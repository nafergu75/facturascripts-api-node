/**
 * Cabecera <AUX> y cierre de los ficheros de autoliquidación de la AEAT
 * (303, 111, 115, 202, 390 y 200): un solo sitio para todos.
 *
 * Todos los diseños comparten la misma cabecera de 328 posiciones (hoja
 * DP30300 del 303 2026 y equivalentes del 111, 115, 202, 390 y 200):
 *   1-17   <T + modelo (3) + "0" + ejercicio (4) + periodo (2) + "0000>"
 *   18-22  <AUX>
 *   23-92  reservado (blancos)
 *   93-96  versión del programa (An 4)
 *   97-100 reservado
 *   101-109 NIF de la entidad desarrolladora (An 9)
 *   110-322 reservado
 *   323-328 </AUX>
 * y el mismo cierre de 18: </T + modelo + "0" + ejercicio + periodo + "0000>".
 *
 * Los modelos informativos (347, 349, 180, 190) no llevan <AUX>: su registro
 * de tipo 1 identifica la declaración.
 */
import { normalizarNif, validarNifEspanol } from '../../utils/nif';

/**
 * NIF de la entidad desarrolladora del programa: IFBIOSOLUCIONES, S.A.
 * (decisión del usuario del 11-10-2026). Se puede cambiar sin tocar el código
 * con la variable de entorno AEAT_NIF_EMPRESA_DESARROLLO.
 */
export const NIF_EMPRESA_DESARROLLO_POR_DEFECTO = 'A10952364';

/** Versión de Conta API que va en todos los ficheros de la AEAT (posición 93). */
export const VERSION_PROGRAMA_AEAT = '0100';

/**
 * NIF de la entidad desarrolladora: el de AEAT_NIF_EMPRESA_DESARROLLO si es un
 * NIF español válido; si no está o no vale, A10952364.
 */
export function nifEmpresaDesarrollo(): string {
  const nif = normalizarNif(process.env.AEAT_NIF_EMPRESA_DESARROLLO ?? '');
  return nif && validarNifEspanol(nif).valido ? nif : NIF_EMPRESA_DESARROLLO_POR_DEFECTO;
}

/** Datos del programa que van en la cabecera. */
export interface ProgramaAeat {
  versionPrograma: string;
  nifEmpresaDesarrollo: string;
}

/** Versión y NIF de la entidad desarrolladora de hoy. */
export function programaAeat(): ProgramaAeat {
  return { versionPrograma: VERSION_PROGRAMA_AEAT, nifEmpresaDesarrollo: nifEmpresaDesarrollo() };
}

function etiquetaModelo(modelo: string, ejercicio: number, periodo: string): string {
  if (!/^\d{3}$/.test(modelo)) throw new Error(`Modelo "${modelo}" no válido para la cabecera <AUX>.`);
  if (!/^[0-9A-Z]{2}$/.test(periodo)) throw new Error(`Periodo "${periodo}" no válido para la cabecera <AUX>.`);
  return `${modelo}0${String(ejercicio).padStart(4, '0')}${periodo}0000>`;
}

/** Cabecera <T...><AUX>...</AUX> de 328 posiciones. */
export function cabeceraAux(modelo: string, ejercicio: number, periodo: string, programa: ProgramaAeat = programaAeat()): string {
  const version = programa.versionPrograma.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4).padEnd(4, ' ');
  const nif = normalizarNif(programa.nifEmpresaDesarrollo).slice(0, 9).padEnd(9, ' ');
  const out =
    `<T${etiquetaModelo(modelo, ejercicio, periodo)}` +
    '<AUX>' +
    ' '.repeat(70) +
    version +
    ' '.repeat(4) +
    nif +
    ' '.repeat(213) +
    '</AUX>';
  if (out.length !== 328) throw new Error(`La cabecera <AUX> mide ${out.length} y tiene que medir 328.`);
  return out;
}

/** Cierre del fichero (18 posiciones): </T + modelo + 0 + ejercicio + periodo + 0000>. */
export function cierreAux(modelo: string, ejercicio: number, periodo: string): string {
  return `</T${etiquetaModelo(modelo, ejercicio, periodo)}`;
}
