/**
 * AccountMapperService
 * Mapea códigos de cuenta de varios formatos al formato interno PGC-PYME
 */

import { Decimal } from '@prisma/client/runtime/library';

export interface AccountMapping {
  originCode: string;
  internalCode: string;
  confidence: number; // 0-100
  isManual: boolean;
  accountName?: string;
}

export class AccountMapperService {
  /**
   * Mapea un código de cuenta de formato origen a formato interno
   * Intenta identificar el formato y convertir automáticamente
   * Si falla, devuelve null
   */
  mapAccountCode(
    originCode: string,
    manualMappings?: Record<string, string>
  ): AccountMapping | null {
    const cleaned = originCode.trim().toUpperCase();

    // Verificar mapeo manual primero
    if (manualMappings && manualMappings[cleaned]) {
      return {
        originCode: cleaned,
        internalCode: manualMappings[cleaned],
        confidence: 100,
        isManual: true,
      };
    }

    // Intentar conversiones automáticas
    const automatic = this.autoMapAccountCode(cleaned);
    return automatic;
  }

  /**
   * Intenta mapear automáticamente un código de cuenta
   * Detecta el formato (4 dígitos, 6 dígitos, etc) y convierte
   */
  private autoMapAccountCode(code: string): AccountMapping | null {
    // Remover caracteres especiales para análisis
    const numericOnly = code.replace(/[^0-9]/g, '');

    if (!numericOnly || numericOnly.length === 0) {
      return null;
    }

    // Formato de 4 dígitos (ej: 1000) → 6 dígitos (100000)
    if (numericOnly.length === 4) {
      const sixDigit = numericOnly + '00';
      return {
        originCode: code,
        internalCode: sixDigit,
        confidence: 85,
        isManual: false,
      };
    }

    // Formato de 5 dígitos (ej: 10000) → 6 dígitos (100000)
    if (numericOnly.length === 5) {
      const sixDigit = numericOnly + '0';
      return {
        originCode: code,
        internalCode: sixDigit,
        confidence: 80,
        isManual: false,
      };
    }

    // Formato de 6 dígitos (ya correcto)
    if (numericOnly.length === 6) {
      return {
        originCode: code,
        internalCode: numericOnly,
        confidence: 100,
        isManual: false,
      };
    }

    // Otros formatos: remover separadores y intentar conversión
    // Ej: 1-0000 → 100000, 1.000.0 → 100000
    const withoutSeparators = numericOnly;

    if (withoutSeparators.length >= 4 && withoutSeparators.length <= 6) {
      // Padear a 6 dígitos
      const padded = withoutSeparators.padEnd(6, '0');
      return {
        originCode: code,
        internalCode: padded,
        confidence: 70,
        isManual: false,
      };
    }

    return null;
  }

  /**
   * Sugiere mapeos automáticos para un lote de códigos
   */
  suggestMappings(
    accountCodes: string[],
    manualMappings?: Record<string, string>
  ): AccountMapping[] {
    const mappings: AccountMapping[] = [];
    const seen = new Set<string>();

    for (const code of accountCodes) {
      const cleaned = code.trim().toUpperCase();
      if (seen.has(cleaned)) continue;
      seen.add(cleaned);

      const mapping = this.mapAccountCode(code, manualMappings);
      if (mapping) {
        mappings.push(mapping);
      }
    }

    return mappings;
  }

  /**
   * Valida que un código de cuenta sea válido (6 dígitos)
   */
  isValidAccountCode(code: string): boolean {
    const numericOnly = code.replace(/[^0-9]/g, '');
    return numericOnly.length === 6 && /^\d{6}$/.test(numericOnly);
  }

  /**
   * Categoriza cuentas según su código (nivel 1 de PGC)
   * 1xxxxx = Activo
   * 2xxxxx = Pasivo
   * 3xxxxx = Patrimonio Neto
   * 4xxxxx = Ingresos / Ventas
   * 5xxxxx = Gastos
   * 6xxxxx = Cuentas complementarias
   * 7xxxxx = Ingresos financieros
   * 8xxxxx = Gastos financieros
   * 9xxxxx = Cuentas de cierre/apertura
   */
  categorizeAccount(
    code: string
  ): 'ACTIVO' | 'PASIVO' | 'PATRIMONIO' | 'INGRESO' | 'GASTO' | 'OTRO' {
    const numericOnly = code.replace(/[^0-9]/g, '');
    if (numericOnly.length === 0) return 'OTRO';

    const firstDigit = numericOnly.charAt(0);

    switch (firstDigit) {
      case '1':
        return 'ACTIVO';
      case '2':
        return 'PASIVO';
      case '3':
        return 'PATRIMONIO';
      case '4':
      case '7':
        return 'INGRESO';
      case '5':
      case '8':
        return 'GASTO';
      default:
        return 'OTRO';
    }
  }

  /**
   * Identifica cuentas de naturaleza mixta (Activo vs Pasivo)
   * Algunas cuentas pueden ser tanto activas como pasivas según saldo
   */
  getMixedNatureAccounts(): string[] {
    return [
      '430000', // Clientes (Activo, pero puede ser Pasivo si negativo)
      '410000', // Proveedores (Pasivo, pero puede ser Activo si negativo)
      '471000', // Hacienda Pública Acreedora (Pasivo)
      '472000', // Hacienda Pública Deudora (Activo)
      '475000', // Impuesto sobre valor añadido (Mixta)
    ];
  }

  /**
   * Validación adicional: detecta si un código de cuenta parece válido
   * según reglas de PGC-PYME
   */
  validateAccountCodeStructure(code: string): {
    isValid: boolean;
    issues: string[];
  } {
    const issues: string[] = [];

    if (!code || code.trim().length === 0) {
      issues.push('Código de cuenta vacío');
      return { isValid: false, issues };
    }

    const numericOnly = code.replace(/[^0-9]/g, '');

    if (!/^\d+$/.test(numericOnly)) {
      issues.push('Código contiene caracteres no numéricos');
    }

    if (numericOnly.length !== 6) {
      issues.push(`Código debe tener 6 dígitos, tiene ${numericOnly.length}`);
    }

    const firstDigit = numericOnly.charAt(0);
    if (!['1', '2', '3', '4', '5', '6', '7', '8', '9'].includes(firstDigit)) {
      issues.push(`Código no comienza con dígito válido: ${firstDigit}`);
    }

    return {
      isValid: issues.length === 0,
      issues,
    };
  }

  /**
   * Sugerencia de valor a cero o a saldo
   * Devuelve el valor que debe tener una cuenta en apertura según su categoría
   */
  suggestOpeningValue(
    category: 'ACTIVO' | 'PASIVO' | 'PATRIMONIO' | 'INGRESO' | 'GASTO' | 'OTRO',
    priorYearBalance?: Decimal
  ): Decimal {
    // En apertura:
    // - Activo, Pasivo, Patrimonio: copian saldo del ejercicio anterior
    // - Ingresos, Gastos: inician en 0
    // - Otros: 0

    if (priorYearBalance !== undefined && (category === 'ACTIVO' || category === 'PASIVO' || category === 'PATRIMONIO')) {
      return priorYearBalance;
    }

    return new Decimal(0);
  }
}
