import { Router } from 'express';
import { authorize } from '../middleware/authorize.middleware';
import { tiposCambioController } from '../controllers/tiposCambio.controller';

const router = Router({ mergeParams: true });

/**
 * Tipo de cambio de referencia del BCE para facturar o cobrar en otra moneda.
 * GET /companies/:companyId/tipos-cambio?moneda=USD&fecha=AAAA-MM-DD
 */
router.get('/', authorize('ventas:read', 'contabilidad:read', 'tesoreria:read'), tiposCambioController.obtener);

export default router;
