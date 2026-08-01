import { CampoDiseno } from '../common/aeat-encoder';

/**
 * Diseno del Modelo 111 (retenciones IRPF) — pagina M11101, longitud 1000.
 * Envoltura <AUX>. Fuente: 111.xls.
 */
export const LONGITUD_REGISTRO_111 = 1000;

export const CAMPOS_111_M11101: CampoDiseno[] = [
  { nombre: 'nif', posicionInicio: 14, longitud: 9, tipo: 'AN' },
  { nombre: 'denominacion', posicionInicio: 23, longitud: 80, tipo: 'AN' },
  { nombre: 'ejercicio', posicionInicio: 103, longitud: 4, tipo: 'N' },
  { nombre: 'periodo', posicionInicio: 107, longitud: 2, tipo: 'AN' },
  { nombre: 'nPerceptoresTrabajo', posicionInicio: 109, longitud: 8, tipo: 'N' },
  { nombre: 'percepcionesTrabajo', posicionInicio: 117, longitud: 17, tipo: 'N', decimales: 2 },
  { nombre: 'retencionesTrabajo', posicionInicio: 134, longitud: 17, tipo: 'N', decimales: 2 },
  { nombre: 'totalRetenciones28', posicionInicio: 487, longitud: 17, tipo: 'N', decimales: 2 },
  { nombre: 'resultadoIngresar30', posicionInicio: 521, longitud: 17, tipo: 'N', decimales: 2 },
];
