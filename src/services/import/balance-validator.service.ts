/**
 * BalanceValidatorService
 * Valida que el balance sea cuadrado: Activo = Pasivo + Patrimonio Neto
 */

import { Decimal } from '@prisma/client/runtime/library';

export interface BalanceRow {
  accountCode: string;
  accountName: string;
  category: 'ACTIVO' | 'PASIVO' | 'PATRIMONIO';
  debit: Decimal | number;
  credit: Decimal | number;
}

export interface BalanceValidationResult {
  isBalanced: boolean;
  activo: Decimal;
  pasivo: Decimal;
  patrimonio: Decimal;
  difference: Decimal;
  errorMargin: Decimal; // Tolerancia para errores de redondeo
  errors: string[];
  warnings: string[];
  mixedNatureAccounts: {
    code: string;
    name: string;
    debit: Decimal;
    credit: Decimal;
    netBalance: Decimal;
  }[];
}

export class BalanceValidatorService {
  private readonly ERROR_MARGIN = new Decimal('0.01'); // 0.01 EUR tolerance

  /**
   * Valida un balance de situación
   * Verifica: Activo = Pasivo + Patrimonio Neto
   */
  validateBalance(rows: BalanceRow[]): BalanceValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const mixedNatureAccounts: BalanceValidationResult['mixedNatureAccounts'] = [];

    let activo = new Decimal(0);
    let pasivo = new Decimal(0);
    let patrimonio = new Decimal(0);

    // Calcular totales por categoría
    for (const row of rows) {
      const debit = new Decimal(row.debit);
      const credit = new Decimal(row.credit);

      // Detectar cuentas de saldo positivo en ambos lados (posible error)
      if (debit.greaterThan(0) && credit.greaterThan(0)) {
        warnings.push(
          `Cuenta ${row.accountCode} tiene débito y crédito simultáneos: D=${debit}, C=${credit}`
        );
      }

      // Calcular saldo neto
      const netBalance = debit.minus(credit);

      // Clasificar según categoría declarada
      switch (row.category) {
        case 'ACTIVO':
          activo = activo.plus(netBalance);
          if (netBalance.lessThan(0)) {
            mixedNatureAccounts.push({
              code: row.accountCode,
              name: row.accountName,
              debit,
              credit,
              netBalance,
            });
            warnings.push(
              `Cuenta de Activo ${row.accountCode} tiene saldo negativo (Pasivo): ${netBalance}`
            );
          }
          break;
        case 'PASIVO':
          pasivo = pasivo.plus(netBalance);
          if (netBalance.greaterThan(0)) {
            mixedNatureAccounts.push({
              code: row.accountCode,
              name: row.accountName,
              debit,
              credit,
              netBalance,
            });
            warnings.push(
              `Cuenta de Pasivo ${row.accountCode} tiene saldo positivo (Activo): ${netBalance}`
            );
          }
          break;
        case 'PATRIMONIO':
          patrimonio = patrimonio.plus(netBalance);
          break;
      }
    }

    // Validar balance: Activo = Pasivo + Patrimonio
    const difference = activo.minus(pasivo.plus(patrimonio)).abs();
    const isBalanced = difference.lessThanOrEqualTo(this.ERROR_MARGIN);

    if (!isBalanced) {
      errors.push(
        `Balance no cuadra. Activo (${activo}) ≠ Pasivo + PN (${pasivo.plus(patrimonio)}). Diferencia: ${difference}`
      );
    }

    if (activo.equals(0)) {
      errors.push('Total de Activo es cero');
    }

    if (pasivo.plus(patrimonio).equals(0)) {
      errors.push('Total de Pasivo + Patrimonio es cero');
    }

    return {
      isBalanced,
      activo,
      pasivo,
      patrimonio,
      difference,
      errorMargin: this.ERROR_MARGIN,
      errors,
      warnings,
      mixedNatureAccounts,
    };
  }

  /**
   * Detecta cuentas de naturaleza mixta (pueden ser activo o pasivo según saldo)
   */
  private getMixedNatureAccounts(): string[] {
    return [
      '430000', // Clientes
      '410000', // Proveedores
      '471000', // Hacienda Pública Acreedora
      '472000', // Hacienda Pública Deudora
    ];
  }

  /**
   * Sugiere correcciones para un balance que no cuadra
   */
  suggestCorrections(
    result: BalanceValidationResult
  ): {
    suggestion: string;
    impactedAmount: Decimal;
  }[] {
    const suggestions: { suggestion: string; impactedAmount: Decimal }[] = [];

    if (result.difference.equals(0)) {
      return suggestions;
    }

    // Si Activo > Pasivo + PN: aumentar pasivo o patrimonio
    if (result.activo.greaterThan(result.pasivo.plus(result.patrimonio))) {
      suggestions.push({
        suggestion: `Aumentar Pasivo o Patrimonio en ${result.difference}`,
        impactedAmount: result.difference,
      });

      // Sugerir específicamente
      suggestions.push({
        suggestion: `O reducir Activo en ${result.difference}`,
        impactedAmount: result.difference,
      });
    }

    // Si Activo < Pasivo + PN: reducir pasivo o patrimonio
    if (result.activo.lessThan(result.pasivo.plus(result.patrimonio))) {
      suggestions.push({
        suggestion: `Reducir Pasivo o Patrimonio en ${result.difference}`,
        impactedAmount: result.difference,
      });

      suggestions.push({
        suggestion: `O aumentar Activo en ${result.difference}`,
        impactedAmount: result.difference,
      });
    }

    return suggestions;
  }

  /**
   * Análisis de estructura del balance
   * Verifica índices de solvencia y estructura financiera
   */
  analyzeStructure(result: BalanceValidationResult): {
    equityRatio: Decimal; // PN / Activo
    debtRatio: Decimal; // Pasivo / Activo
    solvencyMetric: string; // Evaluación cualitativa
  } {
    if (result.activo.equals(0)) {
      return {
        equityRatio: new Decimal(0),
        debtRatio: new Decimal(0),
        solvencyMetric: 'SIN ACTIVO',
      };
    }

    const equityRatio = result.patrimonio.dividedBy(result.activo);
    const debtRatio = result.pasivo.dividedBy(result.activo);

    let solvencyMetric = '';
    if (equityRatio.greaterThanOrEqualTo(0.5)) {
      solvencyMetric = 'BUENA (PN >= 50% Activo)';
    } else if (equityRatio.greaterThanOrEqualTo(0.3)) {
      solvencyMetric = 'ACEPTABLE (PN 30-50% Activo)';
    } else if (equityRatio.greaterThan(0)) {
      solvencyMetric = 'DÉBIL (PN < 30% Activo)';
    } else {
      solvencyMetric = 'INSOLVENTE (PN <= 0)';
    }

    return {
      equityRatio,
      debtRatio,
      solvencyMetric,
    };
  }

  /**
   * Valida que todos los códigos de cuenta sean mapeables
   */
  validateAccountMappings(rows: BalanceRow[]): {
    unmappedAccounts: string[];
    suspiciousAccounts: string[];
  } {
    const unmappedAccounts: string[] = [];
    const suspiciousAccounts: string[] = [];

    for (const row of rows) {
      // Verificar que el código tenga exactamente 6 dígitos
      const numericOnly = row.accountCode.replace(/[^0-9]/g, '');

      if (numericOnly.length !== 6) {
        unmappedAccounts.push(
          `${row.accountCode} (${numericOnly.length} dígitos, esperados 6)`
        );
      }

      // Detectar códigos sospechosos (ej: 000000)
      if (numericOnly === '000000') {
        suspiciousAccounts.push(
          `${row.accountCode}: código genérico 000000`
        );
      }

      // Detectar primeros dígitos inválidos
      const firstDigit = numericOnly.charAt(0);
      if (!['1', '2', '3', '4', '5', '6', '7', '8', '9'].includes(firstDigit)) {
        suspiciousAccounts.push(
          `${row.accountCode}: primer dígito inválido ${firstDigit}`
        );
      }
    }

    return { unmappedAccounts, suspiciousAccounts };
  }

  /**
   * Compara balances de períodos consecutivos para detectar anomalías
   */
  compareWithPriorYear(
    currentYear: BalanceValidationResult,
    priorYear: BalanceValidationResult | null
  ): {
    activoChange: Decimal;
    pasivoChange: Decimal;
    patrimonioChange: Decimal;
    anomalies: string[];
  } {
    const anomalies: string[] = [];

    if (!priorYear) {
      return {
        activoChange: new Decimal(0),
        pasivoChange: new Decimal(0),
        patrimonioChange: new Decimal(0),
        anomalies: ['No hay año anterior para comparar'],
      };
    }

    const activoChange = currentYear.activo.minus(priorYear.activo);
    const pasivoChange = currentYear.pasivo.minus(priorYear.pasivo);
    const patrimonioChange = currentYear.patrimonio.minus(priorYear.patrimonio);

    // Detectar variaciones sospechosas
    if (activoChange.lessThan(new Decimal('-50')) || activoChange.greaterThan(new Decimal('100'))) {
      anomalies.push(
        `Variación de Activo muy grande: ${activoChange.toFixed(2)}`
      );
    }

    // Detectar patrimonio negativo
    if (currentYear.patrimonio.lessThan(0)) {
      anomalies.push(
        `Patrimonio Neto negativo: ${currentYear.patrimonio.toFixed(2)} (empresa técnicamente insolvente)`
      );
    }

    // Detectar pasivo excesivo
    const pasivoPorcentaje = currentYear.pasivo.dividedBy(currentYear.activo);
    if (pasivoPorcentaje.greaterThan(new Decimal('2'))) {
      anomalies.push(
        `Pasivo excesivo: ${pasivoPorcentaje.times(100).toFixed(0)}% del Activo`
      );
    }

    return {
      activoChange,
      pasivoChange,
      patrimonioChange,
      anomalies,
    };
  }
}
