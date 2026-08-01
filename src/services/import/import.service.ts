/**
 * ImportService
 * Orquestador principal del sistema de importación de datos contables históricos
 * Coordina: Parse → Normalize → Map → Validate → Import
 */

import { Decimal } from '@prisma/client/runtime/library';
import { FileParserService, ParsedRow, ParseResult } from './file-parser.service';
import { ColumnNormalizerService, NormalizedRow } from './column-normalizer.service';
import { AccountMapperService, AccountMapping } from './account-mapper.service';
import { BalanceValidatorService, BalanceRow, BalanceValidationResult } from './balance-validator.service';
import { MayorValidatorService, MayorRow, MayorValidationResult } from './mayor-validator.service';
import { ImportSessionService, ImportSessionData, ImportState } from './import-session.service';
import { OpeningEntryGeneratorService, HistoricalBalance, OpeningEntry } from './opening-entry-generator.service';

export interface ImportResult {
  sessionId: string;
  success: boolean;
  ejercicio: number;
  importType: 'BALANCE' | 'MAYOR' | 'PYG';
  totalRows: number;
  processedRows: number;
  errorRows: number;
  duration: string;
  openingEntry?: OpeningEntry;
  validationResult?: BalanceValidationResult | MayorValidationResult;
  errors: string[];
  warnings: string[];
}

export class ImportService {
  private fileParser = new FileParserService();
  private columnNormalizer = new ColumnNormalizerService();
  private accountMapper = new AccountMapperService();
  private balanceValidator = new BalanceValidatorService();
  private mayorValidator = new MayorValidatorService();
  private sessionService = new ImportSessionService();
  private openingEntryGenerator = new OpeningEntryGeneratorService();

  /**
   * Comienza el flujo de importación completo
   */
  async importHistoricalData(data: {
    companyId: string;
    importType: 'BALANCE' | 'MAYOR' | 'PYG';
    ejercicio: number;
    filePath: string;
    fileName: string;
    manualAccountMappings?: Record<string, string>;
    userId: string;
    sheetName?: string;
  }): Promise<ImportResult> {
    // Crear sesión
    const session = this.sessionService.createSession({
      companyId: data.companyId,
      importType: data.importType,
      ejercicio: data.ejercicio,
      filePath: data.filePath,
      fileName: data.fileName,
      fileSize: 0,
      creadoPor: data.userId,
    });

    try {
      // Paso 1: Parse
      await this.transitionState(session.id, 'PARSEADO');
      const parseResult = await this.fileParser.parseFile(
        data.filePath,
        data.sheetName
      );

      this.sessionService.updateSession(session.id, {
        totalRows: parseResult.rows.length,
        metadata: {
          sheetName: parseResult.sheetName,
        },
      });

      // Paso 2: Suggest column mapping
      const suggestedMappings = this.columnNormalizer.suggestColumnMapping(
        parseResult.headers,
        this.getExpectedColumns(data.importType)
      );

      // Filtrar mappings null (columnas sin coincidencia)
      const validMappings = Object.entries(suggestedMappings)
        .filter(([_, v]) => v !== null)
        .reduce((acc, [k, v]) => ({ ...acc, [k]: v as string }), {});

      this.sessionService.setColumnMappings(session.id, validMappings);

      // Paso 3: Normalize data
      const normalizedRows = this.normalizeRows(
        parseResult.rows,
        validMappings
      );

      // Paso 4: Map accounts
      await this.transitionState(session.id, 'MAPEADO');
      const mappedRows = this.mapAccountCodes(
        normalizedRows,
        data.manualAccountMappings
      );

      // Paso 5: Validate según tipo
      await this.transitionState(session.id, 'VALIDADO');
      let validationResult: BalanceValidationResult | MayorValidationResult | null = null;
      const errors: string[] = [];

      if (data.importType === 'BALANCE') {
        validationResult = await this.validateBalance(
          mappedRows,
          session.id
        );
        errors.push(...(validationResult as BalanceValidationResult).errors);
      } else if (data.importType === 'MAYOR') {
        validationResult = await this.validateMayor(
          mappedRows,
          session.id
        );
        errors.push(...(validationResult as MayorValidationResult).errors);
      }

      // Si hay errores críticos, fallar
      if (errors.length > 0 && data.importType === 'BALANCE') {
        await this.transitionState(session.id, 'FALLIDO');
        return this.buildResult(session, false, validationResult, errors);
      }

      // Paso 6: Generate opening entry si es BALANCE
      let openingEntry: OpeningEntry | undefined;
      if (data.importType === 'BALANCE') {
        openingEntry = await this.generateOpeningEntry(
          mappedRows,
          data.ejercicio + 1
        );
      }

      // Paso 7: Import (cambiar estado a IMPORTADO)
      await this.transitionState(session.id, 'IMPORTADO');

      return this.buildResult(
        session,
        true,
        validationResult,
        errors,
        openingEntry
      );
    } catch (error) {
      await this.transitionState(session.id, 'FALLIDO');
      const errorMsg = error instanceof Error ? error.message : 'Error desconocido';
      this.sessionService.addError(session.id, errorMsg);

      return this.buildResult(
        session,
        false,
        null,
        [errorMsg]
      );
    }
  }

  /**
   * Obtiene el estado actual de una importación
   */
  getImportStatus(sessionId: string): ImportSessionData | null {
    return this.sessionService.getSession(sessionId);
  }

  /**
   * Obtiene el progreso de una importación
   */
  getImportProgress(sessionId: string) {
    return this.sessionService.getProgress(sessionId);
  }

  /**
   * Cancela una importación en curso
   */
  cancelImport(sessionId: string): boolean {
    return this.sessionService.cancelSession(sessionId);
  }

  // Privados

  private getExpectedColumns(importType: string): string[] {
    switch (importType) {
      case 'BALANCE':
        return [
          'Cuenta',
          'Nombre Cuenta',
          'Debe',
          'Haber',
          'Categoría',
          'Code',
          'Description',
          'Debit',
          'Credit',
        ];
      case 'MAYOR':
        return [
          'Fecha',
          'Cuenta',
          'Descripción',
          'Debe',
          'Haber',
          'Date',
          'Account',
          'Description',
          'Debit',
          'Credit',
        ];
      case 'PYG':
        return [
          'Cuenta',
          'Descripción',
          'Valor',
          'Amount',
          'Description',
        ];
      default:
        return [];
    }
  }

  private normalizeRows(
    rows: ParsedRow[],
    mappings: Record<string, string>
  ): NormalizedRow[] {
    const normalized: NormalizedRow[] = [];

    for (const row of rows) {
      const norm = this.columnNormalizer.normalizeRow(row, mappings);
      normalized.push(norm);
    }

    return normalized;
  }

  private mapAccountCodes(
    rows: NormalizedRow[],
    manualMappings?: Record<string, string>
  ): NormalizedRow[] {
    const mapped: NormalizedRow[] = [];

    for (const row of rows) {
      const mapped_row = { ...row };

      // Si hay código de cuenta original, mapear
      if (row.cuentaCodigo) {
        const mapping = this.accountMapper.mapAccountCode(
          String(row.cuentaCodigo),
          manualMappings
        );

        if (mapping) {
          mapped_row.cuentaCodigoMapeado = mapping.internalCode;
          mapped_row.confianzaMapeo = mapping.confidence;
        }
      }

      mapped.push(mapped_row);
    }

    return mapped;
  }

  private async validateBalance(
    rows: NormalizedRow[],
    sessionId: string
  ): Promise<BalanceValidationResult> {
    const balanceRows: BalanceRow[] = rows.map((row, idx) => ({
      accountCode: String(row.cuentaCodigoMapeado || row.cuentaCodigo || ''),
      accountName: String(row.cuentaNombre || ''),
      category: this.getCategoryFromCode(String(row.cuentaCodigoMapeado || row.cuentaCodigo || '')) as any,
      debit: row.debe instanceof Decimal ? row.debe : (typeof row.debe === 'number' ? new Decimal(row.debe) : new Decimal(0)),
      credit: row.haber instanceof Decimal ? row.haber : (typeof row.haber === 'number' ? new Decimal(row.haber) : new Decimal(0)),
    }));

    const result = this.balanceValidator.validateBalance(balanceRows);

    // Registrar en sesión
    result.errors.forEach((e) => this.sessionService.addError(sessionId, e));
    result.warnings.forEach((w) => this.sessionService.addWarning(sessionId, w));

    return result;
  }

  private async validateMayor(
    rows: NormalizedRow[],
    sessionId: string
  ): Promise<MayorValidationResult> {
    const mayorRows: MayorRow[] = rows.map((row) => ({
      fecha: (row.fecha instanceof Date ? row.fecha : new Date(String(row.fecha))) as Date,
      cuentaCodigo: String(row.cuentaCodigoMapeado || row.cuentaCodigo || ''),
      cuentaNombre: String(row.cuentaNombre || ''),
      descripcion: String(row.descripcion || ''),
      debe: row.debe instanceof Decimal ? row.debe : (typeof row.debe === 'number' ? new Decimal(row.debe) : new Decimal(0)),
      haber: row.haber instanceof Decimal ? row.haber : (typeof row.haber === 'number' ? new Decimal(row.haber) : new Decimal(0)),
    }));

    const result = this.mayorValidator.validateMayor(mayorRows);

    // Registrar en sesión
    result.errors.forEach((e) => this.sessionService.addError(sessionId, e));
    result.warnings.forEach((w) => this.sessionService.addWarning(sessionId, w));

    return result;
  }

  private async generateOpeningEntry(
    rows: NormalizedRow[],
    newExerciseYear: number
  ): Promise<OpeningEntry> {
    const historicalBalances: HistoricalBalance[] = rows.map((row) => ({
      accountCode: String(row.cuentaCodigoMapeado || row.cuentaCodigo || ''),
      accountName: String(row.cuentaNombre || ''),
      category: this.getCategoryFromCode(String(row.cuentaCodigoMapeado || row.cuentaCodigo || '')) as any,
      debit: row.debe instanceof Decimal ? row.debe : (typeof row.debe === 'number' ? new Decimal(row.debe) : new Decimal(0)),
      credit: row.haber instanceof Decimal ? row.haber : (typeof row.haber === 'number' ? new Decimal(row.haber) : new Decimal(0)),
    }));

    return this.openingEntryGenerator.generateOpeningEntry(
      historicalBalances,
      newExerciseYear
    );
  }

  private async transitionState(sessionId: string, newState: ImportState): Promise<void> {
    const result = this.sessionService.transitionState(sessionId, newState);
    if (!result.success) {
      throw new Error(result.error);
    }
  }

  private getCategoryFromCode(code: string): 'ACTIVO' | 'PASIVO' | 'PATRIMONIO' | 'INGRESO' | 'GASTO' | 'OTRO' {
    const firstDigit = code.charAt(0);
    switch (firstDigit) {
      case '1': return 'ACTIVO';
      case '2': return 'PASIVO';
      case '3': return 'PATRIMONIO';
      case '4':
      case '7': return 'INGRESO';
      case '5':
      case '8': return 'GASTO';
      default: return 'OTRO';
    }
  }

  private buildResult(
    session: ImportSessionData,
    success: boolean,
    validationResult: BalanceValidationResult | MayorValidationResult | null,
    errors: string[],
    openingEntry?: OpeningEntry
  ): ImportResult {
    const duration = session.completedAt
      ? `${Math.round((session.completedAt.getTime() - session.startedAt.getTime()) / 1000)}s`
      : 'N/A';

    return {
      sessionId: session.id,
      success,
      ejercicio: session.ejercicio,
      importType: session.importType,
      totalRows: session.totalRows,
      processedRows: session.processedRows,
      errorRows: session.errorRows,
      duration,
      openingEntry,
      validationResult: validationResult || undefined,
      errors,
      warnings: session.validationWarnings,
    };
  }
}
