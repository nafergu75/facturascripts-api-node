/**
 * Paises y codigos postales espanoles para validar los datos de una empresa.
 *
 * - Pais: codigo ISO 3166-1 alfa-2 (los 249 asignados oficialmente). Antes
 *   valia cualquier par de letras y un "SP" pensando en Espana convertia la
 *   empresa en extranjera sin avisar (sin comprobar el NIF ni pedir provincia).
 * - Codigo postal espanol: 5 cifras y las dos primeras son la provincia (01 a
 *   52, el mismo numero que su codigo INE). Asi un 64120 por 46120 no llega a
 *   las facturas, y un CP de Alicante con la provincia "Valencia" tampoco.
 *
 * Funciones puras, probadas en tests/geografia.test.ts. La web tiene una copia
 * en web/lib/geografia.ts: si cambia algo aqui, cambialo tambien alli.
 */

const ISO_3166_1 =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR ' +
  'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP ' +
  'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT ' +
  'MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW ' +
  'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG ' +
  'UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW';

/** Codigos ISO 3166-1 alfa-2 asignados. */
export const PAISES_ISO: ReadonlySet<string> = new Set(ISO_3166_1.split(' '));

/** true si es un codigo de pais ISO de dos letras que existe ("es" vale; "SP", "UK" o "EU" no). */
export function esCodigoPais(valor: unknown): boolean {
  return PAISES_ISO.has(String(valor ?? '').trim().toUpperCase());
}

/** Provincia de cada prefijo de codigo postal (01 a 52), con su nombre mas habitual. */
export const PROVINCIAS: Readonly<Record<string, string>> = {
  '01': 'Álava',
  '02': 'Albacete',
  '03': 'Alicante',
  '04': 'Almería',
  '05': 'Ávila',
  '06': 'Badajoz',
  '07': 'Illes Balears',
  '08': 'Barcelona',
  '09': 'Burgos',
  '10': 'Cáceres',
  '11': 'Cádiz',
  '12': 'Castellón',
  '13': 'Ciudad Real',
  '14': 'Córdoba',
  '15': 'A Coruña',
  '16': 'Cuenca',
  '17': 'Girona',
  '18': 'Granada',
  '19': 'Guadalajara',
  '20': 'Gipuzkoa',
  '21': 'Huelva',
  '22': 'Huesca',
  '23': 'Jaén',
  '24': 'León',
  '25': 'Lleida',
  '26': 'La Rioja',
  '27': 'Lugo',
  '28': 'Madrid',
  '29': 'Málaga',
  '30': 'Murcia',
  '31': 'Navarra',
  '32': 'Ourense',
  '33': 'Asturias',
  '34': 'Palencia',
  '35': 'Las Palmas',
  '36': 'Pontevedra',
  '37': 'Salamanca',
  '38': 'Santa Cruz de Tenerife',
  '39': 'Cantabria',
  '40': 'Segovia',
  '41': 'Sevilla',
  '42': 'Soria',
  '43': 'Tarragona',
  '44': 'Teruel',
  '45': 'Toledo',
  '46': 'Valencia',
  '47': 'Valladolid',
  '48': 'Bizkaia',
  '49': 'Zamora',
  '50': 'Zaragoza',
  '51': 'Ceuta',
  '52': 'Melilla',
};

/**
 * Otras formas de escribir la provincia (sin tildes y en minusculas): nombre
 * en la otra lengua oficial, nombre antiguo o la isla. Lo que no esta aqui no
 * se reconoce y entonces no se compara con el codigo postal.
 */
const OTROS_NOMBRES: Record<string, string[]> = {
  '01': ['araba'],
  '03': ['alacant'],
  '07': ['islas baleares', 'baleares', 'balears', 'mallorca', 'menorca', 'ibiza', 'eivissa', 'formentera'],
  '12': ['castello', 'castellon de la plana', 'castello de la plana'],
  '15': ['la coruna', 'coruna'],
  '17': ['gerona'],
  '20': ['guipuzcoa'],
  '25': ['lerida'],
  '26': ['rioja'],
  '30': ['region de murcia'],
  '31': ['nafarroa', 'comunidad foral de navarra'],
  '32': ['orense'],
  '33': ['principado de asturias'],
  '35': ['gran canaria', 'lanzarote', 'fuerteventura', 'las palmas de gran canaria'],
  '38': ['tenerife', 'la palma', 'la gomera', 'el hierro'],
  '48': ['vizcaya'],
};

/** "Castellón/Castelló" -> ["castellon", "castello"]: sin tildes, en minusculas y por partes. */
function partesDelNombre(texto: string): string[] {
  return texto
    .split(/[/()]/)
    .map((p) =>
      p
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/^provincia de /, ''),
    )
    .filter(Boolean);
}

const PREFIJO_DE_NOMBRE = new Map<string, string>();
for (const [prefijo, nombre] of Object.entries(PROVINCIAS)) {
  for (const parte of partesDelNombre(nombre)) PREFIJO_DE_NOMBRE.set(parte, prefijo);
  for (const otro of OTROS_NOMBRES[prefijo] ?? []) PREFIJO_DE_NOMBRE.set(otro, prefijo);
}

/** Prefijo de codigo postal (01 a 52) de una provincia escrita a mano, o null si no se reconoce. */
export function prefijoDeProvincia(texto: unknown): string | null {
  for (const parte of partesDelNombre(String(texto ?? ''))) {
    const prefijo = PREFIJO_DE_NOMBRE.get(parte);
    if (prefijo) return prefijo;
  }
  return null;
}

/** Provincia de un codigo postal espanol, o null si no tiene 5 cifras o no existe. */
export function provinciaDeCodigoPostal(cp: unknown): string | null {
  const texto = String(cp ?? '').trim();
  if (!/^\d{5}$/.test(texto)) return null;
  return PROVINCIAS[texto.slice(0, 2)] ?? null;
}

export interface ProblemaCodigoPostal {
  /** formato: no son 5 cifras; rango: no empieza por 01 a 52; provincia: es de otra provincia. */
  tipo: 'formato' | 'rango' | 'provincia';
  mensaje: string;
}

/**
 * Comprueba un codigo postal espanol y, si se reconoce la provincia escrita,
 * que sea de esa provincia. Devuelve null si esta bien.
 */
export function problemaCodigoPostal(cp: unknown, provincia?: unknown): ProblemaCodigoPostal | null {
  const texto = String(cp ?? '').trim();
  if (!/^\d{5}$/.test(texto)) return { tipo: 'formato', mensaje: 'El código postal tiene que tener 5 cifras.' };
  const deCp = PROVINCIAS[texto.slice(0, 2)];
  if (!deCp) {
    return {
      tipo: 'rango',
      mensaje: `El código postal ${texto} no existe: en España empiezan por 01 a 52 (las dos primeras cifras son la provincia).`,
    };
  }
  const escrita = String(provincia ?? '').trim();
  const prefijo = escrita ? prefijoDeProvincia(escrita) : null;
  if (prefijo && prefijo !== texto.slice(0, 2)) {
    return {
      tipo: 'provincia',
      mensaje: `El código postal ${texto} es de ${deCp}, no de ${escrita}. Revisa el código postal o la provincia.`,
    };
  }
  return null;
}
