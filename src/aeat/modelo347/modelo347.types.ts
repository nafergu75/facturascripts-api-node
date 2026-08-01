/** Datos de negocio del Modelo 347 (operaciones con terceros). */
export interface Declarante347Dom {
  nif: string;
  razonSocial: string;
  ejercicio: number;
  numPersonas: number;
  importeTotal: number;
}

export interface Declarado347Dom {
  nifDeclarante: string;
  nifDeclarado: string;
  razonSocial: string;
  clave: 'A' | 'B'; // A adquisiciones (compras) / B entregas (ventas)
  importeAnual: number;
  ejercicio: number;
}
