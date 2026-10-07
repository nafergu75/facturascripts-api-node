/**
 * Depura el texto que se envía a la IA. La IA no recibe datos de la empresa:
 * NIF, IBAN, correos y teléfonos se cambian por [NIF], [IBAN], [EMAIL] y
 * [TELÉFONO], y los nombres de clientes, proveedores y bancos de la empresa por
 * «un cliente», «un proveedor» o «un banco». Los importes que escribe el
 * usuario se quedan (son parte de su duda).
 */
import { plano } from '../../utils/texto';
import type { Tercero } from './terceros';

const RE_IBAN = /\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]{4}){3,7}(?:[ -]?[A-Z0-9]{1,4})?\b/gi;
const RE_CUENTA = /\b\d{4}[ -]?\d{4}[ -]?\d{2}[ -]?\d{10}\b/g;
const RE_EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const RE_TELEFONO = /(?<![\d.,])(?:\+34[ -]?)?[6789]\d{2}[ -]?\d{3}[ -]?\d{3}(?![\d.,])/g;
const RE_NIF_GLOBAL = /\b(\d{8}[A-HJ-NP-TV-Z]|[XYZ]\d{7}[A-HJ-NP-TV-Z]|[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J])\b/gi;

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

const SUSTITUTO: Record<Tercero['rol'], string> = { cliente: 'un cliente', proveedor: 'un proveedor', banco: 'un banco' };

export function depurarParaIA(texto: string, terceros: Tercero[] = []): string {
  let t = texto
    .replace(RE_EMAIL, '[EMAIL]')
    .replace(RE_IBAN, (m) => (/\d{6,}/.test(m.replace(/[ -]/g, '')) ? '[IBAN]' : m))
    .replace(RE_CUENTA, '[IBAN]')
    .replace(RE_NIF_GLOBAL, '[NIF]')
    .replace(RE_TELEFONO, '[TELÉFONO]');

  // Nombres de terceros: primero los más largos, para no dejar trozos sueltos.
  const textoPlano = plano(t);
  const candidatos = terceros
    .filter((tc) => tc.tokens.join(' ').length >= 4 && tc.tokens.every((tok) => textoPlano.includes(tok)))
    .sort((a, b) => b.tokens.join(' ').length - a.tokens.join(' ').length);
  for (const tc of candidatos) t = t.replace(patronNombre(tc.tokens), SUSTITUTO[tc.rol]);
  return t;
}
