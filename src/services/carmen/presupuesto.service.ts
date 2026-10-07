/**
 * Topes de uso de Carmen, con contadores en la BD (valen entre instancias
 * serverless; el rateLimit en memoria es solo un freno barato).
 *
 *  - Gasto de la IA en el mes, para todas las empresas: CARMEN_TOPE_MENSUAL_EUR (5 €).
 *  - Preguntas a la IA al día por empresa: CARMEN_TOPE_EMPRESA_DIA (100), o el
 *    tope propio de la empresa si es menor.
 *  - Preguntas a la IA al día por usuario: CARMEN_TOPE_USUARIO_DIA (15).
 *  - Mensajes a Carmen al día por usuario (cualquier tipo): CARMEN_MENSAJES_USUARIO_DIA (300).
 *
 * Antes de llamar a la IA se RESERVA el peor caso con UPDATE condicionales
 * atómicos dentro de una transacción (si alguno afecta a 0 filas, el tope está
 * alcanzado y no se reserva nada). Después se LIQUIDA con el coste real de
 * `usage`, o se DEVUELVE la reserva si la API contesta con un error que no
 * cobra. Si la llamada se corta o se agota el tiempo, la reserva se queda.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { config } from '../../config/env';
import { reservaUsd, redondear } from './precios';

export type MotivoSinIA = 'apagada' | 'sin_clave' | 'desactivada_empresa' | 'tope_mensual' | 'tope_empresa' | 'tope_usuario';

export const TEXTO_MOTIVO: Record<MotivoSinIA, string> = {
  apagada: 'La IA de Carmen está apagada en la plataforma.',
  sin_clave: 'La IA de Carmen no está configurada.',
  desactivada_empresa: 'La IA no está activada en esta empresa. Un administrador puede activarla en los ajustes de Carmen.',
  tope_mensual: 'Este mes ya se ha gastado el presupuesto de la IA. Vuelve a estar disponible el día 1.',
  tope_empresa: 'Hoy ya se han hecho todas las preguntas a la IA que permite tu empresa. Mañana vuelve a estar disponible.',
  tope_usuario: 'Hoy ya has hecho todas tus preguntas a la IA. Mañana vuelve a estar disponible.',
};

export interface ClavesContador {
  global: string;
  empresaDia: string;
  usuarioDia: string;
  empresaMes: string;
}

export function clavesContador(companyId: string, userId: string, hoy: string): ClavesContador {
  const mes = hoy.slice(0, 7);
  return {
    global: `global:${mes}`,
    empresaDia: `empresa:${companyId}:${hoy}`,
    usuarioDia: `usuario:${userId}:${hoy}`,
    empresaMes: `empresa:${companyId}:${mes}`,
  };
}

export interface Reserva {
  claves: ClavesContador;
  usd: number;
}

class TopeAlcanzado extends Error {
  constructor(public readonly motivo: MotivoSinIA) {
    super(motivo);
  }
}

const dec = (n: number) => new Prisma.Decimal(n.toFixed(6));

async function asegurarFilas(claves: string[]): Promise<void> {
  await prisma.carmenContador.createMany({ data: claves.map((clave) => ({ clave })), skipDuplicates: true });
}

/**
 * Cuenta un mensaje del usuario. Devuelve false (sin contarlo) si ya ha llegado
 * al máximo de mensajes del día.
 */
export async function contarMensaje(userId: string, hoy: string): Promise<boolean> {
  const clave = `usuario:${userId}:${hoy}`;
  await asegurarFilas([clave]);
  const filas = await prisma.$executeRaw`UPDATE \`CarmenContador\` SET \`mensajes\` = \`mensajes\` + 1, \`actualizadoEn\` = NOW(3) WHERE \`clave\` = ${clave} AND \`mensajes\` < ${config.carmen.mensajesUsuarioDia}`;
  return filas === 1;
}

/** Reserva el peor caso de una llamada a la IA en los tres topes, o nada si alguno está lleno. */
export async function reservar(
  companyId: string,
  userId: string,
  hoy: string,
  topeEmpresa: number,
): Promise<{ ok: true; reserva: Reserva } | { ok: false; motivo: MotivoSinIA }> {
  const claves = clavesContador(companyId, userId, hoy);
  const usd = reservaUsd(config.carmen.modelo, config.carmen.maxTokensSalida);
  const tope = dec(config.carmen.topeMensualEur);
  await asegurarFilas([claves.global, claves.empresaDia, claves.usuarioDia, claves.empresaMes]);
  try {
    // Mismo orden de filas en todas las transacciones: sin interbloqueos.
    await prisma.$transaction(async (tx) => {
      const g = await tx.$executeRaw`UPDATE \`CarmenContador\` SET \`costeUsd\` = \`costeUsd\` + ${dec(usd)}, \`consultasIA\` = \`consultasIA\` + 1, \`actualizadoEn\` = NOW(3) WHERE \`clave\` = ${claves.global} AND \`costeUsd\` + ${dec(usd)} <= ${tope}`;
      if (g !== 1) throw new TopeAlcanzado('tope_mensual');
      const e = await tx.$executeRaw`UPDATE \`CarmenContador\` SET \`consultasIA\` = \`consultasIA\` + 1, \`actualizadoEn\` = NOW(3) WHERE \`clave\` = ${claves.empresaDia} AND \`consultasIA\` < ${topeEmpresa}`;
      if (e !== 1) throw new TopeAlcanzado('tope_empresa');
      const u = await tx.$executeRaw`UPDATE \`CarmenContador\` SET \`consultasIA\` = \`consultasIA\` + 1, \`actualizadoEn\` = NOW(3) WHERE \`clave\` = ${claves.usuarioDia} AND \`consultasIA\` < ${config.carmen.topeUsuarioDia}`;
      if (u !== 1) throw new TopeAlcanzado('tope_usuario');
      await tx.$executeRaw`UPDATE \`CarmenContador\` SET \`costeUsd\` = \`costeUsd\` + ${dec(usd)}, \`consultasIA\` = \`consultasIA\` + 1, \`actualizadoEn\` = NOW(3) WHERE \`clave\` = ${claves.empresaMes}`;
    }, { maxWait: 10_000, timeout: 10_000 });
    ultimoTopeMensualAgotado = false;
    return { ok: true, reserva: { claves, usd } };
  } catch (e) {
    if (e instanceof TopeAlcanzado) {
      if (e.motivo === 'tope_mensual') ultimoTopeMensualAgotado = true;
      return { ok: false, motivo: e.motivo };
    }
    throw e;
  }
}

/*
 * liquidar y devolver tocan las filas de una en una, cada UPDATE en su propia
 * sentencia y en el mismo orden que reservar (global → empresa día → usuario
 * día → empresa mes). Un `WHERE clave IN (global, empresaMes)` las bloquearía
 * en el orden de la clave primaria ('empresa:...' antes que 'global:...'), el
 * contrario al de reservar, y dos peticiones de la misma empresa podrían
 * interbloquearse. Así ninguna sentencia espera por una fila mientras tiene
 * otra bloqueada.
 */

/** Ajusta la reserva al coste real (normalmente menor). */
export async function liquidar(reserva: Reserva, costeRealUsd: number): Promise<void> {
  const ajuste = dec(redondear(costeRealUsd - reserva.usd));
  for (const clave of [reserva.claves.global, reserva.claves.empresaMes]) {
    await prisma.$executeRaw`UPDATE \`CarmenContador\` SET \`costeUsd\` = GREATEST(\`costeUsd\` + ${ajuste}, 0), \`actualizadoEn\` = NOW(3) WHERE \`clave\` = ${clave}`;
  }
}

/** Devuelve la reserva entera (la API contestó con un error que no cobra: no se ha gastado nada). */
export async function devolver(reserva: Reserva): Promise<void> {
  const usd = dec(reserva.usd);
  const { global, empresaDia, usuarioDia, empresaMes } = reserva.claves;
  await prisma.$executeRaw`UPDATE \`CarmenContador\` SET \`costeUsd\` = GREATEST(\`costeUsd\` - ${usd}, 0), \`consultasIA\` = GREATEST(\`consultasIA\` - 1, 0), \`actualizadoEn\` = NOW(3) WHERE \`clave\` = ${global}`;
  for (const clave of [empresaDia, usuarioDia]) {
    await prisma.$executeRaw`UPDATE \`CarmenContador\` SET \`consultasIA\` = GREATEST(\`consultasIA\` - 1, 0), \`actualizadoEn\` = NOW(3) WHERE \`clave\` = ${clave}`;
  }
  await prisma.$executeRaw`UPDATE \`CarmenContador\` SET \`costeUsd\` = GREATEST(\`costeUsd\` - ${usd}, 0), \`consultasIA\` = GREATEST(\`consultasIA\` - 1, 0), \`actualizadoEn\` = NOW(3) WHERE \`clave\` = ${empresaMes}`;
}

// ---------- Estado ----------

/** Último estado del tope mensual visto por esta instancia (para /health, sin consultar la BD). */
let ultimoTopeMensualAgotado: boolean | null = null;
export function topeMensualAgotadoEnCache(): boolean | null {
  return ultimoTopeMensualAgotado;
}

export interface UsoIA {
  /** Gasto del mes de todas las empresas, en euros (1 $ = 1 €). */
  gastoMesEur: number;
  topeMesEur: number;
  /** Porcentaje del tope mensual gastado. */
  porcentajeMes: number;
  /** A partir del 80 %, aviso para los administradores. */
  avisoTope: boolean;
  consultasEmpresaHoy: number;
  topeEmpresaDia: number;
  consultasEmpresaMes: number;
  gastoEmpresaMesEur: number;
  consultasUsuarioHoy: number;
  topeUsuarioDia: number;
}

export async function leerUso(companyId: string, userId: string, hoy: string, topeEmpresa: number): Promise<UsoIA> {
  const claves = clavesContador(companyId, userId, hoy);
  const filas = await prisma.carmenContador.findMany({ where: { clave: { in: Object.values(claves) } } });
  const fila = (clave: string) => filas.find((f) => f.clave === clave);
  const gastoMes = Number(fila(claves.global)?.costeUsd ?? 0);
  const topeMes = config.carmen.topeMensualEur;
  const porcentaje = topeMes > 0 ? Math.round((gastoMes / topeMes) * 1000) / 10 : 100;
  return {
    gastoMesEur: redondear(gastoMes),
    topeMesEur: topeMes,
    porcentajeMes: porcentaje,
    avisoTope: porcentaje >= 80,
    consultasEmpresaHoy: fila(claves.empresaDia)?.consultasIA ?? 0,
    topeEmpresaDia: topeEmpresa,
    consultasEmpresaMes: fila(claves.empresaMes)?.consultasIA ?? 0,
    gastoEmpresaMesEur: redondear(Number(fila(claves.empresaMes)?.costeUsd ?? 0)),
    consultasUsuarioHoy: fila(claves.usuarioDia)?.consultasIA ?? 0,
    topeUsuarioDia: config.carmen.topeUsuarioDia,
  };
}

/** Motivo de configuración por el que no hay IA (sin mirar los contadores), o null. */
export function motivoConfiguracion(iaActivaEmpresa: boolean): MotivoSinIA | null {
  if (!config.carmen.llmActivo) return 'apagada';
  if (!config.anthropicApiKey) return 'sin_clave';
  if (!iaActivaEmpresa) return 'desactivada_empresa';
  return null;
}

/** Motivo por el que la IA no está disponible ahora mismo, o null si lo está. */
export function motivoSinIA(
  opciones: { iaActivaEmpresa: boolean },
  uso: Pick<UsoIA, 'gastoMesEur' | 'consultasEmpresaHoy' | 'topeEmpresaDia' | 'consultasUsuarioHoy' | 'topeUsuarioDia'>,
): MotivoSinIA | null {
  const configuracion = motivoConfiguracion(opciones.iaActivaEmpresa);
  if (configuracion) return configuracion;
  const reserva = reservaUsd(config.carmen.modelo, config.carmen.maxTokensSalida);
  ultimoTopeMensualAgotado = uso.gastoMesEur + reserva > config.carmen.topeMensualEur;
  if (ultimoTopeMensualAgotado) return 'tope_mensual';
  if (uso.consultasEmpresaHoy >= uso.topeEmpresaDia) return 'tope_empresa';
  if (uso.consultasUsuarioHoy >= uso.topeUsuarioDia) return 'tope_usuario';
  return null;
}

// ---------- Limpieza de contadores y auditoría ----------

/** Contadores diarios ('usuario:{id}:AAAA-MM-DD', 'empresa:{id}:AAAA-MM-DD'): bastan unos días tras el día. */
export const DIAS_CONTADORES_DIARIOS = 40;
/** Contadores mensuales ('global:AAAA-MM', 'empresa:{id}:AAAA-MM') y auditoría de la IA: 13 meses. */
export const DIAS_CONTADORES_MENSUALES = 400;
const LOTE_CONTADORES = 500;

/**
 * Borra los contadores y la auditoría de la IA viejos (purga diaria). Son un
 * registro de qué usuario usó Carmen cada día: no se guardan para siempre.
 * Por lotes (DELETE ... LIMIT) para no pasar del tamaño de transacción de TiDB.
 * Devuelve true si se acabó el tiempo con algo pendiente.
 */
export async function purgarContadores(ahora: Date, hasta: number): Promise<boolean> {
  const diarios = new Date(ahora.getTime() - DIAS_CONTADORES_DIARIOS * 86_400_000);
  const mensuales = new Date(ahora.getTime() - DIAS_CONTADORES_MENSUALES * 86_400_000);
  const borrar: Array<() => Promise<number>> = [
    // Claves que acaban en ':AAAA-MM-DD' (en LIKE, '_' es un carácter cualquiera).
    () => prisma.$executeRaw`DELETE FROM \`CarmenContador\` WHERE \`actualizadoEn\` < ${diarios} AND \`clave\` LIKE '%:____-__-__' LIMIT ${LOTE_CONTADORES}`,
    () => prisma.$executeRaw`DELETE FROM \`CarmenContador\` WHERE \`actualizadoEn\` < ${mensuales} LIMIT ${LOTE_CONTADORES}`,
    () => prisma.$executeRaw`DELETE FROM \`CarmenLlamadaIA\` WHERE \`createdAt\` < ${mensuales} LIMIT ${LOTE_CONTADORES}`,
  ];
  for (const paso of borrar) {
    for (;;) {
      if (Date.now() >= hasta) return true;
      if ((await paso()) < LOTE_CONTADORES) break;
    }
  }
  return false;
}
