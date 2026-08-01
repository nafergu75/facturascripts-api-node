/**
 * OCR Controller
 * Maneja peticiones para OCR de PDFs usando iLovePDF
 */

import { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import ILovePDFService from '../services/ilovepdf.service';
import { extractTextFromPdf, validatePdfFile } from '../utils/pdfTextExtractor';
import { logger } from '../config/logger';
import ILovePDFConfig from '../config/ilovepdf.config';
import OCRPersistenceService from '../services/ocr-persistence.service';

// Schemas de validación
const ocrInvoiceSchema = z.object({
  invoiceType: z.enum(['expense', 'income']).optional().default('expense'),
  language: z.string().optional().default('es'),
  source: z.enum(['email', 'manual', 'api']).optional().default('manual'),
});

interface OCRResponse {
  ok: boolean;
  data?: {
    ocrText: string;
    ocrPdfPath: string;
    pages: number;
    originalFileName: string;
    processingTime: number;
    invoiceType: string;
    charCount: number;
    sessionId?: string;
    documentId?: string;
  };
  error?: string;
  details?: Record<string, any>;
  sessionId?: string;
}

class OCRController {
  /**
   * POST /companies/:companyId/ocr/invoices
   * Procesa un PDF de factura con OCR
   */
  async processInvoiceOcr(req: Request, res: Response<OCRResponse>) {
    const startTime = Date.now();
    let tempUploadPath: string | null = null;
    let ocrSessionId: string | null = null;

    try {
      // Validar que el archivo está presente
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error: 'PDF file is required',
        });
      }

      // Validar el body
      const bodyParsed = ocrInvoiceSchema.parse(req.body);

      tempUploadPath = req.file.path;
      const fileName = req.file.originalname;
      const companyId = req.params.companyId;
      const userId = (req as any).user?.id;

      logger.info(
        `[OCR] Iniciando OCR para: ${fileName} (Empresa: ${companyId}, Tipo: ${bodyParsed.invoiceType})`
      );

      // STEP 1: Crear sesión en BD
      const ocrSession = await OCRPersistenceService.createSession({
        companyId,
        userId,
        originalFileName: fileName,
        originalFilePath: tempUploadPath,
        originalFileSize: req.file.size,
        originalMimeType: req.file.mimetype,
        language: bodyParsed.language,
        invoiceType: bodyParsed.invoiceType,
        source: bodyParsed.source,
      });

      ocrSessionId = ocrSession.id;
      logger.debug(`[OCR] Sesión OCR creada: ${ocrSessionId}`);

      // STEP 2: Validar que el PDF es válido
      logger.debug(`[OCR] Validando PDF...`);
      const validation = await validatePdfFile(tempUploadPath);
      if (!validation.isValid) {
        await OCRPersistenceService.markSessionFailed(
          ocrSessionId,
          'INVALID_PDF',
          validation.error || 'Invalid PDF file'
        );

        return res.status(400).json({
          ok: false,
          error: 'Invalid PDF file',
          details: { validationError: validation.error },
        });
      }

      // STEP 3: Procesar con iLovePDF
      logger.debug(`[OCR] Procesando con iLovePDF (idioma: ${bodyParsed.language})...`);
      await OCRPersistenceService.updateSession(ocrSessionId, {
        status: 'PROCESSING',
        processingStartedAt: new Date(),
      });

      const ocrResult = await ILovePDFService.ocrInvoicePdf(tempUploadPath, {
        language: bodyParsed.language,
      });

      // STEP 4: Extraer texto del PDF OCR
      logger.debug(`[OCR] Extrayendo texto del PDF OCR...`);
      const textExtraction = await extractTextFromPdf(ocrResult.ocrPdfPath, {
        returnPageTexts: false,
        minimalCleanup: false,
      });

      const processingTime = Math.round((Date.now() - startTime) / 1000);

      logger.info(
        `[OCR] OCR exitoso: ${textExtraction.pages} páginas, ${textExtraction.cleanCharCount} caracteres, ${processingTime}s`
      );

      // STEP 5: Guardar resultado en BD
      await OCRPersistenceService.markSessionCompleted(ocrSessionId, {
        processingTimeSeconds: processingTime,
        ocrPdfPath: ocrResult.ocrPdfPath,
        ocrPdfSize: ocrResult.fileSize,
        ocrTextExtracted: textExtraction.text,
        ocrPageCount: textExtraction.pages,
        ocrCharCount: textExtraction.cleanCharCount,
      });

      // STEP 6: Crear documento OCR vinculado
      const ocrDocument = await OCRPersistenceService.createDocument({
        companyId,
        sessionId: ocrSessionId,
        extractedData: {
          ocrText: textExtraction.text,
          pages: textExtraction.pages,
          charCount: textExtraction.cleanCharCount,
          language: bodyParsed.language,
          invoiceType: bodyParsed.invoiceType,
        },
        confidenceScore: 0.95, // iLovePDF es muy confiable
      });

      logger.debug(`[OCR] Documento OCR guardado: ${ocrDocument.id}`);

      // STEP 7: Retornar resultado
      return res.status(200).json({
        ok: true,
        data: {
          ocrText: textExtraction.text,
          ocrPdfPath: ocrResult.ocrPdfPath,
          pages: ocrResult.pages,
          originalFileName: fileName,
          processingTime,
          invoiceType: bodyParsed.invoiceType,
          charCount: textExtraction.cleanCharCount,
          sessionId: ocrSessionId,
          documentId: ocrDocument.id,
        },
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[OCR] Error en OCR: ${errorMsg}`);

      // Registrar error en BD si tenemos sessionId
      if (ocrSessionId) {
        try {
          const errorCode = this.getErrorCode(errorMsg);
          await OCRPersistenceService.markSessionFailed(
            ocrSessionId,
            errorCode,
            errorMsg
          );
        } catch (dbError) {
          logger.error(`[OCR] Error guardando fallo en BD: ${dbError}`);
        }
      }

      // Limpiar archivo temporal en caso de error
      if (tempUploadPath && fs.existsSync(tempUploadPath)) {
        try {
          fs.unlinkSync(tempUploadPath);
        } catch (e) {
          logger.warn(`Failed to cleanup temp file: ${tempUploadPath}`);
        }
      }

      // Mapear errores específicos a códigos HTTP
      if (errorMsg.includes('not found')) {
        return res.status(400).json({
          ok: false,
          error: 'PDF file not found',
          sessionId: ocrSessionId ?? undefined,
        });
      }

      if (errorMsg.includes('too large') || errorMsg.includes('exceeds limit')) {
        return res.status(413).json({
          ok: false,
          error: 'File too large',
          details: { maxSize: ILovePDFConfig.limits.maxFileSizeBytes },
          sessionId: ocrSessionId ?? undefined,
        });
      }

      if (errorMsg.includes('authentication') || errorMsg.includes('AUTH_FAILED')) {
        return res.status(503).json({
          ok: false,
          error: 'iLovePDF authentication failed. Check API keys.',
          sessionId: ocrSessionId ?? undefined,
        });
      }

      if (errorMsg.includes('credits') || errorMsg.includes('INSUFFICIENT_CREDITS')) {
        return res.status(503).json({
          ok: false,
          error: 'Insufficient credits in iLovePDF account',
          sessionId: ocrSessionId ?? undefined,
        });
      }

      if (errorMsg.includes('timeout') || errorMsg.includes('TIMEOUT')) {
        return res.status(504).json({
          ok: false,
          error: 'OCR processing timed out. Please try again.',
          sessionId: ocrSessionId ?? undefined,
        });
      }

      // Error genérico
      return res.status(500).json({
        ok: false,
        error: 'Failed to process invoice OCR',
        details: { message: errorMsg },
        sessionId: ocrSessionId ?? undefined,
      });
    }
  }

  /**
   * GET /companies/:companyId/ocr/status
   * Obtiene información sobre el estado del servicio OCR
   */
  async getOCRStatus(req: Request, res: Response) {
    try {
      const companyId = req.params.companyId;
      const { limit = 10, offset = 0 } = req.query;

      // Verificar que iLovePDF esté configurado
      try {
        ILovePDFConfig.validate();
      } catch (e) {
        return res.status(503).json({
          ok: false,
          error: 'iLovePDF not configured',
        });
      }

      // Obtener información de la cuenta
      const accountInfo = await ILovePDFService.getAccountInfo();

      // Verificar espacio en directorio temporal
      const tempDirs = {
        uploads: ILovePDFConfig.paths.tempUpload,
        ocr: ILovePDFConfig.paths.tempOcr,
      };

      const diskSpace = {
        uploads: this.getDirSize(tempDirs.uploads),
        ocr: this.getDirSize(tempDirs.ocr),
      };

      // Obtener estadísticas de OCR
      const stats = await OCRPersistenceService.getOCRStats(companyId);

      // Obtener histórico reciente
      const recentSessions = await OCRPersistenceService.getSessionHistory(
        companyId,
        {
          limit: Number(limit) || 10,
          offset: Number(offset) || 0,
        }
      );

      return res.status(200).json({
        ok: true,
        data: {
          service: 'iLovePDF',
          status: 'operational',
          companyId,
          limits: {
            maxFileSize: `${ILovePDFConfig.limits.maxFileSizeBytes / (1024 * 1024)}MB`,
            maxPages: ILovePDFConfig.limits.maxPages,
          },
          account: accountInfo,
          diskUsage: diskSpace,
          stats,
          recentSessions: recentSessions.map((s) => ({
            id: s.id,
            status: s.status,
            invoiceType: s.invoiceType,
            processingTimeSeconds: s.processingTimeSeconds,
            ocrCharCount: s.ocrCharCount,
            errorCode: s.errorCode,
            createdAt: s.createdAt,
          })),
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[OCR] Error getting status: ${errorMsg}`);

      return res.status(500).json({
        ok: false,
        error: 'Failed to get OCR status',
      });
    }
  }

  /**
   * POST /companies/:companyId/ocr/cleanup
   * Limpia archivos temporales antiguos (admin only)
   */
  async cleanupTemporaryFiles(req: Request, res: Response) {
    try {
      // Idealmente, esto debería estar protegido por middleware de admin
      const daysOld = req.body.daysOld || 7;

      logger.info(`[OCR] Iniciando limpieza de archivos > ${daysOld} días...`);

      const result = await ILovePDFService.cleanupOldFiles(daysOld);

      return res.status(200).json({
        ok: true,
        data: {
          deleted: result.deleted,
          failed: result.failed,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[OCR] Error en cleanup: ${errorMsg}`);

      return res.status(500).json({
        ok: false,
        error: 'Failed to cleanup temporary files',
      });
    }
  }

  // Privados

  /**
   * Calcula el tamaño de un directorio
   */
  private getDirSize(dirPath: string): string {
    if (!fs.existsSync(dirPath)) {
      return '0 B';
    }

    try {
      let size = 0;
      const files = fs.readdirSync(dirPath);

      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const stats = fs.statSync(filePath);
        size += stats.size;
      }

      return this.formatBytes(size);
    } catch {
      return 'unknown';
    }
  }

  /**
   * Formatea bytes a unidad legible
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';

    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Mapea mensaje de error a código de error consistente
   */
  private getErrorCode(errorMsg: string): string {
    if (errorMsg.includes('not found')) return 'FILE_NOT_FOUND';
    if (errorMsg.includes('too large')) return 'FILE_TOO_LARGE';
    if (errorMsg.includes('authentication') || errorMsg.includes('AUTH_FAILED'))
      return 'AUTH_FAILED';
    if (errorMsg.includes('credits')) return 'INSUFFICIENT_CREDITS';
    if (errorMsg.includes('timeout')) return 'PROCESSING_TIMEOUT';
    if (errorMsg.includes('Invalid PDF')) return 'INVALID_PDF';
    return 'UNKNOWN_ERROR';
  }
}

export default new OCRController();
