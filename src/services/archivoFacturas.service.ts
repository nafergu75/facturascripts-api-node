/**
 * ARCHIVO DE FACTURAS POR AÑO Y TRIMESTRE
 *
 * Guarda una copia de cada factura de venta emitida y de cada factura de gasto
 * en su carpeta:
 *
 *   archivo/<companyId>/<anio>/<T>T/<ventas|gastos>/<fecha>_<numero>_<tercero>.<ext>
 *
 * y deja constancia en DocumentoArchivo (tipo 'ingreso' | 'gasto'), enlazado con
 * la factura. El arbol y los listados se calculan desde las FACTURAS, no solo
 * desde los documentos: asi el historial esta completo aunque alguna copia no se
 * haya podido guardar (p. ej. en Vercel sin Blob configurado).
 *
 * Todo el archivado automatico es "no bloqueante": si falla, se avisa en el log
 * y la operacion principal (emitir, registrar el gasto...) sigue adelante.
 */
import { createHash } from 'crypto';
import { prisma } from '../config/database';
import { logger } from '../config/logger';
import { badRequest, notFound } from '../utils/http-errors';
import { putObject, getObject } from '../utils/storage';
import { nombreSeguro } from '../utils/nombre-seguro';
import { crearZip, ZipEntry } from '../utils/zip';
import { generarPdfFactura } from './facturaPdf.service';
import { perfilEmpresa } from './perfilEmpresa.service';

export type CarpetaArchivo = 'ventas' | 'gastos';

/**
 * Tipos de DocumentoArchivo que no son facturas y solo se ven con nominas:read
 * (los PDF de nominas y de seguros sociales, ver services/nominas/documentos.ts).
 * El archivo de facturas (contabilidad:read) no los lista ni los descarga.
 */
export const TIPOS_DOCUMENTO_PRIVADOS = ['nomina', 'seguros_sociales'];

export interface FicheroArchivo {
  buffer: Buffer;
  nombre: string;
  mime: string;
}

export interface Periodo {
  anio: number;
  mes: number;
  trimestre: number;
}

export interface ResumenTipo {
  n: number;
  total: number;
}

export interface TrimestreArbol {
  trimestre: number;
  ventas: ResumenTipo;
  gastos: ResumenTipo;
}

export interface AnioArbol {
  anio: number;
  ventas: ResumenTipo;
  gastos: ResumenTipo;
  trimestres: TrimestreArbol[];
}

export interface ElementoTrimestre {
  /** Id de la factura (IncomeInvoice o ExpenseInvoice); null si es una subida suelta. */
  facturaId: string | null;
  numero: string | null;
  fecha: string;
  tercero: string | null;
  nif: string | null;
  base: number;
  iva: number;
  total: number;
  documentoId: string | null;
  /** Nombre del fichero archivado (para descargarlo con su extensión). */
  archivoNombre: string | null;
  /** Hay una copia guardada en el almacenamiento. */
  tieneArchivo: boolean;
  /** Se puede descargar (las ventas se generan al vuelo aunque no haya copia). */
  descargable: boolean;
  /** 'emitida' | 'digitalizada' | 'registrada' | 'manual' ... */
  origen: string | null;
  /**
   * Moneda de la factura. base, iva y total van SIEMPRE en la moneda de
   * cuenta; si la factura se emitio en otra, `totalDivisa` es su total en esa
   * moneda y `tipoCambio`, el aplicado (unidades por 1 de la moneda de cuenta).
   */
  moneda?: string;
  totalDivisa?: number | null;
  tipoCambio?: number | null;
}

export interface ListadoTrimestre {
  anio: number;
  trimestre: number;
  ventas: ElementoTrimestre[];
  gastos: ElementoTrimestre[];
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const TIPO_DOC: Record<CarpetaArchivo, 'ingreso' | 'gasto'> = { ventas: 'ingreso', gastos: 'gasto' };

const EXTENSIONES: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/tiff': 'tif',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/plain': 'txt',
};

const num = (v: unknown): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/** Año, mes y trimestre de una fecha 'YYYY-MM-DD' (sin pasar por Date: nada de husos horarios). */
export function periodoDeFecha(fecha: string): Periodo {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(fecha ?? '').trim());
  if (!m) throw badRequest(`Fecha inválida: "${fecha}". Usa el formato AAAA-MM-DD.`);
  const anio = parseInt(m[1], 10);
  const mes = parseInt(m[2], 10);
  if (mes < 1 || mes > 12) throw badRequest(`Mes inválido en la fecha "${fecha}".`);
  return { anio, mes, trimestre: Math.ceil(mes / 3) };
}

/** Primer y último día del trimestre como 'YYYY-MM-DD' (para comparar como texto). */
export function rangoTrimestre(anio: number, trimestre: number): { desde: string; hasta: string } {
  const mesIni = (trimestre - 1) * 3 + 1;
  const mm = (n: number) => String(n).padStart(2, '0');
  return { desde: `${anio}-${mm(mesIni)}-01`, hasta: `${anio}-${mm(mesIni + 2)}-31` };
}

export function validarPeriodo(anio: unknown, trimestre?: unknown): { anio: number; trimestre: number } {
  const a = parseInt(String(anio ?? ''), 10);
  if (!Number.isInteger(a) || a < 2000 || a > 2099) throw badRequest('Año inválido.');
  const t = parseInt(String(trimestre ?? ''), 10);
  if (trimestre !== undefined && (!Number.isInteger(t) || t < 1 || t > 4)) throw badRequest('El trimestre debe ser 1, 2, 3 o 4.');
  return { anio: a, trimestre: t };
}

/** Quita tildes y deja el texto listo para nombreSeguro (que solo admite ASCII). */
function sinTildes(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function extensionDe(nombre: string | undefined, mime: string | undefined): string {
  const porNombre = /\.([A-Za-z0-9]{1,5})$/.exec(nombre ?? '')?.[1]?.toLowerCase();
  return porNombre || EXTENSIONES[mime ?? ''] || 'bin';
}

/** Nombre del fichero dentro de su carpeta: <fecha>_<numero o id>_<tercero>.<ext> */
export function nombreArchivoFactura(fecha: string, numeroOId: string, tercero: string | null | undefined, ext: string): string {
  // Las barras se cambian por guiones ANTES de limpiar: un número como
  // "F/2026/001" no debe partir el nombre (nombreSeguro se quedaría con "001").
  const base = sinTildes([fecha, numeroOId, tercero || 'sin-tercero'].join('_'))
    .replace(/[\\/]+/g, '-')
    .replace(/\s+/g, '-');
  return `${nombreSeguro(base).slice(0, 110)}.${nombreSeguro(ext).toLowerCase()}`;
}

/** Ruta completa en el almacenamiento: archivo/<empresa>/<anio>/<T>T/<carpeta>/<nombre> */
export function rutaArchivoFactura(companyId: string, periodo: Periodo, carpeta: CarpetaArchivo, nombre: string): string {
  return `archivo/${nombreSeguro(companyId)}/${periodo.anio}/${periodo.trimestre}T/${carpeta}/${nombre}`;
}

/** Guarda en el almacenamiento; si no se puede (p. ej. Vercel sin Blob), avisa y devuelve ''. */
async function guardarSinRomper(ruta: string, buffer: Buffer, mime: string): Promise<string> {
  try {
    return await putObject(ruta, buffer, mime);
  } catch (err) {
    logger.warn(`[archivo] No se pudo guardar ${ruta}: ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
}

/** Lee un original ya guardado en el almacenamiento (lector de facturas, extractor IA...). */
export async function ficheroDesdeAlmacen(ref: string | null | undefined, nombre: string, mime: string): Promise<FicheroArchivo | undefined> {
  if (!ref) return undefined;
  try {
    return { buffer: await getObject(ref), nombre, mime };
  } catch (err) {
    logger.warn(`[archivo] No se pudo leer el original ${ref}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Archivado de una factura
// ---------------------------------------------------------------------------

/**
 * Archiva una factura de venta EMITIDA (estadoDocumento FINAL). Si nació de un
 * documento subido (lector/extractor), se guarda ese original; si no, el PDF de
 * la factura. Idempotente: si ya hay un documento activo con copia, no duplica.
 * Devuelve el id del DocumentoArchivo, o null si no procede (borrador...).
 */
export async function archivarFacturaVenta(companyId: string, incomeInvoiceId: string, fichero?: FicheroArchivo): Promise<string | null> {
  const factura = await prisma.incomeInvoice.findFirst({
    where: { id: incomeInvoiceId, companyId },
    include: { customer: true, readerDocument: true },
  });
  if (!factura) throw notFound('Factura de venta no encontrada.');
  if (factura.estadoDocumento !== 'FINAL') return null;

  const existente = await prisma.documentoArchivo.findFirst({
    where: { companyId, incomeInvoiceId, estado: 'activo' },
  });
  if (existente && (existente.archivoPath || !fichero)) return existente.id;

  // Original subido: el que nos pasan o el que guardó el lector de facturas.
  let original = fichero;
  let origen = 'emitida';
  if (!original && factura.readerDocument?.storagePath) {
    original = await ficheroDesdeAlmacen(
      factura.readerDocument.storagePath,
      factura.readerDocument.originalFileName,
      factura.readerDocument.mimeType,
    );
  }
  if (original || factura.readerDocument) origen = 'digitalizada';

  let contenido: Buffer | null = original?.buffer ?? null;
  let mime = original?.mime ?? 'application/pdf';
  let nombreOriginal = original?.nombre;
  if (!contenido) {
    try {
      const pdf = await generarPdfFactura(companyId, incomeInvoiceId);
      contenido = pdf.contenido;
      mime = 'application/pdf';
      nombreOriginal = pdf.nombre;
    } catch (err) {
      logger.warn(`[archivo] No se pudo generar el PDF de la factura ${incomeInvoiceId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const periodo = periodoDeFecha(factura.fechaEmision);
  const numero = factura.numeroCompleto ?? factura.id;
  const nombre = nombreArchivoFactura(factura.fechaEmision, numero, factura.customer?.nombreFiscal, extensionDe(original ? nombreOriginal : undefined, mime));
  // base, iva y total en moneda de cuenta; en divisa, ademas el total del documento y el tipo.
  const { monedaCuenta } = await perfilEmpresa(companyId);
  const enDivisa = factura.moneda !== monedaCuenta;
  const divisa = {
    moneda: factura.moneda,
    totalDivisa: enDivisa ? num(factura.totalFacturaDoc) : null, // moneda-doc: dato secundario del archivo, no se suma
    tipoCambio: enDivisa ? factura.tipoCambio : null,
  };
  const archivoPath = contenido ? await guardarSinRomper(rutaArchivoFactura(companyId, periodo, 'ventas', nombre), contenido, mime) : '';

  const datos = {
    archivoNombre: nombre,
    archivoTipo: mime,
    archivoTamanio: archivoPath && contenido ? contenido.length : 0,
    archivoPath,
    archivoHash: archivoPath && contenido ? sha256(contenido) : '',
  };

  if (existente) {
    // Había registro sin copia y ahora llega el fichero: se completa.
    await prisma.documentoArchivo.update({ where: { id: existente.id }, data: { ...datos, origen } });
    return existente.id;
  }

  const doc = await prisma.documentoArchivo.create({
    data: {
      companyId,
      tipo: 'ingreso',
      numeroFactura: factura.numeroCompleto,
      emisor: null,
      receptor: factura.customer?.nombreFiscal ?? null,
      nifCif: factura.customer?.nifCif ?? null,
      fecha: factura.fechaEmision,
      ...periodo,
      base: num(factura.baseTotal),
      iva: num(factura.ivaTotal),
      retencion: num(factura.retencionTotal),
      total: num(factura.totalFactura),
      ...divisa,
      ...datos,
      incomeInvoiceId,
      readerDocumentId: factura.readerDocument?.id ?? null,
      origen,
    },
  });
  return doc.id;
}

/**
 * Archiva una factura de gasto. Guarda el original si se pasa; si no, deja el
 * registro en su trimestre (sin copia) para poder adjuntarlo más tarde.
 * Idempotente: no duplica; si había registro sin copia y llega el fichero, lo completa.
 */
export async function archivarFacturaGasto(companyId: string, expenseInvoiceId: string, fichero?: FicheroArchivo): Promise<string> {
  const factura = await prisma.expenseInvoice.findFirst({
    where: { id: expenseInvoiceId, companyId },
    include: { supplier: true },
  });
  if (!factura) throw notFound('Factura de gasto no encontrada.');

  const existente = await prisma.documentoArchivo.findFirst({
    where: { companyId, expenseInvoiceId, estado: 'activo' },
  });
  if (existente && (existente.archivoPath || !fichero)) return existente.id;

  const periodo = periodoDeFecha(factura.fechaEmision);
  const nombre = nombreArchivoFactura(
    factura.fechaEmision,
    factura.numeroCompleto || factura.id,
    factura.supplier?.nombreFiscal,
    fichero ? extensionDe(fichero.nombre, fichero.mime) : 'pdf',
  );
  const archivoPath = fichero ? await guardarSinRomper(rutaArchivoFactura(companyId, periodo, 'gastos', nombre), fichero.buffer, fichero.mime) : '';

  const datos = {
    archivoNombre: fichero ? nombre : '',
    archivoTipo: fichero?.mime ?? '',
    archivoTamanio: archivoPath && fichero ? fichero.buffer.length : 0,
    archivoPath,
    archivoHash: archivoPath && fichero ? sha256(fichero.buffer) : '',
  };

  if (existente) {
    await prisma.documentoArchivo.update({ where: { id: existente.id }, data: datos });
    return existente.id;
  }

  const doc = await prisma.documentoArchivo.create({
    data: {
      companyId,
      tipo: 'gasto',
      numeroFactura: factura.numeroCompleto,
      emisor: factura.supplier?.nombreFiscal ?? null,
      receptor: null,
      nifCif: factura.supplier?.nifCif ?? null,
      fecha: factura.fechaEmision,
      ...periodo,
      base: num(factura.baseTotal),
      iva: num(factura.ivaTotal),
      retencion: num(factura.retencionTotal),
      total: num(factura.totalFactura),
      ...datos,
      expenseInvoiceId,
      origen: fichero ? 'subida' : 'registrada',
    },
  });
  return doc.id;
}

/** Versión para los ganchos automáticos: nunca lanza. */
export async function archivarVentaSinRomper(companyId: string, incomeInvoiceId: string, fichero?: FicheroArchivo): Promise<void> {
  try {
    await archivarFacturaVenta(companyId, incomeInvoiceId, fichero);
  } catch (err) {
    logger.warn(`[archivo] No se pudo archivar la factura de venta ${incomeInvoiceId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Versión para los ganchos automáticos: nunca lanza. */
export async function archivarGastoSinRomper(companyId: string, expenseInvoiceId: string, fichero?: FicheroArchivo): Promise<void> {
  try {
    await archivarFacturaGasto(companyId, expenseInvoiceId, fichero);
  } catch (err) {
    logger.warn(`[archivo] No se pudo archivar la factura de gasto ${expenseInvoiceId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Archiva las facturas que aún no tienen documento (histórico). Procesa como
 * mucho `limite` facturas por llamada para no pasarse del tiempo de una función
 * serverless; devuelve cuántas quedan para volver a llamar.
 */
export async function regenerarArchivo(
  companyId: string,
  anio?: number,
  limite = 150,
): Promise<{ ventas: number; gastos: number; errores: number; pendientes: number }> {
  const filtroFecha = anio ? { fechaEmision: { gte: `${anio}-01-01`, lte: `${anio}-12-31` } } : {};

  const docs = await prisma.documentoArchivo.findMany({
    where: { companyId, estado: 'activo', OR: [{ incomeInvoiceId: { not: null } }, { expenseInvoiceId: { not: null } }] },
    select: { incomeInvoiceId: true, expenseInvoiceId: true },
  });
  const ventasHechas = new Set(docs.map((d) => d.incomeInvoiceId).filter(Boolean) as string[]);
  const gastosHechos = new Set(docs.map((d) => d.expenseInvoiceId).filter(Boolean) as string[]);

  const [ventas, gastos] = await Promise.all([
    prisma.incomeInvoice.findMany({
      where: { companyId, estadoDocumento: 'FINAL', ...filtroFecha },
      select: { id: true },
      orderBy: { fechaEmision: 'asc' },
    }),
    prisma.expenseInvoice.findMany({
      where: { companyId, estado: { not: 'DRAFT' }, ...filtroFecha },
      select: { id: true },
      orderBy: { fechaEmision: 'asc' },
    }),
  ]);
  const ventasPend = ventas.filter((v) => !ventasHechas.has(v.id));
  const gastosPend = gastos.filter((g) => !gastosHechos.has(g.id));

  const resultado = { ventas: 0, gastos: 0, errores: 0, pendientes: 0 };
  let presupuesto = limite;
  for (const v of ventasPend) {
    if (presupuesto-- <= 0) break;
    try {
      if (await archivarFacturaVenta(companyId, v.id)) resultado.ventas++;
    } catch (err) {
      resultado.errores++;
      logger.warn(`[archivo] Regenerar: venta ${v.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const g of gastosPend) {
    if (presupuesto-- <= 0) break;
    try {
      await archivarFacturaGasto(companyId, g.id);
      resultado.gastos++;
    } catch (err) {
      resultado.errores++;
      logger.warn(`[archivo] Regenerar: gasto ${g.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  resultado.pendientes = Math.max(0, ventasPend.length + gastosPend.length - resultado.ventas - resultado.gastos - resultado.errores);
  return resultado;
}

// ---------------------------------------------------------------------------
// Consultas: árbol, listado por trimestre y ZIP
// ---------------------------------------------------------------------------

const vacio = (): ResumenTipo => ({ n: 0, total: 0 });

/**
 * Años (de más reciente a más antiguo) con sus 4 trimestres: número de facturas
 * y total de ventas y de gastos. Sale de las facturas y de las subidas sueltas.
 */
export async function arbolArchivo(companyId: string): Promise<AnioArbol[]> {
  const [ventas, gastos, sueltos] = await Promise.all([
    prisma.incomeInvoice.findMany({
      where: { companyId, estadoDocumento: 'FINAL' },
      select: { fechaEmision: true, totalFactura: true },
    }),
    prisma.expenseInvoice.findMany({
      where: { companyId, estado: { not: 'DRAFT' } },
      select: { fechaEmision: true, totalFactura: true },
    }),
    prisma.documentoArchivo.findMany({
      where: { companyId, estado: 'activo', incomeInvoiceId: null, expenseInvoiceId: null, tipo: { notIn: TIPOS_DOCUMENTO_PRIVADOS } },
      select: { anio: true, trimestre: true, tipo: true, total: true },
    }),
  ]);

  const anios = new Map<number, AnioArbol>();
  const nodo = (anio: number): AnioArbol => {
    let a = anios.get(anio);
    if (!a) {
      a = { anio, ventas: vacio(), gastos: vacio(), trimestres: [1, 2, 3, 4].map((t) => ({ trimestre: t, ventas: vacio(), gastos: vacio() })) };
      anios.set(anio, a);
    }
    return a;
  };
  const sumar = (anio: number, trimestre: number, carpeta: CarpetaArchivo, total: unknown) => {
    if (trimestre < 1 || trimestre > 4) return;
    const a = nodo(anio);
    const t = a.trimestres[trimestre - 1];
    t[carpeta].n++;
    t[carpeta].total = num(t[carpeta].total + num(total));
    a[carpeta].n++;
    a[carpeta].total = num(a[carpeta].total + num(total));
  };

  for (const v of ventas) {
    try {
      const p = periodoDeFecha(v.fechaEmision);
      sumar(p.anio, p.trimestre, 'ventas', v.totalFactura);
    } catch {
      /* fecha ilegible: no se puede colocar */
    }
  }
  for (const g of gastos) {
    try {
      const p = periodoDeFecha(g.fechaEmision);
      sumar(p.anio, p.trimestre, 'gastos', g.totalFactura);
    } catch {
      /* fecha ilegible: no se puede colocar */
    }
  }
  for (const d of sueltos) sumar(d.anio, d.trimestre, d.tipo === 'ingreso' ? 'ventas' : 'gastos', d.total);

  // El año en curso aparece siempre, aunque esté vacío.
  nodo(new Date().getFullYear());
  return [...anios.values()].sort((a, b) => b.anio - a.anio);
}

/** Facturas de venta y de gasto de un trimestre, con su documento archivado si lo hay. */
export async function listarTrimestre(companyId: string, anio: number, trimestre: number): Promise<ListadoTrimestre> {
  validarPeriodo(anio, trimestre);
  const { desde, hasta } = rangoTrimestre(anio, trimestre);
  const enRango = { fechaEmision: { gte: desde, lte: hasta } };

  const { monedaCuenta } = await perfilEmpresa(companyId);
  const [ventas, gastos, docs] = await Promise.all([
    prisma.incomeInvoice.findMany({
      where: { companyId, estadoDocumento: 'FINAL', ...enRango },
      include: { customer: true },
      orderBy: [{ fechaEmision: 'asc' }, { numero: 'asc' }],
    }),
    prisma.expenseInvoice.findMany({
      where: { companyId, estado: { not: 'DRAFT' }, ...enRango },
      include: { supplier: true },
      orderBy: [{ fechaEmision: 'asc' }, { numero: 'asc' }],
    }),
    prisma.documentoArchivo.findMany({
      // Subidas sueltas (sin factura enlazada) de este trimestre.
      where: { companyId, estado: 'activo', anio, trimestre, incomeInvoiceId: null, expenseInvoiceId: null, tipo: { notIn: TIPOS_DOCUMENTO_PRIVADOS } },
      orderBy: { fecha: 'asc' },
    }),
  ]);

  // Documentos enlazados a facturas de este trimestre (aunque la copia se
  // archivara con otra fecha) se buscan por id de factura.
  const idsVentas = ventas.map((v) => v.id);
  const idsGastos = gastos.map((g) => g.id);
  const enlazados = await prisma.documentoArchivo.findMany({
    where: {
      companyId,
      estado: 'activo',
      OR: [{ incomeInvoiceId: { in: idsVentas } }, { expenseInvoiceId: { in: idsGastos } }],
    },
  });
  const docVenta = new Map(enlazados.filter((d) => d.incomeInvoiceId).map((d) => [d.incomeInvoiceId as string, d]));
  const docGasto = new Map(enlazados.filter((d) => d.expenseInvoiceId).map((d) => [d.expenseInvoiceId as string, d]));

  const lVentas: ElementoTrimestre[] = ventas.map((v) => {
    const d = docVenta.get(v.id);
    return {
      facturaId: v.id,
      numero: v.numeroCompleto,
      fecha: v.fechaEmision,
      tercero: v.customer?.nombreFiscal ?? null,
      nif: v.customer?.nifCif ?? null,
      base: num(v.baseTotal),
      iva: num(v.ivaTotal),
      total: num(v.totalFactura),
      documentoId: d?.id ?? null,
      archivoNombre: d?.archivoNombre || null,
      tieneArchivo: !!d?.archivoPath,
      descargable: true,
      origen: d?.origen ?? 'emitida',
      moneda: v.moneda,
      totalDivisa: v.moneda !== monedaCuenta ? num(v.totalFacturaDoc) : null, // moneda-doc: dato secundario del listado, no se suma
      tipoCambio: v.moneda !== monedaCuenta ? v.tipoCambio : null,
    };
  });
  const lGastos: ElementoTrimestre[] = gastos.map((g) => {
    const d = docGasto.get(g.id);
    return {
      facturaId: g.id,
      numero: g.numeroCompleto,
      fecha: g.fechaEmision,
      tercero: g.supplier?.nombreFiscal ?? null,
      nif: g.supplier?.nifCif ?? null,
      base: num(g.baseTotal),
      iva: num(g.ivaTotal),
      total: num(g.totalFactura),
      documentoId: d?.id ?? null,
      archivoNombre: d?.archivoNombre || null,
      tieneArchivo: !!d?.archivoPath,
      descargable: !!d?.archivoPath,
      origen: d?.origen ?? 'registrada',
      // Gastos en divisa: fuera de alcance; van en la moneda de cuenta.
      moneda: monedaCuenta,
      totalDivisa: null,
      tipoCambio: null,
    };
  });

  // Subidas manuales sin factura enlazada: se colocan por su propia fecha.
  for (const d of docs) {
    const el: ElementoTrimestre = {
      facturaId: null,
      numero: d.numeroFactura,
      fecha: d.fecha,
      tercero: (d.tipo === 'ingreso' ? d.receptor : d.emisor) ?? d.emisor ?? d.receptor ?? null,
      nif: d.nifCif,
      base: num(d.base),
      iva: num(d.iva),
      total: num(d.total),
      documentoId: d.id,
      archivoNombre: d.archivoNombre || null,
      tieneArchivo: !!d.archivoPath,
      descargable: !!d.archivoPath,
      origen: d.origen ?? 'manual',
      moneda: d.moneda,
      totalDivisa: d.totalDivisa === null ? null : num(d.totalDivisa),
      tipoCambio: d.tipoCambio === null ? null : Number(d.tipoCambio),
    };
    (d.tipo === 'ingreso' ? lVentas : lGastos).push(el);
  }

  const porFecha = (a: ElementoTrimestre, b: ElementoTrimestre) => a.fecha.localeCompare(b.fecha);
  lVentas.sort(porFecha);
  lGastos.sort(porFecha);
  return { anio, trimestre, ventas: lVentas, gastos: lGastos };
}

/**
 * PDF de una factura de venta para descargar: la copia archivada si existe; si
 * no (o no se puede leer), se genera al vuelo.
 */
export async function pdfFacturaVenta(companyId: string, incomeInvoiceId: string): Promise<{ nombre: string; contenido: Buffer; mime: string }> {
  const factura = await prisma.incomeInvoice.findFirst({ where: { id: incomeInvoiceId, companyId }, include: { customer: true } });
  if (!factura) throw notFound('Factura de venta no encontrada.');
  if (factura.estadoDocumento !== 'FINAL') throw badRequest('La factura está en borrador: no forma parte del archivo.');

  const doc = await prisma.documentoArchivo.findFirst({ where: { companyId, incomeInvoiceId, estado: 'activo' } });
  if (doc?.archivoPath) {
    try {
      return { nombre: doc.archivoNombre, contenido: await getObject(doc.archivoPath), mime: doc.archivoTipo || 'application/pdf' };
    } catch (err) {
      logger.warn(`[archivo] Copia de ${incomeInvoiceId} ilegible; se genera al vuelo: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const pdf = await generarPdfFactura(companyId, incomeInvoiceId);
  return {
    nombre: nombreArchivoFactura(factura.fechaEmision, factura.numeroCompleto ?? factura.id, factura.customer?.nombreFiscal, 'pdf'),
    contenido: pdf.contenido,
    mime: 'application/pdf',
  };
}

/** Importe con coma decimal (Excel en español). */
const importeCsv = (n: number): string => n.toFixed(2).replace('.', ',');

function campoCsv(v: string | null | undefined): string {
  const s = String(v ?? '');
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * resumen.csv: separador ';', coma decimal y BOM UTF-8 para que Excel lo abra
 * bien. Base, IVA y Total en la moneda de cuenta. Si alguna factura del
 * trimestre va en otra moneda, se anaden AL FINAL 'Moneda', 'Total divisa' y
 * 'Tipo de cambio' (las 9 columnas de siempre no cambian).
 */
export function resumenCsv(filas: Array<ElementoTrimestre & { tipo: 'Venta' | 'Gasto'; archivo: string }>): Buffer {
  const conDivisa = filas.some((f) => f.totalDivisa !== null && f.totalDivisa !== undefined);
  const cabecera = ['Tipo', 'Fecha', 'Número', 'Tercero', 'NIF', 'Base', 'IVA', 'Total', 'Archivo'];
  if (conDivisa) cabecera.push('Moneda', 'Total divisa', 'Tipo de cambio');
  const lineas = [cabecera.join(';')];
  for (const f of filas) {
    const celdas = [f.tipo, f.fecha, f.numero, f.tercero, f.nif, importeCsv(f.base), importeCsv(f.iva), importeCsv(f.total), f.archivo];
    if (conDivisa) {
      const enDivisa = f.totalDivisa !== null && f.totalDivisa !== undefined;
      celdas.push(
        f.moneda ?? '',
        enDivisa ? importeCsv(f.totalDivisa as number) : '',
        enDivisa && f.tipoCambio ? String(f.tipoCambio).replace('.', ',') : '',
      );
    }
    lineas.push(celdas.map((c) => campoCsv(c)).join(';'));
  }
  return Buffer.from('﻿' + lineas.join('\r\n') + '\r\n', 'utf8');
}

/** ZIP de un trimestre: ventas/*.pdf, gastos/* y resumen.csv. */
export async function zipTrimestre(companyId: string, anio: number, trimestre: number): Promise<{ nombre: string; contenido: Buffer }> {
  const listado = await listarTrimestre(companyId, anio, trimestre);
  const entradas: ZipEntry[] = [];
  const usados = new Set<string>();
  const filas: Array<ElementoTrimestre & { tipo: 'Venta' | 'Gasto'; archivo: string }> = [];

  const nombreUnico = (carpeta: string, nombre: string): string => {
    let ruta = `${carpeta}/${nombre}`;
    let i = 2;
    while (usados.has(ruta)) {
      ruta = `${carpeta}/${nombre.replace(/(\.[^.]*)?$/, (ext) => `_${i}${ext}`)}`;
      i++;
    }
    usados.add(ruta);
    return ruta;
  };

  const docsIds = [...listado.ventas, ...listado.gastos].map((e) => e.documentoId).filter(Boolean) as string[];
  const docs = new Map(
    (await prisma.documentoArchivo.findMany({ where: { id: { in: docsIds }, companyId } })).map((d) => [d.id, d]),
  );

  const leerCopia = async (documentoId: string | null): Promise<{ buffer: Buffer; nombre: string } | null> => {
    const d = documentoId ? docs.get(documentoId) : undefined;
    if (!d?.archivoPath) return null;
    try {
      return { buffer: await getObject(d.archivoPath), nombre: d.archivoNombre || `${d.id}.${extensionDe(undefined, d.archivoTipo)}` };
    } catch (err) {
      logger.warn(`[archivo] ZIP: no se pudo leer ${d.archivoPath}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  for (const v of listado.ventas) {
    let fichero = await leerCopia(v.documentoId);
    if (!fichero && v.facturaId) {
      try {
        const pdf = await generarPdfFactura(companyId, v.facturaId);
        fichero = { buffer: pdf.contenido, nombre: nombreArchivoFactura(v.fecha, v.numero ?? v.facturaId, v.tercero, 'pdf') };
      } catch (err) {
        logger.warn(`[archivo] ZIP: no se pudo generar el PDF de ${v.facturaId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    let archivo = 'no disponible';
    if (fichero) {
      archivo = nombreUnico('ventas', nombreSeguro(fichero.nombre));
      entradas.push({ name: archivo, data: fichero.buffer });
    }
    filas.push({ ...v, tipo: 'Venta', archivo });
  }

  for (const g of listado.gastos) {
    const fichero = await leerCopia(g.documentoId);
    let archivo = 'sin original';
    if (fichero) {
      archivo = nombreUnico('gastos', nombreSeguro(fichero.nombre));
      entradas.push({ name: archivo, data: fichero.buffer });
    }
    filas.push({ ...g, tipo: 'Gasto', archivo });
  }

  entradas.push({ name: 'resumen.csv', data: resumenCsv(filas) });
  return { nombre: `facturas_${anio}_${trimestre}T.zip`, contenido: crearZip(entradas, { comprimir: true, fecha: new Date() }) };
}
