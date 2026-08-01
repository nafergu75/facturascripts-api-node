import { Router, raw, json } from 'express';
import multer from 'multer';
import { incomeReaderController } from '../controllers/income-reader.controller';
import { authorize } from '../middleware/authorize.middleware';
import { authMiddleware } from '../middleware/auth.middleware';
import { incomeReaderService } from '../services/income-reader.service';
import { HttpError } from '../utils/http-errors';

const router = Router({ mergeParams: true });

// Subida multipart (drag&drop web / foto movil): campo 'archivo', en memoria, 15 MB max.
// PENDIENTE BLOQUEADO no estaba aqui: faltaba este middleware por completo, por lo que
// req.file nunca llegaba a poblarse y extraerArchivo() fallaba siempre con
// "No archivo recibido" aunque el comentario decia "Soporta multipart (multer)".
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

/**
 * Subir documento desde app móvil (foto).
 * POST /api/income-reader/mobile-upload
 * Soporta: multipart/form-data (multer) o binario crudo o JSON con base64
 */
router.post(
  '/mobile-upload',
  authorize('ventas:write'),
  upload.single('archivo'),
  incomeReaderController.subirDesdeMovil,
);

/**
 * Subir documento desde web (drag & drop).
 * POST /api/income-reader/web-upload
 */
router.post(
  '/web-upload',
  authorize('ventas:write'),
  upload.single('archivo'),
  incomeReaderController.subirDesdeWeb,
);

/**
 * Webhook para recibir facturas por email.
 * POST /api/income-reader/email-hook
 * (Generalmente sin auth, o con auth de sistema)
 */
router.post('/email-hook', raw({ type: ['application/json', 'text/plain'], limit: '10mb' }), incomeReaderController.procesarDesdeEmail);

/**
 * Listar documentos pendientes de verificar.
 * GET /api/income-reader/pending
 */
router.get('/pending', incomeReaderController.listarPendientes);

/**
 * Obtener configuración de email del lector.
 * GET /api/income-reader/config
 */
router.get('/config', incomeReaderController.obtenerConfig);

/**
 * Crear/actualizar configuración de email del lector.
 * POST /api/income-reader/config
 */
router.post('/config', authorize('admin'), incomeReaderController.actualizarConfig);

/**
 * Obtener detalle de un documento.
 * GET /api/income-reader/:id
 */
router.get('/:id', incomeReaderController.obtenerDetalle);

/**
 * Actualizar datos extraídos de un documento (correcciones manuales).
 * PUT /api/income-reader/:id
 */
router.put('/:id', authorize('ventas:write'), incomeReaderController.actualizar);

/**
 * Verificar documento y crear factura de ingreso.
 * POST /api/income-reader/:id/verify
 */
router.post('/:id/verify', authorize('ventas:write'), incomeReaderController.verificar);

/**
 * Rechazar un documento.
 * POST /api/income-reader/:id/reject
 */
router.post('/:id/reject', authorize('ventas:write'), incomeReaderController.rechazar);

/**
 * Reintentar OCR de un documento en estado ERROR.
 * POST /api/companies/:companyId/income-reader/:id/reintent-ocr
 * Solo permitido si status = 'ERROR'
 */
router.post('/:id/reintent-ocr', authMiddleware, async (req, res) => {
  try {
    const companyId = req.companyId as string;
    const { id } = req.params;
    const documento = await incomeReaderService.reintentarOCR(companyId, id);
    res.json({ ok: true, data: documento });
  } catch (err) {
    const statusCode = err instanceof HttpError ? err.statusCode : 400;
    const message = err instanceof Error ? err.message : String(err);
    res.status(statusCode).json({ error: message });
  }
});

export default router;
