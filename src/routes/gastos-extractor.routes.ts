/**
 * Rutas del EXTRACTOR DE GASTOS con IA.
 * Montadas bajo /companies/:companyId/gastos-extractor (ver routes/index.ts).
 *
 *  POST /extraer-ia     extraer datos de un PDF/imagen de comprobante de gasto (4 MB como mucho)
 *  POST /confirmar      registrar la factura revisada (factura y asiento en borrador)
 *  POST /lecturas, GET /lecturas/:id, POST /lecturas/:id/descartar   lectura con Azure (ver lecturas.controller.ts)
 */

import { RequestHandler, Router } from 'express';
import multer from 'multer';
import { gastosExtractorController, MAX_ARCHIVO_LECTOR, MENSAJE_ARCHIVO_GRANDE } from '../controllers/gastos-extractor.controller';
import { authorize } from '../middleware/authorize.middleware';
import { badRequest } from '../utils/http-errors';
import { lecturasGastos, subirArchivoLectura } from '../controllers/lecturas.controller';

const router = Router({ mergeParams: true });

// Multipart en memoria, 4 MB como maximo (el cuerpo de una funcion de Vercel no pasa de 4,5 MB).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ARCHIVO_LECTOR } });

/** El archivo demasiado grande da un 400 en castellano (no un 500). */
const subirArchivo: RequestHandler = (req, res, next) =>
  upload.single('archivo')(req, res, (err?: unknown) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') return next(badRequest(MENSAJE_ARCHIVO_GRANDE));
    if (err) return next(badRequest('No se pudo leer el archivo subido.'));
    next();
  });

router.post('/extraer-ia', authorize('compras:write'), subirArchivo, gastosExtractorController.extraer);
router.post('/confirmar', authorize('compras:write'), gastosExtractorController.confirmar);
router.post('/lecturas', authorize('compras:write'), subirArchivoLectura, lecturasGastos.crear);
router.get('/lecturas/:id', authorize('compras:read', 'compras:write'), lecturasGastos.consultar);
router.post('/lecturas/:id/descartar', authorize('compras:write'), lecturasGastos.descartar);

export default router;
