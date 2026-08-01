import { CampoDiseno } from '../common/aeat-encoder';

/**
 * Diseno del Modelo 200 (Impuesto sobre Sociedades) — pagina identificacion
 * DP200001, longitud 627. Envoltura <AUX>. El modelo tiene 77 paginas; aqui
 * solo se documenta la de identificacion (las de liquidacion son TODO).
 */
export const LONGITUD_REGISTRO_200_DP200001 = 627;

export const CAMPOS_200_DP200001: CampoDiseno[] = [
  { nombre: 'tag', posicionInicio: 1, longitud: 11, tipo: 'AN' }, // <T200...>
  { nombre: 'tipoDeclaracion', posicionInicio: 13, longitud: 1, tipo: 'AN' },
  { nombre: 'nif', posicionInicio: 14, longitud: 9, tipo: 'AN' },
  { nombre: 'razonSocial', posicionInicio: 23, longitud: 80, tipo: 'AN' },
  { nombre: 'ejercicio', posicionInicio: 103, longitud: 4, tipo: 'N' },
  { nombre: 'tipoEjercicio', posicionInicio: 107, longitud: 2, tipo: 'AN' }, // '0A'
];
