// Representacion ligera de un asiento tal como lo devuelve el listado de FS.
export interface Asiento {
  numero?: number;
  fecha?: string;
  concepto?: string;
  idempresa?: number;
  [key: string]: unknown;
}

/** Una linea (apunte) de un asiento contable generado. */
export interface LineaAsiento {
  subcuenta: string;
  debe: number;
  haber: number;
  concepto: string;
}

/** Asiento contable generado por el motor de reglas, listo para mapear a FS. */
export interface AsientoContableGenerado {
  fecha: string;
  descripcion: string;
  lineas: LineaAsiento[];
  debeTotal: number;
  haberTotal: number;
}
