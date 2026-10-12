/**
 * El proveedor o el cliente de una factura leida tiene que estar dado de alta
 * antes de registrarla (decision del usuario del 12-10-2026). Hasta entonces,
 * el lector se los creaba solo al confirmar, con lo que se hubiera leido.
 *
 *  - clientePorNif: el cliente de la empresa con ese NIF (la lectura de ventas
 *    lo devuelve como clienteExistente, igual que proveedorExistente en gastos).
 *  - exigirProveedorDadoDeAlta: el /confirmar de gastos solo admite
 *    proveedor: { id }. Un proveedor nuevo da 400 TERCERO_NO_DADO_DE_ALTA.
 *  - errorTerceroNoDadoDeAlta: el mismo 400 para el /confirmar de ventas.
 *
 * Fichero aparte para no tocar los servicios del lector mas de lo necesario.
 * No importa contexto.ts ni ingresos-extractor.service (que lo usa): sin ciclos.
 */
import { prisma } from '../../config/database';
import { limpiarNif } from '../../domain/tipo-operacion.model';
import { badRequest, HttpError } from '../../utils/http-errors';
import { normalizarNif } from '../../utils/nif';

export const CODIGO_TERCERO_NO_DADO_DE_ALTA = 'TERCERO_NO_DADO_DE_ALTA';

export type TipoTercero = 'proveedor' | 'cliente';

export interface TerceroExistente {
  id: string;
  nombreFiscal: string;
  nifCif: string;
}

/**
 * Formas en que puede estar guardado un NIF: normalizado (sin ES ni signos),
 * solo sin signos y con el prefijo ES. Los clientes se guardan tal como se
 * escribieron (mayusculas, sin espacios ni guiones), asi que pueden llevar ES
 * o puntos.
 */
export function variantesNif(nif: string): string[] {
  const normal = normalizarNif(nif);
  const sinSignos = limpiarNif(nif);
  const conPuntos = String(nif ?? '').toUpperCase().replace(/[\s-]/g, '');
  return [...new Set([normal, sinSignos, conPuntos, normal ? `ES${normal}` : ''].filter(Boolean))];
}

/** Cliente de la empresa con ese NIF (con o sin prefijo ES y separadores), o null. */
export async function clientePorNif(companyId: string, nif: string | null | undefined): Promise<TerceroExistente | null> {
  if (!nif || !normalizarNif(nif)) return null;
  return prisma.customer.findFirst({
    where: { companyId, nifCif: { in: variantesNif(nif) } },
    select: { id: true, nombreFiscal: true, nifCif: true },
    orderBy: { createdAt: 'asc' },
  });
}

const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * 400 TERCERO_NO_DADO_DE_ALTA. Con nombre o NIF, los dice; si ya hay uno con
 * ese NIF (el formulario mando un tercero nuevo en vez de elegirlo), lo dice y
 * lo devuelve en details.existente para enlazarlo.
 */
export function errorTerceroNoDadoDeAlta(
  tipo: TipoTercero,
  leido: { nombre?: string | null; nif?: string | null },
  existente: TerceroExistente | null = null,
): HttpError {
  const nombre = texto(leido.nombre);
  const nif = texto(leido.nif);
  const campo = tipo === 'proveedor' ? 'proveedor' : 'clienteId';
  const detalles = { codigo: CODIGO_TERCERO_NO_DADO_DE_ALTA, tipo, campo, nombre, nif, ...(existente ? { existente } : {}) };
  if (existente) {
    return badRequest(`Ya tienes dado de alta un ${tipo} con ese NIF: ${existente.nombreFiscal}. Elígelo para registrar la factura.`, detalles);
  }
  if (!nombre && !nif) {
    return badRequest(`Antes de registrar la factura, da de alta el ${tipo} o elige uno que ya tengas.`, detalles);
  }
  const quien = nombre && nif ? `${nombre} (${nif})` : (nombre ?? nif);
  return badRequest(`Este ${tipo} no está dado de alta: ${quien}. Dalo de alta o elige uno que ya tengas para poder registrar la factura.`, detalles);
}

/**
 * /gastos-extractor/confirmar: el proveedor tiene que llegar como { id } (uno
 * dado de alta). Que sea de la empresa lo sigue comprobando el alta de la
 * factura (404). Acepta el alias antiguo `provider`.
 */
export async function exigirProveedorDadoDeAlta(companyId: string, cuerpo: Record<string, unknown>): Promise<void> {
  const p = (cuerpo.proveedor ?? cuerpo.provider) as { id?: unknown; nuevo?: unknown } | undefined;
  if (p && typeof p === 'object' && texto(p.id)) return;
  const nuevo = (p && typeof p === 'object' && p.nuevo && typeof p.nuevo === 'object' ? p.nuevo : {}) as Record<string, unknown>;
  const nombre = texto(nuevo.nombreFiscal ?? nuevo.nombre ?? nuevo.razonsocial);
  const nif = texto(nuevo.nifCif ?? nuevo.cifnif ?? nuevo.nif);
  const existente = nif && normalizarNif(nif)
    ? await prisma.supplier.findFirst({ where: { companyId, nifCif: { in: variantesNif(nif) } }, select: { id: true, nombreFiscal: true, nifCif: true } })
    : null;
  throw errorTerceroNoDadoDeAlta('proveedor', { nombre, nif }, existente);
}
