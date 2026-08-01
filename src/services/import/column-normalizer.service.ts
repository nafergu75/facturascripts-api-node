/**
 * ColumnNormalizerService
 * Normaliza y limpia datos, sugiere mapeos de columnas automáticos
 */

import { Decimal } from '@prisma/client/runtime/library';
import { ParsedRow } from './file-parser.service';

export interface SuggestedMapping {
  [originalColumn: string]: string | null; // original → estándar o null si sin match
}

export interface NormalizedRow {
  [columnName: string]: string | number | Date | Decimal | null;
}

export class ColumnNormalizerService {
  /**
   * Sugiere mapeos automáticos entre columnas originales y esperadas
   * Utiliza similitud de strings para encontrar coincidencias
   */
  suggestColumnMapping(
    headersOriginales: string[],
    headersEsperados: string[]
  ): SuggestedMapping {
    const sugerencias: SuggestedMapping = {};

    for (const original of headersOriginales) {
      const coincidencia = this.findClosestMatch(original, headersEsperados);
      sugerencias[original] = coincidencia;
    }

    return sugerencias;
  }

  /**
   * Busca la columna esperada más similar a una columna original
   * Usando algoritmo de similitud de Levenshtein
   */
  private findClosestMatch(
    original: string,
    esperados: string[],
    threshold: number = 0.7
  ): string | null {
    const normalized = this.normalizeString(original);

    let bestMatch: { valor: string; similitud: number } | null = null;

    for (const esperado of esperados) {
      const normalizedEsperado = this.normalizeString(esperado);
      const similitud = this.stringSimilarity(normalized, normalizedEsperado);

      if (
        similitud >= threshold &&
        (!bestMatch || similitud > bestMatch.similitud)
      ) {
        bestMatch = { valor: esperado, similitud };
      }
    }

    return bestMatch?.valor ?? null;
  }

  /**
   * Normaliza un string: lowercase, sin acentos, sin caracteres especiales
   */
  private normalizeString(str: string): string {
    return str
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // remover acentos
      .replace(/[^a-z0-9]/g, ''); // solo alfanuméricos
  }

  /**
   * Calcula similitud de Levenshtein (0-1)
   */
  private stringSimilarity(a: string, b: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    const distance = matrix[b.length][a.length];
    const maxLength = Math.max(a.length, b.length);
    return maxLength === 0 ? 1 : 1 - distance / maxLength;
  }

  /**
   * Normaliza una fila completa según mapeo de columnas
   * Limpia espacios, convierte números (comas → puntos), parsea fechas
   */
  normalizeRow(
    row: ParsedRow,
    mapping: Record<string, string>
  ): NormalizedRow {
    const normalized: NormalizedRow = {};

    for (const [original, estándar] of Object.entries(mapping)) {
      if (!estándar || row[original] === null || row[original] === undefined) {
        continue;
      }

      let valor = row[original];

      // Procesar según tipo
      if (typeof valor === 'string') {
        valor = valor.trim();

        // Intentar convertir a número
        if (this.isNumeric(valor)) {
          const num = this.parseNumber(valor);
          normalized[estándar] = num !== null ? new Decimal(num) : null;
        }
        // Intentar convertir a fecha
        else if (this.isDateLike(valor)) {
          const date = this.parseDate(valor);
          normalized[estándar] = date;
        }
        // Mantener como string
        else {
          normalized[estándar] = valor;
        }
      } else if (typeof valor === 'number') {
        normalized[estándar] = new Decimal(valor);
      } else if (valor instanceof Date) {
        normalized[estándar] = valor;
      } else {
        normalized[estándar] = null;
      }
    }

    return normalized;
  }

  /**
   * Verifica si un string parece un número
   */
  private isNumeric(str: string): boolean {
    return /^-?[\d.,]+$/.test(str.trim());
  }

  /**
   * Parsea un número con formatos españoles (1.234,56) o internacionales (1,234.56)
   */
  private parseNumber(str: string): string | null {
    try {
      str = str.trim();

      // Detectar formato: si hay "," y ".", ver cuál viene último
      const lastComma = str.lastIndexOf(',');
      const lastDot = str.lastIndexOf('.');

      let normalized = str;

      if (lastComma > lastDot) {
        // Formato español: 1.234,56 → 1234.56
        normalized = str.replace(/\./g, '').replace(',', '.');
      } else if (lastDot > lastComma) {
        // Formato internacional: 1,234.56 → 1234.56
        normalized = str.replace(/,/g, '');
      }

      const parsed = parseFloat(normalized);
      return isNaN(parsed) ? null : String(parsed);
    } catch {
      return null;
    }
  }

  /**
   * Verifica si un string parece una fecha
   */
  private isDateLike(str: string): boolean {
    return /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(str.trim()) ||
      /^\d{4}[/-]\d{1,2}[/-]\d{1,2}$/.test(str.trim());
  }

  /**
   * Parsea fechas en múltiples formatos:
   * - DD/MM/YYYY o DD-MM-YYYY (español)
   * - DD/MM/YY o DD-MM-YY
   * - YYYY-MM-DD (ISO)
   */
  private parseDate(dateStr: string): Date | null {
    const formats = [
      /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/, // DD/MM/YYYY
      /^(\d{1,2})[/-](\d{1,2})[/-](\d{2})$/, // DD/MM/YY
      /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/, // YYYY-MM-DD
    ];

    for (let i = 0; i < formats.length; i++) {
      const match = dateStr.trim().match(formats[i]);
      if (match) {
        const [, part1, part2, part3] = match;

        let day: number, month: number, year: number;

        if (i === 0) {
          // DD/MM/YYYY
          day = parseInt(part1, 10);
          month = parseInt(part2, 10);
          year = parseInt(part3, 10);
        } else if (i === 1) {
          // DD/MM/YY
          day = parseInt(part1, 10);
          month = parseInt(part2, 10);
          year = parseInt(part3, 10) + 2000;
        } else {
          // YYYY-MM-DD
          year = parseInt(part1, 10);
          month = parseInt(part2, 10);
          day = parseInt(part3, 10);
        }

        // Validar rango básico
        if (month < 1 || month > 12 || day < 1 || day > 31) {
          return null;
        }

        return new Date(year, month - 1, day);
      }
    }

    return null;
  }

  /**
   * Limpia un valor de nombre de cuenta (trim, mayúsculas)
   */
  cleanAccountName(name: string): string {
    return name.trim().replace(/\s+/g, ' ');
  }

  /**
   * Limpia un código de cuenta (remover espacios, convertir a uppercase)
   */
  cleanAccountCode(code: string): string {
    return code.trim().toUpperCase().replace(/\s/g, '');
  }

  /**
   * Detecta anomalías comunes en los datos
   */
  detectAnomalies(rows: NormalizedRow[]): {
    columnasVacias: string[];
    columnasConNulls: Record<string, number>;
    decimalRangeAnomaly: Record<string, boolean>;
  } {
    const columnasVacias: string[] = [];
    const columnasConNulls: Record<string, number> = {};
    const decimalRangeAnomaly: Record<string, boolean> = {};

    if (rows.length === 0) {
      return { columnasVacias, columnasConNulls, decimalRangeAnomaly };
    }

    const columns = Object.keys(rows[0]);

    for (const col of columns) {
      const values = rows.map((r) => r[col]);
      const nullCount = values.filter((v) => v === null).length;

      if (nullCount === values.length) {
        columnasVacias.push(col);
      } else if (nullCount > 0) {
        columnasConNulls[col] = nullCount;
      }

      // Detectar si hay decimales con rango anormalmente grande
      const decimals = values
        .filter((v) => v instanceof Decimal)
        .map((v) => (v as Decimal).toNumber());

      if (decimals.length > 0) {
        const sorted = decimals.sort((a, b) => a - b);
        const min = sorted[0];
        const max = sorted[sorted.length - 1];

        // Si el rango es > 10x la mediana, probablemente hay problemas
        if (Math.abs(max) > 1000000 && Math.abs(min) < 1) {
          decimalRangeAnomaly[col] = true;
        }
      }
    }

    return { columnasVacias, columnasConNulls, decimalRangeAnomaly };
  }
}
