/**
 * NIF espanol con su caracter de control y numero de afiliacion a la Seguridad
 * Social (NAF). Un solo validador para toda la app:
 * - empresas (alta y "Datos de la empresa"): validarNifEspanol, que admite
 *   DNI, NIE y CIF;
 * - trabajadores de las nominas: errorNifPersona, que se apoya en el mismo
 *   validador pero solo admite personas fisicas (un CIF de sociedad no vale).
 *
 * Casos que cubre validarNifEspanol:
 * - DNI: 8 cifras + letra (12345678Z). Tambien los NIF K, L y M de personas
 *   fisicas sin DNI (letra + 7 cifras + letra), que se calculan igual.
 * - NIE: X, Y o Z + 7 cifras + letra (X1234567L). La X, Y, Z valen 0, 1, 2.
 * - CIF (personas juridicas): letra + 7 cifras + control (A10952364).
 *
 * Funciones puras, probadas en tests/nif.test.ts y tests/nominas.test.ts.
 */

const LETRAS_DNI = 'TRWAGMYFPDXBNJZSQVHLCKE';
const LETRAS_CONTROL_CIF = 'JABCDEFGHI';
/** Letras iniciales de las personas juridicas y entidades sin personalidad. */
const LETRAS_CIF = 'ABCDEFGHJNPQRSUVW';
/** El control de estas es siempre una cifra (S.A., S.L., comunidades de bienes, comunidades de propietarios). */
const CIF_CONTROL_CIFRA = 'ABEH';
/** El control de estas es siempre una letra (entidades publicas, religiosas, extranjeras...). */
const CIF_CONTROL_LETRA = 'NPQSW';

export type TipoNif = 'DNI' | 'NIE' | 'CIF';

export interface ResultadoNif {
  valido: boolean;
  /**
   * Como normalizarNif: mayusculas, sin espacios, guiones, puntos ni el prefijo
   * ES del NIF-IVA, y con los ceros que Excel quita en DNI y NIE.
   */
  normalizado: string;
  tipo?: TipoNif;
  /** Por que no vale, en castellano y para mostrarlo tal cual. */
  motivo?: string;
}

/**
 * NIF tal como se guarda: mayusculas, sin espacios, puntos, guiones ni barras
 * (ni ningun otro signo), sin el prefijo ES del NIF-IVA intracomunitario y con
 * los ceros de la izquierda que Excel suele comerse en los DNI y NIE.
 *
 * "a-10.952.364" -> "A10952364"; "ES A10952364" -> "A10952364";
 * "1234567L" -> "01234567L"; "x-1234567-l" -> "X1234567L".
 */
export function normalizarNif(valor: unknown): string {
  let nif = String(valor ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  // NIF-IVA: ES + NIF. Ningun NIF valido empieza por "ES" (la S no es una
  // cifra), asi que quitarlo no confunde ningun otro. Con un DNI o NIE al que
  // Excel le ha quitado los ceros, lo que queda tras el ES es mas corto.
  if (/^ES[0-9A-Z]{9}$/.test(nif) || (/^ES[0-9XYZKLM]/.test(nif) && nif.length > 9)) nif = nif.slice(2);
  if (/^\d{1,7}[A-Z]$/.test(nif)) nif = nif.padStart(9, '0');
  if (/^[XYZKLM]\d{1,6}[A-Z]$/.test(nif)) nif = nif[0] + nif.slice(1).padStart(8, '0');
  return nif;
}

/** Letra de control de un DNI (o de un NIE ya convertido a cifras). */
export function letraDni(numero: string): string {
  return LETRAS_DNI[Number(numero) % 23];
}

/** Lo mismo que letraDni, con el numero como cifra (nominas y sus tests). */
export function letraNif(numero: number): string {
  return letraDni(String(numero));
}

/** Control de un CIF a partir de sus 7 cifras: la cifra y su letra equivalente. */
export function controlCif(siete: string): { cifra: string; letra: string } {
  let pares = 0;
  let impares = 0;
  for (let i = 0; i < 7; i++) {
    const d = Number(siete[i]);
    if (i % 2 === 1) {
      pares += d; // posiciones 2, 4 y 6
    } else {
      const doble = d * 2; // posiciones 1, 3, 5 y 7: se suman las cifras del doble
      impares += Math.floor(doble / 10) + (doble % 10);
    }
  }
  const control = (10 - ((pares + impares) % 10)) % 10;
  return { cifra: String(control), letra: LETRAS_CONTROL_CIF[control] };
}

const FORMATO =
  'Un NIF español tiene 9 caracteres: 8 cifras y una letra (DNI), X, Y o Z con 7 cifras y una letra (NIE) o una letra, 7 cifras y el control (CIF).';

/** Valida un NIF espanol (DNI, NIE o CIF) con su caracter de control. */
export function validarNifEspanol(valor: unknown): ResultadoNif {
  const nif = normalizarNif(valor);
  const mal = (motivo: string, tipo?: TipoNif): ResultadoNif => ({ valido: false, normalizado: nif, tipo, motivo });
  if (!nif) return mal('Falta el NIF.');
  if (nif.length !== 9) return mal(FORMATO);

  // DNI
  if (/^\d{8}[A-Z]$/.test(nif)) {
    return nif[8] === letraDni(nif.slice(0, 8))
      ? { valido: true, normalizado: nif, tipo: 'DNI' }
      : mal(`La letra del NIF ${nif} no corresponde a sus cifras: revísalo.`, 'DNI');
  }
  // K, L, M: personas fisicas sin DNI; el control se calcula como en el DNI.
  if (/^[KLM]\d{7}[A-Z]$/.test(nif)) {
    return nif[8] === letraDni(nif.slice(1, 8))
      ? { valido: true, normalizado: nif, tipo: 'DNI' }
      : mal(`La letra del NIF ${nif} no corresponde a sus cifras: revísalo.`, 'DNI');
  }
  // NIE
  if (/^[XYZ]\d{7}[A-Z]$/.test(nif)) {
    const numero = String('XYZ'.indexOf(nif[0])) + nif.slice(1, 8);
    return nif[8] === letraDni(numero)
      ? { valido: true, normalizado: nif, tipo: 'NIE' }
      : mal(`La letra del NIE ${nif} no corresponde a sus cifras: revísalo.`, 'NIE');
  }
  // CIF
  if (new RegExp(`^[${LETRAS_CIF}]\\d{7}[0-9A-J]$`).test(nif)) {
    const { cifra, letra } = controlCif(nif.slice(1, 8));
    const inicial = nif[0];
    const control = nif[8];
    const aceptados = CIF_CONTROL_CIFRA.includes(inicial) ? [cifra] : CIF_CONTROL_LETRA.includes(inicial) ? [letra] : [cifra, letra];
    return aceptados.includes(control)
      ? { valido: true, normalizado: nif, tipo: 'CIF' }
      : mal(`El dígito de control del CIF ${nif} no es correcto: revísalo.`, 'CIF');
  }
  return mal(FORMATO);
}

/** Atajo: true si es un NIF espanol valido (DNI, NIE o CIF). */
export function esNifEspanolValido(valor: unknown): boolean {
  return validarNifEspanol(valor).valido;
}

/**
 * Motivo por el que un NIF de persona fisica no es valido, o null si lo es
 * (trabajadores y conyuges en las nominas). Admite DNI, NIE y los NIF K, L y
 * M, con su letra de control (el mismo calculo que validarNifEspanol). Un CIF
 * de sociedad no vale para un trabajador. Recibe el NIF ya normalizado.
 */
export function errorNifPersona(nif: string): string | null {
  if (!nif) return 'Falta el NIF.';
  const r = validarNifEspanol(nif);
  if (r.tipo === 'CIF') return `${nif} es el NIF de una sociedad, no de una persona.`;
  if (r.valido) return null;
  if (r.tipo) return `La letra del NIF ${nif} no es correcta.`;
  return `El NIF ${nif} no tiene un formato válido (DNI o NIE).`;
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
