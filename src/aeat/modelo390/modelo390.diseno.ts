import { CampoDiseno } from '../common/aeat-encoder';

/**
 * Diseno del Modelo 390 (resumen anual IVA). Multipagina; se documentan las
 * casillas clave por pagina. Fuente: 390.xlsx v1.02.
 */
export const CAMPOS_390_PAGINA01: CampoDiseno[] = [
  { nombre: 'nif', posicionInicio: 14, longitud: 9, tipo: 'AN' },
  { nombre: 'razonSocial', posicionInicio: 23, longitud: 80, tipo: 'AN' },
  { nombre: 'ejercicio', posicionInicio: 103, longitud: 4, tipo: 'N' },
];

export const CAMPOS_390_PAGINA04: CampoDiseno[] = [
  { nombre: 'resultadoRegimenGeneral65', posicionInicio: 676, longitud: 17, tipo: 'N', decimales: 2 },
];

export const CAMPOS_390_PAGINA06: CampoDiseno[] = [
  { nombre: 'resultadoLiquidacionAnual84', posicionInicio: 30, longitud: 17, tipo: 'N', decimales: 2 },
  { nombre: 'resultadoAnual86', posicionInicio: 81, longitud: 17, tipo: 'N', decimales: 2 },
  { nombre: 'volumenOperaciones99', posicionInicio: 361, longitud: 17, tipo: 'N', decimales: 2 },
  { nombre: 'totalVolumen108', posicionInicio: 650, longitud: 17, tipo: 'N', decimales: 2 },
];
