/**
 * Proveedores — MIGRADO de FacturaScripts a Prisma (modelo `Supplier`), épico
 * FS→Prisma (ADR-002). Comparte la MISMA tabla `supplier` que las facturas de
 * gasto (expense-invoices). Mantiene los endpoints /companies/:companyId/proveedores.
 *
 * Alta y modificacion con los datos validados (datosProveedor): NIF español
 * con su caracter de control, pais ISO-2, direccion completa, email y
 * telefono que se pueden borrar. NIF repetido y borrar con facturas: 409.
 * Cada alta, cambio y baja queda en el historial (SupplierAudit).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { ID, Paginated } from '../domain/common.types';
import { parsePagination } from '../utils/pagination';
import { badRequest, conflict, notFound } from '../utils/http-errors';
import { normalizarNif, validarNifEspanol } from '../utils/nif';
import { esCodigoPais, problemaCodigoPostal } from '../utils/geografia';
import { limpiarNif, normalizarPais, prefijoNifIvaUe } from '../domain/tipo-operacion.model';
import { logCreate, logDelete, logUpdate } from './suppliers/supplierAudit.service';
import { hoyEspana } from '../utils/fechas';
import {
  apuntesEnSubcuentas,
  conReintentoSubcuenta,
  crearProveedorConSubcuenta,
  retirarSubcuentasDeFicha,
  sincronizarNombreSubcuentas,
  subcuentasEnPlan,
} from './terceros/subcuentas';

/** Proveedor tal como lo devuelve la API. */
export interface Proveedor {
  id: string;
  nombreFiscal: string;
  nifCif: string;
  email: string;
  telefono: string;
  direccion: string;
  provincia: string;
  municipio: string;
  cp: string;
  pais: string;
  activo: boolean;
  /** Subcuentas propias con el mismo numero: 400N (compras) y 410N (servicios). */
  subcuenta400: string | null;
  subcuenta410: string | null;
  /** Las que ya estan dadas de alta en el plan (las demas, "sin movimientos todavia"). */
  subcuentasEnPlan: string[];
}

/** Proveedor en formato ligero para selectores (espejo de ClienteResumen). */
export interface ProveedorResumen {
  id: string;
  nombre: string;
  nif: string;
  email: string;
  telefono: string;
  pais: string;
  activo: boolean;
}

type SupplierRow = {
  id: string;
  nombreFiscal: string;
  nifCif: string;
  email: string | null;
  telefono: string | null;
  direccion: string | null;
  provincia: string | null;
  municipio: string | null;
  cp: string | null;
  pais: string;
  activo: boolean;
  subcuenta400?: string | null;
  subcuenta410?: string | null;
};

/** Supplier (Prisma) -> forma de respuesta del recurso proveedores (todos los campos). */
function aProveedor(s: SupplierRow, enPlan: string[] = []): Proveedor {
  return {
    id: s.id,
    nombreFiscal: s.nombreFiscal,
    nifCif: s.nifCif,
    email: s.email ?? '',
    telefono: s.telefono ?? '',
    direccion: s.direccion ?? '',
    provincia: s.provincia ?? '',
    municipio: s.municipio ?? '',
    cp: s.cp ?? '',
    pais: s.pais || 'ES',
    activo: s.activo,
    subcuenta400: s.subcuenta400 ?? null,
    subcuenta410: s.subcuenta410 ?? null,
    subcuentasEnPlan: enPlan.filter((c) => c === s.subcuenta400 || c === s.subcuenta410),
  };
}

/** Respuesta de varios proveedores con sus subcuentas ya dadas de alta en el plan (una consulta). */
async function aProveedores(companyId: string, filas: SupplierRow[]): Promise<Proveedor[]> {
  const enPlan = await subcuentasEnPlan(prisma, companyId, filas.flatMap((s) => [s.subcuenta400, s.subcuenta410]));
  return filas.map((s) => aProveedor(s, enPlan));
}

/** P2002 del indice (companyId, nifCif). */
const nifRepetido = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && String((e.meta as { target?: unknown } | undefined)?.target ?? '').includes('nifCif');

async function errorNifRepetido(companyId: string, nif: string, excluir?: string) {
  const ya = await prisma.supplier.findFirst({
    where: { companyId, nifCif: nif, ...(excluir ? { id: { not: excluir } } : {}) },
    select: { id: true, nombreFiscal: true },
  });
  return conflict(`Ya existe un proveedor con ese NIF: ${ya?.nombreFiscal ?? ''}.`.replace(': .', '.'), { campo: 'nifCif', proveedorId: ya?.id });
}

async function buscarDeLaEmpresa(companyId: string, id: string): Promise<SupplierRow> {
  const s = (await prisma.supplier.findFirst({ where: { id, companyId } })) as SupplierRow | null;
  if (!s) throw notFound('Proveedor no encontrado.');
  return s;
}

const CAMPOS_HISTORIAL = ['nombreFiscal', 'nifCif', 'pais', 'direccion', 'provincia', 'municipio', 'cp', 'email', 'telefono', 'activo'] as const;

export const proveedoresService = {
  /**
   * Listado con busqueda en el servidor (q: nombre, NIF o email), filtro de
   * activo y paginacion (page/limit, por defecto 50 y como mucho 200).
   */
  async list(companyId: ID, params: Record<string, unknown> = {}): Promise<Paginated<Proveedor> & { page: number }> {
    const { limit, offset, page } = parsePagination(params);
    const where: Prisma.SupplierWhereInput = { companyId: String(companyId) };
    const q = typeof params.q === 'string' ? params.q.trim() : '';
    if (q) {
      where.OR = [
        { nombreFiscal: { contains: q } },
        { nifCif: { contains: q } },
        { email: { contains: q } },
        { subcuenta400: { startsWith: q } },
        { subcuenta410: { startsWith: q } },
      ];
    }
    if (params.activo === 'true' || params.activo === true) where.activo = true;
    if (params.activo === 'false' || params.activo === false) where.activo = false;
    const [items, total] = await Promise.all([
      prisma.supplier.findMany({ where, skip: offset, take: limit, orderBy: [{ nombreFiscal: 'asc' }, { id: 'asc' }] }),
      prisma.supplier.count({ where }),
    ]);
    return { items: await aProveedores(String(companyId), items as SupplierRow[]), total, limit, offset, page };
  },

  async getById(companyId: ID, id: ID): Promise<Proveedor> {
    return (await aProveedores(String(companyId), [await buscarDeLaEmpresa(String(companyId), String(id))]))[0];
  },

  /** Proveedor de la empresa con ese NIF (normalizado), o 404. */
  async porNif(companyId: ID, nif: string): Promise<Proveedor> {
    const nifs = [...new Set([normalizarNif(nif), limpiarNif(nif)].filter(Boolean))];
    const s = (await prisma.supplier.findFirst({ where: { companyId: String(companyId), nifCif: { in: nifs } } })) as SupplierRow | null;
    if (!s) throw notFound('No hay ningún proveedor con ese NIF.');
    return (await aProveedores(String(companyId), [s]))[0];
  },

  async create(companyId: ID, data: Record<string, unknown>, usuarioEmail?: string): Promise<Proveedor> {
    const d = datosProveedor(data ?? {});
    const ya = await prisma.supplier.findFirst({ where: { companyId: String(companyId), nifCif: d.nifCif! }, select: { id: true } });
    if (ya) throw await errorNifRepetido(String(companyId), d.nifCif!);
    let s: SupplierRow;
    try {
      // Las subcuentas 400N y 410N se asignan en la misma transaccion que el alta.
      s = (await crearProveedorConSubcuenta({
        companyId: String(companyId),
        ...d,
        nombreFiscal: d.nombreFiscal!,
        nifCif: d.nifCif!,
        pais: d.pais ?? 'ES',
      })) as SupplierRow;
    } catch (e) {
      if (nifRepetido(e)) throw await errorNifRepetido(String(companyId), d.nifCif!);
      throw e;
    }
    await logCreate(s.id, usuarioEmail);
    return aProveedor(s);
  },

  /** Modificacion parcial: solo cambian los campos que llegan. Un historial por campo cambiado. */
  async update(companyId: ID, id: ID, data: Record<string, unknown>, usuarioEmail?: string): Promise<Proveedor> {
    const existe = await buscarDeLaEmpresa(String(companyId), String(id));
    const d = datosProveedor(data ?? {}, existe);
    const cambios = CAMPOS_HISTORIAL.filter((k) => d[k] !== undefined && (existe[k] ?? null) !== (d[k] ?? null));
    if (!cambios.length) return (await aProveedores(String(companyId), [existe]))[0];
    if (d.nifCif) {
      const ya = await prisma.supplier.findFirst({ where: { companyId: String(companyId), nifCif: d.nifCif, id: { not: existe.id } }, select: { id: true } });
      if (ya) throw await errorNifRepetido(String(companyId), d.nifCif, existe.id);
    }
    let s: SupplierRow;
    try {
      s = (await prisma.$transaction(async (tx) => {
        // La subcuenta del plan lleva el nombre fiscal: cambia con el. Los apuntes ya grabados no se tocan.
        if (cambios.includes('nombreFiscal')) {
          await sincronizarNombreSubcuentas(tx, String(companyId), [existe.subcuenta400, existe.subcuenta410], d.nombreFiscal!);
        }
        return tx.supplier.update({ where: { id: existe.id }, data: Object.fromEntries(cambios.map((k) => [k, d[k]])) });
      })) as SupplierRow;
    } catch (e) {
      if (nifRepetido(e)) throw await errorNifRepetido(String(companyId), d.nifCif ?? '', existe.id);
      throw e;
    }
    for (const k of cambios) await logUpdate(existe.id, k, existe[k], d[k], usuarioEmail);
    return (await aProveedores(String(companyId), [s]))[0];
  },

  /**
   * Borra el proveedor si no tiene facturas ni apuntes en sus subcuentas; si
   * no, 409 (se puede desactivar). Sus subcuentas quedan en el plan inactivas:
   * el numero no se le da a otro proveedor.
   */
  async remove(companyId: ID, id: ID, usuarioEmail?: string): Promise<void> {
    const existe = await buscarDeLaEmpresa(String(companyId), String(id));
    const facturas = await prisma.expenseInvoice.count({ where: { companyId: String(companyId), supplierId: existe.id } });
    if (facturas > 0) {
      throw conflict(`No se puede borrar: tiene ${facturas} factura(s). Puedes desactivarlo para que no salga al registrar gastos.`, { facturas });
    }
    const subcuentas = [existe.subcuenta400, existe.subcuenta410];
    const apuntes = await apuntesEnSubcuentas(prisma, String(companyId), subcuentas);
    if (apuntes > 0) {
      throw conflict('No se puede borrar: tiene movimientos contables en su subcuenta. Puedes desactivarlo para que no salga al registrar gastos.', { apuntes });
    }
    await conReintentoSubcuenta(() =>
      prisma.$transaction(async (tx) => {
        await retirarSubcuentasDeFicha(tx, String(companyId), subcuentas, { tipo: 'proveedor', id: existe.id, nombreFiscal: existe.nombreFiscal }, hoyEspana());
        await tx.supplier.delete({ where: { id: existe.id } });
      }),
    );
    await logDelete(existe.id, usuarioEmail, `Proveedor eliminado: ${existe.nombreFiscal} (${existe.nifCif})`);
  },
};

/** Busqueda por nombre/NIF/email sobre Prisma (espejo de buscarClientes). */
export async function buscarProveedores(companyId: ID, query: string, limit = 20, soloActivos = false): Promise<ProveedorResumen[]> {
  const q = (query ?? '').trim();
  const where: Prisma.SupplierWhereInput = { companyId: String(companyId), ...(soloActivos ? { activo: true } : {}) };
  if (q) {
    where.OR = [
      { nombreFiscal: { contains: q } },
      { nifCif: { contains: q } },
      { email: { contains: q } },
    ];
  }
  const items = (await prisma.supplier.findMany({ where, take: limit, orderBy: { nombreFiscal: 'asc' } })) as SupplierRow[];
  return items.map((s) => ({ id: s.id, nombre: s.nombreFiscal, nif: s.nifCif, email: s.email ?? '', telefono: s.telefono ?? '', pais: s.pais || 'ES', activo: s.activo }));
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
