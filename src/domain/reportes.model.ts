export interface FilaMargen {
  clave: string; // clienteId, productoId, etc.
  nombre: string;
  ventas: number;
  coste: number;
  margen: number;
  margenPorcentaje: number;
}

export interface ReporteMargen {
  companyId: string;
  ejercicio: number;
  criterio: 'cliente' | 'producto' | 'centroCoste';
  filas: FilaMargen[];
}
