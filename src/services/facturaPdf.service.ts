import { degrees, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import { prisma } from '../config/database';
import { notFound } from '../utils/http-errors';
import { crearDocumentoPdfA, guardarPdfA } from '../utils/pdf-a';
import { textoInscripcionRegistral } from './legalConfig.service';
import { desgloseIvaPorTipo } from './accounting-engine.service';
import { perfilDesdeConfig } from './perfilEmpresa.service';
import { importesDoc, nombreMoneda, textoTipo } from '../domain/divisas';
import {
  esPaisEspana,
  formatearFecha,
  formatearNumero,
  formatoPorPais,
  type FormatoDocumento,
  type Idioma,
} from '../domain/perfil-empresa.model';
import {
  esPaisUe,
  esTipoOperacion,
  mencionFiscal,
  normalizarPais,
  paisDelCliente,
  REGLA_OPERACION,
  resolverFiscalidadPura,
  tieneNifIvaUe,
  type TipoOperacionVenta,
} from '../domain/tipo-operacion.model';

/**
 * PDF de una factura de venta (PDF/A-2b, apto para conservarla).
 *
 * Lleva lo que exige el art. 6 del Reglamento de facturacion (RD 1619/2012):
 * numero y serie, fecha de expedicion, nombre, NIF y domicilio del emisor y del
 * cliente, descripcion de las operaciones, base, tipo y cuota de IVA por tipo y
 * total. Las rectificativas llevan la factura que corrigen y el motivo.
 * Un borrador sale con marca de agua y sin numero.
 *
 * Moneda: los importes van en la moneda de la FACTURA. Si no es la de la
 * contabilidad, un bloque da el tipo de cambio aplicado y el contravalor (la
 * cuota de IVA en euros, art. 12.1 RD 1619/2012), con las mismas cifras que el
 * libro de IVA.
 *
 * Tipo de operacion: la mencion legal de la exencion, la no sujecion o la
 * inversion del sujeto pasivo (domain/tipo-operacion.model.ts), en espanol y,
 * si el cliente no es de Espana, tambien en ingles.
 *
 * Empresa no establecida en Espana: la factura entera en ingles (fechas y cifras
 * del pais: EE. UU. MM/DD/YYYY, resto DD/MM/YYYY; 1,234.56), sin IVA.
 *
 * Diseno: todo sobrio (filetes finos, cifras en Geist Mono) salvo una franja de
 * pago en verde bajo la cabecera, que responde a lo que busca el cliente:
 * cuanto, cuando y como se paga.
 *
 * `generarPdfFactura` carga los datos de la BD; `renderizarFactura` solo dibuja
 * (funcion pura sobre un objeto plano, se puede probar sin BD).
 * TODO (Verifactu paso 2): el QR y la leyenda "VERI*FACTU" al enviar a la AEAT.
 * El logo de la empresa (si lo hay) va arriba a la derecha y el numero baja debajo.
 */

// ---------- Datos de entrada ----------

/** Importes en la moneda de la factura. */
export interface LineaFacturaPdf {
  descripcion: string;
  cantidad: number;
  precioUnitario: number;
  descuentoPorcentaje: number;
  tipoIva: number;
  ivaImporte: number;
  baseLine: number;
  tipoRetencion: number;
}

/** Importes en la moneda de la contabilidad (los mismos que el libro de IVA). */
export interface ContravalorPdf {
  base: number;
  iva: number;
  retencion: number;
  total: number;
  desglose: Array<{ tipoIva: number; base: number; cuota: number }>;
}

export interface DatosFacturaPdf {
  id: string;
  numeroCompleto: string | null;
  estadoDocumento: string; // 'BORRADOR' | 'FINAL' | 'PROFORMA'
  tipoFactura: string; // F1, F2, R1-R5
  formaPago: string; // TRANSFERENCIA | GIRO | CONTADO
  tipoRectificativa: string | null; // S | I
  motivoRectificacion: string | null;
  esRectificativa: boolean;
  fechaEmision: string; // YYYY-MM-DD
  fechaVencimiento: string; // YYYY-MM-DD
  /** Totales en la moneda de la factura (`moneda`). */
  baseTotal: number;
  ivaTotal: number;
  retencionTotal: number;
  totalFactura: number;
  observaciones: string | null;
  lineas: LineaFacturaPdf[];
  cliente: {
    nombreFiscal: string;
    nifCif: string | null;
    direccion: string | null;
    cp: string | null;
    municipio: string | null;
    provincia: string | null;
    pais: string | null;
  };
  emisor: {
    denominacion: string | null;
    nif: string | null;
    domicilioSocial: string | null;
    codigoPostal: string | null;
    municipio: string | null;
    provincia: string | null;
    telefono?: string | null;
    email?: string | null;
    web?: string | null;
    /** "Inscrita en el Registro Mercantil de ..." (sociedades), al pie en letra pequena. */
    inscripcion?: string | null;
    /** Pais de la empresa (ISO-2). Decide el idioma y el formato: ES o vacio, espanol. */
    pais?: string | null;
  } | null;
  /** Factura que corrige una rectificativa. */
  original: { numeroCompleto: string | null; fechaEmision: string } | null;
  /** Cuenta donde se cobra (solo se imprime si la forma de pago es transferencia). */
  cuenta: { iban: string; bic: string | null } | null;
  /** Logo de la empresa (PNG o JPG). */
  logo?: { bytes: Uint8Array; mime: string } | null;
  /** Moneda de la factura (ISO 4217). Por defecto EUR. */
  moneda?: string;
  /** Moneda de la contabilidad de la empresa. Por defecto EUR. */
  monedaCuenta?: string;
  /** Unidades de `moneda` por 1 de `monedaCuenta` ("1 EUR = 1,1490 USD"). */
  tipoCambio?: number | null;
  /** Fecha de la observacion del BCE. */
  fechaTipoCambio?: string | null;
  /** PAR | BCE | MANUAL | HEREDADO | PENDIENTE */
  fuenteTipoCambio?: string | null;
  /** Fecha de la operacion (devengo) si es distinta de la de emision. */
  fechaOperacion?: string | null;
  /** Importes en la moneda de cuenta; null si la factura va en ella o aun no hay tipo. */
  contravalor?: ContravalorPdf | null;
  /** Tipo de operacion de IVA guardado (null: anterior a esta funcion o sin elegir). */
  tipoOperacion?: string | null;
  causaExencion?: string | null;
  referenciaLegal?: string | null;
  /** false: sin IVA (empresa no establecida en Espana). Por defecto, segun el pais del emisor. */
  conIva?: boolean;
}

/** Hueco del logo, arriba a la derecha (puntos). */
const LOGO_ANCHO = 150;
const LOGO_ALTO = 56;

// ---------- Paleta y medidas ----------

const TINTA = rgb(0.059, 0.09, 0.165); // #0F172A
const GRIS = rgb(0.392, 0.455, 0.545); // #64748B
const LINEA = rgb(0.886, 0.91, 0.941); // #E2E8F0
const ACENTO = rgb(0.016, 0.471, 0.341); // #047857
const ACENTO_SUAVE = rgb(0.925, 0.992, 0.961); // #ECFDF5
const MARCA_AGUA = rgb(0.945, 0.953, 0.965);
const FONDO_DIVISA = rgb(0.973, 0.98, 0.988); // #F8FAFC

const MARGEN = 48;
const PIE_Y = 30;
const SUELO = 56; // nada de contenido por debajo (deja sitio al pie)
const COL_B = 300; // segunda columna: cliente y forma de pago

/** Nota que lleva la proforma bajo el titulo. */
export const AVISO_PROFORMA = 'Documento sin validez fiscal. No es una factura.';

// ---------- Textos (espanol / ingles) ----------

interface TextosPdf {
  titulo: Record<string, string>;
  proforma: string;
  avisoProforma: string;
  borradorDe: (tipoDoc: string) => string;
  borradorCabecera: string;
  marcaAgua: string;
  refBorrador: (tipoDoc: string) => string;
  continuacion: string;
  numero: (tipoDoc: string, esProforma: boolean, esRectificativa: boolean) => string;
  fechaEmision: string;
  fechaOperacion: string;
  emisor: string;
  cliente: string;
  nif: string;
  nifIva: string;
  nifExtranjero: string;
  faltaDenominacion: string;
  faltaNif: string;
  tel: string;
  totalPagar: string;
  totalAbonar: string;
  fechaPago: string;
  vence: string;
  formaPago: string;
  pagoTransferenciaA: string;
  contado: string;
  transferencia: string;
  giro: string;
  bic: string;
  rectificacion: string;
  rectifica: (ref: { numero: string; fecha: string } | null, sustitucion: boolean, tipoFactura: string) => string;
  motivo: string;
  concepto: string;
  cant: string;
  precio: string;
  dto: string;
  iva: string;
  importe: string;
  desgloseIva: string;
  tipo: string;
  base: string;
  cuota: string;
  ivaCeroGenerico: string;
  baseImponible: string;
  ivaFila: string;
  retencion: (pct: string) => string;
  total: string;
  totalFactura: string;
  /** Fila del total cuando es negativo (rectificativa que abona). */
  totalNegativo: string;
  observaciones: string;
  pagina: (i: number, n: number) => string;
  pieBorrador: string;
  piePro: string;
}

const TEXTOS: Record<Idioma, TextosPdf> = {
  es: {
    titulo: {
      F1: 'Factura',
      F2: 'Factura simplificada',
      R1: 'Factura rectificativa',
      R2: 'Factura rectificativa',
      R3: 'Factura rectificativa',
      R4: 'Factura rectificativa',
      R5: 'Factura rectificativa',
    },
    proforma: 'Factura proforma',
    avisoProforma: AVISO_PROFORMA,
    borradorDe: (t) => `Borrador de ${t.toLowerCase()}`,
    borradorCabecera: 'Borrador · sin número ni validez fiscal',
    marcaAgua: 'BORRADOR',
    refBorrador: (t) => `${t} (borrador)`,
    continuacion: 'continuación',
    numero: () => 'Nº',
    fechaEmision: 'Fecha de emisión',
    fechaOperacion: 'Fecha de la operación',
    emisor: 'Emisor',
    cliente: 'Cliente',
    nif: 'NIF',
    nifIva: 'NIF-IVA / VAT No.',
    nifExtranjero: 'NIF / Tax ID',
    faltaDenominacion: 'Falta la denominación de la empresa',
    faltaNif: 'falta el NIF',
    tel: 'Tel.',
    totalPagar: 'Total a pagar',
    totalAbonar: 'Total a abonar',
    fechaPago: 'Fecha de pago',
    vence: 'Vence',
    formaPago: 'Forma de pago',
    pagoTransferenciaA: 'Transferencia a la cuenta',
    contado: 'Contado',
    transferencia: 'Transferencia bancaria',
    giro: 'Recibo domiciliado en su cuenta',
    bic: 'BIC',
    rectificacion: 'Rectificación',
    rectifica: (ref, sustitucion, tipoFactura) =>
      `Rectifica ${ref ? `la factura ${ref.numero}, de ${ref.fecha}` : 'una factura anterior'}, ${
        sustitucion ? 'por sustitución' : 'por diferencias'
      } (${tipoFactura}).`,
    motivo: 'Motivo',
    concepto: 'Concepto',
    cant: 'Cant.',
    precio: 'Precio',
    dto: 'Dto.',
    iva: 'IVA',
    importe: 'Importe',
    desgloseIva: 'Desglose de IVA',
    tipo: 'Tipo',
    base: 'Base',
    cuota: 'Cuota',
    ivaCeroGenerico: 'IVA 0 %: operación exenta o no sujeta',
    baseImponible: 'Base imponible',
    ivaFila: 'IVA',
    retencion: (p) => `Retención IRPF ${p}`,
    total: 'Total',
    totalFactura: 'Total factura',
    totalNegativo: 'Total factura',
    observaciones: 'Observaciones',
    pagina: (i, n) => `Página ${i} de ${n}`,
    pieBorrador: 'Borrador sin validez fiscal',
    piePro: 'Proforma sin validez fiscal',
  },
  en: {
    titulo: {
      F1: 'Invoice',
      F2: 'Simplified invoice',
      R1: 'Credit note',
      R2: 'Credit note',
      R3: 'Credit note',
      R4: 'Credit note',
      R5: 'Credit note',
    },
    proforma: 'Proforma invoice',
    avisoProforma: 'This is not an invoice and has no tax validity.',
    borradorDe: (t) => `Draft ${t.toLowerCase()}`,
    borradorCabecera: 'Draft · not numbered, not valid as an invoice',
    marcaAgua: 'DRAFT',
    refBorrador: (t) => `${t} (draft)`,
    continuacion: 'continued',
    numero: (_t, esProforma, esRectificativa) => (esProforma ? 'Proforma no.' : esRectificativa ? 'Credit note no.' : 'Invoice no.'),
    fechaEmision: 'Date',
    fechaOperacion: 'Date of supply',
    emisor: 'From',
    cliente: 'Bill to',
    nif: 'Tax ID',
    nifIva: 'VAT No.',
    nifExtranjero: 'Tax ID',
    faltaDenominacion: 'Company name missing',
    faltaNif: 'Tax ID missing',
    tel: 'Tel.',
    totalPagar: 'Total due',
    totalAbonar: 'Total credited',
    fechaPago: 'Payment date',
    vence: 'Due date',
    formaPago: 'Payment details',
    pagoTransferenciaA: 'Payment details',
    contado: 'Cash',
    transferencia: 'Bank transfer',
    giro: 'Direct debit from your account',
    bic: 'SWIFT/BIC',
    rectificacion: 'Credit note',
    rectifica: (ref, sustitucion) =>
      `${sustitucion ? 'Replaces' : 'Corrects'} ${ref ? `invoice ${ref.numero}, dated ${ref.fecha}` : 'a previous invoice'}.`,
    motivo: 'Reason',
    concepto: 'Description',
    cant: 'Qty',
    precio: 'Unit price',
    dto: 'Disc.',
    iva: 'VAT',
    importe: 'Amount',
    desgloseIva: 'VAT breakdown',
    tipo: 'Rate',
    base: 'Base',
    cuota: 'VAT',
    ivaCeroGenerico: 'VAT 0 %: exempt or outside the scope of VAT',
    baseImponible: 'Subtotal',
    ivaFila: 'VAT',
    retencion: (p) => `Withholding ${p}`,
    total: 'Total',
    totalFactura: 'Total due',
    totalNegativo: 'Total credit',
    observaciones: 'Notes',
    pagina: (i, n) => `Page ${i} of ${n}`,
    pieBorrador: 'Draft, not valid as an invoice',
    piePro: 'Proforma, not an invoice',
  },
};

// ---------- Formatos ----------

const num = (n: number, dec = 2): string =>
  n.toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: true });
const eur = (n: number): string => `${n < 0 ? '−' : ''}${num(Math.abs(n))} €`;
const fechaES = (iso: string): string =>
  /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso;
const cantidadES = (n: number): string =>
  `${n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('es-ES', { maximumFractionDigits: 3 })}`;
const nif = (s: string | null | undefined): string => (s ?? '').replace(/[\s-]/g, '').toUpperCase();
/**
 * Identificacion fiscal tal como se imprime: la espanola y la de la UE sin
 * espacios ni guiones (B46123456, FR40303265045); la de otros paises, como se
 * escribio (el EIN de EE. UU. es 12-3456789).
 */
const nifDe = (s: string | null | undefined, pais: string | null | undefined): string => {
  const p = normalizarPais(pais || 'ES');
  if (!p || p === 'ES' || esPaisUe(p)) return nif(s);
  return (s ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
};
const iban = (s: string): string => s.replace(/\s/g, '').toUpperCase().replace(/(.{4})/g, '$1 ').trim();
const pctES = (n: number): string => `${n.toLocaleString('es-ES', { maximumFractionDigits: 2 })} %`;

/**
 * Formatos del documento segun su idioma. En espanol y en euros, exactamente
 * los de siempre ('1.234,56 €'); en otra moneda, el codigo detras
 * ('1.234,56 USD'). En ingles, el codigo delante ('USD 1,234.56'): sin simbolos
 * ambiguos ($ vale para varias monedas) y sin Intl currency (la fuente va en
 * subconjunto y no lleva el espacio fino U+202F).
 */
function formatos(idioma: Idioma, formato: FormatoDocumento, moneda: string) {
  const es = idioma === 'es';
  const cifra = (n: number): string => `${n < 0 ? '−' : ''}${es ? num(Math.abs(n)) : formatearNumero(Math.abs(n), formato)}`;
  const importe = (n: number, mon = moneda): string => {
    if (es) return mon === 'EUR' ? eur(n) : `${cifra(n)} ${mon}`;
    return `${mon} ${cifra(n)}`;
  };
  return {
    cifra,
    importe,
    /** Celda de la tabla de lineas: en euros y en espanol, como siempre (con €); si no, la cifra (la moneda va en la cabecera). */
    celda: (n: number): string => (es && moneda === 'EUR' ? eur(n) : cifra(n)),
    fecha: (iso: string): string => (es ? fechaES(iso) : formatearFecha(iso, formato)),
    cantidad: (n: number): string =>
      es ? cantidadES(n) : `${n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 3 })}`,
    pct: (n: number): string => (es ? pctES(n) : `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`),
  };
}

/** Nombre del pais en el idioma del documento ('US' -> 'Estados Unidos'); el codigo si no se conoce. */
function nombrePais(codigo: string, idioma: Idioma): string {
  const c = normalizarPais(codigo);
  if (!/^[A-Z]{2}$/.test(c)) return codigo;
  try {
    return new Intl.DisplayNames([idioma], { type: 'region' }).of(c) ?? codigo;
  } catch {
    return codigo;
  }
}

/** Parte un texto en lineas que caben en `ancho` puntos (corta tambien palabras imposibles). */
function partir(texto: string, fuente: PDFFont, tam: number, ancho: number): string[] {
  const out: string[] = [];
  const cabe = (s: string) => fuente.widthOfTextAtSize(s, tam) <= ancho;
  for (const parrafo of texto.split(/\r?\n/)) {
    let linea = '';
    for (let palabra of parrafo.split(/\s+/).filter(Boolean)) {
      // Palabra mas ancha que la columna (una URL, una referencia): se trocea.
      while (!cabe(palabra)) {
        let corte = palabra.length - 1;
        while (corte > 1 && !cabe(palabra.slice(0, corte))) corte--;
        if (linea) {
          out.push(linea);
          linea = '';
        }
        out.push(palabra.slice(0, corte));
        palabra = palabra.slice(corte);
      }
      const prueba = linea ? `${linea} ${palabra}` : palabra;
      if (linea && !cabe(prueba)) {
        out.push(linea);
        linea = palabra;
      } else {
        linea = prueba;
      }
    }
    out.push(linea);
  }
  return out;
}

/**
 * Codigo postal y poblacion. En Espana y en la UE, el codigo delante
 * ('46006 València (Valencia)', '75009 Paris'); en el resto, la ciudad delante
 * ('Miami, FL 33131', 'Central, Hong Kong').
 */
const lineaPoblacion = (
  cp?: string | null,
  municipio?: string | null,
  provincia?: string | null,
  pais?: string | null,
): string => {
  const prov = provincia && provincia.trim() && provincia.trim() !== municipio?.trim() ? provincia.trim() : '';
  const p = normalizarPais(pais || 'ES');
  if (p && p !== 'ES' && !esPaisUe(p)) {
    // 'Miami, FL 33131': coma tras la ciudad si sigue el estado (en la provincia o delante del codigo).
    const ciudad = [municipio?.trim(), prov].filter(Boolean).join(', ');
    const codigo = cp?.trim() ?? '';
    if (!ciudad || !codigo) return ciudad || codigo;
    return `${ciudad}${!prov && /^[A-Za-z]/.test(codigo) ? ',' : ''} ${codigo}`;
  }
  const base = [cp, municipio].filter((s) => s && s.trim()).join(' ');
  return base && prov ? `${base} (${prov})` : base || prov;
};

// ---------- Textos de divisa y de la mencion (puros, se prueban sin dibujar) ----------

/**
 * Frase del bloque de divisa: en que moneda va la factura, que tipo se aplica y
 * de donde sale. Vacia si la factura va en la moneda de la contabilidad.
 */
export function fraseDivisa(f: DatosFacturaPdf, idioma: Idioma): string {
  const moneda = f.moneda ?? 'EUR';
  const cuenta = f.monedaCuenta ?? 'EUR';
  if (moneda === cuenta) return '';
  const formato = formatoPorPais(f.emisor?.pais ?? 'ES');
  const fecha = (iso: string) => (idioma === 'es' ? fechaES(iso) : formatearFecha(iso, formato));
  const nombre = `${nombreMoneda(moneda, idioma)} (${moneda})`;
  const tc = Number(f.tipoCambio ?? 0);
  const fuente = f.fuenteTipoCambio ?? '';
  const definitivo = f.estadoDocumento === 'FINAL';
  const conCuota = llevaCuotaIva(f);

  if (fuente === 'PENDIENTE' || !(tc > 0)) {
    return idioma === 'es'
      ? `Importes en ${nombre}. Todavía no hay tipo de cambio: el contravalor en ${nombreMoneda(cuenta)} se calcula al emitir la factura.`
      : `Amounts in ${nombre}. No exchange rate yet: the ${cuenta} equivalent is calculated when the invoice is issued.`;
  }
  const tipo = textoTipo(cuenta, moneda, tc, idioma);
  const fechaTipo = f.fechaTipoCambio ? fecha(f.fechaTipoCambio) : '';
  if (!definitivo) {
    return idioma === 'es'
      ? `Importes en ${nombre}. Contravalor orientativo al tipo ${fechaTipo && fuente === 'BCE' ? `del BCE del ${fechaTipo} ` : 'indicado '}(${tipo}); el tipo definitivo se fija al emitir la factura.`
      : `Amounts in ${nombre}. Indicative ${cuenta} equivalent at ${fechaTipo && fuente === 'BCE' ? `the ECB rate of ${fechaTipo} ` : 'the rate given '}(${tipo}); the final rate is set when the invoice is issued.`;
  }
  const original = f.original?.numeroCompleto ?? '';
  const origen =
    idioma === 'es'
      ? fuente === 'BCE'
        ? `referencia BCE${fechaTipo ? ` de ${fechaTipo}` : ''}`
        : fuente === 'MANUAL'
          ? 'tipo indicado por el emisor'
          : fuente === 'HEREDADO'
            ? `el de la factura rectificada${original ? ` ${original}` : ''}`
            : ''
      : fuente === 'BCE'
        ? `ECB reference rate${fechaTipo ? ` of ${fechaTipo}` : ''}`
        : fuente === 'MANUAL'
          ? 'rate set by the issuer'
          : fuente === 'HEREDADO'
            ? `rate of the corrected invoice${original ? ` ${original}` : ''}`
            : '';
  if (idioma === 'es') {
    return `Factura expresada en ${nombre}. Tipo de cambio aplicado: ${tipo}${origen ? ` (${origen})` : ''}.${
      conCuota && cuenta === 'EUR' ? ' Cuota de IVA en euros según el art. 12.1 del RD 1619/2012.' : ''
    }`;
  }
  return `Amounts in ${nombre}. Exchange rate applied: ${tipo}${origen ? ` (${origen})` : ''}.`;
}

/** Tipo de operacion con el que se imprime la factura (null: sin mencion propia). */
function tipoDelDocumento(f: DatosFacturaPdf): TipoOperacionVenta | null {
  return esTipoOperacion(f.tipoOperacion) ? f.tipoOperacion : null;
}

/**
 * La factura repercute IVA: empresa con IVA, tipo de operacion con cuota (o sin
 * tipo, las de siempre) y alguna cuota. Sin cuota (exportacion, intracomunitaria,
 * ISP...) el contravalor no lleva fila ni desglose de IVA.
 */
function llevaCuotaIva(f: DatosFacturaPdf): boolean {
  if (f.conIva === false) return false;
  const tipo = tipoDelDocumento(f);
  if (tipo && !REGLA_OPERACION[tipo].llevaCuota) return false;
  return f.ivaTotal !== 0 || f.lineas.some((l) => l.ivaImporte !== 0);
}

/**
 * Mencion legal del tipo de operacion: en espanol y, si el cliente no es de
 * Espana, tambien en ingles. Sin tipo (facturas anteriores) no hay mencion
 * propia: conservan el texto generico de siempre.
 */
/**
 * La factura se imprime con IVA (columna, desglose y mencion legal). Sin IVA:
 * las de una empresa no establecida en Espana (EMPRESA_EXTRANJERA; las que ya
 * lleven IVA, con su IVA). Una factura con un tipo de operacion espanol
 * (exportacion, intracomunitaria...) conserva su mencion legal aunque despues
 * cambie el pais de la empresa: el documento emitido no cambia.
 */
export function facturaConIva(
  tipoOperacion: TipoOperacionVenta | null,
  empresaEspanola: boolean,
  ivaTotal: number,
  tiposIva: number[],
): boolean {
  if (tipoOperacion === 'EMPRESA_EXTRANJERA') return false;
  return empresaEspanola || tipoOperacion !== null || ivaTotal !== 0 || tiposIva.some((t) => t !== 0);
}

export function mencionDocumento(f: DatosFacturaPdf): { es: string; en: string | null } | null {
  if (f.conIva === false) return null;
  const tipo = tipoDelDocumento(f);
  if (!tipo) return null;
  const cliente = { pais: f.cliente.pais, nifCif: f.cliente.nifCif, cp: f.cliente.cp };
  const m = mencionFiscal(tipo, { cliente, causaExencion: f.causaExencion, referenciaLegal: f.referenciaLegal });
  if (!m) return null;
  return { es: m.es, en: paisDelCliente(cliente) === 'ES' ? null : m.en };
}

// ---------- Dibujo ----------

/** Dibuja la factura y devuelve el PDF/A. No toca la BD. */
export async function renderizarFactura(f: DatosFacturaPdf): Promise<Buffer> {
  const formato = formatoPorPais(f.emisor?.pais ?? 'ES');
  const idioma = formato.idioma;
  const T = TEXTOS[idioma];
  const moneda = f.moneda ?? 'EUR';
  const monedaCuenta = f.monedaCuenta ?? 'EUR';
  const conIva = f.conIva ?? esPaisEspana(f.emisor?.pais);
  const F = formatos(idioma, formato, moneda);
  const tipoOp = tipoDelDocumento(f);
  const cliente = { pais: f.cliente.pais, nifCif: f.cliente.nifCif, cp: f.cliente.cp };

  // La proforma es el mismo documento con su numero P-n, sin marca de agua y
  // con una nota de que no es una factura.
  const esProforma = f.estadoDocumento === 'PROFORMA';
  const esBorrador = !esProforma && f.estadoDocumento !== 'FINAL';
  const tipoDoc = esProforma ? T.proforma : (T.titulo[f.tipoFactura] ?? T.titulo.F1);
  const tituloDoc = esBorrador ? T.borradorDe(tipoDoc) : `${tipoDoc} ${f.numeroCompleto ?? ''}`.trim();

  const { doc, normal, negrita, mono, monoNegrita, ancho, alto } = await crearDocumentoPdfA(tituloDoc);
  const derecha = ancho - MARGEN;
  const anchoUtil = derecha - MARGEN;

  type Estilo = { tam?: number; fuente?: PDFFont; color?: RGB; alinear?: 'izq' | 'der' };
  const texto = (pg: PDFPage, s: string, x: number, y: number, o: Estilo = {}) => {
    if (!s) return;
    const tam = o.tam ?? 9;
    const fuente = o.fuente ?? normal;
    const xx = o.alinear === 'der' ? x - fuente.widthOfTextAtSize(s, tam) : x;
    pg.drawText(s, { x: xx, y, size: tam, font: fuente, color: o.color ?? TINTA });
  };
  const etiqueta = (pg: PDFPage, s: string, x: number, y: number, o: Estilo = {}) =>
    texto(pg, s, x, y, { tam: 7.5, fuente: negrita, color: GRIS, ...o });
  const filete = (pg: PDFPage, y: number, x1 = MARGEN, x2 = derecha, grueso = 0.5, color = LINEA) =>
    pg.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: grueso, color });

  const nombreEmpresa = f.emisor?.denominacion?.trim() || T.faltaDenominacion;
  const nifEmpresa = nifDe(f.emisor?.nif, f.emisor?.pais) || T.faltaNif;
  const refDoc = esBorrador ? T.refBorrador(tipoDoc) : `${tipoDoc} ${f.numeroCompleto ?? ''}`.trim();

  // ---------- Paginas ----------
  const paginas: PDFPage[] = [];
  const nuevaPagina = (): PDFPage => {
    const pg = doc.addPage([ancho, alto]);
    paginas.push(pg);
    if (esBorrador) {
      // Centrada en la hoja: el punto de origen se desplaza medio texto a lo largo del giro.
      const tam = 100;
      const w = negrita.widthOfTextAtSize(T.marcaAgua, tam);
      const a = (35 * Math.PI) / 180;
      const x = ancho / 2 - (w / 2) * Math.cos(a) + (tam * 0.35) * Math.sin(a);
      const y = alto / 2 - (w / 2) * Math.sin(a) - (tam * 0.35) * Math.cos(a);
      pg.drawText(T.marcaAgua, { x, y, size: tam, font: negrita, color: MARCA_AGUA, rotate: degrees(35) });
    }
    return pg;
  };
  let p = nuevaPagina();
  let y = alto - 72;

  /** Cabecera breve de las paginas siguientes. */
  const continuacion = () => {
    p = nuevaPagina();
    y = alto - 56;
    texto(p, nombreEmpresa, MARGEN, y, { tam: 9, fuente: negrita });
    texto(p, `${refDoc} (${T.continuacion})`, derecha, y, { tam: 9, color: GRIS, alinear: 'der' });
    y -= 30;
  };
  const asegurar = (alto: number): boolean => {
    if (y - alto < SUELO) {
      continuacion();
      return true;
    }
    return false;
  };

  // ---------- Logo (arriba a la derecha) ----------
  // Se ajusta al hueco sin deformarse; el numero y la fecha bajan debajo.
  let yNumero = y;
  if (f.logo?.bytes?.length) {
    try {
      const img = f.logo.mime === 'image/png' ? await doc.embedPng(f.logo.bytes) : await doc.embedJpg(f.logo.bytes);
      const escala = Math.min(LOGO_ANCHO / img.width, LOGO_ALTO / img.height, 1);
      const w = img.width * escala;
      const h = img.height * escala;
      const techo = alto - 36;
      p.drawImage(img, { x: derecha - w, y: techo - h, width: w, height: h });
      yNumero = Math.min(y, techo - h - 18);
    } catch {
      // Imagen dañada: la factura sale igual, sin logo.
    }
  }

  // ---------- Cabecera: tipo de documento y numero ----------
  // El borrador es igual que la factura: solo cambian el numero (aun no lo tiene) y la marca de agua.
  texto(p, tipoDoc, MARGEN, y, { tam: 24, fuente: negrita });
  if (esProforma) texto(p, T.avisoProforma, MARGEN, y - 17, { tam: 8.5, color: GRIS });
  if (esBorrador) {
    texto(p, T.borradorCabecera, derecha, yNumero, { tam: 10, fuente: negrita, color: GRIS, alinear: 'der' });
  } else {
    texto(p, f.numeroCompleto ?? '', derecha, yNumero, { tam: 13, fuente: monoNegrita, alinear: 'der' });
    const wNum = monoNegrita.widthOfTextAtSize(f.numeroCompleto ?? '', 13);
    texto(p, T.numero(tipoDoc, esProforma, f.esRectificativa), derecha - wNum - 6, yNumero, { tam: 9, color: GRIS, alinear: 'der' });
  }
  const filasFecha: Array<[string, string]> = [[T.fechaEmision, F.fecha(f.fechaEmision)]];
  if (f.fechaOperacion && f.fechaOperacion !== f.fechaEmision) filasFecha.push([T.fechaOperacion, F.fecha(f.fechaOperacion)]);
  filasFecha.forEach(([etq, valor], i) => {
    const yy = yNumero - 17 - i * 14;
    texto(p, valor, derecha, yy, { tam: 9, fuente: mono, alinear: 'der' });
    texto(p, etq, derecha - mono.widthOfTextAtSize(valor, 9) - 6, yy, { tam: 9, color: GRIS, alinear: 'der' });
  });
  y = Math.min(y, yNumero) - 50 - (filasFecha.length - 1) * 14;

  // ---------- Emisor y cliente ----------
  // NIF-IVA (VAT No.) en las entregas intracomunitarias y en los servicios a un cliente de la UE.
  const conNifIva = conIva && (tipoOp === 'INTRACOMUNITARIA' || (tipoOp === 'SERVICIOS_EXTRANJERO' && tieneNifIvaUe(cliente)));
  const clienteEspanol = paisDelCliente(cliente) === 'ES';
  const anchoA = COL_B - MARGEN - 24;
  const anchoB = derecha - COL_B;
  const bloqueParte = (
    x: number,
    anchoCol: number,
    titulo: string,
    nombre: string,
    etqNif: string,
    nifTxt: string,
    resto: Array<string | null | undefined>,
    nombreFalta = false,
  ): number => {
    let yy = y;
    etiqueta(p, titulo, x, yy);
    yy -= 15;
    for (const l of partir(nombre, negrita, 10.5, anchoCol)) {
      texto(p, l, x, yy, { tam: 10.5, fuente: negrita, color: nombreFalta ? GRIS : TINTA });
      yy -= 13;
    }
    texto(p, etqNif, x, yy, { color: GRIS });
    // Un NIF real va en mono; el aviso de que falta, en texto normal y gris.
    const nifReal = /\d/.test(nifTxt);
    texto(p, nifTxt, x + normal.widthOfTextAtSize(etqNif, 9) + 5, yy, {
      fuente: nifReal ? mono : normal,
      color: nifReal ? TINTA : GRIS,
    });
    yy -= 12;
    for (const r of resto.filter((s): s is string => !!s && !!s.trim())) {
      for (const l of partir(r, normal, 9, anchoCol)) {
        texto(p, l, x, yy);
        yy -= 12;
      }
    }
    return yy;
  };
  const e = f.emisor;
  const nifEmisorIva = conNifIva && /\d/.test(nifEmpresa) && !nifEmpresa.startsWith('ES') ? `ES${nifEmpresa}` : nifEmpresa;
  const yEmisor = bloqueParte(
    MARGEN,
    anchoA,
    T.emisor,
    nombreEmpresa,
    conNifIva ? T.nifIva : T.nif,
    nifEmisorIva,
    [
      e?.domicilioSocial,
      lineaPoblacion(e?.codigoPostal, e?.municipio, e?.provincia, e?.pais),
      [e?.telefono && `${T.tel} ${e.telefono}`, e?.email, e?.web].filter(Boolean).join(' · ') || null,
    ],
    !e?.denominacion?.trim(),
  );
  const c = f.cliente;
  // Pais del cliente: en espanol, si no es Espana (como siempre); en ingles, si no es el de la empresa.
  const paisEmpresa = normalizarPais(e?.pais || 'ES') || 'ES';
  const paisCliente = c.pais?.trim() ?? '';
  const mostrarPais =
    idioma === 'es'
      ? !!paisCliente && paisCliente.toUpperCase() !== 'ES' && paisCliente.toUpperCase() !== 'ESPAÑA'
      : !!paisCliente && normalizarPais(paisCliente) !== paisEmpresa;
  const etqNifCliente = conNifIva ? T.nifIva : idioma === 'es' && conIva && !clienteEspanol ? T.nifExtranjero : T.nif;
  const yCliente = bloqueParte(COL_B, anchoB, T.cliente, c.nombreFiscal, etqNifCliente, nifDe(c.nifCif, paisDelCliente(cliente)) || '—', [
    c.direccion,
    lineaPoblacion(c.cp, c.municipio, c.provincia, paisDelCliente(cliente)),
    mostrarPais ? nombrePais(paisCliente, idioma) : null,
  ]);
  y = Math.min(yEmisor, yCliente) - 14;

  // ---------- Franja de pago (el elemento firma) ----------
  const aAbonar = f.totalFactura < 0;
  let pagoEtq = T.formaPago;
  let pagoValor = T.contado;
  let pagoMono = false;
  let pagoNota = '';
  if (f.formaPago === 'TRANSFERENCIA') {
    if (f.cuenta?.iban && !aAbonar) {
      pagoEtq = T.pagoTransferenciaA;
      pagoValor = iban(f.cuenta.iban);
      pagoMono = true;
      if (f.cuenta.bic) pagoNota = `${T.bic} ${f.cuenta.bic.toUpperCase()}`;
    } else {
      pagoValor = T.transferencia;
    }
  } else if (f.formaPago === 'GIRO') {
    pagoValor = T.giro;
  } else if (f.formaPago !== 'CONTADO') {
    pagoValor = f.formaPago;
  }
  const altoFranja = pagoNota ? 64 : 54;
  p.drawRectangle({ x: MARGEN, y: y - altoFranja, width: anchoUtil, height: altoFranja, color: ACENTO_SUAVE });
  filete(p, y, MARGEN, derecha, 1.25, ACENTO);
  const yEtq = y - 17;
  const yVal = y - 39;
  const xTotal = MARGEN + 14;
  // Un total largo (o con el codigo de la moneda) aparta el vencimiento hasta
  // donde cabe la fecha y, si aun no cabe, se achica.
  const totalTxt = F.importe(Math.abs(f.totalFactura));
  const xVence = Math.min(Math.max(MARGEN + 152, xTotal + monoNegrita.widthOfTextAtSize(totalTxt, 18) + 20), COL_B - 78);
  etiqueta(p, aAbonar ? T.totalAbonar : T.totalPagar, xTotal, yEtq, { color: ACENTO });
  let tamTotal = 18;
  while (tamTotal > 11 && monoNegrita.widthOfTextAtSize(totalTxt, tamTotal) > xVence - xTotal - 20) tamTotal -= 0.5;
  texto(p, totalTxt, xTotal, yVal, { tam: tamTotal, fuente: monoNegrita });
  etiqueta(p, f.formaPago === 'CONTADO' ? T.fechaPago : T.vence, xVence, yEtq, { color: ACENTO });
  texto(p, F.fecha(f.fechaVencimiento), xVence, yVal, { tam: 11, fuente: mono });
  etiqueta(p, pagoEtq, COL_B, yEtq, { color: ACENTO });
  texto(p, pagoValor, COL_B, yVal, { tam: pagoMono ? 10.5 : 10, fuente: pagoMono ? mono : normal });
  if (pagoNota) texto(p, pagoNota, COL_B, yVal - 13, { tam: 8, fuente: mono, color: GRIS });
  y -= altoFranja + 26;

  // ---------- Rectificativa: a que factura corrige y por que ----------
  if (f.esRectificativa) {
    const ref = f.original?.numeroCompleto ? { numero: f.original.numeroCompleto, fecha: F.fecha(f.original.fechaEmision) } : null;
    const lineas = partir(T.rectifica(ref, f.tipoRectificativa === 'S', f.tipoFactura), normal, 9, anchoUtil);
    const motivo = f.motivoRectificacion?.trim() ? partir(`${T.motivo}: ${f.motivoRectificacion.trim()}`, normal, 9, anchoUtil) : [];
    etiqueta(p, T.rectificacion, MARGEN, y);
    y -= 14;
    for (const l of [...lineas, ...motivo]) {
      texto(p, l, MARGEN, y);
      y -= 12;
    }
    y -= 16;
  }

  // ---------- Tabla de lineas ----------
  const hayDto = f.lineas.some((l) => l.descuentoPorcentaje);
  // En euros y en espanol, como siempre; en otra moneda (o en ingles), la moneda va en la cabecera.
  const conMonedaEnCabecera = !(idioma === 'es' && moneda === 'EUR');
  const tPrecio = conMonedaEnCabecera ? `${T.precio} (${moneda})` : T.precio;
  const tImporte = conMonedaEnCabecera ? `${T.importe} (${moneda})` : T.importe;
  // Columnas numericas, alineadas a la derecha: [titulo, borde derecho].
  const cols: Array<[string, number]> = [];
  {
    let borde = derecha;
    const anchos: Array<[string, number]> = conIva
      ? [
          [tImporte, 0],
          [T.iva, 76],
          ...(hayDto ? ([[T.dto, 42]] as Array<[string, number]>) : []),
          [tPrecio, hayDto ? 42 : 46],
          [T.cant, 72],
        ]
      : [
          [tImporte, 0],
          ...(hayDto ? ([[T.dto, 84]] as Array<[string, number]>) : []),
          [tPrecio, hayDto ? 42 : 84],
          [T.cant, 84],
        ];
    for (const [t, w] of anchos) {
      borde -= w;
      cols.unshift([t, borde]);
    }
  }
  const anchoConcepto = cols[0][1] - 52 - MARGEN;

  const cabeceraTabla = () => {
    etiqueta(p, T.concepto, MARGEN, y - 10);
    for (const [t, x] of cols) etiqueta(p, t, x, y - 10, { alinear: 'der' });
    y -= 16;
    filete(p, y, MARGEN, derecha, 0.75, TINTA);
  };
  cabeceraTabla();
  f.lineas.forEach((l) => {
    const desc = partir(l.descripcion, normal, 9, anchoConcepto);
    let i = 0;
    // Una descripcion muy larga puede partirse entre paginas.
    while (i < desc.length) {
      const caben = Math.max(1, Math.floor((y - SUELO - 9) / 12));
      if (y - 21 < SUELO) {
        continuacion();
        cabeceraTabla();
        continue;
      }
      const trozo = desc.slice(i, i + caben);
      const primera = i === 0;
      let yl = y - 14;
      for (const d of trozo) {
        texto(p, d, MARGEN, yl);
        yl -= 12;
      }
      if (primera) {
        const valores = [
          F.cantidad(l.cantidad),
          F.celda(l.precioUnitario),
          ...(hayDto ? [l.descuentoPorcentaje ? F.pct(l.descuentoPorcentaje) : ''] : []),
          ...(conIva ? [F.pct(l.tipoIva)] : []),
          F.celda(l.baseLine),
        ];
        valores.forEach((v, k) => texto(p, v, cols[k][1], y - 14, { tam: 8.5, fuente: mono, alinear: 'der' }));
      }
      y -= trozo.length * 12 + 9;
      i += trozo.length;
      filete(p, y);
      if (i < desc.length) {
        continuacion();
        cabeceraTabla();
      }
    }
  });

  // ---------- Desglose de IVA (izquierda) y totales (derecha) ----------
  const porTipo = new Map<number, { base: number; cuota: number }>();
  for (const l of f.lineas) {
    const t = porTipo.get(l.tipoIva) ?? { base: 0, cuota: 0 };
    t.base += l.baseLine;
    t.cuota += l.ivaImporte;
    porTipo.set(l.tipoIva, t);
  }
  const tipos = conIva ? Array.from(porTipo.entries()).sort((a, b) => b[0] - a[0]) : [];
  const tipoRet = f.lineas.find((l) => l.tipoRetencion)?.tipoRetencion ?? 0;
  // Un tipo sin cuota (exenta, intracomunitaria...) se nombra por su tipo en vez de "0 %".
  const reglaSinCuota = tipoOp && !REGLA_OPERACION[tipoOp].llevaCuota ? REGLA_OPERACION[tipoOp] : null;
  const etiquetaTipo = (t: number): string => (t === 0 && reglaSinCuota ? reglaSinCuota.etiquetaCorta[idioma] : F.pct(t));
  // El texto generico del 0 % solo en las facturas sin tipo de operacion propio (las de siempre).
  const hayExentoGenerico = conIva && porTipo.has(0) && (tipoOp === null || tipoOp === 'NACIONAL');

  const filasTotales: Array<[string, string]> = [[T.baseImponible, F.importe(f.baseTotal)]];
  if (conIva) filasTotales.push([T.ivaFila, F.importe(f.ivaTotal)]);
  if (f.retencionTotal) filasTotales.push([T.retencion(F.pct(tipoRet)), F.importe(-f.retencionTotal)]);
  const altoTotales = filasTotales.length * 15 + 30;
  const altoDesglose = conIva ? 27 + tipos.length * 13 + (hayExentoGenerico ? 16 : 0) : 0;

  // Mencion legal del tipo de operacion (debajo, a todo lo ancho).
  const mencion = mencionDocumento({ ...f, conIva });
  const mencionEs = mencion ? partir(mencion.es, normal, 8.5, anchoUtil) : [];
  const mencionEn = mencion?.en ? partir(mencion.en, normal, 8, anchoUtil) : [];
  const altoMencion = mencion ? mencionEs.length * 11 + mencionEn.length * 10.5 + 16 : 0;

  // Bloque de divisa: tipo de cambio y contravalor en la moneda de la contabilidad.
  const otraMoneda = moneda !== monedaCuenta;
  const frase = otraMoneda ? partir(fraseDivisa({ ...f, conIva }, idioma), normal, 8.5, anchoUtil - 20) : [];
  const cv = otraMoneda ? (f.contravalor ?? null) : null;
  const definitivo = f.estadoDocumento === 'FINAL';
  const cvConCuota = llevaCuotaIva({ ...f, conIva });
  const filasCv: Array<[string, string, boolean]> = cv
    ? [
        [T.baseImponible, F.importe(cv.base, monedaCuenta), false],
        ...(cvConCuota
          ? ([
              [
                idioma === 'es' && definitivo ? `Cuota de IVA en ${nombreMoneda(monedaCuenta)}` : T.ivaFila,
                F.importe(cv.iva, monedaCuenta),
                definitivo,
              ],
            ] as Array<[string, string, boolean]>)
          : []),
        ...(cv.retencion ? ([[T.retencion(F.pct(tipoRet)), F.importe(-cv.retencion, monedaCuenta), false]] as Array<[string, string, boolean]>) : []),
        [T.total, F.importe(cv.total, monedaCuenta), true],
      ]
    : [];
  // El desglose en la moneda de cuenta, solo si hay cuota (con un unico tipo sin cuota no aporta nada).
  const desgloseCv = cv && cvConCuota ? [...cv.desglose].sort((a, b) => b.tipoIva - a.tipoIva) : [];
  const altoDivisa = otraMoneda
    ? 14 + frase.length * 11 + 8 + (cv ? Math.max(filasCv.length * 14, desgloseCv.length ? 13 + desgloseCv.length * 13 : 0) + 6 : 0) + 22
    : 0;

  // Las observaciones cortas viajan con los totales: no se quedan solas en otra pagina.
  const obs = f.observaciones?.trim() ? partir(f.observaciones.trim(), normal, 9, Math.min(anchoUtil, 400)) : [];
  const altoObsCorta = obs.length && obs.length <= 4 ? 28 + 14 + obs.length * 12 : 0;
  y -= 24;
  asegurar(Math.max(altoTotales, altoDesglose) + altoMencion + altoDivisa + altoObsCorta);

  const xTipo = MARGEN;
  const xBase = MARGEN + 120;
  const xCuota = MARGEN + 200;
  let yi = y;
  if (conIva) {
    etiqueta(p, T.desgloseIva, xTipo, yi);
    yi -= 15;
    texto(p, T.tipo, xTipo, yi, { tam: 8, color: GRIS });
    texto(p, T.base, xBase, yi, { tam: 8, color: GRIS, alinear: 'der' });
    texto(p, T.cuota, xCuota, yi, { tam: 8, color: GRIS, alinear: 'der' });
    yi -= 13;
    for (const [t, v] of tipos) {
      const etq = etiquetaTipo(t);
      texto(p, etq, xTipo, yi, { tam: 8.5, fuente: etq === F.pct(t) ? mono : normal });
      texto(p, F.importe(v.base), xBase, yi, { tam: 8.5, fuente: mono, alinear: 'der' });
      texto(p, F.importe(v.cuota), xCuota, yi, { tam: 8.5, fuente: mono, alinear: 'der' });
      yi -= 13;
    }
    if (hayExentoGenerico) {
      yi -= 3;
      texto(p, T.ivaCeroGenerico, xTipo, yi, { tam: 8, color: GRIS });
      yi -= 13;
    }
  }

  const xEtq = derecha - 200;
  let yt = y + 1;
  for (const [etq, valor] of filasTotales) {
    texto(p, etq, xEtq, yt, { color: GRIS });
    texto(p, valor, derecha, yt, { fuente: mono, alinear: 'der' });
    yt -= 15;
  }
  yt += 4;
  filete(p, yt, xEtq, derecha, 0.75, TINTA);
  yt -= 17;
  texto(p, esProforma ? T.total : f.totalFactura < 0 ? T.totalNegativo : T.totalFactura, xEtq, yt, { tam: 10.5, fuente: negrita });
  texto(p, F.importe(f.totalFactura), derecha, yt, { tam: 10.5, fuente: monoNegrita, alinear: 'der' });
  y = Math.min(yi, yt) - 28;

  // ---------- Mencion del tipo de operacion ----------
  if (mencion) {
    y += 8;
    for (const l of mencionEs) {
      texto(p, l, MARGEN, y, { tam: 8.5 });
      y -= 11;
    }
    for (const l of mencionEn) {
      texto(p, l, MARGEN, y, { tam: 8, color: GRIS });
      y -= 10.5;
    }
    y -= 16;
  }

  // ---------- Divisa: tipo de cambio y contravalor ----------
  if (otraMoneda) {
    const arriba = y + 10;
    const abajo = y + 10 - altoDivisa + 14;
    p.drawRectangle({ x: MARGEN, y: abajo, width: anchoUtil, height: arriba - abajo, color: FONDO_DIVISA });
    const x0 = MARGEN + 10;
    etiqueta(
      p,
      idioma === 'es' ? `Contravalor en ${nombreMoneda(monedaCuenta)}` : `Equivalent in ${nombreMoneda(monedaCuenta, 'en')}`,
      x0,
      y - 4,
    );
    y -= 18;
    for (const l of frase) {
      texto(p, l, x0, y, { tam: 8.5 });
      y -= 11;
    }
    y -= 8;
    if (cv) {
      let yl = y;
      if (desgloseCv.length) {
        texto(p, T.tipo, x0, yl, { tam: 8, color: GRIS });
        texto(p, `${T.base} (${monedaCuenta})`, xBase, yl, { tam: 8, color: GRIS, alinear: 'der' });
        texto(p, `${T.cuota} (${monedaCuenta})`, xCuota + 10, yl, { tam: 8, color: GRIS, alinear: 'der' });
        yl -= 13;
        for (const d of desgloseCv) {
          const etq = etiquetaTipo(d.tipoIva);
          texto(p, etq, x0, yl, { tam: 8.5, fuente: etq === F.pct(d.tipoIva) ? mono : normal });
          texto(p, F.importe(d.base, monedaCuenta), xBase, yl, { tam: 8.5, fuente: mono, alinear: 'der' });
          texto(p, F.importe(d.cuota, monedaCuenta), xCuota + 10, yl, { tam: 8.5, fuente: mono, alinear: 'der' });
          yl -= 13;
        }
      }
      let yr = y;
      for (const [etq, valor, fuerte] of filasCv) {
        texto(p, etq, xEtq, yr, { tam: 8.5, fuente: fuerte ? negrita : normal, color: fuerte ? TINTA : GRIS });
        texto(p, valor, derecha - 10, yr, { tam: 8.5, fuente: fuerte ? monoNegrita : mono, alinear: 'der' });
        yr -= 14;
      }
      y = Math.min(yl, yr) - 6;
    }
    y -= 22;
  }

  // ---------- Observaciones ----------
  if (obs.length) {
    asegurar(14 + Math.min(obs.length, 3) * 12);
    etiqueta(p, T.observaciones, MARGEN, y);
    y -= 14;
    for (const o of obs) {
      if (asegurar(12)) {
        etiqueta(p, `${T.observaciones} (${T.continuacion})`, MARGEN, y);
        y -= 14;
      }
      texto(p, o, MARGEN, y);
      y -= 12;
    }
  }

  // ---------- Pie en todas las paginas ----------
  const pie = `${nombreEmpresa} · ${T.nif} ${nifEmpresa}${esBorrador ? ` · ${T.pieBorrador}` : esProforma ? ` · ${T.piePro}` : ''}`;
  // Datos registrales (obligatorios en las sociedades) encima del pie, en letra pequena.
  const inscripcion = f.emisor?.inscripcion ? partir(f.emisor.inscripcion, normal, 6.5, anchoUtil) : [];
  paginas.forEach((pg, i) => {
    inscripcion.forEach((l, k) => texto(pg, l, MARGEN, PIE_Y + 11 + (inscripcion.length - 1 - k) * 8, { tam: 6.5, color: GRIS }));
    texto(pg, pie, MARGEN, PIE_Y, { tam: 7.5, color: GRIS });
    texto(pg, T.pagina(i + 1, paginas.length), derecha, PIE_Y, { tam: 7.5, color: GRIS, alinear: 'der' });
  });

  return guardarPdfA(doc, tituloDoc);
}

// ---------- Carga desde la BD ----------

/** Cuenta donde se cobra: la primera activa en la moneda de la factura; si no hay, la primera activa. */
export function elegirCuentaCobro<C extends { moneda?: string | null }>(cuentas: C[], moneda: string): C | null {
  return cuentas.find((c) => (c.moneda ?? 'EUR') === moneda) ?? cuentas[0] ?? null;
}

export async function generarPdfFactura(companyId: string, id: string): Promise<{ nombre: string; contenido: Buffer }> {
  const factura = await prisma.incomeInvoice.findFirst({
    where: { id, companyId },
    include: { lineas: true, customer: true },
  });
  if (!factura) throw notFound('Factura no encontrada.');

  const [empresa, original, cuentas, compania] = await Promise.all([
    prisma.legalConfig.findUnique({ where: { companyId } }).catch(() => null),
    factura.facturaOriginalId
      ? prisma.incomeInvoice.findFirst({ where: { id: factura.facturaOriginalId, companyId } })
      : Promise.resolve(null),
    prisma.bankAccount.findMany({ where: { companyId, activa: true }, orderBy: { createdAt: 'asc' } }).catch(() => []),
    prisma.company.findUnique({ where: { id: companyId }, select: { name: true } }).catch(() => null),
  ]);

  const perfil = perfilDesdeConfig(empresa);
  const moneda = factura.moneda || perfil.monedaCuenta;
  const cuenta = elegirCuentaCobro(cuentas, moneda);
  // Totales y lineas en la moneda de la factura (*Doc; null = igual que la de cuenta).
  const doc = importesDoc({
    moneda,
    tipoCambio: Number(factura.tipoCambio ?? 1),
    baseTotal: Number(factura.baseTotal),
    ivaTotal: Number(factura.ivaTotal),
    retencionTotal: Number(factura.retencionTotal),
    totalFactura: Number(factura.totalFactura),
    baseTotalDoc: factura.baseTotalDoc === null ? null : Number(factura.baseTotalDoc),
    ivaTotalDoc: factura.ivaTotalDoc === null ? null : Number(factura.ivaTotalDoc),
    retencionTotalDoc: factura.retencionTotalDoc === null ? null : Number(factura.retencionTotalDoc),
    totalFacturaDoc: factura.totalFacturaDoc === null ? null : Number(factura.totalFacturaDoc),
  });
  const tipoOperacion = esTipoOperacion(factura.tipoOperacion) ? factura.tipoOperacion : null;
  const conIva = facturaConIva(tipoOperacion, perfil.espanola, doc.ivaTotal, factura.lineas.map((l) => Number(l.tipoIva)));
  const otraMoneda = moneda !== perfil.monedaCuenta;
  const conTipo = otraMoneda && factura.fuenteTipoCambio !== 'PENDIENTE' && Number(factura.tipoCambio) > 0;
  const contravalor: ContravalorPdf | null = conTipo
    ? {
        base: Number(factura.baseTotal),
        iva: Number(factura.ivaTotal),
        retencion: Number(factura.retencionTotal),
        total: Number(factura.totalFactura),
        // Los mismos numeros que el libro de IVA.
        desglose: desgloseIvaPorTipo(
          factura.lineas.map((l) => ({ tipoIva: Number(l.tipoIva), baseLine: Number(l.baseLine), ivaImporte: Number(l.ivaImporte) })),
        ),
      }
    : null;

  const c = factura.customer;
  const contenido = await renderizarFactura({
    id: factura.id,
    numeroCompleto: factura.numeroCompleto,
    estadoDocumento: factura.estadoDocumento,
    tipoFactura: factura.tipoFactura,
    formaPago: factura.formaPago,
    tipoRectificativa: factura.tipoRectificativa,
    motivoRectificacion: factura.motivoRectificacion,
    esRectificativa: factura.esRectificativa,
    fechaEmision: factura.fechaEmision,
    fechaVencimiento: factura.fechaVencimiento,
    baseTotal: doc.baseTotal,
    ivaTotal: doc.ivaTotal,
    retencionTotal: doc.retencionTotal,
    totalFactura: doc.totalFactura,
    observaciones: factura.observaciones,
    lineas: factura.lineas.map((l) => ({
      descripcion: l.descripcion,
      cantidad: Number(l.cantidad),
      precioUnitario: Number(l.precioUnitarioDoc ?? l.precioUnitario),
      descuentoPorcentaje: Number(l.descuentoPorcentaje ?? 0),
      tipoIva: Number(l.tipoIva),
      ivaImporte: Number(l.ivaImporteDoc ?? l.ivaImporte),
      baseLine: Number(l.baseLineDoc ?? l.baseLine),
      tipoRetencion: Number(l.tipoRetencion ?? 0),
    })),
    cliente: {
      nombreFiscal: c.nombreFiscal,
      nifCif: c.nifCif,
      direccion: c.direccion,
      cp: c.cp,
      municipio: c.municipio,
      provincia: c.provincia,
      pais: c.pais,
    },
    // Sin denominacion en los datos de la sociedad, al menos el nombre con el que esta dada de alta.
    emisor: empresa || compania
      ? {
          denominacion: empresa?.denominacion?.trim() || compania?.name || null,
          nif: empresa?.nif ?? null,
          domicilioSocial: empresa?.domicilioSocial ?? null,
          codigoPostal: empresa?.codigoPostal ?? null,
          municipio: empresa?.municipio ?? null,
          provincia: empresa?.provincia ?? null,
          telefono: empresa?.telefono ?? null,
          email: empresa?.email ?? null,
          web: empresa?.web ?? null,
          inscripcion: textoInscripcionRegistral(empresa as unknown as Record<string, unknown> | null),
          pais: perfil.pais,
        }
      : null,
    original: original ? { numeroCompleto: original.numeroCompleto, fechaEmision: original.fechaEmision } : null,
    cuenta: cuenta?.iban ? { iban: cuenta.iban, bic: cuenta.bic ?? null } : null,
    logo: empresa?.logo && empresa.logoMime ? { bytes: new Uint8Array(empresa.logo), mime: empresa.logoMime } : null,
    moneda,
    monedaCuenta: perfil.monedaCuenta,
    tipoCambio: Number(factura.tipoCambio ?? 1),
    fechaTipoCambio: factura.fechaTipoCambio,
    fuenteTipoCambio: factura.fuenteTipoCambio,
    fechaOperacion: factura.fechaOperacion,
    contravalor,
    tipoOperacion,
    causaExencion: factura.causaExencion,
    referenciaLegal: factura.referenciaLegal,
    conIva,
  });

  const nombre =
    factura.estadoDocumento === 'PROFORMA'
      ? `proforma_${factura.numeroCompleto}.pdf`
      : factura.estadoDocumento !== 'FINAL'
        ? `borrador_factura_${factura.id.slice(-6)}.pdf`
        : `factura_${factura.numeroCompleto}.pdf`;
  return { nombre: nombre.replace(/[^\w.-]/g, '_'), contenido };
}

/**
 * Datos que faltan para que la factura salga completa (se avisan en pantalla).
 * No bloquean el borrador; el NIF y la denominacion si bloquean la emision.
 *
 * Ademas, en divisa: TIPO_CAMBIO_PROVISIONAL / TIPO_CAMBIO_PENDIENTE (aun sin
 * emitir).
 * En un borrador o una proforma de una empresa espanola, los errores fiscales
 * que impediran emitirla (TIPO_AMBIGUO, CLIENTE_SIN_NIF_IVA...).
 */
export async function avisosFactura(companyId: string, id: string): Promise<string[]> {
  const factura = await prisma.incomeInvoice.findFirst({ where: { id, companyId }, include: { customer: true, lineas: true } });
  if (!factura) throw notFound('Factura no encontrada.');
  const [empresa, cuentas] = await Promise.all([
    prisma.legalConfig.findUnique({
      where: { companyId },
      select: { denominacion: true, nif: true, domicilioSocial: true, logoMime: true, pais: true, monedaCuenta: true },
    }),
    prisma.bankAccount.findMany({ where: { companyId, activa: true }, select: { id: true } }),
  ]);
  const perfil = perfilDesdeConfig(empresa);
  const avisos: string[] = [];
  if (!empresa?.denominacion?.trim()) avisos.push('EMISOR_DENOMINACION');
  if (!empresa?.nif?.trim()) avisos.push('EMISOR_NIF');
  if (!empresa?.domicilioSocial?.trim()) avisos.push('EMISOR_DOMICILIO');
  if (!empresa?.logoMime) avisos.push('EMISOR_LOGO');
  const c = factura.customer;
  if (!c.direccion?.trim() || !(c.cp?.trim() || c.municipio?.trim())) avisos.push('CLIENTE_DIRECCION');
  if (factura.formaPago === 'TRANSFERENCIA' && cuentas.length === 0) avisos.push('CUENTA_BANCARIA');

  const moneda = factura.moneda || perfil.monedaCuenta;
  // Sin aviso de cuenta en la moneda de la factura: las cuentas bancarias van en
  // la moneda de la contabilidad y no se pueden dar de alta en otra (el cliente
  // paga en USD a la cuenta en EUR y el banco convierte).
  if (moneda !== perfil.monedaCuenta) {
    if (factura.estadoDocumento !== 'FINAL') {
      avisos.push(factura.fuenteTipoCambio === 'PENDIENTE' ? 'TIPO_CAMBIO_PENDIENTE' : 'TIPO_CAMBIO_PROVISIONAL');
    }
  }

  if (factura.estadoDocumento !== 'FINAL' && perfil.espanola && !factura.esRectificativa) {
    const r = resolverFiscalidadPura(
      {
        empresaEspanola: true,
        tipoOperacion: factura.tipoOperacion,
        causaExencion: factura.causaExencion,
        referenciaLegal: factura.referenciaLegal,
        tipoFactura: factura.tipoFactura,
        lineas: factura.lineas.map((l) => ({ tipoIva: Number(l.tipoIva), tipoRetencion: Number(l.tipoRetencion ?? 0) })),
        cliente: { pais: c.pais, nifCif: c.nifCif, cp: c.cp },
      },
      'emitir',
    );
    for (const err of r.errores) if (!avisos.includes(err.codigo)) avisos.push(err.codigo);
  }
  return avisos;
}
