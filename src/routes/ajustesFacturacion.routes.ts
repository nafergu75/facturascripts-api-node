import { Router } from 'express';
import { ajustesController } from '../controllers/ajustes.controller';
import { authorize } from '../middleware/authorize.middleware';

// Montado bajo /companies/:companyId/ajustes-facturacion (scoped).
// Los ve quien factura o lleva la contabilidad; los cambia quien factura
// (ventas:write) y el administrador, que tiene todos los permisos.
const router = Router({ mergeParams: true });

router.get('/', authorize('ventas:read', 'contabilidad:read'), ajustesController.leerFacturacion);
router.put('/', authorize('ventas:write'), ajustesController.guardarFacturacion);

export default router;
