/**
 * Lo que anaden las lecturas a los "confirmar" de hoy, con dos llamadas para
 * tocar lo menos posible los controladores:
 *
 *  - Antes de registrar: comprobarLecturaParaConfirmar (gastos) o
 *    comprobarRevisionVenta (ventas). Exigen "He revisado" si algo estaba
 *    marcado y, en gastos, vuelven a validar lo que llega en el cuerpo.
 *  - Despues: vincularLectura. La lectura queda CONFIRMADA (quien y cuando),
 *    el original de un gasto se archiva con la factura y se borra el de la
 *    lectura.
 *
 * Este modulo no importa ingresos-extractor.service (que lo usa) para no
 * crear un ciclo.
 */
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { hoyEspana } from '../../utils/fechas';
import { badRequest, conflict, notFound } from '../../utils/http-errors';
import { deleteObject, getObject } from '../../utils/storage';
import { archivarGastoSinRomper } from '../archivoFacturas.service';
import { perfilEmpresa } from '../perfilEmpresa.service';
import { lecturaVacia, type Lector, type LecturaNormalizada, type OrigenLectura, type ResultadoValidacion } from './tipos';
import { validacionesSincronas } from './validaciones';

export const MENSAJE_FALTA_REVISION = 'Marca que has revisado los datos señalados antes de registrar.';
export const MENSAJE_LECTURA_NO_ENCONTRADA = 'No se encuentra esa lectura.';

type FilaLectura = NonNullable<Awaited<ReturnType<typeof prisma.lecturaDocumento.findFirst>>>;

const pct = (c: number | null | undefined) => (typeof c === 'number' ? ` (confianza ${Math.round(c * 100)} %)` : '');

/** Texto que va delante de las observaciones de la factura. */
export function prefijoObservaciones(origen: string | null, confianza: number | null): string {
  switch (origen as OrigenLectura | null) {
    case 'AZURE':
      return `Leída con Azure${pct(confianza)}.`;
    case 'AZURE_CLAUDE':
      return `Leída con Azure y completada con IA${pct(confianza)}.`;
    case 'FACTURAE':
      return 'Leída del XML Facturae.';
    default:
      return 'Leída con IA (Claude).';
  }
}

const necesitaRevision = (fila: { estadoValidacion: string | null }) => fila.estadoValidacion !== null && fila.estadoValidacion !== 'ok';

/** Las validaciones que se guardaron al terminar la lectura. */
const validacionesGuardadas = (fila: { validaciones: unknown }): ResultadoValidacion[] => (Array.isArray(fila.validaciones) ? (fila.validaciones as ResultadoValidacion[]) : []);

/** Validaciones que se repiten sobre lo que llega al confirmar un gasto (V14 la sigue haciendo registrarGasto, con su 409). */
const REVALIDAR_GASTO = new Set(['TIPO_IVA', 'NIF_EMISOR', 'EMPRESA', 'FECHA']);

/** El cuerpo del alta de un gasto, como lectura, para volver a validarlo. */
async function lecturaDelCuerpo(companyId: string, cuerpo: Record<string, unknown>, guardada: LecturaNormalizada | null): Promise<LecturaNormalizada> {
  const l = lecturaVacia('claude');
  const prov = (cuerpo.proveedor ?? {}) as { id?: unknown; nuevo?: { nifCif?: unknown } };
  let nif: string | null = typeof prov.nuevo?.nifCif === 'string' ? prov.nuevo.nifCif : null;
  if (!nif && typeof prov.id === 'string') nif = (await prisma.supplier.findFirst({ where: { id: prov.id, companyId }, select: { nifCif: true } }))?.nifCif ?? null;
  l.emisor.nif = { valor: nif, confianza: null, fuente: 'claude' };
  l.receptor.nif = guardada?.receptor.nif ?? l.receptor.nif;
  l.numero = { valor: typeof cuerpo.numeroFacturaProveedor === 'string' ? cuerpo.numeroFacturaProveedor : null, confianza: null, fuente: 'claude' };
  l.fechaEmision = { valor: typeof cuerpo.fechaEmision === 'string' ? cuerpo.fechaEmision : null, confianza: null, fuente: 'claude' };
  const tipos = new Set<number>();
  for (const linea of Array.isArray(cuerpo.lineas) ? (cuerpo.lineas as Array<{ tipoIva?: unknown }>) : []) {
    if (typeof linea.tipoIva === 'number') tipos.add(linea.tipoIva);
  }
  l.desglose = [...tipos].map((tipoIva) => ({ tipoIva, base: { valor: 0, confianza: null, fuente: 'claude' }, cuota: { valor: 0, confianza: null, fuente: 'claude' }, tipoRecargo: null, cuotaRecargo: null }));
  return l;
}

/**
 * Antes de registrar un gasto leido. Devuelve la fila de la lectura (para el
 * prefijo de observaciones).
 */
export async function comprobarLecturaParaConfirmar(companyId: string, lecturaId: string, lector: Lector, cuerpo: Record<string, unknown>): Promise<FilaLectura> {
  const fila = await prisma.lecturaDocumento.findFirst({ where: { id: lecturaId, companyId, lector } });
  if (!fila) throw notFound(MENSAJE_LECTURA_NO_ENCONTRADA);
  if (fila.estado === 'CONFIRMADA') throw conflict('Esta factura ya se registró.', { codigo: 'LECTURA_YA_CONFIRMADA' });
  if (fila.estado !== 'LISTA') throw badRequest('Esta lectura ya no se puede registrar: está descartada o no ha terminado. Vuelve a leer la factura.', { codigo: 'LECTURA_NO_LISTA' });
  if (necesitaRevision(fila) && cuerpo.revisado !== true) throw badRequest(MENSAJE_FALTA_REVISION, { codigo: 'FALTA_REVISION' });
  // Una rectificativa (o un abono) no se arregla en el formulario: el gasto subiria en vez de bajar.
  const rectificativa = validacionesGuardadas(fila).find((v) => v.codigo === 'RECTIFICATIVA' && v.nivel === 'error');
  if (rectificativa) throw badRequest(rectificativa.mensaje, { codigo: 'RECTIFICATIVA_NO_ADMITIDA' });

  const guardada = ((fila.resultado as { lectura?: LecturaNormalizada } | null)?.lectura ?? null) as LecturaNormalizada | null;
  const l = await lecturaDelCuerpo(companyId, cuerpo, guardada);
  const [legal, perfil] = await Promise.all([prisma.legalConfig.findUnique({ where: { companyId }, select: { nif: true } }), perfilEmpresa(companyId)]);
  const errores = validacionesSincronas(l, {
    lector,
    nifEmpresa: legal?.nif ?? null,
    empresaEspanola: perfil.espanola,
    monedaCuenta: perfil.monedaCuenta,
    hoy: hoyEspana(),
    periodoAbierto: async () => true,
    duplicado: { factura: null, archivo: null },
  }).filter((v) => REVALIDAR_GASTO.has(v.codigo) && v.nivel === 'error');
  if (errores.length) {
    throw badRequest(errores[0].mensaje, { codigo: 'VALIDACION_LECTURA', campo: errores[0].campos[0] ?? null, validaciones: errores });
  }
  return fila;
}

/**
 * Antes de registrar una venta leida: si la lectura tenia algo marcado, hace
 * falta "He revisado"; y lo que la lectura dejo en error sigue bloqueando,
 * aunque el documento se haya corregido despues por PUT /invoice-extractor/:id
 * (que rehace validation.errors con las validaciones antiguas).
 */
export async function comprobarRevisionVenta(companyId: string, incomeReaderDocumentId: string, revisado: boolean): Promise<void> {
  const fila = await prisma.lecturaDocumento.findFirst({ where: { companyId, incomeReaderDocumentId, lector: 'VENTA' }, select: { estado: true, estadoValidacion: true, validaciones: true } });
  if (!fila) return; // Documento del lector de siempre (/extraer-ia): como hoy.
  if (fila.estado === 'CONFIRMADA') throw conflict('Esta factura ya se registró.', { codigo: 'LECTURA_YA_CONFIRMADA' });
  if (necesitaRevision(fila) && !revisado) throw badRequest(MENSAJE_FALTA_REVISION, { codigo: 'FALTA_REVISION' });
  const errores = validacionesGuardadas(fila).filter((v) => v.nivel === 'error');
  if (errores.length) {
    throw badRequest(`No se puede registrar: ${[...new Set(errores.map((v) => v.mensaje))].join(' ')}`, { codigo: 'VALIDACION_LECTURA', validaciones: errores });
  }
}

/** Tras registrar: la lectura queda CONFIRMADA. Nunca rompe el alta (lo que falle va al log). */
export async function vincularLectura(
  companyId: string,
  donde: { lecturaId?: string; incomeReaderDocumentId?: string },
  datos: { expenseInvoiceId?: string; incomeInvoiceId?: string; userId?: string | null; revisada: boolean },
): Promise<void> {
  const fila = await prisma.lecturaDocumento.findFirst({
    where: { companyId, estado: 'LISTA', ...(donde.lecturaId ? { id: donde.lecturaId } : { incomeReaderDocumentId: donde.incomeReaderDocumentId ?? '-' }) },
  });
  if (!fila) return;
  const hecho = await prisma.lecturaDocumento.updateMany({
    where: { id: fila.id, estado: 'LISTA' },
    data: {
      estado: 'CONFIRMADA',
      confirmadaPor: datos.userId ?? null,
      confirmadaEn: new Date(),
      revisada: datos.revisada,
      expenseInvoiceId: datos.expenseInvoiceId ?? null,
      incomeInvoiceId: datos.incomeInvoiceId ?? null,
    },
  });
  if (hecho.count === 0 || !fila.archivoRef) return;

  try {
    if (fila.lector === 'GASTO' && datos.expenseInvoiceId) {
      // El original se guarda con la factura (hoy se archivaba "sin original").
      const buffer = await getObject(fila.archivoRef);
      await archivarGastoSinRomper(companyId, datos.expenseInvoiceId, { buffer, nombre: fila.archivoNombre, mime: fila.archivoTipo });
    } else if (fila.lector === 'VENTA' && fila.incomeReaderDocumentId) {
      // El documento del lector movio el archivo a su carpeta; si no pudo, se deja.
      const doc = await prisma.incomeReaderDocument.findUnique({ where: { id: fila.incomeReaderDocumentId }, select: { storagePath: true } });
      if (doc?.storagePath === fila.archivoRef) return;
    }
    await deleteObject(fila.archivoRef);
    await prisma.lecturaDocumento.update({ where: { id: fila.id }, data: { archivoRef: null } });
  } catch (err) {
    logger.warn('[lectura] No se ha podido archivar o borrar el archivo de la lectura', { lecturaId: fila.id, error: (err as { name?: string })?.name ?? 'Error' });
  }
}
