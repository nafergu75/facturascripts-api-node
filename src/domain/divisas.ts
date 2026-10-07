/**
 * Divisas: catalogo de monedas, convencion del tipo de cambio, conversion,
 * calendario TARGET y cobro en divisa. Todo puro (sin BD ni red).
 *
 * CONVENCION UNICA DEL TIPO DE CAMBIO (la del BCE y las Resoluciones del BdE):
 * `tipoCambio` = unidades de la moneda del documento por 1 unidad de la moneda
 * de cuenta ("1 EUR = 1,1490 USD"). Para pasar a la moneda de cuenta SOLO se
 * divide, y solo aqui: importeCuenta = redondear2(importeDoc / tipoCambio).
 *
 * Moneda de cuenta = la de la contabilidad de la empresa (LegalConfig.monedaCuenta):
 * EUR en las espanolas; USD en las de EE. UU. y Hong Kong.
 */
import { badRequest } from '../utils/http-errors';
import { aCentimos, redondear2, redondear8 } from '../utils/money';

export interface InfoMoneda {
  codigo: string;
  nombre: { es: string; en: string };
  /** Simbolo corto que no se confunde con otra moneda (US$, HK$...). */
  simbolo: string;
  /** Todas las del catalogo tienen 2 decimales (JPY, KWD... quedan fuera). */
  decimales: 2;
}

const m = (codigo: string, es: string, en: string, simbolo: string): InfoMoneda => ({
  codigo,
  nombre: { es, en },
  simbolo,
  decimales: 2,
});

/** Catalogo: monedas de 2 decimales con tipo de referencia diario del BCE. */
export const MONEDAS_FACTURA: Readonly<Record<string, InfoMoneda>> = Object.freeze({
  EUR: m('EUR', 'euros', 'euros', '€'),
  USD: m('USD', 'dólares estadounidenses', 'US dollars', 'US$'),
  GBP: m('GBP', 'libras esterlinas', 'pounds sterling', '£'),
  CHF: m('CHF', 'francos suizos', 'Swiss francs', 'CHF'),
  HKD: m('HKD', 'dólares de Hong Kong', 'Hong Kong dollars', 'HK$'),
  CAD: m('CAD', 'dólares canadienses', 'Canadian dollars', 'CA$'),
  AUD: m('AUD', 'dólares australianos', 'Australian dollars', 'A$'),
  CNY: m('CNY', 'yuanes renminbi', 'Chinese yuan renminbi', 'CN¥'),
  MXN: m('MXN', 'pesos mexicanos', 'Mexican pesos', 'MX$'),
  SEK: m('SEK', 'coronas suecas', 'Swedish kronor', 'SEK'),
  NOK: m('NOK', 'coronas noruegas', 'Norwegian kroner', 'NOK'),
  DKK: m('DKK', 'coronas danesas', 'Danish kroner', 'DKK'),
  PLN: m('PLN', 'esloti polacos', 'Polish zloty', 'PLN'),
  CZK: m('CZK', 'coronas checas', 'Czech koruny', 'CZK'),
  SGD: m('SGD', 'dólares de Singapur', 'Singapore dollars', 'S$'),
});

/**
 * Monedas en las que una empresa ESPANOLA puede emitir facturas: SOLO euro y
 * dolar estadounidense (decision del usuario). El resto del catalogo queda
 * desactivado; para activar una, anadirla aqui (todas tienen tipo diario del
 * BCE y 2 decimales).
 */
export const MONEDAS_FACTURA_ACTIVAS: readonly string[] = Object.freeze(['EUR', 'USD']);

/**
 * Monedas que puede tener la contabilidad de una empresa. EUR obligatoria en
 * las espanolas; las de EE. UU. y Hong Kong llevan su contabilidad en USD.
 */
export const MONEDAS_CUENTA_HABILITADAS: readonly string[] = Object.freeze(['EUR', 'USD']);

export const MONEDA_CUENTA_POR_DEFECTO = 'EUR';

/** De donde sale el tipo de cambio de una factura. */
export const FUENTES_TIPO_CAMBIO = ['PAR', 'BCE', 'MANUAL', 'HEREDADO', 'PENDIENTE'] as const;
export type FuenteTipoCambio = (typeof FUENTES_TIPO_CAMBIO)[number];
/** Fuentes con las que el tipo esta fijado (una factura emitida en divisa lleva una de estas). */
export const FUENTES_FIJADAS: readonly FuenteTipoCambio[] = ['BCE', 'MANUAL', 'HEREDADO'];

/** 'usd ' -> 'USD'. */
export function normalizarMoneda(valor: unknown): string {
  return String(valor ?? '')
    .replace(/\s+/g, '')
    .toUpperCase();
}

export function nombreMoneda(codigo: string, idioma: 'es' | 'en' = 'es'): string {
  return MONEDAS_FACTURA[codigo]?.nombre[idioma] ?? codigo;
}

/** Valida y normaliza una moneda contra la lista permitida (400 si no esta). */
export function validarMoneda(valor: unknown, permitidas: readonly string[] = MONEDAS_FACTURA_ACTIVAS): string {
  const codigo = normalizarMoneda(valor);
  if (!/^[A-Z]{3}$/.test(codigo)) throw badRequest('La moneda tiene que ser un código ISO de tres letras (EUR, USD...).');
  if (!permitidas.includes(codigo)) {
    const motivo = MONEDAS_FACTURA[codigo] ? 'no está habilitada' : 'no está disponible';
    throw badRequest(`La moneda ${codigo} ${motivo}. Usa: ${permitidas.join(', ')}.`);
  }
  return codigo;
}

/** Estados de la UE (ISO-2), Espana incluida: llevan la contabilidad en euros. */
const PAISES_UE_EUR = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'EL', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV',
  'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
]);
/** Paises cuyas empresas trabajan SOLO en dolares (decision del usuario: EE. UU. y Hong Kong). */
const PAISES_SOLO_USD = new Set(['US', 'HK']);

/**
 * Monedas de la contabilidad que admite una empresa segun su pais: Espana y el
 * resto de la UE, solo EUR; EE. UU. y Hong Kong, solo USD; el resto, las dos.
 */
export function monedasCuentaPermitidas(pais: string | null | undefined): readonly string[] {
  const p = String(pais ?? '').trim().toUpperCase() || 'ES';
  if (PAISES_UE_EUR.has(p)) return ['EUR'];
  if (PAISES_SOLO_USD.has(p)) return ['USD'];
  return MONEDAS_CUENTA_HABILITADAS;
}

/** Valida la moneda de la contabilidad de una empresa (y que corresponde a su pais). */
export function validarMonedaCuenta(valor: unknown, pais: string): string {
  const codigo = validarMoneda(valor, MONEDAS_CUENTA_HABILITADAS);
  if (!monedasCuentaPermitidas(pais).includes(codigo)) {
    const p = String(pais ?? 'ES').trim().toUpperCase() || 'ES';
    throw badRequest(
      p === 'ES'
        ? 'Una empresa establecida en España lleva la contabilidad en euros (EUR).'
        : PAISES_SOLO_USD.has(p)
          ? 'Las empresas de EE. UU. y Hong Kong llevan la contabilidad en dólares (USD).'
          : 'Una empresa de la UE lleva la contabilidad en euros (EUR).',
    );
  }
  return codigo;
}

// ---------------------------------------------------------------------------
// Tipo de cambio
// ---------------------------------------------------------------------------

/**
 * Formato de un tipo de cambio indicado a mano: numero finito, > 0, <= 1e6 y
 * con 8 decimales como maximo. Acepta "1,1490" o "1.1490".
 */
export function validarFormatoTipoCambio(valor: unknown): number {
  const texto = typeof valor === 'string' ? valor.trim().replace(',', '.') : valor;
  const n = typeof texto === 'number' ? texto : Number(texto);
  if (texto === '' || texto === null || !Number.isFinite(n)) throw badRequest('El tipo de cambio no es un número.');
  if (n <= 0) throw badRequest('El tipo de cambio tiene que ser mayor que cero.');
  if (n > 1e6) throw badRequest('El tipo de cambio es demasiado grande.');
  if (Math.abs(redondear8(n) - n) > 1e-12) throw badRequest('El tipo de cambio admite como máximo 8 decimales.');
  // Con 8 decimales un valor diminuto queda en 0: no vale (y dividir por el daria un error interno).
  if (!(redondear8(n) > 0)) throw badRequest('El tipo de cambio tiene que ser mayor que cero.');
  return redondear8(n);
}

/**
 * true si el tipo manual parece el inverso del BCE (1 USD = 0,87 EUR en vez de
 * 1 EUR = 1,149 USD). No se aplica a monedas casi a la par (CHF, por ejemplo).
 */
export function pareceInvertido(manual: number, bce: number): boolean {
  return Math.abs(manual * bce - 1) < 0.03 && Math.abs(bce - 1) > 0.05;
}

/** Desviacion relativa del tipo manual respecto al del BCE (0.01 = 1 %). */
export function desviacion(manual: number, bce: number): number {
  return Math.abs(manual - bce) / bce;
}

/** Por encima de esta desviacion se avisa (sin bloquear). */
export const DESVIACION_AVISO = 0.005;

/**
 * Unidades por 1 EUR APROXIMADAS de las monedas activas (orden de magnitud de
 * 2024-2026). Solo sirven para descartar un tipo manual absurdo o invertido
 * cuando no hay ningun dato del BCE (ni de ese dia ni guardado): nunca se
 * aplican a un importe.
 */
const UNIDADES_POR_EUR_ORIENTATIVAS: Readonly<Record<string, number>> = Object.freeze({ EUR: 1, USD: 1.12 });

/** Tipo aproximado "unidades de `moneda` por 1 de `monedaCuenta`", o null si no se conoce. */
export function tipoOrientativo(monedaCuenta: string, moneda: string): number | null {
  const doc = UNIDADES_POR_EUR_ORIENTATIVAS[moneda];
  const cuenta = UNIDADES_POR_EUR_ORIENTATIVAS[monedaCuenta];
  return doc && cuenta ? redondear8(doc / cuenta) : null;
}

/**
 * Comprueba un tipo indicado a mano (o el que sale de lo recibido en el banco)
 * contra el de referencia: rechaza el invertido y el que se sale de
 * [ref/2, ref*2]; avisa si se desvia mas de un 0,5 %.
 *
 * La referencia es la del BCE de esa fecha. Si no la hay, `aproximado` (el
 * ultimo tipo guardado) o, sin ninguno, el orientativo: se rechaza igual lo
 * invertido o absurdo, y se avisa de que no se ha podido comprobar con el BCE.
 */
export function comprobarTipoManual(
  manual: number,
  referencia: number | null,
  monedaCuenta: string,
  moneda: string,
  opciones: { aproximado?: boolean; origen?: 'manual' | 'banco' } = {},
): { aviso?: string } {
  let ref = referencia !== null && referencia > 0 ? referencia : null;
  let aproximado = !!opciones.aproximado;
  if (ref === null) {
    ref = tipoOrientativo(monedaCuenta, moneda);
    aproximado = true;
  }
  if (ref === null) return {};
  const texto = aproximado
    ? `referencia aproximada, sin el tipo del BCE de esa fecha: 1 ${monedaCuenta} = ${formatoTipo(ref)} ${moneda}`
    : `BCE: ${textoTipo(monedaCuenta, moneda, ref)}`;
  const banco = opciones.origen === 'banco';
  const sujeto = banco ? `Lo recibido en el banco equivale a ${textoTipo(monedaCuenta, moneda, manual)}, que` : `El tipo ${formatoTipo(manual)}`;
  const revisa = banco ? ` Comprueba que lo recibido está en ${monedaCuenta}.` : '';
  if (pareceInvertido(manual, ref)) {
    throw badRequest(`${sujeto} parece invertido: indica cuántos ${moneda} vale 1 ${monedaCuenta} (${texto}).${revisa}`);
  }
  if (manual < ref / 2 || manual > ref * 2) {
    throw badRequest(`${sujeto} está muy lejos del tipo de referencia (${texto}). Revísalo.${revisa}`);
  }
  if (aproximado) {
    return { aviso: `No se ha podido comprobar el tipo con el del BCE de esa fecha (${texto}): revisa que es correcto.` };
  }
  if (desviacion(manual, ref) > DESVIACION_AVISO) {
    return { aviso: `El tipo indicado se desvía más de un 0,5 % del de referencia del BCE (${textoTipo(monedaCuenta, moneda, ref)}).` };
  }
  return {};
}

/** Importe en la moneda del documento -> moneda de cuenta. La UNICA conversion. */
export function aCuenta(importeDoc: number, tipoCambio: number): number {
  if (!(tipoCambio > 0)) throw new Error(`Tipo de cambio no válido: ${tipoCambio}`);
  return redondear2(importeDoc / tipoCambio);
}

/** Moneda de cuenta -> documento. Solo para PROPONER precios (productos). */
export function aDoc(importeCuenta: number, tipoCambio: number): number {
  return redondear2(importeCuenta * tipoCambio);
}

/** Inverso de un tipo (solo de ayuda: "1 USD = 0,8703 EUR"; no se guarda). */
export function inverso(tipoCambio: number): number {
  return redondear8(1 / tipoCambio);
}

/**
 * Tipo cruzado a partir de los del BCE (unidades por 1 EUR, r(EUR) = 1):
 * unidades de la moneda del documento por 1 de la moneda de cuenta. Las dos
 * observaciones tienen que ser del mismo dia.
 */
export function tipoCruzado(unidadesDocPorEur: number, unidadesCuentaPorEur: number): number {
  return redondear8(unidadesDocPorEur / unidadesCuentaPorEur);
}

/** 1.149 -> '1,1490' (4 decimales, formato espanol) o '1.1490' en ingles. */
export function formatoTipo(tipoCambio: number, idioma: 'es' | 'en' = 'es'): string {
  const t = tipoCambio.toFixed(4);
  return idioma === 'es' ? t.replace('.', ',') : t;
}

/** Texto unico del tipo: '1 EUR = 1,1490 USD'. */
export function textoTipo(monedaCuenta: string, moneda: string, tipoCambio: number, idioma: 'es' | 'en' = 'es'): string {
  return `1 ${monedaCuenta} = ${formatoTipo(tipoCambio, idioma)} ${moneda}`;
}

// ---------------------------------------------------------------------------
// Calendario TARGET (dias en que el BCE publica tipos de referencia)
// ---------------------------------------------------------------------------

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const desdeIso = (fecha: string): Date => new Date(`${fecha}T00:00:00Z`);

/** Domingo de Pascua (algoritmo de Meeus/Jones/Butcher), AAAA-MM-DD. */
export function pascua(anio: number): string {
  const a = anio % 19;
  const b = Math.floor(anio / 100);
  const c = anio % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const mm = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * mm + 114) / 31);
  const dia = ((h + l - 7 * mm + 114) % 31) + 1;
  return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

function sumarDias(fecha: string, dias: number): string {
  const d = desdeIso(fecha);
  d.setUTCDate(d.getUTCDate() + dias);
  return iso(d);
}

/**
 * Dia habil TARGET: no es sabado ni domingo, ni 1/1, Viernes Santo, Lunes de
 * Pascua, 1/5, 25/12 o 26/12.
 */
export function esDiaHabilTarget(fecha: string): boolean {
  const d = desdeIso(fecha);
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const mmdd = fecha.slice(5);
  if (['01-01', '05-01', '12-25', '12-26'].includes(mmdd)) return false;
  const p = pascua(d.getUTCFullYear());
  return fecha !== sumarDias(p, -2) && fecha !== sumarDias(p, 1);
}

/** Ultimo dia habil TARGET <= fecha. */
export function ultimoDiaHabilTarget(fecha: string): string {
  let f = fecha;
  for (let i = 0; i < 10 && !esDiaHabilTarget(f); i++) f = sumarDias(f, -1);
  return f;
}

/** Fecha y hora en Madrid: { fecha: 'AAAA-MM-DD', minutos: minutos desde las 00:00 }. */
export function ahoraEnMadrid(ahora: Date = new Date()): { fecha: string; minutos: number } {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(ahora);
  const v = (t: string) => partes.find((p) => p.type === t)?.value ?? '00';
  return { fecha: `${v('year')}-${v('month')}-${v('day')}`, minutos: Number(v('hour')) * 60 + Number(v('minute')) };
}

/** Hora (Madrid) a partir de la cual se da por publicado el tipo del dia: 16:30. */
export const MINUTOS_PUBLICACION_BCE = 16 * 60 + 30;

/**
 * Fecha de la observacion del BCE que corresponde a un devengo: el ultimo dia
 * habil TARGET <= devengo; si el devengo es hoy (o futuro) y en Madrid aun no
 * son las 16:30, el dia habil anterior a hoy.
 */
export function fechaObservacionEsperada(devengo: string, ahora: Date = new Date()): string {
  const madrid = ahoraEnMadrid(ahora);
  let tope = devengo;
  if (devengo >= madrid.fecha) {
    tope = madrid.minutos < MINUTOS_PUBLICACION_BCE ? sumarDias(madrid.fecha, -1) : madrid.fecha;
  }
  return ultimoDiaHabilTarget(tope);
}

// ---------------------------------------------------------------------------
// Importes de una factura en su moneda (con la convencion null = cuenta)
// ---------------------------------------------------------------------------

export interface CabeceraConDoc {
  moneda?: string | null;
  tipoCambio?: number | null;
  baseTotal: number;
  ivaTotal: number;
  retencionTotal: number;
  totalFactura: number;
  baseTotalDoc?: number | null;
  ivaTotalDoc?: number | null;
  retencionTotalDoc?: number | null;
  totalFacturaDoc?: number | null;
}

/**
 * Totales en la moneda del documento. Las *Doc a null significan "igual que la
 * columna de cuenta" (facturas anteriores a las divisas). Si la factura tiene un
 * tipo distinto de 1 y le falta alguna *Doc, es un dato corrupto: error interno
 * (mejor que pintar euros como si fueran dolares).
 */
export function importesDoc(f: CabeceraConDoc): {
  baseTotal: number;
  ivaTotal: number;
  retencionTotal: number;
  totalFactura: number;
} {
  const faltaDoc = [f.baseTotalDoc, f.ivaTotalDoc, f.retencionTotalDoc, f.totalFacturaDoc].some((v) => v === null || v === undefined);
  if (faltaDoc && Number(f.tipoCambio ?? 1) !== 1) {
    throw new Error('Factura en divisa sin importes en la moneda del documento.');
  }
  return {
    baseTotal: f.baseTotalDoc ?? f.baseTotal,
    ivaTotal: f.ivaTotalDoc ?? f.ivaTotal,
    retencionTotal: f.retencionTotalDoc ?? f.retencionTotal,
    totalFactura: f.totalFacturaDoc ?? f.totalFactura,
  };
}

/** Datos del tipo de cambio de una factura (para contabilizarla). */
export interface TipoDeFactura extends CabeceraConDoc {
  fuenteTipoCambio?: string | null;
  fechaTipoCambio?: string | null;
}

/**
 * Por que una factura NO se puede contabilizar todavia por su tipo de cambio
 * (null si se puede). Una factura en otra moneda que la de cuenta necesita el
 * tipo fijado (BCE, MANUAL o HEREDADO), mayor que cero, y sus importes en las
 * dos monedas: si no, sus columnas de cuenta no son de fiar.
 */
export function motivoSinTipoFijado(f: TipoDeFactura, monedaCuenta: string): string | null {
  const moneda = normalizarMoneda(f.moneda) || monedaCuenta;
  if (moneda === monedaCuenta) return null;
  const faltaDoc = [f.baseTotalDoc, f.ivaTotalDoc, f.retencionTotalDoc, f.totalFacturaDoc].some((v) => v === null || v === undefined);
  const fijada = (FUENTES_FIJADAS as readonly string[]).includes(String(f.fuenteTipoCambio ?? ''));
  if (!fijada || faltaDoc || !(Number(f.tipoCambio ?? 0) > 0)) return `Factura en ${moneda} sin tipo de cambio: no se contabiliza.`;
  return null;
}

const ddmmaaaa = (f: string): string => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}`;

/**
 * Nota de divisa para la descripcion del asiento de la factura:
 * " (1.319,99 USD; 1 EUR = 1,1490 USD, BCE 21/09/2026)". Vacia si la factura
 * va en la moneda de cuenta (el asiento de siempre no cambia).
 */
export function notaDivisa(f: TipoDeFactura, monedaCuenta: string): string {
  const moneda = normalizarMoneda(f.moneda) || monedaCuenta;
  if (moneda === monedaCuenta) return '';
  const tc = Number(f.tipoCambio ?? 0);
  if (!(tc > 0)) return '';
  const total = f.totalFacturaDoc ?? f.totalFactura;
  const fuente =
    f.fuenteTipoCambio === 'BCE'
      ? `BCE${f.fechaTipoCambio ? ` ${ddmmaaaa(f.fechaTipoCambio)}` : ''}`
      : f.fuenteTipoCambio === 'MANUAL'
        ? 'tipo indicado a mano'
        : f.fuenteTipoCambio === 'HEREDADO'
          ? 'tipo de la factura rectificada'
          : String(f.fuenteTipoCambio ?? '');
  return ` (${importeConMoneda(total, moneda)}; ${textoTipo(monedaCuenta, moneda, tc)}${fuente ? `, ${fuente}` : ''})`;
}

// ---------------------------------------------------------------------------
// Cobro (o pago) de una factura en divisa
// ---------------------------------------------------------------------------

export interface EntradaCobroDivisa {
  /** INGRESO: cobro de una venta (430). GASTO: pago de una compra (400). */
  tipo: 'INGRESO' | 'GASTO';
  moneda: string;
  monedaCuenta: string;
  /** Moneda de la cuenta de tesoreria (la caja, en moneda de cuenta). */
  monedaTesoreria: string;
  /** Total de la factura en moneda de cuenta y en la de la factura. */
  totalCuenta: number;
  totalDoc: number;
  /** Lo ya cobrado (cobros activos), en moneda de cuenta y en la de la factura. */
  cobradoCuenta: number;
  cobradoDoc: number;
  /** Lo que se cobra ahora, en la moneda de la factura. */
  importeDoc: number;
  /** Lo que ha llegado al banco, en moneda de cuenta (si se sabe). */
  importeRecibido?: number | null;
  /** Tipo del dia del cobro (manual o BCE), si no llega importeRecibido. */
  tipoCambio?: number | null;
  fuenteTipoCambio?: 'BCE' | 'MANUAL' | null;
  /** Comision del banco en moneda de cuenta (626). */
  comisionBancaria?: number | null;
}

export interface ApunteCobro {
  /** TESORERIA (572/570), TERCERO (430/400), COMISION (626), DIF_POSITIVA (768), DIF_NEGATIVA (668). */
  cuenta: 'TESORERIA' | 'TERCERO' | 'COMISION' | 'DIF_POSITIVA' | 'DIF_NEGATIVA';
  debe: number;
  haber: number;
}

export interface ResultadoCobroDivisa {
  /** Moneda de cuenta aplicada a la 430/400 al tipo de la factura. */
  importe: number;
  importeDoc: number;
  /** Moneda de cuenta que entra o sale de tesoreria. */
  importeTesoreria: number;
  tipoCambio: number;
  fuenteTipoCambio: 'PAR' | 'BCE' | 'MANUAL' | 'BANCO';
  /** > 0 a la 768 (cobro) / 668 (pago); ver apuntes. */
  diferenciaCambio: number;
  comisionBancaria: number;
  /** true si con este cobro la factura queda saldada. */
  esUltimo: boolean;
  pendienteDocTras: number;
  apuntes: ApunteCobro[];
}

const fmt2 = (n: number): string =>
  n
    .toFixed(2)
    .replace('.', ',')
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** Importe con su moneda para los mensajes: '1.000,00 €' o '1.000,00 USD'. */
export function importeConMoneda(n: number, moneda: string): string {
  return `${fmt2(n)} ${moneda === 'EUR' ? '€' : moneda}`;
}

/**
 * Calcula un cobro (o pago) en divisa: lo que se aplica al tercero al tipo de
 * la factura, lo que entra en tesoreria al tipo del dia (o lo que dice el
 * banco), la diferencia de cambio (768/668) y la comision (626).
 *
 * En la misma moneda que la de cuenta salen los dos apuntes de siempre y no se
 * admiten tipo ni comision.
 */
export function calcularCobroDivisa(e: EntradaCobroDivisa): ResultadoCobroDivisa {
  const mismaMoneda = e.moneda === e.monedaCuenta;
  const importeDoc = redondear2(e.importeDoc);
  if (!(aCentimos(importeDoc) > 0)) throw badRequest('El importe tiene que ser mayor que cero.');
  const pendienteDoc = redondear2(e.totalDoc - e.cobradoDoc);
  const pendienteCuenta = redondear2(e.totalCuenta - e.cobradoCuenta);
  if (aCentimos(importeDoc) > aCentimos(pendienteDoc)) {
    throw badRequest(
      `El importe (${importeConMoneda(importeDoc, e.moneda)}) supera lo pendiente (${importeConMoneda(pendienteDoc, e.moneda)}).`,
    );
  }
  const esUltimo = aCentimos(importeDoc) === aCentimos(pendienteDoc);
  const comision = redondear2(e.comisionBancaria ?? 0);
  const tercero: ApunteCobro['cuenta'] = 'TERCERO';

  if (mismaMoneda) {
    if (comision !== 0 || e.importeRecibido != null || e.tipoCambio != null) {
      throw badRequest('El tipo de cambio, lo recibido en el banco y la comisión solo se indican en cobros en divisa.');
    }
    const apuntes: ApunteCobro[] =
      e.tipo === 'INGRESO'
        ? [
            { cuenta: 'TESORERIA', debe: importeDoc, haber: 0 },
            { cuenta: tercero, debe: 0, haber: importeDoc },
          ]
        : [
            { cuenta: tercero, debe: importeDoc, haber: 0 },
            { cuenta: 'TESORERIA', debe: 0, haber: importeDoc },
          ];
    return {
      importe: importeDoc,
      importeDoc,
      importeTesoreria: importeDoc,
      tipoCambio: 1,
      fuenteTipoCambio: 'PAR',
      diferenciaCambio: 0,
      comisionBancaria: 0,
      esUltimo,
      pendienteDocTras: redondear2(pendienteDoc - importeDoc),
      apuntes,
    };
  }

  if (comision < 0) throw badRequest('La comisión bancaria no puede ser negativa.');
  // Lo que se aplica al tercero, al tipo de la factura (el ultimo cobro salda el resto exacto).
  const importe = esUltimo ? pendienteCuenta : redondear2((importeDoc * e.totalCuenta) / e.totalDoc);

  let importeTesoreria: number;
  let tipoCambio: number;
  let fuente: ResultadoCobroDivisa['fuenteTipoCambio'];
  if (e.monedaTesoreria === e.monedaCuenta) {
    if (e.importeRecibido != null) {
      importeTesoreria = redondear2(e.importeRecibido);
      if (!(importeTesoreria > 0)) throw badRequest('Lo recibido en el banco tiene que ser mayor que cero.');
      // Cobro: el banco abona lo recibido ya descontada la comision. Pago: lo cargado por la factura.
      tipoCambio = redondear8(importeDoc / (e.tipo === 'INGRESO' ? importeTesoreria + comision : importeTesoreria));
      fuente = 'BANCO';
    } else {
      if (!(e.tipoCambio && e.tipoCambio > 0)) {
        throw badRequest(`Indica el tipo de cambio del día del cobro o lo recibido en el banco en ${e.monedaCuenta}.`);
      }
      tipoCambio = e.tipoCambio;
      // Cobro: el banco abona lo cobrado al tipo del dia menos su comision (la
      // diferencia de cambio no la absorbe). Pago: sale lo pagado y, aparte, la comision.
      importeTesoreria = e.tipo === 'INGRESO' ? redondear2(aCuenta(importeDoc, tipoCambio) - comision) : aCuenta(importeDoc, tipoCambio);
      if (!(importeTesoreria > 0)) throw badRequest('La comisión no puede ser mayor que lo cobrado.');
      fuente = e.fuenteTipoCambio ?? 'MANUAL';
    }
  } else if (e.monedaTesoreria === e.moneda) {
    if (e.importeRecibido != null) {
      throw badRequest(`La cuenta está en ${e.moneda}: indica el tipo de cambio del día, no lo recibido en ${e.monedaCuenta}.`);
    }
    if (!(e.tipoCambio && e.tipoCambio > 0)) throw badRequest('Indica el tipo de cambio del día del cobro.');
    tipoCambio = e.tipoCambio;
    // Igual que en una cuenta en moneda de cuenta: la comision la descuenta el
    // banco (cobro) o sale aparte (pago); la diferencia de cambio no la absorbe.
    importeTesoreria = e.tipo === 'INGRESO' ? redondear2(aCuenta(importeDoc, tipoCambio) - comision) : aCuenta(importeDoc, tipoCambio);
    if (!(importeTesoreria > 0)) throw badRequest('La comisión no puede ser mayor que lo cobrado.');
    fuente = e.fuenteTipoCambio ?? 'MANUAL';
  } else {
    throw badRequest(`Cobrar una factura en ${e.moneda} en una cuenta en ${e.monedaTesoreria} no está admitido todavía.`);
  }

  const apuntes: ApunteCobro[] = [];
  let diferenciaCambio: number;
  if (e.tipo === 'INGRESO') {
    // Entra en el banco lo recibido; la comision es gasto; la 430 se salda al tipo de la factura.
    diferenciaCambio = redondear2(importeTesoreria + comision - importe);
    apuntes.push({ cuenta: 'TESORERIA', debe: importeTesoreria, haber: 0 });
    if (comision > 0) apuntes.push({ cuenta: 'COMISION', debe: comision, haber: 0 });
    apuntes.push({ cuenta: tercero, debe: 0, haber: importe });
    if (diferenciaCambio > 0) apuntes.push({ cuenta: 'DIF_POSITIVA', debe: 0, haber: diferenciaCambio });
    if (diferenciaCambio < 0) apuntes.push({ cuenta: 'DIF_NEGATIVA', debe: -diferenciaCambio, haber: 0 });
  } else {
    // Pago: se salda la 400 al tipo de la factura y sale del banco lo pagado (+ comision).
    // dif = pagado - tercero: > 0 es perdida (668), < 0 ganancia (768).
    diferenciaCambio = redondear2(importeTesoreria - importe);
    apuntes.push({ cuenta: tercero, debe: importe, haber: 0 });
    if (comision > 0) apuntes.push({ cuenta: 'COMISION', debe: comision, haber: 0 });
    if (diferenciaCambio > 0) apuntes.push({ cuenta: 'DIF_NEGATIVA', debe: diferenciaCambio, haber: 0 });
    apuntes.push({ cuenta: 'TESORERIA', debe: 0, haber: redondear2(importeTesoreria + comision) });
    if (diferenciaCambio < 0) apuntes.push({ cuenta: 'DIF_POSITIVA', debe: 0, haber: -diferenciaCambio });
  }

  return {
    importe,
    importeDoc,
    importeTesoreria,
    tipoCambio,
    fuenteTipoCambio: fuente,
    diferenciaCambio,
    comisionBancaria: comision,
    esUltimo,
    pendienteDocTras: redondear2(pendienteDoc - importeDoc),
    apuntes,
  };
}
