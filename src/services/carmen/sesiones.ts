/**
 * Conversaciones de Carmen. Cada una es de un usuario en una empresa: TODAS las
 * lecturas y escrituras filtran por companyId + userId, y un id que no es suyo
 * (de otra empresa, de otro usuario o inventado) da 404 sin leer nada. El id lo
 * genera siempre el servidor.
 *
 * Se guardan 90 días (CarmenAjustes.conservarDias) con las cifras de cada
 * respuesta tal como se dieron, y el usuario puede borrarlas. Lo caducado se
 * purga sin prisa, en lotes de 200, como mucho cada 6 horas por empresa.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { notFound } from '../../utils/http-errors';
import { tiene } from './contexto';
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

/** La sesión del usuario en la empresa, o 404. */
export async function obtenerSesion(ctx: Pick<CarmenCtx, 'companyId' | 'userId'>, sessionId: string): Promise<SesionCarmen> {
  const s = await prisma.chatSession.findFirst({
    where: { id: sessionId, companyId: ctx.companyId, userId: ctx.userId },
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
  for (const k of ['entendido', 'kpis', 'tabla', 'enlaces', 'descargas', 'botones', 'avisos', 'fuente', 'etiquetaIA'] as const) {
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

/** Hasta 2 turnos anteriores con origen 'faq' o 'ia' (nunca de datos), para la IA. */
export async function turnosParaIA(ctx: Pick<CarmenCtx, 'companyId' | 'userId'>, sessionId: string): Promise<TurnoPrevio[]> {
  const filas = await prisma.chatMessage.findMany({
    where: { sessionId, companyId: ctx.companyId, userId: ctx.userId, origen: { in: ['faq', 'ia'] } },
    orderBy: { createdAt: 'desc' },
    take: 8,
    select: { role: true, content: true, origen: true, createdAt: true },
  });
  const orden = filas.reverse();
  const turnos: TurnoPrevio[] = [];
  for (let i = 0; i + 1 < orden.length; i++) {
    if (orden[i].role === 'user' && orden[i + 1].role === 'assistant' && orden[i].origen === orden[i + 1].origen) {
      turnos.push({ pregunta: orden[i].content, respuesta: orden[i + 1].content });
      i++;
    }
  }
  return turnos.slice(-2);
}

export async function listarSesiones(ctx: Pick<CarmenCtx, 'companyId' | 'userId'>, pagina = 1) {
  const p = Math.max(1, Math.floor(pagina) || 1);
  const where = { companyId: ctx.companyId, userId: ctx.userId };
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

/** ¿Sigue teniendo el usuario el permiso con que se calculó? Formato: grupos con ';' (todos) de alternativas con '|'. */
export function conservaPermiso(ctx: Pick<CarmenCtx, 'permisos'>, permisoRequerido: string | null): boolean {
  if (!permisoRequerido) return true;
  return permisoRequerido.split(';').every((grupo) => tiene(ctx, ...grupo.split('|').filter(Boolean)));
}

/** Mensajes de una conversación propia; las respuestas cuyo permiso ya no tiene el usuario se ocultan. */
export async function mensajesDeSesion(ctx: Pick<CarmenCtx, 'companyId' | 'userId' | 'permisos'>, sessionId: string) {
  const sesion = await obtenerSesion(ctx, sessionId);
  const filas = await prisma.chatMessage.findMany({
    where: { sessionId: sesion.id, companyId: ctx.companyId, userId: ctx.userId },
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

/** Borra los mensajes y las conversaciones de la empresa más antiguos que `conservarDias`. */
export async function purgarCaducadas(companyId: string, conservarDias: number, ahora: Date = new Date()): Promise<number> {
  const limite = new Date(ahora.getTime() - conservarDias * 86_400_000);
  let borrados = 0;
  for (let lote = 0; lote < LOTES_POR_PURGA; lote++) {
    const viejos = await prisma.chatMessage.findMany({ where: { companyId, createdAt: { lt: limite } }, select: { id: true }, take: LOTE_PURGA });
    if (!viejos.length) break;
    borrados += (await prisma.chatMessage.deleteMany({ where: { id: { in: viejos.map((m) => m.id) } } })).count;
    if (viejos.length < LOTE_PURGA) break;
  }
  for (let lote = 0; lote < LOTES_POR_PURGA; lote++) {
    const sesiones = await prisma.chatSession.findMany({ where: { companyId, updatedAt: { lt: limite } }, select: { id: true }, take: LOTE_PURGA });
    if (!sesiones.length) break;
    const ids = sesiones.map((s) => s.id);
    await prisma.chatMessage.deleteMany({ where: { sessionId: { in: ids } } });
    await prisma.chatSession.deleteMany({ where: { id: { in: ids } } });
    if (sesiones.length < LOTE_PURGA) break;
  }
  return borrados;
}

/** Purga perezosa: como mucho una vez cada 6 horas por empresa y por instancia. */
export async function purgarSiToca(companyId: string, conservarDias: number): Promise<void> {
  const ultima = ultimaPurga.get(companyId) ?? 0;
  if (Date.now() - ultima < CADA_PURGA_MS) return;
  ultimaPurga.set(companyId, Date.now());
  if (ultimaPurga.size > 1000) ultimaPurga.clear();
  await purgarCaducadas(companyId, conservarDias);
}

/** Solo para tests. */
export function olvidarPurgas(): void {
  ultimaPurga.clear();
}
