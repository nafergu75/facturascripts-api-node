import { Router } from 'express';
import ocrAnalyticsController from '../controllers/ocr-analytics.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router({ mergeParams: true });

/**
 * GET /companies/:companyId/ocr/analytics/kpis
 * Retorna KPIs: PDFs hoy, tiempo promedio, tasa de error
 * Query params: ?days=30
 */
router.get('/analytics/kpis', authorize('compras:read', 'ventas:read', 'contabilidad:read'), ocrAnalyticsController.getKPIs.bind(ocrAnalyticsController));

/**
 * GET /companies/:companyId/ocr/analytics/timeline
 * Retorna timeline de PDFs por día
 * Query params: ?from=2026-06-01&to=2026-07-17 o ?days=30
 */
router.get(
  '/analytics/timeline',
  authorize('compras:read', 'ventas:read', 'contabilidad:read'),
  ocrAnalyticsController.getTimeline.bind(ocrAnalyticsController)
);

/**
 * GET /companies/:companyId/ocr/analytics/distribution
 * Retorna distribución de PDFs por tipo (expense/income) y tasa de éxito
 * Query params: ?from=2026-06-01&to=2026-07-17 o ?days=30
 */
router.get(
  '/analytics/distribution',
  authorize('compras:read', 'ventas:read', 'contabilidad:read'),
  ocrAnalyticsController.getDistribution.bind(ocrAnalyticsController)
);

/**
 * GET /ocr/analytics/global (SUPERADMIN ONLY)
 * Retorna estadísticas agregadas de todas las empresas
 * Query params: ?from=2026-06-01&to=2026-07-17 o ?days=30
 */
router.get('/analytics/global', authorize('compras:read', 'ventas:read', 'contabilidad:read'), ocrAnalyticsController.getGlobalStats.bind(ocrAnalyticsController));

export default router;
