/**
 * Rutas del EXTRACTOR DE GASTOS con IA.
 * Montadas bajo /companies/:companyId/gastos-extractor (ver routes/index.ts).
 *
 *  POST /extraer-ia     extraer datos de un PDF/imagen de comprobante de gasto
 *  POST /confirmar      confirmar y guardar el gasto (crea asiento contable)
 */

import { Router } from 'express';
import multer from 'multer';
import { gastosExtractorController } from '../controllers/gastos-extractor.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router({ mergeParams: true });

// Multipart en memoria, 15 MB máximo
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

router.post('/extraer-ia', authorize('compras:write'), upload.single('archivo'), gastosExtractorController.extraer);
router.post('/confirmar', authorize('compras:write'), gastosExtractorController.confirmar);

export default router;
