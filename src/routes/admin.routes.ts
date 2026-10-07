import { Router } from 'express';
import { adminController } from '../controllers/admin.controller';
import { authorize } from '../middleware/authorize.middleware';

// Administracion de plataforma (modo administrador global). NO acotado a empresa.
//
// Cada ruta lleva authorize('admin:global') EN LINEA (lo comprueba
// tests/permisos-rutas.test.ts): solo pasa quien es administrador global; el
// rol 'admin' de una empresa NO basta. No hace falta mirar la BD aqui:
// authMiddleware ya ha puesto en req.user el modo administrador ACTUAL (no el
// del token), asi que quitarlo o desactivar a alguien le cierra el panel al momento.
const router = Router();

// --- Empresas ---
router.get('/empresas', authorize('admin:global'), adminController.listarEmpresas);
router.post('/empresas', authorize('admin:global'), adminController.crearEmpresa);
router.patch('/empresas/:id', authorize('admin:global'), adminController.actualizarEmpresa);

// --- Usuarios ---
router.get('/usuarios', authorize('admin:global'), adminController.listarUsuarios);
router.post('/usuarios', authorize('admin:global'), adminController.crearUsuario);
router.patch('/usuarios/:userId', authorize('admin:global'), adminController.actualizarUsuario);

// --- Accesos de un usuario a una empresa ---
router.put('/usuarios/:userId/empresas/:companyId', authorize('admin:global'), adminController.asignarRol);
router.delete('/usuarios/:userId/empresas/:companyId', authorize('admin:global'), adminController.quitarAcceso);
// Compatibilidad: la version anterior asignaba con POST (body { role }).
router.post('/usuarios/:userId/empresas/:companyId', authorize('admin:global'), adminController.asignarRol);

export default router;
