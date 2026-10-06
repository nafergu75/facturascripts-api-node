import { Router } from 'express';
import { treasuryController } from '../controllers/treasury.controller';
import { tesoreriaCategoriasController } from '../controllers/tesoreriaCategorias.controller';
import multer from 'multer';
import { authorize } from '../middleware/authorize.middleware';
import { badRequest } from '../utils/http-errors';

const subidaExtracto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (/\.(xlsx|xls|csv|txt)$/i.test(file.originalname)) return cb(null, true);
    cb(badRequest('El extracto tiene que ser un Excel (.xlsx, .xls) o un CSV.'));
  },
});

// Rutas de la pantalla de tesoreria del frontend. Se montan bajo
// /companies/:companyId/treasury, despues de companyScope.
const router = Router({ mergeParams: true });

router.get('/summary', authorize('tesoreria:read'), treasuryController.resumen);
router.get('/bank-accounts', authorize('tesoreria:read'), treasuryController.listarCuentas);
router.post('/bank-accounts', authorize('tesoreria:write'), treasuryController.crearCuenta);
router.get('/bank-accounts/:accountId/movements', authorize('tesoreria:read'), treasuryController.listarMovimientos);
router.post('/bank-accounts/:accountId/statements', authorize('tesoreria:write'), treasuryController.subirExtracto);
// Extracto en Excel (.xlsx/.xls) o CSV, como fichero (campo "archivo").
// ?vistaPrevia=1 lo lee y dice cuantos movimientos son nuevos, sin guardar.
router.post(
  '/bank-accounts/:accountId/statements/archivo',
  authorize('tesoreria:write'),
  subidaExtracto.single('archivo'),
  treasuryController.subirExtractoArchivo,
);
router.post('/movements/:movementId/reconcile', authorize('tesoreria:write'), treasuryController.conciliar);

// --- Tesoreria analitica: categorias y categorizacion de movimientos ---
const c = tesoreriaCategoriasController;
router.get('/categorias', authorize('tesoreria:read'), c.listarCategorias);
router.post('/categorias', authorize('tesoreria:write'), c.crearCategoria);
router.patch('/categorias/:categoriaId', authorize('tesoreria:write'), c.actualizarCategoria);
router.delete('/categorias/:categoriaId', authorize('tesoreria:write'), c.borrarCategoria);
router.get('/movimientos', authorize('tesoreria:read'), c.listarMovimientos);
router.put('/movimientos/:movementId/categoria', authorize('tesoreria:write'), c.categorizar);
router.post('/movimientos/:movementId/similares', authorize('tesoreria:write'), c.aplicarASimilares);
router.put('/movimientos/:movementId/ignorado', authorize('tesoreria:write'), c.ignorar);
router.put('/movimientos/:movementId/desglose', authorize('tesoreria:write'), c.desglosar);
router.delete('/movimientos/:movementId/desglose', authorize('tesoreria:write'), c.deshacerDesglose);

export default router;
