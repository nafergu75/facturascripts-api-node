import { Router } from 'express';
import { adminController } from '../controllers/admin.controller';
import { authorize } from '../middleware/authorize.middleware';
import { adminGlobalVigente } from '../middleware/adminGlobalVigente.middleware';

// Administracion de plataforma (modo administrador global). NO acotado a empresa.
//
// Cada ruta lleva authorize('admin:global') EN LINEA (lo comprueba
// tests/permisos-rutas.test.ts): solo pasa quien tiene esAdminGlobal en el
// token; el rol 'admin' de una empresa NO basta. Despues, adminGlobalVigente
// confirma en la BD que lo sigue siendo (el token dura 24 h).
const router = Router();

// --- Empresas ---
router.get('/empresas', authorize('admin:global'), adminGlobalVigente, adminController.listarEmpresas);
router.post('/empresas', authorize('admin:global'), adminGlobalVigente, adminController.crearEmpresa);
router.patch('/empresas/:id', authorize('admin:global'), adminGlobalVigente, adminController.actualizarEmpresa);

// --- Usuarios ---
router.get('/usuarios', authorize('admin:global'), adminGlobalVigente, adminController.listarUsuarios);
router.post('/usuarios', authorize('admin:global'), adminGlobalVigente, adminController.crearUsuario);
router.patch('/usuarios/:userId', authorize('admin:global'), adminGlobalVigente, adminController.actualizarUsuario);

// --- Accesos de un usuario a una empresa ---
router.put('/usuarios/:userId/empresas/:companyId', authorize('admin:global'), adminGlobalVigente, adminController.asignarRol);
router.delete('/usuarios/:userId/empresas/:companyId', authorize('admin:global'), adminGlobalVigente, adminController.quitarAcceso);
// Compatibilidad: la version anterior asignaba con POST (body { role }).
router.post('/usuarios/:userId/empresas/:companyId', authorize('admin:global'), adminGlobalVigente, adminController.asignarRol);

export default router;
