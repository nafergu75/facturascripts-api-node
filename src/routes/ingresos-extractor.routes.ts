/**
 * Lector de facturas de INGRESO. Montado en /companies/:companyId/ingresos-extractor.
 *
 *  POST /extraer-ia   lee una factura emitida (PDF/imagen) y la deja pendiente
 *  POST /confirmar    { documentId, revisado?, lineas?: [{ cuenta }] }: la registra como factura de ingreso (con la cuenta elegida en cada linea)
 *  POST /lecturas, GET /lecturas/:id, POST /lecturas/:id/descartar   lectura con Azure, 4 MB como mucho (ver lecturas.controller.ts)
 */
import { Router } from 'express';
import multer from 'multer';
import { ingresosExtractorController } from '../controllers/ingresos-extractor.controller';
import { authorize } from '../middleware/authorize.middleware';
import { lecturasVentas, subirArchivoLectura } from '../controllers/lecturas.controller';

const router = Router({ mergeParams: true });

// Multipart en memoria, 15 MB maximo (el JSON base64 lo cubre express.json, 20 MB).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

router.post('/extraer-ia', authorize('ventas:write'), upload.single('archivo'), ingresosExtractorController.extraer);
// Sin el aviso del plan anterior: el lector ya no da de alta al tercero (sin ficha, 400
// TERCERO_NO_DADO_DE_ALTA). El aviso sale al darlo de alta desde su pantalla (POST /clientes o /proveedores).
router.post('/confirmar', authorize('ventas:write'), ingresosExtractorController.confirmar);
router.post('/lecturas', authorize('ventas:write'), subirArchivoLectura, lecturasVentas.crear);
router.get('/lecturas/:id', authorize('ventas:read', 'ventas:write'), lecturasVentas.consultar);
router.post('/lecturas/:id/descartar', authorize('ventas:write'), lecturasVentas.descartar);

export default router;
