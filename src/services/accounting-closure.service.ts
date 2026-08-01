import { badRequest, notFound } from '../utils/http-errors';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID as uuid } from 'crypto';
import { prisma } from '../config/database';

const STORAGE_DIR = path.join(process.cwd(), 'storage', 'accounting-closures');

async function ensureStorageDir(): Promise<void> {
  try {
    await fs.mkdir(STORAGE_DIR, { recursive: true });
  } catch (err) {
    console.error('Error creating storage dir:', err);
  }
}

/**
 * Crear un cierre de ejercicio contable.
 */
export async function crearCierrePeriodo(
  companyId: string,
  ejercicio: number,
): Promise<any> {
  // Validar que no existe cierre previo
  const existe = await prisma.accountingClosure.findFirst({
    where: { companyId, ejercicio },
  });

  if (existe) throw badRequest(`Ya existe cierre para el ejercicio ${ejercicio}.`);

  const cierre = await prisma.accountingClosure.create({
    data: {
      companyId,
      ejercicio,
      estado: 'ABIERTO',
    },
  });

  return cierre;
}

/**
 * Listar cierres contables de una empresa.
 */
export async function listarCierres(
  companyId: string,
  filtros?: { estado?: string; desde?: number; hasta?: number },
) {
  const where: any = { companyId };

  if (filtros?.estado) where.estado = filtros.estado;
  if (filtros?.desde || filtros?.hasta) {
    where.ejercicio = {};
    if (filtros.desde) where.ejercicio.gte = filtros.desde;
    if (filtros.hasta) where.ejercicio.lte = filtros.hasta;
  }

  const cierres = await prisma.accountingClosure.findMany({
    where,
    include: { archivos: true },
    orderBy: { ejercicio: 'desc' },
  });

  return cierres;
}

/**
 * Obtener cierre por ejercicio.
 */
export async function obtenerCierre(
  companyId: string,
  ejercicio: number,
): Promise<any> {
  const cierre = await prisma.accountingClosure.findFirst({
    where: { companyId, ejercicio },
    include: { archivos: true },
  });

  if (!cierre) throw notFound(`Cierre del ejercicio ${ejercicio} no encontrado.`);
  return cierre;
}

/**
 * Cambiar estado de un cierre.
 */
export async function cambiarEstadoCierre(
  companyId: string,
  ejercicio: number,
  nuevoEstado: string,
  datos?: any,
): Promise<any> {
  const cierre = await obtenerCierre(companyId, ejercicio);

  const actualizado = await prisma.accountingClosure.update({
    where: { id: cierre.id },
    data: {
      estado: nuevoEstado,
      cierreContable: datos?.cierreContable,
      balanceGeneral: datos?.balanceGeneral,
      cuentaResultados: datos?.cuentaResultados,
      observaciones: datos?.observaciones,
      fechaCierre: nuevoEstado === 'CERRADO' ? new Date() : null,
    },
  });

  return actualizado;
}

/**
 * Subir archivo de cierre (PDF, Excel, etc.).
 */
export async function subirArchivoCierre(
  companyId: string,
  ejercicio: number,
  archivo: { buffer: Buffer; originalname: string; mimetype: string },
  tipoContenido: string,
): Promise<any> {
  // Obtener o crear cierre
  let cierre = await prisma.accountingClosure.findFirst({
    where: { companyId, ejercicio },
  });

  if (!cierre) {
    cierre = await crearCierrePeriodo(companyId, ejercicio);
  }

  if (!cierre) throw badRequest('No se pudo crear cierre');

  // Determinar tipo de archivo
  const tipoArchivo = archivo.mimetype.includes('pdf')
    ? 'PDF'
    : archivo.mimetype.includes('spreadsheet') || archivo.originalname.endsWith('.xlsx')
      ? 'EXCEL'
      : 'TXT';

  // Guardar archivo
  await ensureStorageDir();
  const nombreGuardado = `${uuid()}-${Date.now()}-${archivo.originalname}`;
  const rutaCompleta = path.join(STORAGE_DIR, nombreGuardado);
  await fs.writeFile(rutaCompleta, archivo.buffer);

  // Crear registro de archivo
  const archivoRegistro = await prisma.accountingClosureFile.create({
    data: {
      closureId: cierre.id,
      companyId,
      nombre: archivo.originalname,
      tipoArchivo,
      mimeType: archivo.mimetype,
      fileSize: archivo.buffer.length,
      storagePath: `storage/accounting-closures/${nombreGuardado}`,
      ejercicio,
      tipoContenido,
    },
  });

  return archivoRegistro;
}

/**
 * Listar archivos de un cierre.
 */
export async function listarArchivosCierre(
  companyId: string,
  ejercicio: number,
): Promise<any> {
  const cierre = await obtenerCierre(companyId, ejercicio);

  const archivos = await prisma.accountingClosureFile.findMany({
    where: { closureId: cierre.id },
    orderBy: { uploadedAt: 'desc' },
  });

  return archivos;
}

/**
 * Crear o actualizar datos de ejercicio anterior.
 */
export async function guardarDatosEjercicioAnterior(
  companyId: string,
  ejercicio: number,
  datos: {
    estado?: string;
    baseImponible?: number;
    ivaDevengado?: number;
    ivaRepercutido?: number;
    irpfRetenido?: number;
    gasto?: number;
    ingresos?: number;
    beneficio?: number;
    datosJSON?: string;
    observaciones?: string;
  },
): Promise<any> {
  // Filtrar datos undefined para Prisma
  const datosLimpios = Object.fromEntries(
    Object.entries(datos).filter(([, v]) => v !== undefined),
  );

  // Buscar si existe
  let registro = await prisma.priorYearData.findFirst({
    where: { companyId, ejercicio },
  });

  if (registro) {
    // Actualizar
    registro = await prisma.priorYearData.update({
      where: { id: registro.id },
      data: datosLimpios as any,
    });
  } else {
    // Crear
    registro = await prisma.priorYearData.create({
      data: {
        companyId,
        ejercicio,
        ...datosLimpios,
      } as any,
    });
  }

  return registro;
}

/**
 * Obtener datos de ejercicio anterior.
 */
export async function obtenerDatosEjercicioAnterior(
  companyId: string,
  ejercicio: number,
): Promise<any> {
  const datos = await prisma.priorYearData.findFirst({
    where: { companyId, ejercicio },
  });

  if (!datos) throw notFound(`Datos del ejercicio ${ejercicio} no encontrados.`);
  return datos;
}

/**
 * Listar ejercicios anteriores (con datos).
 */
export async function listarEjerciciosAnteriores(
  companyId: string,
  filtros?: { desde?: number; hasta?: number },
): Promise<any> {
  const where: any = { companyId };

  if (filtros?.desde || filtros?.hasta) {
    where.ejercicio = {};
    if (filtros.desde) where.ejercicio.gte = filtros.desde;
    if (filtros.hasta) where.ejercicio.lte = filtros.hasta;
  }

  const ejercicios = await prisma.priorYearData.findMany({
    where,
    orderBy: { ejercicio: 'desc' },
  });

  return ejercicios;
}

/**
 * Obtener comparativa entre años (para análisis).
 */
export async function obtenerComparativa(
  companyId: string,
  ejercicio1: number,
  ejercicio2: number,
): Promise<any> {
  const datos1 = await obtenerDatosEjercicioAnterior(companyId, ejercicio1);
  const datos2 = await obtenerDatosEjercicioAnterior(companyId, ejercicio2);

  return {
    ejercicio1: datos1,
    ejercicio2: datos2,
    variaciones: {
      ivaDevengado: datos2.ivaDevengado - datos1.ivaDevengado,
      ivaRepercutido: datos2.ivaRepercutido - datos1.ivaRepercutido,
      irpfRetenido: datos2.irpfRetenido - datos1.irpfRetenido,
      gasto: datos2.gasto - datos1.gasto,
      ingresos: datos2.ingresos - datos1.ingresos,
      beneficio: datos2.beneficio - datos1.beneficio,
    },
  };
}

export const accountingClosureService = {
  crearCierrePeriodo,
  listarCierres,
  obtenerCierre,
  cambiarEstadoCierre,
  subirArchivoCierre,
  listarArchivosCierre,
  guardarDatosEjercicioAnterior,
  obtenerDatosEjercicioAnterior,
  listarEjerciciosAnteriores,
  obtenerComparativa,
};
