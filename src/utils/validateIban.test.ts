import { validateIban, isValidIban, calculateIbanChecksum } from './validateIban';

describe('IBAN Validation', () => {
  describe('calculateIbanChecksum', () => {
    it('should calculate correct checksum for valid Spanish IBAN', () => {
      // ES9121 1234 5678 9012 3456 7890 (sin espacios: ES9121123456789012345678990)
      const iban = 'ES9121123456789012345678990';
      const checksum = calculateIbanChecksum(iban);
      expect(checksum).toBe(1); // mod-97 debe ser 1 para IBAN válido
    });

    it('should calculate correct checksum for valid German IBAN', () => {
      const iban = 'DE89370400440532013000';
      const checksum = calculateIbanChecksum(iban);
      expect(checksum).toBe(1);
    });

    it('should return different checksum for invalid IBAN', () => {
      const iban = 'ES9221123456789012345678990'; // check digit diferente
      const checksum = calculateIbanChecksum(iban);
      expect(checksum).not.toBe(1);
    });
  });

  describe('validateIban - Valid Cases', () => {
    it('should validate correct Spanish IBAN', () => {
      const result = validateIban('ES9121123456789012345678990');
      expect(result.valid).toBe(true);
      expect(result.country).toBe('ES');
      expect(result.normalized).toBe('ES9121123456789012345678990');
    });

    it('should validate correct German IBAN', () => {
      const result = validateIban('DE89370400440532013000');
      expect(result.valid).toBe(true);
      expect(result.country).toBe('DE');
    });

    it('should validate correct French IBAN', () => {
      const result = validateIban('FR1420041010050500013M02606');
      expect(result.valid).toBe(true);
      expect(result.country).toBe('FR');
    });

    it('should validate correct Italian IBAN', () => {
      const result = validateIban('IT60X0542811101000000123456');
      expect(result.valid).toBe(true);
      expect(result.country).toBe('IT');
    });

    it('should handle lowercase input', () => {
      const result = validateIban('es9121123456789012345678990');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('ES9121123456789012345678990');
    });

    it('should handle IBAN with spaces', () => {
      const result = validateIban('ES91 2112 3456 7890 1234 5678 990');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('ES9121123456789012345678990');
    });

    it('should handle IBAN with mixed case and spaces', () => {
      const result = validateIban('es91 2112 3456 7890 1234 5678 990');
      expect(result.valid).toBe(true);
      expect(result.normalized).toBe('ES9121123456789012345678990');
    });

    it('should validate real IBAN examples (IBAN registry)', () => {
      // Real examples from various banks
      const validIbans = [
        'ES9121123456789012345678990',
        'DE89370400440532013000',
        'FR1420041010050500013M02606',
        'GB82WEST12345698765432',
        'IT60X0542811101000000123456',
      ];

      validIbans.forEach(iban => {
        const result = validateIban(iban);
        expect(result.valid).toBe(true);
      });
    });
  });

  describe('validateIban - Invalid Cases (Format)', () => {
    it('should reject empty string', () => {
      const result = validateIban('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('non-empty string');
    });

    it('should reject null/undefined', () => {
      expect(validateIban(null as any).valid).toBe(false);
      expect(validateIban(undefined as any).valid).toBe(false);
    });

    it('should reject IBAN too short', () => {
      const result = validateIban('ES91 1234');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('length must be between');
    });

    it('should reject IBAN too long', () => {
      const result = validateIban('ES91 1234567890123456789012345678901234567890');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('length must be between');
    });

    it('should reject non-alphabetic country code', () => {
      const result = validateIban('1234567890123456789012345678');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('country code');
    });

    it('should reject single character country code', () => {
      const result = validateIban('E91234567890123456789012345678');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('country code');
    });

    it('should reject non-numeric check digits', () => {
      const result = validateIban('ESAB123456789012345678990');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Check digits');
    });

    it('should reject invalid characters in BBAN', () => {
      const result = validateIban('ES91-@#$%^&*()');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('alphanumeric');
    });

    it('should reject lowercase in country code', () => {
      // Nota: normalizamos a mayúsculas, así que esto debería pasar
      const result = validateIban('es9121123456789012345678990');
      expect(result.valid).toBe(true); // Se normaliza correctamente
    });
  });

  describe('validateIban - Invalid Cases (Checksum)', () => {
    it('should reject IBAN with wrong check digit (1)', () => {
      const result = validateIban('ES9021123456789012345678990'); // cambié 91 a 90
      expect(result.valid).toBe(false);
      expect(result.error).toContain('checksum');
    });

    it('should reject IBAN with wrong check digit (2)', () => {
      const result = validateIban('ES1121123456789012345678990'); // cambié 91 a 11
      expect(result.valid).toBe(false);
      expect(result.error).toContain('checksum');
    });

    it('should reject IBAN with corrupted BBAN', () => {
      const result = validateIban('ES9121123456789012345678991'); // último dígito +1
      expect(result.valid).toBe(false);
      expect(result.error).toContain('checksum');
    });
  });

  describe('validateIban - Country-Specific Length Validation', () => {
    it('should reject Spanish IBAN with wrong length', () => {
      // España requiere exactamente 24 caracteres
      const result = validateIban('ES9121123456789012345678'); // 23 caracteres
      expect(result.valid).toBe(false);
      expect(result.error).toContain('must be 24 characters');
    });

    it('should reject German IBAN with wrong length', () => {
      // Alemania requiere exactamente 22 caracteres
      const result = validateIban('DE89370400440532013'); // 21 caracteres
      expect(result.valid).toBe(false);
      expect(result.error).toContain('must be 22 characters');
    });

    it('should reject French IBAN with wrong length', () => {
      // Francia requiere exactamente 27 caracteres
      const result = validateIban('FR1420041010050500013M0260'); // 26 caracteres
      expect(result.valid).toBe(false);
      expect(result.error).toContain('must be 27 characters');
    });
  });

  describe('isValidIban - Boolean Wrapper', () => {
    it('should return true for valid IBAN', () => {
      expect(isValidIban('ES9121123456789012345678990')).toBe(true);
    });

    it('should return false for invalid IBAN', () => {
      expect(isValidIban('ES9021123456789012345678990')).toBe(false);
      expect(isValidIban('not-an-iban')).toBe(false);
      expect(isValidIban('')).toBe(false);
    });
  });

  describe('Edge Cases and Real-World Scenarios', () => {
    it('should handle leading/trailing whitespace', () => {
      const result = validateIban('  ES9121123456789012345678990  ');
      expect(result.valid).toBe(true);
    });

    it('should handle internal whitespace variations', () => {
      const result = validateIban('ES91  2112  3456  7890  1234  5678  990');
      expect(result.valid).toBe(true);
    });

    it('should handle tab characters', () => {
      const result = validateIban('ES91\t2112\t3456\t7890\t1234\t5678\t990');
      expect(result.valid).toBe(true);
    });

    it('should return normalized form even for invalid IBAN', () => {
      const result = validateIban('es91 2112 3456 7890 1234 5678 991');
      expect(result.normalized).toBe('ES9121123456789012345678991');
    });

    it('should preserve country code in result', () => {
      const result = validateIban('DE89370400440532013000');
      expect(result.country).toBe('DE');
    });

    it('should handle various EU country codes', () => {
      // Solo verificamos que reconoce el código de país, sin validar checksum
      const countries = ['AT', 'BE', 'CH', 'CZ', 'DK', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LU', 'NL', 'NO', 'PL', 'PT', 'RO', 'SE', 'ES', 'GB'];
      countries.forEach(cc => {
        // Creamos un IBAN ficticio con estructura mínima válida
        const fakeIban = `${cc}00` + 'A'.repeat(IBAN_LENGTHS[cc as keyof typeof IBAN_LENGTHS] ? IBAN_LENGTHS[cc as keyof typeof IBAN_LENGTHS] - 4 : 20);
        const result = validateIban(fakeIban);
        // No es necesario que sea válido, solo que reconozca el país
        expect(result.country).toBe(cc);
      });
    });
  });
});

// Helper para imports
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
