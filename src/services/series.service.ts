import type { InvoiceSeries } from '@prisma/client';
import { prisma } from '../config/database';
import { SerieDocumento, TipoDocumentoSerie } from '../domain/series.model';
import { badRequest, notFound } from '../utils/http-errors';

/**
 * Series de documentos por empresa, guardadas en la tabla InvoiceSeries.
 * Cada serie lleva su ultimo numero emitido: la numeracion de las facturas
 * finales sale de aqui, en orden y sin huecos (ver siguienteNumero).
 */

function aDominio(s: InvoiceSeries): SerieDocumento {
  return {
    id: s.id,
    companyId: s.companyId,
    codigo: s.codigo,
    descripcion: s.descripcion,
    tipoDocumento: s.tipoDocumento as TipoDocumentoSerie,
    activa: s.activa,
    porDefecto: s.porDefecto,
    ultimoNumero: s.ultimoNumero,
    ultimaFecha: s.ultimaFecha ?? undefined,
    creadoEn: s.createdAt.toISOString(),
    actualizadoEn: s.updatedAt.toISOString(),
  };
}

/** Series que toda empresa necesita: la general de facturas y la de rectificativas. */
const SEMILLAS: Array<Pick<SerieDocumento, 'codigo' | 'descripcion' | 'tipoDocumento'>> = [
  { codigo: 'A', descripcion: 'Serie general', tipoDocumento: 'FACTURA' },
  { codigo: 'R', descripcion: 'Facturas rectificativas', tipoDocumento: 'RECTIFICATIVA' },
];

/** Crea las series por defecto que le falten a la empresa (idempotente). */
async function asegurarSemilla(companyId: string): Promise<void> {
  const existentes = await prisma.invoiceSeries.findMany({ where: { companyId }, select: { tipoDocumento: true } });
  const tipos = new Set(existentes.map((s) => s.tipoDocumento));
  for (const semilla of SEMILLAS) {
    if (tipos.has(semilla.tipoDocumento)) continue;
    // upsert: dos peticiones a la vez no deben chocar con el unico (empresa, codigo).
    await prisma.invoiceSeries.upsert({
      where: { companyId_codigo: { companyId, codigo: semilla.codigo } },
      create: { companyId, ...semilla, activa: true, porDefecto: true },
      update: {},
    });
  }
}

export async function listarSeries(companyId: string, tipoDocumento?: TipoDocumentoSerie): Promise<SerieDocumento[]> {
  await asegurarSemilla(companyId);
  const series = await prisma.invoiceSeries.findMany({
    where: { companyId, ...(tipoDocumento ? { tipoDocumento } : {}) },
    orderBy: [{ tipoDocumento: 'asc' }, { codigo: 'asc' }],
  });
  return series.map(aDominio);
}

/** Si una serie pasa a ser la por defecto, el resto del mismo tipo deja de serlo. */
async function desmarcarOtrasPorDefecto(companyId: string, tipoDocumento: string, exceptoId?: string): Promise<void> {
  await prisma.invoiceSeries.updateMany({
    where: { companyId, tipoDocumento, porDefecto: true, ...(exceptoId ? { NOT: { id: exceptoId } } : {}) },
    data: { porDefecto: false },
  });
}

export async function crearSerie(
  companyId: string,
  data: Pick<SerieDocumento, 'codigo' | 'descripcion' | 'tipoDocumento' | 'activa' | 'porDefecto'>,
): Promise<SerieDocumento> {
  const codigo = data.codigo?.trim().toUpperCase();
  if (!codigo) throw badRequest('El código de la serie es obligatorio.');
  if (!/^[A-Z0-9-]{1,10}$/.test(codigo)) {
    throw badRequest('El código de la serie solo admite letras, números y guiones (máximo 10).');
  }
  const dup = await prisma.invoiceSeries.findUnique({ where: { companyId_codigo: { companyId, codigo } } });
  if (dup) throw badRequest(`Ya existe la serie '${codigo}'.`);

  if (data.porDefecto) await desmarcarOtrasPorDefecto(companyId, data.tipoDocumento);
  const serie = await prisma.invoiceSeries.create({
    data: {
      companyId,
      codigo,
      descripcion: data.descripcion ?? '',
      tipoDocumento: data.tipoDocumento,
      activa: data.activa ?? true,
      porDefecto: data.porDefecto ?? false,
    },
  });
  return aDominio(serie);
}

export async function actualizarSerie(
  companyId: string,
  serieId: string,
  data: Partial<Pick<SerieDocumento, 'descripcion' | 'activa' | 'porDefecto'>>,
): Promise<SerieDocumento> {
  const actual = await prisma.invoiceSeries.findFirst({ where: { id: serieId, companyId } });
  if (!actual) throw notFound('Serie no encontrada.');
  // El codigo, el tipo y la numeracion no se tocan: cambiarlos romperia la
  // correlatividad de las facturas ya emitidas.
  if (data.porDefecto === true) await desmarcarOtrasPorDefecto(companyId, actual.tipoDocumento, actual.id);
  const serie = await prisma.invoiceSeries.update({
    where: { id: serieId },
    data: {
      ...(data.descripcion !== undefined ? { descripcion: String(data.descripcion) } : {}),
      ...(data.activa !== undefined ? { activa: Boolean(data.activa) } : {}),
      ...(data.porDefecto !== undefined ? { porDefecto: Boolean(data.porDefecto) } : {}),
    },
  });
  return aDominio(serie);
}

export async function obtenerSeriePorDefecto(
  companyId: string,
  tipoDocumento: TipoDocumentoSerie,
): Promise<SerieDocumento | null> {
  const series = (await listarSeries(companyId, tipoDocumento)).filter((s) => s.activa);
  return series.find((s) => s.porDefecto) ?? series[0] ?? null;
}

/**
 * Resuelve la serie a usar al crear una factura a partir del DTO:
 *  - serieId     -> esa serie (de la empresa y de tipo FACTURA)
 *  - serieCodigo -> busca por codigo
 *  - si nada     -> serie por defecto de FACTURA
 * Devuelve el codigo de la serie.
 */
export async function resolverCodSerieFactura(
  companyId: string,
  dto: { serieId?: string; serieCodigo?: string },
): Promise<string> {
  if (dto.serieId) {
    const s = await prisma.invoiceSeries.findFirst({ where: { id: dto.serieId, companyId } });
    if (!s || s.tipoDocumento !== 'FACTURA') throw badRequest('serieId no valido para esta empresa.');
    return s.codigo;
  }
  if (dto.serieCodigo) {
    const series = await listarSeries(companyId, 'FACTURA');
    const s = series.find((x) => x.codigo === dto.serieCodigo);
    if (!s) throw badRequest(`serieCodigo '${dto.serieCodigo}' no existe para FACTURA.`);
    return s.codigo;
  }
  const def = await obtenerSeriePorDefecto(companyId, 'FACTURA');
  if (!def) throw badRequest('No hay serie por defecto de FACTURA configurada.');
  return def.codigo;
}

/** Serie por codigo; si no existe se crea (las facturas antiguas usaban "2026" como serie). */
export async function obtenerOCrearSerie(
  companyId: string,
  codigo: string,
  tipoDocumento: TipoDocumentoSerie = 'FACTURA',
): Promise<SerieDocumento> {
  await asegurarSemilla(companyId);
  const s = await prisma.invoiceSeries.upsert({
    where: { companyId_codigo: { companyId, codigo } },
    create: { companyId, codigo, descripcion: `Serie ${codigo}`, tipoDocumento, activa: true, porDefecto: false },
    update: {},
  });
  return aDominio(s);
}
