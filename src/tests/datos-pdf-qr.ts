/**
 * Datos ficticios para los tests del QR de VERI*FACTU en el PDF (el repo es
 * publico: cliente, IBAN y empresa inventados). Las plantillas A y B llevan los
 * articulos y las cifras de sus muestras (NZ004_26 y NZ013_26).
 *
 * Tambien sirve para generar a mano las imagenes de muestra, por eso no importa
 * nada de jest.
 */
import { deflateSync } from 'zlib';
import type { DatosFacturaPdf } from '../services/facturaPdf.service';
import { LINEAS_NZ004, TOTALES_NZ004 } from './muestra-nz004';
import { LINEAS_NZ013, TOTALES_NZ013 } from './muestra-nz013';

export const comunPdfQr = {
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

export const lineaSimplePdfQr = (i: number) => ({ descripcion: `Servicio de consultoría ${i}`, cantidad: 1, precioUnitario: 100, descuentoPorcentaje: 0, tipoIva: 21, ivaImporte: 21, baseLine: 100, tipoRetencion: 0 });

/** Factura de una linea con el diseno de siempre. */
export const estandarPdfQr = (extra: Partial<DatosFacturaPdf> = {}): DatosFacturaPdf => ({
  ...comunPdfQr,
  numeroCompleto: 'A-1',
  tipoFactura: 'F1',
  baseTotal: 100,
  ivaTotal: 21,
  totalFactura: 121,
  plantilla: null,
  lineas: [lineaSimplePdfQr(1)],
  ...extra,
});

const IVA_A = [114.25, 216.16, 15.05, 50.8, 21.42, 207.8, 876.57];
/** Plantilla A con los 7 articulos de NZ004_26 (7.152,63 + 1.502,05 = 8.654,68). */
export const plantillaAPdfQr = (extra: Partial<DatosFacturaPdf> = {}): DatosFacturaPdf => ({
  ...comunPdfQr,
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
/** Plantilla B con las lineas de NZ013_26 (600,74 + 126,16 = 726,90). */
export const plantillaBPdfQr = (extra: Partial<DatosFacturaPdf> = {}): DatosFacturaPdf => ({
  ...comunPdfQr,
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

/** Rectificativa por diferencias de la factura A-0 (para las tres plantillas). */
export const rectificativaPdfQr = { tipoFactura: 'R1', esRectificativa: true, tipoRectificativa: 'I', original: { numeroCompleto: 'A-0', fechaEmision: '2026-01-01' } } as const;

/** Cliente de fuera con el nombre y la direccion largos (inventados). */
export const clienteLargoPdfQr = {
  nombreFiscal: 'INTERNATIONAL BEVERAGE DISTRIBUTION AND LOGISTICS COMPANY OF NORTHERN EUROPE GMBH & CO. KG',
  nifCif: 'DE123456789',
  direccion: 'INDUSTRIESTRASSE 1234, GEWERBEGEBIET NORD, HALLE 7, TOR 12, ZU HAENDEN DER BUCHHALTUNG',
  cp: '20095',
  municipio: 'HAMBURG-WILHELMSBURG',
  provincia: 'FREIE UND HANSESTADT HAMBURG',
  pais: 'DE',
} as const;

// ---------- Imagenes PNG de colores lisos (logos de prueba) ----------

const TABLA_CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = TABLA_CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const trozo = (tipo: string, datos: Buffer) => {
  const t = Buffer.from(tipo, 'latin1');
  const largo = Buffer.alloc(4);
  largo.writeUInt32BE(datos.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, datos])));
  return Buffer.concat([largo, t, datos, crc]);
};

/** PNG de `ancho` x `alto` pixeles de un solo color (RGB, 8 bits). */
export function pngLiso(ancho: number, alto: number, [r, g, b]: [number, number, number]): Uint8Array {
  const cabecera = Buffer.alloc(13);
  cabecera.writeUInt32BE(ancho, 0);
  cabecera.writeUInt32BE(alto, 4);
  cabecera.set([8, 2, 0, 0, 0], 8);
  const fila = Buffer.alloc(1 + ancho * 3);
  for (let x = 0; x < ancho; x++) fila.set([r, g, b], 1 + x * 3);
  const crudo = Buffer.concat(Array.from({ length: alto }, () => fila));
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), trozo('IHDR', cabecera), trozo('IDAT', deflateSync(crudo)), trozo('IEND', Buffer.alloc(0))]),
  );
}

/** Logo de la empresa (300 x 110, azul) y de la marca (300 x 110, rojo), como los de las muestras de F2. */
export const logosPdfQr = () => ({
  logo: { bytes: pngLiso(300, 110, [26, 77, 153]), mime: 'image/png' },
  logoMarca: { bytes: pngLiso(300, 110, [179, 51, 26]), mime: 'image/png' },
});
