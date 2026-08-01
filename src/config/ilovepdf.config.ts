/**
 * iLovePDF Configuration
 * Inicializa y configura la librería oficial de iLovePDF
 * Documentación: https://github.com/ilovepdf/ilovepdf-nodejs
 */

import { config } from 'dotenv';

config();

export class ILovePDFConfig {
  public static readonly publicKey = process.env.ILOVEPDF_PUBLIC_KEY;
  public static readonly secretKey = process.env.ILOVEPDF_SECRET_KEY;

  /**
   * Valida que las claves estén configuradas
   */
  public static validate(): void {
    if (!this.publicKey || !this.secretKey) {
      throw new Error(
        'iLovePDF API keys not configured. Set ILOVEPDF_PUBLIC_KEY and ILOVEPDF_SECRET_KEY in .env'
      );
    }
  }

  /**
   * Retorna la configuración para inicializar el cliente
   */
  public static getClientConfig() {
    this.validate();
    return {
      publicKey: this.publicKey!,
      secretKey: this.secretKey!,
    };
  }

  /**
   * Límites de uso de iLovePDF (según plan gratuito/pagado)
   */
  public static readonly limits = {
    maxFileSizeBytes: 150 * 1024 * 1024, // 150MB (plan gratuito)
    maxPages: 1000, // Máx páginas por tarea
    maxRequestsPerHour: 100, // Rate limit típico
  };

  /**
   * Paths de almacenamiento temporal
   */
  public static readonly paths = {
    // Donde se guardan los PDFs subidos temporalmente
    tempUpload: process.env.TEMP_UPLOAD_DIR || '/tmp/ocr/uploads',
    // Donde se guardan los PDFs procesados por iLovePDF
    tempOcr: process.env.TEMP_OCR_DIR || '/tmp/ocr/processed',
  };
}

export default ILovePDFConfig;
