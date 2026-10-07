/**
 * PDF de las nominas en el archivo privado: los recibos que manda la gestoria
 * (uno por trabajador o el de todo el mes) y los de seguros sociales (RLC y
 * RNT). Se guardan con putObject (blob privado, nunca publico) y en
 * DocumentoArchivo con tipo 'nomina' o 'seguros_sociales', con su SHA-256 para
 * no subir dos veces el mismo PDF.
 *
 * Solo se listan y descargan por /nominas (nominas:read). El archivo general de
 * facturas (contabilidad:read: ventas, tesoreria, solo-lectura) no los muestra:
 * ver TIPOS_DOCUMENTO_PRIVADOS en documentoArchivo.service.ts.
 */
import { createHash } from 'crypto';
import { prisma } from '../../config/database';
import { badRequest, conflict, HttpError, notFound } from '../../utils/http-errors';
import { logger } from '../../config/logger';
import { getObject, putObject } from '../../utils/storage';
import { nombreSeguro } from '../../utils/nombre-seguro';
import { crearZip, type ZipEntry } from '../../utils/zip';
import { nombreCompleto } from '../empleados.service';
import { ultimoDiaMes } from './calculo';

/** Clases de documento que se suben a nominas y en que tipo de DocumentoArchivo quedan. */
export const CLASES_DOCUMENTO_NOMINAS = {
  nomina: { tipo: 'nomina', carpeta: 'nominas', etiqueta: 'Nómina' },
  rlc: { tipo: 'seguros_sociales', carpeta: 'seguros-sociales', etiqueta: 'RLC (recibo de liquidación de cotizaciones)' },
  rnt: { tipo: 'seguros_sociales', carpeta: 'seguros-sociales', etiqueta: 'RNT (relación nominal de trabajadores)' },
} as const;
export type ClaseDocumentoNominas = keyof typeof CLASES_DOCUMENTO_NOMINAS;

export const TIPOS_DOCUMENTO_NOMINAS = ['nomina', 'seguros_sociales'];

const mm = (n: number) => String(n).padStart(2, '0');
const MIMES = ['application/pdf', 'image/jpeg', 'image/png'];

export interface DocumentoNominaDTO {
  id: string;
  tipo: string;
  clase: ClaseDocumentoNominas;
  ejercicio: number;
  mes: number;
  nominaId: string | null;
  trabajador: string | null;
  archivoNombre: string;
  archivoTipo: string;
  archivoTamanio: number;
  archivoHash: string;
  estado: string;
  observaciones: string | null;
  uploadedBy: string | null;
  uploadedAt: Date;
}

type FilaDoc = Awaited<ReturnType<typeof prisma.documentoArchivo.findFirstOrThrow>>;

function claseDe(d: FilaDoc): ClaseDocumentoNominas {
  if (d.tipo === 'nomina') return 'nomina';
  return d.observaciones?.startsWith('RNT') ? 'rnt' : 'rlc';
}

function aDTO(d: FilaDoc, trabajadores: Map<string, string>): DocumentoNominaDTO {
  return {
    id: d.id,
    tipo: d.tipo,
    clase: claseDe(d),
    ejercicio: d.anio,
    mes: d.mes,
    nominaId: d.nominaId,
    trabajador: d.nominaId ? (trabajadores.get(d.nominaId) ?? null) : null,
    archivoNombre: d.archivoNombre,
    archivoTipo: d.archivoTipo,
    archivoTamanio: d.archivoTamanio,
    archivoHash: d.archivoHash,
    estado: d.estado,
    observaciones: d.observaciones,
    uploadedBy: d.uploadedBy,
    uploadedAt: d.uploadedAt,
  };
}

async function nombresPorNomina(ids: Array<string | null>): Promise<Map<string, string>> {
  const validos = [...new Set(ids.filter((x): x is string => !!x))];
  if (!validos.length) return new Map();
  const filas = await prisma.nomina.findMany({ where: { id: { in: validos } }, select: { id: true, empleado: { select: { nombre: true, apellidos: true } } } });
  return new Map(filas.map((n) => [n.id, nombreCompleto(n.empleado)]));
}

export interface FicheroSubido {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

/**
 * Sube el PDF de un mes: clase 'nomina' (con nominaId si es el recibo de un
 * trabajador; sin el, el PDF de todo el mes), 'rlc' o 'rnt'. 409 si el mismo
 * fichero ya esta en el archivo. El recibo nuevo de una nomina sustituye al
 * anterior (queda como reemplazado).
 */
export async function subirDocumentoNominas(
  companyId: string,
  ejercicio: number,
  mes: number,
  fichero: FicheroSubido | undefined,
  opciones: { clase?: string; nominaId?: string; observaciones?: string; userId?: string } = {},
): Promise<DocumentoNominaDTO> {
  if (!fichero?.buffer?.length) throw badRequest('Adjunta el PDF en el campo "archivo".');
  if (!MIMES.includes(fichero.mimetype)) throw badRequest('El documento tiene que ser un PDF (o una imagen JPG o PNG).');
  const claseTxt = String(opciones.clase ?? 'nomina').toLowerCase();
  if (!(claseTxt in CLASES_DOCUMENTO_NOMINAS)) throw badRequest('El tipo de documento tiene que ser nomina, rlc o rnt.');
  const clase = CLASES_DOCUMENTO_NOMINAS[claseTxt as ClaseDocumentoNominas];
  let nominaId: string | null = null;
  if (opciones.nominaId) {
    if (claseTxt !== 'nomina') throw badRequest('Solo un recibo de nómina se enlaza con una nómina.');
    const n = await prisma.nomina.findFirst({ where: { id: opciones.nominaId, companyId }, select: { id: true, ejercicio: true, mes: true } });
    if (!n) throw notFound('Nómina no encontrada.');
    if (n.ejercicio !== ejercicio || n.mes !== mes) throw badRequest(`La nómina indicada es de ${mm(n.mes)}/${n.ejercicio}, no de ${mm(mes)}/${ejercicio}.`);
    nominaId = n.id;
  }

  const hash = createHash('sha256').update(fichero.buffer).digest('hex');
  const repetido = await prisma.documentoArchivo.findFirst({
    where: { companyId, archivoHash: hash, estado: 'activo', tipo: { in: TIPOS_DOCUMENTO_NOMINAS } },
    select: { id: true, archivoNombre: true, anio: true, mes: true },
  });
  if (repetido) {
    throw conflict(`Este fichero ya está en el archivo de nóminas (${repetido.archivoNombre}, ${mm(repetido.mes)}/${repetido.anio}).`, { documentoId: repetido.id });
  }

  const fecha = ultimoDiaMes(ejercicio, mes);
  const ext = nombreSeguro(/\.([A-Za-z0-9]{1,5})$/.exec(fichero.originalname)?.[1]?.toLowerCase() ?? (fichero.mimetype === 'application/pdf' ? 'pdf' : 'bin'));
  const base = nombreSeguro(fichero.originalname.replace(/\.[A-Za-z0-9]{1,5}$/, '')).slice(0, 80);
  const nombreArchivo = `${ejercicio}-${mm(mes)}_${claseTxt}_${hash.slice(0, 8)}_${base}.${ext}`;
  const clave = `nominas/${nombreSeguro(companyId)}/${ejercicio}/${mm(mes)}/${clase.carpeta}/${nombreArchivo}`;
  let archivoPath: string;
  try {
    archivoPath = await putObject(clave, fichero.buffer, fichero.mimetype);
  } catch (e) {
    logger.warn(`[nominas] No se pudo guardar ${clave}: ${e instanceof Error ? e.message : String(e)}`);
    throw new HttpError(503, 'No se ha podido guardar el PDF en el almacenamiento privado. Vuelve a intentarlo; si sigue fallando, revisa la configuración del almacenamiento (Vercel Blob).');
  }

  if (nominaId) {
    await prisma.documentoArchivo.updateMany({ where: { companyId, nominaId, estado: 'activo', tipo: 'nomina' }, data: { estado: 'reemplazado' } });
  }
  const etiqueta = claseTxt === 'nomina' ? null : claseTxt.toUpperCase();
  const doc = await prisma.documentoArchivo.create({
    data: {
      companyId,
      tipo: clase.tipo,
      fecha,
      mes,
      trimestre: Math.ceil(mes / 3),
      anio: ejercicio,
      archivoNombre: nombreSeguro(fichero.originalname).slice(0, 190),
      archivoTipo: fichero.mimetype,
      archivoTamanio: fichero.buffer.length,
      archivoPath,
      archivoHash: hash,
      nominaId,
      origen: 'manual',
      observaciones: [etiqueta, opciones.observaciones?.trim()].filter(Boolean).join(' - ') || null,
      uploadedBy: opciones.userId ?? null,
    },
  });
  return aDTO(doc, await nombresPorNomina([nominaId]));
}

/** Documentos de nominas y seguros sociales activos de un ejercicio (o de un mes). */
export async function listarDocumentosNominas(companyId: string, filtro: { ejercicio: number; mes?: number; trimestre?: number }): Promise<DocumentoNominaDTO[]> {
  const docs = await prisma.documentoArchivo.findMany({
    where: {
      companyId,
      tipo: { in: TIPOS_DOCUMENTO_NOMINAS },
      estado: 'activo',
      anio: filtro.ejercicio,
      ...(filtro.mes ? { mes: filtro.mes } : {}),
      ...(filtro.trimestre ? { trimestre: filtro.trimestre } : {}),
    },
    orderBy: [{ mes: 'asc' }, { tipo: 'asc' }, { uploadedAt: 'asc' }],
  });
  const nombres = await nombresPorNomina(docs.map((d) => d.nominaId));
  return docs.map((d) => aDTO(d, nombres));
}

async function cargarDocumento(companyId: string, id: string): Promise<FilaDoc> {
  const d = await prisma.documentoArchivo.findFirst({ where: { id, companyId, tipo: { in: TIPOS_DOCUMENTO_NOMINAS } } });
  if (!d) throw notFound('Documento no encontrado.');
  return d;
}

export async function descargarDocumentoNominas(companyId: string, id: string): Promise<{ buffer: Buffer; nombre: string; tipo: string }> {
  const d = await cargarDocumento(companyId, id);
  if (!d.archivoPath) throw notFound('El documento no tiene el fichero guardado.');
  return { buffer: await getObject(d.archivoPath), nombre: d.archivoNombre, tipo: d.archivoTipo };
}

/** Anula un documento (no se borra el fichero: queda fuera del archivo). */
export async function anularDocumentoNominas(companyId: string, id: string): Promise<void> {
  const d = await cargarDocumento(companyId, id);
  if (d.estado === 'anulado') return;
  await prisma.documentoArchivo.update({ where: { id: d.id }, data: { estado: 'anulado' } });
}

/** ZIP de los documentos de nominas de un ejercicio, trimestre o mes: <MM>/<nominas|seguros-sociales>/<fichero>. */
export async function zipDocumentosNominas(companyId: string, filtro: { ejercicio: number; mes?: number; trimestre?: number }): Promise<{ nombre: string; contenido: Buffer }> {
  const docs = await listarDocumentosNominas(companyId, filtro);
  if (!docs.length) throw notFound('No hay documentos de nóminas en ese periodo.');
  const filas = await prisma.documentoArchivo.findMany({ where: { id: { in: docs.map((d) => d.id) }, companyId }, select: { id: true, archivoPath: true } });
  const rutas = new Map(filas.map((f) => [f.id, f.archivoPath]));
  const entradas: ZipEntry[] = [];
  const usados = new Set<string>();
  for (const d of docs) {
    const ruta = rutas.get(d.id);
    if (!ruta) continue;
    const carpeta = CLASES_DOCUMENTO_NOMINAS[d.clase].carpeta;
    const base = `${mm(d.mes)}/${carpeta}/${d.trabajador ? `${nombreSeguro(d.trabajador)}_` : ''}${d.archivoNombre}`;
    let nombre = base;
    for (let i = 2; usados.has(nombre); i++) nombre = base.replace(/(\.[^./]+)?$/, `_${i}$1`);
    usados.add(nombre);
    entradas.push({ name: nombre, data: await getObject(ruta) });
  }
  const sufijo = filtro.mes ? `_${mm(filtro.mes)}` : filtro.trimestre ? `_${filtro.trimestre}T` : '';
  return { nombre: `nominas_${filtro.ejercicio}${sufijo}.zip`, contenido: crearZip(entradas, { comprimir: true, fecha: new Date() }) };
}
