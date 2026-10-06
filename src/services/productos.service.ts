/**
 * Catalogo de productos y servicios, organizado por familias con codigo, para
 * rellenar las lineas de las facturas (descripcion, precio, IVA, unidad y
 * cuenta de ventas).
 *
 * Mantiene la forma de respuesta antigua del recurso (idproducto, stockfis) por
 * compatibilidad.
 */
import { prisma } from '../config/database';
import { CompanyScopedService, ID, Paginated } from '../domain/common.types';
import { Producto } from '../domain/producto.model';
import { parsePagination } from '../utils/pagination';
import { badRequest, notFound } from '../utils/http-errors';
import { leerFilasArchivo, normalizar } from './extractoBancario.service';
import { leerImporte } from './extractoBancario.service';

type ProductRow = {
  id: string;
  referencia: string;
  descripcion: string | null;
  precio: number;
  stock: number;
  bloqueado: boolean;
  tipo: string;
  unidad: string;
  ivaPorcentaje: number;
  precioCompra: number | null;
  cuentaVentas: string | null;
  notas: string | null;
  familiaId: string | null;
  familia?: { id: string; codigo: string; nombre: string; cuentaVentas: string | null } | null;
};

/** Product (Prisma) -> respuesta del recurso productos. */
function aProducto(p: ProductRow): Record<string, unknown> {
  return {
    id: p.id,
    idproducto: p.id,
    referencia: p.referencia,
    descripcion: p.descripcion ?? '',
    precio: p.precio,
    stock: p.stock,
    stockfis: p.stock,
    bloqueado: p.bloqueado,
    tipo: p.tipo,
    unidad: p.unidad,
    ivaPorcentaje: p.ivaPorcentaje,
    precioCompra: p.precioCompra,
    cuentaVentas: p.cuentaVentas,
    // Cuenta con la que se contabiliza: la del producto, la de su familia o la estandar.
    cuentaVentasEfectiva: p.cuentaVentas || p.familia?.cuentaVentas || (p.tipo === 'SERVICIO' ? '705' : '700'),
    notas: p.notas,
    familiaId: p.familiaId,
    familia: p.familia ? { id: p.familia.id, codigo: p.familia.codigo, nombre: p.familia.nombre } : null,
  };
}

const TIPOS = ['PRODUCTO', 'SERVICIO'];
const UNIDADES = ['ud', 'h', 'kg', 'g', 'l', 'm', 'm2', 'm3', 'día', 'mes', 'km', 'servicio'];

function numero(v: unknown, campo: string, { min = 0, max = 1e9, opcional = false } = {}): number | null {
  if (v === null || v === undefined || v === '') {
    if (opcional) return null;
    return 0;
  }
  const n = typeof v === 'number' ? v : leerImporte(v);
  if (n === null || !Number.isFinite(n) || n < min || n > max) throw badRequest(`${campo} no es válido.`);
  return n;
}

function cuenta(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  const c = String(v).trim();
  if (!/^7\d{2,9}$/.test(c)) throw badRequest('La cuenta de ventas tiene que ser del grupo 7 (por ejemplo 700, 705 o 7000001).');
  return c;
}

/** Valida y limpia los datos de un producto (solo los campos conocidos). */
async function datosProducto(companyId: string, data: Record<string, unknown>, parcial: boolean) {
  const out: Record<string, unknown> = {};
  if (!parcial || data.referencia !== undefined) {
    const referencia = String(data.referencia ?? '').trim().slice(0, 50);
    if (!referencia) throw badRequest('El código del producto es obligatorio.');
    out.referencia = referencia;
  }
  if (!parcial || data.descripcion !== undefined) {
    const descripcion = String(data.descripcion ?? '').trim().slice(0, 500);
    if (!descripcion) throw badRequest('La descripción es obligatoria: es lo que sale en la factura.');
    out.descripcion = descripcion;
  }
  if (data.precio !== undefined || !parcial) out.precio = numero(data.precio, 'El precio');
  if (data.precioCompra !== undefined) out.precioCompra = numero(data.precioCompra, 'El precio de compra', { opcional: true });
  if (data.ivaPorcentaje !== undefined) out.ivaPorcentaje = numero(data.ivaPorcentaje, 'El IVA', { max: 100 });
  if (data.stockfis !== undefined || data.stock !== undefined) out.stock = numero(data.stockfis ?? data.stock, 'El stock', { min: -1e9 });
  if (data.bloqueado !== undefined) out.bloqueado = data.bloqueado === true;
  if (data.tipo !== undefined) {
    const tipo = String(data.tipo).toUpperCase();
    if (!TIPOS.includes(tipo)) throw badRequest('El tipo tiene que ser PRODUCTO o SERVICIO.');
    out.tipo = tipo;
  }
  if (data.unidad !== undefined) {
    const unidad = String(data.unidad).trim().toLowerCase().slice(0, 15) || 'ud';
    out.unidad = unidad;
  }
  if (data.cuentaVentas !== undefined) out.cuentaVentas = cuenta(data.cuentaVentas);
  if (data.notas !== undefined) out.notas = data.notas ? String(data.notas).slice(0, 2000) : null;
  if (data.familiaId !== undefined) {
    if (!data.familiaId) out.familiaId = null;
    else {
      const f = await prisma.productFamily.findFirst({ where: { id: String(data.familiaId), companyId } });
      if (!f) throw badRequest('La familia no existe.');
      out.familiaId = f.id;
      // Un producto nuevo de la familia toma su IVA si no se indica otro.
      if (!parcial && data.ivaPorcentaje === undefined && f.ivaPorcentaje !== null) out.ivaPorcentaje = Number(f.ivaPorcentaje);
    }
  }
  return out;
}

async function codigoRepetido(companyId: string, referencia: unknown, excepto?: string) {
  if (referencia === undefined) return;
  const otro = await prisma.product.findFirst({ where: { companyId, referencia: String(referencia), ...(excepto && { NOT: { id: excepto } }) } });
  if (otro) throw badRequest(`Ya hay un producto con el código ${referencia}.`);
}

const INCLUIR = { familia: { select: { id: true, codigo: true, nombre: true, cuentaVentas: true } } };

export const productosService: CompanyScopedService<Producto> = {
  async list(companyId: ID, params: Record<string, unknown> = {}): Promise<Paginated<Producto>> {
    const { limit, offset } = parsePagination(params);
    const where: Record<string, unknown> = { companyId: String(companyId) };
    const q = String(params.q ?? params.referencia ?? '').trim();
    if (q) where.OR = [{ referencia: { contains: q } }, { descripcion: { contains: q } }];
    if (params.familiaId) {
      // La familia y sus subfamilias.
      const hijas = await prisma.productFamily.findMany({ where: { companyId: String(companyId), parentId: String(params.familiaId) }, select: { id: true } });
      where.familiaId = { in: [String(params.familiaId), ...hijas.map((h) => h.id)] };
    }
    if (params.activos === 'true' || params.activos === true) where.bloqueado = false;
    const [items, total] = await Promise.all([
      prisma.product.findMany({ where, skip: offset, take: limit, orderBy: { referencia: 'asc' }, include: INCLUIR }),
      prisma.product.count({ where }),
    ]);
    return { items: (items as unknown as ProductRow[]).map(aProducto) as unknown as Producto[], total, limit, offset };
  },

  async getById(companyId: ID, id: ID): Promise<Producto> {
    const p = await prisma.product.findFirst({ where: { id: String(id), companyId: String(companyId) }, include: INCLUIR });
    if (!p) throw notFound('Producto no encontrado.');
    return aProducto(p as unknown as ProductRow) as unknown as Producto;
  },

  async create(companyId: ID, data: Record<string, unknown>): Promise<Producto> {
    const datos = await datosProducto(String(companyId), data ?? {}, false);
    await codigoRepetido(String(companyId), datos.referencia);
    const p = await prisma.product.create({ data: { companyId: String(companyId), ...datos } as never, include: INCLUIR });
    return aProducto(p as unknown as ProductRow) as unknown as Producto;
  },

  async update(companyId: ID, id: ID, data: Record<string, unknown>): Promise<Producto> {
    const existe = await prisma.product.findFirst({ where: { id: String(id), companyId: String(companyId) } });
    if (!existe) throw notFound('Producto no encontrado.');
    const datos = await datosProducto(String(companyId), data ?? {}, true);
    await codigoRepetido(String(companyId), datos.referencia, String(id));
    const p = await prisma.product.update({ where: { id: String(id) }, data: datos as never, include: INCLUIR });
    return aProducto(p as unknown as ProductRow) as unknown as Producto;
  },

  /** Si el producto ya se ha usado en facturas, se da de baja en vez de borrarlo. */
  async remove(companyId: ID, id: ID): Promise<void> {
    const existe = await prisma.product.findFirst({ where: { id: String(id), companyId: String(companyId) } });
    if (!existe) throw notFound('Producto no encontrado.');
    const usado = await prisma.incomeInvoiceLine.count({ where: { productoServicioId: String(id) } });
    if (usado > 0) {
      await prisma.product.update({ where: { id: String(id) }, data: { bloqueado: true } });
      return;
    }
    await prisma.product.delete({ where: { id: String(id) } });
  },
};

/**
 * Siguiente codigo libre: el codigo de la familia seguido de un numero de 3
 * cifras (familia 01 -> 01001, 01002...). Sin familia, P0001, P0002...
 */
export async function siguienteCodigo(companyId: string, familiaId?: string): Promise<string> {
  const familia = familiaId ? await prisma.productFamily.findFirst({ where: { id: familiaId, companyId } }) : null;
  const prefijo = familia ? familia.codigo : 'P';
  const cifras = familia ? 3 : 4;
  const usados = new Set(
    (await prisma.product.findMany({ where: { companyId, referencia: { startsWith: prefijo } }, select: { referencia: true } })).map((p) => p.referencia),
  );
  for (let n = 1; n < 10 ** cifras; n++) {
    const codigo = `${prefijo}${String(n).padStart(cifras, '0')}`;
    if (!usados.has(codigo)) return codigo;
  }
  return `${prefijo}${Date.now()}`;
}

// --- Familias ---

export async function listarFamilias(companyId: string) {
  const filas = await prisma.productFamily.findMany({
    where: { companyId },
    orderBy: { codigo: 'asc' },
    include: { _count: { select: { productos: true } } },
  });
  const nodo = (f: (typeof filas)[number]) => ({
    id: f.id,
    codigo: f.codigo,
    nombre: f.nombre,
    ivaPorcentaje: f.ivaPorcentaje === null ? null : Number(f.ivaPorcentaje),
    cuentaVentas: f.cuentaVentas,
    activa: f.activa,
    parentId: f.parentId,
    productos: f._count.productos,
    hijas: [] as unknown[],
  });
  const porId = new Map(filas.map((f) => [f.id, nodo(f)]));
  const raices: ReturnType<typeof nodo>[] = [];
  for (const f of filas) {
    const n = porId.get(f.id)!;
    const padre = f.parentId ? porId.get(f.parentId) : undefined;
    if (padre) padre.hijas.push(n);
    else raices.push(n);
  }
  return raices;
}

async function datosFamilia(companyId: string, data: Record<string, unknown>, parcial: boolean, id?: string) {
  const out: Record<string, unknown> = {};
  if (!parcial || data.codigo !== undefined) {
    const codigo = String(data.codigo ?? '').trim().toUpperCase().slice(0, 20);
    if (!/^[A-Z0-9][A-Z0-9-]*$/.test(codigo)) throw badRequest('El código de la familia lleva letras o números (por ejemplo 01 o BEB).');
    const otra = await prisma.productFamily.findFirst({ where: { companyId, codigo, ...(id && { NOT: { id } }) } });
    if (otra) throw badRequest(`Ya hay una familia con el código ${codigo}.`);
    out.codigo = codigo;
  }
  if (!parcial || data.nombre !== undefined) {
    const nombre = String(data.nombre ?? '').trim().slice(0, 100);
    if (!nombre) throw badRequest('Escribe el nombre de la familia.');
    out.nombre = nombre;
  }
  if (data.ivaPorcentaje !== undefined) out.ivaPorcentaje = numero(data.ivaPorcentaje, 'El IVA', { max: 100, opcional: true });
  if (data.cuentaVentas !== undefined) out.cuentaVentas = cuenta(data.cuentaVentas);
  if (data.activa !== undefined) out.activa = Boolean(data.activa);
  if (!parcial && data.parentId) {
    const padre = await prisma.productFamily.findFirst({ where: { id: String(data.parentId), companyId } });
    if (!padre) throw badRequest('La familia padre no existe.');
    if (padre.parentId) throw badRequest('Las subfamilias no pueden tener a su vez subfamilias.');
    out.parentId = padre.id;
  }
  return out;
}

export async function crearFamilia(companyId: string, data: Record<string, unknown>) {
  return prisma.productFamily.create({ data: { companyId, ...(await datosFamilia(companyId, data ?? {}, false)) } as never });
}

export async function actualizarFamilia(companyId: string, id: string, data: Record<string, unknown>) {
  if (!(await prisma.productFamily.findFirst({ where: { id, companyId } }))) throw notFound('Familia no encontrada.');
  return prisma.productFamily.update({ where: { id }, data: (await datosFamilia(companyId, data ?? {}, true, id)) as never });
}

/** Solo se borra una familia sin productos ni subfamilias. */
export async function borrarFamilia(companyId: string, id: string) {
  const f = await prisma.productFamily.findFirst({ where: { id, companyId }, include: { _count: { select: { productos: true, hijas: true } } } });
  if (!f) throw notFound('Familia no encontrada.');
  if (f._count.productos > 0 || f._count.hijas > 0) {
    throw badRequest('La familia tiene productos o subfamilias: muévelos antes o desactívala.');
  }
  await prisma.productFamily.delete({ where: { id } });
}

// --- Importacion desde Excel o CSV ---

type CampoProducto = 'referencia' | 'descripcion' | 'familia' | 'precio' | 'iva' | 'unidad' | 'tipo' | 'precioCompra' | 'cuentaVentas';

function campoDeCabecera(titulo: unknown): CampoProducto | null {
  const t = normalizar(titulo);
  if (!t) return null;
  if (/^(codigo|cod|referencia|ref|sku|articulo)$/.test(t) || /^codigo (de )?(producto|articulo)/.test(t)) return 'referencia';
  if (/descripcion|^nombre|^producto$|^concepto/.test(t)) return 'descripcion';
  if (/familia|categoria|grupo/.test(t)) return 'familia';
  if (/compra|coste|costo/.test(t)) return 'precioCompra';
  if (/^(precio|pvp|tarifa|importe|precio venta|precio de venta)/.test(t)) return 'precio';
  if (/iva|impuesto/.test(t)) return 'iva';
  if (/unidad|^ud$|medida/.test(t)) return 'unidad';
  if (/^tipo/.test(t)) return 'tipo';
  if (/cuenta/.test(t)) return 'cuentaVentas';
  return null;
}

export interface FilaProductoImportada {
  fila: number;
  referencia: string;
  descripcion: string;
  familia?: string;
  precio: number;
  ivaPorcentaje?: number;
  unidad?: string;
  tipo?: string;
  precioCompra?: number | null;
  cuentaVentas?: string | null;
}

export function leerProductosArchivo(contenido: Buffer, nombre: string) {
  const { filas } = leerFilasArchivo(contenido, nombre);
  let cab = -1;
  let columnas: Partial<Record<CampoProducto, number>> = {};
  for (let i = 0; i < Math.min(filas.length, 20); i++) {
    const cols: Partial<Record<CampoProducto, number>> = {};
    filas[i].forEach((c, j) => {
      const campo = campoDeCabecera(c);
      if (campo && cols[campo] === undefined) cols[campo] = j;
    });
    if (cols.referencia !== undefined && cols.descripcion !== undefined) {
      cab = i;
      columnas = cols;
      break;
    }
  }
  if (cab < 0) throw badRequest('No encuentro la fila de títulos: hacen falta al menos las columnas «Código» y «Descripción».');

  const productos: FilaProductoImportada[] = [];
  const errores: string[] = [];
  const vistos = new Set<string>();
  for (let i = cab + 1; i < filas.length; i++) {
    const f = filas[i];
    const val = (c?: number) => (c === undefined ? '' : String(f?.[c] ?? '').trim());
    const referencia = val(columnas.referencia);
    const descripcion = val(columnas.descripcion);
    if (!referencia && !descripcion) continue;
    const n = i + 1;
    if (!referencia) errores.push(`fila ${n}: falta el código`);
    if (!descripcion) errores.push(`fila ${n}: falta la descripción`);
    if (referencia && vistos.has(referencia)) errores.push(`fila ${n}: el código ${referencia} está repetido en el fichero`);
    vistos.add(referencia);
    const importe = (c?: number) => (c === undefined || val(c) === '' ? null : leerImporte(f?.[c]));
    const precio = importe(columnas.precio);
    // "10%", "10 %" o "IVA 10": se quita lo que no es numero.
    const iva = columnas.iva === undefined || val(columnas.iva) === '' ? null : typeof f?.[columnas.iva] === 'number' ? (f[columnas.iva] as number) : leerImporte(val(columnas.iva).replace(/%|iva/gi, '').trim());
    const precioCompra = importe(columnas.precioCompra);
    if (precio !== null && (Number.isNaN(precio) || precio < 0)) errores.push(`fila ${n}: precio no válido`);
    if (iva !== null && (Number.isNaN(iva) || iva < 0 || iva > 100)) errores.push(`fila ${n}: IVA no válido`);
    const tipoTxt = normalizar(val(columnas.tipo));
    productos.push({
      fila: n,
      referencia: referencia.slice(0, 50),
      descripcion: descripcion.slice(0, 500),
      familia: val(columnas.familia) || undefined,
      precio: precio ?? 0,
      // "21%" o "0,21": se acepta en porcentaje o en tanto por uno.
      ivaPorcentaje: iva === null ? undefined : iva > 0 && iva < 1 ? Math.round(iva * 10000) / 100 : iva,
      unidad: val(columnas.unidad) || undefined,
      tipo: tipoTxt.startsWith('serv') ? 'SERVICIO' : tipoTxt ? 'PRODUCTO' : undefined,
      precioCompra: precioCompra === null || Number.isNaN(precioCompra) ? null : precioCompra,
      cuentaVentas: val(columnas.cuentaVentas) || null,
    });
  }
  if (errores.length) {
    throw badRequest(`El fichero tiene filas que no se pueden leer; no se ha importado nada. ${errores.slice(0, 10).join('; ')}${errores.length > 10 ? `; y ${errores.length - 10} más` : ''}`);
  }
  if (!productos.length) throw badRequest('El fichero no tiene productos.');
  return productos;
}

/**
 * Importa (o actualiza, si el codigo ya existe) los productos de un Excel o
 * CSV. Las familias se buscan por codigo o nombre y, si no existen, se crean.
 */
export async function importarProductos(companyId: string, contenido: Buffer, nombre: string, vistaPrevia = false) {
  const filas = leerProductosArchivo(contenido, nombre);
  const existentes = new Set(
    (await prisma.product.findMany({ where: { companyId, referencia: { in: filas.map((f) => f.referencia) } }, select: { referencia: true } })).map((p) => p.referencia),
  );
  const familias = await prisma.productFamily.findMany({ where: { companyId } });
  const buscarFamilia = (t: string) => familias.find((f) => f.codigo === t.toUpperCase() || normalizar(f.nombre) === normalizar(t));
  const nuevasFamilias = [...new Set(filas.map((f) => f.familia).filter((t): t is string => Boolean(t) && !buscarFamilia(t!)))];
  for (const f of filas) if (f.cuentaVentas) cuenta(f.cuentaVentas);

  const resumen = {
    total: filas.length,
    nuevos: filas.filter((f) => !existentes.has(f.referencia)).length,
    actualizados: filas.filter((f) => existentes.has(f.referencia)).length,
    familiasNuevas: nuevasFamilias,
  };
  if (vistaPrevia) return { ...resumen, muestra: filas.slice(0, 15) };

  for (const nombreFamilia of nuevasFamilias) {
    const base = normalizar(nombreFamilia).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'FAM';
    let codigo = base;
    for (let n = 2; familias.some((f) => f.codigo === codigo); n++) codigo = `${base}${n}`;
    familias.push(await prisma.productFamily.create({ data: { companyId, codigo, nombre: nombreFamilia.slice(0, 100) } }));
  }

  for (const f of filas) {
    const familia = f.familia ? buscarFamilia(f.familia) : undefined;
    const datos = {
      descripcion: f.descripcion,
      precio: f.precio,
      ...(f.ivaPorcentaje !== undefined ? { ivaPorcentaje: f.ivaPorcentaje } : familia?.ivaPorcentaje != null ? { ivaPorcentaje: Number(familia.ivaPorcentaje) } : {}),
      ...(f.unidad && { unidad: f.unidad.toLowerCase().slice(0, 15) }),
      ...(f.tipo && { tipo: f.tipo }),
      ...(f.precioCompra !== null && f.precioCompra !== undefined && { precioCompra: f.precioCompra }),
      ...(f.cuentaVentas && { cuentaVentas: f.cuentaVentas }),
      ...(familia && { familiaId: familia.id }),
    };
    await prisma.product.upsert({
      where: { companyId_referencia: { companyId, referencia: f.referencia } },
      update: datos,
      create: { companyId, referencia: f.referencia, ...datos },
    });
  }
  return resumen;
}

export const UNIDADES_SUGERIDAS = UNIDADES;
