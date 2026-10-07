/**
 * Proveedores — MIGRADO de FacturaScripts a Prisma (modelo `Supplier`), épico
 * FS→Prisma (ADR-002). Comparte la MISMA tabla `supplier` que las facturas de
 * gasto (expense-invoices). Mantiene los endpoints /companies/:companyId/proveedores
 * (el frontend Chakra no cambia). Espejo de clientes.service.
 */
import { prisma } from '../config/database';
import { CompanyScopedService, ID, Paginated } from '../domain/common.types';
import { parsePagination } from '../utils/pagination';
import { badRequest, notFound } from '../utils/http-errors';
import { validarNifEspanol } from '../utils/nif';
import { esCodigoPais, problemaCodigoPostal } from '../utils/geografia';
import { limpiarNif, normalizarPais, prefijoNifIvaUe } from '../domain/tipo-operacion.model';

export interface Proveedor {
  codproveedor?: string;
  nombre?: string;
  razonsocial?: string;
  cifnif?: string;
  email?: string;
  [key: string]: unknown;
}

/** Proveedor en formato ligero para selectores (espejo de ClienteResumen). */
export interface ProveedorResumen {
  id: string;
  nombre: string;
  nif: string;
  email: string;
  telefono: string;
}

type SupplierRow = {
  id: string;
  nombreFiscal: string;
  nifCif: string;
  email: string | null;
  telefono: string | null;
  activo: boolean;
};

/** Supplier (Prisma) -> forma de respuesta del recurso proveedores. */
function aProveedor(s: SupplierRow): Record<string, unknown> {
  return {
    id: s.id,
    nombreFiscal: s.nombreFiscal,
    nifCif: s.nifCif,
    email: s.email ?? '',
    telefono: s.telefono ?? '',
    activo: s.activo,
  };
}

/** Lee nombre/nif/teléfono del payload aceptando alias FS y Prisma. */
function leerDatos(data: Record<string, unknown>): { nombreFiscal?: string; nifCif?: string; email: string | null; telefono: string | null; direccion: string | null } {
  const nombre = (data.nombreFiscal ?? data.nombre ?? data.razonsocial) as string | undefined;
  const nif = (data.nifCif ?? data.cifnif ?? data.nif) as string | undefined;
  const tel = (data.telefono ?? data.telefono1) as string | undefined;
  return {
    nombreFiscal: nombre !== undefined ? String(nombre) : undefined,
    nifCif: nif !== undefined ? String(nif) : undefined,
    email: data.email != null ? String(data.email) : null,
    telefono: tel != null && tel !== '' ? String(tel) : null,
    direccion: data.direccion != null ? String(data.direccion) : null,
  };
}

export const proveedoresService: CompanyScopedService<Proveedor> = {
  async list(companyId: ID, params: Record<string, unknown> = {}): Promise<Paginated<Proveedor>> {
    const { limit, offset } = parsePagination(params);
    const where = { companyId: String(companyId) };
    const [items, total] = await Promise.all([
      prisma.supplier.findMany({ where, skip: offset, take: limit, orderBy: { createdAt: 'desc' } }),
      prisma.supplier.count({ where }),
    ]);
    return { items: (items as SupplierRow[]).map(aProveedor) as unknown as Proveedor[], total, limit, offset };
  },

  async getById(companyId: ID, id: ID): Promise<Proveedor> {
    const s = (await prisma.supplier.findFirst({ where: { id: String(id), companyId: String(companyId) } })) as SupplierRow | null;
    if (!s) throw notFound('Proveedor no encontrado.');
    return aProveedor(s) as unknown as Proveedor;
  },

  async create(companyId: ID, data: Record<string, unknown>): Promise<Proveedor> {
    const d = leerDatos(data);
    if (!d.nombreFiscal || !d.nifCif) throw notFound('Se requiere nombre y NIF.');
    const s = (await prisma.supplier.create({
      data: {
        companyId: String(companyId),
        nombreFiscal: d.nombreFiscal,
        nifCif: d.nifCif,
        email: d.email,
        telefono: d.telefono,
        direccion: d.direccion,
        pais: data.pais != null ? String(data.pais) : 'ES',
      },
    })) as SupplierRow;
    return aProveedor(s) as unknown as Proveedor;
  },

  async update(companyId: ID, id: ID, data: Record<string, unknown>): Promise<Proveedor> {
    const existe = await prisma.supplier.findFirst({ where: { id: String(id), companyId: String(companyId) } });
    if (!existe) throw notFound('Proveedor no encontrado.');
    const d = leerDatos(data);
    const s = (await prisma.supplier.update({
      where: { id: String(id) },
      data: {
        ...(d.nombreFiscal !== undefined ? { nombreFiscal: d.nombreFiscal } : {}),
        ...(d.nifCif !== undefined ? { nifCif: d.nifCif } : {}),
        ...(data.email !== undefined ? { email: d.email } : {}),
        ...(data.telefono !== undefined || data.telefono1 !== undefined ? { telefono: d.telefono } : {}),
      },
    })) as SupplierRow;
    return aProveedor(s) as unknown as Proveedor;
  },

  async remove(companyId: ID, id: ID): Promise<void> {
    const existe = await prisma.supplier.findFirst({ where: { id: String(id), companyId: String(companyId) } });
    if (!existe) throw notFound('Proveedor no encontrado.');
    await prisma.supplier.delete({ where: { id: String(id) } });
  },
};

/** Busqueda por nombre/NIF/email sobre Prisma (espejo de buscarClientes). */
export async function buscarProveedores(companyId: ID, query: string, limit = 20): Promise<ProveedorResumen[]> {
  const q = (query ?? '').trim();
  const where: Record<string, unknown> = { companyId: String(companyId) };
  if (q) {
    where.OR = [
      { nombreFiscal: { contains: q } },
      { nifCif: { contains: q } },
      { email: { contains: q } },
    ];
  }
  const items = (await prisma.supplier.findMany({ where, take: limit, orderBy: { nombreFiscal: 'asc' } })) as SupplierRow[];
  return items.map((s) => ({ id: s.id, nombre: s.nombreFiscal, nif: s.nifCif, email: s.email ?? '', telefono: s.telefono ?? '' }));
}

// ---------------------------------------------------------------------------
// Validacion comun de los datos de un proveedor (alta, modificacion y el
// proveedor nuevo que se da de alta con una factura de gasto).
// ---------------------------------------------------------------------------

/** Datos de un proveedor ya validados. En una modificacion solo vienen los que cambian. */
export interface DatosProveedor {
  nombreFiscal?: string;
  nifCif?: string;
  pais?: string;
  direccion?: string | null;
  provincia?: string | null;
  municipio?: string | null;
  cp?: string | null;
  email?: string | null;
  telefono?: string | null;
  activo?: boolean;
}

const errorCampo = (mensaje: string, campo: string) => badRequest(mensaje, { campo });
const textoONull = (v: unknown): string | null => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Pais del proveedor en ISO-2. Sin pais (o 'ES') y con un NIF-IVA de otro
 * Estado de la UE, el del prefijo. La misma regla que leerPais de clientes.
 */
export function leerPaisProveedor(valor: unknown, nif?: string): string | undefined {
  const crudo = textoONull(valor);
  const prefijo = prefijoNifIvaUe(nif);
  if (crudo === null) return prefijo && prefijo.pais !== 'ES' ? prefijo.pais : undefined;
  const pais = normalizarPais(crudo);
  if (!/^[A-Z]{2}$/.test(pais)) throw errorCampo('El país del proveedor tiene que ser un código de dos letras (ES, FR, US...).', 'pais');
  if (!esCodigoPais(pais)) throw errorCampo(`El país del proveedor «${pais}» no existe: usa su código de dos letras (ES para España, FR, US...).`, 'pais');
  if (pais === 'ES' && prefijo && prefijo.pais !== 'ES') return prefijo.pais;
  return pais;
}

/**
 * Valida y normaliza los datos de un proveedor. Sin `existente` es un alta
 * (nombre y NIF obligatorios); con `existente`, una modificacion parcial: solo
 * se devuelven los campos que llegan. En España el NIF se valida con su
 * caracter de control y se guarda normalizado; fuera, en mayusculas y sin
 * espacios, puntos ni guiones. Una cadena vacia en email o telefono los borra.
 */
export function datosProveedor(
  data: Record<string, unknown>,
  existente?: { nifCif: string; pais: string | null; provincia?: string | null; cp?: string | null },
): DatosProveedor {
  const d: DatosProveedor = {};
  const has = (...k: string[]) => k.some((x) => data[x] !== undefined);
  const nombre = data.nombreFiscal ?? data.nombre ?? data.razonsocial;
  const nifCrudo = data.nifCif ?? data.cifnif ?? data.nif;

  if (!existente || nombre !== undefined) {
    const n = textoONull(nombre);
    if (!n) throw errorCampo('Falta el nombre fiscal del proveedor.', 'nombreFiscal');
    if (n.length > 200) throw errorCampo('El nombre fiscal es demasiado largo (200 caracteres como mucho).', 'nombreFiscal');
    d.nombreFiscal = n;
  }

  const nif = nifCrudo !== undefined ? textoONull(nifCrudo) : existente?.nifCif ?? null;
  if (!nif) throw errorCampo('Falta el NIF del proveedor.', 'nifCif');

  // Pais: el que llega, o (si cambia el NIF) el que diga su prefijo de NIF-IVA.
  let pais: string | undefined;
  if (data.pais !== undefined) pais = leerPaisProveedor(data.pais, nif) ?? 'ES';
  else if (!existente) pais = leerPaisProveedor(undefined, nif) ?? 'ES';
  else if (nifCrudo !== undefined) pais = leerPaisProveedor(existente.pais || 'ES', nif);
  const paisFinal = pais ?? normalizarPais(existente?.pais || 'ES');
  if (pais !== undefined && (!existente || pais !== normalizarPais(existente.pais))) d.pais = pais;

  if (!existente || nifCrudo !== undefined || d.pais !== undefined) {
    let nifFinal: string;
    if (paisFinal === 'ES') {
      const r = validarNifEspanol(nif);
      if (!r.valido) throw errorCampo(r.motivo ?? 'El NIF no es válido.', 'nifCif');
      nifFinal = r.normalizado;
    } else {
      nifFinal = limpiarNif(nif);
    }
    if (!existente || nifFinal !== existente.nifCif) d.nifCif = nifFinal;
  }

  for (const campo of ['direccion', 'provincia', 'municipio', 'cp'] as const) {
    if (!has(campo)) continue;
    const v = textoONull(data[campo]);
    if (v && v.length > 200) throw errorCampo('El texto es demasiado largo (200 caracteres como mucho).', campo);
    d[campo] = v;
  }
  if (paisFinal === 'ES') {
    const cp = d.cp !== undefined ? d.cp : existente?.cp ?? null;
    const provincia = d.provincia !== undefined ? d.provincia : existente?.provincia ?? null;
    if (cp && (d.cp !== undefined || d.provincia !== undefined || d.pais !== undefined)) {
      const problema = problemaCodigoPostal(cp, provincia);
      if (problema) throw errorCampo(problema.mensaje, problema.tipo === 'provincia' ? 'provincia' : 'cp');
    }
  }

  if (has('email')) {
    const e = textoONull(data.email);
    if (e && !EMAIL.test(e)) throw errorCampo('El email no es válido.', 'email');
    d.email = e;
  }
  if (has('telefono', 'telefono1')) {
    const t = textoONull(data.telefono ?? data.telefono1);
    if (t && t.length > 30) throw errorCampo('El teléfono es demasiado largo.', 'telefono');
    d.telefono = t;
  }
  if (has('activo')) {
    const a = data.activo;
    if (a === true || a === 'true') d.activo = true;
    else if (a === false || a === 'false') d.activo = false;
    else throw errorCampo('«activo» tiene que ser sí o no (true o false).', 'activo');
  }
  return d;
}
