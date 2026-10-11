/**
 * Diseño de registro del Modelo 303 (IVA). Ya no se copia aquí a mano: es la
 * tabla OFICIAL de la AEAT para las presentaciones a partir de 2026 (v1.01,
 * DR303e26v101.xlsx), en src/domain/aeat/dr303-2026.json, con todos los campos
 * de la cabecera y de las páginas 01 a 05 y DID. El generador del fichero la
 * usa directamente (services/modelo303.service).
 */
export { DR303_2026, paginaDiseno303, campoDeCasilla303 } from '../../domain/aeat/modelo303-2026';

/** Longitud de la página 01 (identificación y liquidación del régimen general). */
export const LONGITUD_REGISTRO_303 = 1581;
