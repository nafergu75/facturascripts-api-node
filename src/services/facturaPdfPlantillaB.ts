/**
 * PDF de la plantilla B (ceramica y materiales de construccion), con la
 * disposicion de la factura de muestra NZ013_2026:
 *  - arriba a la izquierda, el recuadro de la empresa (nombre, CIF, direccion,
 *    CP y ciudad, en cursiva) y debajo los recuadros FACTURA: y FECHA:;
 *  - en el centro, el logo de la empresa y debajo el de la marca (opcional);
 *  - arriba a la derecha, el recuadro CLIENTE;
 *  - la franja OBRA: con la obra de la factura;
 *  - la tabla con PALETS, CAJAS, M2, PIEZAS, FORMATO, DESCRIPCION (negrita
 *    cursiva, con el texto adicional debajo), CAL, PESO (Kg), PRECIO € e
 *    IMPORTE €, con las columnas hasta el pie;
 *  - la fila de totales (palets, cajas, m2 y piezas), el PESO NETO y el PESO
 *    BRUTO escritos a mano y el cargo de PALETS DE MADERA TRATADA;
 *  - TOTAL BRUTO, IVA y TOTAL FACTURA, con el sello de la empresa a la
 *    izquierda (opcional) y las observaciones en el recuadro azul;
 *  - FORMA DE PAGO con el IBAN, el banco y el SWIFT, y la inscripcion en el
 *    Registro Mercantil.
 *
 * Puro: dibuja un DatosFacturaPdf (lo carga facturaPdf.service) sin tocar la BD.
 *
 * Medidas en puntos desde ARRIBA (como las da PyMuPDF sobre la muestra); `Y()`
 * las pasa al origen de abajo de pdf-lib. Fuentes Geist (las de la app: Arial
 * no se puede incrustar); la cursiva se imita inclinando el texto.
 *
 * Pie alto (observaciones largas, varios tipos de IVA, texto al pie): en una
 * factura de una pagina sube lo justo para caber entero. Si no cabe, los
 * totales de la tabla, los pesos, el cargo de palets, TOTAL FACTURA y las
 * primeras observaciones (con el sello) van detras de la ultima linea, y el
 * resto de las observaciones («OBSERVACIONES (continuación)»), la forma de
 * pago, el Registro Mercantil y el texto al pie siguen en las paginas
 * siguientes. Nada baja del margen.
 *
 * Varias paginas: con muchas lineas, la tabla sigue en la pagina siguiente con
 * una cabecera breve y la de la tabla; nada pisa «Página n de m».
 */
import { degrees, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from 'pdf-lib';
import { crearDocumentoPdfA, guardarPdfA } from '../utils/pdf-a';
import { paisDelCliente } from '../domain/tipo-operacion.model';
import { esUnidadPrecio, resumenCeramica } from '../domain/ceramica';
import { aCentimos } from '../utils/money';
import { textoRegistroA } from './facturaPdfPlantillaA';
import {
  AVISO_PROFORMA,
  etiquetaNifCliente,
  fraseDivisa,
  iban,
  lineaPoblacion,
  mencionDocumento,
  nifDe,
  nombrePais,
  partir,
  textoRectificacionPdf,
  type DatosFacturaPdf,
  type LineaFacturaPdf,
} from './facturaPdf.service';

// ---------- Colores y medidas de la muestra ----------

const NEGRO = rgb(0, 0, 0);
const BEIGE = rgb(0.933, 0.925, 0.882); // #EEECE1: cabeceras y etiquetas
const BEIGE_OSCURO = rgb(0.867, 0.851, 0.765); // #DDD9C3: OBRA y la fila de totales
const AZUL = rgb(0.773, 0.851, 0.945); // #C5D9F1: observaciones
const GRIS = rgb(0.392, 0.455, 0.545);
const MARCA_AGUA = rgb(0.93, 0.93, 0.93);

const GRUESO = 1.7;
const FINO = 0.8;
/** Bordes del recuadro grande: cara exterior e interior, izquierda y derecha. */
const X_IZQ = 45.7;
const X_IZQ_IN = 47.4;
const X_DER_IN = 561.1;
const X_DER = 562.8;

/** Cara izquierda de las rayas finas de las columnas (cada una de 0,8). */
const COL = { palets: 76.8, cajas: 102.4, m2: 143.5, piezas: 186.8, formato: 228.0, descripcion: 389.0, cal: 403.9, peso: 455.0, precio: 499.8 } as const;
type Columna = 'palets' | 'cajas' | 'm2' | 'piezas' | 'formato' | 'cal' | 'peso' | 'precio' | 'importe';
/** Borde izquierdo y derecho del hueco de cada columna. */
const HUECO: Record<Columna, [number, number]> = {
  palets: [X_IZQ_IN, COL.palets],
  cajas: [COL.palets + FINO, COL.cajas],
  m2: [COL.cajas + FINO, COL.m2],
  piezas: [COL.m2 + FINO, COL.piezas],
  formato: [COL.piezas + FINO, COL.formato],
  cal: [COL.descripcion + FINO, COL.cal],
  peso: [COL.cal + FINO, COL.peso],
  precio: [COL.peso + FINO, COL.precio],
  importe: [COL.precio + FINO, X_DER_IN],
};
/** Borde derecho del texto de cada columna en la muestra. */
const DERECHA: Record<Columna, number> = {
  palets: 75.3,
  cajas: 101.0,
  m2: 142.1,
  piezas: 185.4,
  formato: 226.4,
  cal: 402.6,
  peso: 453.5,
  precio: 495.3,
  importe: 557.5,
};
/** Las del pie (totales y cargo de palets) van un poco mas a la derecha. */
const DERECHA_PIE = 560.1;
/** Borde derecho del texto de cada columna (y el de las cifras del pie), para los tests. */
export const COLUMNAS_B = { ...DERECHA, pie: DERECHA_PIE } as const;
const X_DESC = 229.9;
const ANCHO_DESC = COL.descripcion - X_DESC - 2;

const T_NUM = 8.2;
const T_PALETS = 9.0;
const T_DESC = 7.2;
const T_CAB = 7.2;
const T_ETQ = 10.8;
const T_EMPRESA = 9.0;
const T_CLIENTE = 10.8;
const T_DIRECCION = 10.0;
const T_PIE = 9.0;
const T_OBS = 8.2;
/** Alto de cada fila de texto de la tabla (194,3 -> 205,4 -> 216,6 en la muestra). */
const FILA = 11.15;
/** De lo alto del cuerpo de la tabla a la primera linea base (186,5 -> 194,3). */
const BASE_PRIMERA = 7.8;
/** Alto de cada fila del pie (peso neto, peso bruto, palets de madera). */
const FILA_PIE = 10.8;
/** Alto de cada fila de las observaciones. */
const FILA_OBS = 11.05;

/** Donde empieza el pie en la muestra (la raya de la fila de totales): la tabla llega hasta aqui. */
const PIE_MUESTRA = 609.6;
/** Hasta donde llega lo demas en una factura de una pagina (sin numero de pagina). */
const SUELO_UNA = 828;
/** Con varias paginas: hasta donde llega cualquier cosa (para no pisar «Página n de m»). */
const SUELO_VARIAS = 818;
/** Hasta donde llega la tabla en una pagina que no es la ultima. */
const SUELO_TABLA = 812;
const Y_PAGINA = 830;

/** NIF de una persona fisica (DNI, NIE o K, L, M): «NIF»; el de una sociedad, «CIF», como el emisor de la muestra. */
const etiquetaNifEmisor = (nif: string) => (/^[0-9XYZKLM]/i.test(nif.trim()) ? 'NIF' : 'CIF');

// ---------- Formatos de la muestra ----------

const miles = (entero: string) => entero.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** n con entre `min` y `max` decimales (sin ceros de mas), coma decimal y, si `agrupar`, punto de miles. */
function cifra(n: number, min: number, max: number, agrupar: boolean): string {
  const v = Number(n) || 0;
  let [ent, dec = ''] = Math.abs(v).toFixed(max).split('.');
  dec = dec.replace(/0+$/, '');
  while (dec.length < min) dec += '0';
  const signo = v < 0 && Number(Math.abs(v).toFixed(max)) !== 0 ? '-' : '';
  return `${signo}${agrupar ? miles(ent) : ent}${dec ? `,${dec}` : ''}`;
}

/** Formatos de la plantilla B (en la moneda de la factura: «€» en euros; si no, su codigo). */
export function formatosB(moneda = 'EUR') {
  const sufijo = moneda === 'EUR' ? '€' : moneda;
  return {
    /** Importes: dos decimales y punto de miles (530,00 €). */
    importe: (n: number) => `${cifra(n, 2, 2, true)} ${sufijo}`,
    /** Precio: de 2 a 4 decimales (12,25 €). */
    precio: (n: number) => `${cifra(n, 2, 4, true)} ${sufijo}`,
    /** m2: dos decimales como poco y tres como mucho (5,04; 7,90). */
    m2: (n: number) => cifra(n, 2, 3, true),
    /** Palets, cajas y piezas: enteros (o con hasta 3 decimales si los llevan). */
    unidades: (n: number) => cifra(n, 0, 3, true),
    /** Kg: hasta 3 decimales, sin punto de miles (353), como el peso bruto de la plantilla A. */
    kg: (n: number) => cifra(n, 0, 3, false),
    /** dd/mm/aaaa. */
    fecha: (iso: string) => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso),
    /** 21% como en la muestra (IVA 21%). */
    pct: (n: number) => `${cifra(n, 0, 2, false)}%`,
  };
}

/** Etiqueta del recuadro del numero: FACTURA:, PROFORMA:, RECTIFICATIVA: o SIMPLIFICADA:. */
function etiquetaNumero(f: DatosFacturaPdf): string {
  if (f.estadoDocumento === 'PROFORMA') return 'PROFORMA:';
  if (f.esRectificativa || /^R/.test(f.tipoFactura)) return 'RECTIFICATIVA:';
  if (f.tipoFactura === 'F2') return 'SIMPLIFICADA:';
  return 'FACTURA:';
}

/** Titulo del documento (metadatos y cabecera breve). */
function tituloB(f: DatosFacturaPdf): string {
  if (f.estadoDocumento === 'PROFORMA') return 'Factura proforma';
  if (f.esRectificativa || /^R/.test(f.tipoFactura)) return 'Factura rectificativa';
  if (f.tipoFactura === 'F2') return 'Factura simplificada';
  return 'Factura';
}

/** Una fila de texto de un bloque de linea: la primera lleva las cifras. */
interface FilaB {
  texto: string;
  primera: boolean;
  linea: LineaFacturaPdf;
}

/** Una linea de las observaciones: `negrita` la primera de las observaciones, como en la muestra. */
interface LineaObs {
  texto: string;
  negrita: boolean;
}

/** Dibuja la factura con la plantilla B y devuelve el PDF/A. No toca la BD. */
export async function renderizarFacturaPlantillaB(f: DatosFacturaPdf): Promise<Buffer> {
  const moneda = f.moneda ?? 'EUR';
  const monedaCuenta = f.monedaCuenta ?? 'EUR';
  const F = formatosB(moneda);
  const esProforma = f.estadoDocumento === 'PROFORMA';
  const esBorrador = !esProforma && f.estadoDocumento !== 'FINAL';
  const titulo = tituloB(f);
  const tituloDoc = esBorrador ? `Borrador de ${titulo.toLowerCase()}` : `${titulo} ${f.numeroCompleto ?? ''}`.trim();

  const { doc, normal, negrita, ancho, alto } = await crearDocumentoPdfA(tituloDoc);
  const Y = (top: number) => alto - top;

  type Estilo = { tam?: number; fuente?: PDFFont; color?: RGB; alinear?: 'izq' | 'der' | 'centro'; cursiva?: boolean };
  /** Texto con su linea base a `base` puntos de arriba. */
  const texto = (pg: PDFPage, s: string, x: number, base: number, o: Estilo = {}) => {
    if (!s) return;
    const tam = o.tam ?? T_NUM;
    const fuente = o.fuente ?? normal;
    const w = fuente.widthOfTextAtSize(s, tam);
    const xx = o.alinear === 'der' ? x - w : o.alinear === 'centro' ? x - w / 2 : x;
    pg.drawText(s, { x: xx, y: Y(base), size: tam, font: fuente, color: o.color ?? NEGRO, ...(o.cursiva ? { ySkew: degrees(12) } : {}) });
  };
  /** Tamaño con el que `s` cabe en `anchoMax` (como mucho `tam`). */
  const tamQueCabe = (s: string, fuente: PDFFont, tam: number, anchoMax: number) => {
    let t = tam;
    while (t > 4.5 && fuente.widthOfTextAtSize(s, t) > anchoMax) t -= 0.2;
    return t;
  };
  /** Rectangulo relleno de `top` a `bottom` (puntos desde arriba). */
  const caja = (pg: PDFPage, x1: number, top: number, x2: number, bottom: number, color: RGB) =>
    pg.drawRectangle({ x: x1, y: Y(bottom), width: x2 - x1, height: bottom - top, color });
  const raya = (pg: PDFPage, x1: number, x2: number, top: number, grueso = GRUESO) => caja(pg, x1, top, x2, top + grueso, NEGRO);
  const vertical = (pg: PDFPage, x: number, top: number, bottom: number, grueso = FINO) => caja(pg, x, top, x + grueso, bottom, NEGRO);
  /** Cifra alineada a la derecha de su columna; si no cabe, se achica (nunca pisa la raya). */
  const celda = (pg: PDFPage, s: string, col: Columna, base: number, o: { tam?: number; fuente?: PDFFont; derecha?: number } = {}) => {
    const fuente = o.fuente ?? normal;
    const der = o.derecha ?? DERECHA[col];
    texto(pg, s, der, base, { tam: tamQueCabe(s, fuente, o.tam ?? T_NUM, der - HUECO[col][0] - 1), fuente, alinear: 'der' });
  };
  /** Texto centrado en su columna, achicado si no cabe. */
  const centrado = (pg: PDFPage, s: string, col: Columna, base: number, o: { tam?: number; fuente?: PDFFont } = {}) => {
    const [a, z] = HUECO[col];
    const fuente = o.fuente ?? normal;
    texto(pg, s, (a + z) / 2, base, { tam: tamQueCabe(s, fuente, o.tam ?? T_NUM, z - a - 2), fuente, alinear: 'centro' });
  };
  /** Una imagen (PNG o JPG) dentro de un hueco, centrada y sin deformar; una dañada no se dibuja. */
  const imagen = async (pg: PDFPage, img: { bytes: Uint8Array; mime: string } | null | undefined, x1: number, top: number, x2: number, bottom: number) => {
    if (!img?.bytes?.length) return;
    let im: PDFImage;
    try {
      im = img.mime === 'image/png' ? await doc.embedPng(img.bytes) : await doc.embedJpg(img.bytes);
    } catch {
      return;
    }
    const escala = Math.min((x2 - x1) / im.width, (bottom - top) / im.height);
    const w = im.width * escala;
    const h = im.height * escala;
    pg.drawImage(im, { x: (x1 + x2) / 2 - w / 2, y: Y((top + bottom) / 2 + h / 2), width: w, height: h });
  };

  // ---------- Datos ----------
  const e = f.emisor;
  const nombreEmpresa = e?.denominacion?.trim() || 'Falta la denominación de la empresa';
  const nifEmpresa = nifDe(e?.nif, e?.pais) || '';
  const c = f.cliente;
  const paisCliente = paisDelCliente({ pais: c.pais, nifCif: c.nifCif, cp: c.cp });
  const conIva = f.conIva !== false;
  const tiposIva = [...new Set(f.lineas.map((l) => l.tipoIva))].sort((a, b) => b - a);
  const variosTipos = tiposIva.length > 1;

  // Lineas de la tabla y cargos de palets (en el pie).
  const tabla = f.lineas.filter((l) => !l.cargoPalets);
  const cargos = f.lineas.filter((l) => l.cargoPalets);
  const resumen = resumenCeramica(f.lineas.map((l) => ({ ...l, unidadPrecio: esUnidadPrecio(l.unidadPrecio) ? l.unidadPrecio : null, baseLine: l.baseLine })));
  const fuenteDesc = negrita;
  const bloques: FilaB[][] = tabla.map((l) => {
    const concepto = variosTipos && conIva ? `${l.descripcion} (IVA ${F.pct(l.tipoIva)})` : l.descripcion;
    const filas: FilaB[] = partir(concepto, fuenteDesc, T_DESC, ANCHO_DESC).map((t, i) => ({ texto: t, primera: i === 0, linea: l }));
    for (const t of l.textoAdicional?.trim() ? partir(l.textoAdicional.trim(), fuenteDesc, T_DESC, ANCHO_DESC) : []) filas.push({ texto: t, primera: false, linea: l });
    return filas;
  });

  // Totales: TOTAL BRUTO e IVA del tipo; con varios tipos, la base y el IVA de cada uno (art. 6.1 RD 1619/2012).
  const porTipo = new Map<number, { base: number; cuota: number }>();
  for (const l of f.lineas) {
    const t = porTipo.get(l.tipoIva) ?? { base: 0, cuota: 0 };
    t.base += aCentimos(l.baseLine);
    t.cuota += aCentimos(l.ivaImporte);
    porTipo.set(l.tipoIva, t);
  }
  /** La etiqueta con puntos hasta X_PUNTOS, como «TOTAL BRUTO.......» de la muestra. */
  const X_PUNTOS = 372;
  const conPuntos = (etq: string) => {
    let s = etq;
    while (normal.widthOfTextAtSize(`${s}.`, T_PIE) <= X_PUNTOS - 230.2 && s.length < etq.length + 80) s += '.';
    return s;
  };
  const filasTotales: Array<[string, string]> = [];
  filasTotales.push([conPuntos('    TOTAL BRUTO'), F.importe(f.baseTotal)]);
  if (conIva && porTipo.size <= 1) filasTotales.push([conPuntos(`     IVA ${F.pct(tiposIva[0] ?? 21)} `), F.importe(f.ivaTotal)]);
  if (conIva && porTipo.size > 1) {
    for (const t of tiposIva) {
      const v = porTipo.get(t)!;
      filasTotales.push([conPuntos(`     BASE ${F.pct(t)} `), F.importe(v.base / 100)], [conPuntos(`     IVA ${F.pct(t)} `), F.importe(v.cuota / 100)]);
    }
  }
  const tipoRet = f.lineas.find((l) => l.tipoRetencion)?.tipoRetencion ?? 0;
  if (aCentimos(f.retencionTotal) !== 0) filasTotales.push([conPuntos(`     RETENCIÓN IRPF ${F.pct(tipoRet)} `), F.importe(-f.retencionTotal)]);

  // Observaciones: lo que la factura tiene que decir (rectificativa, proforma,
  // mencion legal, fecha de la operacion, divisa) y despues las observaciones,
  // con su primera linea en negrita como en la muestra.
  const anchoObs = X_DER_IN - 230.0 - 3;
  const mencion = mencionDocumento({ ...f, conIva });
  const otraMoneda = moneda !== monedaCuenta;
  const cv = otraMoneda ? f.contravalor : null;
  const previos = [
    esProforma ? AVISO_PROFORMA : null,
    ...(f.esRectificativa ? textoRectificacionPdf(f, 'es') : []),
    f.fechaOperacion && f.fechaOperacion !== f.fechaEmision ? `Fecha de la operación: ${F.fecha(f.fechaOperacion)}.` : null,
    mencion?.es,
    mencion?.en,
    otraMoneda ? fraseDivisa({ ...f, conIva }, 'es') : null,
    cv ? `Contravalor en ${monedaCuenta}: base ${cifra(cv.base, 2, 2, true)}, IVA ${cifra(cv.iva, 2, 2, true)} y total ${cifra(cv.total, 2, 2, true)} ${monedaCuenta}.` : null,
  ].filter((s): s is string => !!s);
  const obs: LineaObs[] = previos.flatMap((t) => partir(t, normal, T_OBS, anchoObs).map((l) => ({ texto: l, negrita: false })));
  // La rectificativa hecha con «Rectificar» lleva en las observaciones «Rectifica la factura X de
  // AAAA-MM-DD. Motivo: …», que ya dice el texto de la rectificacion de arriba: no se repite.
  const obsAutomaticas =
    f.esRectificativa && f.original?.numeroCompleto
      ? `Rectifica la factura ${f.original.numeroCompleto} de ${f.original.fechaEmision}. Motivo: ${f.motivoRectificacion?.trim() ?? ''}`
      : null;
  const observaciones = f.observaciones?.trim() ?? '';
  if (observaciones && observaciones !== obsAutomaticas) {
    partir(observaciones, negrita, T_OBS, anchoObs).forEach((l, i) => obs.push({ texto: l, negrita: i === 0 }));
  }

  // Forma de pago.
  const conCuenta = f.formaPago === 'TRANSFERENCIA' && !!f.cuenta?.iban;
  const FORMA: Record<string, string> = { TRANSFERENCIA: 'TRANSFERENCIA BANCARIA', GIRO: 'RECIBO DOMICILIADO', CONTADO: 'CONTADO' };
  const pago1: Array<[string, PDFFont]> = conCuenta ? [[`${FORMA.TRANSFERENCIA}: `, normal], [iban(f.cuenta!.iban), negrita]] : [[FORMA[f.formaPago] ?? f.formaPago, normal]];
  const banco = conCuenta ? [f.cuenta!.bancoNombre?.trim().toUpperCase(), f.cuenta!.bic?.trim().toUpperCase()].filter(Boolean).join(': ') : '';
  const registro = textoRegistroA(e, nifEmpresa);
  const lineasRegistro = registro ? partir(registro, normal, T_NUM, X_DER - 48.2) : [];
  const lineasPie = f.textoPie?.trim() ? partir(f.textoPie.trim(), normal, 6.5, X_DER - 48.2) : [];

  // ---------- Alturas del pie (desde la raya de la fila de totales) ----------
  /** Filas bajo los totales de palets, cajas...: peso neto, peso bruto y un cargo de palets por fila (3 como poco). */
  const filasResumen = Math.max(3, 2 + cargos.length);
  const altoResumen = GRUESO + 10.1 + GRUESO + filasResumen * FILA_PIE; // 609,6 -> 655,4
  const altoTotales = GRUESO + (filasTotales.length - 1) * 10.9 + 10.4 + 1.6 + 10.1; // 655,4 -> 690,1
  /** El recuadro azul con `n` filas de observaciones (3 como poco: es tambien el hueco del sello). */
  const altoObsDe = (n: number) => GRUESO + Math.max(3, n) * FILA_OBS - 0.8; // 690,1 -> 724,2
  const altoPago = GRUESO + 23.1 + GRUESO; // 724,2 -> 750,7
  const altoTras = (lineasRegistro.length ? 7.8 + (lineasRegistro.length - 1) * 10 : 0) + (lineasPie.length ? (lineasRegistro.length ? 9 : 7.8) + (lineasPie.length - 1) * 8 : 0) + 3;
  /** El pie entero, con todas las observaciones en su recuadro. */
  const altoPie = altoResumen + altoTotales + altoObsDe(obs.length) + altoPago + altoTras;
  /**
   * Lo que va siempre con la ultima linea: los totales de la tabla, los pesos,
   * el cargo de palets, TOTAL FACTURA y el recuadro azul con sus primeras filas
   * (y el sello). Lo demas puede seguir en otra pagina.
   */
  const altoCabeza = altoResumen + altoTotales + altoObsDe(Math.min(obs.length, 3)) + GRUESO;

  // ---------- Paginas ----------
  const paginas: PDFPage[] = [];
  const nuevaPagina = (): PDFPage => {
    const pg = doc.addPage([ancho, alto]);
    paginas.push(pg);
    if (esBorrador) {
      const marca = 'BORRADOR';
      const tam = 100;
      const w = negrita.widthOfTextAtSize(marca, tam);
      const a = (35 * Math.PI) / 180;
      pg.drawText(marca, {
        x: ancho / 2 - (w / 2) * Math.cos(a) + tam * 0.35 * Math.sin(a),
        y: alto / 2 - (w / 2) * Math.sin(a) - tam * 0.35 * Math.cos(a),
        size: tam,
        font: negrita,
        color: MARCA_AGUA,
        rotate: degrees(35),
      });
    }
    return pg;
  };
  let p = nuevaPagina();

  // ---------- Recuadro de la empresa (centrado y en cursiva) ----------
  {
    caja(p, 47.0, 29.3, 187.3, 43.3, BEIGE);
    raya(p, X_IZQ_IN, 188.0, 28.3, 1.3);
    raya(p, X_IZQ_IN, 188.0, 42.4);
    raya(p, X_IZQ_IN, 188.0, 81.6);
    vertical(p, X_IZQ, 28.3, 83.3, GRUESO);
    vertical(p, 186.4, 29.6, 83.3, GRUESO);
    const cx = (X_IZQ_IN + 186.4) / 2;
    const anchoCaja = 186.4 - X_IZQ_IN - 6;
    const filas: Array<[string, PDFFont, number]> = [
      [nombreEmpresa, negrita, 39.1],
      [nifEmpresa ? `${etiquetaNifEmisor(nifEmpresa)}: ${nifEmpresa}` : '', negrita, 53.8],
      [e?.domicilioSocial?.trim() ?? '', normal, 66.8],
      [lineaPoblacion(e?.codigoPostal, e?.municipio, e?.provincia, e?.pais), normal, 79.1],
    ];
    for (const [s, fuente, base] of filas) texto(p, s, cx, base, { tam: tamQueCabe(s, fuente, T_EMPRESA, anchoCaja), fuente, alinear: 'centro', cursiva: true });
  }

  // ---------- FACTURA: y FECHA: ----------
  {
    caja(p, 47.0, 94.9, 144.0, 109.4, BEIGE);
    caja(p, 47.0, 123.0, 144.0, 137.5, BEIGE);
    for (const top of [94.1, 108.5, 122.2, 136.6, 148.3]) raya(p, X_IZQ_IN, 144.7, top);
    vertical(p, X_IZQ, 94.1, 150.0, GRUESO);
    vertical(p, 143.0, 95.8, 150.0, GRUESO);
    const etq = etiquetaNumero(f);
    texto(p, etq, 48.6, 105.2, { tam: tamQueCabe(etq, negrita, T_ETQ, 143.0 - 48.6 - 2), fuente: negrita });
    const numero = esBorrador ? 'Borrador (sin número)' : (f.numeroCompleto ?? '');
    texto(p, numero, 79.0, 119.6, { tam: tamQueCabe(numero, normal, T_PIE, 143.0 - 79.0 - 2) });
    texto(p, 'FECHA:', 48.6, 133.3, { tam: T_ETQ, fuente: negrita });
    texto(p, F.fecha(f.fechaEmision), 79.0, 145.8, { tam: T_PIE });
  }

  // ---------- Logos: el de la empresa y, debajo, el de la marca ----------
  await imagen(p, f.logo, 210.2, 30.4, 308.2, 85.2);
  await imagen(p, f.logoMarca, 206.6, 88.0, 318.1, 145.6);

  // ---------- CLIENTE ----------
  {
    caja(p, 325.6, 29.3, 562.1, 43.3, BEIGE);
    raya(p, 326.4, X_DER, 28.3, 1.3);
    raya(p, 326.4, X_DER, 42.4);
    raya(p, 326.4, X_DER, 148.3);
    vertical(p, 324.7, 28.3, 150.0, GRUESO);
    // El borde derecho del CLIENTE sigue hasta la tabla (el de la tabla sigue hasta el pie).
    vertical(p, X_DER_IN, 29.6, 156.1, GRUESO);
    const cx = (326.4 + X_DER_IN) / 2;
    const anchoCli = X_DER_IN - 326.4 - 8;
    texto(p, 'CLIENTE', cx, 39.1, { tam: T_ETQ, fuente: negrita, alinear: 'centro' });
    const nifCliente = nifDe(c.nifCif, paisCliente);
    const etqNif = paisCliente === 'ES' ? 'NIF' : etiquetaNifCliente(c, 'es');
    const datos: Array<[string, PDFFont, number, boolean]> = [];
    for (const l of partir(c.nombreFiscal, negrita, T_CLIENTE, anchoCli)) datos.push([l, negrita, T_CLIENTE, true]);
    if (nifCliente) datos.push([`${etqNif}: ${nifCliente}`, normal, T_CLIENTE, false]);
    const prov = c.provincia?.trim();
    const poblacion =
      paisCliente === 'ES'
        ? [[c.cp?.trim(), c.municipio?.trim()].filter(Boolean).join(' '), prov && prov.toUpperCase() !== c.municipio?.trim().toUpperCase() ? `(${prov})` : ''].filter(Boolean).join(' - ')
        : lineaPoblacion(c.cp, c.municipio, c.provincia, paisCliente);
    const resto = [c.direccion?.trim(), poblacion, paisCliente !== 'ES' && c.pais ? nombrePais(c.pais, 'es').toUpperCase() : null];
    for (const r of resto.filter((s): s is string => !!s)) for (const l of partir(r, normal, T_DIRECCION, anchoCli)) datos.push([l, normal, T_DIRECCION, false]);
    // Las lineas de la muestra van de 12,5 a 13,6 puntos; si no caben, mas juntas.
    const paso = Math.min(12.9, datos.length > 1 ? (146 - 53.5) / (datos.length - 1) : 12.9);
    datos.forEach(([s, fuente, tam, cursiva], i) => texto(p, s, cx, 53.5 + i * paso, { tam: tamQueCabe(s, fuente, tam, anchoCli), fuente, alinear: 'centro', cursiva }));
  }

  // ---------- OBRA y cabecera de la tabla ----------
  /** Lo alto del recuadro de la tabla en la pagina actual (para sus laterales). */
  let topTabla = 156.1;
  /** Dibuja la cabecera de las columnas con su fondo; devuelve donde empieza el cuerpo. */
  const cabeceraColumnas = (top: number) => {
    caja(p, 47.0, top + 0.9, 562.1, top + 14.7, BEIGE);
    raya(p, X_IZQ_IN, X_DER, top);
    raya(p, X_IZQ_IN, X_DER, top + 13.7);
    const b = top + 11.2;
    // En la fila de la cabecera no hay rayas de columna: el texto puede pasar un poco de su hueco (CAL, en la muestra).
    const encabezado = (s: string, col: Columna) => {
      const [a, z] = HUECO[col];
      texto(p, s, (a + z) / 2, b, { tam: tamQueCabe(s, negrita, T_CAB, z - a + 6), fuente: negrita, alinear: 'centro' });
    };
    texto(p, 'PALETS', 48.2, b, { tam: tamQueCabe('PALETS', negrita, T_CAB, COL.palets - 48.2 + 1), fuente: negrita });
    encabezado('CAJAS', 'cajas');
    encabezado('M2', 'm2');
    encabezado('PIEZAS', 'piezas');
    encabezado('FORMATO', 'formato');
    texto(p, 'DESCRIPCION', X_DESC, b, { tam: T_CAB, fuente: negrita });
    encabezado('CAL', 'cal');
    encabezado('PESO (Kg)', 'peso');
    encabezado(`PRECIO ${moneda === 'EUR' ? '€' : moneda}`, 'precio');
    encabezado(`IMPORTE ${moneda === 'EUR' ? '€' : moneda}`, 'importe');
    return top + 15.4;
  };
  /** Rayas de las columnas del cuerpo de la tabla, de `desde` a `hasta`. */
  const columnas = (desde: number, hasta: number) => {
    if (hasta <= desde) return;
    for (const x of Object.values(COL)) vertical(p, x, desde, hasta);
  };
  // Primera pagina: OBRA y la cabecera de las columnas.
  caja(p, 47.0, 157.0, 562.1, 172.1, BEIGE_OSCURO);
  raya(p, X_IZQ_IN, X_DER, 156.1);
  raya(p, X_IZQ_IN, X_DER, 171.1);
  texto(p, 'OBRA:', 49.3, 170.3, { tam: 16.2, fuente: negrita });
  if (f.obra?.trim()) {
    const xObra = 49.3 + negrita.widthOfTextAtSize('OBRA:', 16.2) + 8;
    const o = f.obra.trim();
    texto(p, o, xObra, 168.6, { tam: tamQueCabe(o, negrita, 11, X_DER_IN - xObra - 4), fuente: negrita });
  }
  let cuerpo = cabeceraColumnas(171.1);
  let y = cuerpo;

  /** Cierra la tabla de una pagina que no es la ultima: columnas, laterales y raya de abajo. */
  const cerrarTabla = (fondo: number) => {
    columnas(cuerpo, fondo);
    vertical(p, X_IZQ, topTabla, fondo + GRUESO, GRUESO);
    vertical(p, X_DER_IN, topTabla, fondo + GRUESO, GRUESO);
    raya(p, X_IZQ_IN, X_DER, fondo);
  };
  /** Pagina siguiente con una cabecera breve; devuelve donde empieza lo demas. */
  const cabeceraBreve = () => {
    p = nuevaPagina();
    texto(p, nombreEmpresa, X_IZQ_IN, 32, { tam: T_ETQ, fuente: negrita });
    texto(p, `${esBorrador ? 'Borrador de factura' : `${titulo} ${f.numeroCompleto ?? ''}`.trim()} (continuación)`, X_DER, 32, { alinear: 'der', tam: T_NUM });
    texto(p, `CLIENTE: ${c.nombreFiscal}`, X_IZQ_IN, 45, { tam: T_NUM });
    return 56;
  };
  /** Pagina siguiente con la cabecera breve y la de las columnas. */
  const continuar = () => {
    const top = cabeceraBreve();
    topTabla = top;
    cuerpo = cabeceraColumnas(top);
    return cuerpo;
  };

  const dibujarFila = (fila: FilaB, top: number) => {
    const b = top + BASE_PRIMERA;
    texto(p, fila.texto, X_DESC, b, { tam: T_DESC, fuente: fuenteDesc, cursiva: true });
    if (!fila.primera) return;
    const l = fila.linea;
    if (l.palets !== null && l.palets !== undefined) celda(p, F.unidades(l.palets), 'palets', b, { tam: T_PALETS });
    if (l.cajas !== null && l.cajas !== undefined) celda(p, F.unidades(l.cajas), 'cajas', b);
    if (l.metros2 !== null && l.metros2 !== undefined) celda(p, F.m2(l.metros2), 'm2', b);
    // Por unidad, la cantidad sale en la columna de piezas (si la linea no las trae).
    const piezas = l.piezas ?? (l.unidadPrecio === 'UNIDAD' || !l.unidadPrecio ? l.cantidad : null);
    if (piezas !== null && piezas !== undefined) celda(p, F.unidades(piezas), 'piezas', b);
    if (l.formato) centrado(p, l.formato, 'formato', b);
    if (l.calidad) celda(p, l.calidad, 'cal', b);
    if (l.pesoKg !== null && l.pesoKg !== undefined) celda(p, F.kg(l.pesoKg), 'peso', b);
    celda(p, F.precio(l.precioUnitario), 'precio', b);
    celda(p, F.importe(l.baseLine), 'importe', b);
  };

  /** La pagina actual aun no tiene filas (acaba de empezar la tabla). */
  const sinFilas = () => Math.abs(y - cuerpo) < 0.01;
  /** El pie entero cabe tras una tabla que acaba en `fin` (en una pagina sola, hasta SUELO_UNA). */
  const cabePie = (fin: number) => fin + 4 + altoPie <= (paginas.length === 1 ? SUELO_UNA : SUELO_VARIAS);
  /** Al menos la cabeza del pie cabe tras `fin` (lo demas seguira en otra pagina, asi que hasta SUELO_VARIAS). */
  const cabeCabeza = (fin: number) => fin + 4 + altoCabeza <= SUELO_VARIAS;
  bloques.forEach((filas) => {
    // El bloque entero va en la pagina siguiente si aqui no cabe (el pie, si no cabe detras del ultimo, va aparte).
    const fin = y + filas.length * FILA;
    if (fin > SUELO_TABLA && !sinFilas()) {
      cerrarTabla(y + 1);
      y = continuar();
    }
    for (const fila of filas) {
      // Un bloque mas alto que una pagina entera se parte por filas.
      if (y + FILA > SUELO_TABLA) {
        cerrarTabla(y + 1);
        y = continuar();
      }
      dibujarFila(fila, y);
      y += FILA;
    }
  });
  // Sin sitio ni para la cabeza del pie: la tabla se cierra aqui y el pie va en la pagina siguiente, bajo la cabecera de las columnas.
  if (!cabePie(y) && !cabeCabeza(y)) {
    cerrarTabla(y + 1);
    y = continuar();
  }
  /** Todo el pie va detras de la ultima linea, en esta pagina; si no, lo que no quepa sigue en las siguientes. */
  const entero = cabePie(y);
  /**
   * Hasta donde llega lo demas: una factura de una pagina baja hasta SUELO_UNA;
   * con varias, nada pisa «Página n de m». Con 0,01 de holgura: el redondeo de
   * las sumas no manda a otra pagina lo que cabe justo.
   */
  const suelo = (entero && paginas.length === 1 ? SUELO_UNA : SUELO_VARIAS) + 0.01;

  // ---------- Pie: totales de la tabla, pesos, cargo de palets, totales, observaciones y forma de pago ----------
  // Como en la muestra, las columnas llegan hasta el pie (609,6) si sobra sitio;
  // si el pie es mas alto, este sube lo justo para caber entero (nunca por
  // encima de la ultima linea); con varias paginas, justo detras de la ultima
  // linea. Primero los fondos y despues las rayas y los textos (asi ningun
  // fondo tapa media raya).
  const T = entero && paginas.length === 1 ? Math.max(y + 4, Math.min(PIE_MUESTRA, SUELO_UNA - altoPie)) : y + 4;
  const S0 = T + 11.8 + GRUESO; // 623,0: filas de los pesos y el cargo de palets
  const E = S0 + filasResumen * FILA_PIE; // 655,4
  const E2 = E + GRUESO; // 657,1: TOTAL BRUTO
  const sepTotal = E2 + (filasTotales.length - 1) * 10.9 + 10.4; // 678,4
  const finTotal = sepTotal + 1.6 + 10.1; // 690,1
  const O = finTotal + GRUESO; // 691,8: observaciones
  // Las observaciones que caben en el recuadro azul (todas si el pie va entero; las 3 primeras como poco).
  let enRecuadro = obs.length;
  if (!entero) while (enRecuadro > Math.min(obs.length, 3) && finTotal + altoObsDe(enRecuadro) + GRUESO > suelo) enRecuadro--;
  const finObs = finTotal + altoObsDe(enRecuadro); // 724,2

  // Fondos.
  caja(p, 47.0, T + 0.8, 562.1, T + 12.7, BEIGE_OSCURO);
  caja(p, 228.4, E2 - 0.8, 500.3, finTotal + 1.0, BEIGE);
  caja(p, 228.4, O - 0.8, 562.1, finObs + 1.0, AZUL);

  // Rayas: las columnas del cuerpo y del pie, y las horizontales.
  columnas(cuerpo, T);
  columnas(T + GRUESO, T + 11.8);
  columnas(S0, E);
  for (const top of [T, T + 11.8, E, finObs]) raya(p, X_IZQ_IN, X_DER, top);
  filasTotales.forEach((_, i) => {
    if (i < filasTotales.length - 1) raya(p, 229.2, X_DER_IN, E2 + i * 10.9 + 10.0, FINO);
  });
  raya(p, 227.5, X_DER_IN, sepTotal, 1.6);
  raya(p, 229.2, X_DER, finTotal);
  vertical(p, 499.8, E2, sepTotal);
  vertical(p, 499.3, sepTotal + 1.6, finTotal, GRUESO);
  vertical(p, 227.5, E2, finObs, GRUESO);
  // Laterales del recuadro grande, desde la tabla hasta el recuadro azul (la forma de pago pone los suyos).
  vertical(p, X_IZQ, topTabla, finObs + GRUESO, GRUESO);
  vertical(p, X_DER_IN, topTabla, finObs + GRUESO, GRUESO);

  // Cabecera de la fila de totales.
  const bCab = T + 9.2;
  texto(p, 'PALETS', 47.9, bCab, { tam: tamQueCabe('PALETS', negrita, T_NUM, COL.palets - 47.9 - 0.5), fuente: negrita });
  centrado(p, 'CAJAS', 'cajas', bCab, { tam: T_NUM, fuente: negrita });
  centrado(p, 'M2', 'm2', bCab, { tam: T_NUM, fuente: negrita });
  centrado(p, 'PIEZAS', 'piezas', bCab, { tam: T_NUM, fuente: negrita });
  centrado(p, 'PESO (Kg)', 'peso', bCab, { tam: T_CAB, fuente: negrita });

  // Totales de palets, cajas, m2 y piezas (los suma la app), pesos a mano y cargo de palets.
  const baseResumen = (k: number) => S0 + 7.8 + k * FILA_PIE;
  celda(p, F.unidades(resumen.palets), 'palets', baseResumen(0), { tam: T_PALETS });
  celda(p, F.unidades(resumen.cajas), 'cajas', baseResumen(0));
  celda(p, F.m2(resumen.metros2), 'm2', baseResumen(0));
  celda(p, F.unidades(resumen.piezas), 'piezas', baseResumen(0));
  const etqDer = COL.descripcion - 1.4;
  texto(p, 'PESO NETO (kg)', etqDer, baseResumen(0), { tam: T_PIE, alinear: 'der' });
  texto(p, 'PESO BRUTO (kg)', etqDer, baseResumen(1), { tam: T_PIE, alinear: 'der' });
  if (f.pesoNetoKg !== null && f.pesoNetoKg !== undefined) celda(p, F.kg(f.pesoNetoKg), 'peso', baseResumen(0), { tam: T_PIE });
  if (f.pesoBrutoKg !== null && f.pesoBrutoKg !== undefined) celda(p, F.kg(f.pesoBrutoKg), 'peso', baseResumen(1), { tam: T_PIE });
  cargos.forEach((l, i) => {
    const b = baseResumen(2 + i);
    const d = variosTipos && conIva ? `${l.descripcion} (IVA ${F.pct(l.tipoIva)})` : l.descripcion;
    texto(p, d, etqDer, b, { tam: tamQueCabe(d, normal, T_NUM, etqDer - COL.formato - 4), alinear: 'der' });
    celda(p, F.unidades(l.cantidad), 'peso', b, { tam: T_PIE, derecha: DERECHA.peso + 0.1 });
    celda(p, F.precio(l.precioUnitario), 'precio', b, { tam: T_PIE });
    celda(p, F.importe(l.baseLine), 'importe', b, { tam: T_PIE, derecha: DERECHA_PIE });
  });

  // TOTAL BRUTO, IVA y TOTAL FACTURA.
  filasTotales.forEach(([etq, valor], i) => {
    const b = E2 + i * 10.9 + 7.8;
    texto(p, etq, 230.2, b, { tam: tamQueCabe(etq, normal, T_PIE, COL.precio - 230.2 - 2) });
    texto(p, valor, DERECHA_PIE, b, { tam: tamQueCabe(valor, normal, T_PIE, DERECHA_PIE - COL.precio - 2), alinear: 'der' });
  });
  const bTotal = sepTotal + 1.6 + 7.6;
  texto(p, 'TOTAL FACTURA:', 498.4, bTotal, { tam: T_PIE, fuente: negrita, alinear: 'der' });
  const totalTxt = F.importe(f.totalFactura);
  texto(p, totalTxt, DERECHA_PIE, bTotal, { tam: tamQueCabe(totalTxt, negrita, T_PIE, DERECHA_PIE - COL.precio - 2), fuente: negrita, alinear: 'der' });

  /** Una linea de las observaciones, en cursiva (la primera de las observaciones, en negrita). */
  const lineaObs = (l: LineaObs, base: number) => texto(p, l.texto, 230.0, base, { tam: T_OBS, fuente: l.negrita ? negrita : normal, cursiva: true });
  obs.slice(0, enRecuadro).forEach((l, i) => lineaObs(l, O + 7.8 + i * FILA_OBS));
  // El sello, en el hueco de la izquierda (70,9-216,4 por 53 de alto en la muestra).
  await imagen(p, f.sello, 70.9, E2 + 0.3, 216.4, Math.min(E2 + 53.5, finObs - 1));

  // ---------- Observaciones que no caben: «OBSERVACIONES (continuación)» en las paginas siguientes ----------
  /** Recuadro con su raya de arriba en `top` y las lineas `trozo`; devuelve su fondo (la raya de abajo). */
  const recuadroContinuacion = (top: number, trozo: LineaObs[]) => {
    const Oc = top + GRUESO;
    const fin = Oc + Math.max(1, trozo.length) * FILA_OBS - 0.8;
    caja(p, 47.0, Oc - 0.8, 227.5, fin + 1.0, BEIGE);
    caja(p, 228.4, Oc - 0.8, 562.1, fin + 1.0, AZUL);
    raya(p, X_IZQ_IN, X_DER, top);
    raya(p, X_IZQ_IN, X_DER, fin);
    vertical(p, X_IZQ, top, fin + GRUESO, GRUESO);
    vertical(p, 227.5, top, fin + GRUESO, GRUESO);
    vertical(p, X_DER_IN, top, fin + GRUESO, GRUESO);
    const etq = 'OBSERVACIONES (continuación)';
    texto(p, etq, 48.4, Oc + 7.8, { tam: tamQueCabe(etq, negrita, T_PIE, 227.5 - 48.4 - 3), fuente: negrita });
    trozo.forEach((l, i) => lineaObs(l, Oc + 7.8 + i * FILA_OBS));
    return fin;
  };
  /** Donde acaba lo ultimo dibujado del recuadro grande (la raya de abajo de las observaciones). */
  let fondo = finObs;
  for (let hechas = enRecuadro; hechas < obs.length; ) {
    const top = cabeceraBreve();
    let n = obs.length - hechas;
    while (n > 1 && top + GRUESO + n * FILA_OBS - 0.8 + GRUESO > suelo) n--;
    fondo = recuadroContinuacion(top, obs.slice(hechas, hechas + n));
    hechas += n;
  }

  // ---------- FORMA DE PAGO: detras de las observaciones o, si no cabe, en la pagina siguiente ----------
  const topPago = fondo + altoPago <= suelo ? fondo : cabeceraBreve();
  const P = topPago + GRUESO; // 725,9
  const finPago = P + 23.1 + GRUESO; // 750,7
  caja(p, 47.0, P - 0.9, 144.0, P + 24.1, BEIGE);
  raya(p, X_IZQ_IN, X_DER, topPago);
  raya(p, X_IZQ_IN, X_DER, P + 23.1);
  vertical(p, 143.0, P, P + 23.1, GRUESO);
  vertical(p, X_IZQ, topPago, finPago, GRUESO);
  vertical(p, X_DER_IN, topPago, finPago, GRUESO);
  texto(p, 'FORMA DE PAGO', 48.4, P + 9.0, { tam: T_PIE, fuente: negrita });
  {
    let x = 145.8;
    for (const [s, fuente] of pago1) {
      const t = tamQueCabe(pago1.map(([z]) => z).join(''), negrita, T_DIRECCION, X_DER_IN - 145.8 - 3);
      texto(p, s, x, P + 8.4, { tam: t, fuente });
      x += fuente.widthOfTextAtSize(s, t);
    }
    if (banco) texto(p, banco, 145.7, P + 20.6, { tam: tamQueCabe(banco, normal, T_PIE, X_DER_IN - 145.7 - 3) });
  }

  // ---------- Registro Mercantil y texto al pie (siguen en otra pagina si no caben) ----------
  let yPie = finPago + 7.8;
  const lineaPie = (s: string, salto: number, o: Estilo) => {
    if (yPie + 3 > suelo) yPie = cabeceraBreve() + 8;
    texto(p, s, 48.2, yPie, o);
    yPie += salto;
  };
  for (const l of lineasRegistro) lineaPie(l, 10, { tam: T_NUM });
  if (lineasPie.length && lineasRegistro.length) yPie -= 1;
  for (const l of lineasPie) lineaPie(l, 8, { tam: 6.5, color: GRIS });

  // ---------- Numero de pagina (con mas de una) ----------
  if (paginas.length > 1) paginas.forEach((pg, i) => texto(pg, `Página ${i + 1} de ${paginas.length}`, X_DER, Y_PAGINA, { tam: 7.5, color: GRIS, alinear: 'der' }));

  return guardarPdfA(doc, tituloDoc);
}
