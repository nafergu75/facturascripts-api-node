/**
 * Depura el texto que se envía a la IA. La IA no recibe datos de la empresa:
 * NIF, IBAN, correos, números de afiliación a la Seguridad Social y teléfonos
 * se cambian por [NIF], [IBAN], [EMAIL], [NAF] y [TELÉFONO], y los nombres de
 * clientes, proveedores, bancos y trabajadores de la empresa por «un cliente»,
 * «un proveedor», «un banco» o «un trabajador». Los importes que escribe el
 * usuario se quedan (son parte de su duda).
 *
 * Los nombres se tapan aunque la pregunta solo traiga una parte («Pérez
 * Martínez» de «Construcciones Pérez Martínez SL»): cada palabra de un nombre
 * con 4 letras o más que no es del vocabulario contable («construcciones»,
 * «pérez», «martínez»...) se sustituye allí donde aparezca.
 */
import { plano } from '../../utils/texto';
import { PALABRAS_VACIAS, esPalabraDelDominio } from './vocabulario';
import type { RolTercero } from './terceros';

/** Lo que se tapa: un cliente, proveedor o banco (Tercero) o un trabajador (Trabajador). */
type RolNombre = RolTercero | 'trabajador';
interface Nombrable {
  rol: RolNombre;
  tokens: string[];
}

const RE_IBAN = /\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]{4}){3,7}(?:[ -]?[A-Z0-9]{1,4})?\b/gi;
const RE_CUENTA = /\b\d{4}[ -]?\d{4}[ -]?\d{2}[ -]?\d{10}\b/g;
const RE_EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** NAF: 12 cifras (provincia, número y control), con o sin separadores: 28 12345678 40. */
const RE_NAF = /(?<![\d.,])\d{2}[ \/-]?\d{8}[ \/-]?\d{2}(?![\d.,])/g;
const RE_TELEFONO = /(?<![\d.,])(?:\+34[ -]?)?[6789]\d{2}[ -]?\d{3}[ -]?\d{3}(?![\d.,])/g;
const RE_NIF_GLOBAL = /\b(\d{8}[A-HJ-NP-TV-Z]|[XYZ]\d{7}[A-HJ-NP-TV-Z]|[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J])\b/gi;

/** Palabras sueltas de un nombre que se tapan: 4 letras o más. */
const LETRAS_MIN_PALABRA = 4;

const VARIANTES: Record<string, string> = {
  a: '[aáàäâ]',
  e: '[eéèëê]',
  i: '[iíìïî]',
  o: '[oóòöô]',
  u: '[uúùüû]',
  n: '[nñ]',
  c: '[cç]',
};

/** Expresión que encuentra el nombre en el texto original sin importar tildes ni mayúsculas. */
function patronNombre(tokens: string[]): RegExp {
  const palabra = (t: string) => [...t].map((ch) => VARIANTES[ch] ?? ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`(?<![\\p{L}\\p{N}])${tokens.map(palabra).join('[\\s.,-]+')}(?![\\p{L}\\p{N}])`, 'giu');
}

const SUSTITUTO: Record<RolNombre, string> = { cliente: 'un cliente', proveedor: 'un proveedor', banco: 'un banco', trabajador: 'un trabajador' };

/** Palabras de los nombres que identifican a un tercero (no vacías ni del vocabulario contable). */
function palabrasSensibles(terceros: Nombrable[]): Map<string, RolNombre> {
  const m = new Map<string, RolNombre>();
  for (const tc of terceros) {
    for (const tok of tc.tokens) {
      if (tok.length >= LETRAS_MIN_PALABRA && !PALABRAS_VACIAS.has(tok) && !esPalabraDelDominio(tok) && !m.has(tok)) m.set(tok, tc.rol);
    }
  }
  return m;
}

/** Tapa las palabras sueltas de un nombre; varias seguidas («Pérez Martínez») se tapan juntas. */
function taparPalabrasSueltas(texto: string, sensibles: Map<string, RolNombre>): string {
  if (!sensibles.size) return texto;
  const palabras = [...texto.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({ ini: m.index ?? 0, fin: (m.index ?? 0) + m[0].length, rol: sensibles.get(plano(m[0])) }));
  let salida = '';
  let pos = 0;
  for (let i = 0; i < palabras.length; i++) {
    const p = palabras[i];
    if (!p.rol) continue;
    let j = i;
    while (j + 1 < palabras.length && palabras[j + 1].rol && /^[\s.,-]+$/.test(texto.slice(palabras[j].fin, palabras[j + 1].ini))) j++;
    salida += texto.slice(pos, p.ini) + SUSTITUTO[p.rol];
    pos = palabras[j].fin;
    i = j;
  }
  return salida + texto.slice(pos);
}

export function depurarParaIA(texto: string, terceros: Nombrable[] = []): string {
  let t = texto
    .replace(RE_EMAIL, '[EMAIL]')
    .replace(RE_IBAN, (m) => (/\d{6,}/.test(m.replace(/[ -]/g, '')) ? '[IBAN]' : m))
    .replace(RE_CUENTA, '[IBAN]')
    .replace(RE_NIF_GLOBAL, '[NIF]')
    .replace(RE_NAF, '[NAF]')
    .replace(RE_TELEFONO, '[TELÉFONO]');

  // Nombres completos: primero los más largos, para no dejar trozos sueltos.
  const textoPlano = plano(t);
  const candidatos = terceros
    .filter((tc) => tc.tokens.join(' ').length >= 4 && tc.tokens.every((tok) => textoPlano.includes(tok)))
    .sort((a, b) => b.tokens.join(' ').length - a.tokens.join(' ').length);
  for (const tc of candidatos) t = t.replace(patronNombre(tc.tokens), SUSTITUTO[tc.rol]);

  // Partes de un nombre («Pérez Martínez» de «Construcciones Pérez Martínez SL»).
  return taparPalabrasSueltas(t, palabrasSensibles(terceros));
}
