/**
 * Panel del resumen (dashboard): ingresos, gastos y resultado sacados de las
 * FACTURAS y de las NÓMINAS, no de la tabla Movement («Nuevo movimiento», que
 * ya no cuenta en las gráficas).
 *
 * Criterio (decisión del usuario, 13-10-2026):
 *  - Por la fecha de la factura (devengo), esté cobrada o pagada o no.
 *  - Ingresos: la base imponible (sin IVA) de las ventas emitidas en la app y
 *    de las registradas con el lector. Las rectificativas restan; una por
 *    sustitucion (S) cuenta solo su diferencia con la original
 *    (sustituidasEnRango), en el periodo de la S.
 *  - Gastos: la base de las facturas de gasto registradas (los abonos restan)
 *    más el coste de las nóminas para la empresa (bruto, dietas,
 *    indemnizaciones y Seguridad Social a cargo de la empresa: el coste que
 *    calcula el módulo de nóminas), por su mes de devengo. La app no guarda
 *    aparte el IVA no deducible de un gasto: cuenta la base.
 *  - Nada en borrador: ni ventas en borrador ni proformas, ni gastos sin
 *    revisar del lector ni anulados, ni nóminas sin contabilizar.
 *  - Importes en la moneda de cuenta de la empresa (las columnas de siempre).
 *
 * Ventas y gastos salen con los mismos filtros que el bloque «IVA y retenciones
 * del año» (resumenFiscal.service): las dos cifras cuadran. Todo son sumas o
 * agrupaciones en la BD, sin traer las facturas una a una. Solo lee.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { badRequest } from '../utils/http-errors';
import { aCentimos } from '../utils/money';
import { ejercicioOActual } from '../utils/anios';
import { hoyEspana } from '../utils/fechas';
import { esTipoGasto, esVencida, textoEstadoPago, TIPO_GASTO_INFO, type TipoGasto } from '../domain/factura-gasto.model';
import { ESTADOS_CONTABILIZADOS } from '../domain/nominas.model';
import { cuadreNomina } from './nominas/calculo';
import { nombresDeCuentas } from './cuentasLinea.service';
import { perfilEmpresa } from './perfilEmpresa.service';
import { resumenFiscalPeriodo, sustituidasEnRango, whereGastosResumen, whereVentasResumen } from './resumenFiscal.service';

// ---------------------------------------------------------------------------
// Periodo
// ---------------------------------------------------------------------------

export interface PeriodoPanel {
  anio: number;
  /** 1-4, o null si no se pidió un trimestre. */
  trimestre: number | null;
  /** 1-12, o null si no se pidió un mes. */
  mes: number | null;
  /** Primer y último mes del periodo (1-12). */
  mesDesde: number;
  mesHasta: number;
  /** Fechas AAAA-MM-DD incluidas (las de factura son texto y se comparan como tal). */
  desde: string;
  hasta: string;
}

const mm = (n: number) => String(n).padStart(2, '0');
const vacio = (v: unknown) => v === undefined || v === null || String(v).trim() === '';
/** Último día del mes (28 a 31), para que `hasta` sea una fecha que existe. */
const ultimoDia = (anio: number, mes: number) => new Date(Date.UTC(anio, mes, 0)).getUTCDate();

/**
 * Año (por defecto, el año en curso en España) y, si se pide, un trimestre o
 * un mes de ese año. 400 con un texto para la persona si algo no vale.
 */
export function periodoPanel(q: { anio?: unknown; trimestre?: unknown; mes?: unknown }, ahora?: Date): PeriodoPanel {
  const anio = ejercicioOActual(q.anio, { campo: 'anio', ahora });
  // Solo cifras: «1e1», «2.0» o « 3» no valen aunque Number() los lea.
  const trimestre = vacio(q.trimestre) ? null : /^[1-4]$/.test(String(q.trimestre)) ? Number(q.trimestre) : 0;
  if (trimestre === 0) throw badRequest('El trimestre tiene que ser 1, 2, 3 o 4.', { campo: 'trimestre' });
  const mes = vacio(q.mes) ? null : /^\d{1,2}$/.test(String(q.mes)) ? Number(q.mes) : 0;
  if (mes !== null && !(mes >= 1 && mes <= 12)) throw badRequest('El mes tiene que ir del 1 al 12.', { campo: 'mes' });
  if (trimestre !== null && mes !== null) throw badRequest('Elige un trimestre o un mes, no los dos.', { campo: 'mes' });
  const mesDesde = mes ?? (trimestre ? (trimestre - 1) * 3 + 1 : 1);
  const mesHasta = mes ?? (trimestre ? trimestre * 3 : 12);
  return { anio, trimestre, mes, mesDesde, mesHasta, desde: `${anio}-${mm(mesDesde)}-01`, hasta: `${anio}-${mm(mesHasta)}-${mm(ultimoDia(anio, mesHasta))}` };
}

/** Lo que el panel incluye según quién mira. */
export interface OpcionesPanel {
  /**
   * El coste de las nóminas (dato de personal): solo con permiso de Nóminas o
   * de Contabilidad (que ya lo ve en la 640 y la 642). Sin él, los gastos van
   * sin las nóminas y `nominasIncluidas` lo dice.
   */
  incluirNominas: boolean;
}

// ---------------------------------------------------------------------------
// Sumas
// ---------------------------------------------------------------------------

const euros = (centimos: number) => Math.round(centimos) / 100;
const centimosDe = (v: unknown) => aCentimos(Number(v ?? 0) || 0);

/** Nóminas que cuentan: contabilizadas (pagadas o no) del año, por su mes de devengo. */
function whereNominasPanel(companyId: string, p: PeriodoPanel): Prisma.NominaWhereInput {
  return { companyId, estado: { in: [...ESTADOS_CONTABILIZADOS] }, ejercicio: p.anio, mes: { gte: p.mesDesde, lte: p.mesHasta } };
}

/** Coste para la empresa y número de nóminas de cada mes del periodo, en céntimos. */
async function nominasPorMes(companyId: string, p: PeriodoPanel): Promise<Map<number, { centimos: number; nominas: number }>> {
  const grupos = await prisma.nomina.groupBy({
    // El ingreso a cuenta de la especie solo es coste si no se descuenta al trabajador.
    by: ['mes', 'ingresoACuentaRepercutido'],
    where: whereNominasPanel(companyId, p),
    _sum: { brutoDinerario: true, dietasExentas: true, indemnizacionExenta: true, indemnizacionSujeta: true, ssEmpresa: true, ingresoACuenta: true },
    _count: { _all: true },
  });
  const out = new Map<number, { centimos: number; nominas: number }>();
  for (const g of grupos) {
    const s = g._sum;
    // La misma fórmula del coste que el módulo de nóminas, sobre las sumas del grupo.
    const coste = cuadreNomina({
      brutoDinerario: Number(s.brutoDinerario ?? 0),
      dietasExentas: Number(s.dietasExentas ?? 0),
      especieValoracion: 0,
      ingresoACuenta: Number(s.ingresoACuenta ?? 0),
      ingresoACuentaRepercutido: g.ingresoACuentaRepercutido,
      indemnizacionExenta: Number(s.indemnizacionExenta ?? 0),
      indemnizacionSujeta: Number(s.indemnizacionSujeta ?? 0),
      ssTrabajador: 0,
      irpf: 0,
      anticipos: 0,
      embargos: 0,
      otrasDeducciones: 0,
      liquido: 0,
      ssEmpresa: Number(s.ssEmpresa ?? 0),
    }).costeEmpresa;
    const previo = out.get(g.mes) ?? { centimos: 0, nominas: 0 };
    out.set(g.mes, { centimos: previo.centimos + aCentimos(coste), nominas: previo.nominas + g._count._all });
  }
  return out;
}

const sumaMapa = (m: Map<number, { centimos: number; nominas: number }>) =>
  [...m.values()].reduce((a, v) => ({ centimos: a.centimos + v.centimos, nominas: a.nominas + v.nominas }), { centimos: 0, nominas: 0 });

// ---------------------------------------------------------------------------
// (1) Resumen del periodo
// ---------------------------------------------------------------------------

export interface ResumenPanel {
  /** Base de las ventas. */
  totalIncome: number;
  /** Base de las facturas de gasto más el coste de las nóminas. */
  totalExpense: number;
  /** Ingresos menos gastos. */
  balance: number;
  /** Facturas que cuentan: de venta más de gasto (sin las nóminas). */
  totalMovements: number;
  periodo: PeriodoPanel;
  monedaCuenta: string;
  facturasVenta: number;
  facturasGasto: number;
  /** Base de las facturas de gasto (sin nóminas). */
  gastoFacturas: number;
  /** Coste de las nóminas para la empresa (0 si no se incluyen). */
  gastoPersonal: number;
  nominas: number;
  /** false: los gastos van sin las nóminas porque quien mira no tiene permiso para verlas. */
  nominasIncluidas: boolean;
  /** Movimientos de «Nuevo movimiento» de la empresa (de cualquier año): ya no cuentan aquí. */
  movimientosManuales: number;
}

export async function resumenPanel(companyId: string, p: PeriodoPanel, op: OpcionesPanel): Promise<ResumenPanel> {
  const [fiscal, nominas, perfil, movimientosManuales] = await Promise.all([
    // La misma suma que «IVA y retenciones del año»: así cuadran las dos.
    resumenFiscalPeriodo(companyId, p.desde, p.hasta),
    op.incluirNominas ? nominasPorMes(companyId, p) : Promise.resolve(new Map<number, { centimos: number; nominas: number }>()),
    perfilEmpresa(companyId),
    prisma.movement.count({ where: { companyId } }),
  ]);
  const personal = sumaMapa(nominas);
  const ingresos = aCentimos(fiscal.ventas.base);
  const gastoFacturas = aCentimos(fiscal.gastos.base);
  const gastos = gastoFacturas + personal.centimos;
  return {
    totalIncome: euros(ingresos),
    totalExpense: euros(gastos),
    balance: euros(ingresos - gastos),
    totalMovements: fiscal.ventas.facturas + fiscal.gastos.facturas,
    periodo: p,
    monedaCuenta: perfil.monedaCuenta,
    facturasVenta: fiscal.ventas.facturas,
    facturasGasto: fiscal.gastos.facturas,
    gastoFacturas: euros(gastoFacturas),
    gastoPersonal: euros(personal.centimos),
    nominas: personal.nominas,
    nominasIncluidas: op.incluirNominas,
    movimientosManuales,
  };
}

// ---------------------------------------------------------------------------
// (2) Por meses
// ---------------------------------------------------------------------------

export interface FilaMesPanel {
  /** AAAA-MM */
  month: string;
  /** Base de las ventas del mes. */
  income: number;
  /** Base de las facturas de gasto más el coste de las nóminas del mes. */
  expense: number;
  balance: number;
  facturasVenta: number;
  facturasGasto: number;
  gastoFacturas: number;
  gastoPersonal: number;
  nominas: number;
}

/** Una fila por mes del periodo (los doce del año si no se pide otro), tenga datos o no. */
export async function porMesPanel(companyId: string, p: PeriodoPanel, op: OpcionesPanel): Promise<FilaMesPanel[]> {
  const rango = { desde: p.desde, hasta: p.hasta };
  // Agrupadas por fecha (como mucho una fila por día) y sumadas después por mes.
  const [ventas, gastos, nominas, sustituidas] = await Promise.all([
    prisma.incomeInvoice.groupBy({ by: ['fechaEmision'], where: whereVentasResumen(companyId, rango), _sum: { baseTotal: true }, _count: { _all: true } }),
    prisma.expenseInvoice.groupBy({ by: ['fechaEmision'], where: whereGastosResumen(companyId, rango), _sum: { baseTotal: true }, _count: { _all: true } }),
    op.incluirNominas ? nominasPorMes(companyId, p) : Promise.resolve(new Map<number, { centimos: number; nominas: number }>()),
    sustituidasEnRango(companyId, rango),
  ]);
  const filas = new Map<number, { venta: number; nVenta: number; gasto: number; nGasto: number }>();
  for (let m = p.mesDesde; m <= p.mesHasta; m++) filas.set(m, { venta: 0, nVenta: 0, gasto: 0, nGasto: 0 });
  const mesDe = (fecha: string) => Number(fecha.slice(5, 7));
  for (const g of ventas) {
    const f = filas.get(mesDe(g.fechaEmision));
    if (!f) continue;
    f.venta += centimosDe(g._sum.baseTotal);
    f.nVenta += g._count._all;
  }
  // Una S cuenta solo su diferencia: su original se resta en el mes de la S.
  for (const o of sustituidas) {
    const f = filas.get(mesDe(o.fecha));
    if (f) f.venta -= aCentimos(o.base);
  }
  for (const g of gastos) {
    const f = filas.get(mesDe(g.fechaEmision));
    if (!f) continue;
    f.gasto += centimosDe(g._sum.baseTotal);
    f.nGasto += g._count._all;
  }
  return [...filas].map(([mes, f]) => {
    const personal = nominas.get(mes) ?? { centimos: 0, nominas: 0 };
    const gasto = f.gasto + personal.centimos;
    return {
      month: `${p.anio}-${mm(mes)}`,
      income: euros(f.venta),
      expense: euros(gasto),
      balance: euros(f.venta - gasto),
      facturasVenta: f.nVenta,
      facturasGasto: f.nGasto,
      gastoFacturas: euros(f.gasto),
      gastoPersonal: euros(personal.centimos),
      nominas: personal.nominas,
    };
  });
}

// ---------------------------------------------------------------------------
// (3) Gastos por categoría: la cuenta de gasto (3 cifras del PGC) y «Personal»
// ---------------------------------------------------------------------------

export interface FilaCategoriaPanel {
  /** Nombre para la persona: el de la cuenta en el plan de la empresa (o en el PGC), o «Personal». */
  category: string;
  expense: number;
  /** Sobre el total de gastos del periodo (0 si el total no es positivo). */
  percentage: number;
  /** Cuenta de 3 cifras del PGC (628), o null en «Personal». */
  cuenta: string | null;
  /** Clave estable: «cuenta:628» o «personal». */
  clave: string;
}

const tipoDe = (t: string): TipoGasto => (esTipoGasto(t) ? t : 'COMPRA');
const SIN_CUENTA: Prisma.ExpenseInvoiceLineWhereInput[] = [{ accountCode: null }, { accountCode: '' }];

/**
 * Cada gasto va a la cuenta de su línea (la del asiento); una línea sin cuenta,
 * o la parte de la cabecera que no está en líneas (facturas antiguas sin
 * líneas), a la cuenta de su tipo de gasto (600, 621, 623 o 628), como hace el
 * asiento. Se agrupan por la cuenta de 3 cifras (6280001 y 628 van juntas).
 * Las nóminas, en «Personal». El total cuadra con el del resumen.
 */
export async function porCategoriaPanel(companyId: string, p: PeriodoPanel, op: OpcionesPanel): Promise<FilaCategoriaPanel[]> {
  const whereG = whereGastosResumen(companyId, { desde: p.desde, hasta: p.hasta });
  const [cabeceras, conCuenta, nominas] = await Promise.all([
    prisma.expenseInvoice.groupBy({ by: ['tipoGasto'], where: whereG, _sum: { baseTotal: true } }),
    prisma.expenseInvoiceLine.groupBy({ by: ['accountCode'], where: { NOT: SIN_CUENTA, invoice: { is: whereG } }, _sum: { baseLine: true } }),
    op.incluirNominas ? nominasPorMes(companyId, p) : Promise.resolve(new Map<number, { centimos: number; nominas: number }>()),
  ]);
  // Lo que cada tipo de gasto tiene en líneas con cuenta: el resto de su cabecera va a la cuenta del tipo.
  const enLineasPorTipo = await Promise.all(
    cabeceras.map((c) =>
      prisma.expenseInvoiceLine.aggregate({ where: { NOT: SIN_CUENTA, invoice: { is: { ...whereG, tipoGasto: c.tipoGasto } } }, _sum: { baseLine: true } }),
    ),
  );

  const porCuenta = new Map<string, number>();
  const sumar = (cuenta: string, centimos: number) => porCuenta.set(cuenta, (porCuenta.get(cuenta) ?? 0) + centimos);
  for (const l of conCuenta) sumar(String(l.accountCode).trim().slice(0, 3), centimosDe(l._sum.baseLine));
  cabeceras.forEach((c, i) => {
    const resto = centimosDe(c._sum.baseTotal) - centimosDe(enLineasPorTipo[i]._sum.baseLine);
    if (resto !== 0) sumar(TIPO_GASTO_INFO[tipoDe(c.tipoGasto)].cuenta, resto);
  });

  const cuentas = [...porCuenta.keys()];
  const nombres = cuentas.length ? await nombresDeCuentas(prisma, companyId, cuentas) : new Map<string, string>();
  const filas: Array<{ category: string; centimos: number; cuenta: string | null; clave: string }> = [...porCuenta]
    .filter(([, c]) => c !== 0)
    .map(([cuenta, centimos]) => ({ category: nombres.get(cuenta) ?? `Cuenta ${cuenta}`, centimos, cuenta, clave: `cuenta:${cuenta}` }));
  const personal = sumaMapa(nominas).centimos;
  if (personal !== 0) filas.push({ category: 'Personal', centimos: personal, cuenta: null, clave: 'personal' });

  const total = filas.reduce((a, f) => a + f.centimos, 0);
  return filas
    .sort((a, b) => b.centimos - a.centimos || a.clave.localeCompare(b.clave))
    .map((f) => ({
      category: f.category,
      expense: euros(f.centimos),
      percentage: total > 0 ? Math.round((f.centimos / total) * 10000) / 100 : 0,
      cuenta: f.cuenta,
      clave: f.clave,
    }));
}

// ---------------------------------------------------------------------------
// Análisis de ingresos (por cliente) y de gastos (por proveedor)
// ---------------------------------------------------------------------------

export interface FilaTerceroPanel {
  /** Id del cliente o del proveedor; null en «Personal (nóminas)». */
  id: string | null;
  name: string;
  nif: string | null;
  /** Base del periodo (con las rectificativas o abonos restados). */
  total: number;
  facturas: number;
  /** Inicial del nombre, para el gráfico. */
  letter: string;
}

const inicial = (s: string) => (s.trim().charAt(0) || '?').toUpperCase();
const ordenar = (a: FilaTerceroPanel, b: FilaTerceroPanel) => b.total - a.total || a.name.localeCompare(b.name, 'es');

/**
 * Ventas del periodo por cliente, de mayor a menor base. Una S cuenta solo su
 * diferencia: su original se resta al cliente de la original.
 */
export async function ingresosPorClientePanel(companyId: string, p: PeriodoPanel): Promise<FilaTerceroPanel[]> {
  const rango = { desde: p.desde, hasta: p.hasta };
  const [grupos, sustituidas] = await Promise.all([
    prisma.incomeInvoice.groupBy({ by: ['customerId'], where: whereVentasResumen(companyId, rango), _sum: { baseTotal: true }, _count: { _all: true } }),
    sustituidasEnRango(companyId, rango),
  ]);
  const porCliente = new Map<string, { centimos: number; facturas: number }>();
  for (const g of grupos) porCliente.set(g.customerId, { centimos: centimosDe(g._sum.baseTotal), facturas: g._count._all });
  for (const o of sustituidas) {
    const c = porCliente.get(o.customerId) ?? { centimos: 0, facturas: 0 };
    porCliente.set(o.customerId, { ...c, centimos: c.centimos - aCentimos(o.base) });
  }
  if (!porCliente.size) return [];
  const clientes = await prisma.customer.findMany({ where: { companyId, id: { in: [...porCliente.keys()] } }, select: { id: true, nombreFiscal: true, nifCif: true } });
  const porId = new Map(clientes.map((c) => [c.id, c]));
  return [...porCliente]
    .map(([id, g]) => {
      const c = porId.get(id);
      const name = c?.nombreFiscal ?? 'Cliente sin ficha';
      return { id, name, nif: c?.nifCif ?? null, total: euros(g.centimos), facturas: g.facturas, letter: inicial(name) };
    })
    .sort(ordenar);
}

/** Gastos del periodo por proveedor, más «Personal (nóminas)», de mayor a menor. */
export async function gastosPorProveedorPanel(companyId: string, p: PeriodoPanel, op: OpcionesPanel): Promise<FilaTerceroPanel[]> {
  const [grupos, nominas] = await Promise.all([
    prisma.expenseInvoice.groupBy({
      by: ['supplierId'],
      where: whereGastosResumen(companyId, { desde: p.desde, hasta: p.hasta }),
      _sum: { baseTotal: true },
      _count: { _all: true },
    }),
    op.incluirNominas ? nominasPorMes(companyId, p) : Promise.resolve(new Map<number, { centimos: number; nominas: number }>()),
  ]);
  const proveedores = grupos.length
    ? await prisma.supplier.findMany({ where: { companyId, id: { in: grupos.map((g) => g.supplierId) } }, select: { id: true, nombreFiscal: true, nifCif: true } })
    : [];
  const porId = new Map(proveedores.map((s) => [s.id, s]));
  const filas: FilaTerceroPanel[] = grupos.map((g) => {
    const s = porId.get(g.supplierId);
    const name = s?.nombreFiscal ?? 'Proveedor sin ficha';
    return { id: g.supplierId, name, nif: s?.nifCif ?? null, total: euros(centimosDe(g._sum.baseTotal)), facturas: g._count._all, letter: inicial(name) };
  });
  const personal = sumaMapa(nominas);
  if (personal.nominas > 0) filas.push({ id: null, name: 'Personal (nóminas)', nif: null, total: euros(personal.centimos), facturas: personal.nominas, letter: 'P' });
  return filas.sort(ordenar);
}

// ---------------------------------------------------------------------------
// (4) Últimas facturas de venta y de gasto
// ---------------------------------------------------------------------------

export interface UltimaFacturaPanel {
  /** Id de la factura (el mismo que facturaId). */
  id: string;
  facturaId: string;
  tipo: 'venta' | 'gasto';
  /** Como en los movimientos de antes: income (venta) o expense (gasto). */
  type: 'income' | 'expense';
  /** Fecha de la factura (AAAA-MM-DD). */
  date: string;
  /** Número de la factura (en un gasto, el que puso el proveedor si lo hay). */
  numero: string;
  referenceDocument: string;
  /** Cliente o proveedor. */
  tercero: string;
  terceroId: string;
  description: string;
  /** «Ventas» o el tipo de gasto. */
  category: string;
  /** Base en la moneda de cuenta (negativa en rectificativas y abonos). */
  base: number;
  /** Total de la factura en la moneda de cuenta. */
  total: number;
  /** La base con dos decimales y punto, como el importe de los movimientos de antes. */
  amount: string;
  rectificativa: boolean;
  /** Siempre «approved»: son facturas emitidas o registradas, no borradores. */
  status: 'approved';
  /**
   * Cobro o pago, para la persona. Ventas: «Cobrada», «Cobrada en parte»,
   * «Vencida», «Pendiente de cobro», «Rectificativa» o «Sustituida» (la
   * original de una rectificativa por sustitucion). Gastos: «Pagada»,
   * «Pagada en parte», «Vencida», «Pendiente de pago», «Abono» (rectificativa
   * que baja) o «Rectificativa» (la que sube o se queda igual).
   */
  estado: string;
  /** Pantalla de la factura en la app. */
  enlace: string;
}

/** Límite de las últimas facturas: por defecto 15, como mucho 50. */
export function limiteUltimas(v: unknown): number {
  if (vacio(v)) return 15;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw badRequest('El límite tiene que ser un número entero mayor que cero.', { campo: 'limit' });
  return Math.min(n, 50);
}

/**
 * Las últimas facturas de venta y de gasto juntas, de la más reciente a la más
 * antigua (por fecha de factura y, a igual fecha, por alta), con los mismos
 * filtros que el resto del panel. Con `anio`, solo las de ese año.
 */
export async function ultimasFacturasPanel(companyId: string, limite: number, anio?: number | null, hoy = hoyEspana()): Promise<UltimaFacturaPanel[]> {
  const rango = anio ? { desde: `${anio}-01-01`, hasta: `${anio}-12-31` } : undefined;
  const orden = [{ fechaEmision: 'desc' as const }, { createdAt: 'desc' as const }];
  const [ventas, gastos] = await Promise.all([
    prisma.incomeInvoice.findMany({
      where: whereVentasResumen(companyId, rango),
      orderBy: orden,
      take: limite,
      select: {
        id: true,
        numeroCompleto: true,
        fechaEmision: true,
        fechaVencimiento: true,
        estado: true,
        baseTotal: true,
        totalFactura: true,
        esRectificativa: true,
        createdAt: true,
        customer: { select: { id: true, nombreFiscal: true } },
      },
    }),
    prisma.expenseInvoice.findMany({
      where: whereGastosResumen(companyId, rango),
      orderBy: orden,
      take: limite,
      select: {
        id: true,
        numeroCompleto: true,
        numeroFacturaProveedor: true,
        fechaEmision: true,
        fechaVencimiento: true,
        estado: true,
        estadoPago: true,
        tipoGasto: true,
        baseTotal: true,
        totalFactura: true,
        esRectificativa: true,
        createdAt: true,
        supplier: { select: { id: true, nombreFiscal: true } },
      },
    }),
  ]);
  // Lo cobrado de cada venta de la lista (en la moneda de cuenta, como su total)
  // y las que ha sustituido una rectificativa por sustitucion (S) emitida.
  const idsVentas = ventas.map((f) => f.id);
  const [cobros, sustituciones] = idsVentas.length
    ? await Promise.all([
        prisma.invoicePayment.groupBy({
          by: ['invoiceId'],
          where: { companyId, invoiceType: 'INGRESO', estado: 'ACTIVO', invoiceId: { in: idsVentas } },
          _sum: { importe: true },
        }),
        prisma.incomeInvoice.findMany({
          where: { ...whereVentasResumen(companyId), esRectificativa: true, tipoRectificativa: 'S', facturaOriginalId: { in: idsVentas } },
          select: { facturaOriginalId: true },
        }),
      ])
    : [[], []];
  const cobradoDe = new Map(cobros.map((c) => [c.invoiceId, centimosDe(c._sum.importe)]));
  const sustituidas = new Set(sustituciones.map((s) => s.facturaOriginalId));
  /** Estado de cobro de una venta: con los cobros registrados, como el de pago de un gasto. */
  const estadoVenta = (f: (typeof ventas)[number]): string => {
    const total = centimosDe(f.totalFactura);
    // Una rectificativa (también la que sube o la de sustitución) no se presenta como un cobro.
    if (f.esRectificativa || total < 0) return 'Rectificativa';
    // La ocupa la rectificativa que la sustituye: ya no se cobra esta (como en «Cobros de clientes»).
    if (sustituidas.has(f.id)) return 'Sustituida';
    const cobrado = cobradoDe.get(f.id) ?? 0;
    // PAID sin cobros: marcada como cobrada a mano antes de que existieran los cobros.
    if (f.estado === 'PAID' || (total > 0 && cobrado >= total)) return 'Cobrada';
    if (f.estado === 'OVERDUE' || f.fechaVencimiento < hoy) return 'Vencida';
    return cobrado > 0 ? 'Cobrada en parte' : 'Pendiente de cobro';
  };
  const base = (v: unknown) => euros(centimosDe(v));
  const filas: Array<UltimaFacturaPanel & { _alta: number }> = [
    ...ventas.map((f) => {
      const total = base(f.totalFactura);
      const numero = f.numeroCompleto ?? '';
      const estado = estadoVenta(f);
      return {
        id: f.id,
        facturaId: f.id,
        tipo: 'venta' as const,
        type: 'income' as const,
        date: f.fechaEmision,
        numero,
        referenceDocument: numero,
        tercero: f.customer.nombreFiscal,
        terceroId: f.customer.id,
        description: f.customer.nombreFiscal,
        category: 'Ventas',
        base: base(f.baseTotal),
        total,
        amount: base(f.baseTotal).toFixed(2),
        rectificativa: f.esRectificativa,
        status: 'approved' as const,
        estado,
        enlace: `/dashboard/facturas/${f.id}`,
        _alta: f.createdAt.getTime(),
      };
    }),
    ...gastos.map((f) => {
      const total = base(f.totalFactura);
      const numero = f.numeroFacturaProveedor || f.numeroCompleto;
      // Abono: la rectificativa que baja. La que sube (o solo cambia el IVA) es «Rectificativa».
      const estado =
        total < 0 ? 'Abono' : f.esRectificativa ? 'Rectificativa' : textoEstadoPago(f.estadoPago, esVencida({ ...f, totalFactura: total }, hoy));
      return {
        id: f.id,
        facturaId: f.id,
        tipo: 'gasto' as const,
        type: 'expense' as const,
        date: f.fechaEmision,
        numero,
        referenceDocument: numero,
        tercero: f.supplier.nombreFiscal,
        terceroId: f.supplier.id,
        description: f.supplier.nombreFiscal,
        category: TIPO_GASTO_INFO[tipoDe(f.tipoGasto)].texto,
        base: base(f.baseTotal),
        total,
        amount: base(f.baseTotal).toFixed(2),
        rectificativa: f.esRectificativa,
        status: 'approved' as const,
        estado,
        enlace: `/dashboard/compras/${f.id}`,
        _alta: f.createdAt.getTime(),
      };
    }),
  ];
  return filas
    .sort((a, b) => b.date.localeCompare(a.date) || b._alta - a._alta)
    .slice(0, limite)
    .map(({ _alta, ...f }) => f);
}
