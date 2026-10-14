import { Router } from 'express';
import { z } from 'zod';
import { adminController } from '../controllers/admin.controller';
import { verifactuController } from '../controllers/verifactu.controller';
import { authorize } from '../middleware/authorize.middleware';
import { validate } from '../middleware/validation.middleware';

// Administracion de plataforma (modo administrador global). NO acotado a empresa.
//
// Cada ruta lleva authorize('admin:global') EN LINEA (lo comprueba
// tests/permisos-rutas.test.ts): solo pasa quien es administrador global; el
// rol 'admin' de una empresa NO basta. No hace falta mirar la BD aqui:
// authMiddleware ya ha puesto en req.user el modo administrador ACTUAL (no el
// del token), asi que quitarlo o desactivar a alguien le cierra el panel al momento.
const router = Router();

// Cuerpo de dar/cambiar un acceso: rol (o role/roles[0], como siempre) y areas.
// Estricto: cualquier otra clave (por ejemplo `permisos` con codigos sueltos)
// es un 400. Las areas se validan en admin.service (esquemaAreas).
const accesoSchema = z
  .object({ rol: z.unknown().optional(), role: z.unknown().optional(), roles: z.unknown().optional(), areas: z.unknown().optional() })
  .strict();

// --- Empresas ---
router.get('/empresas', authorize('admin:global'), adminController.listarEmpresas);
router.post('/empresas', authorize('admin:global'), adminController.crearEmpresa);
router.patch('/empresas/:id', authorize('admin:global'), adminController.actualizarEmpresa);
// VERI*FACTU: empresa de pruebas (mismo NIF, solo el entorno de pruebas de la AEAT) de una empresa real.
router.post('/empresas/:id/pruebas-verifactu', authorize('admin:global'), adminController.crearEmpresaPruebasVerifactu);

// --- Usuarios ---
router.get('/usuarios', authorize('admin:global'), adminController.listarUsuarios);
router.post('/usuarios', authorize('admin:global'), adminController.crearUsuario);
router.patch('/usuarios/:userId', authorize('admin:global'), adminController.actualizarUsuario);

// --- Permisos a medida: catalogo de la matriz (areas, niveles y perfiles) ---
router.get('/permisos/catalogo', authorize('admin:global'), adminController.catalogoPermisos);

// --- VERI*FACTU: red de seguridad (bloqueo de emision sin VERI*FACTU desde el 1-1-2027) ---
router.get('/verifactu/red-seguridad', authorize('admin:global'), verifactuController.leerInterruptor);
router.put('/verifactu/red-seguridad', authorize('admin:global'), verifactuController.cambiarInterruptor);

// --- Accesos de un usuario a una empresa ---
router.put('/usuarios/:userId/empresas/:companyId', authorize('admin:global'), validate(accesoSchema), adminController.asignarRol);
router.delete('/usuarios/:userId/empresas/:companyId', authorize('admin:global'), adminController.quitarAcceso);
// Compatibilidad: la version anterior asignaba con POST (body { role }).
router.post('/usuarios/:userId/empresas/:companyId', authorize('admin:global'), validate(accesoSchema), adminController.asignarRol);

export default router;
