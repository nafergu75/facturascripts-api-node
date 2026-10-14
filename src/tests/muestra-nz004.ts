// Los 7 articulos de la factura de muestra NZ004_26 (plantilla A, envases e
// IEEPNR), con sus cifras exactas. Los tests la usan con un cliente y un IBAN
// ficticios: el repo es publico.
//
// Cifras de la muestra:
//   articulos 6.974,88 + IEEPNR 177,75 = subtotal (base) 7.152,63
//   IVA 21 % 1.502,05 (sobre el subtotal; linea a linea darian 1.502,04)
//   total 8.654,68; kg 394,992; packs 9.826; uds 46.320

export interface LineaMuestra {
  descripcion: string;
  textoAdicional: string | null;
  packs: number;
  /** UDS (la cantidad). */
  cantidad: number;
  kgPlastico: number;
  precioUnitario: number;
  /** TOTAL del articulo en la muestra (uds × precio). */
  totalArticulo: number;
  /** IEEPNR de la muestra (kg × 0,45). */
  ieepnr: number;
}

export const LINEAS_NZ004: LineaMuestra[] = [
  { descripcion: 'LIMON 6% FREEWAY 2,0L P P4 MP', textoAdicional: 'Unidad 2,00 L Refrescos SR', packs: 768, cantidad: 3072, kgPlastico: 103.089, precioUnitario: 0.162, totalArticulo: 497.66, ieepnr: 46.39 },
  { descripcion: 'NARANJA CINTRA 1.5L P P6 P X', textoAdicional: 'Cod. RPA Azúcar: 6B30250\nUnidad 1,5 L Refrescos SR', packs: 1092, cantidad: 6552, kgPlastico: 176.17, precioUnitario: 0.145, totalArticulo: 950.04, ieepnr: 79.28 },
  { descripcion: 'NARANJA CINTRA 1.5L P P6 P X', textoAdicional: 'Cod. RPA Azúcar: 6B30250\nUnidad 1,5 L Refrescos SR', packs: 76, cantidad: 456, kgPlastico: 12.267, precioUnitario: 0.145, totalArticulo: 66.12, ieepnr: 5.52 },
  { descripcion: 'LIMA LIMON FREEWAY 2L P P4 MP ESP-PT', textoAdicional: 'Unidad 2,00 L Refrescos SR', packs: 384, cantidad: 1536, kgPlastico: 56.311, precioUnitario: 0.141, totalArticulo: 216.58, ieepnr: 25.34 },
  { descripcion: 'LIMON 6% FREEWAY 2,0L P P4 MP', textoAdicional: 'Unidad 2,00 L Refrescos SR', packs: 144, cantidad: 576, kgPlastico: 19.333, precioUnitario: 0.162, totalArticulo: 93.31, ieepnr: 8.7 },
  { descripcion: 'PIÑA BRIZO 33CL L B24SH P X', textoAdicional: 'Unidad 0,33 L Refrescos SR', packs: 234, cantidad: 5616, kgPlastico: 2.489, precioUnitario: 0.176, totalArticulo: 988.42, ieepnr: 1.12 },
  { descripcion: 'MALIA YAMBY 33 CL L B4X6 P X (1a)', textoAdicional: 'Unidad 0,33 L Cerveza SR\nALC. 0,0%VOL.18,10 GRADOS PLATO', packs: 7128, cantidad: 28512, kgPlastico: 25.333, precioUnitario: 0.146, totalArticulo: 4162.75, ieepnr: 11.4 },
];

export const TOTALES_NZ004 = {
  articulos: 6974.88,
  ieepnr: 177.75,
  base: 7152.63,
  iva: 1502.05,
  ivaPorLinea: 1502.04,
  total: 8654.68,
  kgPlastico: 394.992,
  packs: 9826,
  uds: 46320,
  pesoBrutoKg: 24528.62,
};
