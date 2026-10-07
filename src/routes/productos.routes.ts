import { Router } from 'express';
import multer from 'multer';
import { productosController } from '../controllers/productos.controller';
import { authorize } from '../middleware/authorize.middleware';
import { badRequest } from '../utils/http-errors';

const router = Router({ mergeParams: true });

// Dan de alta productos quienes facturan (ventas:write) o llevan la contabilidad.

const subida = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (/\.(xlsx|xls|csv|txt)$/i.test(file.originalname)) return cb(null, true);
    cb(badRequest('El catálogo tiene que ser un Excel (.xlsx, .xls) o un CSV.'));
  },
});

// Rutas fijas antes de /:id.
router.get('/familias', authorize('ventas:read', 'contabilidad:read'), productosController.listarFamilias);
router.post('/familias', authorize('ventas:write', 'contabilidad:write'), productosController.crearFamilia);
router.patch('/familias/:familiaId', authorize('ventas:write', 'contabilidad:write'), productosController.actualizarFamilia);
router.delete('/familias/:familiaId', authorize('ventas:write', 'contabilidad:write'), productosController.borrarFamilia);
router.get('/siguiente-codigo', authorize('ventas:read', 'contabilidad:read'), productosController.siguienteCodigo);
// Excel o CSV con el catalogo (campo "archivo"); ?vistaPrevia=1 no guarda.
router.post('/importar', authorize('ventas:write', 'contabilidad:write'), subida.single('archivo'), productosController.importar);

router.get('/', authorize('ventas:read', 'contabilidad:read'), productosController.list);
router.get('/:id', authorize('ventas:read', 'contabilidad:read'), productosController.getById);
router.post('/', authorize('ventas:write', 'contabilidad:write'), productosController.create);
router.put('/:id', authorize('ventas:write', 'contabilidad:write'), productosController.update);
router.delete('/:id', authorize('ventas:write', 'contabilidad:write'), productosController.remove);

export default router;
