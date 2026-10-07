/**
 * Tipo de operacion de IVA de una factura de venta: la UNICA tabla de reglas
 * (cuota, IVA y retencion permitidos, casilla del 303, clave del 349,
 * Verifactu y mencion del PDF en espanol e ingles). Puro: sin BD.
 *
 *  - Un tipo por factura: si una venta mezcla operaciones, se hacen dos facturas.
 *  - Empresa no espanola: EMPRESA_EXTRANJERA (interno, lo fija el backend), sin
 *    IVA ni IRPF, sin libro de IVA ni modelos de la AEAT.
 *  - Facturas anteriores a esta funcion (tipoOperacion null): se clasifican con
 *    `tipoOperacionLegacy`, que reproduce EXACTAMENTE la clasificacion de
 *    siempre, para que sus cifras en 303/347/349/390 no cambien.
 */
import { esPaisEspana } from './perfil-empresa.model';

export const TIPOS_OPERACION_VENTA = [
  'NACIONAL',
  'INTRACOMUNITARIA',
  'EXPORTACION',
  'SERVICIOS_EXTRANJERO',
  'EXENTA',
  'ISP_NACIONAL',
  'EMPRESA_EXTRANJERA',
] as const;
export type TipoOperacionVenta = (typeof TIPOS_OPERACION_VENTA)[number];

/** Los que puede elegir una empresa espanola (EMPRESA_EXTRANJERA es interno). */
export const TIPOS_SELECCIONABLES: readonly TipoOperacionVenta[] = TIPOS_OPERACION_VENTA.filter(
  (t) => t !== 'EMPRESA_EXTRANJERA',
);

export function esTipoOperacion(valor: unknown): valor is TipoOperacionVenta {
  return typeof valor === 'string' && (TIPOS_OPERACION_VENTA as readonly string[]).includes(valor);
}

/** Causas de exencion que se guardan en la factura (solo con EXENTA). */
export const CAUSAS_EXENCION = ['E1', 'E3', 'E4', 'E6'] as const;
export type CausaExencion = (typeof CAUSAS_EXENCION)[number];
/** En el libro de IVA tambien E2 (exportacion) y E5 (intracomunitaria), derivadas del tipo. */
export type CausaExencionLibro = CausaExencion | 'E2' | 'E5';

export interface SupuestoExencion {
  codigo: string;
  causa: CausaExencion;
  etiqueta: string;
  /** Texto que va en la mencion del PDF; null = lo escribe el usuario. */
  referenciaLegal: string | null;
}

/** Desplegable secundario de EXENTA (referencia legal ya redactada). */
export const SUPUESTOS_EXENCION: readonly SupuestoExencion[] = [
  { codigo: 'ART20_3', causa: 'E1', etiqueta: 'Asistencia sanitaria (art. 20.Uno.3.º)', referenciaLegal: 'art. 20.Uno.3.º Ley 37/1992' },
  { codigo: 'ART20_9', causa: 'E1', etiqueta: 'Educación y enseñanza (art. 20.Uno.9.º)', referenciaLegal: 'art. 20.Uno.9.º Ley 37/1992' },
  { codigo: 'ART20_10', causa: 'E1', etiqueta: 'Clases particulares (art. 20.Uno.10.º)', referenciaLegal: 'art. 20.Uno.10.º Ley 37/1992' },
  { codigo: 'ART20_16', causa: 'E1', etiqueta: 'Seguros (art. 20.Uno.16.º)', referenciaLegal: 'art. 20.Uno.16.º Ley 37/1992' },
  { codigo: 'ART20_18', causa: 'E1', etiqueta: 'Operaciones financieras (art. 20.Uno.18.º)', referenciaLegal: 'art. 20.Uno.18.º Ley 37/1992' },
  {
    codigo: 'ART20_22',
    causa: 'E1',
    etiqueta: 'Segundas entregas de edificaciones (art. 20.Uno.22.º)',
    referenciaLegal: 'art. 20.Uno.22.º Ley 37/1992',
  },
  { codigo: 'ART20_23', causa: 'E1', etiqueta: 'Alquiler de vivienda (art. 20.Uno.23.º)', referenciaLegal: 'art. 20.Uno.23.º Ley 37/1992' },
  { codigo: 'ART20_26', causa: 'E1', etiqueta: 'Artistas y autores (art. 20.Uno.26.º)', referenciaLegal: 'art. 20.Uno.26.º Ley 37/1992' },
  { codigo: 'ART22', causa: 'E3', etiqueta: 'Operaciones asimiladas a las exportaciones (art. 22)', referenciaLegal: 'art. 22 Ley 37/1992' },
  { codigo: 'ART23_24', causa: 'E4', etiqueta: 'Zonas francas, depósitos y regímenes aduaneros (arts. 23 y 24)', referenciaLegal: 'arts. 23 y 24 Ley 37/1992' },
  { codigo: 'OTRO', causa: 'E6', etiqueta: 'Otro supuesto (indica el precepto)', referenciaLegal: null },
];

/**
 * Supuestos de inversion del sujeto pasivo en ventas de una empresa espanola
 * (letra del art. 84.Uno.2.º LIVA, opcional). Solo las letras comprobadas; para
 * otra, texto libre.
 */
export const SUPUESTOS_ISP: ReadonlyArray<{ codigo: string; etiqueta: string; referenciaLegal: string | null }> = [
  { codigo: 'ISP_B', etiqueta: 'Oro sin elaborar o semielaborado (letra b)', referenciaLegal: 'b)' },
  { codigo: 'ISP_C', etiqueta: 'Desechos, chatarra y materiales de recuperación (letra c)', referenciaLegal: 'c)' },
  { codigo: 'ISP_D', etiqueta: 'Derechos de emisión de gases de efecto invernadero (letra d)', referenciaLegal: 'd)' },
  { codigo: 'ISP_E', etiqueta: 'Inmuebles con renuncia a la exención o en ejecución de garantía (letra e)', referenciaLegal: 'e)' },
  { codigo: 'ISP_F', etiqueta: 'Ejecuciones de obra de urbanización, construcción o rehabilitación (letra f)', referenciaLegal: 'f)' },
  { codigo: 'OTRO', etiqueta: 'Otro supuesto (indica la letra)', referenciaLegal: null },
];

export const MAX_REFERENCIA_LEGAL = 200;

// ---------------------------------------------------------------------------
// Paises y NIF-IVA
// ---------------------------------------------------------------------------

/** Estados de la UE: ISO-3 -> ISO-2 (incluida Espana). */
const UE_ISO3_A_ISO2: Readonly<Record<string, string>> = {
  AUT: 'AT', BEL: 'BE', BGR: 'BG', CYP: 'CY', CZE: 'CZ', DEU: 'DE', DNK: 'DK', EST: 'EE', ESP: 'ES',
  FIN: 'FI', FRA: 'FR', GRC: 'GR', HRV: 'HR', HUN: 'HU', IRL: 'IE', ITA: 'IT', LTU: 'LT', LUX: 'LU',
  LVA: 'LV', MLT: 'MT', NLD: 'NL', POL: 'PL', PRT: 'PT', ROU: 'RO', SWE: 'SE', SVN: 'SI', SVK: 'SK',
};

/** Otros codigos ISO-3 frecuentes (FacturaScripts usa ISO-3 en codpais). */
const OTROS_ISO3_A_ISO2: Readonly<Record<string, string>> = {
  USA: 'US', GBR: 'GB', HKG: 'HK', CHN: 'CN', CHE: 'CH', MAR: 'MA', MEX: 'MX', CAN: 'CA', AUS: 'AU',
  NOR: 'NO', AND: 'AD', JPN: 'JP', BRA: 'BR', ARG: 'AR', COL: 'CO', CHL: 'CL', PER: 'PE', TUR: 'TR',
  IND: 'IN', SGP: 'SG', ARE: 'AE', ISL: 'IS', LIE: 'LI', MCO: 'MC', GIB: 'GI', DZA: 'DZ', TUN: 'TN',
  URY: 'UY', VEN: 'VE', ECU: 'EC', DOM: 'DO', RUS: 'RU', UKR: 'UA', ISR: 'IL', KOR: 'KR', ZAF: 'ZA',
};

/** Estados miembros de la UE en ISO-2 (Espana incluida). */
export const PAISES_UE: ReadonlySet<string> = new Set(Object.values(UE_ISO3_A_ISO2));

/** Prefijo del NIF-IVA (VIES) -> pais ISO-2. EL = Grecia; XI = Irlanda del Norte (solo bienes). */
export const PREFIJOS_NIF_UE: Readonly<Record<string, string>> = {
  AT: 'AT', BE: 'BE', BG: 'BG', CY: 'CY', CZ: 'CZ', DE: 'DE', DK: 'DK', EE: 'EE', EL: 'GR', ES: 'ES',
  FI: 'FI', FR: 'FR', HR: 'HR', HU: 'HU', IE: 'IE', IT: 'IT', LT: 'LT', LU: 'LU', LV: 'LV', MT: 'MT',
  NL: 'NL', PL: 'PL', PT: 'PT', RO: 'RO', SE: 'SE', SI: 'SI', SK: 'SK', XI: 'GB',
};

/** 'fra' -> 'FR', 'EL' -> 'GR', 'UK' -> 'GB', ' es ' -> 'ES'. Vacio -> ''. */
export function normalizarPais(pais: string | null | undefined): string {
  const p = String(pais ?? '').trim().toUpperCase();
  if (p === 'EL') return 'GR';
  if (p === 'UK') return 'GB';
  if (p.length === 3) return UE_ISO3_A_ISO2[p] ?? OTROS_ISO3_A_ISO2[p] ?? p;
  return p;
}

/** Estado miembro de la UE (Espana incluida). Admite ISO-2, ISO-3 y EL. */
export function esPaisUe(pais: string | null | undefined): boolean {
  return PAISES_UE.has(normalizarPais(pais));
}

/** NIF sin espacios, guiones ni puntos, en mayusculas. */
export function limpiarNif(nif: string | null | undefined): string {
  return String(nif ?? '')
    .toUpperCase()
    .replace(/[\s.\-]/g, '');
}

/** Prefijo de Estado de un NIF-IVA ('FR12345678901' -> { prefijo: 'FR', pais: 'FR' }) o null. */
export function prefijoNifIvaUe(nif: string | null | undefined): { prefijo: string; pais: string } | null {
  const n = limpiarNif(nif);
  const m = /^([A-Z]{2})[0-9A-Z+*]{2,12}$/.exec(n);
  if (!m || !/\d/.test(n.slice(2))) return null;
  const pais = PREFIJOS_NIF_UE[m[1]];
  return pais ? { prefijo: m[1], pais } : null;
}

/**
 * Formato de NIF-IVA comunitario: prefijo del Estado (EL para Grecia) y de 2 a
 * 12 caracteres. Si se indica el pais, el prefijo tiene que ser el suyo. No
 * consulta VIES.
 */
export function validarFormatoNifIvaUe(nif: string | null | undefined, pais?: string | null): boolean {
  const pref = prefijoNifIvaUe(nif);
  if (!pref || pref.prefijo === 'XI' || pref.prefijo === 'ES') return false;
  if (!pais) return true;
  return pref.pais === normalizarPais(pais);
}

export interface ClienteFiscal {
  pais?: string | null;
  nifCif?: string | null;
  cp?: string | null;
}

/**
 * Pais del cliente en ISO-2. Si viene vacio o 'ES' y el NIF lleva prefijo de
 * otro Estado de la UE, el del prefijo (el pais por defecto de la ficha es ES);
 * con el prefijo XI (Irlanda del Norte), GB.
 */
export function paisDelCliente(c: ClienteFiscal): string {
  const pais = normalizarPais(c.pais);
  if (pais === '' || pais === 'ES') {
    const pref = prefijoNifIvaUe(c.nifCif);
    if (pref && pref.prefijo !== 'ES') return pref.pais;
    return 'ES';
  }
  return pais;
}

/** Cliente de otro Estado de la UE (no Espana). */
export function esClienteUe(c: ClienteFiscal): boolean {
  const p = paisDelCliente(c);
  return p !== 'ES' && PAISES_UE.has(p);
}

/** Cliente de otro Estado de la UE con NIF-IVA con el prefijo de su Estado. */
export function tieneNifIvaUe(c: ClienteFiscal): boolean {
  return esClienteUe(c) && validarFormatoNifIvaUe(c.nifCif, paisDelCliente(c));
}

/**
 * Empresario de Irlanda del Norte con NIF-IVA XI. Solo en las entregas de
 * BIENES se trata como un cliente de la UE (Protocolo de Irlanda/Irlanda del
 * Norte): entrega intracomunitaria exenta, casilla [59] y clave E del 349. En
 * los servicios es un cliente de pais tercero (Reino Unido).
 */
export function tieneNifIvaXi(c: ClienteFiscal): boolean {
  const pref = prefijoNifIvaUe(c.nifCif);
  return !!pref && pref.prefijo === 'XI' && paisDelCliente(c) === 'GB';
}

/** Espana fuera del territorio de aplicacion del IVA: Canarias (35, 38), Ceuta (51) y Melilla (52). */
export function fueraDelTai(pais: string | null | undefined, cp: string | null | undefined): boolean {
  if (normalizarPais(pais || 'ES') !== 'ES') return false;
  return /^(35|38|51|52)\d{3}$/.test(String(cp ?? '').trim());
}

// ---------------------------------------------------------------------------
// Clasificacion de las facturas anteriores (tipoOperacion null)
// ---------------------------------------------------------------------------

// Las tablas de siempre (las de impuestosCalculo.clasificarOperacion antes de
// que entendiera ISO-2): paises UE en ISO-3 sin ESP y prefijos de NIF-IVA. Se
// copian tal cual a proposito: es la clasificacion congelada de las ventas sin tipo.
const LEGACY_UE_ISO3 = new Set([
  'DEU', 'FRA', 'ITA', 'PRT', 'BEL', 'NLD', 'LUX', 'IRL', 'AUT', 'FIN', 'SWE', 'DNK', 'GRC',
  'POL', 'CZE', 'SVK', 'SVN', 'HUN', 'ROU', 'BGR', 'HRV', 'EST', 'LVA', 'LTU', 'CYP', 'MLT',
]);
const LEGACY_PREFIJOS = new Set([
  'DE', 'FR', 'IT', 'PT', 'BE', 'NL', 'LU', 'IE', 'AT', 'FI', 'SE', 'DK', 'EL', 'PL', 'CZ',
  'SK', 'SI', 'HU', 'RO', 'BG', 'HR', 'EE', 'LV', 'LT', 'CY', 'MT', 'XI',
]);

/**
 * Tipo de una factura anterior a esta funcion: EXACTAMENTE la clasificacion de
 * siempre (la clasificarOperacion anterior: interior / intracomunitaria /
 * exportacion por el pais de la ficha o, sin pais, por el prefijo del NIF;
 * hoy clasificarOperacion ya entiende ISO-2 y solo se usa con compras), para que las
 * cifras ya declaradas no cambien. Ojo: la tabla de siempre esta en ISO-3, asi
 * que un pais guardado en ISO-2 distinto de ES ('FR') sale como exportacion;
 * se mantiene a proposito y se corrige solo en las facturas nuevas.
 */
export function tipoOperacionLegacy(pais: string | null | undefined, nif: string | null | undefined): TipoOperacionVenta {
  const p = String(pais ?? '').trim().toUpperCase();
  if (p === 'ESP' || p === 'ES') return 'NACIONAL';
  if (p) return LEGACY_UE_ISO3.has(p) ? 'INTRACOMUNITARIA' : 'EXPORTACION';
  const pref = String(nif ?? '').trim().slice(0, 2).toUpperCase();
  return LEGACY_PREFIJOS.has(pref) ? 'INTRACOMUNITARIA' : 'NACIONAL';
}

/**
 * Tipo con el que se trata una factura: el guardado o, si no tiene, el de
 * siempre con el pais del cliente congelado en la factura (`paisClienteLegacy`)
 * o, si aun no se ha congelado, el de su ficha.
 */
export function operacionEfectiva(
  factura: { tipoOperacion?: string | null; paisClienteLegacy?: string | null },
  cliente: ClienteFiscal,
): TipoOperacionVenta {
  if (esTipoOperacion(factura.tipoOperacion)) return factura.tipoOperacion;
  return tipoOperacionLegacy(paisLegacy(factura, cliente), cliente.nifCif);
}

/**
 * Fecha de devengo del IVA de una venta (art. 75 LIVA): decide el periodo de
 * los modelos (303, 349, 390, 347) y el del libro de IVA.
 *  - En general, la de la operacion si se indica (fechaOperacion); si no, la
 *    de emision.
 *  - Entrega intracomunitaria de bienes (art. 75.Uno.8.º): la de emision de la
 *    factura o, si es posterior, el dia 15 del mes siguiente al de la operacion.
 * Las facturas anteriores no tienen fecha de operacion: la de emision, como siempre.
 */
export function fechaDevengoVenta(f: { tipoOperacion?: string | null; fechaOperacion?: string | null; fechaEmision: string }): string {
  if (!f.fechaOperacion) return f.fechaEmision;
  if (f.tipoOperacion === 'INTRACOMUNITARIA') {
    const [anio, mes] = f.fechaOperacion.split('-').map(Number);
    const dia15 = mes === 12 ? `${anio + 1}-01-15` : `${anio}-${String(mes + 1).padStart(2, '0')}-15`;
    return f.fechaEmision < dia15 ? f.fechaEmision : dia15;
  }
  return f.fechaOperacion;
}

/** Pais con el que se clasifica una factura sin tipo: el congelado en ella o, si no, el de la ficha del cliente. */
export function paisLegacy(factura: { paisClienteLegacy?: string | null }, cliente: { pais?: string | null }): string | null {
  return factura.paisClienteLegacy ?? cliente.pais ?? null;
}

// ---------------------------------------------------------------------------
// Tabla de reglas
// ---------------------------------------------------------------------------

export interface ContextoOperacion {
  cliente: ClienteFiscal;
  causaExencion?: string | null;
  referenciaLegal?: string | null;
  /** Tipo de IVA (para la casilla del 303 en NACIONAL). */
  tipoIva?: number;
}

export interface Mencion {
  es: string;
  en: string;
}

export interface VerifactuOperacion {
  /** S1 sujeta no exenta, S2 sujeta con inversion del sujeto pasivo, N2 no sujeta por localizacion. */
  calificacion: 'S1' | 'S2' | 'N2' | null;
  operacionExenta: CausaExencionLibro | null;
  /** 01 regimen general, 02 exportacion. */
  claveRegimen: '01' | '02';
  impuesto: '01';
  /** S2: TipoImpositivo 0 y CuotaRepercutida 0. */
  tipoYCuotaCero: boolean;
}

export interface ReglaOperacion {
  etiqueta: Mencion;
  etiquetaCorta: Mencion;
  /** true: las lineas llevan IVA (4/5/10/21); false: todas al 0 %. */
  llevaCuota: boolean;
  /** Admite retencion de IRPF. */
  admiteRetencion: boolean;
  /** Tipos de factura de Verifactu que no se admiten (simplificadas). */
  tiposFacturaProhibidos: readonly string[];
  enLibroIva: boolean;
  enModelos: boolean;
  /** Casilla de BASE del 303 (pagina 1 o informacion adicional); null = ninguna. */
  casilla303(ctx: ContextoOperacion): string | null;
  /** Clave del 349 ('E' entregas, 'S' servicios); null = no va en el 349. */
  clave349(ctx: ContextoOperacion): 'E' | 'S' | null;
  /** Causa de exencion para el libro de IVA. */
  causaLibro(ctx: ContextoOperacion): CausaExencionLibro | null;
  verifactu(ctx: ContextoOperacion): VerifactuOperacion | null;
  /** Mencion obligatoria del PDF; null = ninguna. */
  mencion(ctx: ContextoOperacion): Mencion | null;
}

const SIMPLIFICADAS = ['F2', 'R5'] as const;
const CASILLA_303_POR_TIPO: Readonly<Record<number, string>> = { 4: '01', 10: '04', 21: '07' };

const vf = (
  calificacion: VerifactuOperacion['calificacion'],
  operacionExenta: VerifactuOperacion['operacionExenta'],
  claveRegimen: VerifactuOperacion['claveRegimen'] = '01',
  tipoYCuotaCero = false,
): VerifactuOperacion => ({ calificacion, operacionExenta, claveRegimen, impuesto: '01', tipoYCuotaCero });

const causaValida = (c: string | null | undefined): CausaExencion | null =>
  (CAUSAS_EXENCION as readonly string[]).includes(String(c)) ? (c as CausaExencion) : null;

const ref = (ctx: ContextoOperacion): string => String(ctx.referenciaLegal ?? '').trim();

export const REGLA_OPERACION: Readonly<Record<TipoOperacionVenta, ReglaOperacion>> = {
  NACIONAL: {
    etiqueta: { es: 'Nacional (con IVA)', en: 'Domestic (VAT charged)' },
    etiquetaCorta: { es: 'Nacional', en: 'Domestic' },
    llevaCuota: true,
    admiteRetencion: true,
    tiposFacturaProhibidos: [],
    enLibroIva: true,
    enModelos: true,
    // [01]-[09] por tipo; el 5 % no tiene fila (fallo ya existente, avisado en el 303).
    casilla303: (ctx) => (ctx.tipoIva !== undefined ? (CASILLA_303_POR_TIPO[ctx.tipoIva] ?? null) : '01-09'),
    clave349: () => null,
    causaLibro: () => null,
    verifactu: () => vf('S1', null),
    mencion: () => null,
  },
  INTRACOMUNITARIA: {
    etiqueta: { es: 'Entrega intracomunitaria exenta (art. 25 LIVA)', en: 'Intra-Community supply of goods (VAT exempt)' },
    etiquetaCorta: { es: 'Intracom.', en: 'Intra-EU' },
    llevaCuota: false,
    admiteRetencion: false,
    tiposFacturaProhibidos: SIMPLIFICADAS,
    enLibroIva: true,
    enModelos: true,
    casilla303: () => '59',
    clave349: () => 'E',
    causaLibro: () => 'E5',
    verifactu: () => vf(null, 'E5'),
    mencion: () => ({
      es: 'Entrega intracomunitaria exenta de IVA (art. 25.Uno Ley 37/1992; art. 138 Directiva 2006/112/CE)',
      en: 'VAT-exempt intra-Community supply of goods (Art. 138 Council Directive 2006/112/EC)',
    }),
  },
  EXPORTACION: {
    etiqueta: { es: 'Exportación / país tercero exenta (art. 21 LIVA)', en: 'Export of goods (VAT exempt)' },
    etiquetaCorta: { es: 'Export.', en: 'Export' },
    llevaCuota: false,
    admiteRetencion: false,
    tiposFacturaProhibidos: SIMPLIFICADAS,
    enLibroIva: true,
    enModelos: true,
    casilla303: () => '60',
    clave349: () => null,
    causaLibro: () => 'E2',
    verifactu: () => vf(null, 'E2', '02'),
    mencion: () => ({
      es: 'Exportación exenta de IVA (art. 21 Ley 37/1992; art. 146 Directiva 2006/112/CE)',
      en: 'VAT-exempt export of goods (Art. 146 Council Directive 2006/112/EC)',
    }),
  },
  SERVICIOS_EXTRANJERO: {
    etiqueta: {
      es: 'Servicios a cliente extranjero, no sujeta (arts. 69-70 LIVA)',
      en: 'Services to a foreign customer (outside the scope of Spanish VAT)',
    },
    etiquetaCorta: { es: 'No sujeta', en: 'Out of scope' },
    llevaCuota: false,
    admiteRetencion: false,
    tiposFacturaProhibidos: SIMPLIFICADAS,
    enLibroIva: true,
    enModelos: true,
    casilla303: (ctx) => (tieneNifIvaUe(ctx.cliente) ? '59' : '120'),
    clave349: (ctx) => (tieneNifIvaUe(ctx.cliente) ? 'S' : null),
    causaLibro: () => null,
    verifactu: () => vf('N2', null),
    mencion: (ctx) =>
      tieneNifIvaUe(ctx.cliente)
        ? {
            es: 'Inversión del sujeto pasivo. Operación no sujeta al IVA español (art. 69.Uno.1.º Ley 37/1992); IVA a liquidar por el destinatario (art. 196 Directiva 2006/112/CE)',
            en: 'Reverse charge – VAT to be accounted for by the recipient (Art. 196 Council Directive 2006/112/EC)',
          }
        : {
            es: 'Operación no sujeta al IVA español por reglas de localización (art. 69.Uno.1.º Ley 37/1992)',
            en: 'Outside the scope of Spanish VAT – place of supply outside Spain',
          },
  },
  EXENTA: {
    etiqueta: { es: 'Exenta por otros motivos (art. 20 LIVA y otros)', en: 'VAT-exempt supply' },
    etiquetaCorta: { es: 'Exenta', en: 'Exempt' },
    llevaCuota: false,
    admiteRetencion: true,
    tiposFacturaProhibidos: [],
    enLibroIva: true,
    enModelos: true,
    // E3/E4 en [60]; E1/E6 sin casilla trimestral (390 y prorrata).
    casilla303: (ctx) => (['E3', 'E4'].includes(String(ctx.causaExencion)) ? '60' : null),
    clave349: () => null,
    causaLibro: (ctx) => causaValida(ctx.causaExencion) ?? 'E6',
    verifactu: (ctx) => vf(null, causaValida(ctx.causaExencion) ?? 'E6'),
    mencion: (ctx) => ({
      es: `Operación exenta de IVA – ${ref(ctx) || 'indica el precepto'}`,
      en: `VAT-exempt supply – ${ref(ctx) || 'legal basis'}`,
    }),
  },
  ISP_NACIONAL: {
    etiqueta: { es: 'Inversión del sujeto pasivo (art. 84.Uno.2.º LIVA)', en: 'Domestic reverse charge' },
    etiquetaCorta: { es: 'ISP', en: 'Reverse charge' },
    llevaCuota: false,
    admiteRetencion: true,
    tiposFacturaProhibidos: SIMPLIFICADAS,
    enLibroIva: true,
    enModelos: true,
    casilla303: () => '122',
    clave349: () => null,
    causaLibro: () => null,
    verifactu: () => vf('S2', null, '01', true),
    mencion: (ctx) => ({
      es: `Inversión del sujeto pasivo (art. 84.Uno.2.º${ref(ctx) ? ` ${ref(ctx)}` : ''} Ley 37/1992)`,
      en: 'Reverse charge',
    }),
  },
  EMPRESA_EXTRANJERA: {
    etiqueta: { es: 'Empresa no establecida en España (sin IVA)', en: 'No VAT' },
    etiquetaCorta: { es: 'Sin IVA', en: 'No VAT' },
    llevaCuota: false,
    admiteRetencion: false,
    tiposFacturaProhibidos: [],
    enLibroIva: false,
    enModelos: false,
    casilla303: () => null,
    clave349: () => null,
    causaLibro: () => null,
    // RD 1007/2023 art. 3: Verifactu no aplica a quien no esta establecido en Espana.
    verifactu: () => null,
    mencion: () => null,
  },
};

/** Tipos que exigen cliente no residente (ni IRPF). */
const TIPOS_NO_RESIDENTE: readonly TipoOperacionVenta[] = ['INTRACOMUNITARIA', 'EXPORTACION', 'SERVICIOS_EXTRANJERO'];

/** Destinatario para Verifactu: NIF espanol, o IDOtro con su tipo de documento. */
export function destinatarioVerifactu(
  c: ClienteFiscal,
): { nif: string } | { idOtro: { codigoPais: string; idType: '02' | '04'; id: string } } {
  const pais = paisDelCliente(c);
  const nif = limpiarNif(c.nifCif);
  if (pais === 'ES') return { nif };
  // 02 = NIF-IVA (cliente UE con NIF-IVA, o XI de Irlanda del Norte); 04 = documento oficial del pais de residencia.
  return { idOtro: { codigoPais: pais, idType: tieneNifIvaUe(c) || tieneNifIvaXi(c) ? '02' : '04', id: nif } };
}

/** Desglose de Verifactu de la factura (null si no aplica). */
export function desgloseVerifactu(tipo: TipoOperacionVenta, ctx: ContextoOperacion): VerifactuOperacion | null {
  return REGLA_OPERACION[tipo].verifactu(ctx);
}

/**
 * Importe en euros para los modelos y el libro de IVA. Las columnas de cuenta
 * de una empresa espanola ya estan en euros (ver domain/divisas.ts), asi que
 * hoy devuelve el importe tal cual: es el punto unico por si eso cambia.
 */
export function importeEnEuros(_factura: { moneda?: string | null }, importe: number): number {
  return importe;
}

// ---------------------------------------------------------------------------
// Inferencia, sugerencia y revision
// ---------------------------------------------------------------------------

export type TipoProducto = 'PRODUCTO' | 'SERVICIO';

/**
 * Tipo de una factura NUEVA que llega sin tipo (API antigua, scripts...):
 * todas las lineas con IVA -> NACIONAL; alguna con IVA y otras al 0 % (p. ej.
 * suplidos) con cliente espanol -> NACIONAL, como siempre; todas al 0 % con
 * cliente UE con NIF-IVA (o XI) -> INTRACOMUNITARIA; todas al 0 % con cliente
 * de fuera de la UE -> EXPORTACION. Cualquier otro caso, null (TIPO_AMBIGUO).
 */
export function inferirTipoOperacion(cliente: ClienteFiscal, lineas: Array<{ tipoIva: number }>): TipoOperacionVenta | null {
  if (lineas.length === 0) return null;
  if (lineas.every((l) => l.tipoIva > 0)) return 'NACIONAL';
  if (!lineas.every((l) => l.tipoIva === 0)) return paisDelCliente(cliente) === 'ES' ? 'NACIONAL' : null;
  if (tieneNifIvaUe(cliente) || tieneNifIvaXi(cliente)) return 'INTRACOMUNITARIA';
  const pais = paisDelCliente(cliente);
  if (pais !== 'ES' && !PAISES_UE.has(pais)) return 'EXPORTACION';
  return null;
}

export interface Sugerencia {
  tipoOperacion: TipoOperacionVenta;
  /** Codigos de aviso que acompanan la sugerencia. */
  avisos: string[];
}

/** Tipo que se propone al elegir cliente (y, si se conocen, los tipos de producto de las lineas). */
export function sugerirTipoOperacion(cliente: ClienteFiscal, tiposProducto: TipoProducto[] = []): Sugerencia {
  const bienes = tiposProducto.includes('PRODUCTO');
  const servicios = tiposProducto.includes('SERVICIO');
  const mixto = bienes && servicios;
  const avisos: string[] = mixto ? ['TIPO_PRODUCTO'] : [];
  const pais = paisDelCliente(cliente);

  if (pais === 'ES') {
    if (!fueraDelTai(pais, cliente.cp)) return { tipoOperacion: 'NACIONAL', avisos: [] };
    return { tipoOperacion: bienes ? 'EXPORTACION' : 'SERVICIOS_EXTRANJERO', avisos: [...avisos, 'CLIENTE_FUERA_TAI'] };
  }
  if (PAISES_UE.has(pais)) {
    if (!tieneNifIvaUe(cliente)) return { tipoOperacion: 'NACIONAL', avisos: ['CLIENTE_EXTRANJERO_CON_IVA'] };
    return { tipoOperacion: bienes ? 'INTRACOMUNITARIA' : 'SERVICIOS_EXTRANJERO', avisos };
  }
  // Irlanda del Norte (XI): las entregas de bienes son intracomunitarias.
  if (bienes && !servicios && tieneNifIvaXi(cliente)) return { tipoOperacion: 'INTRACOMUNITARIA', avisos };
  // Servicios fuera de la UE: no sujetos si el cliente es empresario (o en los del art. 69.Dos).
  return bienes
    ? { tipoOperacion: 'EXPORTACION', avisos }
    : { tipoOperacion: 'SERVICIOS_EXTRANJERO', avisos: [...avisos, 'SERVICIOS_PARTICULAR'] };
}

/** Quien revisa: guardar (borrador/proforma), emitir, heredar (rectificativa) o lector (OCR). */
export type ModoFiscal = 'guardar' | 'emitir' | 'heredar' | 'lector';

export interface AvisoFiscal {
  codigo: string;
  mensaje: string;
}

export interface EntradaFiscal {
  empresaEspanola: boolean;
  tipoOperacion: string | null;
  causaExencion?: string | null;
  referenciaLegal?: string | null;
  tipoFactura?: string | null;
  lineas: Array<{ tipoIva: number; tipoRetencion: number }>;
  cliente: ClienteFiscal;
  tiposProducto?: TipoProducto[];
  /**
   * No bloquear por contradicciones con el tipo (pasan a aviso): rectificativa de
   * una factura sin tipo (anterior) o borrador cuyo tipo no ha elegido el usuario.
   */
  heredadoLegacy?: boolean;
}

const MENSAJES: Record<string, string> = {
  LINEA_CON_IVA: 'Este tipo de operación no lleva IVA: pon todas las líneas al 0 %.',
  RETENCION_NO_RESIDENTE: 'A un cliente no residente no se le aplica retención de IRPF: quítala de las líneas.',
  F2_NO_PERMITIDA: 'Este tipo de operación no admite factura simplificada: usa factura completa (F1).',
  CAUSA_SIN_EXENTA: 'La causa de exención solo se indica en operaciones exentas.',
  CAUSA_NO_VALIDA: 'La causa de exención tiene que ser E1, E3, E4 o E6.',
  REFERENCIA_LARGA: `La referencia legal admite como máximo ${MAX_REFERENCIA_LEGAL} caracteres.`,
  TIPO_RESERVADO: 'Tipo de operación no válido.',
  LINEA_SIN_IVA:
    'Todas las líneas van al 0 % en una factura nacional: elige Exenta, Intracomunitaria, Exportación… o pon el IVA que corresponda.',
  LINEAS_AL_0:
    'Hay líneas al 0 % en una factura nacional: solo es correcto con suplidos (gastos pagados en nombre y por cuenta del cliente, art. 78.Tres.3.º LIVA). Si es una operación exenta, hazla en otra factura con su tipo.',
  CLIENTE_NO_UE: 'Una entrega intracomunitaria exige un cliente de otro Estado de la UE.',
  CLIENTE_SIN_NIF_IVA:
    'Falta el NIF-IVA del cliente con el prefijo de su Estado (por ejemplo FR…, DE…; EL para Grecia).',
  CLIENTE_ESPANOL: 'El cliente es de España: una venta a un cliente español lleva IVA (salvo Canarias, Ceuta y Melilla).',
  EXENCION_SIN_SUPUESTO: 'Indica el supuesto de exención (causa y precepto legal).',
  ISP_CLIENTE: 'La inversión del sujeto pasivo exige un cliente español con NIF.',
  TIPO_AMBIGUO: 'Elige el tipo de operación de la factura.',
  CLIENTE_EXTRANJERO_CON_IVA:
    'Cliente extranjero con IVA español: es correcto con un particular de la UE (por debajo de 10.000 €/año) o un empresario sin NIF-IVA.',
  OPERACION_INCOHERENTE_PAIS: 'El cliente es de la UE: ¿no es una entrega intracomunitaria?',
  CLIENTE_FUERA_TAI: 'El cliente está en Canarias, Ceuta o Melilla: no se le repercute IVA peninsular.',
  TIPO_PRODUCTO: 'Revisa si la factura es de bienes o de servicios: cada uno tiene su tipo de operación.',
  ART70: 'Algunos servicios se gravan en España aunque el cliente sea extranjero (art. 70 LIVA): inmuebles, eventos, restauración…',
  SERVICIOS_PARTICULAR:
    'Comprueba que el cliente es un empresario: a un particular de fuera de la UE solo se le factura sin IVA en los servicios del art. 69.Dos LIVA (asesoría, publicidad, servicios electrónicos…); en los demás el servicio se grava en España (art. 69.Uno.2.º) y lleva IVA.',
  ROI_Y_PRUEBA_TRANSPORTE:
    'Comprueba el alta del cliente en el ROI (VIES) y guarda la prueba del transporte de los bienes a otro Estado.',
  DUA_DAE: 'Guarda el DUA o DAE de la exportación como prueba de la salida de los bienes.',
  PRORRATA: 'Las operaciones exentas sin derecho a deducción pueden obligarte a aplicar la prorrata del IVA soportado.',
  IVA_ELIMINADO_EMPRESA_EXTRANJERA: 'La empresa no está establecida en España: la factura va sin IVA ni retención.',
  TIPO_LEIDO_OCR: 'No se ha podido saber el tipo de operación de la factura leída: revísalo.',
};

/** Aviso o error fiscal con su texto. */
export const avisoFiscal = (codigo: string): AvisoFiscal => ({ codigo, mensaje: MENSAJES[codigo] ?? codigo });
const aviso = avisoFiscal;

/**
 * Revisa la fiscalidad de una factura con codigos estables. Errores que
 * siempre bloquean (contradicciones), errores que solo bloquean al emitir
 * (al guardar son avisos) y avisos. En modo lector nada bloquea.
 */
export function revisarFiscalidad(e: EntradaFiscal, modo: ModoFiscal): { errores: AvisoFiscal[]; avisos: AvisoFiscal[] } {
  const errores: AvisoFiscal[] = [];
  const avisos: AvisoFiscal[] = [];
  if (!e.empresaEspanola) return { errores, avisos };

  const siempre = (c: string) => (modo === 'lector' || e.heredadoLegacy ? avisos : errores).push(aviso(c));
  const alEmitir = (c: string) => (modo === 'emitir' ? errores : avisos).push(aviso(c));
  const avisar = (c: string) => avisos.push(aviso(c));

  const tipo = e.tipoOperacion;
  if (tipo === null || tipo === '') {
    alEmitir('TIPO_AMBIGUO');
    return { errores, avisos };
  }
  if (!esTipoOperacion(tipo) || tipo === 'EMPRESA_EXTRANJERA') {
    // Un codigo desconocido o reservado nunca se acepta (tampoco del lector).
    errores.push(aviso('TIPO_RESERVADO'));
    return { errores, avisos };
  }

  const regla = REGLA_OPERACION[tipo];
  const cliente = e.cliente;
  const pais = paisDelCliente(cliente);
  const causa = e.causaExencion ? String(e.causaExencion) : null;
  const referencia = String(e.referenciaLegal ?? '').trim();

  if (!regla.llevaCuota && e.lineas.some((l) => l.tipoIva > 0)) siempre('LINEA_CON_IVA');
  if (TIPOS_NO_RESIDENTE.includes(tipo) && e.lineas.some((l) => l.tipoRetencion > 0)) siempre('RETENCION_NO_RESIDENTE');
  if (e.tipoFactura && regla.tiposFacturaProhibidos.includes(e.tipoFactura)) siempre('F2_NO_PERMITIDA');
  if (causa && tipo !== 'EXENTA') siempre('CAUSA_SIN_EXENTA');
  if (causa && tipo === 'EXENTA' && !causaValida(causa)) siempre('CAUSA_NO_VALIDA');
  if (referencia.length > MAX_REFERENCIA_LEGAL) siempre('REFERENCIA_LARGA');

  // En una rectificativa los datos del cliente ya se revisaron al emitir la original.
  const deCliente = modo === 'heredar' ? avisar : alEmitir;
  // Nacional con TODAS las lineas al 0 %: no es nacional. Con alguna (suplidos), solo aviso, como siempre.
  if (tipo === 'NACIONAL' && e.lineas.length > 0 && e.lineas.every((l) => l.tipoIva === 0)) {
    (modo === 'heredar' ? avisar : alEmitir)('LINEA_SIN_IVA');
  } else if (tipo === 'NACIONAL' && e.lineas.some((l) => l.tipoIva === 0)) avisar('LINEAS_AL_0');
  // Irlanda del Norte (XI): entrega intracomunitaria de bienes.
  const intraXi = tipo === 'INTRACOMUNITARIA' && tieneNifIvaXi(cliente);
  if (tipo === 'INTRACOMUNITARIA' && !esClienteUe(cliente) && !intraXi) deCliente('CLIENTE_NO_UE');
  else if (((tipo === 'INTRACOMUNITARIA' && !intraXi) || (tipo === 'SERVICIOS_EXTRANJERO' && esClienteUe(cliente))) && !tieneNifIvaUe(cliente)) {
    deCliente('CLIENTE_SIN_NIF_IVA');
  }
  if ((tipo === 'EXPORTACION' || tipo === 'SERVICIOS_EXTRANJERO') && pais === 'ES' && !fueraDelTai(pais, cliente.cp)) {
    deCliente('CLIENTE_ESPANOL');
  }
  if (tipo === 'EXENTA' && (!causaValida(causa) || !referencia)) alEmitir('EXENCION_SIN_SUPUESTO');
  if (tipo === 'ISP_NACIONAL' && (pais !== 'ES' || !limpiarNif(cliente.nifCif))) deCliente('ISP_CLIENTE');

  if (tipo === 'NACIONAL' && pais !== 'ES') avisar('CLIENTE_EXTRANJERO_CON_IVA');
  if (tipo === 'EXPORTACION' && (esClienteUe(cliente) || tieneNifIvaXi(cliente))) avisar('OPERACION_INCOHERENTE_PAIS');
  if (fueraDelTai(pais, cliente.cp)) avisar('CLIENTE_FUERA_TAI');
  const tp = e.tiposProducto ?? [];
  if ((tipo === 'SERVICIOS_EXTRANJERO' && tp.includes('PRODUCTO')) || ((tipo === 'INTRACOMUNITARIA' || tipo === 'EXPORTACION') && tp.includes('SERVICIO'))) {
    avisar('TIPO_PRODUCTO');
  }
  if (tipo === 'SERVICIOS_EXTRANJERO') avisar('ART70');
  if (tipo === 'SERVICIOS_EXTRANJERO' && pais !== 'ES' && !PAISES_UE.has(pais)) avisar('SERVICIOS_PARTICULAR');
  if (tipo === 'INTRACOMUNITARIA') avisar('ROI_Y_PRUEBA_TRANSPORTE');
  if (tipo === 'EXPORTACION') avisar('DUA_DAE');
  if (tipo === 'EXENTA' && (causa === 'E1' || causa === 'E6')) avisar('PRORRATA');

  return { errores, avisos };
}

export interface ResultadoFiscalidad {
  /** Tipo a guardar (null: borrador sin tipo elegido; se infiere al emitir). */
  tipoOperacion: TipoOperacionVenta | null;
  /** Tipo con el que se trata la factura ahora (el guardado o el inferido). */
  tipoOperacionEfectivo: TipoOperacionVenta | null;
  causaExencion: CausaExencion | null;
  referenciaLegal: string | null;
  /** Lineas con el IVA y la retencion definitivos (normalizadas en empresa extranjera). */
  lineas: Array<{ tipoIva: number; tipoRetencion: number }>;
  errores: AvisoFiscal[];
  avisos: AvisoFiscal[];
}

/**
 * Decide el tipo de operacion de una factura (puro):
 *  1. Empresa no espanola: EMPRESA_EXTRANJERA, lineas a 0 % de IVA y sin
 *     retencion (se normaliza, no se rechaza: el lector OCR manda 21 % por
 *     defecto), causa y referencia a null.
 *  2. Sin tipo: se infiere; en el lector, si no se puede, EXENTA E6 "Revisar".
 *     Al guardar un borrador o proforma solo se guarda el tipo ELEGIDO.
 *  3. Se revisa con `revisarFiscalidad`.
 */
export function resolverFiscalidadPura(e: EntradaFiscal, modo: ModoFiscal): ResultadoFiscalidad {
  if (!e.empresaEspanola) {
    const cambia = e.lineas.some((l) => l.tipoIva !== 0 || l.tipoRetencion !== 0);
    return {
      tipoOperacion: 'EMPRESA_EXTRANJERA',
      tipoOperacionEfectivo: 'EMPRESA_EXTRANJERA',
      causaExencion: null,
      referenciaLegal: null,
      lineas: e.lineas.map(() => ({ tipoIva: 0, tipoRetencion: 0 })),
      errores: [],
      avisos: cambia ? [aviso('IVA_ELIMINADO_EMPRESA_EXTRANJERA')] : [],
    };
  }

  const elegido = e.tipoOperacion ? String(e.tipoOperacion).trim().toUpperCase() : null;
  let causa = e.causaExencion ? String(e.causaExencion).trim().toUpperCase() : null;
  let referencia = e.referenciaLegal ? String(e.referenciaLegal).trim() || null : null;
  const avisosExtra: AvisoFiscal[] = [];

  let efectivo: string | null = elegido ?? inferirTipoOperacion(e.cliente, e.lineas);
  if (!efectivo && modo === 'lector') {
    // Factura leida que no se sabe clasificar: si alguna linea lleva IVA, nacional
    // (como siempre); si todas van al 0 %, exenta "para revisar".
    avisosExtra.push(aviso('TIPO_LEIDO_OCR'));
    if (e.lineas.some((l) => l.tipoIva > 0)) efectivo = 'NACIONAL';
    else {
      efectivo = 'EXENTA';
      causa = 'E6';
      referencia = 'Revisar: leída por OCR';
    }
  }
  // La referencia solo tiene sentido en EXENTA (obligatoria) e ISP (opcional).
  if (efectivo !== 'EXENTA' && efectivo !== 'ISP_NACIONAL') referencia = null;

  // Un borrador sin tipo elegido no se bloquea por el tipo que se deduce: solo se avisa.
  const sinBloqueo = !!e.heredadoLegacy || (modo === 'guardar' && !elegido);
  const { errores, avisos } = revisarFiscalidad(
    { ...e, tipoOperacion: efectivo, causaExencion: causa, referenciaLegal: referencia, heredadoLegacy: sinBloqueo },
    modo,
  );
  const tipoValido = esTipoOperacion(efectivo) ? efectivo : null;
  // Borrador o proforma: solo se guarda lo que el usuario eligio.
  const guardar = modo === 'guardar' ? (elegido && esTipoOperacion(elegido) ? elegido : null) : tipoValido;
  return {
    tipoOperacion: guardar,
    tipoOperacionEfectivo: tipoValido,
    causaExencion: efectivo === 'EXENTA' ? causaValida(causa) : null,
    referenciaLegal: referencia ? referencia.slice(0, MAX_REFERENCIA_LEGAL) : null,
    lineas: e.lineas.map((l) => ({ tipoIva: l.tipoIva, tipoRetencion: l.tipoRetencion })),
    errores,
    avisos: [...avisosExtra, ...avisos],
  };
}

/** Mencion fiscal del PDF para un tipo (null si no lleva). */
export function mencionFiscal(tipo: TipoOperacionVenta | null, ctx: ContextoOperacion): Mencion | null {
  return tipo ? REGLA_OPERACION[tipo].mencion(ctx) : null;
}

/** ¿El pais de la empresa es Espana? (reexportado para quien solo importa este modulo). */
export { esPaisEspana };
