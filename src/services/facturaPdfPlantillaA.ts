/**
 * PDF de la plantilla A (envases e IEEPNR), con la disposicion de la factura de
 * muestra NZ004_26: recuadro de la empresa arriba a la izquierda (centrado y en
 * cursiva), «FACTURA», recuadro con el numero y la fecha, recuadro CLIENTE,
 * tabla con CONCEPTO, KG.Plast, PACKS, UDS, IEEPNR, PRECIO/UDS y TOTAL (cada
 * articulo en un bloque: su fila, su texto adicional y la fila «KG Plástico»),
 * resumen con el peso bruto y los totales de envases, Subtotal, I.V.A. y Total
 * en recuadro, DATOS BANCARIOS y OBSERVACIONES, y la inscripcion registral.
 *
 * Puro: dibuja un DatosFacturaPdf (lo carga facturaPdf.service) sin tocar la BD.
 *
 * Medidas en puntos desde ARRIBA (como las da PyMuPDF sobre la muestra); `Y()`
 * las pasa al origen de abajo de pdf-lib. Fuentes Geist (las de la app: Arial
 * no se puede incrustar); la cursiva del recuadro de la empresa se imita
 * inclinando el texto.
 *
 * Varias paginas: la cabecera breve y la de la tabla se repiten; el resumen y
 * los totales van detras del ultimo articulo, en su misma pagina. Si el resto
 * (DATOS BANCARIOS, OBSERVACIONES, registro y texto al pie) no cabe ni con los
 * huecos apretados, sigue en otra pagina: las observaciones largas se parten
 * en varios recuadros y nada pasa del margen de abajo ni pisa «Página n de m».
 */
import { degrees, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import { crearDocumentoPdfA, guardarPdfA } from '../utils/pdf-a';
import { paisDelCliente } from '../domain/tipo-operacion.model';
import { resumenEnvases } from '../domain/ieepnr';
import { aCentimos } from '../utils/money';
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
  llevaMarcaPruebas,
  llevaQrVerifactu,
  tamMarcaAgua,
  type DatosFacturaPdf,
  type LineaFacturaPdf,
} from './facturaPdf.service';
import { ANCHO_BLOQUE_QR, dibujarBloqueQr, MARCA_PRUEBAS } from './verifactu/qrPdf';

// ---------- Colores y medidas de la muestra ----------

const NEGRO = rgb(0, 0, 0);
const AZUL = rgb(0, 0, 1);
const VERDE = rgb(0xea / 255, 0xf1 / 255, 0xdd / 255); // #EAF1DD, el fondo de las etiquetas
const GRIS = rgb(0.392, 0.455, 0.545);
const MARCA_AGUA = rgb(0.93, 0.93, 0.93);

/** Grosor de los bordes y de las rayas entre bloques. */
const GRUESO = 1.7;
const FINO = 0.8;
/** Borde izquierdo y derecho del recuadro grande (cara exterior e interior). */
const X_IZQ = 39.7;
const X_IZQ_IN = 41.4;
const X_DER = 568.8;
const X_DER_IN = 567.1;

/** Bordes (cara izquierda) de las columnas de la tabla. */
const BORDE = { concepto: 277.7, kg: 320.9, packs: 358.0, uds: 395.0, ieepnr: 443.8, precio: 510.2 } as const;
/** Borde derecho del texto de cada columna numerica. */
export const COLUMNAS_A = { kg: 319.9, packs: 357.0, uds: 394.0, ieepnr: 439.9, precio: 506.4, total: 563.2 } as const;

const T_TABLA = 8.8;
const T_ETQ = 10.4;
const T_NOMBRE = 12.2;
const T_TITULO = 19.2;
const FILA = 10.8;
/** De lo alto de una fila de la tabla a su linea base. */
const BASE_FILA = 8.0;
/** Ancho del concepto (de 42,4 al borde de la columna KG, con aire). */
const X_TEXTO = 42.4;
const ANCHO_CONCEPTO = BORDE.concepto - X_TEXTO - 3;
/** Hueco entre bloques: la raya, una fila vacia y otra raya. */
const HUECO_BLOQUE = 10.9;
/** Hasta donde llega la tabla en una pagina que no es la ultima, y el numero de pagina. */
const SUELO_TABLA = 812;
/** Hasta donde llega la cola (resumen, totales, pie y registro) en una factura de una sola pagina (sin numero de pagina). */
const SUELO_COLA = 825;
/** Con varias paginas: hasta donde llega cualquier cosa, para no pisar «Página n de m». */
const SUELO_PAGINADO = 820;
const Y_PAGINA = 830;
/**
 * QR de VERI*FACTU: en el hueco de arriba entre el recuadro de la empresa y el
 * logo, con su borde de arriba a 15 pt del papel. La letra de sus textos es la
 * mayor de los datos (el nombre de la empresa y el del cliente, 12,2 pt). Lo
 * que va desde el recuadro del numero baja lo que haga falta.
 */
export const HUECO_QR_A = { izq: 238.2, der: 398.8, arriba: 15 } as const;
export const TAM_QR_A = T_NOMBRE;
/** Donde empieza hoy el recuadro del numero (puntos desde arriba). */
const TOP_NUMERO = 133.8;

/** NIF de una persona fisica (DNI, NIE o K, L, M): «NIF»; el de una sociedad, «CIF», como en la muestra. */
const etiquetaNifEspanol = (nif: string) => (/^[0-9XYZKLM]/i.test(nif.trim()) ? 'NIF' : 'CIF');

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

/** Formatos de la plantilla A (en la moneda de la factura: «€» en euros; si no, su codigo). */
export function formatosA(moneda = 'EUR') {
  const sufijo = moneda === 'EUR' ? '€' : moneda;
  return {
    /** Importes: dos decimales y punto de miles (4.162,75 €). */
    importe: (n: number) => `${cifra(n, 2, 2, true)} ${sufijo}`,
    /** Precio por unidad: de 2 a 4 decimales (0,162 €). */
    precio: (n: number) => `${cifra(n, 2, 4, true)} ${sufijo}`,
    /** Kg (y peso bruto): hasta 3 decimales, sin punto de miles (394,992; 24528,62). */
    kg: (n: number) => cifra(n, 0, 3, false),
    /** Packs y unidades: enteros sin punto de miles (28512); unidades con decimales, hasta 3. */
    unidades: (n: number) => cifra(n, 0, 3, false),
    /** dd/mm/aaaa. */
    fecha: (iso: string) => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso),
    /** 21% como en la muestra (I.V.A. (21%)). */
    pct: (n: number) => `${cifra(n, 0, 2, false)}%`,
  };
}

/** «Inscrita en el Registro Mercantil de {provincia}, {datos}, con CIF: {nif}», o null sin datos registrales. */
export function textoRegistroA(emisor: DatosFacturaPdf['emisor'], nif: string): string | null {
  if (!emisor) return null;
  const datos = emisor.datosRegistrales?.trim();
  const prov = emisor.registroMercantilProvincia?.trim();
  const conCif = nif ? `, con CIF: ${nif}` : '';
  if (datos) return `Inscrita en el Registro Mercantil${prov ? ` de ${prov}` : ''}, ${datos.replace(/[.\s]+$/, '')}${conCif}`;
  // Sin el texto libre: el de los datos por partes (tomo, folio, hoja...), sin su punto final.
  const insc = emisor.inscripcion?.trim();
  return insc ? `${insc.replace(/[.\s]+$/, '')}${conCif}` : null;
}

/** «TRANSFERENCIA BANCARIA», «RECIBO DOMICILIADO» o «CONTADO». */
const FORMA_PAGO_A: Record<string, string> = { TRANSFERENCIA: 'TRANSFERENCIA BANCARIA', GIRO: 'RECIBO DOMICILIADO', CONTADO: 'CONTADO' };

/** Titulo del documento en mayusculas. */
function tituloA(f: DatosFacturaPdf): string {
  if (f.estadoDocumento === 'PROFORMA') return 'FACTURA PROFORMA';
  if (f.tipoFactura === 'F2') return 'FACTURA SIMPLIFICADA';
  if (f.esRectificativa || /^R/.test(f.tipoFactura)) return 'FACTURA RECTIFICATIVA';
  return 'FACTURA';
}

/** Una fila de un bloque de articulo. */
interface FilaBloque {
  tipo: 'principal' | 'texto' | 'kg';
  texto: string;
  linea: LineaFacturaPdf;
}

/** Dibuja la factura con la plantilla A y devuelve el PDF/A. No toca la BD. */
export async function renderizarFacturaPlantillaA(f: DatosFacturaPdf): Promise<Buffer> {
  const moneda = f.moneda ?? 'EUR';
  const monedaCuenta = f.monedaCuenta ?? 'EUR';
  const F = formatosA(moneda);
  const esProforma = f.estadoDocumento === 'PROFORMA';
  const esBorrador = !esProforma && f.estadoDocumento !== 'FINAL';
  const titulo = tituloA(f);
  const tituloDoc = esBorrador ? `Borrador de ${titulo.toLowerCase()}` : `${titulo} ${f.numeroCompleto ?? ''}`.trim();

  const { doc, normal, negrita, ancho, alto } = await crearDocumentoPdfA(tituloDoc);
  const Y = (top: number) => alto - top;

  type Estilo = { tam?: number; fuente?: PDFFont; color?: RGB; alinear?: 'izq' | 'der' | 'centro'; cursiva?: boolean };
  /** Texto con su linea base a `base` puntos de arriba. */
  const texto = (pg: PDFPage, s: string, x: number, base: number, o: Estilo = {}) => {
    if (!s) return;
    const tam = o.tam ?? T_TABLA;
    const fuente = o.fuente ?? normal;
    const w = fuente.widthOfTextAtSize(s, tam);
    const xx = o.alinear === 'der' ? x - w : o.alinear === 'centro' ? x - w / 2 : x;
    pg.drawText(s, { x: xx, y: Y(base), size: tam, font: fuente, color: o.color ?? NEGRO, ...(o.cursiva ? { ySkew: degrees(12) } : {}) });
  };
  /** Tamaño con el que `s` cabe en `ancho` (como mucho `tam`). */
  const tamQueCabe = (s: string, fuente: PDFFont, tam: number, anchoMax: number) => {
    let t = tam;
    while (t > 5 && fuente.widthOfTextAtSize(s, t) > anchoMax) t -= 0.2;
    return t;
  };
  /** Rectangulo relleno de `top` a `bottom` (puntos desde arriba). */
  const caja = (pg: PDFPage, x1: number, top: number, x2: number, bottom: number, color: RGB) =>
    pg.drawRectangle({ x: x1, y: Y(bottom), width: x2 - x1, height: bottom - top, color });
  const raya = (pg: PDFPage, x1: number, x2: number, top: number, grueso = GRUESO) => caja(pg, x1, top, x2, top + grueso, NEGRO);
  const vertical = (pg: PDFPage, x: number, top: number, bottom: number, grueso = GRUESO) => caja(pg, x, top, x + grueso, bottom, NEGRO);
  /** Cara izquierda (interior) de cada columna numerica. */
  const IZQ_COL: Record<keyof typeof COLUMNAS_A, number> = {
    kg: BORDE.concepto + GRUESO,
    packs: BORDE.kg + GRUESO,
    uds: BORDE.packs + GRUESO,
    ieepnr: BORDE.uds + GRUESO,
    precio: BORDE.ieepnr + GRUESO,
    total: BORDE.precio + GRUESO,
  };
  /** Cifra alineada a la derecha de su columna; si no cabe, se achica (nunca pisa el borde). */
  const celda = (pg: PDFPage, s: string, col: keyof typeof COLUMNAS_A, base: number, fuente: PDFFont = normal, ajuste = 0) =>
    texto(pg, s, COLUMNAS_A[col] + ajuste, base, { tam: tamQueCabe(s, fuente, T_TABLA, COLUMNAS_A[col] + ajuste - IZQ_COL[col] - 1.5), fuente, alinear: 'der' });

  // ---------- Datos ----------
  const e = f.emisor;
  const nombreEmpresa = e?.denominacion?.trim() || 'Falta la denominación de la empresa';
  const nifEmpresa = nifDe(e?.nif, e?.pais) || '';
  const c = f.cliente;
  const clienteFiscal = { pais: c.pais, nifCif: c.nifCif, cp: c.cp };
  const paisCliente = paisDelCliente(clienteFiscal);
  const tiposIva = [...new Set(f.lineas.map((l) => l.tipoIva))].sort((a, b) => b - a);
  const variosTipos = tiposIva.length > 1;
  const conIva = f.conIva !== false;

  // Bloques de la tabla: la fila del articulo (el concepto partido), el texto
  // adicional y la fila «KG Plástico» (si la linea lleva kg o IEEPNR).
  const bloques: FilaBloque[][] = f.lineas.map((l) => {
    const concepto = variosTipos && conIva ? `${l.descripcion} (IVA ${F.pct(l.tipoIva)})` : l.descripcion;
    const trozos = partir(concepto, normal, T_TABLA, ANCHO_CONCEPTO);
    const filas: FilaBloque[] = trozos.map((t, i) => ({ tipo: i === 0 ? 'principal' : 'texto', texto: t, linea: l }));
    for (const t of l.textoAdicional?.trim() ? partir(l.textoAdicional.trim(), normal, T_TABLA, ANCHO_CONCEPTO) : []) filas.push({ tipo: 'texto', texto: t, linea: l });
    if ((l.kgPlastico !== null && l.kgPlastico !== undefined) || aCentimos(Number(l.ieepnrImporte ?? 0)) !== 0) filas.push({ tipo: 'kg', texto: 'KG Plástico', linea: l });
    return filas;
  });

  // Resumen de envases y totales por tipo de IVA (en centimos).
  const resumen = resumenEnvases(f.lineas.map((l) => ({ cantidad: l.cantidad, packs: l.packs, kgPlastico: l.kgPlastico, ieepnrImporte: l.ieepnrImporte })));
  const porTipo = new Map<number, { base: number; cuota: number }>();
  for (const l of f.lineas) {
    const t = porTipo.get(l.tipoIva) ?? { base: 0, cuota: 0 };
    t.base += aCentimos(l.baseLine);
    t.cuota += aCentimos(l.ivaImporte);
    porTipo.set(l.tipoIva, t);
  }
  const filasTotales: Array<[string, string]> = [];
  if (!conIva || porTipo.size <= 1) {
    filasTotales.push(['Subtotal', F.importe(f.baseTotal)]);
    if (conIva) filasTotales.push([`I.V.A. (${F.pct(tiposIva[0] ?? 21)})`, F.importe(f.ivaTotal)]);
  } else {
    // Varios tipos: una fila Base y otra I.V.A. por tipo (art. 6.1.j RD 1619/2012).
    for (const t of tiposIva) {
      const v = porTipo.get(t)!;
      filasTotales.push([`Base (${F.pct(t)})`, F.importe(v.base / 100)], [`I.V.A. (${F.pct(t)})`, F.importe(v.cuota / 100)]);
    }
  }
  const tipoRet = f.lineas.find((l) => l.tipoRetencion)?.tipoRetencion ?? 0;
  if (aCentimos(f.retencionTotal) !== 0) filasTotales.push([`IRPF (${F.pct(tipoRet)})`, F.importe(-f.retencionTotal)]);

  // Pie: DATOS BANCARIOS y OBSERVACIONES.
  const conCuenta = f.formaPago === 'TRANSFERENCIA' && !!f.cuenta?.iban;
  const banco: string[] = [`DATOS BANCARIOS:  ${FORMA_PAGO_A[f.formaPago] ?? f.formaPago}`];
  if (conCuenta) {
    banco.push(`TITULAR: ${nombreEmpresa}`, `IBAN: ${iban(f.cuenta!.iban)}`);
    const swift = [f.cuenta!.bic?.trim().toUpperCase(), f.cuenta!.bancoNombre?.trim().toUpperCase()].filter(Boolean).join(' - ');
    if (swift) banco.push(`SWIFT BANK: ${swift}`);
  }
  const T_OBS = 7.8;
  const anchoObs = X_DER_IN - 325.4 - 4;
  const mencion = mencionDocumento({ ...f, conIva });
  const otraMoneda = moneda !== monedaCuenta;
  const cv = otraMoneda ? f.contravalor : null;
  const textosObs = [
    // La mencion legal (exencion, ISP...) va antes de las observaciones.
    mencion?.es,
    mencion?.en,
    otraMoneda ? fraseDivisa({ ...f, conIva }, 'es') : null,
    cv ? `Contravalor en ${monedaCuenta}: base ${cifra(cv.base, 2, 2, true)}, IVA ${cifra(cv.iva, 2, 2, true)} y total ${cifra(cv.total, 2, 2, true)} ${monedaCuenta}.` : null,
    f.observaciones?.trim(),
  ].filter((s): s is string => !!s);
  const obs = textosObs.flatMap((t) => partir(t, normal, T_OBS, anchoObs));
  const registro = textoRegistroA(e, nifEmpresa);
  const lineasRegistro = registro ? partir(registro, normal, T_TABLA, X_DER - X_TEXTO) : [];
  const lineasPie = f.textoPie?.trim() ? partir(f.textoPie.trim(), normal, 6.5, X_DER - X_TEXTO) : [];

  // Alturas de la cola (resumen, totales y pie), para saber si cabe.
  const altoTotales = 13.4 + (filasTotales.length - 1) * 16.8 + 3.1 + GRUESO + 16.7 + 3.1 + GRUESO;
  /** Del alto del resumen al fondo de los totales. */
  const altoResumenTotales = 34.2 + altoTotales;
  /**
   * Huecos de la cola: los de la muestra o, si asi la cola entera cabe en la
   * pagina (un texto al pie largo, por ejemplo), apretados: menos aire tras el
   * ultimo articulo y antes del pie, y el recuadro del pie a su medida.
   */
  type Huecos = { finBloques: number; antesPie: number; minPie: number };
  const HUECOS_MUESTRA: Huecos = { finBloques: 10.1, antesPie: 9.7, minPie: 66.9 };
  const HUECOS_APRETADOS: Huecos = { finBloques: 4, antesPie: 5, minPie: 0 };
  const altoBanco = 18.8 + Math.max(banco.length - 1, 0) * 11.2 + 8;
  /** Alto del recuadro del pie con `n` lineas de observaciones (con DATOS BANCARIOS o, si sigue en otra pagina, sin ellos). */
  const altoCajaPie = (n: number, conBanco: boolean, minimo: number) => Math.max(conBanco ? Math.max(minimo, altoBanco) : 0, 18.8 + Math.max(n - 1, 0) * 9.4 + 8);
  /** Del fondo del recuadro del pie a la ultima linea base del registro y del texto al pie, mas el descendente. */
  const altoTrasPie = (() => {
    const r = lineasRegistro.length;
    const t = lineasPie.length;
    if (!r && !t) return 0;
    return 7.6 + (r ? (r - 1) * 10 : 0) + (t ? (r ? 10 : 0) + (t - 1) * 8 : 0) + 3;
  })();
  /** Alto de la cola entera, del final del ultimo articulo a su ultima linea. */
  const altoCola = (h: Huecos) => h.finBloques + altoResumenTotales + h.antesPie + altoCajaPie(obs.length, true, h.minPie) + altoTrasPie;

  // ---------- Paginas ----------
  const paginas: PDFPage[] = [];
  const nuevaPagina = (): PDFPage => {
    const pg = doc.addPage([ancho, alto]);
    paginas.push(pg);
    const marca = esBorrador ? 'BORRADOR' : llevaMarcaPruebas(f) ? MARCA_PRUEBAS : null;
    if (marca) {
      // Marca de agua centrada y girada, debajo de todo.
      const tam = tamMarcaAgua(marca, negrita, ancho, alto);
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
    const cx = (X_IZQ_IN + 236.5) / 2;
    const anchoCaja = 236.5 - X_IZQ_IN - 6;
    vertical(p, X_IZQ, 15.8, 91.3);
    vertical(p, 236.5, 17.5, 91.3);
    raya(p, X_IZQ_IN, 238.2, 15.8);
    raya(p, X_IZQ_IN, 238.2, 89.6);
    const filas: Array<[string, number, PDFFont, number]> = [
      [nombreEmpresa, T_NOMBRE, negrita, 28.5],
      [nifEmpresa ? `${etiquetaNifEspanol(nifEmpresa)}. ${nifEmpresa}` : '', T_ETQ, negrita, 43.8],
      [e?.domicilioSocial?.trim() ?? '', T_ETQ, normal, 58.0],
      [lineaPoblacion(e?.codigoPostal, e?.municipio, e?.provincia, e?.pais), T_ETQ, normal, 71.5],
      [nombrePais(e?.pais || 'ES', 'es').toUpperCase(), T_NOMBRE, normal, 85.7],
    ];
    for (const [s, tam, fuente, base] of filas) texto(p, s, cx, base, { tam: tamQueCabe(s, fuente, tam, anchoCaja), fuente, alinear: 'centro', cursiva: true });
  }
  // Logo (si lo hay), arriba a la derecha, donde la muestra no tiene nada.
  if (f.logo?.bytes?.length) {
    try {
      const img = f.logo.mime === 'image/png' ? await doc.embedPng(f.logo.bytes) : await doc.embedJpg(f.logo.bytes);
      const escala = Math.min(170 / img.width, 74 / img.height, 1);
      p.drawImage(img, { x: X_DER - img.width * escala, y: Y(16 + img.height * escala), width: img.width * escala, height: img.height * escala });
    } catch {
      // Imagen dañada: sin logo.
    }
  }
  // Email, azul y subrayado.
  if (e?.email?.trim()) {
    const email = e.email.trim();
    texto(p, email, X_TEXTO, 100.2, { color: AZUL });
    caja(p, X_TEXTO, 101.0, X_TEXTO + normal.widthOfTextAtSize(email, T_TABLA), 101.6, AZUL);
  }

  // ---------- QR de VERI*FACTU (solo en la primera pagina) ----------
  // dy: lo que baja todo lo que va desde el recuadro del numero para dejar sitio al bloque.
  let dy = 0;
  let xBloqueQr = X_DER;
  if (llevaQrVerifactu(f)) {
    const anchoHueco = HUECO_QR_A.der - HUECO_QR_A.izq;
    const bloque = dibujarBloqueQr(p, {
      xCentro: (HUECO_QR_A.izq + HUECO_QR_A.der) / 2,
      yArriba: Y(HUECO_QR_A.arriba),
      url: f.verifactu!.url,
      tam: TAM_QR_A,
      anchoMax: Math.min(ANCHO_BLOQUE_QR, anchoHueco - 4),
      normal,
      negrita,
    });
    xBloqueQr = bloque.cajaBloque.x;
    dy = Math.max(0, alto - bloque.cajaBloque.y + 4 - TOP_NUMERO);
  }

  // ---------- FACTURA y recuadro del numero y la fecha ----------
  // Un titulo largo (rectificativa, simplificada) se achica para no llegar al QR.
  texto(p, titulo, 43.8, 124.5, { tam: tamQueCabe(titulo, negrita, T_TITULO, xBloqueQr - 8 - 43.8), fuente: negrita });
  if (esProforma) texto(p, AVISO_PROFORMA, X_DER_IN, 124.5, { tam: 8.5, color: GRIS, alinear: 'der' });
  if (esBorrador) texto(p, 'Borrador: sin número ni validez fiscal', X_DER_IN, 124.5, { tam: 8.5, color: GRIS, alinear: 'der' });
  caja(p, 41.0, 134.6 + dy, 135.4, 166.8 + dy, VERDE);
  raya(p, X_IZQ_IN, X_DER, 133.8 + dy);
  raya(p, X_IZQ_IN, X_DER, 165.8 + dy);
  vertical(p, X_IZQ, 133.8 + dy, 167.5 + dy);
  vertical(p, 134.4, 135.5 + dy, 167.5 + dy);
  vertical(p, X_DER_IN, 135.5 + dy, 167.5 + dy);
  texto(p, esProforma ? 'Nº PROFORMA:' : 'Nº FACTURA:', 45.4, 144.7 + dy, { tam: T_ETQ, fuente: negrita });
  texto(p, esBorrador ? 'Borrador (sin número)' : (f.numeroCompleto ?? ''), 137.2, 144.7 + dy, { tam: T_ETQ });
  texto(p, 'FECHA:', 45.4, 162.7 + dy, { tam: T_ETQ, fuente: negrita });
  const fechaTxt = `${F.fecha(f.fechaEmision)}${f.fechaOperacion && f.fechaOperacion !== f.fechaEmision ? `   (fecha de la operación: ${F.fecha(f.fechaOperacion)})` : ''}`;
  texto(p, fechaTxt, 137.2, 162.7 + dy, { tam: T_ETQ });

  // ---------- CLIENTE ----------
  const X_CLIENTE = 199.6;
  const anchoCliente = X_DER_IN - X_CLIENTE - 4;
  const nifCliente = nifDe(c.nifCif, paisCliente);
  const etqNif = paisCliente === 'ES' ? etiquetaNifEspanol(nifCliente) : etiquetaNifCliente(c, 'es');
  const datosCliente: Array<[string, number]> = [];
  for (const l of partir(c.nombreFiscal, negrita, T_NOMBRE, anchoCliente)) datosCliente.push([l, T_NOMBRE]);
  // Simplificada (F2 o R5) registrada en VERI*FACTU: solo el nombre del cliente, como la plantilla de siempre.
  const sinIdentificar = f.clienteSinIdentificar === true;
  if (nifCliente && !sinIdentificar) datosCliente.push([`${etqNif}: ${nifCliente}`, T_ETQ]);
  const resto = sinIdentificar
    ? []
    : paisCliente === 'ES'
      ? [
          c.direccion?.trim(),
          [c.cp?.trim(), c.municipio?.trim()].filter(Boolean).join('   '),
          c.provincia?.trim() && c.provincia.trim().toUpperCase() !== c.municipio?.trim().toUpperCase() ? c.provincia.trim() : null,
        ]
      : [c.direccion?.trim(), lineaPoblacion(c.cp, c.municipio, c.provincia, paisCliente), c.pais ? nombrePais(c.pais, 'es').toUpperCase() : null];
  for (const r of resto.filter((s): s is string => !!s)) for (const l of partir(r, negrita, T_ETQ, anchoCliente)) datosCliente.push([l, T_ETQ]);
  let base = 193.6 + dy;
  datosCliente.forEach(([s, tam], i) => {
    if (i > 0) base += 13.2;
    texto(p, s, X_CLIENTE, base, { tam, fuente: negrita });
  });
  const fondoCliente = Math.max(264.4 + dy, base + 18);
  caja(p, 41.0, 174.8 + dy, 135.4, fondoCliente - 0.8, VERDE);
  raya(p, X_IZQ_IN, X_DER, 174.0 + dy);
  raya(p, X_IZQ_IN, X_DER, fondoCliente - GRUESO);
  vertical(p, X_IZQ, 174.0 + dy, fondoCliente);
  vertical(p, 134.4, 175.7 + dy, fondoCliente);
  vertical(p, X_DER_IN, 175.7 + dy, fondoCliente);
  texto(p, 'CLIENTE:', 42.5, 193.6 + dy, { tam: T_ETQ, fuente: negrita });
  let y = fondoCliente + 9.7;

  // ---------- Rectificativa: que corrige, como y por que (bajo el CLIENTE) ----------
  if (f.esRectificativa) {
    const lineas = textoRectificacionPdf(f, 'es').flatMap((t) => partir(t, normal, T_TABLA, X_DER_IN - 137.2 - 4));
    const fondo = y + Math.max(24, 10 + lineas.length * FILA + 4);
    caja(p, 41.0, y + 0.8, 135.4, fondo - 0.8, VERDE);
    raya(p, X_IZQ_IN, X_DER, y);
    raya(p, X_IZQ_IN, X_DER, fondo - GRUESO);
    vertical(p, X_IZQ, y, fondo);
    vertical(p, 134.4, y + GRUESO, fondo);
    vertical(p, X_DER_IN, y + GRUESO, fondo);
    texto(p, 'RECTIFICA:', 45.4, y + 13, { tam: T_ETQ, fuente: negrita });
    lineas.forEach((l, i) => texto(p, l, 137.2, y + 12 + i * FILA));
    y = fondo + 9.7;
  }

  // ---------- Tabla ----------
  /** Lo alto de la tabla en la pagina actual (para cerrar sus bordes). */
  let topTabla = y;
  const cabeceraTabla = (top: number) => {
    caja(p, 41.0, top + 0.8, 568.1, top + 23.0, VERDE);
    raya(p, X_IZQ_IN, X_DER, top);
    raya(p, X_IZQ_IN, X_DER, top + 22.1);
    for (const x of Object.values(BORDE)) vertical(p, x, top + GRUESO, top + 23.8);
    const b = top + 16.1;
    const centro = (a: number, z: number) => (a + GRUESO + z) / 2;
    texto(p, 'CONCEPTO', 53.2, b, { fuente: negrita });
    texto(p, 'KG.Plast', centro(BORDE.concepto, BORDE.kg), b, { fuente: negrita, alinear: 'centro' });
    texto(p, 'PACKS', centro(BORDE.kg, BORDE.packs), b, { fuente: negrita, alinear: 'centro' });
    texto(p, 'UDS', centro(BORDE.packs, BORDE.uds), b, { fuente: negrita, alinear: 'centro' });
    texto(p, 'IEEPNR', centro(BORDE.uds, BORDE.ieepnr), b, { fuente: negrita, alinear: 'centro' });
    texto(p, 'PRECIO/UDS', centro(BORDE.ieepnr, BORDE.precio), b, { fuente: negrita, alinear: 'centro' });
    texto(p, 'TOTAL', centro(BORDE.precio, X_DER_IN), b, { fuente: negrita, alinear: 'centro' });
    topTabla = top;
    return top + 23.8;
  };
  /** Cierra la tabla de una pagina que no es la ultima: los laterales hasta `fondo` y una raya. */
  const cerrarTabla = (fondo: number) => {
    vertical(p, X_IZQ, topTabla, fondo);
    vertical(p, X_DER_IN, topTabla + GRUESO, fondo);
    raya(p, X_IZQ_IN, X_DER, fondo - GRUESO);
  };
  /** Pagina siguiente con la cabecera breve; devuelve donde empieza lo demas. */
  const cabeceraBreve = () => {
    p = nuevaPagina();
    texto(p, nombreEmpresa, X_IZQ_IN, 32, { tam: T_ETQ, fuente: negrita });
    texto(p, `${esBorrador ? 'Borrador de factura' : `${titulo} ${f.numeroCompleto ?? ''}`.trim()} (continuación)`, X_DER, 32, { alinear: 'der' });
    texto(p, `CLIENTE: ${c.nombreFiscal}`, X_IZQ_IN, 45, { tam: T_TABLA });
    return 56;
  };
  /** Pagina siguiente: cabecera breve y la de la tabla. */
  const continuar = () => cabeceraTabla(cabeceraBreve());

  y = cabeceraTabla(y);
  const dibujarFila = (fila: FilaBloque, top: number) => {
    const b = top + BASE_FILA;
    texto(p, fila.texto, X_TEXTO, b);
    const l = fila.linea;
    if (fila.tipo === 'principal') {
      if (l.packs !== null && l.packs !== undefined) celda(p, F.unidades(l.packs), 'packs', b);
      celda(p, F.unidades(l.cantidad), 'uds', b);
      celda(p, F.precio(l.precioUnitario), 'precio', b);
      // TOTAL del articulo: la base de la linea sin su IEEPNR.
      celda(p, F.importe((aCentimos(l.baseLine) - aCentimos(Number(l.ieepnrImporte ?? 0))) / 100), 'total', b);
    } else if (fila.tipo === 'kg') {
      if (l.kgPlastico !== null && l.kgPlastico !== undefined) celda(p, F.kg(l.kgPlastico), 'kg', b);
      celda(p, F.importe(Number(l.ieepnrImporte ?? 0)), 'ieepnr', b);
    }
  };

  /** La pagina actual aun no tiene filas (acaba de empezar la tabla). */
  const sinFilas = () => Math.abs(y - (topTabla + 23.8)) < 0.01;
  /**
   * Huecos con los que la cola entera cabe tras un ultimo articulo que acaba en
   * `fin` (los de la muestra o los apretados); null si no cabe ni asi. Sola en
   * la primera pagina puede bajar mas: no lleva numero de pagina.
   */
  const huecosQueCaben = (fin: number): Huecos | null => {
    const suelo = paginas.length === 1 ? SUELO_COLA : SUELO_PAGINADO;
    return [HUECOS_MUESTRA, HUECOS_APRETADOS].find((h) => fin + altoCola(h) <= suelo) ?? null;
  };
  /** El resumen y los totales caben tras un ultimo articulo que acaba en `fin` (el resto de la cola sigue en otra pagina). */
  const cabenTotales = (fin: number) => fin + HUECOS_MUESTRA.finBloques + altoResumenTotales <= SUELO_PAGINADO;
  bloques.forEach((filas, k) => {
    const ultimo = k === bloques.length - 1;
    // El bloque entero va en la pagina siguiente si aqui no cabe. El ultimo, con
    // el resumen y los totales detras: si no caben, tambien pasa a la siguiente.
    const fin = y + filas.length * FILA;
    const cabe = ultimo ? !!huecosQueCaben(fin) || cabenTotales(fin) : fin + HUECO_BLOQUE <= SUELO_TABLA;
    if (!cabe && !sinFilas()) {
      cerrarTabla(y);
      y = continuar();
    }
    for (const fila of filas) {
      // Un bloque mas alto que una pagina entera se parte por filas.
      if (y + FILA > SUELO_TABLA) {
        cerrarTabla(y + GRUESO);
        y = continuar();
      }
      dibujarFila(fila, y);
      y += FILA;
    }
    // Raya al final del bloque; entre bloques, una fila vacia y otra raya.
    raya(p, X_IZQ_IN, X_DER_IN, y - 0.9, FINO);
    if (!ultimo) {
      raya(p, X_IZQ_IN, X_DER_IN, y + HUECO_BLOQUE - FINO, FINO);
      y += HUECO_BLOQUE;
    }
  });
  // Sin sitio para el resumen y los totales (un ultimo bloque partido): otra pagina.
  if (!huecosQueCaben(y) && !cabenTotales(y) && !sinFilas()) {
    cerrarTabla(y + GRUESO);
    y = continuar();
  }
  // Los huecos de la muestra o, si asi la cola entera cabe, los apretados. Si
  // no cabe, la cola se parte (con los de la muestra) y todo va hasta SUELO_PAGINADO.
  const huecos = huecosQueCaben(y);
  const h = huecos ?? HUECOS_MUESTRA;
  const sueloCola = huecos && paginas.length === 1 ? SUELO_COLA : SUELO_PAGINADO;
  // Tras el ultimo bloque queda una fila vacia (como en la muestra) y despues el resumen.
  const S = y + h.finBloques;

  // ---------- Resumen: peso bruto y totales de envases ----------
  {
    const etqTop = S + GRUESO;
    caja(p, 136.1, etqTop, 236.5, S + 11.4, VERDE);
    caja(p, 279.4, etqTop, BORDE.ieepnr, S + 11.4, VERDE);
    raya(p, 136.1, 445.4, S);
    raya(p, 136.1, 445.4, S + 22.8);
    vertical(p, 134.4, S, S + 24.5);
    vertical(p, 236.5, S + GRUESO, S + 24.5);
    vertical(p, BORDE.ieepnr, S + GRUESO, S + 24.5);
    raya(p, 136.1, 238.2, S + 11.4);
    raya(p, 279.4, 445.4, S + 11.4);
    for (const x of [BORDE.concepto, BORDE.kg, BORDE.packs, BORDE.uds]) vertical(p, x, S + GRUESO, S + 13.1);
    const centro = (a: number, z: number) => (a + GRUESO + z) / 2;
    texto(p, 'PESO BRUTO(kg)', 137.0, S + 9.7, { fuente: negrita });
    texto(p, 'KG. Plast', centro(BORDE.concepto, BORDE.kg), S + 9.1, { fuente: negrita, alinear: 'centro' });
    texto(p, 'PACKS', centro(BORDE.kg, BORDE.packs), S + 9.1, { fuente: negrita, alinear: 'centro' });
    texto(p, 'UDS', centro(BORDE.packs, BORDE.uds), S + 9.1, { fuente: negrita, alinear: 'centro' });
    texto(p, 'IEEPNR', centro(BORDE.uds, BORDE.ieepnr), S + 9.1, { fuente: negrita, alinear: 'centro' });
    const v = S + 20.5;
    if (f.pesoBrutoKg !== null && f.pesoBrutoKg !== undefined) texto(p, F.kg(f.pesoBrutoKg), 177.4, v, { alinear: 'centro' });
    celda(p, F.kg(resumen.kgPlastico), 'kg', v);
    celda(p, F.unidades(resumen.packs), 'packs', v, normal, -0.1);
    celda(p, F.unidades(resumen.uds), 'uds', v);
    celda(p, F.importe(resumen.ieepnr), 'ieepnr', v);
  }

  // ---------- Subtotal, I.V.A. y Total ----------
  const L = S + 34.2;
  raya(p, X_IZQ_IN, X_DER, L);
  const bases = filasTotales.map((_, i) => L + 13.4 + i * 16.8);
  const sep = bases[bases.length - 1] + 3.1;
  const baseTotal = sep + GRUESO + 16.7;
  const fondoTotales = baseTotal + 3.1 + GRUESO;
  caja(p, 511.1, L + 0.8, 568.1, sep + 1.0, VERDE);
  caja(p, 511.1, sep + 0.9, 568.1, fondoTotales - 0.7, VERDE);
  raya(p, 511.9, X_DER, sep);
  raya(p, X_IZQ_IN, X_DER, fondoTotales - GRUESO);
  vertical(p, BORDE.ieepnr, L + GRUESO, fondoTotales);
  vertical(p, BORDE.precio, L + GRUESO, fondoTotales);
  const anchoEtq = BORDE.precio - BORDE.ieepnr - GRUESO - 4;
  filasTotales.forEach(([etq, valor], i) => {
    texto(p, etq, 509.2, bases[i], { tam: tamQueCabe(etq, negrita, T_ETQ, anchoEtq), fuente: negrita, alinear: 'der' });
    celda(p, valor, 'total', bases[i] + 0.1);
  });
  const totalTxt = F.importe(f.totalFactura);
  texto(p, 'Total', 509.2, baseTotal, { tam: T_ETQ, fuente: negrita, alinear: 'der' });
  celda(p, totalTxt, 'total', baseTotal + 0.1, negrita);
  // Laterales del recuadro grande, de la cabecera de la tabla al final de los totales.
  vertical(p, X_IZQ, topTabla, fondoTotales);
  vertical(p, X_DER_IN, topTabla + GRUESO, fondoTotales);

  // ---------- DATOS BANCARIOS y OBSERVACIONES ----------
  // Un recuadro con los datos bancarios y las observaciones que quepan; las
  // que no, en otro recuadro «OBSERVACIONES (continuación)» en la pagina
  // siguiente (sin la tabla), y asi hasta acabar.
  const anchoBanco = BORDE.kg - 44.7 - 4;
  /** Dibuja el recuadro en `P` con las observaciones `trozo`; devuelve su fondo. */
  const recuadroPie = (P: number, trozo: string[], conBanco: boolean, continuacion: boolean) => {
    const fondo = P + altoCajaPie(trozo.length, conBanco, h.minPie);
    caja(p, 41.0, P + 0.9, 568.1, fondo - 0.8, VERDE);
    raya(p, X_IZQ_IN, X_DER, P);
    raya(p, X_IZQ_IN, X_DER, fondo - GRUESO);
    vertical(p, X_IZQ, P, fondo);
    vertical(p, BORDE.kg, P + GRUESO, fondo);
    vertical(p, X_DER_IN, P + GRUESO, fondo);
    if (conBanco) banco.forEach((l, i) => texto(p, l, 44.7, P + 18.8 + i * 11.2, { tam: tamQueCabe(l, negrita, T_TABLA, anchoBanco), fuente: negrita }));
    texto(p, continuacion ? 'OBSERVACIONES (continuación):' : 'OBSERVACIONES:', 325.4, P + 8.0, { tam: T_OBS, fuente: negrita });
    trozo.forEach((l, i) => texto(p, l, 325.4, P + 18.8 + i * 9.4, { tam: T_OBS }));
    return fondo;
  };
  /** Cuantas observaciones (desde la `desde`) caben en un recuadro que empieza en `P`. */
  const caben = (P: number, desde: number, conBanco: boolean) => {
    let n = obs.length - desde;
    while (n > 0 && P + altoCajaPie(n, conBanco, h.minPie) > sueloCola) n--;
    return n;
  };
  let P = fondoTotales + h.antesPie;
  let fondoPie = P;
  let hechas = 0;
  let conBanco = true;
  // Con los datos bancarios: si ni ellos ni (de haberlas) unas pocas observaciones caben aqui, a la pagina siguiente.
  if (P + altoCajaPie(0, true, h.minPie) > sueloCola || (obs.length && caben(P, 0, true) < Math.min(obs.length, 3))) P = cabeceraBreve();
  for (;;) {
    const n = Math.max(caben(P, hechas, conBanco), conBanco ? 0 : 1);
    fondoPie = recuadroPie(P, obs.slice(hechas, hechas + n), conBanco, hechas > 0);
    hechas += n;
    if (hechas >= obs.length) break;
    P = cabeceraBreve();
    conBanco = false;
  }

  // ---------- Registro Mercantil y texto al pie (siguen en otra pagina si no caben) ----------
  let yPie = fondoPie + 7.6;
  const lineaPie = (s: string, salto: number, o: Estilo = {}) => {
    if (yPie + 3 > sueloCola) yPie = cabeceraBreve() + 8;
    texto(p, s, X_TEXTO, yPie, o);
    yPie += salto;
  };
  for (const l of lineasRegistro) lineaPie(l, 10);
  for (const l of lineasPie) lineaPie(l, 8, { tam: 6.5, color: GRIS });

  // ---------- Numero de pagina (con mas de una) ----------
  if (paginas.length > 1) paginas.forEach((pg, i) => texto(pg, `Página ${i + 1} de ${paginas.length}`, X_DER, Y_PAGINA, { tam: 7.5, color: GRIS, alinear: 'der' }));

  return guardarPdfA(doc, tituloDoc);
}
