/**
 * Piezas comunes de los borradores de los modelos 349, 180 y 202: datos del
 * declarante, opciones de cada declaracion (complementaria, sustitutiva,
 * domiciliacion...) y envio del fichero en ISO-8859-1.
 *
 * Las opciones se guardan en la fila del calendario (ModeloImpuesto) del
 * modelo y periodo, en casillas que empiezan por "opc_": el autorrelleno del
 * modulo de Impuestos las conserva.
 */
import type { Response } from 'express';
import { prisma } from '../../config/database';
import { badRequest, forbidden } from '../../utils/http-errors';
import { telefonoAeat } from '../../aeat/common/disenoRegistro';
import { registrarAuditoria } from '../auditoria.service';

export interface DeclaranteEmpresa {
  nif: string;
  nombre: string;
  telefono: string;
  personaContacto: string;
}

/** NIF, razon social, telefono y persona de contacto (Registro Mercantil > Datos). */
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

/** Avisos (no impiden el fichero) por los datos de contacto que faltan. */
export function avisosContacto(d: DeclaranteEmpresa): string[] {
  const avisos: string[] = [];
  if (!telefonoAeat(d.telefono)) avisos.push('Falta el teléfono de contacto (9 cifras) en Registro Mercantil > Datos: el fichero lo lleva a ceros.');
  if (!d.personaContacto.trim()) avisos.push('Falta la persona de contacto (apellidos y nombre) en Registro Mercantil > Datos.');
  return avisos;
}

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
 * calendario si no existe. Una declaracion presentada no se cambia.
 */
export async function guardarOpciones(companyId: string, codigo: string, ejercicio: number, periodo: string, opciones: OpcionesModelo): Promise<void> {
  const fila = await filaModelo(companyId, codigo, ejercicio, periodo);
  if (fila && (fila.estado === 'presentado' || fila.estado === 'omitido')) {
    throw forbidden(`El ${codigo} de ${periodo} de ${ejercicio} está ${fila.estado}: no se puede cambiar.`);
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

/** Justificante de la presentacion: numero y fecha (AAAA-MM-DD). */
export function justificanteDe(body: Record<string, unknown>): { numero: string; fecha: string } {
  const j = (body.justificante ?? {}) as Record<string, unknown>;
  const numero = String(j.numero ?? '').trim().toUpperCase();
  const fecha = String(j.fecha ?? '').trim();
  if (!/^[0-9A-Z]{6,20}$/.test(numero)) throw badRequest('Indica el número de justificante que da la sede al presentar.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw badRequest('Indica la fecha de presentación.');
  return { numero, fecha };
}

/**
 * Marca la declaracion como presentada y guarda lo que se presento (la
 * entrada del fichero), que es lo que se enseña despues y la base de las
 * rectificaciones y complementarias.
 */
export async function guardarPresentacion<E>(
  companyId: string,
  userId: string,
  codigo: string,
  ejercicio: number,
  periodo: string,
  entrada: E,
  justificante: { numero: string; fecha: string },
  resumen: Record<string, number>,
): Promise<void> {
  const fila = await filaModelo(companyId, codigo, ejercicio, periodo);
  if (fila?.estado === 'presentado') throw badRequest(`El ${codigo} de ${periodo} de ${ejercicio} ya está presentado.`);
  const casillas = { ...conservarOpciones(fila?.casillas), ...resumen };
  const datos = { entrada, justificante, fechaPresentacion: new Date().toISOString(), auditoria: { marcadoPresentadoPor: userId } };
  await prisma.modeloImpuesto.upsert({
    where: { companyId_codigo_ejercicio_periodo: { companyId, codigo, ejercicio, periodo } },
    create: { companyId, codigo, ejercicio, periodo, estado: 'presentado', casillas: casillas as never, datos: datos as never },
    update: { estado: 'presentado', casillas: casillas as never, datos: datos as never },
  });
  await registrarAuditoria({ userId, companyId, action: `MARCAR_${codigo}_PRESENTADO`, resourceType: 'modelo_fiscal', resourceId: `${codigo}-${ejercicio}-${periodo}` });
}
