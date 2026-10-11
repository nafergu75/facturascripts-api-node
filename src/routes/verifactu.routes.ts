import { Router } from 'express';
import { verifactuController } from '../controllers/verifactu.controller';
import { authorize } from '../middleware/authorize.middleware';

// Montado bajo /companies/:companyId/verifactu (scoped). Lo lee quien ve las
// ventas: el formulario de factura y la lista de Ventas lo usan para avisar y
// para deshabilitar el boton de emitir.
const router = Router({ mergeParams: true });

router.get('/red-seguridad', authorize('ventas:read'), verifactuController.estadoRedEmpresa);

// Exclusion SII o FORAL (spec 9.2): solo un administrador de la empresa, con
// rastro en AuditLog. Marcar el SII en los ajustes fiscales no basta para abrir la red.
router.get('/exclusion', authorize('admin:empresa'), verifactuController.leerExclusion);
router.put('/exclusion', authorize('admin:empresa'), verifactuController.fijarExclusion);

export default router;
