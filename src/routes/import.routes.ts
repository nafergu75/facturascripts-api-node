/**
 * Import Routes
 * Rutas para importación de datos contables históricos
 */

import express, { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import importController from '../controllers/import.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();

// Configurar multer para uploads
const uploadsDir = path.join(process.cwd(), 'uploads', 'imports');
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
    fileSize: 50 * 1024 * 1024, // 50MB
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls', '.csv'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Solo se aceptan archivos .xlsx, .xls o .csv'));
    }
  },
});

/**
 * POST /companies/:companyId/import/upload
 * Sube un archivo para importación
 * Body:
 *   - importType: 'BALANCE' | 'MAYOR' | 'PYG'
 *   - ejercicio: number
 *   - sheetName?: string (opcional, para Excel)
 */
router.post(
  '/:companyId/import/upload',
  authMiddleware,
  upload.single('file'),
  importController.upload.bind(importController)
);

/**
 * POST /companies/:companyId/import/:sessionId/suggest-mapping
 * Obtiene mapeos sugeridos de columnas
 * Body:
 *   - columnMappings: Record<string, string | null>
 */
router.post(
  '/:companyId/import/:sessionId/suggest-mapping',
  authMiddleware,
  importController.suggestMapping.bind(importController)
);

/**
 * POST /companies/:companyId/import/:sessionId/validate
 * Valida los datos sin importar
 * Body:
 *   - columnMappings: Record<string, string>
 *   - manualAccountMappings?: Record<string, string>
 *   - companyId: string
 *   - importType: 'BALANCE' | 'MAYOR' | 'PYG'
 *   - ejercicio: number
 *   - sheetName?: string
 */
router.post(
  '/:companyId/import/:sessionId/validate',
  authMiddleware,
  importController.validate.bind(importController)
);

/**
 * POST /companies/:companyId/import/:sessionId/confirm
 * Confirma e importa los datos
 * Body:
 *   - columnMappings: Record<string, string>
 *   - manualAccountMappings?: Record<string, string>
 *   - companyId: string
 *   - importType: 'BALANCE' | 'MAYOR' | 'PYG'
 *   - ejercicio: number
 *   - sheetName?: string
 */
router.post(
  '/:companyId/import/:sessionId/confirm',
  authMiddleware,
  importController.confirm.bind(importController)
);

/**
 * GET /companies/:companyId/import/:sessionId/status
 * Obtiene el estado de una importación
 */
router.get(
  '/:companyId/import/:sessionId/status',
  authMiddleware,
  importController.getStatus.bind(importController)
);

/**
 * GET /companies/:companyId/import/:sessionId/progress
 * Obtiene el progreso de una importación
 */
router.get(
  '/:companyId/import/:sessionId/progress',
  authMiddleware,
  importController.getProgress.bind(importController)
);

/**
 * GET /companies/:companyId/import/:sessionId/opening-entry
 * Obtiene el asiento de apertura generado
 * Query:
 *   - format?: 'json' | 'csv' (default: 'json')
 */
router.get(
  '/:companyId/import/:sessionId/opening-entry',
  authMiddleware,
  importController.getOpeningEntry.bind(importController)
);

/**
 * DELETE /companies/:companyId/import/:sessionId/cancel
 * Cancela una importación en curso
 */
router.delete(
  '/:companyId/import/:sessionId/cancel',
  authMiddleware,
  importController.cancel.bind(importController)
);

export default router;
