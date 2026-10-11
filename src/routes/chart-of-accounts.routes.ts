import { Router } from 'express';
import { chartOfAccountsController } from '../controllers/chart-of-accounts.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router({ mergeParams: true });

/**
 * Inicializar plan contable para una empresa.
 * POST /api/accounting/chart-of-accounts/init
 */
router.post('/init', authorize('admin:empresa'), chartOfAccountsController.inicializar);

/**
 * Listar plan contable con filtros.
 * GET /api/accounting/chart-of-accounts?grupo=7&naturaleza=INGRESO
 */
// El plan lleva el nombre fiscal de clientes y proveedores en sus subcuentas: solo con contabilidad:read.
router.get('/', authorize('contabilidad:read'), chartOfAccountsController.listar);

/**
 * Obtener estructura jerárquica completa (árbol).
 * GET /api/accounting/chart-of-accounts/arbol?grupo=7
 */
router.get('/arbol', authorize('contabilidad:read'), chartOfAccountsController.obtenerArbol);

/**
 * Obtener una cuenta por código.
 * GET /api/accounting/chart-of-accounts/700
 */
router.get('/:codigo', authorize('contabilidad:read'), chartOfAccountsController.obtenerPorCodigo);

/**
 * Crear subcuenta personalizada.
 * POST /api/accounting/chart-of-accounts
 */
router.post('/', authorize('contabilidad:write'), chartOfAccountsController.crearSubcuenta);

/**
 * Actualizar cuenta.
 * PATCH /api/accounting/chart-of-accounts/:id
 */
router.patch('/:id', authorize('contabilidad:write'), chartOfAccountsController.actualizar);

export default router;
