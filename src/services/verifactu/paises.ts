/**
 * Identificacion de un destinatario extranjero (IDOtro) que admite la AEAT.
 *
 *  - PAISES_AEAT: los 246 codigos de CountryType2 de SuministroInformacion.xsd
 *    (esquemas tikeV1.0 de VERI*FACTU). Un CodigoPais fuera de la lista no
 *    cumple el esquema y la AEAT rechaza la peticion ENTERA (Validaciones y
 *    errores v1.2.2, 4.1): el lote se quedaria bloqueado con un registro ya
 *    encadenado que no se puede cambiar. Por eso se comprueba antes de numerar.
 *    No estan, por ejemplo, XK (Kosovo), XI (Irlanda del Norte) ni EL (Grecia).
 *  - problemaNifIvaAeat: la estructura del NIF-IVA de cada Estado (Validaciones
 *    v1.2.2, nota (1) del apdo. 3.1.3; errores 1222 y 1290). La AEAT rechaza el
 *    registro si no la cumple: no es un error admisible.
 */

export const PAISES_AEAT: ReadonlySet<string> = new Set(
  (
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AZ BA BB BD BE BF BG BH BI BJ BM BN BO BQ BR BS BT BV BW BY BZ ' +
    'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FK FM FO ' +
    'FR GA GB GD GE GG GH GI GL GM GN GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM ' +
    'JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM MN MO MP ' +
    'MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY ' +
    'QA QU RE RO RS RU RW SA SB SC SD SE SG SH SI SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM ' +
    'TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XB XG XN XU YE YT ZA ZM ZW'
  ).split(' '),
);

/** Estructura del numero (sin el prefijo) del NIF-IVA de cada Estado: nota (1) de las Validaciones v1.2.2. */
const ESTRUCTURA_NIF_IVA: Readonly<Record<string, { patron: RegExp; texto: string }>> = {
  DE: { patron: /^\d{9}$/, texto: '9 cifras' },
  AT: { patron: /^[0-9A-Z]{9}$/, texto: '9 letras o cifras' },
  BE: { patron: /^\d{10}$/, texto: '10 cifras' },
  CY: { patron: /^[0-9A-Z]{9}$/, texto: '9 letras o cifras' },
  CZ: { patron: /^\d{8,10}$/, texto: '8, 9 o 10 cifras' },
  HR: { patron: /^\d{11}$/, texto: '11 cifras' },
  DK: { patron: /^\d{8}$/, texto: '8 cifras' },
  SK: { patron: /^\d{10}$/, texto: '10 cifras' },
  SI: { patron: /^\d{8}$/, texto: '8 cifras' },
  EE: { patron: /^\d{9}$/, texto: '9 cifras' },
  FI: { patron: /^\d{8}$/, texto: '8 cifras' },
  FR: { patron: /^[0-9A-Z]{11}$/, texto: '11 letras o cifras' },
  EL: { patron: /^\d{9}$/, texto: '9 cifras' },
  // Irlanda del Norte: desde el 1-2-2021 el prefijo es XI (nota (*) BREXIT); VERI*FACTU empieza el 28-10-2024.
  XI: { patron: /^([0-9A-Z]{5}|[0-9A-Z]{9}|[0-9A-Z]{12})$/, texto: '5, 9 o 12 letras o cifras' },
  NL: { patron: /^[0-9A-Z]{12}$/, texto: '12 letras o cifras' },
  HU: { patron: /^\d{8}$/, texto: '8 cifras' },
  IT: { patron: /^\d{11}$/, texto: '11 cifras' },
  IE: { patron: /^[0-9A-Z]{8,9}$/, texto: '8 o 9 letras o cifras' },
  LV: { patron: /^\d{11}$/, texto: '11 cifras' },
  LT: { patron: /^(\d{9}|\d{12})$/, texto: '9 o 12 cifras' },
  LU: { patron: /^\d{8}$/, texto: '8 cifras' },
  MT: { patron: /^\d{8}$/, texto: '8 cifras' },
  PL: { patron: /^\d{10}$/, texto: '10 cifras' },
  PT: { patron: /^\d{9}$/, texto: '9 cifras' },
  SE: { patron: /^\d{12}$/, texto: '12 cifras' },
  BG: { patron: /^\d{9,10}$/, texto: '9 o 10 cifras' },
  RO: { patron: /^[1-9]\d{1,9}$/, texto: 'de 2 a 10 cifras, sin ceros a la izquierda' },
};

/**
 * Por que un NIF-IVA (con su prefijo: «FR12345678901») no tiene la estructura
 * que exige la AEAT, o null si la tiene. Solo mayusculas, como VIES.
 */
export function problemaNifIvaAeat(id: string): string | null {
  const prefijo = id.slice(0, 2);
  const e = ESTRUCTURA_NIF_IVA[prefijo];
  if (!e) return `no empieza por el código de un Estado de la UE (o XI de Irlanda del Norte)`;
  if (!e.patron.test(id.slice(2))) return `tiene que ser ${prefijo} seguido de ${e.texto}`;
  return null;
}
