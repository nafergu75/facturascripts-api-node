/**
 * Rutas del EXTRACTOR CONTABLE DE FACTURAS con IA.
 * Montadas bajo /companies/:companyId/invoice-extractor (ver routes/index.ts).
 *
 *  POST /extract      extraer datos de un PDF/imagen (multipart 'archivo' o JSON base64)
 *  GET  /:id          detalle de una extracción
 *  PUT  /:id          corregir la extracción (revisión manual)
 *  POST /:id/confirm  guardar el PDF en /{año}/{Qx}/{ventas|gastos}/ y crear el asiento
 */
import { Router } from 'express';
import multer from 'multer';
import { invoiceExtractorController } from '../controllers/invoice-extractor.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router({ mergeParams: true });

// Multipart en memoria, 15 MB máximo (mismo límite que el income-reader).
// El formato JSON base64 lo cubre el express.json global (límite 20mb en app.ts).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

router.post('/extract', authorize('ventas:write'), upload.single('archivo'), invoiceExtractorController.extraer);
router.get('/:id', invoiceExtractorController.detalle);
router.put('/:id', authorize('ventas:write'), invoiceExtractorController.corregir);
router.post('/:id/confirm', authorize('ventas:write'), invoiceExtractorController.confirmar);

export default router;
