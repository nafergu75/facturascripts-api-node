/**
 * OCR Routes
 * Rutas para procesamiento de OCR de facturas con iLovePDF
 */

import express, { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import ocrController from '../controllers/ocr.controller';
import ILovePDFConfig from '../config/ilovepdf.config';

const router = Router();

// Configurar multer para uploads de PDFs
const uploadsDir = ILovePDFConfig.paths.tempUpload;
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substr(2, 9);
    const ext = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext);
    cb(null, `${name}_${timestamp}_${random}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: ILovePDFConfig.limits.maxFileSizeBytes,
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.pdf'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  },
});

/**
 * POST /companies/ocr/invoices
 * Procesa un PDF de factura con OCR
 *
 * Body (multipart/form-data):
 *   - file: archivo PDF
 *   - invoiceType: 'expense' | 'income' (opcional, default: 'expense')
 *   - language: código de idioma (opcional, default: 'es')
 *   - source: 'email' | 'manual' | 'api' (opcional, default: 'manual')
 *
 * Response:
 * {
 *   "ok": true,
 *   "data": {
 *     "ocrText": "texto extraído del PDF",
 *     "ocrPdfPath": "/tmp/ocr/processed/...",
 *     "pages": 1,
 *     "originalFileName": "factura_123.pdf",
 *     "processingTime": 5,
 *     "invoiceType": "expense",
 *     "charCount": 2500
 *   }
 * }
 */
router.post(
  '/ocr/invoices',
  upload.single('file'),
  ocrController.processInvoiceOcr.bind(ocrController)
);

/**
 * GET /companies/ocr/status
 * Obtiene información sobre el estado del servicio OCR
 *
 * Response:
 * {
 *   "ok": true,
 *   "data": {
 *     "service": "iLovePDF",
 *     "status": "operational",
 *     "limits": { ... },
 *     "account": { ... },
 *     "diskUsage": { ... }
 *   }
 * }
 */
router.get('/ocr/status', ocrController.getOCRStatus.bind(ocrController));

/**
 * POST /companies/ocr/cleanup
 * Limpia archivos temporales antiguos
 * Requiere autenticación de admin
 *
 * Body (opcional):
 * {
 *   "daysOld": 7  (archivos más antiguos que esto serán eliminados)
 * }
 *
 * Response:
 * {
 *   "ok": true,
 *   "data": {
 *     "deleted": 5,
 *     "failed": 0,
 *     "timestamp": "2026-07-18T..."
 *   }
 * }
 */
router.post(
  '/ocr/cleanup',
  ocrController.cleanupTemporaryFiles.bind(ocrController)
);

export default router;
