/**
 * Validacion del NIF espanol con su caracter de control.
 *
 * Cubre los tres casos que pueden ser titulares de una empresa en la app:
 * - DNI: 8 cifras + letra (12345678Z). Tambien los NIF K, L y M de personas
 *   fisicas sin DNI (letra + 7 cifras + letra), que se calculan igual.
 * - NIE: X, Y o Z + 7 cifras + letra (X1234567L). La X, Y, Z valen 0, 1, 2.
 * - CIF (personas juridicas): letra + 7 cifras + control (A10952364).
 *
 * Funciones puras, probadas en tests/nif.test.ts.
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
  /** Mayusculas, sin espacios, guiones, puntos ni el prefijo ES del NIF-IVA. */
  normalizado: string;
  tipo?: TipoNif;
  /** Por que no vale, en castellano y para mostrarlo tal cual. */
  motivo?: string;
}

/** "a-10.952.364" -> "A10952364"; "ES A10952364" -> "A10952364". */
export function normalizarNif(valor: unknown): string {
  const nif = String(valor ?? '')
    .toUpperCase()
    .replace(/[\s.\-/]/g, '');
  // NIF-IVA intracomunitario: ES + NIF. Ningun NIF valido empieza por "ES"
  // seguido de 9 caracteres, asi que quitarlo no confunde ningun otro.
  return /^ES[0-9A-Z]{9}$/.test(nif) ? nif.slice(2) : nif;
}

/** Letra de control de un DNI (o de un NIE ya convertido a cifras). */
export function letraDni(numero: string): string {
  return LETRAS_DNI[Number(numero) % 23];
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
