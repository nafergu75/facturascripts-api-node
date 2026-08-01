import { CampoDiseno } from '../common/aeat-encoder';

/**
 * Diseno de registro del Modelo 303 (IVA) — PAGINA 01, longitud 1581.
 * Solo se documentan las casillas principales (el resto van a ceros). Los
 * importes son 'N' con 2 decimales (centimos) salvo el tipo% que va *100.
 * Fuente: diseno oficial AEAT 303 v1.01 (303.xlsx).
 */
export const LONGITUD_REGISTRO_303 = 1581;

export const CAMPOS_303_PAGINA01: CampoDiseno[] = [
  { nombre: 'nif', posicionInicio: 14, longitud: 9, tipo: 'AN' },
  { nombre: 'razonSocial', posicionInicio: 23, longitud: 80, tipo: 'AN' },
  { nombre: 'ejercicio', posicionInicio: 103, longitud: 4, tipo: 'N' },
  { nombre: 'periodo', posicionInicio: 107, longitud: 2, tipo: 'AN' },
  // Devengado regimen general
  { nombre: 'base01', posicionInicio: 209, longitud: 17, tipo: 'N', decimales: 2 },
  { nombre: 'tipo02', posicionInicio: 226, longitud: 5, tipo: 'N', decimales: 2 },
  { nombre: 'cuota03', posicionInicio: 231, longitud: 17, tipo: 'N', decimales: 2 },
  { nombre: 'totalCuotaDevengada27', posicionInicio: 696, longitud: 17, tipo: 'N', decimales: 2 },
  // Deducible
  { nombre: 'base28', posicionInicio: 713, longitud: 17, tipo: 'N', decimales: 2 },
  { nombre: 'cuota29', posicionInicio: 730, longitud: 17, tipo: 'N', decimales: 2 },
  { nombre: 'totalDeducir45', posicionInicio: 1002, longitud: 17, tipo: 'N', decimales: 2 },
  { nombre: 'resultadoRegimenGeneral46', posicionInicio: 1019, longitud: 17, tipo: 'N', decimales: 2 },
];
