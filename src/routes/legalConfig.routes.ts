import { Router } from 'express';
import multer from 'multer';
import { legalConfigController } from '../controllers/legalConfig.controller';
import { authorize } from '../middleware/authorize.middleware';

// Montado bajo /companies/:companyId/legal-config (scoped: companyScope ya validó acceso).
const router = Router({ mergeParams: true });

router.get('/', legalConfigController.obtener);
router.put('/', authorize('contabilidad:write'), legalConfigController.actualizar);

// Logo de la empresa para las facturas (en memoria; el servicio comprueba tipo y tamano).
const subidaLogo = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });
router.get('/logo', legalConfigController.obtenerLogo);
router.put('/logo', authorize('contabilidad:write', 'ventas:write'), subidaLogo.single('logo'), legalConfigController.guardarLogo);
router.delete('/logo', authorize('contabilidad:write', 'ventas:write'), legalConfigController.borrarLogo);

export default router;
