import { CampoDiseno } from '../common/aeat-encoder';

/**
 * Diseno del Modelo 115 (retenciones por arrendamiento) — pagina DR11501,
 * longitud 500. Envoltura <AUX>. Fuente: 115.xls.
 */
export const LONGITUD_REGISTRO_115 = 500;

export const CAMPOS_115_DR11501: CampoDiseno[] = [
  { nombre: 'nif', posicionInicio: 14, longitud: 9, tipo: 'AN' },
  { nombre: 'razonSocial', posicionInicio: 23, longitud: 80, tipo: 'AN' },
  { nombre: 'ejercicio', posicionInicio: 103, longitud: 4, tipo: 'N' },
  { nombre: 'periodo', posicionInicio: 107, longitud: 2, tipo: 'AN' },
  { nombre: 'nPerceptores01', posicionInicio: 109, longitud: 15, tipo: 'N' },
  { nombre: 'baseRetenciones02', posicionInicio: 124, longitud: 17, tipo: 'N', decimales: 2 },
  { nombre: 'retenciones03', posicionInicio: 141, longitud: 17, tipo: 'N', decimales: 2 },
  { nombre: 'resultadoAnteriores04', posicionInicio: 158, longitud: 17, tipo: 'N', decimales: 2 },
  { nombre: 'resultadoIngresar05', posicionInicio: 175, longitud: 17, tipo: 'N', decimales: 2 },
];
