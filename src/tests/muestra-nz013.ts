// Las lineas de la factura de muestra NZ013_2026 (plantilla B, ceramica), con
// sus cifras exactas. Los tests la usan con un cliente y un IBAN ficticios: el
// repo es publico.
//
// Cifras de la muestra:
//   61,74 (5,04 m2 × 12,25) + 530,00 (20 piezas × 26,50) + 9,00 (1 palet de
//   madera × 9,00) = TOTAL BRUTO (base) 600,74
//   IVA 21 % 126,16; TOTAL FACTURA 726,90
//   palets 1, m2 12,94, piezas 38 (la muestra pone 60 cajas; las lineas suman 13)
//   peso neto 353 y bruto 373, escritos a mano

import type { UnidadPrecio } from '../domain/ceramica';

export interface LineaMuestraB {
  descripcion: string;
  textoAdicional: string | null;
  palets: number | null;
  cajas: number | null;
  metros2: number | null;
  piezas: number | null;
  formato: string | null;
  calidad: string | null;
  unidadPrecio: UnidadPrecio;
  /** La cantidad de la unidad del precio (m2, piezas o unidades). */
  cantidad: number;
  precioUnitario: number;
  /** IMPORTE de la muestra. */
  importe: number;
  cargoPalets?: boolean;
}

export const LINEAS_NZ013: LineaMuestraB[] = [
  {
    descripcion: 'MOGAN NATURAL',
    textoAdicional: 'PORCELANICO RECTIFICADO',
    palets: 0,
    cajas: 3,
    metros2: 5.04,
    piezas: 18,
    formato: '23,3x120',
    calidad: '1',
    unidadPrecio: 'M2',
    cantidad: 5.04,
    precioUnitario: 12.25,
    importe: 61.74,
  },
  {
    descripcion: 'PELDAÑO MULTIESTEP',
    textoAdicional: 'MOGAN NATURAL PRCELANICO 14 MM',
    palets: 1,
    cajas: 10,
    metros2: 7.9,
    piezas: 20,
    formato: '33X120',
    calidad: '1',
    unidadPrecio: 'PIEZA',
    cantidad: 20,
    precioUnitario: 26.5,
    importe: 530,
  },
  {
    descripcion: 'PALETS DE MADERA TRATADA',
    textoAdicional: null,
    palets: null,
    cajas: null,
    metros2: null,
    piezas: null,
    formato: null,
    calidad: null,
    unidadPrecio: 'UNIDAD',
    cantidad: 1,
    precioUnitario: 9,
    importe: 9,
    cargoPalets: true,
  },
];

export const TOTALES_NZ013 = {
  base: 600.74,
  iva: 126.16,
  total: 726.9,
  palets: 1,
  /** Lo que suman las lineas (la muestra pone 60, un error de su hoja de calculo). */
  cajas: 13,
  metros2: 12.94,
  piezas: 38,
  pesoNetoKg: 353,
  pesoBrutoKg: 373,
  obra: null as string | null,
  observaciones:
    'ESTE PRESUPUESTO NO INCLUYE EL TRANSPORTE\nEL TRANSPORTE SE FACTURARA APARTE EN FUNCION DE LAS\nNECESIDADES DE SUMINISTRO DEL MATERIAL QUE NOS INDIQUE EL CLIENTE',
};
