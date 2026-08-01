/**
 * MayorValidatorService
 * Valida que el Mayor/Ledger sea consistente: debe = haber
 * También valida que los saldos del Mayor coincidan con el Balance
 */

import { Decimal } from '@prisma/client/runtime/library';

export interface MayorRow {
  fecha: Date;
  cuentaCodigo: string;
  cuentaNombre: string;
  descripcion: string;
  debe: Decimal | number;
  haber: Decimal | number;
}

export interface MayorValidationResult {
  isConsistent: boolean;
  totalDebe: Decimal;
  totalHaber: Decimal;
  difference: Decimal;
  errorMargin: Decimal;
  errors: string[];
  warnings: string[];
  accountBalances: Map<string, { debe: Decimal; haber: Decimal; saldo: Decimal }>;
  dateRange: {
    earliest: Date | null;
    latest: Date | null;
  };
}

export class MayorValidatorService {
  private readonly ERROR_MARGIN = new Decimal('0.01');

  /**
   * Valida la consistencia del Mayor
   * Debe = Haber (partida doble)
   */
  validateMayor(rows: MayorRow[]): MayorValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const accountBalances = new Map<
      string,
      { debe: Decimal; haber: Decimal; saldo: Decimal }
    >();

    let totalDebe = new Decimal(0);
    let totalHaber = new Decimal(0);
    let earliestDate: Date | null = null;
    let latestDate: Date | null = null;

    // Procesar filas del Mayor
    for (const row of rows) {
      // Validar fechas
      if (!(row.fecha instanceof Date) || isNaN(row.fecha.getTime())) {
        errors.push(`Fecha inválida en partida: ${row.fecha}`);
        continue;
      }

      // Actualizar rango de fechas
      if (!earliestDate || row.fecha < earliestDate) {
        earliestDate = row.fecha;
      }
      if (!latestDate || row.fecha > latestDate) {
        latestDate = row.fecha;
      }

      // Convertir a Decimal
      const debe = new Decimal(row.debe);
      const haber = new Decimal(row.haber);

      // Detectar partidas con ambos lados > 0 (posible error)
      if (debe.greaterThan(0) && haber.greaterThan(0)) {
        warnings.push(
          `Partida con D y H simultáneos en ${row.fecha.toISOString()}: ${row.cuentaCodigo} D=${debe} H=${haber}`
        );
      }

      // Acumular totales
      totalDebe = totalDebe.plus(debe);
      totalHaber = totalHaber.plus(haber);

      // Acumular por cuenta
      const cuenta = row.cuentaCodigo.trim().toUpperCase();
      const current = accountBalances.get(cuenta) || {
        debe: new Decimal(0),
        haber: new Decimal(0),
        saldo: new Decimal(0),
      };

      current.debe = current.debe.plus(debe);
      current.haber = current.haber.plus(haber);
      current.saldo = current.debe.minus(current.haber);

      accountBalances.set(cuenta, current);

      // Validar valores
      if (debe.isNaN() || haber.isNaN()) {
        errors.push(`Valores no numéricos en partida: ${row.fecha}`);
      }

      if (debe.lessThan(0) || haber.lessThan(0)) {
        warnings.push(
          `Valores negativos en partida ${row.fecha}: ${row.cuentaCodigo}`
        );
      }
    }

    // Validar que Debe = Haber
    const difference = totalDebe.minus(totalHaber).abs();
    const isConsistent = difference.lessThanOrEqualTo(this.ERROR_MARGIN);

    if (!isConsistent) {
      errors.push(
        `Mayor no cuadra: Debe (${totalDebe}) ≠ Haber (${totalHaber}). Diferencia: ${difference}`
      );
    }

    if (rows.length === 0) {
      warnings.push('Mayor sin partidas');
    }

    return {
      isConsistent,
      totalDebe,
      totalHaber,
      difference,
      errorMargin: this.ERROR_MARGIN,
      errors,
      warnings,
      accountBalances,
      dateRange: {
        earliest: earliestDate,
        latest: latestDate,
      },
    };
  }

  /**
   * Compara los saldos del Mayor con el Balance (Balance of Situation)
   */
  compareWithBalance(
    mayorResult: MayorValidationResult,
    balanceAccountBalances: Map<string, { debe: Decimal; haber: Decimal }>
  ): {
    matches: number;
    mismatches: Array<{
      account: string;
      mayorSaldo: Decimal;
      balanceSaldo: Decimal;
      difference: Decimal;
    }>;
    unmappedInBalance: string[];
    unmappedInMayor: string[];
    isConsistent: boolean;
  } {
    const mismatches: Array<{
      account: string;
      mayorSaldo: Decimal;
      balanceSaldo: Decimal;
      difference: Decimal;
    }> = [];
    const unmappedInBalance: string[] = [];
    const unmappedInMayor: string[] = [];
    let matches = 0;

    // Comparar cada cuenta del Mayor con el Balance
    for (const [cuenta, mayorBalance] of mayorResult.accountBalances) {
      const balanceData = balanceAccountBalances.get(cuenta);

      if (!balanceData) {
        unmappedInMayor.push(cuenta);
        continue;
      }

      const balanceSaldo = balanceData.debe.minus(balanceData.haber);
      const difference = mayorBalance.saldo.minus(balanceSaldo).abs();

      if (difference.lessThanOrEqualTo(this.ERROR_MARGIN)) {
        matches++;
      } else {
        mismatches.push({
          account: cuenta,
          mayorSaldo: mayorBalance.saldo,
          balanceSaldo,
          difference,
        });
      }
    }

    // Detectar cuentas en Balance no presentes en Mayor
    for (const cuenta of balanceAccountBalances.keys()) {
      if (!mayorResult.accountBalances.has(cuenta)) {
        unmappedInBalance.push(cuenta);
      }
    }

    const isConsistent =
      mismatches.length === 0 &&
      unmappedInBalance.length === 0 &&
      unmappedInMayor.length === 0;

    return {
      matches,
      mismatches,
      unmappedInBalance,
      unmappedInMayor,
      isConsistent,
    };
  }

  /**
   * Detecta anomalías comunes en datos de Mayor
   */
  detectAnomalies(result: MayorValidationResult): {
    emptyAccounts: string[];
    unusualAccountActivity: Array<{
      account: string;
      totalMovements: number;
      totalAmount: Decimal;
    }>;
    suspiciousBalances: Array<{
      account: string;
      saldo: Decimal;
      reason: string;
    }>;
  } {
    const emptyAccounts: string[] = [];
    const unusualAccountActivity: Array<{
      account: string;
      totalMovements: number;
      totalAmount: Decimal;
    }> = [];
    const suspiciousBalances: Array<{
      account: string;
      saldo: Decimal;
      reason: string;
    }> = [];

    // Detectar cuentas con saldo cero
    for (const [cuenta, balance] of result.accountBalances) {
      if (balance.saldo.equals(0)) {
        emptyAccounts.push(cuenta);
      }
    }

    // Detectar cuentas con actividad muy grande
    // (volumen de movimientos total muy alto)
    for (const [cuenta, balance] of result.accountBalances) {
      const totalActivity = balance.debe.plus(balance.haber);

      if (totalActivity.greaterThan(new Decimal('1000000'))) {
        unusualAccountActivity.push({
          account: cuenta,
          totalMovements: 1, // Simplificado, en realidad necesitaríamos contar partidas
          totalAmount: totalActivity,
        });
      }
    }

    // Detectar saldos sospechosos
    for (const [cuenta, balance] of result.accountBalances) {
      // Cuentas que típicamente no deben tener saldo negativo
      if (cuenta.startsWith('1') && balance.saldo.lessThan(0)) {
        suspiciousBalances.push({
          account: cuenta,
          saldo: balance.saldo,
          reason: 'Cuenta de Activo con saldo negativo',
        });
      }

      // Cuentas que típicamente no deben tener saldo positivo
      if (cuenta.startsWith('2') && balance.saldo.greaterThan(0)) {
        suspiciousBalances.push({
          account: cuenta,
          saldo: balance.saldo,
          reason: 'Cuenta de Pasivo con saldo positivo',
        });
      }
    }

    return {
      emptyAccounts,
      unusualAccountActivity,
      suspiciousBalances,
    };
  }

  /**
   * Análisis temporal del Mayor
   * Detecta patrones en fechas de partidas
   */
  analyzeTemporalPatterns(result: MayorValidationResult): {
    dateRange: string;
    movementsPerDay: Decimal;
    firstTransaction: Date | null;
    lastTransaction: Date | null;
    anomalies: string[];
  } {
    const anomalies: string[] = [];

    if (!result.dateRange.earliest || !result.dateRange.latest) {
      return {
        dateRange: 'SIN RANGO',
        movementsPerDay: new Decimal(0),
        firstTransaction: null,
        lastTransaction: null,
        anomalies: ['No hay transacciones registradas'],
      };
    }

    const daysDifference =
      (result.dateRange.latest.getTime() -
        result.dateRange.earliest.getTime()) /
      (1000 * 60 * 60 * 24);

    const movementsPerDay =
      daysDifference > 0
        ? new Decimal(result.accountBalances.size).dividedBy(
            new Decimal(Math.max(1, daysDifference))
          )
        : new Decimal(0);

    if (daysDifference === 0) {
      anomalies.push('Todas las transacciones en el mismo día');
    }

    if (movementsPerDay.greaterThan(100)) {
      anomalies.push(
        `Promedio de ${movementsPerDay.toFixed(2)} cuentas por día (inusual)`
      );
    }

    return {
      dateRange: `${result.dateRange.earliest?.toISOString().split('T')[0]} a ${result.dateRange.latest?.toISOString().split('T')[0]}`,
      movementsPerDay,
      firstTransaction: result.dateRange.earliest,
      lastTransaction: result.dateRange.latest,
      anomalies,
    };
  }

  /**
   * Genera un resumen contable del Mayor
   */
  generateSummary(result: MayorValidationResult): {
    totalAccounts: number;
    totalPartidas: number;
    totalDebe: Decimal;
    totalHaber: Decimal;
    isBalanced: boolean;
    accountsWithActivity: number;
  } {
    return {
      totalAccounts: result.accountBalances.size,
      totalPartidas: 0, // Simplificado
      totalDebe: result.totalDebe,
      totalHaber: result.totalHaber,
      isBalanced: result.isConsistent,
      accountsWithActivity: result.accountBalances.size,
    };
  }
}
