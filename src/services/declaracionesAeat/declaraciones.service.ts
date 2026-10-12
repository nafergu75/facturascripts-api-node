/**
 * Historial de declaraciones de los modelos de la AEAT (B4) y número
 * identificativo único (B5), igual para todos los modelos.
 *
 * Cada modelo y periodo tiene en DeclaracionAeat una fila por declaración: la
 * normal (N) y después las complementarias (C; en el 303 y el 200,
 * rectificativas) o sustitutivas (S). Estados:
 *  - preparada: la que se está haciendo ahora (como mucho una por periodo);
 *  - presentada: congelada, con la instantánea de lo que se presentó;
 *  - anulada: abandonada o marcada como presentada por error. No se borra,
 *    para que su número no se vuelva a usar.
 *
 * ModeloImpuesto sigue siendo la fila «de trabajo» del calendario: al
 * presentar queda 'presentado' con sus casillas y datos (cada modelo con su
 * formato); al preparar una complementaria vuelve a 'vigente' (lo presentado
 * queda a salvo aquí) y al cancelarla se restaura desde la última presentada.
 *
 * Este servicio no calcula ningún modelo: recibe del que lo llama la
 * instantánea y los importes. Solo escriben las funciones que llaman las rutas
 * con permiso de escritura; las de lectura (contextoDeclaracion, historial)
 * no escriben nunca.
 */
import { Prisma, type DeclaracionAeat } from '@prisma/client';
import { prisma } from '../../config/database';
import { badRequest, conflict } from '../../utils/http-errors';
import { registrarAuditoria } from '../auditoria.service';

export type CodigoAeat = '303' | '111' | '115' | '202' | '390' | '200' | '347' | '349' | '180' | '190';
export type TipoDeclaracionAeat = 'N' | 'C' | 'S';
export type TipoRectificacion = 'C' | 'S';

export interface ConfigModeloAeat {
  codigo: CodigoAeat;
  clase: 'autoliquidacion' | 'informativa';
  /** Tipos de rectificación que admite el modelo después de presentarlo. */
  rectificaciones: TipoRectificacion[];
  /** Lleva número identificativo que pone la app (registro de tipo 1). */
  numero: boolean;
  /** Cómo se llama cada tipo en la pantalla. */
  nombres: Record<TipoDeclaracionAeat, string>;
}

const AUTO = (codigo: CodigoAeat, rect: TipoRectificacion[], nombreC = 'complementaria'): ConfigModeloAeat => ({
  codigo,
  clase: 'autoliquidacion',
  rectificaciones: rect,
  numero: false,
  nombres: { N: 'normal', C: nombreC, S: 'sustitutiva' },
});
const INFO = (codigo: CodigoAeat): ConfigModeloAeat => ({
  codigo,
  clase: 'informativa',
  rectificaciones: ['C', 'S'],
  numero: true,
  nombres: { N: 'normal', C: 'complementaria', S: 'sustitutiva' },
});

export const MODELOS_AEAT: Readonly<Record<CodigoAeat, ConfigModeloAeat>> = {
  '303': AUTO('303', ['C'], 'rectificativa'),
  '111': AUTO('111', ['C']),
  '115': AUTO('115', ['C']),
  '202': AUTO('202', ['C']),
  '390': AUTO('390', ['S']),
  '200': AUTO('200', ['C'], 'rectificativa'),
  '347': INFO('347'),
  '349': INFO('349'),
  '180': INFO('180'),
  '190': INFO('190'),
};

export function configModelo(codigo: string): ConfigModeloAeat {
  const c = MODELOS_AEAT[codigo as CodigoAeat];
  if (!c) throw badRequest(`El modelo ${codigo} no tiene historial de declaraciones en la app.`);
  return c;
}

/**
 * Periodo de un modelo con su código: '1T'..'4T' o '01'..'12' (303, 111, 115
 * y 349), '1P'..'3P' (202) o '0A' (anuales). 400 si no vale.
 */
export function periodoDeclaracion(codigo: string, valor: unknown): string {
  const p = String(valor ?? '').trim().toUpperCase();
  if (['390', '200', '347', '180', '190'].includes(codigo)) {
    if (p && p !== '0A') throw badRequest(`El ${codigo} es anual: no lleva periodo.`);
    return '0A';
  }
  if (codigo === '202') {
    if (!/^[1-3]P$/.test(p)) throw badRequest('El 202 tiene tres periodos: 1P, 2P y 3P.');
    return p;
  }
  if (/^[1-4]T$/.test(p)) return p;
  if (/^[1-4]$/.test(p)) return `${p}T`;
  if (/^(0?[1-9]|1[0-2])$/.test(p)) return p.padStart(2, '0');
  throw badRequest(`El periodo "${String(valor ?? '')}" no vale para el ${codigo}: usa un trimestre (1T a 4T) o un mes (01 a 12).`);
}

/** Fila de DeclaracionAeat tal como la lee el cliente (el importe, como number). */
export type FilaDeclaracion = Omit<DeclaracionAeat, 'resultadoAnterior'> & { resultadoAnterior: number | null };

/** Lo que se guarda al presentar (lo calcula cada modelo con lo que enseña la pantalla). */
export interface InstantaneaDeclaracion {
  /** Casillas principales, para el historial. */
  casillas: Record<string, unknown>;
  /** Cómo queda la fila de ModeloImpuesto (el formato de cada modelo). */
  fila: { casillas: Record<string, unknown>; datos: Record<string, unknown> };
  /** Fichero tal como se descarga (si el modelo lo genera). */
  fichero?: string | null;
  /** Respuesta de la pantalla, para enseñarla congelada. */
  pantalla?: unknown;
  /** Autoliquidaciones: lo que se ingresa con esta declaración. */
  resultado?: number;
  /** Autoliquidaciones: otros importes que necesita la siguiente rectificación ([69] del 303...). */
  importes?: Record<string, number>;
  /** Informativas: los registros que lleva. */
  registros?: Array<{ clave: string; nombre: string; importe: number }>;
  tipoDeclaracion?: string | null;
  iban?: string | null;
}

/** Datos de una declaración presentada (lo guardado en `datos`). */
export interface DatosPresentada {
  fila?: { casillas?: Record<string, unknown>; datos?: Record<string, unknown> };
  fichero?: string | null;
  pantalla?: unknown;
  resultado?: number;
  importes?: Record<string, number>;
  registros?: Array<{ clave: string; nombre: string; importe: number }>;
  tipoDeclaracion?: string | null;
  iban?: string | null;
  /** Fila presentada antes de existir el historial (convertida al preparar una rectificación). */
  legado?: boolean;
}

/** Opciones de una declaración en curso (las que no son columnas). */
export interface DatosEnCurso {
  /** 303 y 200: devoluciones acordadas por la AEAT de la autoliquidación anterior ([109] del 303, [01584] del 200). */
  devolucionAcordada?: number;
  /**
   * Sustitutiva de una informativa: números que hay que dar de baja en la sede
   * antes de presentarla. El primero es el que cita la sustitutiva; los demás,
   * las complementarias que se presentaron después.
   */
  bajas?: string[];
  /**
   * Complementaria de una informativa: claves de todos los registros que había
   * al prepararla o al guardar la selección (los que la persona ya vio). Un
   * registro que aparece después (la factura olvidada que se registra ahora)
   * no está aquí y, si no se presentó antes, entra solo en la propuesta.
   */
  vistos?: string[];
}

/**
 * Declaración que sustituye una sustitutiva: la última normal o sustitutiva
 * presentada (la «original» de la cadena), no una complementaria. La sede de la
 * AEAT («Modificar una declaración informativa mediante fichero») dice que la
 * sustitutiva anula una sola declaración y que antes hay que darla de baja con
 * «Baja de declaración por sustitución». Las complementarias presentadas
 * después de esa original también se dan de baja: la sustitutiva lleva todos
 * los registros y, si no, quedarían declarados dos veces.
 */
export function anteriorDeSustitutiva(presentadas: FilaDeclaracion[] | DeclaracionAeat[]): { base: DeclaracionAeat | FilaDeclaracion | null; complementarias: Array<DeclaracionAeat | FilaDeclaracion> } {
  const lista = presentadas as Array<DeclaracionAeat | FilaDeclaracion>;
  let i = lista.length - 1;
  while (i >= 0 && lista[i].tipo === 'C') i--;
  if (i < 0) return { base: lista[0] ?? null, complementarias: lista.slice(1) };
  return { base: lista[i], complementarias: lista.slice(i + 1) };
}

/** Aviso de la sustitutiva de una informativa: qué hay que dar de baja en la sede antes de presentarla. */
export function avisoBajasSustitutiva(codigo: string, bajas: string[]): string | null {
  if (!bajas.length) return null;
  const [original, ...resto] = bajas;
  const otras = resto.length
    ? ` Da de baja también ${resto.length === 1 ? 'la complementaria' : 'las complementarias'} ${resto.join(', ')}: la sustitutiva lleva todos los registros y, si no, quedarían declarados dos veces.`
    : '';
  return `Antes de presentar la sustitutiva del ${codigo}, da de baja en la sede de la AEAT la declaración ${original} («Consulta y bajas de declaraciones» > «Baja de declaración por sustitución»). La sustitutiva cita ese número.${otras} Apunta los números antes de darlas de baja: después la sede ya no las enseña.`;
}

export const datosDe = (f: FilaDeclaracion | null | undefined): DatosPresentada => (f?.datos ?? {}) as DatosPresentada;

/** Situación de la declaración de un modelo y periodo (solo lee). */
export interface ContextoDeclaracion {
  codigo: CodigoAeat;
  ejercicio: number;
  periodo: string;
  config: ConfigModeloAeat;
  /** Declaraciones no anuladas, por secuencia. */
  declaraciones: FilaDeclaracion[];
  enCurso: FilaDeclaracion | null;
  ultimaPresentada: FilaDeclaracion | null;
  presentadas: FilaDeclaracion[];
  /** Hay una presentada y no se está preparando otra: pantalla y fichero salen de la instantánea. */
  congelada: boolean;
  /** Tipo de la declaración que se está haciendo (o de la última presentada si está congelada). */
  tipo: TipoDeclaracionAeat;
  numero: string | null;
  justificanteAnterior: string | null;
  resultadoAnterior: number;
  /** Complementaria de una informativa: claves elegidas. null = todos los registros. */
  registros: string[] | null;
  /** Claves de los registros de todas las presentadas. */
  registrosPresentados: Set<string>;
  /** Complementaria: registros que ya se vieron al prepararla o al elegir (null si no se apuntaron). */
  registrosVistos: Set<string> | null;
  devolucionAcordada: number;
}

/**
 * Si un registro va en la complementaria en curso: los elegidos y, además, los
 * nuevos (no vistos al prepararla ni al elegir, y no presentados antes). null
 * si no hay selección (normal o sustitutiva: van todos).
 */
export function incluyeRegistro(ctx: Pick<ContextoDeclaracion, 'registros' | 'registrosVistos' | 'registrosPresentados'>): ((clave: string) => boolean) | null {
  if (!ctx.registros) return null;
  const elegidos = new Set(ctx.registros);
  const vistos = ctx.registrosVistos;
  return (clave) => elegidos.has(clave) || (!!vistos && !vistos.has(clave) && !ctx.registrosPresentados.has(clave));
}

/** Cliente de una transacción (con la extensión de importes). */
type Tx = Parameters<Extract<Parameters<typeof prisma.$transaction>[0], (...args: never[]) => unknown>>[0];

const delPeriodo = (companyId: string, codigo: string, ejercicio: number, periodo: string) => ({ companyId, codigo, ejercicio, periodo });

/** Contexto de la declaración (no escribe). */
export async function contextoDeclaracion(companyId: string, codigo: string, ejercicio: number, periodo: string): Promise<ContextoDeclaracion> {
  const config = configModelo(codigo);
  // Sin la tabla (tests con la BD simulada): sin historial.
  const tabla = (prisma as { declaracionAeat?: { findMany?: unknown } }).declaracionAeat;
  const declaraciones =
    typeof tabla?.findMany === 'function'
      ? await prisma.declaracionAeat.findMany({ where: { ...delPeriodo(companyId, codigo, ejercicio, periodo), estado: { not: 'anulada' } }, orderBy: { secuencia: 'asc' } })
      : [];
  const enCurso = declaraciones.find((d) => d.estado === 'preparada') ?? null;
  const presentadas = declaraciones.filter((d) => d.estado === 'presentada');
  const ultimaPresentada = presentadas[presentadas.length - 1] ?? null;
  const registrosPresentados = new Set<string>();
  for (const p of presentadas) for (const r of datosDe(p).registros ?? []) registrosPresentados.add(r.clave);
  const actual = enCurso ?? ultimaPresentada;
  const sel = enCurso?.registros;
  return {
    codigo: config.codigo,
    ejercicio,
    periodo,
    config,
    declaraciones,
    enCurso,
    ultimaPresentada,
    presentadas,
    congelada: !enCurso && !!ultimaPresentada,
    tipo: (actual?.tipo as TipoDeclaracionAeat) ?? 'N',
    numero: actual?.numero ?? null,
    justificanteAnterior: actual?.justificanteAnterior ?? null,
    resultadoAnterior: Number(actual?.resultadoAnterior ?? 0) || 0,
    registros: enCurso && enCurso.tipo === 'C' && Array.isArray(sel) ? (sel as unknown[]).map(String) : null,
    registrosPresentados,
    registrosVistos: Array.isArray(((enCurso?.datos ?? {}) as DatosEnCurso).vistos) ? new Set(((enCurso!.datos ?? {}) as DatosEnCurso).vistos!.map(String)) : null,
    devolucionAcordada: Number(((enCurso?.datos ?? {}) as DatosEnCurso).devolucionAcordada ?? 0) || 0,
  };
}

/** Lo que quedó presentado de un modelo y periodo (para los modelos que lo leen: 390, 202). */
export interface FilaPresentada {
  casillas: Record<string, unknown>;
  datos: Record<string, unknown> | null;
  /** Hay una complementaria, sustitutiva o rectificativa en preparación: lo presentado sigue siendo esto. */
  rectificacionEnCurso: boolean;
}

/**
 * Casillas y datos de la última declaración PRESENTADA del periodo (solo lee).
 * Sale del historial (DeclaracionAeat, la fila de ModeloImpuesto tal como quedó
 * al presentarla) y, si no hay historial, de ModeloImpuesto cuando está
 * 'presentado' (lo presentado antes de existir el historial). No se mira solo el
 * estado de ModeloImpuesto porque, al preparar una complementaria, sustitutiva
 * o rectificativa, esa fila vuelve a 'vigente' aunque la presentada siga en pie
 * (diseño B4). null si no hay nada presentado.
 */
export async function filaPresentada(companyId: string, codigo: string, ejercicio: number, periodo: string): Promise<FilaPresentada | null> {
  const ctx = await contextoDeclaracion(companyId, codigo, ejercicio, periodo);
  if (ctx.ultimaPresentada) {
    const fila = datosDe(ctx.ultimaPresentada).fila ?? {};
    return { casillas: fila.casillas ?? {}, datos: fila.datos ?? null, rectificacionEnCurso: !!ctx.enCurso };
  }
  const m = await prisma.modeloImpuesto.findUnique({ where: { companyId_codigo_ejercicio_periodo: delPeriodo(companyId, codigo, ejercicio, periodo) } });
  if (m?.estado !== 'presentado') return null;
  return { casillas: (m.casillas as Record<string, unknown> | null) ?? {}, datos: (m.datos as Record<string, unknown> | null) ?? null, rectificacionEnCurso: false };
}

/** Aviso para la pantalla de una declaración congelada. */
export function avisoCongelada(f: FilaDeclaracion): string {
  const j = f.justificante ? ` (justificante ${f.justificante}${f.fechaPresentacion ? `, ${f.fechaPresentacion}` : ''})` : '';
  return `Presentada${j}: se enseña lo que se presentó. Las facturas que cambien después no lo modifican. Si hay que corregirla, prepara una complementaria o sustitutiva.`;
}

// ---------------------------------------------------------------------------
// Número identificativo (B5)
// ---------------------------------------------------------------------------

/**
 * Siguiente número: modelo (3) + ejercicio (4) + contador (6). El contador es
 * el siguiente al mayor ya usado en la empresa para ese modelo y ejercicio
 * (las anuladas cuentan: un número no se reutiliza nunca).
 */
export async function siguienteNumero(tx: Tx, companyId: string, codigo: string, ejercicio: number): Promise<string> {
  const prefijo = `${codigo}${String(ejercicio).padStart(4, '0')}`;
  const ultima = await tx.declaracionAeat.findFirst({
    where: { companyId, numero: { startsWith: prefijo } },
    orderBy: { numero: 'desc' },
    select: { numero: true },
  });
  const n = ultima?.numero ? Number(ultima.numero.slice(prefijo.length)) + 1 : 1;
  if (n > 999999) throw conflict(`Se han agotado los números del ${codigo} de ${ejercicio}.`);
  return `${prefijo}${String(n).padStart(6, '0')}`;
}

const esChoque = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/** Reintenta una escritura que puede chocar con otra a la vez (número o secuencia repetidos). */
async function conReintento<T>(fn: () => Promise<T>): Promise<T> {
  for (let intento = 0; ; intento++) {
    try {
      return await fn();
    } catch (e) {
      if (!esChoque(e) || intento >= 4) {
        if (esChoque(e)) throw conflict('Se estaba guardando otra declaración del mismo modelo a la vez: vuelve a intentarlo.');
        throw e;
      }
    }
  }
}

async function siguienteSecuencia(tx: Tx, companyId: string, codigo: string, ejercicio: number, periodo: string): Promise<number> {
  const ultima = await tx.declaracionAeat.findFirst({ where: delPeriodo(companyId, codigo, ejercicio, periodo), orderBy: { secuencia: 'desc' }, select: { secuencia: true } });
  return (ultima?.secuencia ?? 0) + 1;
}

/**
 * Declaración en curso con su número (informativas). Si no hay ninguna
 * preparada y el periodo no está presentado, crea la normal. Si ya tiene
 * número, lo devuelve: no se gasta otro en cada descarga.
 */
export async function asignarNumero(companyId: string, userId: string, codigo: string, ejercicio: number, periodo: string): Promise<FilaDeclaracion> {
  const config = configModelo(codigo);
  if (!config.numero) throw badRequest(`El ${codigo} no lleva número identificativo: el justificante lo da la sede al presentarlo.`);
  const fila = await conReintento(() =>
    prisma.$transaction(async (tx) => {
      const vivas = await tx.declaracionAeat.findMany({ where: { ...delPeriodo(companyId, codigo, ejercicio, periodo), estado: { not: 'anulada' } }, orderBy: { secuencia: 'asc' } });
      const enCurso = vivas.find((d) => d.estado === 'preparada');
      if (enCurso?.numero) return { fila: enCurso, nueva: false };
      if (!enCurso && vivas.some((d) => d.estado === 'presentada')) {
        throw conflict(`El ${codigo} ya está presentado: para cambiarlo, prepara una complementaria o una sustitutiva.`);
      }
      if (!enCurso && (await legadoPresentado(tx, companyId, codigo, ejercicio, periodo))) {
        throw conflict(`El ${codigo} ya está marcado como presentado: para cambiarlo, prepara una complementaria o una sustitutiva.`);
      }
      const numero = await siguienteNumero(tx, companyId, codigo, ejercicio);
      if (enCurso) return { fila: await tx.declaracionAeat.update({ where: { id: enCurso.id }, data: { numero } }), nueva: true };
      const secuencia = await siguienteSecuencia(tx, companyId, codigo, ejercicio, periodo);
      return {
        fila: await tx.declaracionAeat.create({ data: { ...delPeriodo(companyId, codigo, ejercicio, periodo), secuencia, tipo: 'N', estado: 'preparada', numero, creadoPor: userId } }),
        nueva: true,
      };
    }),
  );
  if (fila.nueva) {
    await registrarAuditoria({ userId, companyId, action: `NUMERO_${codigo}`, resourceType: 'modelo_fiscal', resourceId: `${codigo}-${ejercicio}-${periodo}`, meta: { numero: fila.fila.numero } });
  }
  return fila.fila;
}

// ---------------------------------------------------------------------------
// Filas de ModeloImpuesto
// ---------------------------------------------------------------------------

async function legadoPresentado(tx: Tx, companyId: string, codigo: string, ejercicio: number, periodo: string) {
  const f = await tx.modeloImpuesto.findUnique({ where: { companyId_codigo_ejercicio_periodo: delPeriodo(companyId, codigo, ejercicio, periodo) } });
  return f?.estado === 'presentado' ? f : null;
}

/** Justificante guardado en una fila presentada de antes del historial. */
function justificanteLegado(datos: unknown): { numero: string | null; fecha: string | null } {
  const d = (datos ?? {}) as { justificante?: { numero?: unknown; fecha?: unknown } };
  const numero = String(d.justificante?.numero ?? '').trim();
  const fecha = String(d.justificante?.fecha ?? '').trim();
  return { numero: numero || null, fecha: /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? fecha : null };
}

// ---------------------------------------------------------------------------
// Presentar
// ---------------------------------------------------------------------------

export interface Justificante {
  numero: string;
  fecha: string;
}

/** Justificante de la presentación: número y fecha (AAAA-MM-DD). 400 si falta o no tiene forma. */
export function justificanteDe(body: Record<string, unknown>): Justificante {
  const j = (body.justificante ?? {}) as Record<string, unknown>;
  const numero = String(j.numero ?? '').trim().toUpperCase().replace(/\s/g, '');
  const fecha = String(j.fecha ?? '').trim();
  if (!/^[0-9A-Z]{6,20}$/.test(numero)) throw badRequest('Indica el número de justificante que da la sede al presentar (de 6 a 20 letras o cifras).');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || Number.isNaN(Date.parse(fecha))) throw badRequest('Indica la fecha de presentación.');
  return { numero, fecha };
}

/**
 * Marca como presentada la declaración en curso (o la normal, si no hay
 * ninguna preparada) con su instantánea, y deja ModeloImpuesto 'presentado'
 * con la fila del modelo. 409 si el periodo ya está presentado y no se está
 * preparando otra. Las informativas sin número reciben uno aquí.
 */
export async function registrarPresentacion(
  companyId: string,
  userId: string,
  codigo: string,
  ejercicio: number,
  periodo: string,
  justificante: Justificante | null,
  inst: InstantaneaDeclaracion,
): Promise<FilaDeclaracion> {
  const config = configModelo(codigo);
  const ahora = new Date();
  const datos: DatosPresentada = {
    fila: inst.fila,
    fichero: inst.fichero ?? null,
    pantalla: inst.pantalla ?? null,
    resultado: inst.resultado,
    importes: inst.importes,
    registros: inst.registros,
    tipoDeclaracion: inst.tipoDeclaracion ?? null,
    iban: inst.iban ?? null,
  };
  const fila = await conReintento(() =>
    prisma.$transaction(async (tx) => {
      const vivas = await tx.declaracionAeat.findMany({ where: { ...delPeriodo(companyId, codigo, ejercicio, periodo), estado: { not: 'anulada' } }, orderBy: { secuencia: 'asc' } });
      const enCurso = vivas.find((d) => d.estado === 'preparada');
      if (!enCurso && (vivas.some((d) => d.estado === 'presentada') || (await legadoPresentado(tx, companyId, codigo, ejercicio, periodo)))) {
        throw conflict(`El ${codigo} de ${periodo === '0A' ? ejercicio : `${periodo} de ${ejercicio}`} ya está presentado. Para corregirlo, prepara una complementaria o una sustitutiva.`);
      }
      const numero = enCurso?.numero ?? (config.numero ? await siguienteNumero(tx, companyId, codigo, ejercicio) : null);
      const comun = {
        estado: 'presentada',
        numero,
        justificante: justificante?.numero ?? null,
        fechaPresentacion: justificante?.fecha ?? null,
        casillas: inst.casillas as Prisma.InputJsonValue,
        datos: datos as unknown as Prisma.InputJsonValue,
        presentadoPor: userId,
        presentadoEn: ahora,
      };
      const guardada = enCurso
        ? await tx.declaracionAeat.update({ where: { id: enCurso.id }, data: comun })
        : await tx.declaracionAeat.create({
            data: { ...delPeriodo(companyId, codigo, ejercicio, periodo), secuencia: await siguienteSecuencia(tx, companyId, codigo, ejercicio, periodo), tipo: 'N', creadoPor: userId, ...comun },
          });
      const datosFila = {
        ...inst.fila.datos,
        ...(justificante ? { justificante } : {}),
        fechaPresentacion: ahora.toISOString(),
        auditoria: { ...((inst.fila.datos?.auditoria as object) ?? {}), marcadoPresentadoPor: userId, marcadoPresentadoEn: ahora.toISOString(), ...(justificante ? { justificante } : {}) },
        declaracion: { id: guardada.id, secuencia: guardada.secuencia, tipo: guardada.tipo, numero: guardada.numero },
      };
      await tx.modeloImpuesto.upsert({
        where: { companyId_codigo_ejercicio_periodo: delPeriodo(companyId, codigo, ejercicio, periodo) },
        create: { ...delPeriodo(companyId, codigo, ejercicio, periodo), estado: 'presentado', casillas: inst.fila.casillas as Prisma.InputJsonValue, datos: datosFila as unknown as Prisma.InputJsonValue, origen: 'autorrelleno' },
        update: { estado: 'presentado', casillas: inst.fila.casillas as Prisma.InputJsonValue, datos: datosFila as unknown as Prisma.InputJsonValue },
      });
      return guardada;
    }),
  );
  await registrarAuditoria({
    userId,
    companyId,
    action: `MARCAR_${codigo}_PRESENTADO`,
    resourceType: 'modelo_fiscal',
    resourceId: `${codigo}-${ejercicio}-${periodo}`,
    meta: { secuencia: fila.secuencia, tipo: fila.tipo, numero: fila.numero, justificante: fila.justificante },
  });
  return fila;
}

// ---------------------------------------------------------------------------
// Complementarias y sustitutivas
// ---------------------------------------------------------------------------

export interface EntradaRectificacion {
  tipo: TipoRectificacion;
  /** Solo si la declaración anterior no está en la app. */
  justificanteAnterior?: string | null;
  /** Solo si la declaración anterior no está en la app (autoliquidaciones). */
  resultadoAnterior?: number | null;
  /** 303: devoluciones acordadas de la autoliquidación anterior ([109]). */
  devolucionAcordada?: number | null;
}

/** Lo ya ingresado de las presentadas (suma de sus resultados positivos). */
export function sumaResultados(presentadas: FilaDeclaracion[]): number {
  return presentadas.reduce((a, p) => a + Math.max(0, Math.round((Number(datosDe(p).resultado ?? 0) || 0) * 100)), 0) / 100;
}

/** Lee y comprueba el cuerpo de POST .../rectificacion. */
export function entradaRectificacion(codigo: string, body: Record<string, unknown>): EntradaRectificacion {
  const config = configModelo(codigo);
  const tipo = String(body.tipo ?? '').toUpperCase();
  if (tipo !== 'C' && tipo !== 'S') throw badRequest('Indica si es una complementaria (C) o una sustitutiva (S).');
  if (!config.rectificaciones.includes(tipo)) {
    const admite = config.rectificaciones.map((t) => `${config.nombres[t]} (${t})`).join(' o ');
    throw badRequest(`El ${codigo} solo admite una ${admite}.`);
  }
  const importe = (k: string): number | null => {
    const v = body[k];
    if (v === undefined || v === null || v === '') return null;
    const n = Number(String(v).replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) throw badRequest(`"${k}" tiene que ser un importe positivo o cero.`);
    return Math.round(n * 100) / 100;
  };
  const j = String(body.justificanteAnterior ?? '').trim().toUpperCase().replace(/\s/g, '');
  if (j && !/^[0-9A-Z]{13}$/.test(j)) throw badRequest('El número de la declaración anterior tiene 13 caracteres.');
  return { tipo: tipo as TipoRectificacion, justificanteAnterior: j || null, resultadoAnterior: importe('resultadoAnterior'), devolucionAcordada: importe('devolucionAcordada') };
}

/**
 * Prepara una complementaria o sustitutiva de un periodo presentado: crea la
 * declaración en curso con la anterior, su número (informativas), lo ya
 * ingresado (autoliquidaciones) y los registros propuestos (complementaria de
 * una informativa), y deja ModeloImpuesto 'vigente' para que se recalcule.
 * Una fila presentada de antes del historial se convierte primero en la
 * secuencia 1. Si la anterior no está en la app, hay que dar su número.
 */
export async function prepararRectificacion(
  companyId: string,
  userId: string,
  codigo: string,
  ejercicio: number,
  periodo: string,
  e: EntradaRectificacion,
  calculo: {
    /** Lo ya ingresado con las presentadas (si no viene en la entrada). */
    resultadoAnterior: (presentadas: FilaDeclaracion[]) => number;
    /** Claves de los registros que hay hoy (informativas). */
    registrosActuales?: () => Promise<string[]>;
  },
): Promise<FilaDeclaracion> {
  const config = configModelo(codigo);
  if (!config.rectificaciones.includes(e.tipo)) throw badRequest(`El ${codigo} no admite una ${config.nombres[e.tipo]}.`);
  const actuales = e.tipo === 'C' && calculo.registrosActuales ? await calculo.registrosActuales() : null;
  const fila = await conReintento(() =>
    prisma.$transaction(async (tx) => {
      let vivas = await tx.declaracionAeat.findMany({ where: { ...delPeriodo(companyId, codigo, ejercicio, periodo), estado: { not: 'anulada' } }, orderBy: { secuencia: 'asc' } });
      if (vivas.some((d) => d.estado === 'preparada')) throw conflict(`Ya se está preparando otra declaración del ${codigo}: termínala o cancélala antes.`);
      // Presentada antes de existir el historial: pasa a ser la secuencia 1.
      const legado = await legadoPresentado(tx, companyId, codigo, ejercicio, periodo);
      if (!vivas.some((d) => d.estado === 'presentada') && legado) {
        const j = justificanteLegado(legado.datos);
        await tx.declaracionAeat.create({
          data: {
            ...delPeriodo(companyId, codigo, ejercicio, periodo),
            secuencia: await siguienteSecuencia(tx, companyId, codigo, ejercicio, periodo),
            tipo: 'N',
            estado: 'presentada',
            justificante: j.numero,
            fechaPresentacion: j.fecha,
            casillas: (legado.casillas ?? {}) as Prisma.InputJsonValue,
            datos: { fila: { casillas: legado.casillas ?? {}, datos: legado.datos ?? {} }, legado: true } as Prisma.InputJsonValue,
            creadoPor: userId,
            presentadoPor: userId,
          },
        });
        vivas = await tx.declaracionAeat.findMany({ where: { ...delPeriodo(companyId, codigo, ejercicio, periodo), estado: { not: 'anulada' } }, orderBy: { secuencia: 'asc' } });
      }
      const presentadas = vivas.filter((d) => d.estado === 'presentada');
      // La complementaria cita la última presentada; la sustitutiva de una
      // informativa, la original (la última normal o sustitutiva), y deja
      // apuntado lo que hay que dar de baja antes de presentarla.
      const sustitucion = e.tipo === 'S' && config.clase === 'informativa' ? anteriorDeSustitutiva(presentadas) : null;
      const anterior = sustitucion ? sustitucion.base : presentadas[presentadas.length - 1] ?? null;
      const bajas = sustitucion
        ? [sustitucion.base, ...sustitucion.complementarias].map((d) => d?.numero ?? d?.justificante ?? '').filter(Boolean)
        : [];
      const justificanteAnterior = e.justificanteAnterior ?? (config.numero ? anterior?.numero ?? anterior?.justificante : anterior?.justificante) ?? null;
      if (!justificanteAnterior || !/^[0-9A-Z]{13}$/.test(justificanteAnterior)) {
        throw badRequest(
          anterior
            ? `La declaración anterior no tiene un número de 13 caracteres guardado (tiene "${justificanteAnterior ?? ''}"): escríbelo en «Número de la declaración anterior».`
            : `El ${codigo} de este periodo no está marcado como presentado en la app: escribe el número de la declaración anterior para preparar la ${config.nombres[e.tipo]}.`,
        );
      }
      // El 390 no lleva lo ingresado. El 200 sí ([01578]): sin él se volvería a pedir el ingreso entero.
      if (config.clase === 'autoliquidacion' && !anterior && e.resultadoAnterior === null && codigo !== '390') {
        throw badRequest('Como la declaración anterior no está en la app, indica lo que se ingresó con ella (resultado anterior).');
      }
      const resultadoAnterior = config.clase === 'autoliquidacion' ? e.resultadoAnterior ?? calculo.resultadoAnterior(presentadas) : null;
      const registros = actuales ? actuales.filter((k) => !presentadas.some((p) => (datosDe(p).registros ?? []).some((r) => r.clave === k))) : null;
      const numero = config.numero ? await siguienteNumero(tx, companyId, codigo, ejercicio) : null;
      const creada = await tx.declaracionAeat.create({
        data: {
          ...delPeriodo(companyId, codigo, ejercicio, periodo),
          secuencia: await siguienteSecuencia(tx, companyId, codigo, ejercicio, periodo),
          tipo: e.tipo,
          estado: 'preparada',
          numero,
          anteriorId: anterior?.id ?? null,
          justificanteAnterior,
          resultadoAnterior,
          registros: registros === null ? Prisma.DbNull : (registros as Prisma.InputJsonValue),
          datos: {
            ...(e.devolucionAcordada ? { devolucionAcordada: e.devolucionAcordada } : {}),
            ...(bajas.length ? { bajas } : {}),
            ...(registros !== null && actuales ? { vistos: actuales } : {}),
          } as Prisma.InputJsonValue,
          creadoPor: userId,
        },
      });
      // La fila de trabajo vuelve a vigente: se recalcula. Lo presentado queda en el historial.
      await tx.modeloImpuesto.updateMany({ where: delPeriodo(companyId, codigo, ejercicio, periodo), data: { estado: 'vigente', origen: 'autorrelleno' } });
      return creada;
    }),
  );
  await registrarAuditoria({
    userId,
    companyId,
    action: `RECTIFICACION_${codigo}`,
    resourceType: 'modelo_fiscal',
    resourceId: `${codigo}-${ejercicio}-${periodo}`,
    meta: { tipo: fila.tipo, secuencia: fila.secuencia, numero: fila.numero, anterior: fila.justificanteAnterior },
  });
  return fila;
}

/**
 * Guarda los registros elegidos para la complementaria en curso de una
 * informativa. `vistos`: las claves de los registros que hay ahora (los que la
 * persona tiene delante al elegir); dejan de proponerse solos.
 */
export async function guardarRegistros(
  companyId: string,
  codigo: string,
  ejercicio: number,
  periodo: string,
  registros: unknown,
  vistos: string[] = [],
): Promise<FilaDeclaracion> {
  const config = configModelo(codigo);
  if (config.clase !== 'informativa') throw badRequest(`El ${codigo} no tiene registros que elegir.`);
  if (!Array.isArray(registros) || registros.some((r) => typeof r !== 'string')) throw badRequest('"registros" es la lista de claves de los registros que van en la complementaria.');
  const enCurso = await prisma.declaracionAeat.findFirst({ where: { ...delPeriodo(companyId, codigo, ejercicio, periodo), estado: 'preparada' } });
  if (!enCurso || enCurso.tipo !== 'C') throw badRequest('Los registros solo se eligen en una complementaria en preparación.');
  const datos = (enCurso.datos ?? {}) as DatosEnCurso;
  const todosVistos = [...new Set([...(datos.vistos ?? []), ...vistos, ...(registros as string[])])];
  return prisma.declaracionAeat.update({
    where: { id: enCurso.id },
    data: { registros: [...new Set(registros as string[])], datos: { ...datos, vistos: todosVistos } as Prisma.InputJsonValue },
  });
}

/**
 * Cancela la complementaria o sustitutiva en curso: queda anulada (su número
 * no se reutiliza) y ModeloImpuesto vuelve a lo presentado.
 */
export async function cancelarRectificacion(companyId: string, userId: string, codigo: string, ejercicio: number, periodo: string): Promise<void> {
  configModelo(codigo);
  await prisma.$transaction(async (tx) => {
    const vivas = await tx.declaracionAeat.findMany({ where: { ...delPeriodo(companyId, codigo, ejercicio, periodo), estado: { not: 'anulada' } }, orderBy: { secuencia: 'asc' } });
    const enCurso = vivas.find((d) => d.estado === 'preparada');
    if (!enCurso) throw badRequest(`No hay ninguna declaración del ${codigo} en preparación.`);
    await tx.declaracionAeat.update({ where: { id: enCurso.id }, data: { estado: 'anulada' } });
    const ultima = vivas.filter((d) => d.estado === 'presentada').pop();
    if (ultima) {
      const f = datosDe(ultima).fila ?? {};
      await tx.modeloImpuesto.updateMany({
        where: delPeriodo(companyId, codigo, ejercicio, periodo),
        data: { estado: 'presentado', casillas: (f.casillas ?? {}) as Prisma.InputJsonValue, datos: (f.datos ?? {}) as Prisma.InputJsonValue },
      });
    }
  });
  await registrarAuditoria({ userId, companyId, action: `CANCELAR_RECTIFICACION_${codigo}`, resourceType: 'modelo_fiscal', resourceId: `${codigo}-${ejercicio}-${periodo}` });
}

/**
 * «No presentado»: la última presentada queda anulada (se marcó por error) y
 * ModeloImpuesto vuelve a la anterior presentada o a vigente.
 */
export async function anularUltimaPresentacion(companyId: string, userId: string, codigo: string, ejercicio: number, periodo: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const vivas = await tx.declaracionAeat.findMany({ where: { ...delPeriodo(companyId, codigo, ejercicio, periodo), estado: { not: 'anulada' } }, orderBy: { secuencia: 'asc' } });
    if (vivas.some((d) => d.estado === 'preparada')) throw conflict('Hay una complementaria o sustitutiva en preparación: cancélala antes.');
    const presentadas = vivas.filter((d) => d.estado === 'presentada');
    const ultima = presentadas.pop();
    if (ultima) await tx.declaracionAeat.update({ where: { id: ultima.id }, data: { estado: 'anulada' } });
    const anterior = presentadas.pop();
    const f = anterior ? datosDe(anterior).fila ?? {} : null;
    await tx.modeloImpuesto.updateMany({
      where: delPeriodo(companyId, codigo, ejercicio, periodo),
      data: f
        ? { estado: 'presentado', casillas: (f.casillas ?? {}) as Prisma.InputJsonValue, datos: (f.datos ?? {}) as Prisma.InputJsonValue }
        : { estado: 'vigente' },
    });
  });
  await registrarAuditoria({ userId, companyId, action: `NO_PRESENTADO_${codigo}`, resourceType: 'modelo_fiscal', resourceId: `${codigo}-${ejercicio}-${periodo}` });
}

/** Historial para la pantalla. */
export interface HistorialDeclaraciones {
  codigo: string;
  ejercicio: number;
  periodo: string;
  clase: ConfigModeloAeat['clase'];
  nombres: ConfigModeloAeat['nombres'];
  /** 'sin-presentar' | 'presentada' | 'en-curso' */
  estado: 'sin-presentar' | 'presentada' | 'en-curso';
  rectificaciones: TipoRectificacion[];
  presentadoSinHistorial: boolean;
  declaraciones: Array<{
    id: string;
    secuencia: number;
    tipo: TipoDeclaracionAeat;
    tipoTexto: string;
    estado: string;
    numero: string | null;
    justificante: string | null;
    justificanteAnterior: string | null;
    fechaPresentacion: string | null;
    resultadoAnterior: number | null;
    resultado: number | null;
    numeroRegistros: number | null;
    presentadoPor: string | null;
    presentadoEn: string | null;
  }>;
  enCurso: {
    tipo: TipoDeclaracionAeat;
    tipoTexto: string;
    numero: string | null;
    justificanteAnterior: string | null;
    resultadoAnterior: number | null;
    registros: string[] | null;
    /** Sustitutiva de una informativa: números que hay que dar de baja en la sede antes de presentarla. */
    bajas: string[];
    /** Texto para la pantalla con lo que hay que hacer en la sede antes de presentar (o null). */
    aviso: string | null;
  } | null;
}

/** Historial de un modelo y periodo (no escribe). */
export async function historialDeclaraciones(companyId: string, codigo: string, ejercicio: number, periodo: string): Promise<HistorialDeclaraciones> {
  const ctx = await contextoDeclaracion(companyId, codigo, ejercicio, periodo);
  const legado = !ctx.ultimaPresentada
    ? await prisma.modeloImpuesto.findUnique({ where: { companyId_codigo_ejercicio_periodo: delPeriodo(companyId, codigo, ejercicio, periodo) }, select: { estado: true } })
    : null;
  const presentadoSinHistorial = legado?.estado === 'presentado';
  const todas = await prisma.declaracionAeat.findMany({ where: delPeriodo(companyId, codigo, ejercicio, periodo), orderBy: { secuencia: 'asc' } });
  const bajasEnCurso = (((ctx.enCurso?.datos ?? {}) as DatosEnCurso).bajas ?? []).map(String);
  return {
    codigo,
    ejercicio,
    periodo,
    clase: ctx.config.clase,
    nombres: ctx.config.nombres,
    estado: ctx.enCurso && (ctx.presentadas.length || ctx.enCurso.tipo !== 'N') ? 'en-curso' : ctx.congelada || presentadoSinHistorial ? 'presentada' : 'sin-presentar',
    rectificaciones: ctx.config.rectificaciones,
    presentadoSinHistorial,
    declaraciones: todas.map((d) => ({
      id: d.id,
      secuencia: d.secuencia,
      tipo: d.tipo as TipoDeclaracionAeat,
      tipoTexto: ctx.config.nombres[d.tipo as TipoDeclaracionAeat] ?? d.tipo,
      estado: d.estado,
      numero: d.numero,
      justificante: d.justificante,
      justificanteAnterior: d.justificanteAnterior,
      fechaPresentacion: d.fechaPresentacion,
      resultadoAnterior: d.resultadoAnterior === null ? null : Number(d.resultadoAnterior),
      resultado: datosDe(d).resultado ?? null,
      numeroRegistros: datosDe(d).registros?.length ?? null,
      presentadoPor: d.presentadoPor,
      presentadoEn: d.presentadoEn ? d.presentadoEn.toISOString() : null,
    })),
    enCurso: ctx.enCurso
      ? {
          tipo: ctx.enCurso.tipo as TipoDeclaracionAeat,
          tipoTexto: ctx.config.nombres[ctx.enCurso.tipo as TipoDeclaracionAeat],
          numero: ctx.enCurso.numero,
          justificanteAnterior: ctx.enCurso.justificanteAnterior,
          resultadoAnterior: ctx.enCurso.resultadoAnterior === null ? null : Number(ctx.enCurso.resultadoAnterior),
          registros: ctx.registros,
          bajas: bajasEnCurso,
          aviso: avisoBajasSustitutiva(codigo, bajasEnCurso),
        }
      : null,
  };
}
