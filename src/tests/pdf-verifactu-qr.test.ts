/**
 * QR de VERI*FACTU en el PDF de la factura (spec verifactu, 5.2; plan F2, 5.4),
 * sin BD, en los tres dibujos (el de siempre, la plantilla A y la B):
 *  - «QR tributario:» justo encima del QR y la leyenda justo debajo, centrados;
 *  - ningun otro texto dentro del QR ni de su zona en blanco;
 *  - letra de los textos del QR: la mayor de los datos de cada plantilla;
 *  - solo en la primera pagina, aunque la factura tenga varias;
 *  - marca «PRUEBAS – SIN VALIDEZ» con un registro de pruebas o en una empresa de pruebas;
 *  - un titulo largo no pisa el bloque;
 *  - borradores, proformas y facturas del lector nunca llevan QR.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import type { PDFFont } from 'pdf-lib';
import { renderizarFactura, TAM_QR_ESTANDAR, type DatosFacturaPdf } from '../services/facturaPdf.service';
import { HUECO_QR_A, TAM_QR_A } from '../services/facturaPdfPlantillaA';
import { FRANJA_QR_B, TAM_QR_B } from '../services/facturaPdfPlantillaB';
import { ANCHO_BLOQUE_QR, calcularBloqueQr, LEYENDA_QR, MARCA_PRUEBAS, TITULO_QR, type CajasBloqueQr } from '../services/verifactu/qrPdf';
import { urlCotejo } from '../services/verifactu/qr';
import { crearDocumentoPdfA } from '../utils/pdf-a';
import { textosDePdf, type TextoPdf } from './texto-pdf';
import { LINEAS_NZ004, TOTALES_NZ004 } from './muestra-nz004';
import { LINEAS_NZ013, TOTALES_NZ013 } from './muestra-nz013';

jest.setTimeout(120_000);

const ANCHO = 595.28;
const ALTO = 841.89;
const URL_PRO = urlCotejo({ entorno: 'PRODUCCION', idEmisor: 'B12345674', numSerie: 'A-1', fechaExpedicion: '04-03-2026', importeTotal: '121.00' });
const URL_PRU = urlCotejo({ entorno: 'PRUEBAS', idEmisor: 'B12345674', numSerie: 'PRU261015-1', fechaExpedicion: '04-03-2026', importeTotal: '121.00' });

const comun = {
  id: 'f1',
  estadoDocumento: 'FINAL',
  formaPago: 'TRANSFERENCIA',
  tipoRectificativa: null,
  motivoRectificacion: null,
  esRectificativa: false,
  fechaEmision: '2026-03-04',
  fechaVencimiento: '2026-04-03',
  retencionTotal: 0,
  observaciones: null,
  original: null,
  cuenta: { iban: 'ES9121000418450200051332', bic: 'CAIXESBBXXX', bancoNombre: 'Banco de pruebas' },
  moneda: 'EUR',
  monedaCuenta: 'EUR',
  tipoCambio: 1,
  fuenteTipoCambio: 'PAR',
  conIva: true,
  cliente: { nombreFiscal: 'CLIENTE FICTICIO SL', nifCif: 'B00000000', direccion: 'CALLE FALSA, 1', cp: '46000', municipio: 'VALENCIA', provincia: 'VALENCIA', pais: 'ES' },
  emisor: {
    denominacion: 'EMPRESA DE PRUEBA S.L.',
    nif: 'B12345674',
    domicilioSocial: 'CALLE INVENTADA, 2',
    codigoPostal: '12200',
    municipio: 'ONDA',
    provincia: 'CASTELLON',
    pais: 'ES',
    datosRegistrales: 'T 1, L 2, F 3, S 8, H CS 4, I/A 1',
    registroMercantilProvincia: 'Castellón',
  },
} as const;

const lineaSimple = (i: number) => ({ descripcion: `Servicio de consultoría ${i}`, cantidad: 1, precioUnitario: 100, descuentoPorcentaje: 0, tipoIva: 21, ivaImporte: 21, baseLine: 100, tipoRetencion: 0 });

const estandar = (extra: Partial<DatosFacturaPdf> = {}): DatosFacturaPdf => ({
  ...comun,
  numeroCompleto: 'A-1',
  tipoFactura: 'F1',
  baseTotal: 100,
  ivaTotal: 21,
  totalFactura: 121,
  plantilla: null,
  lineas: [lineaSimple(1)],
  ...extra,
});

const IVA_A = [114.25, 216.16, 15.05, 50.8, 21.42, 207.8, 876.57];
const plantillaA = (extra: Partial<DatosFacturaPdf> = {}): DatosFacturaPdf => ({
  ...comun,
  numeroCompleto: 'A-1',
  tipoFactura: 'F1',
  baseTotal: TOTALES_NZ004.base,
  ivaTotal: TOTALES_NZ004.iva,
  totalFactura: TOTALES_NZ004.total,
  plantilla: 'A',
  pesoBrutoKg: TOTALES_NZ004.pesoBrutoKg,
  lineas: LINEAS_NZ004.map((l, i) => ({
    descripcion: l.descripcion,
    textoAdicional: l.textoAdicional,
    packs: l.packs,
    cantidad: l.cantidad,
    kgPlastico: l.kgPlastico,
    precioUnitario: l.precioUnitario,
    descuentoPorcentaje: 0,
    tipoIva: 21,
    ivaImporte: IVA_A[i],
    baseLine: Math.round((l.totalArticulo + l.ieepnr) * 100) / 100,
    ieepnrImporte: l.ieepnr,
    tipoRetencion: 0,
  })),
  ...extra,
});

const IVA_B = [12.97, 111.3, 1.89];
const plantillaB = (extra: Partial<DatosFacturaPdf> = {}): DatosFacturaPdf => ({
  ...comun,
  numeroCompleto: 'B-13',
  tipoFactura: 'F1',
  baseTotal: TOTALES_NZ013.base,
  ivaTotal: TOTALES_NZ013.iva,
  totalFactura: TOTALES_NZ013.total,
  observaciones: TOTALES_NZ013.observaciones,
  plantilla: 'B',
  pesoNetoKg: TOTALES_NZ013.pesoNetoKg,
  pesoBrutoKg: TOTALES_NZ013.pesoBrutoKg,
  lineas: LINEAS_NZ013.map((l, i) => ({
    descripcion: l.descripcion,
    textoAdicional: l.textoAdicional,
    cantidad: l.cantidad,
    precioUnitario: l.precioUnitario,
    descuentoPorcentaje: 0,
    tipoIva: 21,
    ivaImporte: IVA_B[i],
    baseLine: l.importe,
    tipoRetencion: 0,
    unidadPrecio: l.unidadPrecio,
    ...(l.cargoPalets ? { cargoPalets: true } : { palets: l.palets, cajas: l.cajas, metros2: l.metros2, piezas: l.piezas, formato: l.formato, calidad: l.calidad }),
  })),
  ...extra,
});

let fuentes: { normal: PDFFont; negrita: PDFFont };
beforeAll(async () => {
  const d = await crearDocumentoPdfA('medidas');
  fuentes = { normal: d.normal, negrita: d.negrita };
});

/** Donde tiene que estar el bloque en cada dibujo (las mismas cuentas que la plantilla). */
const PLANTILLAS: Array<{ nombre: string; datos: (e?: Partial<DatosFacturaPdf>) => DatosFacturaPdf; tam: number; bloque: () => CajasBloqueQr }> = [
  { nombre: 'estándar', datos: estandar, tam: TAM_QR_ESTANDAR, bloque: () => calcularBloqueQr({ ...fuentes, xCentro: ANCHO / 2, yArriba: ALTO - 36, tam: TAM_QR_ESTANDAR }) },
  {
    nombre: 'A',
    datos: plantillaA,
    tam: TAM_QR_A,
    bloque: () =>
      calcularBloqueQr({
        ...fuentes,
        xCentro: (HUECO_QR_A.izq + HUECO_QR_A.der) / 2,
        yArriba: ALTO - HUECO_QR_A.arriba,
        tam: TAM_QR_A,
        anchoMax: Math.min(ANCHO_BLOQUE_QR, HUECO_QR_A.der - HUECO_QR_A.izq - 4),
      }),
  },
  { nombre: 'B', datos: plantillaB, tam: TAM_QR_B, bloque: () => calcularBloqueQr({ ...fuentes, xCentro: ANCHO / 2, yArriba: ALTO - FRANJA_QR_B.arriba, tam: TAM_QR_B }) },
];

const esMarca = (t: TextoPdf) => t.texto === MARCA_PRUEBAS || t.texto === 'BORRADOR';
const esDelQr = (t: TextoPdf) => t.texto === TITULO_QR || LEYENDA_QR.includes(t.texto);
/** Caja aproximada de un texto: de su base menos el descendente a la altura de las mayusculas. */
const solapa = (t: TextoPdf, c: { x: number; y: number; ancho: number; alto: number }) =>
  t.x < c.x + c.ancho && t.derecha > c.x && t.y - 0.25 * t.tam < c.y + c.alto && t.y + 0.75 * t.tam > c.y;
const centroX = (t: TextoPdf) => (t.x + t.derecha) / 2;

describe.each(PLANTILLAS)('QR de VERI*FACTU en la plantilla $nombre', ({ datos, tam, bloque }) => {
  it('«QR tributario:» encima, la leyenda debajo, centrados, y nada mas dentro del QR ni de su zona en blanco', async () => {
    const ts = await textosDePdf(await renderizarFactura(datos({ verifactu: { url: URL_PRO, entorno: 'PRODUCCION' } })));
    const b = bloque();
    const xCentro = b.cajaBloque.x + b.cajaBloque.ancho / 2;
    const titulo = ts.filter((t) => t.texto === TITULO_QR);
    expect(titulo).toHaveLength(1);
    expect(titulo[0].pagina).toBe(1);
    expect(titulo[0].tam).toBe(tam);
    expect(Math.abs(centroX(titulo[0]) - xCentro)).toBeLessThan(1);
    // Justo encima de la zona en blanco.
    expect(titulo[0].y).toBeGreaterThan(b.cajaBlanca.y + b.cajaBlanca.alto);
    expect(titulo[0].y).toBeLessThan(b.cajaBlanca.y + b.cajaBlanca.alto + tam * 1.2);
    // La leyenda, en sus lineas, justo debajo y centrada.
    const leyenda = ts.filter((t) => t.pagina === 1 && t.texto !== TITULO_QR && esDelQr(t) && t.y < b.cajaBlanca.y).sort((a, z) => z.y - a.y);
    expect(leyenda.map((t) => t.texto).join(' ')).toBe(LEYENDA_QR);
    expect(leyenda[0].y).toBeGreaterThan(b.cajaBlanca.y - tam * 1.2);
    for (const l of leyenda) {
      expect(l.tam).toBe(tam);
      expect(Math.abs(centroX(l) - xCentro)).toBeLessThan(1);
    }
    // Ningun otro texto dentro del bloque (la marca de agua va debajo, tapada por el blanco).
    const dentro = ts.filter((t) => t.pagina === 1 && !esDelQr(t) && !esMarca(t) && solapa(t, b.cajaBloque));
    expect(dentro.map((t) => t.texto)).toEqual([]);
  });

  it('sin registro (o en un borrador, una proforma o una factura del lector) no hay QR', async () => {
    const conQr = { verifactu: { url: URL_PRO, entorno: 'PRODUCCION' as const } };
    for (const d of [datos(), datos({ ...conQr, estadoDocumento: 'BORRADOR', numeroCompleto: null }), datos({ ...conQr, estadoDocumento: 'PROFORMA', numeroCompleto: 'P-1' }), datos({ ...conQr, registroLector: true })]) {
      const ts = await textosDePdf(await renderizarFactura(d));
      expect(ts.some((t) => t.texto === TITULO_QR)).toBe(false);
    }
  });

  it('registro de PRUEBAS: QR y marca «PRUEBAS – SIN VALIDEZ» en cada pagina; en una empresa de pruebas, tambien en la proforma', async () => {
    const ts = await textosDePdf(await renderizarFactura(datos({ verifactu: { url: URL_PRU, entorno: 'PRUEBAS' } })));
    expect(ts.filter((t) => t.texto === MARCA_PRUEBAS).length).toBeGreaterThanOrEqual(1);
    expect(ts.some((t) => t.texto === TITULO_QR)).toBe(true);
    const proforma = await textosDePdf(await renderizarFactura(datos({ empresaPruebas: true, estadoDocumento: 'PROFORMA', numeroCompleto: 'P-1' })));
    expect(proforma.some((t) => t.texto === MARCA_PRUEBAS)).toBe(true);
    // El borrador sigue con su marca, no la de pruebas.
    const borrador = await textosDePdf(await renderizarFactura(datos({ empresaPruebas: true, estadoDocumento: 'BORRADOR', numeroCompleto: null })));
    expect(borrador.some((t) => t.texto === 'BORRADOR')).toBe(true);
    expect(borrador.some((t) => t.texto === MARCA_PRUEBAS)).toBe(false);
    // Una factura de produccion de una empresa real, sin marca.
    const real = await textosDePdf(await renderizarFactura(datos({ verifactu: { url: URL_PRO, entorno: 'PRODUCCION' } })));
    expect(real.some((t) => t.texto === MARCA_PRUEBAS)).toBe(false);
  });

  it('una rectificativa o una simplificada: el titulo no pisa el QR', async () => {
    for (const extra of [{ tipoFactura: 'R1', esRectificativa: true, tipoRectificativa: 'I', original: { numeroCompleto: 'A-0', fechaEmision: '2026-01-01' } }, { tipoFactura: 'F2' }]) {
      const ts = await textosDePdf(await renderizarFactura(datos({ ...extra, verifactu: { url: URL_PRO, entorno: 'PRODUCCION' } })));
      const b = bloque();
      const pisan = ts.filter((t) => t.pagina === 1 && !esDelQr(t) && !esMarca(t) && solapa(t, b.cajaBloque));
      expect(pisan.map((t) => t.texto)).toEqual([]);
    }
  });
});

describe('plantilla B: letra de la obra', () => {
  it('con QR no pasa de la de «QR tributario:» y su leyenda; sin QR, la de siempre (11 pt)', async () => {
    const obra = 'REFORMA LOCAL CALLE MAYOR';
    const conQr = await textosDePdf(await renderizarFactura(plantillaB({ obra, verifactu: { url: URL_PRO, entorno: 'PRODUCCION' } })));
    expect(conQr.find((t) => t.texto === obra)?.tam).toBe(TAM_QR_B);
    const sinQr = await textosDePdf(await renderizarFactura(plantillaB({ obra })));
    expect(sinQr.find((t) => t.texto === obra)?.tam).toBe(11);
  });
});

describe('QR solo en la primera pagina', () => {
  it('una factura de varias paginas lleva un solo QR, en la primera (en los tres dibujos)', async () => {
    const muchas = (d: DatosFacturaPdf) => ({ ...d, lineas: Array.from({ length: 12 }, () => d.lineas).flat(), verifactu: { url: URL_PRO, entorno: 'PRODUCCION' as const } });
    for (const d of [estandar({ lineas: Array.from({ length: 60 }, (_, i) => lineaSimple(i)) }), plantillaA(), plantillaB()]) {
      const ts = await textosDePdf(await renderizarFactura(muchas(d)));
      expect(Math.max(...ts.map((t) => t.pagina))).toBeGreaterThan(1);
      const titulos = ts.filter((t) => t.texto === TITULO_QR);
      expect(titulos.map((t) => t.pagina)).toEqual([1]);
    }
  });
});
