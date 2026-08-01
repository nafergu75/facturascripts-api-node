import { CampoDiseno } from '../common/aeat-encoder';

/**
 * Diseno del Modelo 349 (operaciones intracomunitarias). Plano: Tipo 1
 * declarante + N Tipo 2 (un operador por registro), 500 chars cada uno. SIN
 * envoltura <T> (como el 347). Importes SIN signo (regla 349).
 */
export const LONGITUD_REGISTRO_349 = 500;

export const CAMPOS_349_TIPO1: CampoDiseno[] = [
  { nombre: 'tipoRegistro', posicionInicio: 1, longitud: 1, tipo: 'AN' },
  { nombre: 'modelo', posicionInicio: 2, longitud: 3, tipo: 'AN' },
  { nombre: 'ejercicio', posicionInicio: 5, longitud: 4, tipo: 'N' },
  { nombre: 'nif', posicionInicio: 9, longitud: 9, tipo: 'AN' },
  { nombre: 'razonSocial', posicionInicio: 18, longitud: 40, tipo: 'AN' },
  { nombre: 'periodo', posicionInicio: 136, longitud: 2, tipo: 'AN' },
  { nombre: 'numOperadores', posicionInicio: 138, longitud: 9, tipo: 'N' },
  { nombre: 'importeOperaciones', posicionInicio: 147, longitud: 15, tipo: 'N', decimales: 2 },
];

export const CAMPOS_349_TIPO2: CampoDiseno[] = [
  { nombre: 'tipoRegistro', posicionInicio: 1, longitud: 1, tipo: 'AN' },
  { nombre: 'modelo', posicionInicio: 2, longitud: 3, tipo: 'AN' },
  { nombre: 'ejercicio', posicionInicio: 5, longitud: 4, tipo: 'N' },
  { nombre: 'nifDeclarante', posicionInicio: 9, longitud: 9, tipo: 'AN' },
  { nombre: 'nifOperador', posicionInicio: 76, longitud: 17, tipo: 'AN' },
  { nombre: 'nombreOperador', posicionInicio: 93, longitud: 40, tipo: 'AN' },
  { nombre: 'clave', posicionInicio: 133, longitud: 1, tipo: 'AN' },
  { nombre: 'baseImponible', posicionInicio: 134, longitud: 13, tipo: 'N', decimales: 2 },
];
