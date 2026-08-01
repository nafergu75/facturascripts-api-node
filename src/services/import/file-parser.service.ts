/**
 * FileParserService
 * Lee archivos Excel/CSV y devuelve filas parseadas
 */

import * as XLSX from 'xlsx';
import * as fs from 'fs';
import { parse } from 'csv-parse/sync';
import { Decimal } from '@prisma/client/runtime/library';

export interface ParsedRow {
  [columnName: string]: string | number | Date | null;
}

export interface ParseResult {
  headers: string[];
  rows: ParsedRow[];
  sheetName: string;
}

export class FileParserService {
  /**
   * Lee un archivo Excel/CSV y devuelve filas parseadas
   */
  async parseFile(filePath: string, sheetName?: string): Promise<ParseResult> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Archivo no encontrado: ${filePath}`);
    }

    if (filePath.endsWith('.xlsx') || filePath.endsWith('.xls')) {
      return this.parseExcel(filePath, sheetName);
    } else if (filePath.endsWith('.csv')) {
      return this.parseCsv(filePath);
    }

    throw new Error(`Formato no soportado: ${filePath}. Use .xlsx, .xls o .csv`);
  }

  private parseExcel(filePath: string, sheetName?: string): ParseResult {
    try {
      const workbook = XLSX.readFile(filePath);

      // Detectar hoja
      const targetSheet = sheetName
        ? workbook.Sheets[sheetName]
        : workbook.Sheets[workbook.SheetNames[0]];

      if (!targetSheet) {
        throw new Error(
          `Hoja '${sheetName}' no encontrada. Hojas disponibles: ${workbook.SheetNames.join(', ')}`
        );
      }

      // Parsear como JSON
      const rows = XLSX.utils.sheet_to_json<ParsedRow>(targetSheet, {
        blankrows: false,
        defval: null,
        raw: false, // Devolver como strings para normalización posterior
      });

      if (rows.length === 0) {
        throw new Error('El archivo está vacío');
      }

      const headers = Object.keys(rows[0]);

      return {
        headers,
        rows,
        sheetName: sheetName || workbook.SheetNames[0],
      };
    } catch (error) {
      throw new Error(
        `Error al parsear Excel: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private parseCsv(filePath: string): ParseResult {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');

      // Detectar delimitador (comma o semicolon)
      const delimiter = this.detectDelimiter(content);

      const rows = parse(content, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        delimiter,
        relax_quotes: true,
      }) as ParsedRow[];

      if (rows.length === 0) {
        throw new Error('El archivo CSV está vacío');
      }

      const headers = Object.keys(rows[0]);

      return {
        headers,
        rows,
        sheetName: 'data',
      };
    } catch (error) {
      throw new Error(
        `Error al parsear CSV: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private detectDelimiter(content: string): string {
    // Analizar primeras líneas para detectar delimitador
    const lines = content.split('\n').slice(0, 3);
    const commaCount = lines.join('').split(',').length;
    const semicolonCount = lines.join('').split(';').length;

    return semicolonCount > commaCount ? ';' : ',';
  }

  /**
   * Extrae información de los archivos cargados
   * Útil para preview antes de mapping
   */
  async getFileInfo(filePath: string): Promise<{
    nombre: string;
    tipo: string;
    tamano: number;
    filas: number;
    columnas: number;
  }> {
    const stats = fs.statSync(filePath);
    const parseResult = await this.parseFile(filePath);

    return {
      nombre: filePath.split('/').pop() || 'unknown',
      tipo: filePath.endsWith('.csv') ? 'CSV' : 'XLSX',
      tamano: stats.size,
      filas: parseResult.rows.length,
      columnas: parseResult.headers.length,
    };
  }
}
