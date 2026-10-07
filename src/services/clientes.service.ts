/**
 * Clientes — MIGRADO de FacturaScripts a Prisma (modelo `Customer`), ADR-002
 * épico FS→Prisma. Comparte la MISMA tabla `customer` que las facturas de
 * ingreso (income-invoices), consolidando el doble-almacén anterior. Mantiene
 * los endpoints /companies/:companyId/clientes (el frontend Chakra no cambia).
 */
import { prisma, type TransaccionBD } from '../config/database';
import { CompanyScopedService, ID, Paginated } from '../domain/common.types';
import { Cliente } from '../domain/cliente.model';
import { parsePagination } from '../utils/pagination';
import { badRequest, notFound } from '../utils/http-errors';
import { normalizarPais, prefijoNifIvaUe } from '../domain/tipo-operacion.model';
import { MONEDAS_FACTURA_ACTIVAS, normalizarMoneda } from '../domain/divisas';
import { esCodigoPais } from '../utils/geografia';

/** Cliente en formato ligero para el selector/buscador al facturar. */
export interface ClienteResumen {
  id: string;
  nombre: string;
  nif: string;
  email: string;
  telefono: string;
}

type CustomerRow = {
  id: string;
  nombreFiscal: string;
  nifCif: string;
  email: string | null;
  telefono: string | null;
  activo: boolean;
  direccion?: string | null;
  pais?: string | null;
  cp?: string | null;
  municipio?: string | null;
  provincia?: string | null;
  monedaPreferida?: string | null;
};

/** Customer (Prisma) -> forma de respuesta del recurso clientes. */
function aCliente(c: CustomerRow): Record<string, unknown> {
  return {
    id: c.id,
    nombreFiscal: c.nombreFiscal,
    nifCif: c.nifCif,
    email: c.email ?? '',
    telefono: c.telefono ?? '',
    activo: c.activo,
    // Pais (ISO-2) y direccion: deciden el tipo de operacion de IVA que se sugiere y salen en la factura.
    pais: c.pais ?? 'ES',
    direccion: c.direccion ?? '',
    cp: c.cp ?? '',
    municipio: c.municipio ?? '',
    provincia: c.provincia ?? '',
    monedaPreferida: c.monedaPreferida ?? null,
  };
}

const textoONull = (v: unknown): string | null => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());

/**
 * Pais del cliente en ISO-2 (ES, FR, US...). Sin pais (o 'ES') y con un NIF-IVA
 * de otro Estado de la UE, el del prefijo (EL se guarda como GR). Un valor que
 * no es un codigo de dos letras, o que no es un pais ISO que exista ('SP'
 * pensando en Espana), da 400: el pais decide el tipo de operacion de IVA.
 */
export function leerPais(valor: unknown, nif?: string): string | undefined {
  const crudo = textoONull(valor);
  const prefijo = prefijoNifIvaUe(nif);
  if (crudo === null) return prefijo && prefijo.pais !== 'ES' ? prefijo.pais : undefined;
  const pais = normalizarPais(crudo);
  if (!/^[A-Z]{2}$/.test(pais)) throw badRequest('El país del cliente tiene que ser un código de dos letras (ES, FR, US...).');
  if (!esCodigoPais(pais)) {
    throw badRequest(`El país del cliente «${pais}» no existe: usa su código de dos letras (ES para España, FR, US...).`);
  }
  if (pais === 'ES' && prefijo && prefijo.pais !== 'ES') return prefijo.pais;
  return pais;
}

/**
 * Pais que queda en la ficha al modificar un cliente, o undefined si no cambia.
 * Si el pais que llega es el mismo que ya tenia (aunque este escrito de otra
 * forma, 'FRA' y 'FR') y el NIF no cambia, se deja tal cual: guardar la ficha
 * sin tocar el pais no lo reescribe. Si no llega pais pero cambia el NIF, se
 * revisa con el prefijo del NIF nuevo.
 */
export function paisTrasModificar(
  existe: { pais: string | null; nifCif: string },
  paisRecibido: unknown,
  nifRecibido: string | undefined,
): string | undefined {
  const cambiaNif = nifRecibido !== undefined && nifRecibido !== existe.nifCif;
  let nuevo: string | undefined;
  if (paisRecibido !== undefined) {
    const mismoPais = textoONull(paisRecibido) !== null && normalizarPais(String(paisRecibido)) === normalizarPais(existe.pais);
    if (mismoPais && !cambiaNif) return undefined;
    nuevo = leerPais(paisRecibido, nifRecibido ?? existe.nifCif);
  } else if (cambiaNif) {
    nuevo = leerPais(existe.pais, nifRecibido);
  }
  if (nuevo === undefined || normalizarPais(nuevo) === normalizarPais(existe.pais)) return undefined;
  return nuevo;
}

/**
 * Las facturas emitidas SIN tipo de operacion (anteriores a esa funcion) se
 * clasifican en los modelos por el pais de la ficha del cliente. Antes de
 * cambiarlo, se congela en ellas el que tenian: asi un 303, 347, 349 o 390 ya
 * presentado no cambia al editar la ficha.
 */
export async function congelarPaisFacturasAnteriores(
  db: Pick<TransaccionBD, 'incomeInvoice'>,
  companyId: string,
  customerId: string,
  paisAnterior: string | null,
): Promise<number> {
  const r = await db.incomeInvoice.updateMany({
    where: { companyId, customerId, tipoOperacion: null, paisClienteLegacy: null, estadoDocumento: { not: 'PROFORMA' } },
    data: { paisClienteLegacy: paisAnterior ?? '' },
  });
  return r.count;
}

/** Moneda en la que se le suele facturar: una de las activas, o null (la de la contabilidad). */
export function leerMonedaPreferida(valor: unknown): string | null {
  const crudo = textoONull(valor);
  if (crudo === null) return null;
  const codigo = normalizarMoneda(crudo);
  if (!MONEDAS_FACTURA_ACTIVAS.includes(codigo)) {
    throw badRequest(`La moneda preferida tiene que ser una de estas: ${MONEDAS_FACTURA_ACTIVAS.join(', ')}.`);
  }
  return codigo;
}

/** Direccion, CP, municipio y provincia que llegan en el cuerpo (solo los presentes). */
function leerDireccion(data: Record<string, unknown>) {
  const out: Record<string, string | null> = {};
  for (const k of ['direccion', 'cp', 'municipio', 'provincia'] as const) {
    if (data[k] !== undefined) out[k] = textoONull(data[k]);
  }
  return out;
}

/** Lee nombre/nif/teléfono del payload aceptando alias FS y Prisma. */
function leerDatos(data: Record<string, unknown>): { nombreFiscal?: string; nifCif?: string; email: string | null; telefono: string | null; direccion: string | null } {
  const nombre = (data.nombreFiscal ?? data.nombre ?? data.razonsocial) as string | undefined;
  const nif = (data.nifCif ?? data.cifnif ?? data.nif) as string | undefined;
  const tel = (data.telefono ?? data.telefono1) as string | undefined;
  return {
    nombreFiscal: nombre !== undefined ? String(nombre) : undefined,
    // El NIF se guarda siempre igual: mayusculas y sin espacios ni guiones.
    nifCif: nif !== undefined ? String(nif).replace(/[\s-]/g, '').toUpperCase() : undefined,
    email: data.email != null ? String(data.email) : null,
    telefono: tel != null && tel !== '' ? String(tel) : null,
    direccion: data.direccion != null ? String(data.direccion) : null,
  };
}

/**
 * Busca clientes por texto libre (nombre fiscal, NIF, email) sobre Prisma.
 */
export async function buscarClientes(companyId: ID, query: string, limit = 20): Promise<ClienteResumen[]> {
  const q = (query ?? '').trim();
  const where: Record<string, unknown> = { companyId: String(companyId) };
  if (q) {
    where.OR = [
      { nombreFiscal: { contains: q } },
      { nifCif: { contains: q } },
      { email: { contains: q } },
    ];
  }
  const items = (await prisma.customer.findMany({ where, take: limit, orderBy: { nombreFiscal: 'asc' } })) as CustomerRow[];
  return items.map((c) => ({ id: c.id, nombre: c.nombreFiscal, nif: c.nifCif, email: c.email ?? '', telefono: c.telefono ?? '' }));
}

export const clientesService: CompanyScopedService<Cliente> = {
  async list(companyId: ID, params: Record<string, unknown> = {}): Promise<Paginated<Cliente>> {
    const { limit, offset } = parsePagination(params);
    const where = { companyId: String(companyId) };
    const [items, total] = await Promise.all([
      prisma.customer.findMany({ where, skip: offset, take: limit, orderBy: { createdAt: 'desc' } }),
      prisma.customer.count({ where }),
    ]);
    return { items: (items as CustomerRow[]).map(aCliente) as unknown as Cliente[], total, limit, offset };
  },

  async getById(companyId: ID, id: ID): Promise<Cliente> {
    const c = (await prisma.customer.findFirst({ where: { id: String(id), companyId: String(companyId) } })) as CustomerRow | null;
    if (!c) throw notFound('Cliente no encontrado.');
    return aCliente(c) as unknown as Cliente;
  },

  async create(companyId: ID, data: Record<string, unknown>): Promise<Cliente> {
    const d = leerDatos(data);
    if (!d.nombreFiscal || !d.nifCif) throw notFound('Se requiere nombre y NIF.');
    const c = (await prisma.customer.create({
      data: {
        companyId: String(companyId),
        nombreFiscal: d.nombreFiscal,
        nifCif: d.nifCif,
        email: d.email,
        telefono: d.telefono,
        ...leerDireccion(data),
        pais: leerPais(data.pais, d.nifCif) ?? 'ES',
        monedaPreferida: leerMonedaPreferida(data.monedaPreferida),
      },
    })) as CustomerRow;
    return aCliente(c) as unknown as Cliente;
  },

  async update(companyId: ID, id: ID, data: Record<string, unknown>): Promise<Cliente> {
    const existe = await prisma.customer.findFirst({ where: { id: String(id), companyId: String(companyId) } });
    if (!existe) throw notFound('Cliente no encontrado.');
    const d = leerDatos(data);
    // El pais se puede cambiar; si no llega, se revisa con el NIF nuevo (prefijo UE).
    const pais = paisTrasModificar(existe, data.pais, d.nifCif);
    const cambios = {
      ...(d.nombreFiscal !== undefined ? { nombreFiscal: d.nombreFiscal } : {}),
      ...(d.nifCif !== undefined ? { nifCif: d.nifCif } : {}),
      ...(data.email !== undefined ? { email: d.email } : {}),
      ...(data.telefono !== undefined || data.telefono1 !== undefined ? { telefono: d.telefono } : {}),
      ...leerDireccion(data),
      ...(pais !== undefined ? { pais } : {}),
      ...(data.monedaPreferida !== undefined ? { monedaPreferida: leerMonedaPreferida(data.monedaPreferida) } : {}),
    };
    const c = (await prisma.$transaction(async (tx) => {
      // Las facturas anteriores conservan la clasificacion con el pais de antes.
      if (pais !== undefined) await congelarPaisFacturasAnteriores(tx, String(companyId), String(id), existe.pais);
      return tx.customer.update({ where: { id: String(id) }, data: cambios });
    })) as CustomerRow;
    return aCliente(c) as unknown as Cliente;
  },

  async remove(companyId: ID, id: ID): Promise<void> {
    const existe = await prisma.customer.findFirst({ where: { id: String(id), companyId: String(companyId) } });
    if (!existe) throw notFound('Cliente no encontrado.');
    await prisma.customer.delete({ where: { id: String(id) } });
  },
};
