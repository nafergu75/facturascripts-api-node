/**
 * Validación robusta de IBAN conforme a ISO 13616
 * Incluye checksum mod-97, estructura y longitud por país
 */

export interface IbanValidationResult {
  valid: boolean;
  error?: string;
  country?: string;
  normalized?: string;
}

// Longitud esperada del IBAN por país (país + check digits + resto)
const IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22,
  BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28,
  EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23,
  GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IS: 26, IT: 27,
  JO: 30, KW: 30, KZ: 20, LB: 28, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27,
  MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18, NO: 15, PK: 24,
  PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SE: 24, SI: 19,
  SK: 24, SM: 27, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
};

/**
 * Calcula el checksum mod-97 de un IBAN
 * Conforme a ISO 13616-1:2015
 */
export function calculateIbanChecksum(iban: string): number {
  // Mover los primeros 4 caracteres al final
  const rearranged = iban.slice(4) + iban.slice(0, 4);

  // Convertir letras a números: A=10, B=11, ..., Z=35
  let numeric = '';
  for (const char of rearranged) {
    if (/\d/.test(char)) {
      numeric += char;
    } else {
      const code = char.toUpperCase().charCodeAt(0) - 'A'.charCodeAt(0) + 10;
      numeric += code;
    }
  }

  // Calcular mod 97
  let remainder = 0;
  for (const digit of numeric) {
    remainder = (remainder * 10 + parseInt(digit, 10)) % 97;
  }

  return remainder;
}

/**
 * Valida un IBAN completo
 * - Formato básico (alfanumérico, sin espacios)
 * - Longitud según país
 * - Checksum mod-97
 */
export function validateIban(iban: string): IbanValidationResult {
  if (!iban || typeof iban !== 'string') {
    return { valid: false, error: 'IBAN must be a non-empty string' };
  }

  // Normalizar: mayúsculas, sin espacios
  const normalized = iban.trim().toUpperCase().replace(/\s+/g, '');

  // Longitud mínima/máxima
  if (normalized.length < 15 || normalized.length > 34) {
    return {
      valid: false,
      error: `IBAN length must be between 15 and 34 characters (got ${normalized.length})`,
      normalized,
    };
  }

  // Primeros 2 caracteres: código de país
  const countryCode = normalized.slice(0, 2);
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    return {
      valid: false,
      error: 'IBAN must start with 2 uppercase letters (country code)',
      normalized,
    };
  }

  // Verificar si el país es conocido y longitud
  if (IBAN_LENGTHS[countryCode]) {
    const expectedLength = IBAN_LENGTHS[countryCode];
    if (normalized.length !== expectedLength) {
      return {
        valid: false,
        error: `IBAN for ${countryCode} must be ${expectedLength} characters (got ${normalized.length})`,
        country: countryCode,
        normalized,
      };
    }
  }

  // Caracteres 3-4: dígitos de verificación (check digits)
  const checkDigits = normalized.slice(2, 4);
  if (!/^[0-9]{2}$/.test(checkDigits)) {
    return {
      valid: false,
      error: 'Check digits (positions 3-4) must be numeric',
      country: countryCode,
      normalized,
    };
  }

  // Resto: alfanuméricos
  const bban = normalized.slice(4);
  if (!/^[A-Z0-9]*$/.test(bban)) {
    return {
      valid: false,
      error: 'BBAN (after check digits) must be alphanumeric',
      country: countryCode,
      normalized,
    };
  }

  // Calcular checksum mod-97
  const checksum = calculateIbanChecksum(normalized);
  if (checksum !== 1) {
    return {
      valid: false,
      error: `Invalid IBAN checksum (mod-97 must equal 1, got ${checksum})`,
      country: countryCode,
      normalized,
    };
  }

  return {
    valid: true,
    country: countryCode,
    normalized,
  };
}

/**
 * Valida un IBAN de manera simple (compatibilidad con regex anterior)
 * Retorna boolean para casos donde solo necesitamos sí/no
 */
export function isValidIban(iban: string): boolean {
  return validateIban(iban).valid;
}
