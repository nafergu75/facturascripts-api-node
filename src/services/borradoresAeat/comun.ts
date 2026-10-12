/**
 * Piezas comunes de los borradores de los modelos: datos del declarante y su
 * persona de contacto (B3), opciones de cada declaracion (domiciliacion, base a
 * mano...), la declaracion en curso de las informativas (numero, tipo y
 * registros elegidos, B4 y B5) y envio del fichero en ISO-8859-1.
 *
 * Las opciones se guardan en la fila del calendario (ModeloImpuesto) del
 * modelo y periodo, en casillas que empiezan por "opc_" (un solo prefijo para
 * todos los modelos): el autorrelleno del modulo de Impuestos las conserva.
 */
import type { Response } from 'express';
import { prisma } from '../../config/database';
import { badRequest, conflict, forbidden } from '../../utils/http-errors';
import { erroresContactoAeat } from '../../aeat/common/normalizacion';
import { contextoDeclaracion, incluyeRegistro, type ContextoDeclaracion } from '../declaracionesAeat/declaraciones.service';

export interface DeclaranteEmpresa {
  nif: string;
  nombre: string;
  telefono: string;
  personaContacto: string;
}

/** NIF y razon social (Registro Mercantil > Datos para la memoria), telefono y persona de contacto (Datos de la empresa, apartado Contacto). */
export async function declaranteEmpresa(companyId: string): Promise<DeclaranteEmpresa> {
  const [legal, empresa] = await Promise.all([
    prisma.legalConfig.findUnique({ where: { companyId }, select: { nif: true, denominacion: true, telefono: true, personaContacto: true } }),
    prisma.company.findUnique({ where: { id: companyId }, select: { name: true } }),
  ]);
  return {
    nif: legal?.nif ?? '',
    nombre: legal?.denominacion || empresa?.name || '',
    telefono: legal?.telefono ?? '',
    personaContacto: legal?.personaContacto ?? '',
  };
}

/**
 * Persona de contacto y teléfono de la empresa para los modelos que los piden
 * (347, 349, 180, 190 y 200): los de Datos de la empresa (apartado Contacto). Si faltan, es
 * un error (el fichero da 400 y dice dónde rellenarlos), no un aviso.
 */
export async function contactoEmpresa(companyId: string): Promise<{ personaContacto: string; telefono: string }> {
  const legal = await prisma.legalConfig.findUnique({ where: { companyId }, select: { telefono: true, personaContacto: true } }).catch(() => null);
  return { personaContacto: legal?.personaContacto ?? '', telefono: legal?.telefono ?? '' };
}

/** Errores por los datos de contacto que faltan (vacío si están): ver erroresContactoAeat. */
export const erroresContacto = erroresContactoAeat;

export type OpcionesModelo = Record<string, string | number | boolean | null>;

export interface FilaCalendario {
  id: string;
  estado: string;
  casillas: Record<string, unknown>;
  datos: unknown;
}

/** Fila del calendario del modelo y periodo, si existe. */
export async function filaModelo(companyId: string, codigo: string, ejercicio: number, periodo: string): Promise<FilaCalendario | null> {
  const f = await prisma.modeloImpuesto.findUnique({ where: { companyId_codigo_ejercicio_periodo: { companyId, codigo, ejercicio, periodo } } });
  return f ? { id: f.id, estado: f.estado, casillas: (f.casillas as Record<string, unknown> | null) ?? {}, datos: f.datos } : null;
}

/** Prefijo de las opciones guardadas en las casillas de ModeloImpuesto. */
export const PREFIJO_OPCION = 'opc_';
export const esOpcion = (clave: string) => clave.startsWith(PREFIJO_OPCION);

/** Opciones guardadas de la declaracion (sin el prefijo opc_). */
export function opcionesDe(fila: FilaCalendario | null): OpcionesModelo {
  const out: OpcionesModelo = {};
  for (const [k, v] of Object.entries(fila?.casillas ?? {})) if (k.startsWith('opc_')) out[k.slice(4)] = v as never;
  return out;
}

/** Casillas "opc_" de una fila: las conserva el autorrelleno del modulo de Impuestos. */
export function conservarOpciones<T>(casillas: Record<string, T> | null | undefined): Record<string, T> {
  return Object.fromEntries(Object.entries(casillas ?? {}).filter(([k]) => k.startsWith('opc_')));
}

/**
 * Guarda opciones de la declaracion (null borra la opcion). Crea la fila del
 * calendario si no existe (lo llaman rutas con permiso de escritura). Una
 * declaracion presentada no se cambia: hay que preparar una complementaria.
 */
export async function guardarOpciones(companyId: string, codigo: string, ejercicio: number, periodo: string, opciones: OpcionesModelo): Promise<void> {
  const fila = await filaModelo(companyId, codigo, ejercicio, periodo);
  if (fila && (fila.estado === 'presentado' || fila.estado === 'omitido')) {
    throw forbidden(
      fila.estado === 'presentado'
        ? `El ${codigo} de ${periodo} de ${ejercicio} está presentado: para cambiarlo, prepara una complementaria o una sustitutiva.`
        : `El ${codigo} de ${periodo} de ${ejercicio} está omitido: recupéralo antes de cambiarlo.`,
    );
  }
  const casillas: Record<string, unknown> = { ...(fila?.casillas ?? {}) };
  for (const [k, v] of Object.entries(opciones)) {
    if (v === null || v === undefined || v === '') delete casillas[`opc_${k}`];
    else casillas[`opc_${k}`] = v;
  }
  await prisma.modeloImpuesto.upsert({
    where: { companyId_codigo_ejercicio_periodo: { companyId, codigo, ejercicio, periodo } },
    create: { companyId, codigo, ejercicio, periodo, casillas: casillas as never },
    update: { casillas: casillas as never },
  });
}

/** Ejercicio de la peticion (año de cuatro cifras). */
export function ejercicioDe(raw: unknown): number {
  const e = Number(raw);
  if (!Number.isInteger(e) || e < 2000 || e > 2100) throw badRequest('Indica el ejercicio (año con cuatro cifras).');
  return e;
}

/** Fichero de texto en ISO-8859-1 (la Ñ y la Ç en un byte), como lo importa la sede. */
export function enviarFicheroAeat(res: Response, nombre: string, contenido: string): void {
  res.setHeader('Content-Type', 'text/plain; charset=ISO-8859-1');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  res.status(200).send(Buffer.from(contenido, 'latin1'));
}

/** Lo que se presento de una declaracion: la entrada del fichero y el justificante. */
export interface Presentacion<E> {
  entrada: E;
  justificante?: { numero: string; fecha: string };
  fechaPresentacion?: string;
}

/** La declaracion presentada de una fila (si lo esta y guardo su entrada). */
export function presentacionDe<E>(fila: FilaCalendario | null): Presentacion<E> | null {
  if (fila?.estado !== 'presentado') return null;
  const d = fila.datos as Presentacion<E> | null;
  return d && typeof d === 'object' && d.entrada ? d : null;
}

/** Aviso de que se enseña lo presentado, no un calculo nuevo. */
export const avisoPresentado = (p: Presentacion<unknown>) =>
  `Presentado${p.justificante?.numero ? ` (justificante ${p.justificante.numero}${p.justificante.fecha ? `, ${p.justificante.fecha}` : ''})` : ''}: se enseña lo que se presentó. Las facturas que cambien después no lo modifican.`;

// ---------------------------------------------------------------------------
// Declaracion en curso de los modelos informativos (347, 349, 180 y 190)
// ---------------------------------------------------------------------------

/** Lo que pone el historial de declaraciones en el registro de tipo 1. */
export interface DeclaracionInformativa {
  tipoDeclaracion: 'C' | 'S' | null;
  /** Numero identificativo de la anterior (complementaria o sustitutiva). */
  declaracionAnterior: string | null;
  /** Numero de esta declaracion; null si aun no tiene (se asigna al descargar o presentar). */
  numeroDeclaracion: string | null;
  /** Complementaria: claves de los registros elegidos; null = todos. */
  seleccion: string[] | null;
  /**
   * Complementaria: si un registro va (los elegidos y los nuevos que aparecen
   * después de prepararla sin haberse presentado); null = todos.
   */
  incluye: ((clave: string) => boolean) | null;
  ctx: ContextoDeclaracion;
}

/** Declaracion en curso (o la ultima presentada) de una informativa. Solo lee. */
export async function declaracionInformativa(companyId: string, codigo: '347' | '349' | '180' | '190', ejercicio: number, periodo: string): Promise<DeclaracionInformativa> {
  const ctx = await contextoDeclaracion(companyId, codigo, ejercicio, periodo);
  const tipo = ctx.tipo === 'C' || ctx.tipo === 'S' ? ctx.tipo : null;
  return { tipoDeclaracion: tipo, declaracionAnterior: tipo ? ctx.justificanteAnterior : null, numeroDeclaracion: ctx.numero, seleccion: ctx.registros, incluye: incluyeRegistro(ctx), ctx };
}

/** Aviso de la pantalla mientras la declaracion no tiene numero. */
export const AVISO_SIN_NUMERO = 'La app le pone a la declaración su número identificativo al descargar el fichero (o al marcarla como presentada), y ya no cambia.';

/** 409 del fichero de una informativa sin numero: lo asigna una operacion de escritura (B5). */
export function exigirNumero(numero: string | null | undefined, codigo: string): string {
  if (!numero) {
    throw conflict(`La declaración del ${codigo} todavía no tiene número identificativo: pulsa «Descargar fichero» en su pantalla y la app se lo pondrá.`, { motivo: 'SIN_NUMERO' });
  }
  return numero;
}

/** Registros de una complementaria: los que incluye (todos en la normal o la sustitutiva). */
export function registrosElegidos<T>(items: T[], clave: (t: T) => string, incluye: ((clave: string) => boolean) | null): T[] {
  if (!incluye) return items;
  return items.filter((t) => incluye(clave(t)));
}
