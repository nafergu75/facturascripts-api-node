import { ApiClient } from './apiClient';

/**
 * Capa de datos del dashboard (VistaGeneralPage): tipos + agregaciones sobre la
 * API real. Los calculos se hacen aqui en cliente a partir de los listados
 * (facturas/compras traen neto/totaliva/totalirpf de FS en cabecera).
 * TODO: si el volumen crece, mover estas agregaciones a endpoints dedicados.
 */

export interface ResumenFinanciero {
  ingresos: number;
  ivaRepercutido: number;
  irpfIngresos: number;
  gastos: number;
  ivaSoportado: number;
  irpfGastos: number;
  resultado: number;
  /** IVA repercutido - soportado: >0 a ingresar, <0 a devolver. */
  ivaNeto: number;
  saldoBancos: number;
  numCuentas: number;
}

export interface PuntoSerieBanco {
  fecha: string;
  valor: number;
}

/** Rango rapido del grafico de bancos. */
export type PeriodoBasico = '7d' | '30d' | 'periodoCompleto';

/** Filtro de tiempo de los vencimientos (por mes o por rango de fechas). */
export interface FiltroTiempo {
  year: number;
  month?: number; // 1-12
  fromDate?: string; // yyyy-mm-dd
  toDate?: string; // yyyy-mm-dd
}

/** KPI de bancos para la tarjeta principal. */
export interface SaldoBancosKpi {
  saldoTotal: number;
  numeroCuentas: number;
  /** Variacion del saldo en los ultimos 30 dias (+ sube / - baja). */
  variacionRespectoPeriodoAnterior: number;
}

export interface LadoVencimientos {
  total: number;
  atrasado: number; // vencidos (fecha < hoy) sin liquidar
  futuro: number;
  porMes: Array<{ mes: string; importe: number }>;
}

export interface ResumenVencimientos {
  aCobrar: LadoVencimientos;
  aPagar: LadoVencimientos;
  neto: number; // aCobrar - aPagar
  /** Periodo medio de cobro en dias (facturas cobradas: ultimo cobro - emision). */
  tiempoMedioCobroDias: number | null;
}

export interface IngresosGastosMes {
  etiqueta: string; // 'ene'...'dic'
  mes: number; // 1..12
  ingresos: number;
  gastos: number;
}

export interface FilaAnalisis {
  nombre: string;
  importe: number;
  porcentaje: number;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** FS devuelve fechas dd-mm-yyyy; normaliza a yyyy-mm-dd (acepta ambas). */
export function aISO(fecha: unknown): string {
  const s = String(fecha ?? '');
  const m = /^(\d{2})-(\d{2})-(\d{4})/.exec(s);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : s.slice(0, 10);
}

const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

type Filas = Array<Record<string, unknown>>;

async function ventasYCompras(api: ApiClient, desde: string, hasta: string): Promise<{ ventas: Filas; compras: Filas }> {
  const [v, c] = await Promise.all([
    api.getFacturas({ desde, hasta, pageSize: 200 }),
    api.getCompras({ desde, hasta, pageSize: 200 }),
  ]);
  return { ventas: v.items as Filas, compras: c.items as Filas };
}

const suma = (filas: Filas, campo: string): number => round2(filas.reduce((a, f) => a + Number(f[campo] ?? 0), 0));

// ---------------------------------------------------------------------------
export async function getResumenFinanciero(api: ApiClient, rango: { desde: string; hasta: string }): Promise<ResumenFinanciero> {
  const [{ ventas, compras }, cuadre] = await Promise.all([
    ventasYCompras(api, rango.desde, rango.hasta),
    api.getCuadreBancos(new Date().getFullYear()).catch(() => ({ cuentas: [] })),
  ]);
  const ingresos = suma(ventas, 'neto');
  const gastos = suma(compras, 'neto');
  const ivaRepercutido = suma(ventas, 'totaliva');
  const ivaSoportado = suma(compras, 'totaliva');
  return {
    ingresos,
    ivaRepercutido,
    irpfIngresos: suma(ventas, 'totalirpf'),
    gastos,
    ivaSoportado,
    irpfGastos: suma(compras, 'totalirpf'),
    resultado: round2(ingresos - gastos),
    ivaNeto: round2(ivaRepercutido - ivaSoportado),
    saldoBancos: round2(cuadre.cuentas.reduce((a, c) => a + c.saldoExtracto, 0)),
    numCuentas: cuadre.cuentas.length,
  };
}

// ---------------------------------------------------------------------------
/** Serie diaria COMPLETA del saldo total en bancos (suma de cuentas, acumulado). */
async function serieCompletaBancos(api: ApiClient): Promise<PuntoSerieBanco[]> {
  const cuentas = await api.getCuentasBancarias();
  const extractos = await Promise.all(cuentas.map((c) => api.getExtracto(c.id).catch(() => null)));
  const movs: Array<{ fecha: string; importe: number }> = [];
  for (const ex of extractos) {
    if (ex) for (const l of ex.lineas) movs.push({ fecha: l.fecha, importe: l.importe });
  }
  movs.sort((a, b) => a.fecha.localeCompare(b.fecha));
  const porDia = new Map<string, number>();
  let saldo = 0;
  for (const m of movs) {
    saldo = round2(saldo + m.importe);
    porDia.set(m.fecha, saldo);
  }
  return [...porDia.entries()].map(([fecha, valor]) => ({ fecha, valor }));
}

/** Serie del saldo en bancos acotada al rango (7d / 30d / completo). */
export async function getSerieBancos(api: ApiClient, periodo: PeriodoBasico): Promise<PuntoSerieBanco[]> {
  let serie = await serieCompletaBancos(api);
  if (periodo !== 'periodoCompleto' && serie.length) {
    const dias = periodo === '7d' ? 7 : 30;
    const corte = new Date();
    corte.setDate(corte.getDate() - dias);
    const corteISO = corte.toISOString().slice(0, 10);
    const previos = serie.filter((p) => p.fecha < corteISO);
    serie = serie.filter((p) => p.fecha >= corteISO);
    // arrastra el saldo previo como punto inicial para no empezar en 0
    if (previos.length) serie.unshift({ fecha: corteISO, valor: previos[previos.length - 1].valor });
  }
  return serie;
}

/** KPI de bancos: saldo total, nº de cuentas y variacion en los ultimos 30 dias. */
export async function getSaldoBancosKpi(api: ApiClient): Promise<SaldoBancosKpi> {
  const [cuentas, serie] = await Promise.all([api.getCuentasBancarias(), serieCompletaBancos(api)]);
  const saldoTotal = serie.length ? serie[serie.length - 1].valor : 0;
  const corte = new Date();
  corte.setDate(corte.getDate() - 30);
  const corteISO = corte.toISOString().slice(0, 10);
  const previos = serie.filter((p) => p.fecha < corteISO);
  const saldoAnterior = previos.length ? previos[previos.length - 1].valor : 0;
  return {
    saldoTotal,
    numeroCuentas: cuentas.length,
    variacionRespectoPeriodoAnterior: round2(saldoTotal - saldoAnterior),
  };
}

// ---------------------------------------------------------------------------
/** Traduce un FiltroTiempo a rango {desde, hasta} (mes concreto / rango / año). */
function rangoDeFiltro(f: FiltroTiempo): { desde?: string; hasta?: string } {
  if (f.month) {
    const mm = String(f.month).padStart(2, '0');
    const ultimo = new Date(f.year, f.month, 0).getDate();
    return { desde: `${f.year}-${mm}-01`, hasta: `${f.year}-${mm}-${ultimo}` };
  }
  if (f.fromDate || f.toDate) return { desde: f.fromDate, hasta: f.toDate };
  return { desde: `${f.year}-01-01`, hasta: `${f.year}-12-31` };
}

export async function getVencimientos(api: ApiClient, filtro: FiltroTiempo): Promise<ResumenVencimientos> {
  const filtros = rangoDeFiltro(filtro);
  const [pendientes, facturas] = await Promise.all([
    api.getVencimientos('pendiente'),
    api.getFacturas({ pageSize: 200 }),
  ]);
  const hoy = new Date().toISOString().slice(0, 10);

  const lado = (tipo: 'cobro' | 'pago'): LadoVencimientos => {
    const vs = pendientes.filter(
      (v) => v.tipo === tipo && (!filtros.desde || v.fecha >= filtros.desde) && (!filtros.hasta || v.fecha <= filtros.hasta),
    );
    const porMesMap = new Map<string, number>();
    let atrasado = 0;
    let futuro = 0;
    for (const v of vs) {
      const mes = v.fecha.slice(0, 7);
      porMesMap.set(mes, round2((porMesMap.get(mes) ?? 0) + v.importe));
      if (v.fecha < hoy) atrasado = round2(atrasado + v.importe);
      else futuro = round2(futuro + v.importe);
    }
    return {
      total: round2(atrasado + futuro),
      atrasado,
      futuro,
      porMes: [...porMesMap.entries()].sort().map(([mes, importe]) => ({ mes, importe })),
    };
  };

  // Periodo medio de cobro: media de (fecha ultimo cobro - fecha emision) en cobradas.
  const cobradas = (facturas.items as Filas).filter((f) => f.estadoCobro === 'cobrada' && f.fechaUltimoCobro);
  let tiempoMedio: number | null = null;
  if (cobradas.length) {
    const dias = cobradas.map((f) => {
      const emision = new Date(aISO(f.fecha)).getTime();
      const cobro = new Date(aISO(f.fechaUltimoCobro)).getTime();
      return Math.max(0, Math.round((cobro - emision) / 86400000));
    });
    tiempoMedio = Math.round(dias.reduce((a, d) => a + d, 0) / dias.length);
  }

  const aCobrar = lado('cobro');
  const aPagar = lado('pago');
  return { aCobrar, aPagar, neto: round2(aCobrar.total - aPagar.total), tiempoMedioCobroDias: tiempoMedio };
}

// ---------------------------------------------------------------------------
export async function getIngresosGastosPorMes(api: ApiClient, year: number): Promise<IngresosGastosMes[]> {
  const { ventas, compras } = await ventasYCompras(api, `${year}-01-01`, `${year}-12-31`);
  const meses: IngresosGastosMes[] = MESES_CORTOS.map((etiqueta, i) => ({ etiqueta, mes: i + 1, ingresos: 0, gastos: 0 }));
  for (const f of ventas) {
    const m = Number(aISO(f.fecha).slice(5, 7));
    if (m >= 1 && m <= 12) meses[m - 1].ingresos = round2(meses[m - 1].ingresos + Number(f.neto ?? 0));
  }
  for (const f of compras) {
    const m = Number(aISO(f.fecha).slice(5, 7));
    if (m >= 1 && m <= 12) meses[m - 1].gastos = round2(meses[m - 1].gastos + Number(f.neto ?? 0));
  }
  return meses;
}

// ---------------------------------------------------------------------------
function agrupar(filas: Filas, campoNombre: string[], desde: string, hasta: string): FilaAnalisis[] {
  const mapa = new Map<string, number>();
  for (const f of filas) {
    const fecha = aISO(f.fecha);
    if (fecha < desde || fecha > hasta) continue;
    const nombre = campoNombre.map((c) => f[c]).find((v) => v) ?? '(sin nombre)';
    const clave = String(nombre);
    mapa.set(clave, round2((mapa.get(clave) ?? 0) + Number(f.neto ?? 0)));
  }
  const total = [...mapa.values()].reduce((a, v) => a + v, 0) || 1;
  return [...mapa.entries()]
    .map(([nombre, importe]) => ({ nombre, importe, porcentaje: round2((importe / total) * 100) }))
    .sort((a, b) => b.importe - a.importe);
}

export async function getAnalisisIngresos(api: ApiClient, year: number, mesDesde: number, mesHasta: number): Promise<FilaAnalisis[]> {
  const { ventas } = await ventasYCompras(api, `${year}-01-01`, `${year}-12-31`);
  const d = `${year}-${String(mesDesde).padStart(2, '0')}-01`;
  const h = `${year}-${String(mesHasta).padStart(2, '0')}-31`;
  return agrupar(ventas, ['nombrecliente', 'codcliente'], d, h);
}

/** TODO: cuando los gastos tengan categoria propia, agrupar por categoria ademas de proveedor. */
export async function getDetalleGastos(api: ApiClient, year: number, mesDesde: number, mesHasta: number): Promise<FilaAnalisis[]> {
  const { compras } = await ventasYCompras(api, `${year}-01-01`, `${year}-12-31`);
  const d = `${year}-${String(mesDesde).padStart(2, '0')}-01`;
  const h = `${year}-${String(mesHasta).padStart(2, '0')}-31`;
  return agrupar(compras, ['nombre', 'codproveedor'], d, h);
}
