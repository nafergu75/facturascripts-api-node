/**
 * OpeningEntryGeneratorService
 * Genera asientos de apertura (opening entries) para el nuevo ejercicio
 * Basado en los saldos de cierre del ejercicio anterior
 */

import { Decimal } from '@prisma/client/runtime/library';

export interface HistoricalBalance {
  accountCode: string;
  accountName: string;
  category: 'ACTIVO' | 'PASIVO' | 'PATRIMONIO' | 'INGRESO' | 'GASTO' | 'OTRO';
  debit: Decimal | number;
  credit: Decimal | number;
}

export interface OpeningEntryLine {
  accountCode: string;
  accountName: string;
  description: string;
  debit: Decimal;
  credit: Decimal;
  lineNumber: number;
}

export interface OpeningEntry {
  numero: string;
  fecha: Date;
  ejercicio: number;
  descripcion: string;
  totalDebe: Decimal;
  totalHaber: Decimal;
  isBalanced: boolean;
  lines: OpeningEntryLine[];
  generatedAt: Date;
  source: string;
}

export class OpeningEntryGeneratorService {
  /**
   * Genera un asiento de apertura a partir de balances históricos
   */
  generateOpeningEntry(
    historicalBalances: HistoricalBalance[],
    newExerciseYear: number,
    openingDate: Date = new Date(newExerciseYear, 0, 1) // 1 de enero por defecto
  ): OpeningEntry {
    const lines: OpeningEntryLine[] = [];
    let totalDebe = new Decimal(0);
    let totalHaber = new Decimal(0);
    let lineNumber = 1;

    // Clasificar y procesar los balances
    for (const balance of historicalBalances) {
      // Filtrar cuentas que no deben aparecer en apertura
      if (this.shouldSkipAccount(balance.accountCode, balance.category)) {
        continue;
      }

      const debit = new Decimal(balance.debit);
      const credit = new Decimal(balance.credit);
      const netBalance = debit.minus(credit);

      // Solo incluir si hay saldo
      if (netBalance.equals(0)) {
        continue;
      }

      // Determinar si va en debe o haber
      let lineDebit = new Decimal(0);
      let lineCredit = new Decimal(0);

      if (netBalance.greaterThan(0)) {
        lineDebit = netBalance;
      } else {
        lineCredit = netBalance.abs();
      }

      totalDebe = totalDebe.plus(lineDebit);
      totalHaber = totalHaber.plus(lineCredit);

      lines.push({
        accountCode: balance.accountCode,
        accountName: balance.accountName,
        description: `Apertura de ${balance.accountName}`,
        debit: lineDebit,
        credit: lineCredit,
        lineNumber,
      });

      lineNumber++;
    }

    // Validar que el asiento cuadre
    const difference = totalDebe.minus(totalHaber).abs();
    const isBalanced = difference.lessThanOrEqualTo(new Decimal('0.01'));

    // Si no cuadra, intentar corregir
    let correctionLine: OpeningEntryLine | null = null;
    if (!isBalanced && difference.greaterThan(0)) {
      correctionLine = {
        accountCode: '570000', // Cuenta de Corrección (debe existir)
        accountName: 'Diferencia de Redondeo',
        description: 'Ajuste por redondeo en apertura',
        debit:
          totalDebe.greaterThan(totalHaber) ? new Decimal(0) : difference,
        credit:
          totalDebe.lessThan(totalHaber) ? new Decimal(0) : difference,
        lineNumber: lineNumber++,
      };

      if (correctionLine.debit.greaterThan(0)) {
        totalDebe = totalDebe.plus(correctionLine.debit);
      } else {
        totalHaber = totalHaber.plus(correctionLine.credit);
      }

      lines.push(correctionLine);
    }

    return {
      numero: `${newExerciseYear}/00001`, // Primer asiento del ejercicio
      fecha: openingDate,
      ejercicio: newExerciseYear,
      descripcion: `Asiento de apertura del ejercicio ${newExerciseYear}`,
      totalDebe,
      totalHaber,
      isBalanced: totalDebe.equals(totalHaber),
      lines,
      generatedAt: new Date(),
      source: 'HISTORICAL_IMPORT',
    };
  }

  /**
   * Genera múltiples asientos de apertura si hay varios ejercicios
   */
  generateOpeningEntries(
    historicalBalancesByExercise: Map<
      number,
      HistoricalBalance[]
    >,
    newExerciseYear: number
  ): OpeningEntry[] {
    const entries: OpeningEntry[] = [];

    for (const [year, balances] of historicalBalancesByExercise) {
      if (year < newExerciseYear) {
        const entry = this.generateOpeningEntry(
          balances,
          newExerciseYear,
          new Date(newExerciseYear, 0, 1)
        );
        entries.push(entry);
      }
    }

    return entries;
  }

  /**
   * Valida un asiento de apertura
   */
  validateOpeningEntry(entry: OpeningEntry): {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validar que cuadre
    if (!entry.isBalanced) {
      errors.push(
        `Asiento de apertura no cuadra: Debe ${entry.totalDebe} ≠ Haber ${entry.totalHaber}`
      );
    }

    // Validar líneas
    if (entry.lines.length === 0) {
      errors.push('Asiento de apertura sin líneas');
    }

    // Validar fechas
    if (entry.fecha.getDate() !== 1 || entry.fecha.getMonth() !== 0) {
      warnings.push(
        `Fecha de apertura no es 1 de enero: ${entry.fecha.toISOString()}`
      );
    }

    // Validar que todos los códigos sean válidos
    for (const line of entry.lines) {
      const numericOnly = line.accountCode.replace(/[^0-9]/g, '');
      if (numericOnly.length !== 6) {
        errors.push(
          `Código de cuenta inválido en línea ${line.lineNumber}: ${line.accountCode}`
        );
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Exporta un asiento de apertura en formato JSON
   */
  exportAsJSON(entry: OpeningEntry): string {
    return JSON.stringify(
      {
        numero: entry.numero,
        fecha: entry.fecha.toISOString(),
        ejercicio: entry.ejercicio,
        descripcion: entry.descripcion,
        lineas: entry.lines.map((line) => ({
          linea: line.lineNumber,
          cuenta: line.accountCode,
          nombre: line.accountName,
          descripcion: line.description,
          debe: line.debit.toString(),
          haber: line.credit.toString(),
        })),
        totales: {
          debe: entry.totalDebe.toString(),
          haber: entry.totalHaber.toString(),
        },
      },
      null,
      2
    );
  }

  /**
   * Exporta un asiento de apertura en formato CSV
   */
  exportAsCSV(entry: OpeningEntry): string {
    const lines: string[] = [];

    // Encabezado
    lines.push(
      `Asiento,Fecha,Ejercicio,Descripción,Cuenta,Nombre Cuenta,Descripción,Debe,Haber`
    );

    // Líneas del asiento
    for (const line of entry.lines) {
      lines.push(
        `"${entry.numero}","${entry.fecha.toISOString().split('T')[0]}",${entry.ejercicio},"${entry.descripcion}","${line.accountCode}","${line.accountName}","${line.description}",${line.debit},${line.credit}`
      );
    }

    // Totales
    lines.push(
      `"${entry.numero}","${entry.fecha.toISOString().split('T')[0]}",${entry.ejercicio},"TOTALES",,,,,${entry.totalDebe},${entry.totalHaber}`
    );

    return lines.join('\n');
  }

  // Privadas

  /**
   * Determina si una cuenta debe saltarse en el asiento de apertura
   */
  private shouldSkipAccount(
    accountCode: string,
    category: string
  ): boolean {
    // Saltar cuentas de resultado (ingresos y gastos)
    // Estos se cierran al final del período y no afectan apertura
    if (category === 'INGRESO' || category === 'GASTO') {
      return true;
    }

    // Saltar cuentas de cierre (9xxxxx)
    if (accountCode.startsWith('9')) {
      return true;
    }

    // Saltar cuentas sin saldo
    return false;
  }
}
