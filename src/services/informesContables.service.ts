/**
 * Informes contables por ejercicio (o periodo dentro de un ejercicio), todos
 * desde los asientos POSTED y sin regularizacion ni cierre:
 *
 *  - Balance de situacion y cuenta de perdidas y ganancias con el modelo PGC
 *    PYMES y columna del ejercicio anterior (mismo calculo que las cuentas
 *    anuales y el Modelo 200: saldosDelEjercicio + calcularEstadosDesdeSaldos).
 *  - Balance de sumas y saldos, libro mayor y libro diario.
 *  - Mayor de clientes y de proveedores (criterio en crearResolvedorTercero).
 *
 * Cada informe devuelve sus datos y una TablaInforme, que es lo que se pinta en
 * pantalla y lo que se descarga en PDF o Excel.
 */
import { prisma } from '../config/database';
import { notFound } from '../utils/http-errors';
import { anioEspana } from '../utils/fechas';
import { calcularPendiente, cobradoPorFactura } from './cobrosPagos.service';
import { saldosDelEjercicio, type AsientoSimple } from './contabilidadDatos.service';
import { fuenteEjercicioAnterior } from './fuenteEjercicioAnterior';
import { calcularEstadosDesdeSaldos } from './impuestoSociedadesCalculo.service';
import { calcularPyGModelo } from '../domain/modelos-cuentas-anuales';
import type { BalancePartida as PartidaDominio } from '../domain/impuesto-sociedades.model';

type BalancePartida = { codigo: string; descripcion: string; importe: number };
const partidas = (ps: PartidaDominio[]): BalancePartida[] => ps.map((p) => ({ codigo: p.codigo ?? '', descripcion: p.descripcion, importe: p.importe }));
import {
  aAsientoInforme,
  calcularDiario,
  calcularMayor,
  calcularMayorTerceros,
  calcularSumasYSaldos,
  crearNombrador,
  movimientosDelPeriodo,
  SIN_IDENTIFICAR,
  type AsientoInforme,
  type FiltroCuentas,
  type NivelSumas,
  type Periodo,
  type SaldoTercero,
  type TipoTercero,
} from './informesContables.calculo';
import { fechaES, num, textoPeriodo, type FilaInforme, type TablaInforme } from './informesContables.documentos';
import { GASTO_VIGENTE, fechaContableGasto } from '../domain/factura-gasto.model';
import { partidasPendientesA } from './arranque/partidas.service';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

// ---------------------------------------------------------------------------
// Datos comunes
// ---------------------------------------------------------------------------

export async function datosEmpresa(companyId: string): Promise<{ nombre: string; nif: string }> {
  const [legal, empresa] = await Promise.all([
    prisma.legalConfig.findUnique({ where: { companyId }, select: { denominacion: true, nif: true } }).catch(() => null),
    prisma.company.findUnique({ where: { id: companyId }, select: { name: true } }).catch(() => null),
  ]);
  return { nombre: legal?.denominacion || empresa?.name || '', nif: legal?.nif ?? '' };
}

/**
 * Simbolo de la moneda de cuenta para los textos de los informes ('€' en las
 * empresas espanolas; el codigo, p. ej. 'USD', en las demas). Los importes de
 * los informes salen siempre de los asientos, en la moneda de cuenta.
 */
async function simboloCuenta(companyId: string): Promise<string> {
  const cfg = await prisma.legalConfig.findUnique({ where: { companyId }, select: { monedaCuenta: true } }).catch(() => null);
  const moneda = cfg?.monedaCuenta || 'EUR';
  return moneda === 'EUR' ? '€' : moneda;
}

/** Asientos POSTED hasta una fecha (incluida), con sus lineas. */
export async function cargarAsientos(companyId: string, hasta: string): Promise<AsientoInforme[]> {
  const [y, m, d] = hasta.split('-').map(Number);
  const entries = await prisma.journalEntry.findMany({
    where: { companyId, estado: 'POSTED', fecha: { lt: new Date(Date.UTC(y, m - 1, d + 1)) } },
    include: { lineas: { orderBy: [{ debe: 'desc' }, { createdAt: 'asc' }] } },
    orderBy: [{ fecha: 'asc' }, { numeroAsiento: 'asc' }],
  });
  return entries.map(aAsientoInforme);
}

/** Nombres del plan contable (los de la empresa mandan sobre los del plan base). */
async function nombrador(companyId: string, asientos: AsientoInforme[]) {
  const cuentas = await prisma.chartOfAccounts
    .findMany({ where: { OR: [{ companyId }, { companyId: null }] }, select: { codigo: true, nombre: true, companyId: true } })
    .catch(() => []);
  const plan = new Map<string, string>();
  for (const c of cuentas) if (!c.companyId) plan.set(c.codigo, c.nombre);
  for (const c of cuentas) if (c.companyId) plan.set(c.codigo, c.nombre);
  const apuntes = new Map<string, string>();
  for (const a of asientos) for (const l of a.lineas) if (l.nombre && !apuntes.has(l.cuenta)) apuntes.set(l.cuenta, l.nombre);
  plan.set('129', plan.get('129') ?? 'Resultado del ejercicio');
  return crearNombrador(plan, apuntes);
}

/**
 * Años que ofrecen los informes y el mayor, del mas reciente al mas antiguo:
 * los que tienen asientos contabilizados, los ejercicios dados de alta, el año
 * en curso y el siguiente (hora de España). Antes solo salia el rango de los
 * asientos y, en enero, el año nuevo no aparecia hasta contabilizar el primero.
 */
export async function ejerciciosDisponibles(companyId: string, ahora: Date = new Date()): Promise<number[]> {
  const actual = anioEspana(ahora);
  const [conAsientos, ejercicios] = await Promise.all([
    prisma.$queryRaw<Array<{ anio: number | bigint }>>`SELECT DISTINCT YEAR(fecha) AS anio FROM JournalEntry WHERE companyId = ${companyId} AND estado = 'POSTED'`,
    prisma.fiscalYear.findMany({ where: { companyId }, select: { label: true } }),
  ]);
  const anios = new Set<number>([actual, actual + 1]);
  for (const f of conAsientos) anios.add(Number(f.anio));
  for (const e of ejercicios) if (/^\d{4}$/.test(e.label)) anios.add(Number(e.label));
  return [...anios].filter((a) => Number.isInteger(a) && a >= 1990).sort((a, b) => b - a);
}

const aSimple = (a: AsientoInforme): AsientoSimple => ({
  idasiento: a.id,
  fecha: a.fecha,
  numero: a.numero,
  concepto: a.concepto,
  tipo: a.tipo,
  lineas: a.lineas.map((l) => ({ subcuenta: l.cuenta, debe: l.debe, haber: l.haber })),
});

/** Misma fecha un año antes (el 29-02 pasa a 28-02). */
const unAnioAntes = (iso: string): string => {
  const y = Number(iso.slice(0, 4)) - 1;
  const md = iso.slice(5) === '02-29' ? '02-28' : iso.slice(5);
  return `${y}-${md}`;
};
const diaAnterior = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------------
// Balance de situacion y PyG (modelo PYMES, con N-1)
// ---------------------------------------------------------------------------

const ROMANOS = /^[IVX]+$/;
const PADRES_BALANCE: Record<string, string> = {
  'B.III': 'Deudores comerciales y otras cuentas a cobrar',
  'D.IV': 'Acreedores comerciales y otras cuentas a pagar',
};

/** Etiqueta de una partida: "I. Inmovilizado intangible", "1. Clientes...". */
function etiquetaPartida(codigo: string, descripcion: string): string {
  const ultima = codigo.split('.').pop() ?? '';
  return ROMANOS.test(ultima) || /^\d+$/.test(ultima) ? `${ultima}. ${descripcion}` : descripcion;
}

interface ColumnasEstado {
  actual: string;
  anterior: string;
}

/** Filas de un bloque del balance, con los padres B.III / D.IV sumados. */
function filasMasa(actual: BalancePartida[], anterior: BalancePartida[], sangria: number): FilaInforme[] {
  const ant = new Map(anterior.map((p) => [p.codigo, p.importe]));
  const filas: FilaInforme[] = [];
  const hechos = new Set<string>();
  for (const p of actual) {
    const partes = p.codigo.split('.');
    if (partes.length === 3) {
      const padre = partes.slice(0, 2).join('.');
      if (hechos.has(padre)) continue;
      hechos.add(padre);
      const hijos = actual.filter((h) => h.codigo.startsWith(`${padre}.`));
      const n = round2(hijos.reduce((s, h) => s + h.importe, 0));
      const n1 = round2(hijos.reduce((s, h) => s + (ant.get(h.codigo) ?? 0), 0));
      if (!n && !n1) continue;
      filas.push({ celdas: [etiquetaPartida(padre, PADRES_BALANCE[padre] ?? padre), n, n1], sangria });
      for (const h of hijos) {
        const hn1 = ant.get(h.codigo) ?? 0;
        if (h.importe || hn1) filas.push({ celdas: [etiquetaPartida(h.codigo, h.descripcion), h.importe, hn1], sangria: sangria + 1 });
      }
      continue;
    }
    const n1 = ant.get(p.codigo) ?? 0;
    if (p.importe || n1) filas.push({ celdas: [etiquetaPartida(p.codigo, p.descripcion), p.importe, n1], sangria });
  }
  return filas;
}

/** Nota de la columna del año anterior cuando sale de los saldos importados. */
const NOTA_COMPARATIVO = (anio: number) => `La columna ${anio} sale de los saldos que dio la gestoría (comparativo importado).`;

const suma = (ps: BalancePartida[]) => round2(ps.reduce((s, p) => s + p.importe, 0));

export async function informeBalance(companyId: string, periodo: Periodo) {
  const hastaAnt = unAnioAntes(periodo.hasta);
  const todos = (await cargarAsientos(companyId, periodo.hasta)).map(aSimple);
  const corte = (d: string) => todos.filter((a) => a.fecha <= d);
  const saldos = saldosDelEjercicio(corte(periodo.hasta), periodo.ejercicio);
  const cierreAnual = periodo.hasta.endsWith('-12-31');
  // Al cierre del año, la columna N-1 sigue la regla unica (los saldos de la gestoria si ese año lo llevo ella).
  const fuenteAnt = cierreAnual ? await fuenteEjercicioAnterior(companyId, periodo.ejercicio - 1, saldosDelEjercicio(corte(hastaAnt), periodo.ejercicio - 1)) : null;
  const saldosAnt = fuenteAnt ? fuenteAnt.saldos : saldosDelEjercicio(corte(hastaAnt), periodo.ejercicio - 1);
  const saldosAnt2 = saldosDelEjercicio(corte(unAnioAntes(hastaAnt)), periodo.ejercicio - 2);
  const { balance: bal } = calcularEstadosDesdeSaldos(saldos, saldosAnt);
  const { balance: balAnt } = calcularEstadosDesdeSaldos(saldosAnt, saldosAnt2);
  const normalizar = (b: typeof bal) => ({
    ...b,
    activoNoCorriente: partidas(b.activoNoCorriente),
    activoCorriente: partidas(b.activoCorriente),
    patrimonioNeto: partidas(b.patrimonioNeto),
    pasivoNoCorriente: partidas(b.pasivoNoCorriente),
    pasivoCorriente: partidas(b.pasivoCorriente),
  });
  const balance = normalizar(bal);
  const anterior = normalizar(balAnt);

  const cols: ColumnasEstado = cierreAnual
    ? { actual: String(periodo.ejercicio), anterior: String(periodo.ejercicio - 1) }
    : { actual: fechaES(periodo.hasta), anterior: fechaES(hastaAnt) };

  const pnF = balance.patrimonioNeto.filter((p) => p.codigo.startsWith('A1.'));
  const pnFAnt = anterior.patrimonioNeto.filter((p) => p.codigo.startsWith('A1.'));
  const pnS = balance.patrimonioNeto.filter((p) => !p.codigo.startsWith('A1.'));
  const pnSAnt = anterior.patrimonioNeto.filter((p) => !p.codigo.startsWith('A1.'));
  const masa = (titulo: string, a: BalancePartida[], b: BalancePartida[]): FilaInforme[] => [
    { celdas: [titulo, suma(a), suma(b)], estilo: 'subtotal' },
    ...filasMasa(a, b, 1),
  ];

  const filas: FilaInforme[] = [
    { celdas: ['ACTIVO', null, null], estilo: 'seccion' },
    ...masa('A) ACTIVO NO CORRIENTE', balance.activoNoCorriente, anterior.activoNoCorriente),
    ...masa('B) ACTIVO CORRIENTE', balance.activoCorriente, anterior.activoCorriente),
    { celdas: ['TOTAL ACTIVO (A + B)', balance.totalActivo, anterior.totalActivo], estilo: 'total' },
    { celdas: ['PATRIMONIO NETO Y PASIVO', null, null], estilo: 'seccion' },
    { celdas: ['A) PATRIMONIO NETO', suma(balance.patrimonioNeto), suma(anterior.patrimonioNeto)], estilo: 'subtotal' },
    { celdas: ['A-1) Fondos propios', suma(pnF), suma(pnFAnt)], sangria: 1 },
    ...filasMasa(pnF, pnFAnt, 2),
    ...(suma(pnS) || suma(pnSAnt) ? [{ celdas: ['A-2) Subvenciones, donaciones y legados recibidos', suma(pnS), suma(pnSAnt)], sangria: 1 }] : []),
    ...masa('B) PASIVO NO CORRIENTE', balance.pasivoNoCorriente, anterior.pasivoNoCorriente),
    ...masa('C) PASIVO CORRIENTE', balance.pasivoCorriente, anterior.pasivoCorriente),
    {
      celdas: ['TOTAL PATRIMONIO NETO Y PASIVO (A + B + C)', balance.totalPatrimonioNetoYPasivo, anterior.totalPatrimonioNetoYPasivo],
      estilo: 'total',
    },
  ];

  const notas: string[] = ['Modelo de balance del PGC de PYMES. No incluye los asientos de regularización ni de cierre.'];
  if (fuenteAnt?.fuente === 'COMPARATIVO') notas.push(NOTA_COMPARATIVO(periodo.ejercicio - 1));
  if (balance.descuadre) {
    notas.push(`Atención: el balance no cuadra (diferencia de ${num(balance.descuadre)} ${await simboloCuenta(companyId)}). Revisa los asientos.`);
  }

  const tabla: TablaInforme = {
    titulo: 'Balance de situación',
    periodo: cierreAnual ? `Ejercicio ${periodo.ejercicio} (a 31/12/${periodo.ejercicio})` : `A ${fechaES(periodo.hasta)}`,
    empresa: await datosEmpresa(companyId),
    columnas: [
      { titulo: 'Partida', tipo: 'texto', ancho: 9 },
      { titulo: cols.actual, tipo: 'importe', ancho: 2 },
      { titulo: cols.anterior, tipo: 'importe', ancho: 2 },
    ],
    filas,
    notas,
    fichero: `balance_situacion_${periodo.hasta}`,
  };
  return { periodo, balance, anterior, cuadra: !balance.descuadre, tabla };
}

const PYG_SUBTOTALES: Array<{ despuesDe: string; titulo: string; clave: 'explotacion' | 'financiero' | 'antes' }> = [
  { despuesDe: '12', titulo: 'A) RESULTADO DE EXPLOTACIÓN (1 a 12)', clave: 'explotacion' },
  { despuesDe: '17', titulo: 'B) RESULTADO FINANCIERO (13 a 17)', clave: 'financiero' },
];

export async function informePerdidasGanancias(companyId: string, periodo: Periodo) {
  const desdeAnt = unAnioAntes(periodo.desde);
  const hastaAnt = unAnioAntes(periodo.hasta);
  const todos = (await cargarAsientos(companyId, periodo.hasta)).map(aSimple);

  // Saldos de 6/7 del ejercicio hasta una fecha; un periodo que no empieza el
  // 1 de enero es la diferencia entre dos cortes.
  const pygHasta = (hasta: string, ejercicio: number) =>
    saldosDelEjercicio(todos.filter((a) => a.fecha <= hasta), ejercicio).pyg;
  const pygPeriodo = (desde: string, hasta: string, ejercicio: number) => {
    const fin = pygHasta(hasta, ejercicio);
    if (desde.endsWith('-01-01')) return fin;
    const ini = pygHasta(diaAnterior(desde), ejercicio);
    const r = new Map(fin);
    for (const [c, s] of ini) r.set(c, round2((r.get(c) ?? 0) - s));
    return r;
  };
  const actual = calcularPyGModelo(pygPeriodo(periodo.desde, periodo.hasta, periodo.ejercicio));
  const anualCompleto = periodo.desde.endsWith('-01-01') && periodo.hasta.endsWith('-12-31');
  // Año completo: la columna N-1 sigue la regla unica (los saldos de la gestoria si ese año lo llevo ella).
  const fuenteAnt = anualCompleto ? await fuenteEjercicioAnterior(companyId, periodo.ejercicio - 1, saldosDelEjercicio(todos.filter((a) => a.fecha <= hastaAnt), periodo.ejercicio - 1)) : null;
  const anterior = calcularPyGModelo(fuenteAnt ? fuenteAnt.saldos.pyg : pygPeriodo(desdeAnt, hastaAnt, periodo.ejercicio - 1));
  const ant = new Map(anterior.partidas.map((p) => [p.codigo, p.importe]));
  const valores = {
    explotacion: [actual.resultadoExplotacion, anterior.resultadoExplotacion],
    financiero: [actual.resultadoFinanciero, anterior.resultadoFinanciero],
    antes: [actual.resultadoAntesImpuestos, anterior.resultadoAntesImpuestos],
  };
  const filas: FilaInforme[] = [];
  for (const p of actual.partidas) {
    if (p.codigo === '18') {
      filas.push({ celdas: ['C) RESULTADO ANTES DE IMPUESTOS (A + B)', ...valores.antes], estilo: 'subtotal' });
    }
    const n1 = ant.get(p.codigo) ?? 0;
    if (p.importe || n1) filas.push({ celdas: [`${p.codigo}. ${p.descripcion}`, p.importe, n1], sangria: 1 });
    const sub = PYG_SUBTOTALES.find((s) => s.despuesDe === p.codigo);
    if (sub) filas.push({ celdas: [sub.titulo, ...valores[sub.clave]], estilo: 'subtotal' });
  }
  filas.push({ celdas: ['D) RESULTADO DEL EJERCICIO (C + 18)', actual.resultadoEjercicio, anterior.resultadoEjercicio], estilo: 'total' });

  const tabla: TablaInforme = {
    titulo: 'Pérdidas y ganancias',
    periodo: textoPeriodo(periodo.desde, periodo.hasta),
    empresa: await datosEmpresa(companyId),
    columnas: [
      { titulo: 'Partida', tipo: 'texto', ancho: 9 },
      { titulo: anualCompleto ? String(periodo.ejercicio) : `${fechaES(periodo.desde)}-${fechaES(periodo.hasta)}`, tipo: 'importe', ancho: 2 },
      { titulo: anualCompleto ? String(periodo.ejercicio - 1) : `${fechaES(desdeAnt)}-${fechaES(hastaAnt)}`, tipo: 'importe', ancho: 2 },
    ],
    filas,
    notas: [
      'Modelo de cuenta de pérdidas y ganancias del PGC de PYMES. Ingresos en positivo y gastos en negativo. Sin asientos de regularización ni de cierre.',
      ...(fuenteAnt?.fuente === 'COMPARATIVO' ? [NOTA_COMPARATIVO(periodo.ejercicio - 1)] : []),
    ],
    fichero: `perdidas_ganancias_${periodo.desde}_${periodo.hasta}`,
  };
  return { periodo, actual, anterior, tabla };
}

// ---------------------------------------------------------------------------
// Sumas y saldos, mayor y diario
// ---------------------------------------------------------------------------

export interface OpcionesSumasSaldos {
  /** Solo un prefijo o un rango de cuentas (430-430 = solo clientes; 410-410 = solo acreedores). */
  filtro?: FiltroCuentas;
  /** Por subcuenta: oculta las subcuentas del plan sin movimientos (por defecto, si). */
  ocultarSinMovimiento?: boolean;
}

/** Subcuentas activas del plan de la empresa (mas de 3 digitos), para enseñarlas aunque no tengan movimientos. */
async function subcuentasDelPlan(companyId: string): Promise<string[]> {
  const filas = await prisma.chartOfAccounts
    .findMany({ where: { companyId, activo: true }, select: { codigo: true } })
    .catch(() => [] as Array<{ codigo: string }>);
  return filas.map((f) => f.codigo).filter((c) => c.length > 3);
}

const textoFiltro = (f: FiltroCuentas | undefined): string | null => {
  if (!f) return null;
  if (f.cuenta) return `cuenta ${f.cuenta}`;
  if (f.desde || f.hasta) return f.desde === f.hasta ? `cuentas ${f.desde}` : `cuentas ${f.desde ?? '1'} a ${f.hasta ?? '9'}`;
  return null;
};

export async function informeSumasYSaldos(companyId: string, periodo: Periodo, nivel: NivelSumas, opciones: OpcionesSumasSaldos = {}) {
  const todos = await cargarAsientos(companyId, periodo.hasta);
  const nombre = await nombrador(companyId, todos);
  const ocultar = opciones.ocultarSinMovimiento ?? true;
  const r = calcularSumasYSaldos(movimientosDelPeriodo(todos, periodo), nivel, nombre, {
    filtro: opciones.filtro,
    cuentasSinMovimiento: nivel === 'subcuenta' && !ocultar ? await subcuentasDelPlan(companyId) : undefined,
  });
  const t = r.totales;
  // Tras las filas de cada cuenta de 3 digitos, su subtotal.
  const subtotal = new Map(r.subtotales.map((s) => [s.cuenta, s]));
  const filasTabla: FilaInforme[] = [];
  r.filas.forEach((f, i) => {
    filasTabla.push({ celdas: [f.cuenta, f.nombre, f.saldoInicial, f.debe, f.haber, f.saldoDeudor, f.saldoAcreedor] });
    const grupo = f.cuenta.slice(0, 3);
    const s = subtotal.get(grupo);
    if (s && r.filas[i + 1]?.cuenta.slice(0, 3) !== grupo) {
      filasTabla.push({ celdas: [s.cuenta, `Total ${s.cuenta} ${s.nombre}`.trim(), s.saldoInicial, s.debe, s.haber, s.saldoDeudor, s.saldoAcreedor], estilo: 'subtotal' });
    }
  });
  const queCuentas = textoFiltro(opciones.filtro);
  const tabla: TablaInforme = {
    titulo: 'Balance de sumas y saldos',
    periodo: `${textoPeriodo(periodo.desde, periodo.hasta)}${queCuentas ? ` · ${queCuentas}` : ''}`,
    empresa: await datosEmpresa(companyId),
    apaisado: true,
    columnas: [
      { titulo: 'Cuenta', tipo: 'codigo', ancho: 2.2 },
      { titulo: 'Nombre', tipo: 'texto', ancho: 6 },
      { titulo: 'Saldo inicial', tipo: 'importe', ancho: 2 },
      { titulo: 'Debe', tipo: 'importe', ancho: 2 },
      { titulo: 'Haber', tipo: 'importe', ancho: 2 },
      { titulo: 'Saldo deudor', tipo: 'importe', ancho: 2 },
      { titulo: 'Saldo acreedor', tipo: 'importe', ancho: 2 },
    ],
    filas: [...filasTabla, { celdas: ['', 'Totales', t.saldoInicial, t.debe, t.haber, t.saldoDeudor, t.saldoAcreedor], estilo: 'total' as const }],
    notas: [
      nivel === 'subcuenta'
        ? `Por subcuenta, con el total de cada cuenta de 3 dígitos${ocultar ? '' : ' (incluye las subcuentas sin movimientos)'}.`
        : `Agrupado por cuentas de ${nivel} dígitos.`,
      ...(queCuentas ? [`Solo ${queCuentas}.`] : []),
      'Saldo inicial: deudor en positivo y acreedor en negativo. Sin asientos de regularización ni de cierre.',
      // Con un filtro el debe y el haber no tienen por que cuadrar: solo se avisa con todas las cuentas.
      ...(r.cuadra || queCuentas ? [] : ['Atención: las sumas no cuadran. Revisa los asientos.']),
    ],
    fichero: `sumas_y_saldos_${queCuentas ? `${queCuentas.replace(/\D+/g, '-')}_` : ''}${periodo.desde}_${periodo.hasta}`.replace(/-+_/g, '_'),
  };
  return { periodo, nivel, filtro: opciones.filtro ?? null, ocultarSinMovimiento: ocultar, ...r, tabla };
}

/** Cliente o proveedor elegido en el Libro mayor: su mayor son sus subcuentas. */
export interface TerceroDelMayor {
  tipo: 'cliente' | 'proveedor';
  id: string;
  nombre: string;
  nif: string | null;
  subcuentas: string[];
}

/** Ficha y subcuentas de un cliente o proveedor (404 si no es de la empresa). */
export async function terceroParaMayor(companyId: string, tipo: 'cliente' | 'proveedor', id: string): Promise<TerceroDelMayor> {
  if (tipo === 'cliente') {
    const c = await prisma.customer.findFirst({ where: { id, companyId }, select: { id: true, nombreFiscal: true, nifCif: true, subcuenta430: true } });
    if (!c) throw notFound('Cliente no encontrado.');
    return { tipo, id: c.id, nombre: c.nombreFiscal, nif: c.nifCif, subcuentas: c.subcuenta430 ? [c.subcuenta430] : [] };
  }
  const p = await prisma.supplier.findFirst({ where: { id, companyId }, select: { id: true, nombreFiscal: true, nifCif: true, subcuenta400: true, subcuenta410: true } });
  if (!p) throw notFound('Proveedor no encontrado.');
  return { tipo, id: p.id, nombre: p.nombreFiscal, nif: p.nifCif, subcuentas: [p.subcuenta400, p.subcuenta410].filter((x): x is string => !!x) };
}

/**
 * Aviso para el mayor de un cliente: sus ventas emitidas en el periodo que no
 * tienen asiento contabilizado y por eso no salen en el mayor (p. ej. una venta
 * del lector cuyo asiento no llego a crearse, o que sigue en borrador sin
 * aprobar). Sin ellas un mayor puede salir vacio sin que se sepa por que.
 * null si no hay ninguna o si ese año lo llevo la gestoria.
 */
export async function avisoFacturasSinAsiento(companyId: string, tipo: TipoTercero, terceroId: string, periodo: Periodo): Promise<string | null> {
  if (tipo !== 'clientes' || terceroId === SIN_IDENTIFICAR || terceroId.startsWith('subcuenta:')) return null;
  const externo = await prisma.fiscalYear.findFirst({ where: { companyId, label: String(periodo.ejercicio), llevanza: 'EXTERNA' }, select: { id: true } });
  if (externo) return null;
  const facturas = await prisma.incomeInvoice.findMany({
    where: { companyId, customerId: terceroId, estadoDocumento: 'FINAL', fechaEmision: { gte: periodo.desde, lte: periodo.hasta } },
    select: { id: true, numeroCompleto: true, totalFactura: true },
    orderBy: { fechaEmision: 'asc' },
  });
  if (!facturas.length) return null;
  // El asiento de la factura (no el de su cobro), como en cobrosPagos.cuentaTerceroDeFactura.
  const asientos = await prisma.journalEntry.findMany({
    where: { companyId, invoiceId: { in: facturas.map((f) => f.id) }, invoiceType: 'INGRESO', origen: { not: 'TESORERIA' } },
    select: { invoiceId: true, estado: true },
  });
  const estados = new Map<string, Set<string>>();
  for (const a of asientos) {
    const s = estados.get(a.invoiceId!) ?? new Set<string>();
    s.add(a.estado);
    estados.set(a.invoiceId!, s);
  }
  const moneda = await simboloCuenta(companyId);
  const texto = (fs: typeof facturas) => fs.map((f) => `${f.numeroCompleto ?? 'sin número'} (${num(Number(f.totalFactura))} ${moneda})`).join(', ');
  // Sin ningun asiento; o con el asiento sin aprobar (borrador o pendiente de revision).
  const sinAsiento = facturas.filter((f) => !estados.has(f.id));
  const sinAprobar = facturas.filter((f) => {
    const s = estados.get(f.id);
    return !!s && !s.has('POSTED') && !s.has('REVERSED');
  });
  const avisos: string[] = [];
  if (sinAsiento.length === 1) avisos.push(`la venta ${texto(sinAsiento)} no tiene asiento y no sale en el mayor. Contabilízala desde la ficha de la factura.`);
  else if (sinAsiento.length) avisos.push(`las ventas ${texto(sinAsiento)} no tienen asiento y no salen en el mayor. Contabilízalas desde la ficha de cada factura.`);
  if (sinAprobar.length === 1) avisos.push(`la venta ${texto(sinAprobar)} tiene el asiento sin aprobar y no sale en el mayor hasta que lo apruebes en el Motor contable.`);
  else if (sinAprobar.length) avisos.push(`las ventas ${texto(sinAprobar)} tienen el asiento sin aprobar y no salen en el mayor hasta que los apruebes en el Motor contable.`);
  if (!avisos.length) return null;
  return `Atención: ${avisos.map((a, i) => (i ? a.charAt(0).toUpperCase() + a.slice(1) : a)).join(' ')}`;
}

export async function informeMayor(companyId: string, periodo: Periodo, filtroCuentas: FiltroCuentas, tercero?: TerceroDelMayor) {
  // Con un cliente o proveedor: solo sus subcuentas (una ficha sin subcuenta no tiene mayor propio).
  const filtro: FiltroCuentas = tercero ? { lista: tercero.subcuentas } : filtroCuentas;
  const todos = await cargarAsientos(companyId, periodo.hasta);
  const nombre = await nombrador(companyId, todos);
  const cuentas = calcularMayor(movimientosDelPeriodo(todos, periodo), filtro, nombre);

  // Columnas: Fecha, Asiento, Concepto, Referencia, Debe, Haber y Saldo. Cada
  // cifra en la suya: el saldo inicial y el final en Saldo, las sumas en Debe y Haber.
  const filas: FilaInforme[] = [];
  for (const c of cuentas) {
    // La cuenta va como rotulo en la columna Concepto (en la de Fecha seria una celda corrida en Excel).
    filas.push({ celdas: [null, null, `${c.cuenta} · ${c.nombre}`, null, null, null, null], estilo: 'seccion' });
    filas.push({ celdas: [null, null, 'Saldo inicial', null, null, null, c.saldoInicial], estilo: 'nota' });
    for (const m of c.movimientos) filas.push({ celdas: [m.fecha, m.asiento, m.concepto, m.referencia, m.debe, m.haber, m.saldo] });
    filas.push({ celdas: [null, null, `Totales y saldo final ${c.cuenta}`, null, c.totalDebe, c.totalHaber, c.saldoFinal], estilo: 'subtotal' });
  }
  if (cuentas.length > 1) {
    filas.push({
      celdas: [
        null,
        null,
        `Totales y saldo final de las ${cuentas.length} cuentas`,
        null,
        round2(cuentas.reduce((s, c) => s + c.totalDebe, 0)),
        round2(cuentas.reduce((s, c) => s + c.totalHaber, 0)),
        round2(cuentas.reduce((s, c) => s + c.saldoFinal, 0)),
      ],
      estilo: 'total',
    });
  }
  const queCuentas = tercero
    ? `${tercero.tipo === 'cliente' ? 'cliente' : 'proveedor'} ${tercero.nombre}${tercero.nif ? ` (${tercero.nif})` : ''}${tercero.subcuentas.length ? `, ${tercero.subcuentas.length > 1 ? 'subcuentas' : 'subcuenta'} ${tercero.subcuentas.join(' y ')}` : ''}`
    : filtro.cuenta
      ? `cuenta ${filtro.cuenta}`
      : `cuentas ${filtro.desde ?? '1'} a ${filtro.hasta ?? '9'}`;
  const sinMovimientos = tercero && !tercero.subcuentas.length
    ? `${tercero.nombre} aún no tiene subcuenta contable: no hay movimientos a su nombre.`
    : 'No hay movimientos en esas cuentas en el periodo.';
  const sinAsiento = tercero?.tipo === 'cliente' ? await avisoFacturasSinAsiento(companyId, 'clientes', tercero.id, periodo) : null;
  const tabla: TablaInforme = {
    titulo: 'Libro mayor',
    periodo: `${textoPeriodo(periodo.desde, periodo.hasta)} · ${queCuentas}`,
    empresa: await datosEmpresa(companyId),
    apaisado: true,
    columnas: [
      { titulo: 'Fecha', tipo: 'fecha', ancho: 1.7 },
      { titulo: 'Asiento', tipo: 'codigo', ancho: 2.4 },
      { titulo: 'Concepto', tipo: 'texto', ancho: 6.5 },
      { titulo: 'Referencia', tipo: 'texto', ancho: 2.2 },
      { titulo: 'Debe', tipo: 'importe', ancho: 2 },
      { titulo: 'Haber', tipo: 'importe', ancho: 2 },
      { titulo: 'Saldo', tipo: 'importe', ancho: 2, saldo: true },
    ],
    filas,
    notas: [
      'Saldo: deudor en positivo y acreedor en negativo; en cada fila, el saldo anterior más el Debe y menos el Haber. Movimientos por fecha de asiento. Sin asientos de regularización ni de cierre.',
      ...(cuentas.length ? [] : [sinMovimientos]),
      ...(sinAsiento ? [sinAsiento] : []),
    ],
    fichero: `libro_mayor_${tercero ? tercero.nombre : (filtro.cuenta ?? `${filtro.desde ?? ''}-${filtro.hasta ?? ''}`)}_${periodo.desde}_${periodo.hasta}`,
  };
  return { periodo, filtro, tercero: tercero ?? null, cuentas, tabla };
}

const NOMBRE_TIPO: Record<string, string> = { APERTURA: 'Apertura', REGULARIZACION: 'Regularización', CIERRE: 'Cierre' };

export async function informeDiario(companyId: string, periodo: Periodo, incluirCierre: boolean) {
  const todos = await cargarAsientos(companyId, periodo.hasta);
  const nombre = await nombrador(companyId, todos);
  const { asientos } = movimientosDelPeriodo(todos, periodo, { incluirCierre });
  const diario = calcularDiario(asientos, nombre);

  const filas: FilaInforme[] = [];
  for (const a of diario.asientos) {
    const concepto = NOMBRE_TIPO[a.tipo] && !a.concepto.toLowerCase().startsWith(NOMBRE_TIPO[a.tipo].toLowerCase().slice(0, 6))
      ? `${NOMBRE_TIPO[a.tipo]}: ${a.concepto}`
      : a.concepto;
    filas.push({ celdas: [a.fecha, a.numero, concepto, null, null], estilo: 'seccion' });
    for (const l of a.lineas) filas.push({ celdas: [null, l.cuenta, l.nombre, l.debe, l.haber], sangria: 1 });
  }
  filas.push({ celdas: [null, null, `Total (${diario.asientos.length} asientos)`, diario.totalDebe, diario.totalHaber], estilo: 'total' });

  const tabla: TablaInforme = {
    titulo: 'Libro diario',
    periodo: textoPeriodo(periodo.desde, periodo.hasta),
    empresa: await datosEmpresa(companyId),
    columnas: [
      { titulo: 'Fecha', tipo: 'fecha', ancho: 1.6 },
      { titulo: 'Asiento / cuenta', tipo: 'codigo', ancho: 2.6 },
      { titulo: 'Concepto / nombre de la cuenta', tipo: 'texto', ancho: 6.5 },
      { titulo: 'Debe', tipo: 'importe', ancho: 2 },
      { titulo: 'Haber', tipo: 'importe', ancho: 2 },
    ],
    filas,
    notas: [incluirCierre ? 'Incluye los asientos de regularización y de cierre.' : 'Sin asientos de regularización ni de cierre.'],
    fichero: `libro_diario_${periodo.desde}_${periodo.hasta}`,
  };
  return { periodo, incluirCierre, ...diario, tabla };
}

// ---------------------------------------------------------------------------
// Mayor de clientes y proveedores
// ---------------------------------------------------------------------------

const TITULO_TERCEROS: Record<TipoTercero, string> = { clientes: 'Mayor de clientes', proveedores: 'Mayor de proveedores' };

const sinTildes = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Desde donde se suma el mayor de terceros: si un año anterior lo llevo la
 * gestoria y el siguiente tiene la apertura importada, desde esa apertura.
 */
async function inicioTercerosTrasGestoria(companyId: string, hasta: string, todos: Array<{ fecha: string; tipo?: string }>): Promise<string | null> {
  const anio = Number(hasta.slice(0, 4));
  const externo = await prisma.fiscalYear.findFirst({
    where: { companyId, llevanza: 'EXTERNA' },
    orderBy: { label: 'desc' },
    select: { label: true },
  });
  const siguiente = externo ? Number(externo.label) + 1 : NaN;
  if (!Number.isInteger(siguiente) || siguiente > anio) return null;
  const inicio = `${siguiente}-01-01`;
  return todos.some((a) => a.tipo === 'APERTURA' && a.fecha.startsWith(`${siguiente}-`)) ? inicio : null;
}

async function calcularTerceros(companyId: string, tipo: TipoTercero, periodo: Periodo) {
  const todos = await cargarAsientos(companyId, periodo.hasta);
  const inicio = await inicioTercerosTrasGestoria(companyId, periodo.hasta, todos);
  const nombre = await nombrador(companyId, todos);
  const [facturas, fichas] =
    tipo === 'clientes'
      ? await Promise.all([
          prisma.incomeInvoice.findMany({ where: { companyId }, select: { id: true, numeroCompleto: true, customerId: true } }),
          prisma.customer.findMany({ where: { companyId }, select: { id: true, nombreFiscal: true, nifCif: true, subcuenta430: true } }),
        ]).then(
          ([f, c]) =>
            [
              f.map((x) => ({ id: x.id, numero: x.numeroCompleto, terceroId: x.customerId })),
              c.map((x) => ({ id: x.id, nombreFiscal: x.nombreFiscal, nifCif: x.nifCif, subcuentas: x.subcuenta430 ? [x.subcuenta430] : [] })),
            ] as const,
        )
      : await Promise.all([
          prisma.expenseInvoice.findMany({ where: { companyId }, select: { id: true, numeroCompleto: true, supplierId: true } }),
          prisma.supplier.findMany({ where: { companyId }, select: { id: true, nombreFiscal: true, nifCif: true, subcuenta400: true, subcuenta410: true } }),
        ]).then(
          ([f, s]) =>
            [
              f.map((x) => ({ id: x.id, numero: x.numeroCompleto, terceroId: x.supplierId })),
              s.map((x) => ({ id: x.id, nombreFiscal: x.nombreFiscal, nifCif: x.nifCif, subcuentas: [x.subcuenta400, x.subcuenta410].filter((c): c is string => !!c) })),
            ] as const,
        );

  const terceros = calcularMayorTerceros(
    todos,
    periodo,
    { tipo, facturas, fichas: fichas.map((f) => ({ id: f.id, nombre: f.nombreFiscal, nif: f.nifCif, subcuentas: f.subcuentas })) },
    nombre,
    inicio,
  );
  // Subcuentas propias de cada ficha (para la columna Subcuenta y las fichas sin movimientos).
  const subcuentas = new Map(fichas.map((f) => [f.id, f.subcuentas]));
  return terceros.map((t) => ({ ...t, subcuentas: subcuentas.get(t.id) ?? (t.id.startsWith('subcuenta:') ? [t.id.slice('subcuenta:'.length)] : []) }));
}

/**
 * Lo pendiente segun las facturas, por tercero, a una fecha: facturas de venta
 * emitidas (o de gasto) hasta `hasta`, menos sus cobros (o pagos) activos con
 * fecha hasta `hasta`. Sirve para cruzarlo con el saldo contable. Una factura
 * de venta marcada como cobrada a mano, sin cobros registrados, cuenta como
 * cobrada entera. Los borradores no cuentan: ni las ventas sin emitir ni las
 * facturas de gasto en DRAFT (mismo criterio que los modelos fiscales).
 *
 * Exportada para Carmen (INT-06, lo que se debe a proveedores). Solo lee.
 */
export interface FacturaPendiente {
  id: string;
  terceroId: string;
  numeroCompleto: string | null;
  fechaEmision: string;
  fechaVencimiento: string;
  totalFactura: number;
  importePendiente: number;
  estado: string;
}

export interface OpcionesPendientes {
  /**
   * Para cruzar con el mayor por tercero: si un año anterior lo llevo la
   * gestoria (llevanza EXTERNA), sus facturas no cuentan (su saldo entro con
   * la apertura) y en su lugar cuentan las partidas pendientes que trajo la
   * carga, con lo cobrado, pagado o descontado con abonos hasta `hasta`.
   */
  conPartidas?: boolean;
}

export async function pendientesSegunFacturas(companyId: string, tipo: TipoTercero, hasta: string, opciones: OpcionesPendientes = {}): Promise<FacturaPendiente[]> {
  const tipoDoc = tipo === 'clientes' ? 'INGRESO' : 'GASTO';
  const cobrado = await cobradoPorFactura(companyId, tipoDoc, hasta);
  const finExterna = opciones.conPartidas ? await finLlevanzaExternaAntesDe(companyId, hasta) : null;
  const facturas =
    tipo === 'clientes'
      ? (
          await prisma.incomeInvoice.findMany({
            where: { companyId, estadoDocumento: 'FINAL', fechaEmision: { lte: hasta, ...(finExterna ? { gt: finExterna } : {}) } },
            select: { id: true, customerId: true, numeroCompleto: true, fechaEmision: true, fechaVencimiento: true, totalFactura: true, estado: true },
            orderBy: { fechaEmision: 'asc' },
          })
        ).map(({ customerId, ...f }) => ({ ...f, terceroId: customerId }))
      : (
          await prisma.expenseInvoice.findMany({
            where: { companyId, ...GASTO_VIGENTE, fechaEmision: { lte: hasta } },
            select: { id: true, supplierId: true, numeroCompleto: true, fechaEmision: true, fechaRegistro: true, fechaVencimiento: true, totalFactura: true, estadoPago: true },
            orderBy: { fechaEmision: 'asc' },
          })
        )
          // Con la gestoria: fuera las que se contabilizaron en un año que llevo ella.
          .filter((f) => !finExterna || fechaContableGasto(f) > finExterna)
          .map(({ supplierId, estadoPago, fechaRegistro: _r, ...f }) => ({ ...f, terceroId: supplierId, estado: estadoPago }));
  const deFacturas = facturas
    .map((f) => {
      const total = Number(f.totalFactura);
      return { ...f, totalFactura: total, importePendiente: calcularPendiente(tipoDoc, total, f.estado, cobrado.get(f.id) ?? 0) };
    })
    .filter((f) => f.importePendiente !== 0);
  if (!finExterna) return deFacturas;
  return [...deFacturas, ...(await partidasComoFacturas(companyId, tipo, hasta))];
}

/** Fin del ultimo ejercicio que llevo la gestoria y acabo antes de `hasta` (null si no hay). */
async function finLlevanzaExternaAntesDe(companyId: string, hasta: string): Promise<string | null> {
  const fy = await prisma.fiscalYear.findFirst({
    where: { companyId, llevanza: 'EXTERNA', fechaFin: { lt: hasta } },
    orderBy: { fechaFin: 'desc' },
    select: { fechaFin: true },
  });
  return fy?.fechaFin.slice(0, 10) ?? null;
}

/**
 * Partidas pendientes de la carga (facturas de la gestoria que quedaron por
 * cobrar o pagar) con la forma de una factura pendiente. El tercero es el de la
 * partida o, si no lo tiene, la ficha con esa subcuenta; sin ninguno no sale.
 */
async function partidasComoFacturas(companyId: string, tipo: TipoTercero, hasta: string): Promise<FacturaPendiente[]> {
  const partidasA = await partidasPendientesA(companyId, tipo === 'clientes' ? 'COBRO' : 'PAGO', hasta);
  if (!partidasA.length) return [];
  const porSubcuenta = new Map<string, string>();
  if (partidasA.some((p) => !p.terceroId)) {
    if (tipo === 'clientes') {
      for (const c of await prisma.customer.findMany({ where: { companyId, subcuenta430: { not: null } }, select: { id: true, subcuenta430: true } })) {
        porSubcuenta.set(c.subcuenta430!, c.id);
      }
    } else {
      for (const p of await prisma.supplier.findMany({ where: { companyId }, select: { id: true, subcuenta400: true, subcuenta410: true } })) {
        if (p.subcuenta400) porSubcuenta.set(p.subcuenta400, p.id);
        if (p.subcuenta410) porSubcuenta.set(p.subcuenta410, p.id);
      }
    }
  }
  return partidasA.flatMap((p) => {
    const terceroId = p.terceroId ?? porSubcuenta.get(p.subcuenta);
    if (!terceroId) return [];
    return [
      {
        id: p.id,
        terceroId,
        numeroCompleto: p.numeroDocumento,
        fechaEmision: p.fechaDocumento ?? '',
        fechaVencimiento: p.fechaVencimiento ?? '',
        totalFactura: p.importeInicial,
        importePendiente: p.pendiente,
        estado: p.estado,
      },
    ];
  });
}

export interface FiltroTerceros {
  soloConSaldo?: boolean;
  q?: string;
}

export async function informeMayorTerceros(companyId: string, tipo: TipoTercero, periodo: Periodo, filtro: FiltroTerceros = {}) {
  let terceros = await calcularTerceros(companyId, tipo, periodo);
  if (filtro.soloConSaldo) terceros = terceros.filter((t) => t.saldoFinal !== 0);
  if (filtro.q?.trim()) {
    const q = sinTildes(filtro.q.trim());
    terceros = terceros.filter((t) => sinTildes(`${t.nombre} ${t.nif ?? ''} ${t.cuentas.join(' ')}`).includes(q));
  }

  const pendiente = new Map<string, number>();
  for (const f of await pendientesSegunFacturas(companyId, tipo, periodo.hasta, { conPartidas: true })) {
    pendiente.set(f.terceroId, round2((pendiente.get(f.terceroId) ?? 0) + f.importePendiente));
  }
  const filasDatos = terceros.map(({ movimientos: _m, ...t }) => ({
    ...t,
    movimientos: _m.length,
    pendienteFacturas: t.id !== SIN_IDENTIFICAR && !t.id.startsWith('subcuenta:') ? (pendiente.get(t.id) ?? 0) : null,
  }));
  const totales = {
    saldoInicial: round2(filasDatos.reduce((s, t) => s + t.saldoInicial, 0)),
    debe: round2(filasDatos.reduce((s, t) => s + t.debe, 0)),
    haber: round2(filasDatos.reduce((s, t) => s + t.haber, 0)),
    saldoFinal: round2(filasDatos.reduce((s, t) => s + t.saldoFinal, 0)),
  };

  const conPendiente = true;
  const tabla: TablaInforme = {
    titulo: TITULO_TERCEROS[tipo],
    periodo: textoPeriodo(periodo.desde, periodo.hasta),
    empresa: await datosEmpresa(companyId),
    apaisado: true,
    columnas: [
      { titulo: tipo === 'clientes' ? 'Cliente' : 'Proveedor', tipo: 'texto', ancho: 6 },
      { titulo: 'NIF', tipo: 'codigo', ancho: 2 },
      { titulo: 'Subcuenta', tipo: 'codigo', ancho: 2.4 },
      { titulo: 'Saldo inicial', tipo: 'importe', ancho: 2, saldo: true },
      { titulo: 'Debe', tipo: 'importe', ancho: 2 },
      { titulo: 'Haber', tipo: 'importe', ancho: 2 },
      { titulo: 'Saldo final', tipo: 'importe', ancho: 2, saldo: true },
      ...(conPendiente ? [{ titulo: 'Pendiente s/ facturas', tipo: 'importe' as const, ancho: 2.2, saldo: true }] : []),
    ],
    filas: [
      ...filasDatos.map((t) => ({
        celdas: [t.nombre, t.nif, t.subcuentas.join(' · ') || null, t.saldoInicial, t.debe, t.haber, t.saldoFinal, ...(conPendiente ? [t.pendienteFacturas] : [])],
      })),
      {
        celdas: [`Total (${filasDatos.length})`, null, null, totales.saldoInicial, totales.debe, totales.haber, totales.saldoFinal, ...(conPendiente ? [null] : [])],
        estilo: 'total' as const,
      },
    ],
    notas: [
      tipo === 'clientes'
        ? 'Cuentas 43. Saldo positivo: lo que nos deben; negativo: anticipos o cobros de más.'
        : 'Cuentas 40 y 41. Saldo positivo: lo que debemos; negativo: anticipos o pagos de más.',
      'El tercero sale de su subcuenta propia; los apuntes en la cuenta genérica (anteriores a las subcuentas), de la factura enlazada al asiento o de la referencia del apunte. Sin asientos de apertura, regularización ni cierre.',
      tipo === 'clientes'
        ? 'Pendiente s/ facturas: importe de las facturas emitidas menos sus cobros registrados, para cruzarlo con el saldo contable. De un año que llevó la gestoría cuentan las facturas que dejó pendientes de cobro.'
        : 'Pendiente s/ facturas: importe de las facturas recibidas menos sus pagos y abonos aplicados, para cruzarlo con el saldo contable. De un año que llevó la gestoría cuentan las facturas que dejó pendientes de pago.',
    ],
    fichero: `${TITULO_TERCEROS[tipo].toLowerCase()}_${periodo.desde}_${periodo.hasta}`,
  };
  return { tipo, periodo, terceros: filasDatos, totales, tabla };
}

export async function informeDetalleTercero(companyId: string, tipo: TipoTercero, periodo: Periodo, terceroId: string) {
  const terceros = await calcularTerceros(companyId, tipo, periodo);
  let t: (SaldoTercero & { subcuentas: string[] }) | undefined = terceros.find((x) => x.id === terceroId);
  if (!t) {
    // Un tercero que existe pero no tiene movimientos: ficha con todo a cero, con sus subcuentas.
    const ficha = await terceroParaMayor(companyId, tipo === 'clientes' ? 'cliente' : 'proveedor', terceroId);
    t = { id: ficha.id, nombre: ficha.nombre, nif: ficha.nif, cuentas: [], subcuentas: ficha.subcuentas, saldoInicial: 0, debe: 0, haber: 0, saldoFinal: 0, movimientos: [] };
  }
  const facturasPendientes = (await pendientesSegunFacturas(companyId, tipo, periodo.hasta, { conPartidas: true })).filter((f) => f.terceroId === t!.id);
  const totalPendiente = round2(facturasPendientes.reduce((s, f) => s + f.importePendiente, 0));

  // Columnas: Fecha, Asiento, Concepto, Factura, Debe, Haber y Saldo. El saldo
  // inicial y el final van en Saldo; las sumas, en Debe y Haber.
  const filas: FilaInforme[] = [
    { celdas: [null, null, 'Saldo inicial', null, null, null, t.saldoInicial], estilo: 'nota' },
    ...t.movimientos.map((m) => ({ celdas: [m.fecha, m.asiento, m.concepto, m.factura, m.debe, m.haber, m.saldo] })),
    { celdas: [null, null, 'Totales y saldo final', null, t.debe, t.haber, t.saldoFinal], estilo: 'total' },
  ];
  const sinAsiento = tipo === 'clientes' ? await avisoFacturasSinAsiento(companyId, tipo, t.id, periodo) : null;
  const notas = [
    tipo === 'clientes'
      ? 'Saldo positivo: lo que nos debe. En cada fila, el saldo anterior más el Debe y menos el Haber.'
      : 'Saldo positivo: lo que le debemos. En cada fila, el saldo anterior más el Haber y menos el Debe.',
    ...(t.cuentas.length ? [`Cuentas: ${t.cuentas.join(', ')}.`] : t.subcuentas.length ? [`Subcuenta: ${t.subcuentas.join(', ')} (sin movimientos).`] : []),
    ...(sinAsiento ? [sinAsiento] : []),
  ];
  if (t.id !== SIN_IDENTIFICAR && !t.id.startsWith('subcuenta:')) {
    const de = tipo === 'clientes' ? 'cobro' : 'pago';
    notas.push(
      facturasPendientes.length
        ? `Según facturación, ${facturasPendientes.length} factura(s) pendiente(s) de ${de} por ${num(totalPendiente)} ${await simboloCuenta(companyId)}: ${facturasPendientes.map((f) => f.numeroCompleto ?? '').filter(Boolean).join(', ')}.`
        : `Según facturación, no tiene facturas pendientes de ${de}.`,
    );
  }
  const tabla: TablaInforme = {
    titulo: `${tipo === 'clientes' ? 'Mayor del cliente' : 'Mayor del proveedor'} ${t.nombre}`,
    periodo: `${textoPeriodo(periodo.desde, periodo.hasta)}${t.nif ? ` · NIF ${t.nif}` : ''}`,
    empresa: await datosEmpresa(companyId),
    apaisado: true,
    columnas: [
      { titulo: 'Fecha', tipo: 'fecha', ancho: 1.7 },
      { titulo: 'Asiento', tipo: 'codigo', ancho: 2.4 },
      { titulo: 'Concepto', tipo: 'texto', ancho: 6.5 },
      { titulo: 'Factura', tipo: 'texto', ancho: 2.2 },
      { titulo: 'Debe', tipo: 'importe', ancho: 2 },
      { titulo: 'Haber', tipo: 'importe', ancho: 2 },
      { titulo: 'Saldo', tipo: 'importe', ancho: 2, saldo: true },
    ],
    filas,
    notas,
    fichero: `mayor_${t.nombre}_${periodo.desde}_${periodo.hasta}`,
  };
  return { tipo, periodo, tercero: t, facturasPendientes, totalPendiente, tabla };
}

// ---------------------------------------------------------------------------
// Buscador de clientes y proveedores (Libro mayor por tercero)
// ---------------------------------------------------------------------------

export interface TerceroEncontrado {
  tipo: 'cliente' | 'proveedor';
  id: string;
  nombre: string;
  nif: string | null;
  subcuentas: string[];
}

/**
 * Clientes y proveedores cuyo nombre, NIF o subcuenta contiene el texto (sin
 * distinguir mayusculas ni tildes: se busca en memoria). Como mucho `limite`,
 * primero los que empiezan por el texto.
 */
export async function buscarTerceros(companyId: string, q: string, tipo?: 'cliente' | 'proveedor', limite = 20): Promise<TerceroEncontrado[]> {
  const texto = sinTildes(q.trim());
  if (texto.length < 2) return [];
  const [clientes, proveedores] = await Promise.all([
    tipo === 'proveedor' ? [] : prisma.customer.findMany({ where: { companyId }, select: { id: true, nombreFiscal: true, nifCif: true, subcuenta430: true } }),
    tipo === 'cliente' ? [] : prisma.supplier.findMany({ where: { companyId }, select: { id: true, nombreFiscal: true, nifCif: true, subcuenta400: true, subcuenta410: true } }),
  ]);
  const todos: TerceroEncontrado[] = [
    ...clientes.map((c) => ({ tipo: 'cliente' as const, id: c.id, nombre: c.nombreFiscal, nif: c.nifCif, subcuentas: c.subcuenta430 ? [c.subcuenta430] : [] })),
    ...proveedores.map((p) => ({
      tipo: 'proveedor' as const,
      id: p.id,
      nombre: p.nombreFiscal,
      nif: p.nifCif,
      subcuentas: [p.subcuenta400, p.subcuenta410].filter((x): x is string => !!x),
    })),
  ];
  const sinEspacios = texto.replace(/[\s.-]/g, '');
  return todos
    .map((t) => {
      const nombre = sinTildes(t.nombre);
      const nif = (t.nif ?? '').toLowerCase();
      const empieza = nombre.startsWith(texto) || nif.startsWith(sinEspacios) || t.subcuentas.some((c) => c.startsWith(sinEspacios));
      const contiene = empieza || nombre.includes(texto) || (sinEspacios.length >= 3 && nif.includes(sinEspacios));
      return { t, peso: empieza ? 0 : contiene ? 1 : 2 };
    })
    .filter((x) => x.peso < 2)
    .sort((a, b) => a.peso - b.peso || a.t.nombre.localeCompare(b.t.nombre, 'es'))
    .slice(0, limite)
    .map((x) => x.t);
}
