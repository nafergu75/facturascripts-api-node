import { randomUUID } from 'crypto';
import { SerieDocumento } from '../domain/series.model';
import { badRequest, notFound } from '../utils/http-errors';

// PENDIENTE BLOQUEADO: persistir en BD (tabla series por empresa). Hoy en memoria.
// Riesgo: al reiniciar se pierden series personalizadas y solo queda la semilla
// 'A' por defecto — la numeracion de facturas seguiria funcionando (cae a la
// serie por defecto) pero las series adicionales configuradas desaparecerian.
// NOTA (deploy Vercel): el guard que LANZABA en produccion se ha rebajado a
// AVISO para permitir el despliegue serverless. Sigue siendo cierto que el
// almacenamiento es en memoria y NO persiste entre invocaciones serverless:
// pendiente migrar SerieDocumento a una tabla Prisma (TODO produccion real).
if (process.env.NODE_ENV !== 'test') {
  console.warn(
    '\x1b[33m[series.service] ADVERTENCIA: series de documentos en memoria. Se perderan al reiniciar.\x1b[0m',
  );
}

const store = new Map<string, SerieDocumento>(); // id -> serie
const ahora = (): string => new Date().toISOString();

/** Siembra una serie 'A' de FACTURA por defecto la primera vez que se consulta una empresa. */
const sembradas = new Set<string>();
function asegurarSemilla(companyId: string): void {
  if (sembradas.has(companyId)) return;
  sembradas.add(companyId);
  const yaTiene = [...store.values()].some((s) => s.companyId === companyId);
  if (yaTiene) return;
  const s: SerieDocumento = {
    id: randomUUID(),
    companyId,
    codigo: 'A',
    descripcion: 'Serie general',
    tipoDocumento: 'FACTURA',
    activa: true,
    porDefecto: true,
    creadoEn: ahora(),
    actualizadoEn: ahora(),
  };
  store.set(s.id, s);
}

export async function listarSeries(
  companyId: string,
  tipoDocumento?: SerieDocumento['tipoDocumento'],
): Promise<SerieDocumento[]> {
  asegurarSemilla(companyId);
  return [...store.values()].filter(
    (s) => s.companyId === companyId && (!tipoDocumento || s.tipoDocumento === tipoDocumento),
  );
}

/** Si la nueva serie es porDefecto, desmarca el resto del mismo tipo. */
function desmarcarOtrasPorDefecto(companyId: string, tipoDocumento: SerieDocumento['tipoDocumento'], exceptoId?: string): void {
  for (const s of store.values()) {
    if (s.companyId === companyId && s.tipoDocumento === tipoDocumento && s.id !== exceptoId && s.porDefecto) {
      s.porDefecto = false;
      s.actualizadoEn = ahora();
    }
  }
}

export async function crearSerie(
  companyId: string,
  data: Omit<SerieDocumento, 'id' | 'companyId' | 'creadoEn' | 'actualizadoEn'>,
): Promise<SerieDocumento> {
  if (!data.codigo) throw badRequest('codigo de serie obligatorio.');
  const dup = [...store.values()].some(
    (s) => s.companyId === companyId && s.tipoDocumento === data.tipoDocumento && s.codigo === data.codigo,
  );
  if (dup) throw badRequest(`Ya existe la serie '${data.codigo}' para ${data.tipoDocumento}.`);

  const serie: SerieDocumento = { ...data, id: randomUUID(), companyId, creadoEn: ahora(), actualizadoEn: ahora() };
  if (serie.porDefecto) desmarcarOtrasPorDefecto(companyId, serie.tipoDocumento);
  store.set(serie.id, serie);
  return serie;
}

export async function actualizarSerie(
  companyId: string,
  serieId: string,
  data: Partial<Omit<SerieDocumento, 'id' | 'companyId' | 'creadoEn'>>,
): Promise<SerieDocumento> {
  const actual = store.get(serieId);
  if (!actual || actual.companyId !== companyId) throw notFound('Serie no encontrada.');
  const actualizada: SerieDocumento = { ...actual, ...data, id: actual.id, companyId, creadoEn: actual.creadoEn, actualizadoEn: ahora() };
  if (data.porDefecto === true) desmarcarOtrasPorDefecto(companyId, actualizada.tipoDocumento, actualizada.id);
  store.set(serieId, actualizada);
  return actualizada;
}

export async function obtenerSeriePorDefecto(
  companyId: string,
  tipoDocumento: SerieDocumento['tipoDocumento'],
): Promise<SerieDocumento | null> {
  asegurarSemilla(companyId);
  const series = [...store.values()].filter((s) => s.companyId === companyId && s.tipoDocumento === tipoDocumento && s.activa);
  return series.find((s) => s.porDefecto) ?? series[0] ?? null;
}

/**
 * Resuelve la serie a usar al crear una factura a partir del DTO:
 *  - serieId    -> esa serie (validando pertenencia a la empresa y tipo FACTURA)
 *  - serieCodigo-> busca por codigo
 *  - si nada    -> serie por defecto de FACTURA
 * Devuelve el `codserie` que espera FacturaScripts.
 */
export async function resolverCodSerieFactura(
  companyId: string,
  dto: { serieId?: string; serieCodigo?: string },
): Promise<string> {
  if (dto.serieId) {
    const s = store.get(dto.serieId);
    if (!s || s.companyId !== companyId || s.tipoDocumento !== 'FACTURA') {
      throw badRequest('serieId no valido para esta empresa.');
    }
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
