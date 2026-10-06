/**
 * Lector de facturas de INGRESO. Montado en /companies/:companyId/ingresos-extractor.
 *
 *  POST /extraer-ia   lee una factura emitida (PDF/imagen) y la deja pendiente
 *  POST /confirmar    { documentId }: la registra como factura de ingreso
 */
import { Router } from 'express';
import multer from 'multer';
import { ingresosExtractorController } from '../controllers/ingresos-extractor.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router({ mergeParams: true });

// Multipart en memoria, 15 MB maximo (el JSON base64 lo cubre express.json, 20 MB).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

router.post('/extraer-ia', authorize('ventas:write'), upload.single('archivo'), ingresosExtractorController.extraer);
router.post('/confirmar', authorize('ventas:write'), ingresosExtractorController.confirmar);

export default router;
