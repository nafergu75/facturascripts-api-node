import { Router } from 'express';
import { adminController } from '../controllers/admin.controller';
import { authorize } from '../middleware/authorize.middleware';

// Administracion de plataforma (superadmin). NO acotado a empresa.
const router = Router();

// Solo admin GLOBAL de plataforma (authorize('admin:global') exige esAdminGlobal).
router.get('/empresas', authorize('admin:global'), adminController.listarEmpresas);
router.post('/empresas', authorize('admin:global'), adminController.crearEmpresa);
router.post('/usuarios', authorize('admin:global'), adminController.crearUsuario);
router.post('/usuarios/:userId/empresas/:companyId', authorize('admin:global'), adminController.asignar);

export default router;
