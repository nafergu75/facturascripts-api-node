import { CampoDiseno } from '../common/aeat-encoder';

// Diseno de registro OFICIAL del Modelo 347 (longitud 500 por registro).
// Los importes (signo + 15) se pre-formatean y se colocan como 'AN'.
export const LONGITUD_REGISTRO_347 = 500;

export const CAMPOS_347_TIPO1: CampoDiseno[] = [
  { nombre: 'tipoRegistro', posicionInicio: 1, longitud: 1, tipo: 'AN' },
  { nombre: 'modelo', posicionInicio: 2, longitud: 3, tipo: 'AN' },
  { nombre: 'ejercicio', posicionInicio: 5, longitud: 4, tipo: 'N' },
  { nombre: 'nif', posicionInicio: 9, longitud: 9, tipo: 'AN' },
  { nombre: 'razonSocial', posicionInicio: 18, longitud: 40, tipo: 'AN' },
  { nombre: 'tipoSoporte', posicionInicio: 58, longitud: 1, tipo: 'AN' },
  { nombre: 'telefono', posicionInicio: 59, longitud: 9, tipo: 'N' },
  { nombre: 'numIdentificativo', posicionInicio: 108, longitud: 13, tipo: 'AN' },
  { nombre: 'numPersonas', posicionInicio: 136, longitud: 9, tipo: 'N' },
  { nombre: 'importeTotal', posicionInicio: 145, longitud: 16, tipo: 'AN' },
  { nombre: 'numInmuebles', posicionInicio: 161, longitud: 9, tipo: 'N' },
  { nombre: 'importeArrendamientos', posicionInicio: 170, longitud: 16, tipo: 'AN' },
];

export const CAMPOS_347_TIPO2: CampoDiseno[] = [
  { nombre: 'tipoRegistro', posicionInicio: 1, longitud: 1, tipo: 'AN' },
  { nombre: 'modelo', posicionInicio: 2, longitud: 3, tipo: 'AN' },
  { nombre: 'ejercicio', posicionInicio: 5, longitud: 4, tipo: 'N' },
  { nombre: 'nifDeclarante', posicionInicio: 9, longitud: 9, tipo: 'AN' },
  { nombre: 'nifDeclarado', posicionInicio: 18, longitud: 9, tipo: 'AN' },
  { nombre: 'razonSocial', posicionInicio: 36, longitud: 40, tipo: 'AN' },
  { nombre: 'tipoHoja', posicionInicio: 76, longitud: 1, tipo: 'AN' },
  { nombre: 'provincia', posicionInicio: 77, longitud: 4, tipo: 'N' },
  { nombre: 'clave', posicionInicio: 82, longitud: 1, tipo: 'AN' },
  { nombre: 'importeAnual', posicionInicio: 83, longitud: 16, tipo: 'AN' },
  { nombre: 'importeMetalico', posicionInicio: 101, longitud: 15, tipo: 'N' },
];
