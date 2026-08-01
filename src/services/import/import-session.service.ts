/**
 * ImportSessionService
 * Gestiona el ciclo de vida de una sesión de importación
 */

import { Decimal } from '@prisma/client/runtime/library';

export type ImportState = 'INICIADO' | 'PARSEADO' | 'MAPEADO' | 'VALIDADO' | 'IMPORTADO' | 'FALLIDO';

export interface ImportSessionData {
  id: string;
  companyId: string;
  importType: 'BALANCE' | 'MAYOR' | 'PYG';
  ejercicio: number;
  state: ImportState;
  filePath: string;
  fileName: string;
  fileSize: number;
  totalRows: number;
  processedRows: number;
  errorRows: number;
  rowsWithWarnings: number;
  columnMappings: Record<string, string>;
  validationErrors: string[];
  validationWarnings: string[];
  startedAt: Date;
  completedAt: Date | null;
  creadoPor: string;
  metadata?: {
    sheetName?: string;
    delimiter?: string;
    encoding?: string;
  };
}

export class ImportSessionService {
  private sessions = new Map<string, ImportSessionData>();

  /**
   * Crea una nueva sesión de importación
   */
  createSession(data: {
    companyId: string;
    importType: 'BALANCE' | 'MAYOR' | 'PYG';
    ejercicio: number;
    filePath: string;
    fileName: string;
    fileSize: number;
    creadoPor: string;
  }): ImportSessionData {
    const id = this.generateId();
    const session: ImportSessionData = {
      id,
      companyId: data.companyId,
      importType: data.importType,
      ejercicio: data.ejercicio,
      state: 'INICIADO',
      filePath: data.filePath,
      fileName: data.fileName,
      fileSize: data.fileSize,
      totalRows: 0,
      processedRows: 0,
      errorRows: 0,
      rowsWithWarnings: 0,
      columnMappings: {},
      validationErrors: [],
      validationWarnings: [],
      startedAt: new Date(),
      completedAt: null,
      creadoPor: data.creadoPor,
    };

    this.sessions.set(id, session);
    return session;
  }

  /**
   * Obtiene una sesión por ID
   */
  getSession(sessionId: string): ImportSessionData | null {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Actualiza el estado y los datos de una sesión
   */
  updateSession(
    sessionId: string,
    updates: Partial<Omit<ImportSessionData, 'id' | 'startedAt' | 'creadoPor'>>
  ): ImportSessionData | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const updated = { ...session, ...updates };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  /**
   * Transiciona el estado de una sesión
   * Valida transiciones válidas
   */
  transitionState(
    sessionId: string,
    newState: ImportState
  ): { success: boolean; error?: string; session?: ImportSessionData } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { success: false, error: 'Sesión no encontrada' };
    }

    const validTransitions: Record<ImportState, ImportState[]> = {
      INICIADO: ['PARSEADO', 'FALLIDO'],
      PARSEADO: ['MAPEADO', 'FALLIDO'],
      MAPEADO: ['VALIDADO', 'FALLIDO'],
      VALIDADO: ['IMPORTADO', 'FALLIDO'],
      IMPORTADO: [], // Terminal
      FALLIDO: [], // Terminal
    };

    if (!validTransitions[session.state].includes(newState)) {
      return {
        success: false,
        error: `Transición inválida de ${session.state} a ${newState}`,
      };
    }

    session.state = newState;

    if (newState === 'IMPORTADO' || newState === 'FALLIDO') {
      session.completedAt = new Date();
    }

    this.sessions.set(sessionId, session);
    return { success: true, session };
  }

  /**
   * Registra un error en la sesión
   */
  addError(sessionId: string, error: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.validationErrors.push(error);
    session.errorRows++;
  }

  /**
   * Registra una advertencia en la sesión
   */
  addWarning(sessionId: string, warning: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.validationWarnings.push(warning);
    session.rowsWithWarnings++;
  }

  /**
   * Actualiza el recuento de filas procesadas
   */
  updateRowCount(sessionId: string, processed: number, total: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.processedRows = processed;
    session.totalRows = total;
  }

  /**
   * Establece los mapeos de columnas
   */
  setColumnMappings(
    sessionId: string,
    mappings: Record<string, string>
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.columnMappings = mappings;
  }

  /**
   * Obtiene el progreso de una sesión
   */
  getProgress(sessionId: string): {
    percentage: number;
    processedRows: number;
    totalRows: number;
    status: string;
  } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const percentage =
      session.totalRows > 0
        ? Math.round((session.processedRows / session.totalRows) * 100)
        : 0;

    return {
      percentage,
      processedRows: session.processedRows,
      totalRows: session.totalRows,
      status: session.state,
    };
  }

  /**
   * Valida que una sesión esté lista para pasar a siguiente etapa
   */
  validateReadiness(sessionId: string): {
    canContinue: boolean;
    blockers: string[];
  } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { canContinue: false, blockers: ['Sesión no encontrada'] };
    }

    const blockers: string[] = [];

    // Validación por estado actual
    switch (session.state) {
      case 'INICIADO':
        if (session.totalRows === 0) {
          blockers.push('No se han cargado filas');
        }
        break;

      case 'PARSEADO':
        if (Object.keys(session.columnMappings).length === 0) {
          blockers.push('No se han configurado mapeos de columnas');
        }
        break;

      case 'MAPEADO':
        if (session.validationErrors.length > 0) {
          blockers.push(
            `Hay ${session.validationErrors.length} errores de validación`
          );
        }
        break;

      case 'VALIDADO':
        if (session.errorRows > 0) {
          blockers.push(`Hay ${session.errorRows} filas con errores`);
        }
        break;
    }

    return {
      canContinue: blockers.length === 0,
      blockers,
    };
  }

  /**
   * Genera un resumen de la sesión
   */
  getSummary(sessionId: string): {
    id: string;
    state: ImportState;
    ejercicio: number;
    totalRows: number;
    processedRows: number;
    errorRows: number;
    duration: string;
    success: boolean;
  } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const duration = this.formatDuration(
      session.startedAt,
      session.completedAt || new Date()
    );

    return {
      id: session.id,
      state: session.state,
      ejercicio: session.ejercicio,
      totalRows: session.totalRows,
      processedRows: session.processedRows,
      errorRows: session.errorRows,
      duration,
      success: session.state === 'IMPORTADO' && session.errorRows === 0,
    };
  }

  /**
   * Cancela una sesión en curso
   */
  cancelSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    if (['IMPORTADO', 'FALLIDO'].includes(session.state)) {
      return false; // No se puede cancelar sesión terminada
    }

    session.state = 'FALLIDO';
    session.completedAt = new Date();
    this.sessions.set(sessionId, session);
    return true;
  }

  /**
   * Limpia sesiones antiguas (más de X horas)
   */
  cleanupOldSessions(maxAgeHours: number = 24): number {
    const now = new Date();
    const maxAge = maxAgeHours * 60 * 60 * 1000;
    let cleaned = 0;

    for (const [id, session] of this.sessions) {
      const age = now.getTime() - session.startedAt.getTime();
      if (age > maxAge && ['IMPORTADO', 'FALLIDO'].includes(session.state)) {
        this.sessions.delete(id);
        cleaned++;
      }
    }

    return cleaned;
  }

  // Privadas

  private generateId(): string {
    return `import_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private formatDuration(start: Date, end: Date): string {
    const ms = end.getTime() - start.getTime();
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
}
