import { Router } from 'express';
import multer from 'multer';
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
router.get('/imagenes/:tipo', authorize('ventas:read', 'contabilidad:read'), ajustesController.obtenerImagen);
router.put('/imagenes/:tipo', authorize('ventas:write'), subidaImagen.single('imagen'), ajustesController.guardarImagen);
router.delete('/imagenes/:tipo', authorize('ventas:write'), ajustesController.borrarImagen);

export default router;
