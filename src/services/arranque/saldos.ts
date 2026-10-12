/**
 * Sumas y saldos de la gestoria a 31-12-2026: que tipo de fichero es (con
 * cierre, regularizado o sin regularizar), masas del balance, lineas del
 * asiento de apertura del 1-1-2027 (una por subcuenta) y avisos por cuenta
 * (signos raros, IVA del 4T sin liquidar, saldos que se pagan en 2027).
 *
 * Funciones puras.
 */
import { aCentimos, importeTexto } from '../../utils/money';
import type { CuentaSaldo } from '../puestaEnMarcha/lectorContable';
import { cuentaResultado } from '../puestaEnMarcha/puestaEnMarcha.service';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const esPyg = (c: string) => c.startsWith('6') || c.startsWith('7');
const eur = importeTexto;

export type TipoSumasSaldos = 'CON_CIERRE' | 'REGULARIZADO' | 'SIN_REGULARIZAR';

export interface LineaApertura {
  cuenta: string;
  debe: number;
  haber: number;
}

export interface AvisoCuenta {
  codigo: string;
  nombre: string;
  saldo: number;
  texto: string;
}

export interface AnalisisSaldos {
  tipo: TipoSumasSaldos;
  cuentas: number;
  totales: { deudor: number; acreedor: number; diferencia: number; cuadra: boolean };
  /** Resultado de los grupos 6 y 7 (> 0 beneficio). Cero si viene regularizado. */
  resultadoPyg: number;
  /** Saldo acreedor de la 129 (> 0 beneficio). */
  saldo129: number;
  /** Resultado del ejercicio: el de 6/7 si no esta regularizado; el de la 129 si lo esta. */
  resultado: number;
  cuenta129: string;
  masas: { activo: number; patrimonioNeto: number; pasivo: number };
  lineas: LineaApertura[];
  anomalias: AvisoCuenta[];
  heredados: AvisoCuenta[];
  /** 472 y 477 con saldo: la liquidacion del IVA del 4T no esta hecha. */
  ivaSinLiquidar: AvisoCuenta[];
}

/** Saldos que se pagan o cobran en los primeros meses de 2027, y como se cancelan en la app. */
const HEREDADOS: Array<[RegExp, string]> = [
  [/^4750/, 'IVA del 4T a ingresar: se cancela al pagar el 303 en enero, casando el cargo del banco con esta cuenta.'],
  [/^4751/, 'Retenciones del 4T (111 y 115): se cancelan al pagar los modelos en enero.'],
  [/^4752/, 'Impuesto sobre Sociedades de 2026: se cancela al pagar el 200 en julio.'],
  [/^476/, 'Seguridad Social de diciembre: se cancela al pagar los seguros sociales en enero.'],
  [/^465/, 'Sueldos de diciembre pendientes de pagar.'],
  [/^4700/, 'IVA a devolver: se cancela cuando Hacienda lo ingrese.'],
  [/^4709/, 'Hacienda deudora por devolución de impuestos: se cancela cuando Hacienda lo ingrese.'],
  [/^555/, 'Partidas pendientes de aplicación: conviene que la gestoría las aclare antes de cerrar.'],
];

function signoAnomalo(codigo: string, saldo: number): string | null {
  if (aCentimos(saldo) === 0) return null;
  if (codigo.startsWith('57') && saldo < 0) return 'Cuenta de bancos o caja con saldo acreedor: si es una póliza de crédito, pide a la gestoría que la pase a la 5201.';
  if (codigo.startsWith('430') && saldo < 0) return 'Cliente con saldo acreedor (le debes tú): puede ser un anticipo o un abono sin aplicar.';
  if (/^4[01]0/.test(codigo) && saldo > 0) return 'Proveedor o acreedor con saldo deudor (te debe él): puede ser un anticipo o un abono pendiente.';
  if (/^2[89]/.test(codigo) && saldo > 0) return 'Amortización o deterioro con saldo deudor: lo normal es que sea acreedor.';
  if (codigo.startsWith('1') && saldo > 0 && !/^(108|109|118|121|129)/.test(codigo)) return 'Cuenta de financiación con saldo deudor: lo normal es que sea acreedora.';
  return null;
}

/**
 * Analiza el sumas y saldos a 31-12-2026. `nombres` pone nombre a las cuentas
 * en los avisos.
 */
export function analizarSaldos(cuentas: CuentaSaldo[], nombres: Map<string, string> = new Map()): AnalisisSaldos {
  const nombre = (c: string) => nombres.get(c) || cuentas.find((x) => x.codigo === c)?.nombre || '';
  let deudor = 0;
  let acreedor = 0;
  for (const c of cuentas) {
    if (c.saldo > 0) deudor += c.saldo;
    else acreedor -= c.saldo;
  }
  deudor = round2(deudor);
  acreedor = round2(acreedor);
  const totales = { deudor, acreedor, diferencia: round2(deudor - acreedor), cuadra: aCentimos(deudor) === aCentimos(acreedor) };

  const conSaldo = cuentas.filter((c) => aCentimos(c.saldo) !== 0);
  const pyg = conSaldo.filter((c) => esPyg(c.codigo));
  const tipo: TipoSumasSaldos = conSaldo.length === 0 ? 'CON_CIERRE' : pyg.length === 0 ? 'REGULARIZADO' : 'SIN_REGULARIZAR';
  const resultadoPyg = round2(-pyg.reduce((s, c) => s + c.saldo, 0));
  const saldo129 = round2(-conSaldo.filter((c) => c.codigo.startsWith('129')).reduce((s, c) => s + c.saldo, 0));
  const c129 = cuentaResultado(cuentas.map((c) => c.codigo));

  // Lineas de la apertura: saldos de balance y el resultado de 6/7 a la 129.
  const porCuenta = new Map<string, number>();
  for (const c of conSaldo) if (!esPyg(c.codigo)) porCuenta.set(c.codigo, round2((porCuenta.get(c.codigo) ?? 0) + c.saldo));
  if (aCentimos(resultadoPyg) !== 0) porCuenta.set(c129, round2((porCuenta.get(c129) ?? 0) - resultadoPyg));
  const lineas = [...porCuenta.entries()]
    .filter(([, s]) => aCentimos(s) !== 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cuenta, s]) => ({ cuenta, debe: s > 0 ? s : 0, haber: s < 0 ? round2(-s) : 0 }));

  // Masas: el activo son los grupos 2 y 3 (con sus amortizaciones) y los 4 y 5 deudores;
  // el patrimonio neto, del 10 al 13 (con el resultado en la 129); el pasivo, el resto.
  let activo = 0;
  let patrimonioNeto = 0;
  let pasivo = 0;
  for (const [c, s] of porCuenta) {
    if (/^[23]/.test(c) || (/^[45]/.test(c) && s > 0)) activo += s;
    else if (/^1[0-3]/.test(c)) patrimonioNeto -= s;
    else pasivo -= s;
  }

  const anomalias: AvisoCuenta[] = [];
  const heredados: AvisoCuenta[] = [];
  const ivaSinLiquidar: AvisoCuenta[] = [];
  for (const c of conSaldo) {
    const a = signoAnomalo(c.codigo, c.saldo);
    if (a) anomalias.push({ codigo: c.codigo, nombre: nombre(c.codigo), saldo: c.saldo, texto: a });
    const h = HEREDADOS.find(([re]) => re.test(c.codigo));
    if (h) heredados.push({ codigo: c.codigo, nombre: nombre(c.codigo), saldo: c.saldo, texto: h[1] });
    if (/^47[27]/.test(c.codigo)) {
      ivaSinLiquidar.push({ codigo: c.codigo, nombre: nombre(c.codigo), saldo: c.saldo, texto: `Saldo de ${eur(Math.abs(c.saldo))}: la liquidación del IVA del 4T no está hecha.` });
    }
  }

  return {
    tipo,
    cuentas: cuentas.length,
    totales,
    resultadoPyg,
    saldo129,
    resultado: tipo === 'SIN_REGULARIZAR' ? resultadoPyg : saldo129,
    cuenta129: c129,
    masas: { activo: round2(activo), patrimonioNeto: round2(patrimonioNeto), pasivo: round2(pasivo) },
    lineas,
    anomalias,
    heredados,
    ivaSinLiquidar,
  };
}

/** Saldo por cuenta de las lineas de la apertura (deudor positivo). */
export function saldosDeLineas(lineas: LineaApertura[]): Map<string, number> {
  return new Map(lineas.map((l) => [l.cuenta, round2(l.debe - l.haber)]));
}
