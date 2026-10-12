/**
 * Saca los datos de cada hoja ya clasificada (clasificador.ts): cuentas del
 * plan, listados de clientes y proveedores, saldos del sumas y saldos, apuntes
 * del diario, partidas de la cartera, fichas de inmovilizado y totales de la
 * PyG o el balance oficiales.
 *
 * Las columnas salen de los titulos (campos.ts) o del mapeo que haga la persona
 * cuando no se pueden deducir. El sumas y saldos y el diario se leen con el
 * lector de la puesta en marcha (lectorContable.ts), que ya sabe de importes
 * con coma o punto, D/H, cuentas agregadas y mayores por cuenta.
 *
 * Funciones puras: nunca lanzan; si falta algo, `error` dice que y, si se puede
 * arreglar eligiendo columnas, `necesitaMapeo`.
 */
import { badRequest } from '../../utils/http-errors';
import { normalizarNif } from '../../utils/nif';
import {
  cuentaYNombre,
  detectarSeparadorDecimal,
  letraColumna,
  leerBalanceDeFilas,
  leerDiarioDeFilas,
  normalizarCuenta,
  normalizarTitulo,
  parsearFecha,
  parsearImporte,
  texto,
  type CampoBalance,
  type CampoDiario,
  type LecturaBalance,
  type LecturaDiario,
  type Mapeo,
} from '../puestaEnMarcha/lectorContable';
import { leerPlanDeFilas } from '../puestaEnMarcha/planAnterior';
import type { CabeceraDetectada, Campo } from './campos';
import type { TipoHoja } from './clasificador';
import { expandirCodigoConPunto, quitarCabecerasRepetidas } from './lectorLibros';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Datos de contacto que traen algunos planes y listados. */
export interface DatosFicha {
  direccion?: string;
  cp?: string;
  municipio?: string;
  provincia?: string;
  pais?: string;
  email?: string;
  telefono?: string;
}

export interface CuentaLeida {
  codigo: string;
  nombre: string;
  nif?: string;
  ficha?: DatosFicha;
}

export interface TerceroLeido {
  subcuenta?: string;
  nif?: string;
  nombre?: string;
  tipo: 'cliente' | 'proveedor';
  ficha?: DatosFicha;
}

export interface PartidaLeida {
  /** Fila 1-based, como en Excel. */
  fila: number;
  subcuenta?: string;
  nif?: string;
  nombre?: string;
  documento: string;
  fecha?: string;
  vencimiento?: string;
  importeOriginal?: number;
  pendiente: number;
  moneda: string;
  /** Si la fila dice si es de un cliente o de un proveedor (por la subcuenta o una columna «Tipo»). */
  tipoTercero?: 'cliente' | 'proveedor';
}

export interface ActivoLeido {
  fila: number;
  descripcion: string;
  cuentaBien?: string;
  cuentaAmortAcum?: string;
  cuentaDotacion?: string;
  fechaAlta?: string;
  fechaInicioAmort?: string;
  coste: number;
  amortAcumulada: number;
  /** % anual. */
  coeficiente?: number;
  valorResidual: number;
}

export interface TotalesOficiales {
  /** PyG: resultado del ejercicio (> 0 beneficio). */
  resultado: number | null;
  cifraNegocios: number | null;
  /** Balance: total activo y total patrimonio neto y pasivo. */
  totalActivo: number | null;
  totalPnPasivo: number | null;
  /**
   * PyG: importe de cada partida principal (1 a 18 de la PyG de PYMES, por su
   * texto: el numero cambia entre el modelo normal y el abreviado). Ingresos
   * en positivo y gastos en negativo, como salen en la PyG.
   */
  partidas?: Record<string, number>;
}

/** Partidas de la PyG por su texto (el orden importa: la mas concreta antes). */
const PARTIDAS_PYG_TEXTO: Array<[RegExp, string]> = [
  [/cifra de negocios/, '1'],
  [/variacion de existencias/, '2'],
  [/trabajos realizados/, '3'],
  [/aprovisionamientos/, '4'],
  [/otros ingresos de explotacion/, '5'],
  [/gastos de personal/, '6'],
  [/otros gastos de explotacion/, '7'],
  [/amortizacion del inmovilizado/, '8'],
  [/imputacion de subvenciones/, '9'],
  [/excesos? de provisiones/, '10'],
  [/enajenaciones? de instrumentos financieros/, '17'],
  [/enajenaciones? del inmovilizado/, '11'],
  [/diferencia negativa de combinaciones|otros resultados/, '12'],
  [/ingresos financieros/, '13'],
  [/gastos financieros/, '14'],
  [/valor razonable/, '15'],
  [/diferencias de cambio/, '16'],
  [/impuestos? sobre (los )?beneficios/, '18'],
];

/**
 * Cuenta de 3 digitos que representa cada partida de la PyG en el comparativo
 * (la misma partida a la que la lleva domain/modelos-cuentas-anuales.ts).
 */
const CUENTA_DE_PARTIDA: Record<string, [string, string]> = {
  '1': ['700', 'Importe neto de la cifra de negocios'],
  '2': ['710', 'Variación de existencias de productos terminados y en curso'],
  '3': ['730', 'Trabajos realizados por la empresa para su activo'],
  '4': ['600', 'Aprovisionamientos'],
  '5': ['759', 'Otros ingresos de explotación'],
  '6': ['640', 'Gastos de personal'],
  '7': ['629', 'Otros gastos de explotación'],
  '8': ['681', 'Amortización del inmovilizado'],
  '9': ['746', 'Imputación de subvenciones de inmovilizado no financiero y otras'],
  '10': ['795', 'Excesos de provisiones'],
  '11': ['671', 'Deterioro y resultado por enajenaciones del inmovilizado'],
  '12': ['678', 'Otros resultados'],
  '13': ['769', 'Ingresos financieros'],
  '14': ['662', 'Gastos financieros'],
  '15': ['663', 'Variación de valor razonable en instrumentos financieros'],
  '16': ['668', 'Diferencias de cambio'],
  '17': ['667', 'Deterioro y resultado por enajenaciones de instrumentos financieros'],
  '18': ['630', 'Impuestos sobre beneficios'],
};

/**
 * Saldos de 2026 de los grupos 6 y 7 sacados de la PyG oficial, para el
 * comparativo cuando el sumas y saldos viene regularizado y no hay diario.
 * null si la PyG no trae sus partidas o no suman el resultado (entonces no
 * sirve: el comparativo quedaria mal).
 */
export function cuentasDePygOficial(t: TotalesOficiales | null): Array<{ codigo: string; nombre: string; saldo: number }> | null {
  if (!t?.partidas || t.resultado === null) return null;
  const entradas = Object.entries(t.partidas).filter(([, v]) => Math.round(v * 100) !== 0);
  if (!entradas.length) return null;
  const suma = round2(entradas.reduce((s, [, v]) => s + v, 0));
  if (Math.round(suma * 100) !== Math.round(t.resultado * 100)) return null;
  return entradas.map(([p, v]) => ({ codigo: CUENTA_DE_PARTIDA[p][0], nombre: CUENTA_DE_PARTIDA[p][1], saldo: round2(-v) })).sort((a, b) => a.codigo.localeCompare(b.codigo));
}

export type Extraccion =
  | { tipo: 'PLAN'; cuentas: CuentaLeida[] }
  | { tipo: 'TERCEROS_CLIENTES' | 'TERCEROS_PROVEEDORES'; terceros: TerceroLeido[] }
  | { tipo: 'SUMAS_Y_SALDOS'; lectura: LecturaBalance }
  | { tipo: 'DIARIO'; lectura: LecturaDiario }
  | { tipo: 'CARTERA'; partidas: PartidaLeida[] }
  | { tipo: 'INMOVILIZADO'; activos: ActivoLeido[] }
  | { tipo: 'PYG' | 'BALANCE'; totales: TotalesOficiales };

export interface ColumnaHoja {
  indice: number;
  letra: string;
  titulo: string;
  ejemplo: string;
}

export interface ErrorExtraccion {
  mensaje: string;
  /** true si se arregla eligiendo a mano que columna es cada dato. */
  necesitaMapeo: boolean;
  /** Datos que faltan («cuenta», «debe»...). */
  faltan: Campo[];
  columnas: ColumnaHoja[];
}

export interface ResultadoExtraccion {
  extraccion: Extraccion | null;
  /** Columnas usadas (indice de cada dato). */
  mapeo: Partial<Record<Campo, number>>;
  avisos: string[];
  error: ErrorExtraccion | null;
  /** Codigos con punto de relleno («430.1») que se han expandido. */
  codigosExpandidos: number;
}

export interface OpcionesExtraccion {
  cabecera: CabeceraDetectada | null;
  /** Mapeo a mano (indices de columna por dato) y su fila de titulos (1-based; 0 = sin titulos). */
  mapeo?: Partial<Record<Campo, number>> | null;
  filaCabecera?: number;
  /** Longitud de las subcuentas para expandir «430.1» (la del plan; si no, la de la empresa). */
  longitud?: number | null;
  formato?: string;
}

/** Que datos hacen falta para leer cada tipo de hoja, y como se dice en pantalla. */
export const OBLIGATORIOS: Partial<Record<TipoHoja, { cumple: (m: Partial<Record<Campo, number>>) => boolean; faltan: (m: Partial<Record<Campo, number>>) => Campo[]; texto: string }>> = {
  PLAN: { cumple: (m) => m.cuenta !== undefined, faltan: () => ['cuenta'], texto: 'la columna del código de cuenta' },
  TERCEROS_CLIENTES: {
    cumple: (m) => (m.nif !== undefined || m.cuenta !== undefined) && m.nombre !== undefined,
    faltan: (m) => [...(m.nif === undefined && m.cuenta === undefined ? (['nif'] as Campo[]) : []), ...(m.nombre === undefined ? (['nombre'] as Campo[]) : [])],
    texto: 'el NIF (o la subcuenta) y el nombre',
  },
  SUMAS_Y_SALDOS: {
    cumple: (m) => m.cuenta !== undefined && (m.saldo !== undefined || (m.saldoDeudor !== undefined && m.saldoAcreedor !== undefined) || (m.debe !== undefined && m.haber !== undefined)),
    faltan: (m) => [...(m.cuenta === undefined ? (['cuenta'] as Campo[]) : []), ...(m.saldo === undefined && m.saldoDeudor === undefined && m.debe === undefined ? (['saldo'] as Campo[]) : [])],
    texto: 'la cuenta y el saldo (o el Debe y el Haber)',
  },
  DIARIO: {
    cumple: (m) => m.fecha !== undefined && ((m.debe !== undefined && m.haber !== undefined) || m.importe !== undefined),
    faltan: (m) => [...(m.fecha === undefined ? (['fecha'] as Campo[]) : []), ...(m.debe === undefined && m.importe === undefined ? (['debe', 'haber'] as Campo[]) : [])],
    texto: 'la fecha, la cuenta y los importes (Debe y Haber, o el importe)',
  },
  CARTERA: {
    cumple: (m) =>
      m.documento !== undefined &&
      (m.cuenta !== undefined || m.nif !== undefined || m.nombre !== undefined) &&
      (m.pendiente !== undefined || m.importe !== undefined || m.importeOriginal !== undefined || m.saldo !== undefined),
    faltan: (m) => [
      ...(m.documento === undefined ? (['documento'] as Campo[]) : []),
      ...(m.cuenta === undefined && m.nif === undefined && m.nombre === undefined ? (['cuenta'] as Campo[]) : []),
      ...(m.pendiente === undefined && m.importe === undefined && m.importeOriginal === undefined && m.saldo === undefined ? (['pendiente'] as Campo[]) : []),
    ],
    texto: 'la factura, el cliente o proveedor (subcuenta o NIF) y el importe pendiente',
  },
  INMOVILIZADO: {
    cumple: (m) => m.nombre !== undefined && m.coste !== undefined,
    faltan: (m) => [...(m.nombre === undefined ? (['nombre'] as Campo[]) : []), ...(m.coste === undefined ? (['coste'] as Campo[]) : [])],
    texto: 'la descripción del bien y su coste',
  },
};
OBLIGATORIOS.TERCEROS_PROVEEDORES = OBLIGATORIOS.TERCEROS_CLIENTES;

/** Columnas de la hoja con un ejemplo, para que la persona pueda elegir. */
export function describirColumnasHoja(filas: unknown[][], filaCabecera: number): ColumnaHoja[] {
  const ancho = Math.max(0, ...filas.slice(0, 200).map((f) => (f ?? []).length));
  const cab = filaCabecera >= 0 ? filas[filaCabecera] ?? [] : [];
  const out: ColumnaHoja[] = [];
  for (let i = 0; i < Math.min(ancho, 60); i++) {
    let ejemplo = '';
    for (let r = filaCabecera + 1; r < filas.length && r < filaCabecera + 50; r++) {
      const v = texto(filas[r]?.[i]);
      if (v) {
        ejemplo = v.slice(0, 40);
        break;
      }
    }
    out.push({ indice: i, letra: letraColumna(i), titulo: texto(cab[i]) || `Columna ${letraColumna(i)}`, ejemplo });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------

const RE_CON_PUNTO = /^\d{3,4}\.\d{1,9}$/;

/** Longitud mas frecuente (7 a 10 digitos) de los codigos sin punto de una columna. */
function longitudDeColumna(filas: unknown[][], col: number): number | null {
  const cuenta = new Map<number, number>();
  for (const f of filas) {
    const c = normalizarCuenta(f?.[col]);
    if (c && !RE_CON_PUNTO.test(texto(f?.[col])) && c.length >= 7 && c.length <= 10) cuenta.set(c.length, (cuenta.get(c.length) ?? 0) + 1);
  }
  let mejor: number | null = null;
  for (const [l, n] of cuenta) if (mejor === null || n > cuenta.get(mejor)!) mejor = l;
  return mejor;
}

/**
 * Copia de las filas con los codigos con punto de relleno expandidos en las
 * columnas de cuenta («430.1» -> «4300000001» con 10 digitos).
 */
function expandirCodigos(filas: unknown[][], columnas: number[], longitud: number | null | undefined, desde: number): { filas: unknown[][]; expandidos: number } {
  let expandidos = 0;
  const cols = columnas.filter((c) => c !== undefined && c >= 0);
  if (!cols.length) return { filas, expandidos };
  const hay = filas.some((f, i) => i > desde && cols.some((c) => RE_CON_PUNTO.test(texto(f?.[c]))));
  if (!hay) return { filas, expandidos };
  const largo = longitud ?? longitudDeColumna(filas.slice(desde + 1), cols[0]) ?? 8;
  const out = filas.map((f, i) => {
    if (i <= desde || !f) return f;
    let copia: unknown[] | null = null;
    for (const c of cols) {
      const v = texto(f[c]);
      if (RE_CON_PUNTO.test(v)) {
        const e = expandirCodigoConPunto(v, largo);
        if (e) {
          copia ??= [...f];
          copia[c] = e;
          expandidos++;
        }
      }
    }
    return copia ?? f;
  });
  return { filas: out, expandidos };
}

const textoCelda = (f: unknown[], c?: number) => (c === undefined ? '' : texto(f[c]));
const opcional = (s: string) => (s ? s : undefined);

function datosFicha(f: unknown[], m: Partial<Record<Campo, number>>): DatosFicha | undefined {
  const d: DatosFicha = {
    direccion: opcional(textoCelda(f, m.direccion).slice(0, 190)),
    cp: opcional(textoCelda(f, m.cp).replace(/\.0+$/, '').slice(0, 10)),
    municipio: opcional(textoCelda(f, m.municipio).slice(0, 100)),
    provincia: opcional(textoCelda(f, m.provincia).slice(0, 100)),
    pais: opcional(textoCelda(f, m.pais).toUpperCase().slice(0, 3)),
    email: opcional(textoCelda(f, m.email).slice(0, 190)),
    telefono: opcional(textoCelda(f, m.telefono).replace(/\.0+$/, '').slice(0, 30)),
  };
  for (const k of Object.keys(d) as Array<keyof DatosFicha>) if (d[k] === undefined) delete d[k];
  return Object.keys(d).length ? d : undefined;
}

/** Codigo de una celda: «4300000001», «4300000001 Cliente SL». */
function codigoDe(v: unknown): { codigo: string; nombre: string } | null {
  const c = normalizarCuenta(v);
  if (c) return { codigo: c, nombre: '' };
  return cuentaYNombre(v);
}

const esFilaVacia = (f: unknown[] | undefined) => !f || f.every((c) => texto(c) === '');
const esTotal = (f: unknown[]) => f.some((c) => /^(total|totales|suma|sumas|suma y sigue)\b/.test(normalizarTitulo(c)));

function aMapeo<C extends string>(m: Partial<Record<Campo, number>>, campos: readonly C[]): Mapeo<C> {
  const out: Mapeo<C> = {};
  for (const c of campos) {
    const v = m[c as unknown as Campo];
    if (v !== undefined) out[c] = v;
  }
  return out;
}

const CAMPOS_BALANCE: readonly CampoBalance[] = ['cuenta', 'nombre', 'debe', 'haber', 'saldoDeudor', 'saldoAcreedor', 'saldo'];
const CAMPOS_DIARIO: readonly CampoDiario[] = ['fecha', 'asiento', 'cuenta', 'nombre', 'concepto', 'debe', 'haber', 'importe', 'signo'];

/**
 * Sumas y saldos sin titulos: columna de codigos, una de texto y las de
 * numeros (1 = saldo; 2 = debe y haber; 4 = debe, haber, saldo deudor y saldo
 * acreedor). Si no encaja, null y se pide el mapeo.
 */
function mapeoSumasSaldosPorContenido(filas: unknown[][]): Partial<Record<Campo, number>> | null {
  const muestra = filas.filter((f) => !esFilaVacia(f)).slice(0, 200);
  const ancho = Math.max(0, ...muestra.map((f) => f.length));
  let cuenta: number | undefined;
  let nombre: number | undefined;
  const numeros: number[] = [];
  for (let j = 0; j < ancho; j++) {
    const vals = muestra.map((f) => f[j]).filter((v) => texto(v) !== '');
    if (!vals.length) continue;
    const codigos = vals.filter((v) => codigoDe(v)).length / vals.length;
    const nums = vals.filter((v) => typeof v === 'number' || !Number.isNaN(parsearImporte(v))).length / vals.length;
    const letras = vals.filter((v) => /[a-zA-ZñÑ]{3,}/.test(texto(v))).length / vals.length;
    if (cuenta === undefined && codigos >= 0.8) cuenta = j;
    else if (nombre === undefined && letras >= 0.6) nombre = j;
    else if (nums >= 0.8) numeros.push(j);
  }
  if (cuenta === undefined) return null;
  const base = { cuenta, ...(nombre !== undefined ? { nombre } : {}) };
  if (numeros.length === 1) return { ...base, saldo: numeros[0] };
  if (numeros.length === 2) return { ...base, debe: numeros[0], haber: numeros[1] };
  if (numeros.length === 4) return { ...base, debe: numeros[0], haber: numeros[1], saldoDeudor: numeros[2], saldoAcreedor: numeros[3] };
  return null;
}

// ---------------------------------------------------------------------------
// Extraccion por tipo
// ---------------------------------------------------------------------------

function extraerPlan(filas: unknown[][], m: Partial<Record<Campo, number>>, desde: number, formato: string): { cuentas: CuentaLeida[]; avisos: string[] } {
  if (m.cuenta === undefined) {
    // Sin titulos: el lector del plan de la puesta en marcha (primer codigo de cada fila y su nombre).
    const l = leerPlanDeFilas(filas, formato);
    return { cuentas: l.cuentas.map((c) => ({ codigo: c.codigo, nombre: c.nombre, ...(c.nif ? { nif: c.nif } : {}) })), avisos: l.avisos };
  }
  const cuentas = new Map<string, CuentaLeida>();
  for (let i = desde + 1; i < filas.length; i++) {
    const f = filas[i];
    if (esFilaVacia(f)) continue;
    const cn = codigoDe(f[m.cuenta]);
    if (!cn) continue;
    const nombre = (textoCelda(f, m.nombre) || cn.nombre).slice(0, 190);
    const nif = m.nif !== undefined ? normalizarNif(f[m.nif]) : '';
    const ficha = datosFicha(f, m);
    if (!cuentas.has(cn.codigo)) cuentas.set(cn.codigo, { codigo: cn.codigo, nombre, ...(nif ? { nif } : {}), ...(ficha ? { ficha } : {}) });
  }
  return { cuentas: [...cuentas.values()].sort((a, b) => a.codigo.localeCompare(b.codigo)), avisos: [] };
}

function extraerTerceros(filas: unknown[][], m: Partial<Record<Campo, number>>, desde: number, tipo: 'cliente' | 'proveedor'): TerceroLeido[] {
  const out: TerceroLeido[] = [];
  const vistos = new Set<string>();
  for (let i = desde + 1; i < filas.length; i++) {
    const f = filas[i];
    if (esFilaVacia(f) || esTotal(f)) continue;
    const cn = m.cuenta !== undefined ? codigoDe(f[m.cuenta]) : null;
    const nif = m.nif !== undefined ? normalizarNif(f[m.nif]) : '';
    const nombre = textoCelda(f, m.nombre).slice(0, 190);
    if (!cn && !nif) continue;
    const clave = `${cn?.codigo ?? ''}|${nif}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    const subcuenta = cn?.codigo;
    const tipoFila = subcuenta?.startsWith('43') ? 'cliente' : subcuenta && /^4[01]/.test(subcuenta) ? 'proveedor' : tipo;
    const ficha = datosFicha(f, m);
    out.push({ tipo: tipoFila, ...(subcuenta ? { subcuenta } : {}), ...(nif ? { nif } : {}), ...(nombre || cn?.nombre ? { nombre: nombre || cn!.nombre } : {}), ...(ficha ? { ficha } : {}) });
  }
  return out;
}

function tipoDeTexto(v: unknown): 'cliente' | 'proveedor' | undefined {
  const t = normalizarTitulo(v);
  if (/^(c|cliente|clientes|cobro|cobros|deudor|a cobrar)$/.test(t)) return 'cliente';
  if (/^(p|a|proveedor|proveedores|acreedor|acreedores|pago|pagos|a pagar)$/.test(t)) return 'proveedor';
  return undefined;
}

function extraerCartera(filas: unknown[][], m: Partial<Record<Campo, number>>, desde: number): { partidas: PartidaLeida[]; avisos: string[] } {
  const avisos: string[] = [];
  const colsImporte = [m.pendiente, m.importe, m.importeOriginal, m.saldo].filter((c): c is number => c !== undefined);
  const datos = filas.slice(desde + 1);
  const decimal = detectarSeparadorDecimal(datos.flatMap((f) => colsImporte.map((c) => f?.[c])));
  const colPendiente = m.pendiente ?? m.importe ?? m.saldo ?? m.importeOriginal!;
  const colOriginal = m.importeOriginal !== undefined && m.importeOriginal !== colPendiente ? m.importeOriginal : m.importe !== undefined && m.importe !== colPendiente ? m.importe : undefined;
  if (m.pendiente === undefined) avisos.push('La cartera no trae una columna de «pendiente»: se toma el importe de cada factura como lo que queda por cobrar o pagar.');
  const partidas: PartidaLeida[] = [];
  let ilegibles = 0;
  datos.forEach((f, k) => {
    if (esFilaVacia(f) || esTotal(f)) return;
    const documento = textoCelda(f, m.documento).replace(/\.0+$/, '').slice(0, 60);
    const cn = m.cuenta !== undefined ? codigoDe(f[m.cuenta]) : null;
    const nif = m.nif !== undefined ? normalizarNif(f[m.nif]) : '';
    const nombre = textoCelda(f, m.nombre).slice(0, 190) || cn?.nombre || '';
    const pendiente = parsearImporte(f[colPendiente], decimal);
    if (!documento && !cn && !nif) return;
    if (Number.isNaN(pendiente)) {
      ilegibles++;
      return;
    }
    if (round2(pendiente) === 0) return;
    const original = colOriginal !== undefined ? parsearImporte(f[colOriginal], decimal) : NaN;
    const subcuenta = cn?.codigo;
    const tipoTercero = subcuenta?.startsWith('43') ? 'cliente' : subcuenta && /^4[01]/.test(subcuenta) ? 'proveedor' : m.tipoTercero !== undefined ? tipoDeTexto(f[m.tipoTercero]) : undefined;
    const moneda = (textoCelda(f, m.moneda).toUpperCase().slice(0, 3) || 'EUR').replace('€', 'EUR');
    partidas.push({
      fila: desde + 2 + k,
      ...(subcuenta ? { subcuenta } : {}),
      ...(nif ? { nif } : {}),
      ...(nombre ? { nombre } : {}),
      documento: documento || `Sin número (fila ${desde + 2 + k})`,
      ...(m.fecha !== undefined && parsearFecha(f[m.fecha]) ? { fecha: parsearFecha(f[m.fecha])! } : {}),
      ...(m.vencimiento !== undefined && parsearFecha(f[m.vencimiento]) ? { vencimiento: parsearFecha(f[m.vencimiento])! } : {}),
      ...(Number.isFinite(original) ? { importeOriginal: round2(original) } : {}),
      pendiente: round2(pendiente),
      moneda: /^[A-Z]{3}$/.test(moneda) ? moneda : 'EUR',
      ...(tipoTercero ? { tipoTercero } : {}),
    });
  });
  if (ilegibles) avisos.push(`${ilegibles} ${ilegibles === 1 ? 'fila de la cartera tiene' : 'filas de la cartera tienen'} un importe que no se entiende: no se han leído.`);
  return { partidas, avisos };
}

function extraerInmovilizado(filas: unknown[][], m: Partial<Record<Campo, number>>, desde: number): { activos: ActivoLeido[]; avisos: string[] } {
  const avisos: string[] = [];
  const cols = [m.coste, m.amortAcumulada, m.valorResidual].filter((c): c is number => c !== undefined);
  const datos = filas.slice(desde + 1);
  const decimal = detectarSeparadorDecimal(datos.flatMap((f) => cols.map((c) => f?.[c])));
  const num = (f: unknown[], c?: number) => (c === undefined ? 0 : parsearImporte(f[c], decimal));
  const activos: ActivoLeido[] = [];
  let sinCuentaDelGrupo2 = 0;
  datos.forEach((f, k) => {
    if (esFilaVacia(f) || esTotal(f)) return;
    const descripcion = textoCelda(f, m.nombre).slice(0, 191);
    const coste = num(f, m.coste);
    if (!descripcion || Number.isNaN(coste) || round2(coste) === 0) return;
    const cuenta = (c?: number) => (c === undefined ? undefined : (codigoDe(f[c])?.codigo ?? undefined));
    // La cuenta del bien es del grupo 2 (20 a 23): un «1», «2»... es el numero del bien, no su cuenta.
    const cuentaBien = cuenta(m.cuenta);
    if (m.cuenta !== undefined && !(cuentaBien && /^2[0-3]\d/.test(cuentaBien))) sinCuentaDelGrupo2++;
    let coeficiente: number | undefined;
    if (m.coeficiente !== undefined) {
      const raw = textoCelda(f, m.coeficiente).replace('%', '').trim();
      const n = parsearImporte(raw, raw.includes(',') ? ',' : '.');
      // 0,10 es el 10 %; 10 es el 10 %.
      if (Number.isFinite(n) && n > 0) coeficiente = n < 1 ? round2(n * 100) : n;
    } else if (m.vidaUtil !== undefined) {
      const anios = parsearImporte(f[m.vidaUtil], '.');
      if (Number.isFinite(anios) && anios > 0) coeficiente = Math.round((100 / anios) * 1000) / 1000;
    }
    const acum = num(f, m.amortAcumulada);
    const residual = num(f, m.valorResidual);
    activos.push({
      fila: desde + 2 + k,
      descripcion,
      ...(cuentaBien && /^2[0-3]\d/.test(cuentaBien) ? { cuentaBien } : {}),
      ...(cuenta(m.cuentaAmortAcum) ? { cuentaAmortAcum: cuenta(m.cuentaAmortAcum) } : {}),
      ...(cuenta(m.cuentaDotacion) ? { cuentaDotacion: cuenta(m.cuentaDotacion) } : {}),
      ...(m.fechaAlta !== undefined && parsearFecha(f[m.fechaAlta]) ? { fechaAlta: parsearFecha(f[m.fechaAlta])! } : {}),
      ...(m.fechaInicioAmort !== undefined && parsearFecha(f[m.fechaInicioAmort]) ? { fechaInicioAmort: parsearFecha(f[m.fechaInicioAmort])! } : {}),
      coste: round2(coste),
      amortAcumulada: Number.isNaN(acum) ? 0 : round2(Math.abs(acum)),
      ...(coeficiente !== undefined ? { coeficiente } : {}),
      valorResidual: Number.isNaN(residual) ? 0 : round2(residual),
    });
  });
  if (activos.some((a) => a.coeficiente === undefined)) avisos.push('Algún bien no trae el coeficiente ni la vida útil: hará falta para calcular la amortización.');
  // Si en mas de la mitad de los bienes la columna de la cuenta no trae una 2xx, la columna esta mal elegida.
  if (activos.length && m.cuenta !== undefined && sinCuentaDelGrupo2 * 2 > activos.length) {
    throw badRequest(
      'La columna que he tomado como cuenta del bien no trae cuentas del grupo 2 (211, 213, 216...) en la mayoría de los bienes. Indica qué columna es la cuenta.',
      { necesitaMapeo: true },
    );
  }
  return { activos, avisos };
}

/** Totales de la PyG o el balance en formato oficial (etiqueta y, a su derecha, el importe del ejercicio). */
function extraerTotalesOficiales(filas: unknown[][]): TotalesOficiales {
  const out: TotalesOficiales = { resultado: null, cifraNegocios: null, totalActivo: null, totalPnPasivo: null };
  const partidas: Record<string, number> = {};
  for (const f of filas) {
    if (!f) continue;
    const i = f.findIndex((c) => texto(c) !== '');
    if (i < 0) continue;
    const etiqueta = normalizarTitulo(f[i]);
    const importe = f.slice(i + 1).map((c) => (typeof c === 'number' ? c : parsearImporte(c))).find((n) => Number.isFinite(n));
    if (importe === undefined) continue;
    // Partidas principales: «1. Importe neto…», «7. Otros gastos…» (no las «a) …» de detalle).
    if (/^\d{1,2} /.test(etiqueta) && !/resultado (de explotacion|financiero|antes|del ejercicio|de las operaciones)/.test(etiqueta)) {
      const partida = PARTIDAS_PYG_TEXTO.find(([re]) => re.test(etiqueta))?.[1];
      if (partida && partidas[partida] === undefined) partidas[partida] = round2(importe);
    }
    if (/resultado del ejercicio/.test(etiqueta)) out.resultado = round2(importe);
    else if (/importe neto de la cifra de negocios/.test(etiqueta) && out.cifraNegocios === null) out.cifraNegocios = round2(importe);
    else if (/^total activo|total del activo|^activo total|total \(a\+b\)|^total a b$/.test(etiqueta) && out.totalActivo === null) out.totalActivo = round2(importe);
    else if (/total patrimonio neto y pasivo|^total pasivo|total \(a\+b\+c\)|^total a b c$/.test(etiqueta) && out.totalPnPasivo === null) out.totalPnPasivo = round2(importe);
  }
  if (Object.keys(partidas).length) out.partidas = partidas;
  return out;
}

/**
 * Saca los datos de una hoja segun su tipo. `opciones.cabecera` es la fila de
 * titulos detectada al clasificar; un mapeo a mano la sustituye.
 */
export function extraerHoja(tipo: TipoHoja, filasHoja: unknown[][], opciones: OpcionesExtraccion): ResultadoExtraccion {
  const avisos: string[] = [];
  const manual = opciones.mapeo && Object.keys(opciones.mapeo).length ? opciones.mapeo : null;
  let desde = manual ? (opciones.filaCabecera ?? 0) - 1 : (opciones.cabecera?.fila ?? -1);
  if (!Number.isInteger(desde) || desde < -1 || desde >= filasHoja.length) desde = -1;
  let m: Partial<Record<Campo, number>> = manual ?? opciones.cabecera?.campos ?? {};
  const formato = opciones.formato ?? 'xlsx';
  const base: ResultadoExtraccion = { extraccion: null, mapeo: m, avisos, error: null, codigosExpandidos: 0 };

  if (tipo === 'DESCONOCIDO') {
    return { ...base, error: { mensaje: 'No sé qué es esta hoja: elige qué tipo de listado es o quítala de la carga.', necesitaMapeo: false, faltan: [], columnas: [] } };
  }
  if (tipo === 'PYG' || tipo === 'BALANCE') {
    const totales = extraerTotalesOficiales(filasHoja);
    if (tipo === 'PYG' && totales.resultado === null) avisos.push('No encuentro la línea «Resultado del ejercicio» en la PyG.');
    return { ...base, extraccion: { tipo, totales } };
  }

  const filasSinRepetir = desde >= 0 ? quitarCabecerasRepetidas(filasHoja, desde) : filasHoja;
  // Sumas y saldos sin titulos: se deducen las columnas por su contenido.
  if (tipo === 'SUMAS_Y_SALDOS' && !manual && !opciones.cabecera) {
    const porContenido = mapeoSumasSaldosPorContenido(filasSinRepetir);
    if (porContenido) {
      m = porContenido;
      avisos.push('El sumas y saldos no trae títulos: las columnas se han deducido por su contenido. Revisa las cifras.');
    }
  }
  const regla = OBLIGATORIOS[tipo];
  const sinTitulosPlan = tipo === 'PLAN' && !manual && !opciones.cabecera;
  if (regla && !sinTitulosPlan && !regla.cumple(m)) {
    return {
      ...base,
      mapeo: m,
      error: {
        mensaje: `No encuentro en esta hoja ${regla.texto}. Indica qué columna es cada dato.`,
        necesitaMapeo: true,
        faltan: regla.faltan(m),
        columnas: describirColumnasHoja(filasHoja, desde),
      },
    };
  }

  const { filas, expandidos } = expandirCodigos(filasSinRepetir, [m.cuenta, m.cuentaAmortAcum, m.cuentaDotacion].filter((c): c is number => c !== undefined), opciones.longitud, desde);
  if (expandidos) avisos.push(`${expandidos} ${expandidos === 1 ? 'código venía' : 'códigos venían'} con punto de relleno («430.1»): se han completado con ceros.`);
  const conMapeo = { ...base, mapeo: m, codigosExpandidos: expandidos };

  try {
    switch (tipo) {
      case 'PLAN': {
        const r = extraerPlan(filas, m, desde, formato);
        avisos.push(...r.avisos);
        if (!r.cuentas.length) throw new Error('No encuentro cuentas en la hoja.');
        return { ...conMapeo, extraccion: { tipo, cuentas: r.cuentas } };
      }
      case 'TERCEROS_CLIENTES':
      case 'TERCEROS_PROVEEDORES': {
        const terceros = extraerTerceros(filas, m, desde, tipo === 'TERCEROS_CLIENTES' ? 'cliente' : 'proveedor');
        if (!terceros.length) throw new Error('No encuentro ningún cliente ni proveedor con NIF o subcuenta en la hoja.');
        return { ...conMapeo, extraccion: { tipo, terceros } };
      }
      case 'SUMAS_Y_SALDOS': {
        const lectura = leerBalanceDeFilas(filas, { mapeo: aMapeo(m, CAMPOS_BALANCE), filaCabecera: desde + 1, conservarCeros: true }, formato);
        avisos.push(...lectura.avisos);
        return { ...conMapeo, extraccion: { tipo, lectura } };
      }
      case 'DIARIO': {
        const lectura = leerDiarioDeFilas(filas, { mapeo: aMapeo(m, CAMPOS_DIARIO), filaCabecera: desde + 1 }, formato);
        avisos.push(...lectura.avisos);
        return { ...conMapeo, extraccion: { tipo, lectura } };
      }
      case 'CARTERA': {
        const r = extraerCartera(filas, m, desde);
        avisos.push(...r.avisos);
        return { ...conMapeo, extraccion: { tipo, partidas: r.partidas } };
      }
      case 'INMOVILIZADO': {
        const r = extraerInmovilizado(filas, m, desde);
        avisos.push(...r.avisos);
        if (!r.activos.length) throw new Error('No encuentro ningún bien con su coste en la hoja.');
        return { ...conMapeo, extraccion: { tipo, activos: r.activos } };
      }
    }
  } catch (e) {
    const detalles = (e as { details?: { necesitaMapeo?: boolean } }).details;
    return {
      ...conMapeo,
      error: {
        mensaje: (e as Error).message || 'No se ha podido leer la hoja.',
        necesitaMapeo: !!detalles?.necesitaMapeo,
        faltan: [],
        columnas: describirColumnasHoja(filasHoja, desde),
      },
    };
  }
  return conMapeo;
}
