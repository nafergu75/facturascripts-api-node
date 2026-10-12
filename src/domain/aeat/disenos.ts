/**
 * Disenos de registro OFICIALES de la AEAT, transcritos campo a campo en JSON
 * (posicion, longitud, tipo y constantes). Son la unica fuente de las
 * posiciones: los generadores escriben con ellos, la pantalla lee con ellos el
 * fichero generado y los tests dorados los comprueban.
 *
 * Comprobados en la Sede el 11-10-2026 (pagina "Diseños de registro"):
 *  - 349: DR_Anexo_349.pdf, Orden HAC/174/2020 (2020 y siguientes). No hay otro.
 *  - 180: DR_Mod_180_2023.pdf, Orden HAP/1732/2014 actualizada por la Orden
 *    HFP/1284/2023. Es el unico publicado: vale para 2023 y siguientes mientras
 *    la AEAT no publique otro. Revisarlo cada enero.
 *  - 202: DR202e25.xlsx v1.3 (2025 y siguientes, actualizado el 14-07-2026).
 */
import type { DisenoDr } from '../../aeat/common/disenoRegistro';
import dr349 from './dr349.json';
import dr180 from './dr180.json';
import dr202 from './dr202-2025.json';

export const DISENO_349 = dr349 as DisenoDr;
export const DISENO_180 = dr180 as DisenoDr;
export const DISENO_202 = dr202 as DisenoDr;
