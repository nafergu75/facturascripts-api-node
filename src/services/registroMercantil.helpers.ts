import { forbidden } from '../utils/http-errors';
import { getObject, putObject } from '../utils/storage';
import type { AuthUser } from '../types/express';

/**
 * Verifica que el usuario del token tiene acceso a la empresa del recurso. Se
 * usa en las rutas de nivel superior (/fiscal-years/:id, /books/:id...), donde
 * el companyId se deriva de la entidad y no de la URL (no hay companyScope).
 */
export function assertAccesoEmpresa(user: AuthUser | undefined, companyId: string): void {
  if (!user) throw forbidden('No autenticado.');
  if (user.esAdminGlobal) return;
  if (!user.companies.includes(companyId)) {
    throw forbidden('No tienes acceso a la empresa de este recurso.');
  }
}

function contentType(nombre: string): string {
  if (/\.zip$/i.test(nombre)) return 'application/zip';
  if (/\.pdf$/i.test(nombre)) return 'application/pdf';
  return 'application/octet-stream';
}

/**
 * Guarda un artefacto (PDF/ZIP) bajo registro-mercantil/<companyId>/<fyId>/ y
 * devuelve su referencia (URL de Vercel Blob en producción, ruta relativa en
 * local). Ver utils/storage.ts.
 */
export async function guardarArtefacto(
  companyId: string,
  fiscalYearId: string,
  nombreArchivo: string,
  contenido: Buffer,
): Promise<string> {
  const key = `registro-mercantil/${companyId}/${fiscalYearId}/${nombreArchivo}`;
  return putObject(key, contenido, contentType(nombreArchivo));
}

/** Lee un artefacto desde su referencia (URL o ruta relativa), para descargas. */
export async function leerArtefacto(ref: string): Promise<Buffer> {
  return getObject(ref);
}
