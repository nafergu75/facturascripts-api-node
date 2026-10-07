/**
 * Conversaciones de Carmen. Cada una es de un usuario en una empresa: TODAS las
 * lecturas y escrituras filtran por companyId + userId, y un id que no es suyo
 * (de otra empresa, de otro usuario o inventado) da 404 sin leer nada. El id lo
 * genera siempre el servidor.
 *
 * Se guardan 90 días (CarmenAjustes.conservarDias) con las cifras de cada
 * respuesta tal como se dieron, y el usuario puede borrarlas. Lo caducado no se
 * enseña aunque siga en la BD (las lecturas filtran por fecha) y se borra en
 * lotes de 200: al usar Carmen o abrir su historial (como mucho cada 6 horas
 * por empresa y por instancia) y en la tarea diaria de Vercel Cron.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { notFound } from '../../utils/http-errors';
import { PERMISO_NOMINAS, PERMISO_NOMINAS_ANTIGUO, tiene } from './contexto';
import { CONSERVAR_DIAS_DEFECTO, CONSERVAR_DIAS_MAX, CONSERVAR_DIAS_MIN } from './ajustes.service';
import type { CarmenCtx, ContextoSesion, CuerpoRespuesta } from './tipos';
import type { TurnoPrevio } from './llm';

export interface SesionCarmen {
  id: string;
  titulo: string | null;
  contexto: ContextoSesion | null;
  updatedAt: Date;
}

const LOTE_PURGA = 200;
/** Lotes por purga: lo que quede se borra en la siguiente. */
const LOTES_POR_PURGA = 5;
const CADA_PURGA_MS = 6 * 3600_000;
const SESIONES_POR_PAGINA = 20;
export const TEXTO_OCULTO = 'Respuesta oculta: ya no tienes acceso a este dato.';

/** Fecha desde la que se conserva lo guardado (lo anterior está caducado). */
export function limiteConservacion(conservarDias: number = CONSERVAR_DIAS_DEFECTO, ahora: Date = new Date()): Date {
  return new Date(ahora.getTime() - conservarDias * 86_400_000);
}

/** La sesión del usuario en la empresa, o 404. Con `conservarDias`, una sesión caducada también da 404. */
export async function obtenerSesion(ctx: Pick<CarmenCtx, 'companyId' | 'userId'>, sessionId: string, conservarDias?: number): Promise<SesionCarmen> {
  const s = await prisma.chatSession.findFirst({
    where: {
      id: sessionId,
      companyId: ctx.companyId,
      userId: ctx.userId,
      ...(conservarDias ? { updatedAt: { gte: limiteConservacion(conservarDias) } } : {}),
    },
    select: { id: true, titulo: true, contexto: true, updatedAt: true },
  });
  if (!s) throw notFound('Conversación no encontrada.');
  return { ...s, contexto: (s.contexto as ContextoSesion | null) ?? null };
}

export async function crearSesion(ctx: Pick<CarmenCtx, 'companyId' | 'userId'>, titulo: string): Promise<SesionCarmen> {
  const s = await prisma.chatSession.create({
    data: { companyId: ctx.companyId, userId: ctx.userId, titulo: titulo.slice(0, 120) || null },
    select: { id: true, titulo: true, contexto: true, updatedAt: true },
  });
  return { ...s, contexto: null };
}

/** Bloques de la respuesta que se guardan para repintar el historial. */
function datosParaGuardar(c: CuerpoRespuesta): Prisma.InputJsonValue | undefined {
  const datos: Record<string, unknown> = {};
  for (const k of ['entendido', 'kpis', 'tabla', 'enlaces', 'descargas', 'botones', 'avisos', 'fuente', 'etiquetaIA', 'actualizar'] as const) {
    if (c[k] !== undefined) datos[k] = c[k];
  }
  return Object.keys(datos).length ? (datos as Prisma.InputJsonValue) : undefined;
}

/**
 * Guarda la pregunta y la respuesta y actualiza el contexto de la sesión.
 * Devuelve el id del mensaje de respuesta.
 */
export async function guardarTurno(
  ctx: Pick<CarmenCtx, 'companyId' | 'userId'>,
  sessionId: string,
  pregunta: string,
  respuesta: CuerpoRespuesta,
  contexto: ContextoSesion | null | undefined,
): Promise<string> {
  const comun = { sessionId, companyId: ctx.companyId, userId: ctx.userId, origen: respuesta.origen };
  await prisma.chatMessage.create({ data: { ...comun, role: 'user', content: pregunta } });
  const msg = await prisma.chatMessage.create({
    data: {
      ...comun,
      role: 'assistant',
      content: respuesta.texto,
      intencion: respuesta.intencion ?? null,
      huecos: respuesta.huecos ? (JSON.parse(JSON.stringify(respuesta.huecos)) as Prisma.InputJsonValue) : undefined,
      datos: datosParaGuardar(respuesta),
      permisoRequerido: respuesta.permisoRequerido ?? null,
      calculadoEn: respuesta.calculadoEn ? new Date(respuesta.calculadoEn) : null,
      validacion: respuesta.validacion ?? null,
    },
    select: { id: true },
  });
  // updateMany con companyId + userId: nunca toca una sesión ajena.
  await prisma.chatSession.updateMany({
    where: { id: sessionId, companyId: ctx.companyId, userId: ctx.userId },
    data: {
      updatedAt: new Date(),
      ...(contexto !== undefined ? { contexto: contexto === null ? Prisma.DbNull : (contexto as unknown as Prisma.InputJsonValue) } : {}),
    },
  });
  return msg.id;
}

/**
 * Hasta 2 turnos anteriores con origen 'faq' o 'ia' para la IA. Nunca de datos:
 * se descartan también las respuestas de fichas que llevan algo de la empresa
 * (por ejemplo, el plazo del 303 con «en la app todavía no consta como
 * presentado»), que se reconocen porque guardan permiso o fecha de cálculo.
 */
export async function turnosParaIA(ctx: Pick<CarmenCtx, 'companyId' | 'userId'>, sessionId: string, conservarDias?: number): Promise<TurnoPrevio[]> {
  const filas = await prisma.chatMessage.findMany({
    where: {
      sessionId,
      companyId: ctx.companyId,
      userId: ctx.userId,
      origen: { in: ['faq', 'ia'] },
      ...(conservarDias ? { createdAt: { gte: limiteConservacion(conservarDias) } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 8,
    select: { role: true, content: true, origen: true, permisoRequerido: true, calculadoEn: true, createdAt: true },
  });
  const orden = filas.reverse();
  const turnos: TurnoPrevio[] = [];
  for (let i = 0; i + 1 < orden.length; i++) {
    const [p, r] = [orden[i], orden[i + 1]];
    if (p.role === 'user' && r.role === 'assistant' && p.origen === r.origen) {
      const conDatos = !!r.permisoRequerido || !!r.calculadoEn || !!p.permisoRequerido || !!p.calculadoEn;
      if (!conDatos) turnos.push({ pregunta: p.content, respuesta: r.content });
      i++;
    }
  }
  return turnos.slice(-2);
}

export async function listarSesiones(ctx: Pick<CarmenCtx, 'companyId' | 'userId'>, pagina = 1, conservarDias: number = CONSERVAR_DIAS_DEFECTO) {
  const p = Math.max(1, Math.floor(pagina) || 1);
  const where = { companyId: ctx.companyId, userId: ctx.userId, updatedAt: { gte: limiteConservacion(conservarDias) } };
  const [total, sesiones] = await Promise.all([
    prisma.chatSession.count({ where }),
    prisma.chatSession.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: (p - 1) * SESIONES_POR_PAGINA,
      take: SESIONES_POR_PAGINA,
      select: { id: true, titulo: true, updatedAt: true, createdAt: true },
    }),
  ]);
  return { total, pagina: p, porPagina: SESIONES_POR_PAGINA, sesiones };
}

/**
 * ¿Sigue teniendo el usuario el permiso con que se calculó? Formato: grupos con
 * ';' (hacen falta todos) de alternativas con '|'. Las respuestas con gastos de
 * personal llevan 'nominas:read'; las guardadas antes con el grupo 'nominas'
 * valen igual que 'nominas:read'.
 */
export function conservaPermiso(
  ctx: Pick<CarmenCtx, 'permisos'> & Partial<Pick<CarmenCtx, 'puedeNominas' | 'esAdminGlobal'>>,
  permisoRequerido: string | null,
): boolean {
  if (!permisoRequerido) return true;
  return permisoRequerido.split(';').every((grupo) => {
    const alternativas = grupo
      .split('|')
      .filter(Boolean)
      .map((a) => (a === PERMISO_NOMINAS_ANTIGUO ? PERMISO_NOMINAS : a));
    return alternativas.length > 0 && tiene(ctx, ...alternativas);
  });
}

/** Mensajes de una conversación propia; las respuestas cuyo permiso ya no tiene el usuario se ocultan. */
export async function mensajesDeSesion(
  ctx: Pick<CarmenCtx, 'companyId' | 'userId' | 'permisos'> & Partial<Pick<CarmenCtx, 'puedeNominas' | 'esAdminGlobal'>>,
  sessionId: string,
  conservarDias: number = CONSERVAR_DIAS_DEFECTO,
) {
  const sesion = await obtenerSesion(ctx, sessionId, conservarDias);
  const filas = await prisma.chatMessage.findMany({
    where: { sessionId: sesion.id, companyId: ctx.companyId, userId: ctx.userId, createdAt: { gte: limiteConservacion(conservarDias) } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, role: true, content: true, origen: true, intencion: true, datos: true, permisoRequerido: true, calculadoEn: true, valoracion: true, createdAt: true },
  });
  const mensajes = filas.map(({ permisoRequerido, ...m }) =>
    conservaPermiso(ctx, permisoRequerido) ? { ...m, oculto: false } : { ...m, content: TEXTO_OCULTO, datos: null, oculto: true },
  );
  return { sessionId: sesion.id, titulo: sesion.titulo, mensajes };
}

export async function borrarSesion(ctx: Pick<CarmenCtx, 'companyId' | 'userId'>, sessionId: string): Promise<void> {
  const sesion = await obtenerSesion(ctx, sessionId);
  await prisma.chatMessage.deleteMany({ where: { sessionId: sesion.id, companyId: ctx.companyId, userId: ctx.userId } });
  await prisma.chatSession.deleteMany({ where: { id: sesion.id, companyId: ctx.companyId, userId: ctx.userId } });
}

/** Valoración de una respuesta propia («¿Te ha servido?»). */
export async function valorarMensaje(ctx: Pick<CarmenCtx, 'companyId' | 'userId'>, mensajeId: string, util: boolean): Promise<void> {
  const r = await prisma.chatMessage.updateMany({
    where: { id: mensajeId, companyId: ctx.companyId, userId: ctx.userId, role: 'assistant' },
    data: { valoracion: util ? 1 : 0 },
  });
  if (r.count !== 1) throw notFound('Mensaje no encontrado.');
}

// ---------- Purga de lo caducado ----------

const ultimaPurga = new Map<string, number>();

/**
 * Borra mensajes y conversaciones anteriores a `limite`, en lotes. Sin
 * `companyId`, de todas las empresas (la tarea diaria).
 */
async function purgarAntesDe(limite: Date, companyId?: string): Promise<number> {
  const deEmpresa = companyId ? { companyId } : {};
  let borrados = 0;
  for (let lote = 0; lote < LOTES_POR_PURGA; lote++) {
    const viejos = await prisma.chatMessage.findMany({ where: { ...deEmpresa, createdAt: { lt: limite } }, select: { id: true }, take: LOTE_PURGA });
    if (!viejos.length) break;
    borrados += (await prisma.chatMessage.deleteMany({ where: { id: { in: viejos.map((m) => m.id) } } })).count;
    if (viejos.length < LOTE_PURGA) break;
  }
  for (let lote = 0; lote < LOTES_POR_PURGA; lote++) {
    const sesiones = await prisma.chatSession.findMany({ where: { ...deEmpresa, updatedAt: { lt: limite } }, select: { id: true }, take: LOTE_PURGA });
    if (!sesiones.length) break;
    const ids = sesiones.map((s) => s.id);
    await prisma.chatMessage.deleteMany({ where: { sessionId: { in: ids } } });
    await prisma.chatSession.deleteMany({ where: { id: { in: ids } } });
    if (sesiones.length < LOTE_PURGA) break;
  }
  return borrados;
}

/** Borra los mensajes y las conversaciones de la empresa más antiguos que `conservarDias`. */
export async function purgarCaducadas(companyId: string, conservarDias: number, ahora: Date = new Date()): Promise<number> {
  return purgarAntesDe(limiteConservacion(conservarDias, ahora), companyId);
}

/** Purga perezosa: como mucho una vez cada 6 horas por empresa y por instancia. */
export async function purgarSiToca(companyId: string, conservarDias: number): Promise<void> {
  const ultima = ultimaPurga.get(companyId) ?? 0;
  if (Date.now() - ultima < CADA_PURGA_MS) return;
  ultimaPurga.set(companyId, Date.now());
  if (ultimaPurga.size > 1000) ultimaPurga.clear();
  await purgarCaducadas(companyId, conservarDias);
}

/**
 * Tarea diaria (Vercel Cron): lo de más de 90 días de todas las empresas, y lo
 * de las empresas que guardan menos días según sus ajustes. No depende de que
 * alguien de la empresa vuelva a usar Carmen.
 */
export async function purgarTodas(ahora: Date = new Date()): Promise<number> {
  let borrados = await purgarAntesDe(limiteConservacion(CONSERVAR_DIAS_MAX, ahora));
  const conMenos = await prisma.carmenAjustes.findMany({ where: { conservarDias: { lt: CONSERVAR_DIAS_MAX } }, select: { companyId: true, conservarDias: true } });
  for (const a of conMenos) borrados += await purgarCaducadas(a.companyId, Math.max(CONSERVAR_DIAS_MIN, a.conservarDias), ahora);
  return borrados;
}

/** Solo para tests. */
export function olvidarPurgas(): void {
  ultimaPurga.clear();
}
