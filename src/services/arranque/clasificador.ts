/**
 * Que es cada hoja que manda la gestoria: plan de cuentas, sumas y saldos,
 * diario, clientes, proveedores, cartera, inmovilizado, balance o PyG.
 *
 * No depende de saber el programa: se decide por los titulos de las columnas y
 * por el contenido (codigos de cuenta, fechas, NIF, si los codigos se repiten).
 * El programa solo se nombra cuando hay una huella clara y sirve para el texto
 * de ayuda («Parece un listado de a3ECO»); si la huella y el contenido no
 * coinciden, manda el contenido.
 *
 * Umbral: un tipo vale con 0,7 puntos o mas y al menos 0,2 por encima del
 * segundo. Si no, la hoja queda «dudosa» con los dos tipos mas probables para
 * que la persona elija con un clic.
 *
 * Funciones puras.
 */
import { cuentaYNombre, normalizarCuenta, normalizarTitulo, parsearFecha, texto } from '../puestaEnMarcha/lectorContable';
import { normalizarNif } from '../../utils/nif';
import { detectarCabecera, type CabeceraDetectada, type Campo } from './campos';

export type TipoHoja =
  | 'PLAN'
  | 'TERCEROS_CLIENTES'
  | 'TERCEROS_PROVEEDORES'
  | 'SUMAS_Y_SALDOS'
  | 'DIARIO'
  | 'CARTERA'
  | 'INMOVILIZADO'
  | 'BALANCE'
  | 'PYG'
  | 'DESCONOCIDO';

export const TIPOS_HOJA: readonly Exclude<TipoHoja, 'DESCONOCIDO'>[] = [
  'PLAN',
  'TERCEROS_CLIENTES',
  'TERCEROS_PROVEEDORES',
  'SUMAS_Y_SALDOS',
  'DIARIO',
  'CARTERA',
  'INMOVILIZADO',
  'BALANCE',
  'PYG',
];

/** Como se llama cada tipo en pantalla. */
export const NOMBRE_TIPO: Record<TipoHoja, string> = {
  PLAN: 'Plan de cuentas',
  TERCEROS_CLIENTES: 'Listado de clientes',
  TERCEROS_PROVEEDORES: 'Listado de proveedores y acreedores',
  SUMAS_Y_SALDOS: 'Sumas y saldos',
  DIARIO: 'Libro diario',
  CARTERA: 'Cartera de cobros y pagos pendientes',
  INMOVILIZADO: 'Inmovilizado',
  BALANCE: 'Balance de situación',
  PYG: 'Cuenta de pérdidas y ganancias',
  DESCONOCIDO: 'Sin reconocer',
};

export type Programa = 'a3' | 'contaplus' | 'sage' | 'holded' | 'contasol' | 'monitor' | 'generico';

export const NOMBRE_PROGRAMA: Record<Programa, string> = {
  a3: 'a3ECO / a3asesor',
  contaplus: 'ContaPlus / Sage Despachos',
  sage: 'Sage 50 / Sage 200',
  holded: 'Holded',
  contasol: 'Contasol',
  monitor: 'Monitor Informático',
  generico: 'Excel genérico',
};

export const UMBRAL_TIPO = 0.7;
export const MARGEN_TIPO = 0.2;

export interface Clasificacion {
  /** El tipo reconocido; DESCONOCIDO si la hoja es dudosa o no se parece a nada. */
  tipo: TipoHoja;
  confianza: number;
  /** Los tipos con puntos, de mas a menos (como mucho tres). */
  candidatos: Array<{ tipo: Exclude<TipoHoja, 'DESCONOCIDO'>; puntos: number }>;
  dudosa: boolean;
  programa: Programa;
  /** «Parece un listado de a3ECO»; null si no hay huella clara. */
  textoPrograma: string | null;
  cabecera: CabeceraDetectada | null;
  /** Fecha (AAAA-MM-DD) que dicen las filas de titulo («a 31/12/2026»), la ultima si hay varias. */
  fechaCorte: string | null;
  /** Filas con datos (sin titulos). */
  filasDatos: number;
}

export interface HojaAClasificar {
  fichero: string;
  hoja: string;
  filas: unknown[][];
  formato?: string;
}

// ---------------------------------------------------------------------------
// Señales
// ---------------------------------------------------------------------------

const PALABRAS = {
  sumasSaldos: /sumas y saldos|sumas saldos|balance de comprobacion|balance de sumas|sys\b/,
  diario: /\bdiario\b|\bmayor\b|extracto de (cuentas|subcuentas)|movimientos contables|apuntes/,
  plan: /plan (de )?cuentas|plan contable|subcuentas|cuadro de cuentas|maestro de cuentas|\bsubcta\b/,
  clientes: /\bclientes?\b|\bdeudores\b/,
  proveedores: /\bproveedor(es)?\b|\bacreedor(es)?\b/,
  cartera: /cartera|vencimientos|\befectos\b|pendientes? de (cobro|pago)|composicion de saldos|partidas abiertas|facturas pendientes|cobros y pagos/,
  inmovilizado: /inmovilizado|amortizaci|activos? fijos?|bienes de inversion/,
  pyg: /perdidas y ganancias|cuenta de resultados|\bpyg\b/,
  balance: /balance de situacion|balance abreviado|balance pymes|balance normal/,
};

const RE_ETIQUETA_OFICIAL = /^(?:[A-E]\)|[IVX]{1,4}\.|\d{1,2}\.|[a-z]\))\s+\S/;

interface Senales {
  campos: Set<Campo>;
  textoTitulos: string;
  codigos: string[];
  repeticion: number;
  grupos: number;
  /** Proporcion de codigos que son de clientes o proveedores (43, 40, 41). */
  deTerceros: number;
  prefijoTercero: 'cliente' | 'proveedor' | null;
  nifValidos: number;
  encabezadosCuenta: number;
  etiquetasOficiales: number;
  filasDatos: number;
  columnasSinTitulo: { codigos: boolean; texto: boolean; numeros: boolean };
  /** Texto de las 200 primeras filas (para reconocer el balance y la PyG oficiales). */
  textoFilas: string;
}

const nifConForma = (v: unknown) => /^([A-Z]\d{7}[A-Z0-9]|\d{8}[A-Z]|[XYZ]\d{7}[A-Z]|[A-Z]{2}[A-Z0-9]{5,13})$/.test(normalizarNif(v));

function filasConDatos(filas: unknown[][], desde: number): unknown[][] {
  return filas.slice(desde).filter((f) => (f ?? []).some((c) => texto(c) !== '')).slice(0, 3000);
}

function senales(h: HojaAClasificar, cab: CabeceraDetectada | null): Senales {
  const campos = new Set<Campo>(cab ? (Object.keys(cab.campos) as Campo[]) : []);
  const titulosArriba = cab ? h.filas.slice(0, cab.fila) : h.filas.slice(0, 5);
  const textoTitulos = normalizarTitulo(
    [h.fichero.replace(/\.[a-z0-9]+$/i, ''), h.hoja, ...titulosArriba.flatMap((f) => (f ?? []).map((c) => texto(c)))].join(' '),
  );
  const datos = filasConDatos(h.filas, cab ? cab.fila + 1 : 0);

  // Codigos de la columna de cuenta (o de la primera columna con codigos, sin titulos).
  let colCuenta = cab?.campos.cuenta;
  const columnasSinTitulo = { codigos: false, texto: false, numeros: false };
  if (!cab) {
    const ancho = Math.max(0, ...datos.slice(0, 200).map((f) => (f ?? []).length));
    for (let j = 0; j < ancho; j++) {
      const vals = datos.slice(0, 200).map((f) => f?.[j]).filter((v) => texto(v) !== '');
      if (!vals.length) continue;
      const codigos = vals.filter((v) => normalizarCuenta(v) || cuentaYNombre(v)).length / vals.length;
      const numeros = vals.filter((v) => typeof v === 'number' || /^-?[\d.]+,\d{1,2}$|^-?\d+\.\d{1,2}$/.test(texto(v))).length / vals.length;
      const letras = vals.filter((v) => /[a-zA-ZñÑ]{3,}/.test(texto(v))).length / vals.length;
      if (codigos >= 0.8 && colCuenta === undefined) {
        colCuenta = j;
        columnasSinTitulo.codigos = true;
      } else if (letras >= 0.6) columnasSinTitulo.texto = true;
      else if (numeros >= 0.6) columnasSinTitulo.numeros = true;
    }
  }
  const codigos: string[] = [];
  if (colCuenta !== undefined) {
    for (const f of datos) {
      const v = f?.[colCuenta];
      const c = normalizarCuenta(v) ?? cuentaYNombre(v)?.codigo ?? null;
      if (c) codigos.push(c);
    }
  }
  const unicos = new Set(codigos);
  const repeticion = codigos.length ? 1 - unicos.size / codigos.length : 0;
  const grupos = new Set(codigos.map((c) => c[0])).size;
  const terceros = codigos.filter((c) => /^4[03]/.test(c) || c.startsWith('41'));
  const deTerceros = codigos.length ? terceros.length / codigos.length : 0;
  const clientes = terceros.filter((c) => c.startsWith('43')).length;
  const prefijoTercero = terceros.length ? (clientes * 2 > terceros.length ? 'cliente' : clientes * 2 < terceros.length ? 'proveedor' : null) : null;

  let nifValidos = 0;
  if (cab?.campos.nif !== undefined) {
    const vals = datos.map((f) => f?.[cab.campos.nif!]).filter((v) => texto(v) !== '');
    nifValidos = vals.length ? vals.filter(nifConForma).length / vals.length : 0;
  }

  // Mayor por cuenta: lineas sueltas «Cuenta: 4300000001 Cliente SL» entre los apuntes.
  const encabezadosCuenta = h.filas.filter((f) => {
    const con = (f ?? []).filter((c) => texto(c) !== '');
    if (!con.length || con.length > 3) return false;
    const cn = cuentaYNombre(con[0]);
    return !!cn && cn.codigo.length >= 6 && cn.nombre !== '';
  }).length;

  const etiquetasOficiales = h.filas.filter((f) => {
    const primera = (f ?? []).find((c) => texto(c) !== '');
    return primera !== undefined && typeof primera === 'string' && RE_ETIQUETA_OFICIAL.test(primera.trim());
  }).length;

  return {
    campos,
    textoTitulos,
    codigos,
    repeticion,
    grupos,
    deTerceros,
    prefijoTercero,
    nifValidos,
    encabezadosCuenta,
    etiquetasOficiales,
    filasDatos: datos.length,
    columnasSinTitulo,
    textoFilas: normalizarTitulo(h.filas.slice(0, 200).flatMap((f) => (f ?? []).map((c) => texto(c))).join(' ')),
  };
}

// ---------------------------------------------------------------------------
// Puntuacion
// ---------------------------------------------------------------------------

const IMPORTES_SALDO: Campo[] = ['debe', 'haber', 'saldoDeudor', 'saldoAcreedor', 'saldo'];
const CUALQUIER_IMPORTE: Campo[] = [...IMPORTES_SALDO, 'importe', 'pendiente', 'importeOriginal', 'coste', 'amortAcumulada', 'valorResidual'];
const CUALQUIER_FECHA: Campo[] = ['fecha', 'vencimiento', 'fechaAlta', 'fechaInicioAmort'];

function puntuar(s: Senales): Record<Exclude<TipoHoja, 'DESCONOCIDO'>, number> {
  const t = (c: Campo) => s.campos.has(c);
  const alguno = (cs: Campo[]) => cs.some(t);
  const conImportesDeSaldo = (t('debe') && t('haber')) || (t('saldoDeudor') && t('saldoAcreedor')) || t('saldo');
  const titulo = (re: RegExp) => re.test(s.textoTitulos);
  const p = {
    PLAN: 0,
    TERCEROS_CLIENTES: 0,
    TERCEROS_PROVEEDORES: 0,
    SUMAS_Y_SALDOS: 0,
    DIARIO: 0,
    CARTERA: 0,
    INMOVILIZADO: 0,
    BALANCE: 0,
    PYG: 0,
  };
  const sinCuentaColumna = !t('cuenta') && !s.columnasSinTitulo.codigos;

  // Plan: codigo y nombre, sin importes ni fechas, codigos sin repetir.
  if ((t('cuenta') || s.columnasSinTitulo.codigos) && (t('nombre') || s.columnasSinTitulo.texto) && !alguno(CUALQUIER_IMPORTE) && !alguno(CUALQUIER_FECHA) && !t('documento') && !s.columnasSinTitulo.numeros) {
    p.PLAN = 0.6;
    if (s.repeticion < 0.02) p.PLAN += 0.15;
    if (s.grupos >= 3) p.PLAN += 0.1;
    if (t('nif')) p.PLAN += 0.1;
    if (titulo(PALABRAS.plan)) p.PLAN += 0.15;
    if (s.deTerceros > 0.95 && s.grupos < 3) p.PLAN -= 0.35;
  }

  // Listado de clientes o proveedores: NIF y nombre, sin importes.
  if (t('nif') && t('nombre') && !alguno(CUALQUIER_IMPORTE) && !t('fecha') && !t('documento')) {
    let base = 0.6;
    if (s.nifValidos >= 0.6) base += 0.2;
    if (alguno(['direccion', 'cp', 'municipio', 'provincia', 'email', 'telefono'])) base += 0.1;
    if (t('cuenta') && s.deTerceros > 0.95) base += 0.1;
    if (t('cuenta') && s.grupos >= 3) base -= 0.4;
    const esCliente = titulo(PALABRAS.clientes);
    const esProveedor = titulo(PALABRAS.proveedores);
    const porCodigo = s.prefijoTercero;
    if (porCodigo === 'cliente' || (!porCodigo && esCliente && !esProveedor)) {
      p.TERCEROS_CLIENTES = base + (esCliente ? 0.1 : 0);
    } else if (porCodigo === 'proveedor' || (!porCodigo && esProveedor && !esCliente)) {
      p.TERCEROS_PROVEEDORES = base + (esProveedor ? 0.1 : 0);
    } else {
      // No se sabe si son clientes o proveedores: los dos empatan y la hoja queda dudosa.
      p.TERCEROS_CLIENTES = base;
      p.TERCEROS_PROVEEDORES = base;
    }
  }

  // Sumas y saldos: codigo e importes de saldo, sin fecha por fila.
  if ((t('cuenta') || s.columnasSinTitulo.codigos) && (conImportesDeSaldo || s.columnasSinTitulo.numeros) && !t('fecha') && !t('vencimiento')) {
    p.SUMAS_Y_SALDOS = conImportesDeSaldo ? 0.6 : 0.45;
    if (s.repeticion < 0.02) p.SUMAS_Y_SALDOS += 0.15;
    if (s.grupos >= 3) p.SUMAS_Y_SALDOS += 0.1;
    if (titulo(PALABRAS.sumasSaldos)) p.SUMAS_Y_SALDOS += 0.15;
    if (t('documento')) p.SUMAS_Y_SALDOS -= 0.4;
  }

  // Diario o mayor: fecha, cuenta (en columna o en encabezados) e importes.
  if (t('fecha') && ((t('debe') && t('haber')) || t('importe'))) {
    p.DIARIO = 0.5;
    if (t('cuenta') || s.encabezadosCuenta >= 2) p.DIARIO += 0.15;
    if (s.repeticion > 0.2 || (sinCuentaColumna && s.encabezadosCuenta >= 2)) p.DIARIO += 0.15;
    if (t('asiento')) p.DIARIO += 0.1;
    if (titulo(PALABRAS.diario)) p.DIARIO += 0.15;
    if (t('documento') && (t('vencimiento') || t('pendiente'))) p.DIARIO -= 0.4;
  }

  // Cartera: tercero, documento, vencimiento e importe pendiente.
  if ((t('cuenta') || t('nif') || t('nombre')) && t('documento') && (t('pendiente') || t('importe') || t('importeOriginal') || conImportesDeSaldo)) {
    p.CARTERA = 0.55;
    if (t('vencimiento')) p.CARTERA += 0.2;
    if (t('pendiente')) p.CARTERA += 0.1;
    if (titulo(PALABRAS.cartera)) p.CARTERA += 0.15;
  }

  // Inmovilizado: bien, coste y amortizacion acumulada.
  if (t('nombre') && t('coste')) {
    p.INMOVILIZADO = 0.5;
    if (t('amortAcumulada')) p.INMOVILIZADO += 0.2;
    if (t('fechaAlta') || t('fechaInicioAmort')) p.INMOVILIZADO += 0.1;
    if (t('coeficiente') || t('vidaUtil')) p.INMOVILIZADO += 0.1;
    if (titulo(PALABRAS.inmovilizado)) p.INMOVILIZADO += 0.15;
  }

  // Balance o PyG oficiales: filas «A) ACTIVO NO CORRIENTE», «1. Importe neto...», sin codigos.
  if (s.etiquetasOficiales >= 5 && s.codigos.length < s.etiquetasOficiales) {
    const esPyg = /importe neto de la cifra de negocios|resultado del ejercicio|aprovisionamientos|gastos de personal/.test(s.textoFilas);
    const esBalance = /activo no corriente|patrimonio neto|pasivo corriente/.test(s.textoFilas);
    if (esPyg && !esBalance) p.PYG = 0.7 + (titulo(PALABRAS.pyg) ? 0.2 : 0.1);
    else if (esBalance && !esPyg) p.BALANCE = 0.7 + (titulo(PALABRAS.balance) ? 0.2 : 0.1);
    else {
      p.PYG = 0.6 + (titulo(PALABRAS.pyg) ? 0.2 : 0);
      p.BALANCE = 0.6 + (titulo(PALABRAS.balance) ? 0.2 : 0);
    }
  }

  for (const k of Object.keys(p) as Array<keyof typeof p>) p[k] = Math.round(Math.max(0, Math.min(1, p[k])) * 100) / 100;
  return p;
}

// ---------------------------------------------------------------------------
// Programa (huella) y fecha de corte
// ---------------------------------------------------------------------------

/**
 * Programa que parece haber generado la hoja. Ninguna huella esta comprobada
 * con ficheros reales: son los titulos que suelen sacar estos programas.
 */
export function detectarPrograma(textoTitulos: string, titulos: string[], formato?: string): Programa {
  const todo = `${textoTitulos} ${titulos.join(' ')}`;
  if (/\ba3 ?(eco|asesor|innuva|con|nom)?\b|\ba3eco\b|\ba3innuva\b|\ba3asesor\b/.test(todo)) return 'a3';
  if (formato === 'dbf' || /contaplus|sage despachos|\bsubcta\b|\beurodebe\b|\bptadebe\b/.test(todo)) return 'contaplus';
  if (/\bholded\b/.test(todo)) return 'holded';
  if (/contasol|software del sol/.test(todo)) return 'contasol';
  if (/contamonitor|monitor informatico|\bmonitor\b/.test(todo)) return 'monitor';
  if (/\bsage\b/.test(todo)) return 'sage';
  return 'generico';
}

const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

/** Fecha de corte que dicen las filas de titulo: la ultima fecha que aparece («del 01/01/2026 al 31/12/2026» -> 31-12-2026). */
export function fechaCorteDeTitulos(filas: unknown[][]): string | null {
  const fechas: string[] = [];
  for (const f of filas) {
    for (const c of f ?? []) {
      const s = texto(c);
      if (!s) continue;
      for (const m of s.matchAll(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/g)) {
        const d = parsearFecha(m[0]);
        if (d) fechas.push(d);
      }
      for (const m of normalizarTitulo(s).matchAll(/(\d{1,2}) de ([a-z]+) de (\d{4})/g)) {
        const mes = MESES[m[2]];
        if (mes) {
          const d = parsearFecha(`${m[3]}-${String(mes).padStart(2, '0')}-${m[1].padStart(2, '0')}`);
          if (d) fechas.push(d);
        }
      }
    }
  }
  return fechas.length ? fechas.sort().at(-1)! : null;
}

// ---------------------------------------------------------------------------
// Clasificar
// ---------------------------------------------------------------------------

/** Clasifica una hoja por sus titulos y su contenido. */
export function clasificarHoja(h: HojaAClasificar): Clasificacion {
  const cab = detectarCabecera(h.filas);
  const s = senales(h, cab);
  const puntos = puntuar(s);
  const candidatos = (Object.entries(puntos) as Array<[Exclude<TipoHoja, 'DESCONOCIDO'>, number]>)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([tipo, n]) => ({ tipo, puntos: n }));
  const [primero, segundo] = candidatos;
  const vale = !!primero && primero.puntos >= UMBRAL_TIPO && primero.puntos - (segundo?.puntos ?? 0) >= MARGEN_TIPO - 1e-9;
  const programa = detectarPrograma(s.textoTitulos, cab?.titulos ?? [], h.formato);
  const filasTitulo = cab ? h.filas.slice(0, cab.fila) : h.filas.slice(0, 5);
  return {
    tipo: vale ? primero.tipo : 'DESCONOCIDO',
    confianza: primero?.puntos ?? 0,
    candidatos,
    dudosa: !vale,
    programa,
    textoPrograma: programa === 'generico' ? null : `Parece un listado de ${NOMBRE_PROGRAMA[programa]}`,
    cabecera: cab,
    fechaCorte: fechaCorteDeTitulos(filasTitulo),
    filasDatos: s.filasDatos,
  };
}
