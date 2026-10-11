/**
 * Cuenta de gasto o de ingreso POR LINEA en las facturas de gasto y de venta.
 *
 * Por defecto cada linea va a la cuenta generica (gastos: la del tipo de gasto,
 * 600/621/623/628; ventas: la 700, o la 705 si el producto es un servicio).
 * Desde la linea se puede elegir otra cuenta ya creada del plan de la empresa
 * (grupo 6 en gastos, 70x en ventas, 705 en servicios) o crear una subcuenta
 * nueva bajo una cuenta madre: la app propone el siguiente codigo libre con la
 * longitud de las subcuentas de la empresa (si la ultima es 6280002, 6280003)
 * y el usuario pone el nombre. Queda en el plan para las facturas siguientes.
 *
 * Las cuentas de este listado son de gastos e ingresos (nunca de terceros): las
 * puede ver quien registra facturas, aunque no tenga contabilidad:read.
 */
import { randomUUID } from 'crypto';
import { prisma, type TransaccionBD } from '../config/database';
import { PGC_BASE } from '../domain/pgc-model';
import { badRequest, conflict } from '../utils/http-errors';
import { conReintento } from '../utils/reintento';
import { asegurarPlanContableEmpresa } from './chart-of-accounts.service';
import { longitudSubcuentasEmpresa } from './terceros/subcuentas';

type Db = TransaccionBD | typeof prisma;

export type TipoCuentaLinea = 'gasto' | 'venta' | 'servicio';
export const TIPOS_CUENTA_LINEA: TipoCuentaLinea[] = ['gasto', 'venta', 'servicio'];

/** Prefijo de las cuentas de cada tipo y cuenta generica por defecto. */
const REGLA: Record<TipoCuentaLinea, { prefijo: string; porDefecto: string; texto: string }> = {
  gasto: { prefijo: '6', porDefecto: '600', texto: 'de gastos (grupo 6)' },
  venta: { prefijo: '70', porDefecto: '700', texto: 'de ventas (70)' },
  servicio: { prefijo: '705', porDefecto: '705', texto: 'de prestaciones de servicios (705)' },
};

/** Permisos que dejan usar las cuentas de cada tipo (con uno basta; el administrador siempre puede). */
export const PERMISOS_CUENTA_LINEA: Record<TipoCuentaLinea, { leer: string[]; crear: string[] }> = {
  gasto: { leer: ['compras:read', 'compras:write', 'contabilidad:read', 'contabilidad:write'], crear: ['compras:write', 'contabilidad:write'] },
  venta: { leer: ['ventas:read', 'ventas:write', 'contabilidad:read', 'contabilidad:write'], crear: ['ventas:write', 'contabilidad:write'] },
  servicio: { leer: ['ventas:read', 'ventas:write', 'contabilidad:read', 'contabilidad:write'], crear: ['ventas:write', 'contabilidad:write'] },
};

export function tipoCuentaLinea(v: unknown): TipoCuentaLinea {
  if (typeof v === 'string' && (TIPOS_CUENTA_LINEA as string[]).includes(v)) return v as TipoCuentaLinea;
  throw badRequest('Indica el tipo de cuenta: gasto, venta o servicio.', { campo: 'tipo' });
}

/** Codigo de cuenta con forma valida para una linea de ese tipo (3 a 10 digitos con su prefijo). */
export function esCuentaDeTipo(codigo: string, tipo: TipoCuentaLinea | 'gasto' | 'venta'): boolean {
  return /^\d{3,10}$/.test(codigo) && codigo.startsWith(REGLA[tipo].prefijo);
}

const NOMBRE_BASE = new Map(PGC_BASE.map((n) => [n.code, n.name]));

/**
 * Cuentas del grupo 6 y de la 70 que no van en la linea de una factura: las de
 * saldo acreedor (descuentos, devoluciones y rappels: 606, 608, 609, 706, 708 y
 * 709), variacion de existencias (61), impuesto sobre beneficios (630 y sus
 * ajustes), sueldos y Seguridad Social (640-645; la 649 «Otros gastos
 * sociales» si), amortizaciones (68) y deterioros (69). No salen en la lista
 * principal; quien tiene contabilidad:write (y el administrador) las ve aparte.
 */
const USO_CONTABLE: Record<TipoCuentaLinea, string[]> = {
  gasto: ['606', '608', '609', '61', '630', '633', '634', '636', '638', '640', '641', '642', '643', '644', '645', '68', '69'],
  venta: ['706', '708', '709'],
  servicio: [],
};

export function esCuentaDeUsoContable(codigo: string, tipo: TipoCuentaLinea): boolean {
  return USO_CONTABLE[tipo].some((p) => codigo.startsWith(p));
}

// ---------------------------------------------------------------------------
// Listado de cuentas elegibles
// ---------------------------------------------------------------------------

export interface CuentaElegible {
  codigo: string;
  nombre: string;
  /** Cuenta de la que cuelga (null en las de 3 digitos). */
  madre: string | null;
  /** Subcuenta propia de la empresa (creada por ella o traida de su plan anterior). */
  propia: boolean;
}

export interface ListadoCuentasLinea {
  tipo: TipoCuentaLinea;
  /** Cuenta que se usa si la linea no dice otra. */
  porDefecto: string;
  /** Longitud de las subcuentas nuevas. */
  longitud: number;
  /** Las que pueden ir en una linea de factura. */
  cuentas: CuentaElegible[];
  /** Las de uso contable (608, 640, 68x...): solo para contabilidad:write o el administrador; si no, vacia. */
  otras: CuentaElegible[];
}

const sinTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Cuentas activas del plan de la empresa del tipo pedido, de 3 o mas digitos
 * (las de 1 y 2 son grupos y subgrupos: no llevan apuntes). Con `q`, las que
 * tienen ese texto en el codigo o en el nombre; con `madre`, solo esa cuenta y
 * las que cuelgan de ella. Las de uso contable van aparte, en `otras`, solo
 * con `verUsoContable`.
 */
export async function listarCuentasLinea(
  companyId: string,
  tipo: TipoCuentaLinea,
  filtro: { q?: string; madre?: string } = {},
  opciones: { verUsoContable?: boolean } = {},
): Promise<ListadoCuentasLinea> {
  await asegurarPlanContableEmpresa(companyId);
  const { prefijo, porDefecto } = REGLA[tipo];
  const madre = filtro.madre?.replace(/\D/g, '') || undefined;
  const filas = await prisma.chartOfAccounts.findMany({
    where: { companyId, activo: true, codigo: { startsWith: madre ?? prefijo } },
    select: { codigo: true, nombre: true, parentCodigo: true, esPersonalizadaEmpresa: true },
    orderBy: { codigo: 'asc' },
  });
  const q = filtro.q?.trim() ? sinTildes(filtro.q.trim()) : null;
  const todas = filas
    .filter((c) => c.codigo.length >= 3 && c.codigo.startsWith(prefijo))
    .filter((c) => !q || sinTildes(`${c.codigo} ${c.nombre}`).includes(q))
    .map((c) => ({ codigo: c.codigo, nombre: c.nombre, madre: c.parentCodigo ?? null, propia: c.esPersonalizadaEmpresa }));
  const cuentas = todas.filter((c) => !esCuentaDeUsoContable(c.codigo, tipo));
  const otras = opciones.verUsoContable ? todas.filter((c) => esCuentaDeUsoContable(c.codigo, tipo)) : [];
  return { tipo, porDefecto, longitud: await longitudSubcuentasEmpresa(companyId), cuentas, otras };
}

/** Tope de codigos por peticion de nombres. */
const MAX_NOMBRES = 50;

/**
 * Nombre de las cuentas pedidas (separadas por comas) que son de ese tipo,
 * tambien las de uso contable. Sirve para que la linea que ya va a la 608 o a
 * la 640 ensene su nombre a quien no recibe la lista `otras`: solo devuelve
 * las que se piden, nunca la lista entera.
 */
export async function nombresCuentasLinea(companyId: string, tipo: TipoCuentaLinea, codigosRaw: unknown): Promise<Array<{ codigo: string; nombre: string }>> {
  const texto = typeof codigosRaw === 'string' ? codigosRaw : '';
  const codigos = [...new Set(texto.split(',').map((c) => c.trim()))].filter((c) => esCuentaDeTipo(c, tipo)).slice(0, MAX_NOMBRES);
  if (!codigos.length) return [];
  const nombres = await nombresDeCuentas(prisma, companyId, codigos);
  return codigos.filter((c) => nombres.has(c)).map((c) => ({ codigo: c, nombre: nombres.get(c)! }));
}

// ---------------------------------------------------------------------------
// Siguiente codigo libre bajo una cuenta madre
// ---------------------------------------------------------------------------

/**
 * Siguiente codigo libre bajo `madre` con `longitud` digitos: el mayor
 * correlativo de las subcuentas de esa longitud que cuelgan de la madre + 1
 * (6280002 -> 6280003), sin reutilizar huecos y saltando el 0 (6280000 seria
 * la madre rellenada). Puro: recibe las cuentas del plan.
 */
export function siguienteCodigoBajo(
  madre: string,
  plan: Array<{ codigo: string; parentCodigo?: string | null }>,
  longitud: number,
): string {
  const ancho = longitud - madre.length;
  if (ancho < 1) throw badRequest(`La cuenta ${madre} ya tiene ${madre.length} dígitos: no admite subcuentas de ${longitud}.`);
  const usados = new Set(plan.map((c) => c.codigo));
  let max = 0;
  for (const c of plan) {
    if (c.codigo.length !== longitud || !c.codigo.startsWith(madre)) continue;
    // Una subcuenta de otra cuenta mas larga (62810001 bajo 6281) no cuenta para la 628.
    if (c.parentCodigo && c.parentCodigo !== madre) continue;
    const n = Number(c.codigo.slice(madre.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  const tope = 10 ** ancho;
  for (let n = max + 1; n < tope; n++) {
    const codigo = `${madre}${String(n).padStart(ancho, '0')}`;
    if (!usados.has(codigo)) return codigo;
  }
  throw badRequest(`No quedan subcuentas libres de ${longitud} dígitos bajo la ${madre}. Habla con tu asesor.`);
}

/** Cuenta madre valida para el tipo: en el plan de la empresa, activa, de 3 o mas digitos y mas corta que la longitud. */
async function madreValida(db: Db, companyId: string, tipo: TipoCuentaLinea, madreRaw: unknown, longitud: number) {
  const madre = typeof madreRaw === 'string' || typeof madreRaw === 'number' ? String(madreRaw).replace(/\D/g, '') : '';
  if (!madre) throw badRequest('Indica la cuenta de la que cuelga la subcuenta (por ejemplo, 628).', { campo: 'madre' });
  if (!esCuentaDeTipo(madre, tipo)) {
    throw badRequest(`La cuenta ${madre} no es una cuenta ${REGLA[tipo].texto}.`, { campo: 'madre' });
  }
  if (madre.length >= longitud) {
    throw badRequest(`La cuenta ${madre} ya es una subcuenta de ${madre.length} dígitos: elige la cuenta de la que cuelga.`, { campo: 'madre' });
  }
  const fila = await db.chartOfAccounts.findFirst({ where: { companyId, codigo: madre } });
  if (!fila) throw badRequest(`La cuenta ${madre} no está en tu plan contable.`, { campo: 'madre' });
  if (!fila.activo) throw badRequest(`La cuenta ${madre} está desactivada en tu plan contable.`, { campo: 'madre' });
  return fila;
}

export interface PropuestaSubcuenta {
  tipo: TipoCuentaLinea;
  madre: string;
  nombreMadre: string;
  longitud: number;
  codigo: string;
}

/** Codigo que recibiria ahora una subcuenta nueva bajo `madre`. */
export async function proponerSubcuenta(companyId: string, tipo: TipoCuentaLinea, madreRaw: unknown): Promise<PropuestaSubcuenta> {
  await asegurarPlanContableEmpresa(companyId);
  const longitud = await longitudSubcuentasEmpresa(companyId);
  const madre = await madreValida(prisma, companyId, tipo, madreRaw, longitud);
  const plan = await prisma.chartOfAccounts.findMany({ where: { companyId, codigo: { startsWith: madre.codigo } }, select: { codigo: true, parentCodigo: true } });
  return { tipo, madre: madre.codigo, nombreMadre: madre.nombre, longitud, codigo: siguienteCodigoBajo(madre.codigo, plan, longitud) };
}

export interface SubcuentaCreada {
  id: string;
  codigo: string;
  nombre: string;
  madre: string;
  tipo: TipoCuentaLinea;
}

/**
 * Crea una subcuenta de gasto o de ingreso bajo `madre` con el siguiente codigo
 * libre (o el `codigo` indicado, si esta libre, empieza por la madre y es mas
 * largo). Si dos personas la crean a la vez, la segunda recibe el siguiente.
 */
export async function crearSubcuentaLinea(
  companyId: string,
  datos: { tipo: unknown; madre: unknown; nombre: unknown; codigo?: unknown },
): Promise<SubcuentaCreada> {
  const tipo = tipoCuentaLinea(datos.tipo);
  const nombre = typeof datos.nombre === 'string' ? datos.nombre.trim() : '';
  if (!nombre) throw badRequest('Escribe el nombre de la subcuenta (por ejemplo, «Luz de la oficina»).', { campo: 'nombre' });
  if (nombre.length > 190) throw badRequest('El nombre de la subcuenta es demasiado largo (190 caracteres como mucho).', { campo: 'nombre' });
  const pedido = datos.codigo === undefined || datos.codigo === null || datos.codigo === '' ? null : String(datos.codigo).replace(/\s/g, '');
  await asegurarPlanContableEmpresa(companyId);
  const longitud = await longitudSubcuentasEmpresa(companyId);

  const crear = () =>
    prisma.$transaction(async (tx) => {
      const madre = await madreValida(tx, companyId, tipo, datos.madre, longitud);
      let codigo: string;
      if (pedido) {
        if (!/^\d{4,10}$/.test(pedido) || !pedido.startsWith(madre.codigo) || pedido.length <= madre.codigo.length) {
          throw badRequest(`El código tiene que empezar por ${madre.codigo} y tener más dígitos (como mucho 10).`, { campo: 'codigo' });
        }
        if (/^0+$/.test(pedido.slice(madre.codigo.length))) {
          throw badRequest(`El código ${pedido} es la propia ${madre.codigo} rellenada con ceros: elige otro.`, { campo: 'codigo' });
        }
        const ya = await tx.chartOfAccounts.findFirst({ where: { companyId, codigo: pedido }, select: { nombre: true } });
        if (ya) throw conflict(`La cuenta ${pedido} ya existe en tu plan (${ya.nombre}).`, { campo: 'codigo', codigo: pedido });
        codigo = pedido;
      } else {
        const plan = await tx.chartOfAccounts.findMany({ where: { companyId, codigo: { startsWith: madre.codigo } }, select: { codigo: true, parentCodigo: true } });
        codigo = siguienteCodigoBajo(madre.codigo, plan, longitud);
      }
      const c = await tx.chartOfAccounts.create({
        data: {
          id: randomUUID(),
          companyId,
          codigo,
          nombre,
          grupo: madre.grupo,
          nivel: madre.nivel + 1,
          naturaleza: madre.naturaleza,
          tipoUso: madre.tipoUso,
          esBasePGC: false,
          esPersonalizadaEmpresa: true,
          parentId: madre.id,
          parentCodigo: madre.codigo,
          notas: 'Creada desde una factura (cuenta por línea).',
        },
      });
      return { id: c.id, codigo: c.codigo, nombre: c.nombre, madre: madre.codigo, tipo };
    });

  // Con un codigo pedido, el choque es un 409; con el automatico, se repite y sale el siguiente.
  if (pedido) {
    try {
      return await crear();
    } catch (e) {
      if (e instanceof Error && (e as { code?: string }).code === 'P2002') {
        throw conflict(`La cuenta ${pedido} ya existe en tu plan.`, { campo: 'codigo', codigo: pedido });
      }
      throw e;
    }
  }
  return conReintento(crear, { indices: ['ChartOfAccounts_companyId_codigo', 'codigo'], intentos: 5 });
}

// ---------------------------------------------------------------------------
// Validacion de las cuentas de las lineas y sus nombres
// ---------------------------------------------------------------------------

/**
 * Cada cuenta de linea tiene que ser del tipo (6 en gastos, 70 en ventas) y
 * estar activa en el plan de la empresa (o en el plan base, que se copia a la
 * empresa al contabilizar). Devuelve el indice de la primera que falla y el
 * texto, o null si todas valen.
 */
export async function problemaCuentasLinea(
  companyId: string,
  tipo: 'gasto' | 'venta',
  cuentas: Array<string | null | undefined>,
  db: Db = prisma,
): Promise<{ indice: number; mensaje: string } | null> {
  const lista = cuentas.map((c) => (c ?? '').trim());
  for (let i = 0; i < lista.length; i++) {
    const c = lista[i];
    if (c && !esCuentaDeTipo(c, tipo)) {
      return { indice: i, mensaje: tipo === 'gasto' ? `La cuenta ${c} no es de gastos: tiene que ser del grupo 6.` : `La cuenta ${c} no es de ventas: tiene que empezar por 70.` };
    }
  }
  const distintas = [...new Set(lista.filter(Boolean))];
  if (!distintas.length) return null;
  const enPlan = await db.chartOfAccounts.findMany({ where: { companyId, codigo: { in: distintas } }, select: { codigo: true, activo: true } });
  const estado = new Map(enPlan.map((c) => [c.codigo, c.activo]));
  for (let i = 0; i < lista.length; i++) {
    const c = lista[i];
    if (!c) continue;
    const activo = estado.get(c);
    if (activo === false) return { indice: i, mensaje: `La cuenta ${c} está desactivada en tu plan contable.` };
    if (activo === undefined && !NOMBRE_BASE.has(c)) return { indice: i, mensaje: `La cuenta ${c} no existe en tu plan contable.` };
  }
  return null;
}

/** Nombre de cada cuenta: el del plan de la empresa; si no esta, el del plan base. */
export async function nombresDeCuentas(db: Db, companyId: string, codigos: string[]): Promise<Map<string, string>> {
  const lista = [...new Set(codigos.filter(Boolean))];
  const out = new Map<string, string>();
  for (const c of lista) {
    const base = NOMBRE_BASE.get(c);
    if (base) out.set(c, base);
  }
  if (!lista.length || typeof (db as { chartOfAccounts?: { findMany?: unknown } }).chartOfAccounts?.findMany !== 'function') return out;
  // Con una BD simulada (tests sin MySQL) puede no devolver nada: se quedan los del plan base.
  const filas = (await db.chartOfAccounts.findMany({ where: { companyId, codigo: { in: lista } }, select: { codigo: true, nombre: true } })) ?? [];
  for (const f of filas) out.set(f.codigo, f.nombre);
  return out;
}

/**
 * Base por cuenta de una factura (para el asiento): suma la base de las lineas
 * de cada cuenta (en centimos, sin errores de coma flotante); las lineas sin
 * cuenta van a la generica.
 */
export function basePorCuenta(lineas: Array<{ cuenta: string | null | undefined; base: number }>, generica: string): Array<{ cuenta: string; base: number }> {
  const mapa = new Map<string, number>();
  for (const l of lineas) {
    const c = (l.cuenta ?? '').trim() || generica;
    mapa.set(c, (mapa.get(c) ?? 0) + Math.round(Number(l.base) * 100));
  }
  return [...mapa].map(([cuenta, centimos]) => ({ cuenta, base: centimos / 100 }));
}

/**
 * Cuenta de gasto habitual de un proveedor: la que mas se repite en las lineas
 * de sus ultimas facturas (como mucho 10), si sigue activa en el plan. El
 * lector de gastos la propone para las lineas (p. ej. 6280001 «Luz oficina»
 * para la compania electrica). null si no tiene facturas con cuenta.
 */
export async function cuentaHabitualDeProveedor(companyId: string, supplierId: string): Promise<{ codigo: string; nombre: string } | null> {
  const facturas = await prisma.expenseInvoice.findMany({
    where: { companyId, supplierId, estado: { not: 'ANULADA' } },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { lineas: { select: { accountCode: true } } },
  });
  const veces = new Map<string, number>();
  for (const f of facturas) for (const l of f.lineas) if (l.accountCode && esCuentaDeTipo(l.accountCode, 'gasto')) veces.set(l.accountCode, (veces.get(l.accountCode) ?? 0) + 1);
  const ordenadas = [...veces].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  for (const codigo of ordenadas) {
    const enPlan = await prisma.chartOfAccounts.findFirst({ where: { companyId, codigo, activo: true }, select: { nombre: true } });
    if (enPlan) return { codigo, nombre: enPlan.nombre };
    const base = NOMBRE_BASE.get(codigo);
    if (base) return { codigo, nombre: base };
  }
  return null;
}
