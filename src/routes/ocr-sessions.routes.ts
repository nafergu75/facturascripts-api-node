/**
 * OCR Sessions Routes
 * Rutas para gestión del historial y detalle de sesiones OCR
 */

import express, { Router } from 'express';
import ocrSessionsController from '../controllers/ocr-sessions.controller';

const router = Router();

// GET /companies/:companyId/ocr/sessions
router.get('/ocr/sessions', ocrSessionsController.getSessions.bind(ocrSessionsController));

// GET /companies/:companyId/ocr/sessions/:sessionId
router.get(
  '/ocr/sessions/:sessionId',
  ocrSessionsController.getSession.bind(ocrSessionsController)
);

// GET /companies/:companyId/ocr/stats
router.get('/ocr/stats', ocrSessionsController.getStats.bind(ocrSessionsController));

// POST /companies/:companyId/ocr/sessions/:sessionId/retry
router.post(
  '/ocr/sessions/:sessionId/retry',
  ocrSessionsController.retrySesion.bind(ocrSessionsController)
);

// POST /companies/:companyId/ocr/sessions/:sessionId/send-to-reader
router.post(
  '/ocr/sessions/:sessionId/send-to-reader',
  ocrSessionsController.sendToReader.bind(ocrSessionsController)
);

export default router;
