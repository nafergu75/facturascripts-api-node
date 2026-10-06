// Tesoreria analitica: categorias de cobros y pagos y categorizacion de los
// movimientos del banco.
//
// Las categorias NO son cuentas contables: sirven para ver en que entra y sale
// el dinero y para la prevision. Un cobro (importe > 0) va a una categoria de
// INGRESO y un pago (importe < 0), a una de GASTO.
//
// El desglose reparte un movimiento en varias categorias sin tocar el
// movimiento original (el cuadre de bancos y la conciliacion siguen viendo uno).
import { prisma } from '../config/database';
import { badRequest, notFound } from '../utils/http-errors';
import { aCentimos } from '../utils/money';

export type TipoCategoria = 'INGRESO' | 'GASTO';

interface PlantillaCategoria {
  nombre: string;
  color: string;
  hijas?: string[];
}

/** Categorias con las que empieza cada empresa (se pueden cambiar todas). */
const PLANTILLA: Record<TipoCategoria, PlantillaCategoria[]> = {
  INGRESO: [
    { nombre: 'Ventas', color: '#16a34a' },
    { nombre: 'Financiación', color: '#4f46e5', hijas: ['Préstamos recibidos', 'Aportaciones de socios'] },
    { nombre: 'Subvenciones', color: '#0d9488' },
    { nombre: 'Otros ingresos', color: '#0891b2' },
  ],
  GASTO: [
    { nombre: 'Proveedores', color: '#ca8a04' },
    { nombre: 'Marketing', color: '#0ea5e9', hijas: ['Publicidad', 'Herramientas y software', 'Eventos y ferias'] },
    { nombre: 'Comercial', color: '#2563eb' },
    { nombre: 'Informática', color: '#dc2626' },
    { nombre: 'Operación', color: '#7c3aed', hijas: ['Alquiler', 'Suministros', 'Telefonía e internet', 'Mantenimiento'] },
    { nombre: 'RRHH / Retribuciones', color: '#db2777', hijas: ['Nóminas', 'Seguridad Social'] },
    { nombre: 'Gastos de gestión', color: '#9333ea', hijas: ['Asesoría', 'Comisiones bancarias'] },
    { nombre: 'Impuestos y seguros', color: '#64748b', hijas: ['IVA', 'IRPF', 'Impuesto de Sociedades', 'Seguros'] },
    { nombre: 'Reembolso de préstamos', color: '#059669' },
  ],
};

export function tipoDeImporte(importe: number): TipoCategoria {
  return importe >= 0 ? 'INGRESO' : 'GASTO';
}

// --- Categorias ---

export interface CategoriaArbol {
  id: string;
  tipo: TipoCategoria;
  nombre: string;
  color: string;
  ivaPorcentaje: number | null;
  activa: boolean;
  parentId: string | null;
  hijas: CategoriaArbol[];
}

/** Crea la plantilla si la empresa aun no tiene categorias. */
export async function asegurarCategorias(companyId: string): Promise<void> {
  if ((await prisma.treasuryCategory.count({ where: { companyId } })) > 0) return;
  for (const tipo of ['INGRESO', 'GASTO'] as const) {
    let orden = 0;
    for (const c of PLANTILLA[tipo]) {
      const padre = await prisma.treasuryCategory.create({ data: { companyId, tipo, nombre: c.nombre, color: c.color, orden: orden++ } });
      let ordenHija = 0;
      for (const h of c.hijas ?? []) {
        await prisma.treasuryCategory.create({
          data: { companyId, tipo, nombre: h, color: c.color, parentId: padre.id, orden: ordenHija++ },
        });
      }
    }
  }
}

export async function listarCategorias(companyId: string): Promise<CategoriaArbol[]> {
  await asegurarCategorias(companyId);
  const filas = await prisma.treasuryCategory.findMany({ where: { companyId }, orderBy: [{ orden: 'asc' }, { createdAt: 'asc' }] });
  const nodo = (f: (typeof filas)[number]): CategoriaArbol => ({
    id: f.id,
    tipo: f.tipo as TipoCategoria,
    nombre: f.nombre,
    color: f.color,
    ivaPorcentaje: f.ivaPorcentaje === null ? null : Number(f.ivaPorcentaje),
    activa: f.activa,
    parentId: f.parentId,
    hijas: [],
  });
  const porId = new Map(filas.map((f) => [f.id, nodo(f)]));
  const raices: CategoriaArbol[] = [];
  for (const f of filas) {
    const n = porId.get(f.id)!;
    const padre = f.parentId ? porId.get(f.parentId) : undefined;
    if (padre) padre.hijas.push(n);
    else raices.push(n);
  }
  return raices;
}

async function categoriaDeEmpresa(companyId: string, id: string) {
  const c = await prisma.treasuryCategory.findFirst({ where: { id, companyId } });
  if (!c) throw notFound('Categoría no encontrada.');
  return c;
}

const COLOR = /^#[0-9a-f]{6}$/i;

function limpiarIva(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw badRequest('El IVA tiene que ser un porcentaje entre 0 y 100.');
  return n;
}

export async function crearCategoria(
  companyId: string,
  datos: { tipo?: string; nombre?: string; color?: string; parentId?: string | null; ivaPorcentaje?: unknown },
) {
  const nombre = String(datos.nombre ?? '').trim().slice(0, 80);
  if (!nombre) throw badRequest('Escribe el nombre de la categoría.');
  let tipo = String(datos.tipo ?? '').toUpperCase() as TipoCategoria;
  let color = String(datos.color ?? '').trim();
  let parentId: string | null = null;
  if (datos.parentId) {
    const padre = await categoriaDeEmpresa(companyId, datos.parentId);
    if (padre.parentId) throw badRequest('Las subcategorías no pueden tener a su vez subcategorías.');
    tipo = padre.tipo as TipoCategoria;
    parentId = padre.id;
    if (!color) color = padre.color;
  }
  if (tipo !== 'INGRESO' && tipo !== 'GASTO') throw badRequest('El tipo tiene que ser INGRESO o GASTO.');
  if (!COLOR.test(color)) color = tipo === 'INGRESO' ? '#16a34a' : '#64748b';
  const repetida = await prisma.treasuryCategory.findFirst({ where: { companyId, tipo, parentId, nombre } });
  if (repetida) throw badRequest(`Ya hay una categoría «${nombre}» en ese nivel.`);
  const orden = await prisma.treasuryCategory.count({ where: { companyId, tipo, parentId } });
  return prisma.treasuryCategory.create({
    data: { companyId, tipo, nombre, color, parentId, orden, ivaPorcentaje: limpiarIva(datos.ivaPorcentaje) ?? null },
  });
}

export async function actualizarCategoria(
  companyId: string,
  id: string,
  datos: { nombre?: string; color?: string; ivaPorcentaje?: unknown; activa?: boolean },
) {
  const c = await categoriaDeEmpresa(companyId, id);
  const data: { nombre?: string; color?: string; ivaPorcentaje?: number | null; activa?: boolean } = {};
  if (datos.nombre !== undefined) {
    const nombre = String(datos.nombre).trim().slice(0, 80);
    if (!nombre) throw badRequest('El nombre no puede quedar vacío.');
    const repetida = await prisma.treasuryCategory.findFirst({
      where: { companyId, tipo: c.tipo, parentId: c.parentId, nombre, NOT: { id } },
    });
    if (repetida) throw badRequest(`Ya hay una categoría «${nombre}» en ese nivel.`);
    data.nombre = nombre;
  }
  if (datos.color !== undefined) {
    if (!COLOR.test(String(datos.color))) throw badRequest('El color tiene que ser un código como #16a34a.');
    data.color = String(datos.color);
  }
  const iva = limpiarIva(datos.ivaPorcentaje);
  if (iva !== undefined) data.ivaPorcentaje = iva;
  if (datos.activa !== undefined) data.activa = Boolean(datos.activa);
  return prisma.treasuryCategory.update({ where: { id }, data });
}

/**
 * Borra la categoria si no se ha usado; si tiene movimientos, se archiva
 * (deja de ofrecerse, pero el historico se conserva).
 */
export async function borrarCategoria(companyId: string, id: string): Promise<{ borrada: boolean; archivada: boolean }> {
  await categoriaDeEmpresa(companyId, id);
  const ids = [id, ...(await prisma.treasuryCategory.findMany({ where: { parentId: id }, select: { id: true } })).map((h) => h.id)];
  const usos =
    (await prisma.bankMovement.count({ where: { categoriaId: { in: ids } } })) +
    (await prisma.bankMovementSplit.count({ where: { categoriaId: { in: ids } } }));
  if (usos > 0) {
    await prisma.treasuryCategory.updateMany({ where: { id: { in: ids } }, data: { activa: false } });
    return { borrada: false, archivada: true };
  }
  await prisma.treasuryCategory.delete({ where: { id } });
  return { borrada: true, archivada: false };
}

// --- Concepto parecido ---

const PALABRAS_VACIAS = new Set([
  'recibo', 'recib', 'transferencia', 'transf', 'trf', 'pago', 'pagos', 'cargo', 'abono', 'compra', 'compras', 'tarjeta',
  'tarj', 'tj', 'sepa', 'domiciliado', 'domiciliacion', 'adeudo', 'ref', 'referencia', 'concepto', 'fecha', 'num', 'favor',
  'de', 'del', 'la', 'las', 'el', 'los', 'en', 'por', 'para', 'con', 'sl', 'slu', 'sa', 'sll', 'cb', 'emitida', 'recibida',
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
  'ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic',
]);

/**
 * Clave para reconocer movimientos del mismo tipo: «RECIBO AGUA 03/26
 * REF.4471» y «Agua mayo» dan «agua». Sin numeros, fechas ni palabras de
 * relleno de los bancos; hasta tres palabras. Vacia si no queda nada util.
 */
export function claveConcepto(concepto: string): string {
  return String(concepto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((p) => p.length >= 3 && !PALABRAS_VACIAS.has(p))
    .slice(0, 3)
    .join(' ');
}

// --- Movimientos ---

async function movimientoDeEmpresa(companyId: string, id: string) {
  const m = await prisma.bankMovement.findFirst({ where: { id, companyId }, include: { partes: true } });
  if (!m) throw notFound('Movimiento no encontrado.');
  return m;
}

async function validarCategoriaPara(companyId: string, categoriaId: string, importe: number) {
  const c = await categoriaDeEmpresa(companyId, categoriaId);
  if (!c.activa) throw badRequest('Esa categoría está archivada.');
  const tipo = tipoDeImporte(importe);
  if (c.tipo !== tipo) {
    throw badRequest(tipo === 'INGRESO' ? 'Un cobro va a una categoría de ingresos.' : 'Un pago va a una categoría de gastos.');
  }
  return c;
}

/** Movimientos sin categoria, sin ignorar y sin desglosar con la misma clave y signo. */
async function similaresSinCategoria(companyId: string, mov: { id: string; concepto: string; importe: number }) {
  const clave = claveConcepto(mov.concepto);
  if (!clave) return { clave, ids: [] as string[] };
  const candidatos = await prisma.bankMovement.findMany({
    where: {
      companyId,
      categoriaId: null,
      ignorado: false,
      id: { not: mov.id },
      importe: mov.importe >= 0 ? { gte: 0 } : { lt: 0 },
      partes: { none: {} },
    },
    select: { id: true, concepto: true },
    take: 5000,
  });
  return { clave, ids: candidatos.filter((c) => claveConcepto(c.concepto) === clave).map((c) => c.id) };
}

/**
 * Asigna (o quita, con null) la categoria de un movimiento. Devuelve cuantos
 * movimientos sin categoria se parecen, para ofrecer asignarles la misma.
 */
export async function categorizarMovimiento(
  companyId: string,
  id: string,
  datos: { categoriaId?: string | null; ivaPorcentaje?: unknown },
) {
  const mov = await movimientoDeEmpresa(companyId, id);
  if (mov.partes.length) throw badRequest('Este movimiento está desglosado: cambia la categoría de cada parte.');
  const categoriaId = datos.categoriaId || null;
  let ivaPorcentaje = limpiarIva(datos.ivaPorcentaje);
  if (categoriaId) {
    const c = await validarCategoriaPara(companyId, categoriaId, Number(mov.importe));
    if (ivaPorcentaje === undefined && c.ivaPorcentaje !== null) ivaPorcentaje = Number(c.ivaPorcentaje);
  }
  const actualizado = await prisma.bankMovement.update({
    where: { id },
    data: { categoriaId, ...(ivaPorcentaje !== undefined && { ivaPorcentaje }) },
  });
  const sim = categoriaId ? await similaresSinCategoria(companyId, { id, concepto: mov.concepto, importe: Number(mov.importe) }) : { clave: '', ids: [] };
  return { movimiento: actualizado, similares: sim.ids.length, clave: sim.clave };
}

/**
 * Da a los movimientos parecidos la categoria de este y, si `recordar`, guarda
 * la regla para los proximos extractos.
 */
export async function aplicarASimilares(companyId: string, id: string, recordar = true) {
  const mov = await movimientoDeEmpresa(companyId, id);
  if (!mov.categoriaId) throw badRequest('Primero asigna una categoría a este movimiento.');
  const { clave, ids } = await similaresSinCategoria(companyId, { id, concepto: mov.concepto, importe: Number(mov.importe) });
  if (ids.length) {
    await prisma.bankMovement.updateMany({
      where: { id: { in: ids }, companyId },
      data: { categoriaId: mov.categoriaId, ...(mov.ivaPorcentaje !== null && { ivaPorcentaje: mov.ivaPorcentaje }) },
    });
  }
  if (recordar && clave) {
    const tipo = tipoDeImporte(Number(mov.importe));
    await prisma.treasuryCategoryRule.upsert({
      where: { companyId_tipo_clave: { companyId, tipo, clave } },
      update: { categoriaId: mov.categoriaId },
      create: { companyId, tipo, clave, categoriaId: mov.categoriaId },
    });
  }
  return { actualizados: ids.length, clave, reglaGuardada: Boolean(recordar && clave) };
}

/** Categoriza con las reglas guardadas los movimientos recien importados. */
export async function aplicarReglas(companyId: string, movimientos: Array<{ id: string; concepto: string; importe: number }>) {
  if (!movimientos.length) return 0;
  const reglas = await prisma.treasuryCategoryRule.findMany({ where: { companyId }, include: { categoria: true } });
  if (!reglas.length) return 0;
  const porClave = new Map(reglas.filter((r) => r.categoria.activa).map((r) => [`${r.tipo}|${r.clave}`, r.categoriaId]));
  let n = 0;
  for (const m of movimientos) {
    const categoriaId = porClave.get(`${tipoDeImporte(m.importe)}|${claveConcepto(m.concepto)}`);
    if (!categoriaId) continue;
    await prisma.bankMovement.update({ where: { id: m.id }, data: { categoriaId } });
    n++;
  }
  return n;
}

export async function ignorarMovimiento(companyId: string, id: string, ignorado: boolean) {
  await movimientoDeEmpresa(companyId, id);
  return prisma.bankMovement.update({ where: { id }, data: { ignorado: Boolean(ignorado) } });
}

export interface ParteDesglose {
  importe: number;
  categoriaId?: string | null;
  ivaPorcentaje?: unknown;
  concepto?: string;
}

/**
 * Reparte un movimiento en varias partes. Tienen que sumar exactamente su
 * importe (al centimo) y tener su mismo signo. Sustituye un desglose anterior.
 */
export async function desglosarMovimiento(companyId: string, id: string, partes: ParteDesglose[]) {
  const mov = await movimientoDeEmpresa(companyId, id);
  const total = Number(mov.importe);
  if (!Array.isArray(partes) || partes.length < 2) throw badRequest('Un desglose tiene al menos dos partes.');
  if (partes.length > 20) throw badRequest('Como mucho 20 partes.');
  const limpias = [];
  for (const p of partes) {
    const importe = Number(p.importe);
    if (!Number.isFinite(importe) || importe === 0) throw badRequest('Cada parte necesita un importe distinto de cero.');
    if (Math.sign(importe) !== Math.sign(total)) throw badRequest('Las partes tienen que tener el mismo signo que el movimiento.');
    if (p.categoriaId) await validarCategoriaPara(companyId, p.categoriaId, total);
    limpias.push({
      importe,
      categoriaId: p.categoriaId || null,
      ivaPorcentaje: limpiarIva(p.ivaPorcentaje) ?? null,
      concepto: p.concepto ? String(p.concepto).slice(0, 200) : null,
    });
  }
  const suma = limpias.reduce((t, p) => t + aCentimos(p.importe), 0);
  if (suma !== aCentimos(total)) {
    throw badRequest(`Las partes suman ${(suma / 100).toFixed(2)} y el movimiento es de ${total.toFixed(2)}.`);
  }
  await prisma.$transaction([
    prisma.bankMovementSplit.deleteMany({ where: { movementId: id } }),
    ...limpias.map((p) => prisma.bankMovementSplit.create({ data: { movementId: id, ...p } })),
    // La categoria del movimiento entero deja de valer: la tiene cada parte.
    prisma.bankMovement.update({ where: { id }, data: { categoriaId: null } }),
  ]);
  return movimientoDeEmpresa(companyId, id);
}

export async function deshacerDesglose(companyId: string, id: string) {
  await movimientoDeEmpresa(companyId, id);
  await prisma.bankMovementSplit.deleteMany({ where: { movementId: id } });
  return movimientoDeEmpresa(companyId, id);
}

export interface FiltrosMovimientos {
  tipo?: 'cobros' | 'pagos';
  cuentaId?: string;
  desde?: string;
  hasta?: string;
  categoriaId?: string;
  estado?: 'sin-categoria' | 'categorizados' | 'ignorados';
  q?: string;
  pagina?: number;
}

const POR_PAGINA = 50;

/** Movimientos de todas las cuentas de la empresa, con su categoria y partes. */
export async function listarMovimientosTesoreria(companyId: string, f: FiltrosMovimientos) {
  const where: Record<string, unknown> = { companyId };
  if (f.tipo === 'cobros') where.importe = { gte: 0 };
  if (f.tipo === 'pagos') where.importe = { lt: 0 };
  if (f.cuentaId) where.cuentaBancariaId = f.cuentaId;
  if (f.desde || f.hasta) where.fecha = { ...(f.desde && { gte: f.desde }), ...(f.hasta && { lte: f.hasta }) };
  if (f.q) where.concepto = { contains: f.q.slice(0, 100) };
  if (f.categoriaId) {
    where.OR = [{ categoriaId: f.categoriaId }, { partes: { some: { categoriaId: f.categoriaId } } }];
  }
  if (f.estado === 'ignorados') where.ignorado = true;
  else {
    where.ignorado = false;
    if (f.estado === 'sin-categoria') Object.assign(where, { categoriaId: null, partes: { none: {} } });
    if (f.estado === 'categorizados') {
      where.AND = [{ OR: [{ categoriaId: { not: null } }, { partes: { some: {} } }] }];
    }
  }
  const pagina = Math.max(1, Number(f.pagina) || 1);
  const [total, items, sinCategoria] = await Promise.all([
    prisma.bankMovement.count({ where }),
    prisma.bankMovement.findMany({
      where,
      include: { partes: { orderBy: { createdAt: 'asc' } }, cuentaBancaria: { select: { bancoNombre: true, iban: true } } },
      orderBy: [{ fecha: 'desc' }, { createdAt: 'desc' }],
      skip: (pagina - 1) * POR_PAGINA,
      take: POR_PAGINA,
    }),
    prisma.bankMovement.count({ where: { companyId, ignorado: false, categoriaId: null, partes: { none: {} } } }),
  ]);
  return { total, pagina, porPagina: POR_PAGINA, sinCategoria, items };
}
