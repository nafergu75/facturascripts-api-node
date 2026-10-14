import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { badRequest } from '../utils/http-errors';
import { ajustesController } from '../controllers/ajustes.controller';
import { authorize } from '../middleware/authorize.middleware';
import { IMAGEN_FACTURA_MAX } from '../services/imagenesFactura.service';

// Montado bajo /companies/:companyId/ajustes-facturacion (scoped).
// Los ve quien factura o lleva la contabilidad; los cambia quien factura
// (ventas:write) y el administrador, que tiene todos los permisos.
const router = Router({ mergeParams: true });

router.get('/', authorize('ventas:read', 'contabilidad:read'), ajustesController.leerFacturacion);
router.put('/', authorize('ventas:write'), ajustesController.guardarFacturacion);

// Plantilla B: logo de la marca y sello de la empresa (en memoria; el servicio comprueba tipo y tamano).
const subidaImagen = multer({ storage: multer.memoryStorage(), limits: { fileSize: IMAGEN_FACTURA_MAX } });
/** Una imagen de mas de 1 MB da un 400 en su campo (multer la corta antes del servicio y daria un 500). */
const subirImagen: RequestHandler = (req, res, next) =>
  subidaImagen.single('imagen')(req, res, (err?: unknown) =>
    next(err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE' ? badRequest('La imagen no puede pasar de 1 MB.', { campo: 'imagen' }) : err),
  );
router.get('/imagenes/:tipo', authorize('ventas:read', 'contabilidad:read'), ajustesController.obtenerImagen);
router.put('/imagenes/:tipo', authorize('ventas:write'), subirImagen, ajustesController.guardarImagen);
router.delete('/imagenes/:tipo', authorize('ventas:write'), ajustesController.borrarImagen);

export default router;
