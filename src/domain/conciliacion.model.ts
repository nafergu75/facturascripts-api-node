export interface MovimientoBanco {
  id?: string;
  fecha: string; // yyyy-mm-dd
  importe: number; // positivo = ingreso, negativo = cargo
  concepto: string;
  referencia?: string;
}

export interface AsientoCandidato {
  asientoId: string;
  fecha: string;
  importe: number;
  concepto: string;
  score: number; // 0..1
}

export interface SugerenciaConciliacion {
  movimientoBanco: MovimientoBanco;
  asientosCandidatos: AsientoCandidato[];
}
