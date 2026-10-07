/**
 * NIF de personas fisicas (DNI, NIE y NIF K/L/M) y numero de afiliacion a la
 * Seguridad Social (NAF), con su control. Funciones puras.
 */

const LETRAS = 'TRWAGMYFPDXBNJZSQVHLCKE';

/**
 * NIF tal como se guarda: mayusculas, sin espacios, puntos ni guiones, sin el
 * prefijo de pais "ES" y con los ceros de la izquierda que Excel suele comerse
 * ("1234567L" -> "01234567L").
 */
export function normalizarNif(valor: unknown): string {
  let s = String(valor ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (/^ES[0-9XYZKLM]/.test(s) && s.length > 9) s = s.slice(2);
  if (/^\d{1,7}[A-Z]$/.test(s)) s = s.padStart(9, '0');
  if (/^[XYZKLM]\d{1,6}[A-Z]$/.test(s)) s = s[0] + s.slice(1).padStart(8, '0');
  return s;
}

/** Letra de control de un numero de DNI (o del numero equivalente de un NIE). */
export function letraNif(numero: number): string {
  return LETRAS[numero % 23];
}

/**
 * Motivo por el que un NIF de persona fisica no es valido, o null si lo es.
 * Admite DNI (8 digitos + letra), NIE (X/Y/Z + 7 digitos + letra) y los NIF
 * K, L y M (7 digitos + letra). Un CIF de sociedad no vale para un trabajador.
 */
export function errorNifPersona(nif: string): string | null {
  if (!nif) return 'Falta el NIF.';
  let numero: number;
  if (/^\d{8}[A-Z]$/.test(nif)) numero = Number(nif.slice(0, 8));
  else if (/^[XYZ]\d{7}[A-Z]$/.test(nif)) numero = Number(`${'XYZ'.indexOf(nif[0])}${nif.slice(1, 8)}`);
  else if (/^[KLM]\d{7}[A-Z]$/.test(nif)) numero = Number(nif.slice(1, 8));
  else if (/^[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]$/.test(nif)) return `${nif} es el NIF de una sociedad, no de una persona.`;
  else return `El NIF ${nif} no tiene un formato válido (DNI o NIE).`;
  if (letraNif(numero) !== nif[8]) return `La letra del NIF ${nif} no es correcta.`;
  return null;
}

export const nifPersonaValido = (nif: string): boolean => errorNifPersona(nif) === null;

/** NAF solo con digitos y los 12 de largo (Excel quita el cero de la provincia). */
export function normalizarNaf(valor: unknown): string {
  if (typeof valor === 'number' && Number.isInteger(valor)) valor = String(valor);
  let s = String(valor ?? '').replace(/\D/g, '');
  if (s.length === 11) s = `0${s}`;
  return s;
}

/**
 * Motivo por el que un NAF no es valido, o null si lo es. Son 12 digitos:
 * provincia (2), numero (8) y control (2). El control es el resto de dividir
 * entre 97 la provincia y el numero juntos; si el numero es menor de
 * 10.000.000, se toma provincia * 10.000.000 + numero.
 */
export function errorNaf(naf: string): string | null {
  if (!/^\d{12}$/.test(naf)) return `El número de afiliación ${naf || '(vacío)'} no tiene 12 dígitos.`;
  const provincia = Number(naf.slice(0, 2));
  const numero = Number(naf.slice(2, 10));
  const control = Number(naf.slice(10));
  const base = numero < 10_000_000 ? numero + provincia * 10_000_000 : Number(naf.slice(0, 10));
  if (base % 97 !== control) return `Los dígitos de control del número de afiliación ${naf} no son correctos.`;
  return null;
}

/** Digitos de control de un NAF (para generar ejemplos y en los tests). */
export function controlNaf(provincia: number, numero: number): string {
  const base = numero < 10_000_000 ? numero + provincia * 10_000_000 : provincia * 100_000_000 + numero;
  return String(base % 97).padStart(2, '0');
}
