import { prisma } from '../config/database';
import { badRequest, notFound } from '../utils/http-errors';
import { putObject, getObject } from '../utils/storage';
import { nombreSeguro } from '../utils/nombre-seguro';
import { createHash } from 'crypto';
import {
  periodoDeFecha,
  nombreArchivoFactura,
  rutaArchivoFactura,
  extensionDe,
  pdfFacturaVenta,
  TIPOS_DOCUMENTO_PRIVADOS,
} from './archivoFacturas.service';

/** Filtro de tipo del archivo de facturas: nunca los documentos de nominas (solo con nominas:read). */
function filtroTipo(tipo?: string): string | { notIn: string[] } {
  if (tipo && TIPOS_DOCUMENTO_PRIVADOS.includes(tipo)) throw badRequest('Tipo de documento no válido: los de nóminas están en Nóminas.');
  return tipo ? tipo : { notIn: TIPOS_DOCUMENTO_PRIVADOS };
}

export interface DocumentoArchivoDTO {
  id: string;
  companyId: string;
  tipo: 'ingreso' | 'gasto';
  numeroFactura?: string;
  emisor?: string;
  receptor?: string;
  nifCif?: string;
  fecha: string;
  mes: number;
  trimestre: number;
  anio: number;
  base?: number;
  iva?: number;
  retencion?: number;
  total?: number;
  archivoNombre: string;
  archivoTipo: string;
  archivoTamanio: number;
  archivoPath: string;
  archivoHash: string;
  readerDocumentId?: string;
  incomeInvoiceId?: string;
  expenseInvoiceId?: string;
  origen?: string;
  estado: 'activo' | 'reemplazado' | 'anulado';
  confianza?: number;
  observaciones?: string;
  uploadedBy?: string;
  uploadedAt: Date;
  updatedAt: Date;
}

export interface CrearDocumentoArchivoInput {
  tipo: 'ingreso' | 'gasto';
  numeroFactura?: string;
  emisor?: string;
  receptor?: string;
  nifCif?: string;
  fecha: string;
  base?: number;
  iva?: number;
  retencion?: number;
  total?: number;
  archivoNombre: string;
  archivoTipo: string;
  archivoBuffer: Buffer;
  readerDocumentId?: string;
  incomeInvoiceId?: string;
  /** Factura de gasto a la que se adjunta el original (opcional). */
  expenseInvoiceId?: string;
  origen?: string;
  confianza?: number;
  observaciones?: string;
  uploadedBy?: string;
}

/**
 * Calcula hash SHA-256 del buffer
 */
function calcularHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Crea un nuevo registro de documento en el archivo (subida manual).
 * Se coloca en la carpeta de su año y trimestre según la fecha:
 *   archivo/<empresa>/<anio>/<T>T/<ventas|gastos>/<fecha>_<numero>_<tercero>.<ext>
 * Si se indica la factura (incomeInvoiceId / expenseInvoiceId), el fichero se
 * adjunta a ella y sustituye al documento activo que tuviera.
 */
export async function crearDocumentoArchivo(
  companyId: string,
  input: CrearDocumentoArchivoInput,
): Promise<DocumentoArchivoDTO> {
  // La fecha se lee como texto AAAA-MM-DD: con new Date() el huso horario
  // podía mover una factura del 1 de enero al año anterior.
  const { anio, mes, trimestre } = periodoDeFecha(input.fecha);
  const fecha = input.fecha.slice(0, 10);

  // Enlace opcional con una factura de la empresa.
  let incomeInvoiceId: string | undefined;
  let expenseInvoiceId: string | undefined;
  if (input.tipo === 'ingreso' && input.incomeInvoiceId) {
    const f = await prisma.incomeInvoice.findFirst({ where: { id: input.incomeInvoiceId, companyId }, select: { id: true } });
    if (!f) throw notFound('La factura de venta indicada no existe.');
    incomeInvoiceId = f.id;
  }
  if (input.tipo === 'gasto' && input.expenseInvoiceId) {
    const f = await prisma.expenseInvoice.findFirst({ where: { id: input.expenseInvoiceId, companyId }, select: { id: true } });
    if (!f) throw notFound('La factura de gasto indicada no existe.');
    expenseInvoiceId = f.id;
  }

  // Calcular hash del archivo
  const hash = calcularHash(input.archivoBuffer);

  // Carpeta del trimestre. El nombre se limpia (nombreSeguro) para que no pueda
  // salir de la carpeta; la clave usa '/', no path.join (en Windows pondría '').
  const carpeta = input.tipo === 'ingreso' ? 'ventas' : 'gastos';
  const tercero = input.tipo === 'ingreso' ? input.receptor : input.emisor;
  const nombreArchivo = nombreArchivoFactura(
    fecha,
    input.numeroFactura || `subida-${Date.now()}`,
    tercero || input.emisor || input.receptor,
    extensionDe(input.archivoNombre, input.archivoTipo),
  );
  const rutaCompleta = rutaArchivoFactura(companyId, { anio, mes, trimestre }, carpeta, nombreArchivo);

  // Guardar archivo en storage (local o Vercel Blob)
  const archivoPath = await putObject(rutaCompleta, input.archivoBuffer, input.archivoTipo);

  // El documento anterior de esa factura queda como reemplazado.
  if (incomeInvoiceId || expenseInvoiceId) {
    await prisma.documentoArchivo.updateMany({
      where: { companyId, estado: 'activo', ...(incomeInvoiceId ? { incomeInvoiceId } : { expenseInvoiceId }) },
      data: { estado: 'reemplazado' },
    });
  }

  // Crear registro en BD
  const documento = await prisma.documentoArchivo.create({
    data: {
      companyId,
      tipo: input.tipo,
      numeroFactura: input.numeroFactura,
      emisor: input.emisor,
      receptor: input.receptor,
      nifCif: input.nifCif,
      fecha,
      mes,
      trimestre,
      anio,
      base: input.base ? parseFloat(input.base.toString()) : undefined,
      iva: input.iva ? parseFloat(input.iva.toString()) : undefined,
      retencion: input.retencion ? parseFloat(input.retencion.toString()) : undefined,
      total: input.total ? parseFloat(input.total.toString()) : undefined,
      archivoNombre: input.archivoNombre,
      archivoTipo: input.archivoTipo,
      archivoTamanio: input.archivoBuffer.length,
      archivoPath,
      archivoHash: hash,
      readerDocumentId: input.readerDocumentId,
      incomeInvoiceId,
      expenseInvoiceId,
      origen: input.origen || 'manual',
      confianza: input.confianza,
      observaciones: input.observaciones,
      uploadedBy: input.uploadedBy,
    },
  });

  return mapearDocumento(documento);
}

/**
 * Lista documentos de un período específico (mes, trimestre, anio)
 */
export async function listarDocumentosPorPeriodo(
  companyId: string,
  opciones: {
    anio: number;
    mes?: number;
    trimestre?: number;
    tipo?: 'ingreso' | 'gasto';
    estado?: string;
    limite?: number;
    pagina?: number;
  },
): Promise<{ documentos: DocumentoArchivoDTO[]; total: number }> {
  const { anio, mes, trimestre, tipo, estado, limite = 50, pagina = 1 } = opciones;

  if (!anio || anio < 2000 || anio > 2099) {
    throw badRequest('Año inválido');
  }

  const where: any = { companyId, anio };

  if (mes) {
    if (mes < 1 || mes > 12) throw badRequest('Mes debe estar entre 1 y 12');
    where.mes = mes;
  }

  if (trimestre) {
    if (trimestre < 1 || trimestre > 4) throw badRequest('Trimestre debe estar entre 1 y 4');
    where.trimestre = trimestre;
  }

  where.tipo = filtroTipo(tipo);

  if (estado) {
    where.estado = estado;
  }

  const skip = (pagina - 1) * limite;

  const [documentos, total] = await Promise.all([
    prisma.documentoArchivo.findMany({
      where,
      orderBy: { fecha: 'desc' },
      take: limite,
      skip,
    }),
    prisma.documentoArchivo.count({ where }),
  ]);

  return {
    documentos: documentos.map(mapearDocumento),
    total,
  };
}

/**
 * Obtiene un documento específico por ID
 */
export async function obtenerDocumento(
  companyId: string,
  documentoId: string,
): Promise<DocumentoArchivoDTO> {
  const documento = await prisma.documentoArchivo.findUnique({
    where: { id: documentoId },
  });

  // Los PDF de nominas y seguros sociales solo se ven por /nominas (nominas:read).
  if (!documento || documento.companyId !== companyId || TIPOS_DOCUMENTO_PRIVADOS.includes(documento.tipo)) {
    throw notFound('Documento no encontrado');
  }

  return mapearDocumento(documento);
}

/**
 * Descarga un archivo desde el storage
 */
export async function descargarArchivo(
  companyId: string,
  documentoId: string,
): Promise<{ buffer: Buffer; nombre: string; tipo: string }> {
  const documento = await obtenerDocumento(companyId, documentoId);

  // Copia guardada: se sirve tal cual.
  if (documento.archivoPath) {
    try {
      const buffer = await getObject(documento.archivoPath);
      return { buffer, nombre: documento.archivoNombre, tipo: documento.archivoTipo };
    } catch (err) {
      if (!documento.incomeInvoiceId) throw err;
    }
  }
  // Ventas sin copia (o ilegible): el PDF se genera al vuelo.
  if (documento.incomeInvoiceId) {
    const pdf = await pdfFacturaVenta(companyId, documento.incomeInvoiceId);
    return { buffer: pdf.contenido, nombre: pdf.nombre, tipo: pdf.mime };
  }
  throw notFound('Este documento no tiene el fichero original guardado.');
}

/**
 * Actualiza el estado de un documento (p.ej., marcar como reemplazado)
 */
export async function actualizarEstadoDocumento(
  companyId: string,
  documentoId: string,
  nuevoEstado: 'activo' | 'reemplazado' | 'anulado',
  observaciones?: string,
): Promise<DocumentoArchivoDTO> {
  const documento = await obtenerDocumento(companyId, documentoId);

  const actualizado = await prisma.documentoArchivo.update({
    where: { id: documentoId },
    data: {
      estado: nuevoEstado,
      observaciones: observaciones || documento.observaciones,
      updatedAt: new Date(),
    },
  });

  return mapearDocumento(actualizado);
}

/**
 * Elimina/marca como anulado un documento
 */
export async function eliminarDocumento(
  companyId: string,
  documentoId: string,
): Promise<void> {
  const documento = await obtenerDocumento(companyId, documentoId);

  // Marca como anulado en lugar de borrar
  await prisma.documentoArchivo.update({
    where: { id: documentoId },
    data: {
      estado: 'anulado',
      updatedAt: new Date(),
    },
  });
}

/**
 * Obtiene estadísticas de un período
 */
export async function obtenerEstadisticasPeriodo(
  companyId: string,
  anio: number,
  mes?: number,
  trimestre?: number,
): Promise<{
  totalDocumentos: number;
  totalIngresos: number;
  totalGastos: number;
  totalIVA: number;
  totalRetencion: number;
  desglosePorTipo: { ingreso: number; gasto: number };
}> {
  const where: any = { companyId, anio, estado: 'activo', tipo: filtroTipo() };

  if (mes) {
    where.mes = mes;
  } else if (trimestre) {
    where.trimestre = trimestre;
  }

  const documentos = await prisma.documentoArchivo.findMany({
    where,
  });

  const totalIngresos = documentos
    .filter((d) => d.tipo === 'ingreso')
    .reduce((sum: number, d: any) => sum + (d.total?.toNumber() || 0), 0);

  const totalGastos = documentos
    .filter((d) => d.tipo === 'gasto')
    .reduce((sum: number, d: any) => sum + (d.total?.toNumber() || 0), 0);

  const totalIVA = documentos.reduce((sum: number, d: any) => sum + (d.iva?.toNumber() || 0), 0);

  const totalRetencion = documentos.reduce((sum: number, d: any) => sum + (d.retencion?.toNumber() || 0), 0);

  return {
    totalDocumentos: documentos.length,
    totalIngresos,
    totalGastos,
    totalIVA,
    totalRetencion,
    desglosePorTipo: {
      ingreso: documentos.filter((d) => d.tipo === 'ingreso').length,
      gasto: documentos.filter((d) => d.tipo === 'gasto').length,
    },
  };
}

/**
 * Busca documentos por número de factura o emisor
 */
export async function buscarDocumentos(
  companyId: string,
  termino: string,
  tipo?: 'ingreso' | 'gasto',
  limite: number = 20,
): Promise<DocumentoArchivoDTO[]> {
  const where: any = {
    companyId,
    estado: 'activo',
    OR: [
      { numeroFactura: { contains: termino, mode: 'insensitive' } },
      { emisor: { contains: termino, mode: 'insensitive' } },
      { receptor: { contains: termino, mode: 'insensitive' } },
    ],
  };

  where.tipo = filtroTipo(tipo);

  const documentos = await prisma.documentoArchivo.findMany({
    where,
    orderBy: { fecha: 'desc' },
    take: limite,
  });

  return documentos.map(mapearDocumento);
}

/**
 * Mapea un registro de BD a DTO
 */
function mapearDocumento(doc: any): DocumentoArchivoDTO {
  return {
    id: doc.id,
    companyId: doc.companyId,
    tipo: doc.tipo,
    numeroFactura: doc.numeroFactura,
    emisor: doc.emisor,
    receptor: doc.receptor,
    nifCif: doc.nifCif,
    fecha: doc.fecha,
    mes: doc.mes,
    trimestre: doc.trimestre,
    anio: doc.anio,
    base: doc.base ? parseFloat(doc.base.toString()) : undefined,
    iva: doc.iva ? parseFloat(doc.iva.toString()) : undefined,
    retencion: doc.retencion ? parseFloat(doc.retencion.toString()) : undefined,
    total: doc.total ? parseFloat(doc.total.toString()) : undefined,
    archivoNombre: doc.archivoNombre,
    archivoTipo: doc.archivoTipo,
    archivoTamanio: doc.archivoTamanio,
    archivoPath: doc.archivoPath,
    archivoHash: doc.archivoHash,
    readerDocumentId: doc.readerDocumentId,
    incomeInvoiceId: doc.incomeInvoiceId,
    expenseInvoiceId: doc.expenseInvoiceId,
    origen: doc.origen,
    estado: doc.estado,
    confianza: doc.confianza,
    observaciones: doc.observaciones,
    uploadedBy: doc.uploadedBy,
    uploadedAt: doc.uploadedAt,
    updatedAt: doc.updatedAt,
  };
}
