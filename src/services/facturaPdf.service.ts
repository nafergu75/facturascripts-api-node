import { degrees, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import { prisma } from '../config/database';
import { notFound } from '../utils/http-errors';
import { crearDocumentoPdfA, guardarPdfA } from '../utils/pdf-a';
import { textoInscripcionRegistral } from './legalConfig.service';

/**
 * PDF de una factura de venta (PDF/A-2b, apto para conservarla).
 *
 * Lleva lo que exige el art. 6 del Reglamento de facturacion (RD 1619/2012):
 * numero y serie, fecha de expedicion, nombre, NIF y domicilio del emisor y del
 * cliente, descripcion de las operaciones, base, tipo y cuota de IVA por tipo y
 * total. Las rectificativas llevan la factura que corrigen y el motivo.
 * Un borrador sale con marca de agua y sin numero.
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
  } | null;
  /** Factura que corrige una rectificativa. */
  original: { numeroCompleto: string | null; fechaEmision: string } | null;
  /** Cuenta donde se cobra (solo se imprime si la forma de pago es transferencia). */
  cuenta: { iban: string; bic: string | null } | null;
  /** Logo de la empresa (PNG o JPG). */
  logo?: { bytes: Uint8Array; mime: string } | null;
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

const MARGEN = 48;
const PIE_Y = 30;
const SUELO = 56; // nada de contenido por debajo (deja sitio al pie)
const COL_B = 300; // segunda columna: cliente y forma de pago

/** Nota que lleva la proforma bajo el titulo. */
export const AVISO_PROFORMA = 'Documento sin validez fiscal. No es una factura.';

const TITULO_TIPO: Record<string, string> = {
  F1: 'Factura',
  F2: 'Factura simplificada',
  R1: 'Factura rectificativa',
  R2: 'Factura rectificativa',
  R3: 'Factura rectificativa',
  R4: 'Factura rectificativa',
  R5: 'Factura rectificativa',
};

// ---------- Formatos ----------

const num = (n: number, dec = 2): string =>
  n.toLocaleString('es-ES', { minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: true });
const eur = (n: number): string => `${n < 0 ? '−' : ''}${num(Math.abs(n))} €`;
const fechaES = (iso: string): string =>
  /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso;
const cantidad = (n: number): string =>
  `${n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('es-ES', { maximumFractionDigits: 3 })}`;
const nif = (s: string | null | undefined): string => (s ?? '').replace(/[\s-]/g, '').toUpperCase();
const iban = (s: string): string => s.replace(/\s/g, '').toUpperCase().replace(/(.{4})/g, '$1 ').trim();
const pct = (n: number): string => `${n.toLocaleString('es-ES', { maximumFractionDigits: 2 })} %`;

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

const lineaPoblacion = (cp?: string | null, municipio?: string | null, provincia?: string | null): string => {
  const base = [cp, municipio].filter((s) => s && s.trim()).join(' ');
  const prov = provincia && provincia.trim() && provincia.trim() !== municipio?.trim() ? provincia.trim() : '';
  return base && prov ? `${base} (${prov})` : base || prov;
};

// ---------- Dibujo ----------

/** Dibuja la factura y devuelve el PDF/A. No toca la BD. */
export async function renderizarFactura(f: DatosFacturaPdf): Promise<Buffer> {
  // La proforma es el mismo documento con su numero P-n, sin marca de agua y
  // con una nota de que no es una factura.
  const esProforma = f.estadoDocumento === 'PROFORMA';
  const esBorrador = !esProforma && f.estadoDocumento !== 'FINAL';
  const tipoDoc = esProforma ? 'Factura proforma' : (TITULO_TIPO[f.tipoFactura] ?? 'Factura');
  const tituloDoc = esBorrador ? `Borrador de ${tipoDoc.toLowerCase()}` : `${tipoDoc} ${f.numeroCompleto ?? ''}`.trim();

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

  const nombreEmpresa = f.emisor?.denominacion?.trim() || 'Falta la denominación de la empresa';
  const nifEmpresa = nif(f.emisor?.nif) || 'falta el NIF';
  const refDoc = esBorrador ? `${tipoDoc} (borrador)` : `${tipoDoc} ${f.numeroCompleto ?? ''}`.trim();

  // ---------- Paginas ----------
  const paginas: PDFPage[] = [];
  const nuevaPagina = (): PDFPage => {
    const pg = doc.addPage([ancho, alto]);
    paginas.push(pg);
    if (esBorrador) {
      // Centrada en la hoja: el punto de origen se desplaza medio texto a lo largo del giro.
      const tam = 100;
      const w = negrita.widthOfTextAtSize('BORRADOR', tam);
      const a = (35 * Math.PI) / 180;
      const x = ancho / 2 - (w / 2) * Math.cos(a) + (tam * 0.35) * Math.sin(a);
      const y = alto / 2 - (w / 2) * Math.sin(a) - (tam * 0.35) * Math.cos(a);
      pg.drawText('BORRADOR', { x, y, size: tam, font: negrita, color: MARCA_AGUA, rotate: degrees(35) });
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
    texto(p, `${refDoc} (continuación)`, derecha, y, { tam: 9, color: GRIS, alinear: 'der' });
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
  if (esProforma) texto(p, AVISO_PROFORMA, MARGEN, y - 17, { tam: 8.5, color: GRIS });
  if (esBorrador) {
    texto(p, 'Borrador · sin número ni validez fiscal', derecha, yNumero, { tam: 10, fuente: negrita, color: GRIS, alinear: 'der' });
  } else {
    texto(p, f.numeroCompleto ?? '', derecha, yNumero, { tam: 13, fuente: monoNegrita, alinear: 'der' });
    const wNum = monoNegrita.widthOfTextAtSize(f.numeroCompleto ?? '', 13);
    texto(p, 'Nº', derecha - wNum - 6, yNumero, { tam: 9, color: GRIS, alinear: 'der' });
  }
  const fechaTxt = fechaES(f.fechaEmision);
  texto(p, fechaTxt, derecha, yNumero - 17, { tam: 9, fuente: mono, alinear: 'der' });
  texto(p, 'Fecha de emisión', derecha - mono.widthOfTextAtSize(fechaTxt, 9) - 6, yNumero - 17, {
    tam: 9,
    color: GRIS,
    alinear: 'der',
  });
  y = Math.min(y, yNumero) - 50;

  // ---------- Emisor y cliente ----------
  const anchoA = COL_B - MARGEN - 24;
  const anchoB = derecha - COL_B;
  const bloqueParte = (
    x: number,
    anchoCol: number,
    titulo: string,
    nombre: string,
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
    texto(p, 'NIF', x, yy, { color: GRIS });
    // Un NIF real va en mono; el aviso de que falta, en texto normal y gris.
    const nifReal = /\d/.test(nifTxt);
    texto(p, nifTxt, x + normal.widthOfTextAtSize('NIF', 9) + 5, yy, {
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
  const yEmisor = bloqueParte(
    MARGEN,
    anchoA,
    'Emisor',
    nombreEmpresa,
    nifEmpresa,
    [
      e?.domicilioSocial,
      lineaPoblacion(e?.codigoPostal, e?.municipio, e?.provincia),
      [e?.telefono && `Tel. ${e.telefono}`, e?.email, e?.web].filter(Boolean).join(' · ') || null,
    ],
    !e?.denominacion?.trim(),
  );
  const c = f.cliente;
  const yCliente = bloqueParte(COL_B, anchoB, 'Cliente', c.nombreFiscal, nif(c.nifCif) || '—', [
    c.direccion,
    lineaPoblacion(c.cp, c.municipio, c.provincia),
    c.pais && c.pais.toUpperCase() !== 'ES' && c.pais.toUpperCase() !== 'ESPAÑA' ? c.pais : null,
  ]);
  y = Math.min(yEmisor, yCliente) - 14;

  // ---------- Franja de pago (el elemento firma) ----------
  const aAbonar = f.totalFactura < 0;
  let pagoEtq = 'Forma de pago';
  let pagoValor = 'Contado';
  let pagoMono = false;
  let pagoNota = '';
  if (f.formaPago === 'TRANSFERENCIA') {
    if (f.cuenta?.iban && !aAbonar) {
      pagoEtq = 'Transferencia a la cuenta';
      pagoValor = iban(f.cuenta.iban);
      pagoMono = true;
      if (f.cuenta.bic) pagoNota = `BIC ${f.cuenta.bic.toUpperCase()}`;
    } else {
      pagoValor = 'Transferencia bancaria';
    }
  } else if (f.formaPago === 'GIRO') {
    pagoValor = 'Recibo domiciliado en su cuenta';
  } else if (f.formaPago !== 'CONTADO') {
    pagoValor = f.formaPago;
  }
  const altoFranja = pagoNota ? 64 : 54;
  p.drawRectangle({ x: MARGEN, y: y - altoFranja, width: anchoUtil, height: altoFranja, color: ACENTO_SUAVE });
  filete(p, y, MARGEN, derecha, 1.25, ACENTO);
  const yEtq = y - 17;
  const yVal = y - 39;
  const xTotal = MARGEN + 14;
  const xVence = MARGEN + 152;
  etiqueta(p, aAbonar ? 'Total a abonar' : 'Total a pagar', xTotal, yEtq, { color: ACENTO });
  texto(p, eur(Math.abs(f.totalFactura)), xTotal, yVal, { tam: 18, fuente: monoNegrita });
  etiqueta(p, f.formaPago === 'CONTADO' ? 'Fecha de pago' : 'Vence', xVence, yEtq, { color: ACENTO });
  texto(p, fechaES(f.fechaVencimiento), xVence, yVal, { tam: 11, fuente: mono });
  etiqueta(p, pagoEtq, COL_B, yEtq, { color: ACENTO });
  texto(p, pagoValor, COL_B, yVal, { tam: pagoMono ? 10.5 : 10, fuente: pagoMono ? mono : normal });
  if (pagoNota) texto(p, pagoNota, COL_B, yVal - 13, { tam: 8, fuente: mono, color: GRIS });
  y -= altoFranja + 26;

  // ---------- Rectificativa: a que factura corrige y por que ----------
  if (f.esRectificativa) {
    const modo = f.tipoRectificativa === 'S' ? 'por sustitución' : 'por diferencias';
    const ref = f.original?.numeroCompleto
      ? `la factura ${f.original.numeroCompleto}, de ${fechaES(f.original.fechaEmision)}`
      : 'una factura anterior';
    const lineas = partir(`Rectifica ${ref}, ${modo} (${f.tipoFactura}).`, normal, 9, anchoUtil);
    const motivo = f.motivoRectificacion?.trim() ? partir(`Motivo: ${f.motivoRectificacion.trim()}`, normal, 9, anchoUtil) : [];
    etiqueta(p, 'Rectificación', MARGEN, y);
    y -= 14;
    for (const l of [...lineas, ...motivo]) {
      texto(p, l, MARGEN, y);
      y -= 12;
    }
    y -= 16;
  }

  // ---------- Tabla de lineas ----------
  const hayDto = f.lineas.some((l) => l.descuentoPorcentaje);
  // Columnas numericas, alineadas a la derecha: [titulo, borde derecho].
  const cols: Array<[string, number]> = [];
  {
    let borde = derecha;
    const anchos: Array<[string, number]> = [
      ['Importe', 0],
      ['IVA', 76],
      ...(hayDto ? ([['Dto.', 42]] as Array<[string, number]>) : []),
      ['Precio', hayDto ? 42 : 46],
      ['Cant.', 72],
    ];
    for (const [t, w] of anchos) {
      borde -= w;
      cols.unshift([t, borde]);
    }
  }
  const anchoConcepto = cols[0][1] - 52 - MARGEN;

  const cabeceraTabla = () => {
    etiqueta(p, 'Concepto', MARGEN, y - 10);
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
          cantidad(l.cantidad),
          eur(l.precioUnitario),
          ...(hayDto ? [l.descuentoPorcentaje ? pct(l.descuentoPorcentaje) : ''] : []),
          pct(l.tipoIva),
          eur(l.baseLine),
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
  const tipos = Array.from(porTipo.entries()).sort((a, b) => b[0] - a[0]);
  const tipoRet = f.lineas.find((l) => l.tipoRetencion)?.tipoRetencion ?? 0;
  const hayExento = porTipo.has(0);

  const filasTotales: Array<[string, string]> = [
    ['Base imponible', eur(f.baseTotal)],
    ['IVA', eur(f.ivaTotal)],
  ];
  if (f.retencionTotal) filasTotales.push([`Retención IRPF ${pct(tipoRet)}`, eur(-f.retencionTotal)]);
  const altoTotales = filasTotales.length * 15 + 30;
  const altoDesglose = 27 + tipos.length * 13 + (hayExento ? 16 : 0);
  // Las observaciones cortas viajan con los totales: no se quedan solas en otra pagina.
  const obs = f.observaciones?.trim() ? partir(f.observaciones.trim(), normal, 9, Math.min(anchoUtil, 400)) : [];
  const altoObsCorta = obs.length && obs.length <= 4 ? 28 + 14 + obs.length * 12 : 0;
  y -= 24;
  asegurar(Math.max(altoTotales, altoDesglose) + altoObsCorta);

  const xTipo = MARGEN;
  const xBase = MARGEN + 120;
  const xCuota = MARGEN + 200;
  let yi = y;
  etiqueta(p, 'Desglose de IVA', xTipo, yi);
  yi -= 15;
  texto(p, 'Tipo', xTipo, yi, { tam: 8, color: GRIS });
  texto(p, 'Base', xBase, yi, { tam: 8, color: GRIS, alinear: 'der' });
  texto(p, 'Cuota', xCuota, yi, { tam: 8, color: GRIS, alinear: 'der' });
  yi -= 13;
  for (const [t, v] of tipos) {
    texto(p, pct(t), xTipo, yi, { tam: 8.5, fuente: mono });
    texto(p, eur(v.base), xBase, yi, { tam: 8.5, fuente: mono, alinear: 'der' });
    texto(p, eur(v.cuota), xCuota, yi, { tam: 8.5, fuente: mono, alinear: 'der' });
    yi -= 13;
  }
  if (hayExento) {
    yi -= 3;
    texto(p, 'IVA 0 %: operación exenta o no sujeta', xTipo, yi, { tam: 8, color: GRIS });
    yi -= 13;
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
  texto(p, esProforma ? 'Total' : 'Total factura', xEtq, yt, { tam: 10.5, fuente: negrita });
  texto(p, eur(f.totalFactura), derecha, yt, { tam: 10.5, fuente: monoNegrita, alinear: 'der' });
  y = Math.min(yi, yt) - 28;

  // ---------- Observaciones ----------
  if (obs.length) {
    asegurar(14 + Math.min(obs.length, 3) * 12);
    etiqueta(p, 'Observaciones', MARGEN, y);
    y -= 14;
    for (const o of obs) {
      if (asegurar(12)) {
        etiqueta(p, 'Observaciones (continuación)', MARGEN, y);
        y -= 14;
      }
      texto(p, o, MARGEN, y);
      y -= 12;
    }
  }

  // ---------- Pie en todas las paginas ----------
  const pie = `${nombreEmpresa} · NIF ${nifEmpresa}${
    esBorrador ? ' · Borrador sin validez fiscal' : esProforma ? ' · Proforma sin validez fiscal' : ''
  }`;
  // Datos registrales (obligatorios en las sociedades) encima del pie, en letra pequena.
  const inscripcion = f.emisor?.inscripcion ? partir(f.emisor.inscripcion, normal, 6.5, anchoUtil) : [];
  paginas.forEach((pg, i) => {
    inscripcion.forEach((l, k) => texto(pg, l, MARGEN, PIE_Y + 11 + (inscripcion.length - 1 - k) * 8, { tam: 6.5, color: GRIS }));
    texto(pg, pie, MARGEN, PIE_Y, { tam: 7.5, color: GRIS });
    texto(pg, `Página ${i + 1} de ${paginas.length}`, derecha, PIE_Y, { tam: 7.5, color: GRIS, alinear: 'der' });
  });

  return guardarPdfA(doc, tituloDoc);
}

// ---------- Carga desde la BD ----------

export async function generarPdfFactura(companyId: string, id: string): Promise<{ nombre: string; contenido: Buffer }> {
  const factura = await prisma.incomeInvoice.findFirst({
    where: { id, companyId },
    include: { lineas: true, customer: true },
  });
  if (!factura) throw notFound('Factura no encontrada.');

  const [empresa, original, cuenta, compania] = await Promise.all([
    prisma.legalConfig.findUnique({ where: { companyId } }).catch(() => null),
    factura.facturaOriginalId
      ? prisma.incomeInvoice.findFirst({ where: { id: factura.facturaOriginalId, companyId } })
      : Promise.resolve(null),
    prisma.bankAccount.findFirst({ where: { companyId, activa: true }, orderBy: { createdAt: 'asc' } }).catch(() => null),
    prisma.company.findUnique({ where: { id: companyId }, select: { name: true } }).catch(() => null),
  ]);

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
    baseTotal: Number(factura.baseTotal),
    ivaTotal: Number(factura.ivaTotal),
    retencionTotal: Number(factura.retencionTotal),
    totalFactura: Number(factura.totalFactura),
    observaciones: factura.observaciones,
    lineas: factura.lineas.map((l) => ({
      descripcion: l.descripcion,
      cantidad: Number(l.cantidad),
      precioUnitario: Number(l.precioUnitario),
      descuentoPorcentaje: Number(l.descuentoPorcentaje ?? 0),
      tipoIva: Number(l.tipoIva),
      ivaImporte: Number(l.ivaImporte),
      baseLine: Number(l.baseLine),
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
        }
      : null,
    original: original ? { numeroCompleto: original.numeroCompleto, fechaEmision: original.fechaEmision } : null,
    cuenta: cuenta?.iban ? { iban: cuenta.iban, bic: cuenta.bic ?? null } : null,
    logo: empresa?.logo && empresa.logoMime ? { bytes: new Uint8Array(empresa.logo), mime: empresa.logoMime } : null,
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
 */
export async function avisosFactura(companyId: string, id: string): Promise<string[]> {
  const factura = await prisma.incomeInvoice.findFirst({ where: { id, companyId }, include: { customer: true } });
  if (!factura) throw notFound('Factura no encontrada.');
  const [empresa, cuenta] = await Promise.all([
    prisma.legalConfig.findUnique({ where: { companyId }, select: { denominacion: true, nif: true, domicilioSocial: true, logoMime: true } }),
    prisma.bankAccount.findFirst({ where: { companyId, activa: true }, select: { id: true } }),
  ]);
  const avisos: string[] = [];
  if (!empresa?.denominacion?.trim()) avisos.push('EMISOR_DENOMINACION');
  if (!empresa?.nif?.trim()) avisos.push('EMISOR_NIF');
  if (!empresa?.domicilioSocial?.trim()) avisos.push('EMISOR_DOMICILIO');
  if (!empresa?.logoMime) avisos.push('EMISOR_LOGO');
  const c = factura.customer;
  if (!c.direccion?.trim() || !(c.cp?.trim() || c.municipio?.trim())) avisos.push('CLIENTE_DIRECCION');
  if (factura.formaPago === 'TRANSFERENCIA' && !cuenta) avisos.push('CUENTA_BANCARIA');
  return avisos;
}
