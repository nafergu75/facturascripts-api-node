/**
 * OCR Persistence Service
 * Maneja la persistencia de sesiones y documentos OCR en la base de datos
 */

import { PrismaClient } from '@prisma/client';
import { logger } from '../config/logger';

const prisma = new PrismaClient();

export interface CreateOCRSessionInput {
  companyId: string;
  userId?: string;
  originalFileName: string;
  originalFilePath: string;
  originalFileSize: number;
  originalMimeType: string;
  language?: string;
  invoiceType?: 'expense' | 'income';
  source?: 'manual' | 'email' | 'api';
}

export interface UpdateOCRSessionInput {
  status?: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  ilovepdfTaskId?: string;
  processingStartedAt?: Date;
  processingCompletedAt?: Date;
  processingTimeSeconds?: number;
  ocrPdfPath?: string;
  ocrPdfSize?: number;
  ocrTextExtracted?: string;
  ocrPageCount?: number;
  ocrCharCount?: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface CreateOCRDocumentInput {
  companyId: string;
  sessionId: string;
  extractedData?: Record<string, any>;
  linkedInvoiceId?: string;
  linkedReaderDocument?: string;
  confidenceScore?: number;
}

/**
 * Servicio de persistencia para OCR
 */
export class OCRPersistenceService {
  /**
   * Crea una nueva sesión de OCR
   */
  async createSession(input: CreateOCRSessionInput) {
    try {
      const session = await prisma.oCRSession.create({
        data: {
          companyId: input.companyId,
          userId: input.userId,
          originalFileName: input.originalFileName,
          originalFilePath: input.originalFilePath,
          originalFileSize: input.originalFileSize,
          originalMimeType: input.originalMimeType,
          language: input.language || 'es',
          invoiceType: input.invoiceType || 'expense',
          source: input.source || 'manual',
        },
      });

      logger.info(`[OCR-Persistence] Sesión creada: ${session.id}`);
      return session;
    } catch (error) {
      logger.error(`[OCR-Persistence] Error creando sesión: ${error}`);
      throw error;
    }
  }

  /**
   * Obtiene una sesión OCR por ID
   */
  async getSession(sessionId: string) {
    try {
      return await prisma.oCRSession.findUnique({
        where: { id: sessionId },
        include: { documents: true },
      });
    } catch (error) {
      logger.error(`[OCR-Persistence] Error obteniendo sesión: ${error}`);
      throw error;
    }
  }

  /**
   * Actualiza una sesión OCR
   */
  async updateSession(sessionId: string, input: UpdateOCRSessionInput) {
    try {
      const session = await prisma.oCRSession.update({
        where: { id: sessionId },
        data: {
          ...input,
          updatedAt: new Date(),
        },
      });

      logger.debug(`[OCR-Persistence] Sesión actualizada: ${sessionId}`);
      return session;
    } catch (error) {
      logger.error(`[OCR-Persistence] Error actualizando sesión: ${error}`);
      throw error;
    }
  }

  /**
   * Marca una sesión como completada exitosamente
   */
  async markSessionCompleted(
    sessionId: string,
    data: {
      processingTimeSeconds: number;
      ocrPdfPath: string;
      ocrPdfSize: number;
      ocrTextExtracted: string;
      ocrPageCount: number;
      ocrCharCount: number;
    }
  ) {
    return this.updateSession(sessionId, {
      status: 'COMPLETED',
      processingCompletedAt: new Date(),
      ...data,
    });
  }

  /**
   * Marca una sesión como fallida
   */
  async markSessionFailed(
    sessionId: string,
    errorCode: string,
    errorMessage: string
  ) {
    return this.updateSession(sessionId, {
      status: 'FAILED',
      processingCompletedAt: new Date(),
      errorCode,
      errorMessage,
    });
  }

  /**
   * Crea un documento OCR vinculado a una sesión
   */
  async createDocument(input: CreateOCRDocumentInput) {
    try {
      const document = await prisma.oCRDocument.create({
        data: {
          companyId: input.companyId,
          sessionId: input.sessionId,
          extractedData: input.extractedData,
          linkedInvoiceId: input.linkedInvoiceId,
          linkedReaderDocument: input.linkedReaderDocument,
          confidenceScore: input.confidenceScore,
        },
      });

      logger.info(`[OCR-Persistence] Documento creado: ${document.id}`);
      return document;
    } catch (error) {
      logger.error(`[OCR-Persistence] Error creando documento: ${error}`);
      throw error;
    }
  }

  /**
   * Obtiene un documento OCR
   */
  async getDocument(documentId: string) {
    try {
      return await prisma.oCRDocument.findUnique({
        where: { id: documentId },
        include: { session: true },
      });
    } catch (error) {
      logger.error(`[OCR-Persistence] Error obteniendo documento: ${error}`);
      throw error;
    }
  }

  /**
   * Vincula un documento OCR a una factura
   */
  async linkDocumentToInvoice(documentId: string, invoiceId: string) {
    try {
      return await prisma.oCRDocument.update({
        where: { id: documentId },
        data: { linkedInvoiceId: invoiceId },
      });
    } catch (error) {
      logger.error(`[OCR-Persistence] Error vinculando documento: ${error}`);
      throw error;
    }
  }

  /**
   * Obtiene historial de OCR por empresa
   */
  async getSessionHistory(
    companyId: string,
    options?: {
      status?: string;
      invoiceType?: string;
      limit?: number;
      offset?: number;
    }
  ) {
    try {
      const where: any = { companyId };

      if (options?.status) {
        where.status = options.status;
      }

      if (options?.invoiceType) {
        where.invoiceType = options.invoiceType;
      }

      const sessions = await prisma.oCRSession.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: options?.limit || 50,
        skip: options?.offset || 0,
        include: { documents: true },
      });

      return sessions;
    } catch (error) {
      logger.error(`[OCR-Persistence] Error obteniendo historial: ${error}`);
      throw error;
    }
  }

  /**
   * Obtiene estadísticas de OCR por empresa
   */
  async getOCRStats(companyId: string, exercisio?: number) {
    try {
      const where: any = { companyId };

      if (exercisio) {
        // Filtrar por año fiscal (createdAt)
        const yearStart = new Date(exercisio, 0, 1);
        const yearEnd = new Date(exercisio + 1, 0, 1);
        where.createdAt = {
          gte: yearStart,
          lt: yearEnd,
        };
      }

      const total = await prisma.oCRSession.count({ where });

      const completed = await prisma.oCRSession.count({
        where: { ...where, status: 'COMPLETED' },
      });

      const failed = await prisma.oCRSession.count({
        where: { ...where, status: 'FAILED' },
      });

      const avgProcessingTime =
        (
          await prisma.oCRSession.aggregate({
            where: { ...where, status: 'COMPLETED' },
            _avg: { processingTimeSeconds: true },
          })
        )._avg.processingTimeSeconds || 0;

      const avgCharCount =
        (
          await prisma.oCRSession.aggregate({
            where: { ...where, status: 'COMPLETED' },
            _avg: { ocrCharCount: true },
          })
        )._avg.ocrCharCount || 0;

      return {
        total,
        completed,
        failed,
        pending: total - completed - failed,
        successRate: total > 0 ? (completed / total) * 100 : 0,
        averageProcessingTimeSeconds: Math.round(avgProcessingTime),
        averageCharactersExtracted: Math.round(avgCharCount),
      };
    } catch (error) {
      logger.error(`[OCR-Persistence] Error obteniendo stats: ${error}`);
      throw error;
    }
  }

  /**
   * Limpia sesiones antiguas (para mantener base de datos limpia)
   */
  async cleanupOldSessions(daysOld: number = 30): Promise<{ deleted: number }> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOld);

      // Solo eliminar sesiones fallidas o completadas
      const result = await prisma.oCRSession.deleteMany({
        where: {
          createdAt: { lt: cutoffDate },
          status: { in: ['COMPLETED', 'FAILED'] },
        },
      });

      logger.info(`[OCR-Persistence] Limpieza: ${result.count} sesiones eliminadas`);
      return { deleted: result.count };
    } catch (error) {
      logger.error(`[OCR-Persistence] Error en cleanup: ${error}`);
      throw error;
    }
  }

  /**
   * Exporta sesiones a JSON para análisis
   */
  async exportSessionsAsJSON(
    companyId: string,
    status?: string
  ): Promise<string> {
    try {
      const sessions = await this.getSessionHistory(companyId, { status });

      return JSON.stringify(sessions, null, 2);
    } catch (error) {
      logger.error(`[OCR-Persistence] Error exportando sesiones: ${error}`);
      throw error;
    }
  }
}

export default new OCRPersistenceService();
