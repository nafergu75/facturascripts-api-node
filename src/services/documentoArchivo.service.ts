import { prisma } from '../config/database';
import { badRequest, notFound } from '../utils/http-errors';
import { putObject, getObject } from '../utils/storage';
import { createHash } from 'crypto';
import * as path from 'path';

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
  origen?: string;
  confianza?: number;
  observaciones?: string;
  uploadedBy?: string;
}

/**
 * Calcula el trimestre basado en el mes (1-12 -> trimestre 1-4)
 */
function calcularTrimestre(mes: number): number {
  if (mes < 1 || mes > 12) throw badRequest('Mes debe estar entre 1 y 12');
  return Math.ceil(mes / 3);
}

/**
 * Calcula hash SHA-256 del buffer
 */
function calcularHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Construye la ruta de almacenamiento: archivos/{companyId}/{anio}/{mes}/
 */
function construirArchivosPath(companyId: string, anio: number, mes: number): string {
  return `archivos/${companyId}/${anio}/${String(mes).padStart(2, '0')}`;
}

/**
 * Crea un nuevo registro de documento en el archivo
 */
export async function crearDocumentoArchivo(
  companyId: string,
  input: CrearDocumentoArchivoInput,
): Promise<DocumentoArchivoDTO> {
  // Validar fechas
  const fechaDate = new Date(input.fecha);
  if (isNaN(fechaDate.getTime())) {
    throw badRequest('Fecha inválida');
  }

  const anio = fechaDate.getFullYear();
  const mes = fechaDate.getMonth() + 1;
  const trimestre = calcularTrimestre(mes);

  // Calcular hash del archivo
  const hash = calcularHash(input.archivoBuffer);

  // Construir ruta de almacenamiento
  const archivosPath = construirArchivosPath(companyId, anio, mes);
  const nombreArchivo = `${Date.now()}-${input.archivoNombre}`;
  const rutaCompleta = path.join(archivosPath, nombreArchivo);

  // Guardar archivo en storage (local o Vercel Blob)
  const archivoPath = await putObject(rutaCompleta, input.archivoBuffer, input.archivoTipo);

  // Crear registro en BD
  const documento = await prisma.documentoArchivo.create({
    data: {
      companyId,
      tipo: input.tipo,
      numeroFactura: input.numeroFactura,
      emisor: input.emisor,
      receptor: input.receptor,
      nifCif: input.nifCif,
      fecha: input.fecha,
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
      incomeInvoiceId: input.incomeInvoiceId,
      origen: input.origen,
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

  if (tipo) {
    where.tipo = tipo;
  }

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

  if (!documento || documento.companyId !== companyId) {
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

  const buffer = await getObject(documento.archivoPath);

  return {
    buffer,
    nombre: documento.archivoNombre,
    tipo: documento.archivoTipo,
  };
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
  const where: any = { companyId, anio, estado: 'activo' };

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

  if (tipo) {
    where.tipo = tipo;
  }

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
    origen: doc.origen,
    estado: doc.estado,
    confianza: doc.confianza,
    observaciones: doc.observaciones,
    uploadedBy: doc.uploadedBy,
    uploadedAt: doc.uploadedAt,
    updatedAt: doc.updatedAt,
  };
}
