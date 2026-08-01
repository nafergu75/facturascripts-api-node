/**
 * iLovePDF Service
 * Integración con la API REST de iLovePDF para OCR de PDFs
 * Documentación: https://developer.ilovepdf.com/
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import ILovePDFConfig from '../config/ilovepdf.config';
import { logger } from '../config/logger';

// Tipos para la respuesta
export interface OCRResult {
  ocrPdfPath: string;
  pages: number;
  fileName: string;
  processingTime: number; // en segundos
  fileSize: number; // bytes del PDF OCR
}

export interface OCRError {
  code: string;
  message: string;
  details?: Record<string, any>;
}

/**
 * Servicio de iLovePDF para procesamiento OCR
 * Nota: La librería oficial de iLovePDF se importa dinámicamente
 * ya que puede no estar instalada en todos los entornos
 */
export class ILovePDFService {
  /**
   * Procesa un PDF con OCR usando la API REST de iLovePDF
   * @param localFilePath - Ruta al archivo PDF local
   * @param options - Opciones adicionales
   * @returns Información del PDF procesado
   */
  async ocrInvoicePdf(
    localFilePath: string,
    options?: {
      language?: string;
      defaultDownloadFormat?: string;
    }
  ): Promise<OCRResult> {
    const startTime = Date.now();

    // Validar que el archivo existe
    if (!fs.existsSync(localFilePath)) {
      throw this.createError('FILE_NOT_FOUND', `File not found: ${localFilePath}`);
    }

    // Validar tamaño del archivo
    const stats = fs.statSync(localFilePath);
    if (stats.size > ILovePDFConfig.limits.maxFileSizeBytes) {
      throw this.createError('FILE_TOO_LARGE',
        `File size (${stats.size} bytes) exceeds limit (${ILovePDFConfig.limits.maxFileSizeBytes} bytes)`
      );
    }

    let taskId: string | null = null;

    try {
      const { publicKey, secretKey } = ILovePDFConfig.getClientConfig();

      logger.info(`[iLovePDF] Iniciando OCR para: ${path.basename(localFilePath)}`);

      // STEP 1: Crear tarea OCR
      logger.debug(`[iLovePDF] Creando tarea OCR...`);
      const createTaskResponse = await axios.post(
        'https://api.ilovepdf.com/v1/start/ocr',
        {},
        {
          headers: {
            Authorization: `Bearer ${publicKey}`,
          },
        }
      );

      taskId = createTaskResponse.data.task;
      logger.debug(`[iLovePDF] Tarea creada: ${taskId}`);

      // STEP 2: Subir archivo
      logger.debug(`[iLovePDF] Subiendo archivo: ${localFilePath}`);
      const formData = new FormData();
      formData.append('file', fs.createReadStream(localFilePath));
      formData.append('task', taskId);

      await axios.post(
        'https://api.ilovepdf.com/v1/upload',
        formData,
        {
          headers: {
            ...formData.getHeaders(),
            Authorization: `Bearer ${publicKey}`,
          },
        }
      );

      logger.debug(`[iLovePDF] Archivo subido`);

      // STEP 3: Ejecutar OCR
      logger.debug(`[iLovePDF] Ejecutando OCR...`);
      await axios.post(
        'https://api.ilovepdf.com/v1/process',
        {
          task: taskId,
          language: options?.language || 'es',
        },
        {
          headers: {
            Authorization: `Bearer ${publicKey}`,
          },
        }
      );

      // STEP 4: Esperar a que termine (polling)
      const maxAttempts = 120; // 10 minutos
      let attempts = 0;
      let taskStatus = 'processing';

      while (taskStatus === 'processing' && attempts < maxAttempts) {
        await this.sleep(5000);
        attempts++;

        const statusResponse = await axios.get(
          `https://api.ilovepdf.com/v1/task/${taskId}`,
          {
            headers: {
              Authorization: `Bearer ${publicKey}`,
            },
          }
        );

        taskStatus = statusResponse.data.status;
        logger.debug(`[iLovePDF] Status check ${attempts}/${maxAttempts}: ${taskStatus}`);
      }

      if (taskStatus !== 'completed') {
        throw this.createError('PROCESSING_TIMEOUT',
          `OCR processing failed or timed out. Status: ${taskStatus}`
        );
      }

      logger.info(`[iLovePDF] OCR completado después de ${attempts * 5}s`);

      // STEP 5: Descargar PDF procesado
      const destDir = ILovePDFConfig.paths.tempOcr;
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }

      const fileName = `ocr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.pdf`;
      const ocrPdfPath = path.join(destDir, fileName);

      logger.debug(`[iLovePDF] Descargando PDF OCR a: ${ocrPdfPath}`);

      const downloadResponse = await axios.get(
        `https://api.ilovepdf.com/v1/download/${taskId}`,
        {
          headers: {
            Authorization: `Bearer ${publicKey}`,
          },
          responseType: 'arraybuffer',
        }
      );

      fs.writeFileSync(ocrPdfPath, downloadResponse.data);

      if (!fs.existsSync(ocrPdfPath)) {
        throw this.createError('DOWNLOAD_FAILED', 'Failed to download OCR PDF');
      }

      const ocrStats = fs.statSync(ocrPdfPath);
      const processingTime = Math.round((Date.now() - startTime) / 1000);

      logger.info(`[iLovePDF] OCR exitoso. Tiempo: ${processingTime}s, Tamaño: ${ocrStats.size} bytes`);

      return {
        ocrPdfPath,
        pages: 1, // iLovePDF no retorna página count directamente
        fileName: path.basename(localFilePath),
        processingTime,
        fileSize: ocrStats.size,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[iLovePDF] Error en OCR: ${errorMsg}`);

      if (error instanceof Error && 'code' in error) {
        throw error;
      }

      if (errorMsg.includes('authentication') || errorMsg.includes('401')) {
        throw this.createError('AUTH_FAILED',
          'iLovePDF authentication failed. Check API keys.'
        );
      }

      if (errorMsg.includes('credits') || errorMsg.includes('quota')) {
        throw this.createError('INSUFFICIENT_CREDITS',
          'Insufficient credits in iLovePDF account'
        );
      }

      if (errorMsg.includes('timeout') || errorMsg.includes('ETIMEDOUT')) {
        throw this.createError('TIMEOUT',
          'iLovePDF request timed out'
        );
      }

      throw this.createError('PROCESSING_ERROR', errorMsg);
    }
  }

  /**
   * Limpia archivos temporales más antiguos de X días
   * @param daysOld - Archivos más antiguos que este número de días serán eliminados
   */
  async cleanupOldFiles(daysOld: number = 7): Promise<{ deleted: number; failed: number }> {
    const dirs = [ILovePDFConfig.paths.tempUpload, ILovePDFConfig.paths.tempOcr];
    let deleted = 0;
    let failed = 0;
    const now = Date.now();
    const ageMs = daysOld * 24 * 60 * 60 * 1000;

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;

      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const filePath = path.join(dir, file);
          const stats = fs.statSync(filePath);

          if (now - stats.mtimeMs > ageMs) {
            try {
              fs.unlinkSync(filePath);
              deleted++;
            } catch (e) {
              logger.warn(`Failed to delete file: ${filePath}`);
              failed++;
            }
          }
        }
      } catch (error) {
        logger.error(`Error cleaning up directory ${dir}: ${error}`);
      }
    }

    logger.info(`[iLovePDF] Cleanup: ${deleted} archivos eliminados, ${failed} fallos`);
    return { deleted, failed };
  }

  /**
   * Obtiene información sobre el uso de la cuenta (si está disponible)
   */
  async getAccountInfo(): Promise<Record<string, any>> {
    try {
      const { publicKey } = ILovePDFConfig.getClientConfig();

      return {
        authenticated: !!publicKey,
        service: 'iLovePDF',
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      logger.error(`Failed to get account info: ${error}`);
      return {};
    }
  }

  // Privados

  /**
   * Crea un error tipado
   */
  private createError(code: string, message: string): Error & OCRError {
    const error = new Error(message) as Error & OCRError;
    error.code = code;
    error.message = message;
    return error;
  }

  /**
   * Helper para dormir (usado en polling)
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default new ILovePDFService();
