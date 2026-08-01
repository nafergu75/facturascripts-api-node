import { Router } from 'express';
import { chartOfAccountsController } from '../controllers/chart-of-accounts.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router({ mergeParams: true });

/**
 * Inicializar plan contable para una empresa.
 * POST /api/accounting/chart-of-accounts/init
 */
router.post('/init', authorize('admin'), chartOfAccountsController.inicializar);

/**
 * Listar plan contable con filtros.
 * GET /api/accounting/chart-of-accounts?grupo=7&naturaleza=INGRESO
 */
router.get('/', chartOfAccountsController.listar);

/**
 * Obtener estructura jerárquica completa (árbol).
 * GET /api/accounting/chart-of-accounts/arbol?grupo=7
 */
router.get('/arbol', chartOfAccountsController.obtenerArbol);

/**
 * Obtener una cuenta por código.
 * GET /api/accounting/chart-of-accounts/700
 */
router.get('/:codigo', chartOfAccountsController.obtenerPorCodigo);

/**
 * Crear subcuenta personalizada.
 * POST /api/accounting/chart-of-accounts
 */
router.post('/', authorize('contable'), chartOfAccountsController.crearSubcuenta);

/**
 * Actualizar cuenta.
 * PATCH /api/accounting/chart-of-accounts/:id
 */
router.patch('/:id', authorize('contable'), chartOfAccountsController.actualizar);

export default router;
