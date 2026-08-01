import { Router } from 'express';
import express from 'express';
import { bancosController } from '../controllers/bancos.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router({ mergeParams: true });

router.get('/cuentas', bancosController.listarCuentas);
router.post('/cuentas', authorize('tesoreria:write'), bancosController.crearCuenta);
router.get('/movimientos', bancosController.listarMovs);
// Importacion CSV: acepta text/plain (cuerpo crudo) o JSON { csv }
router.post(
  '/cuentas/:cuentaId/importar-csv',
  authorize('tesoreria:write'),
  express.text({ type: ['text/plain', 'text/csv'], limit: '5mb' }),
  bancosController.importarCsv,
);

// Conciliacion estilo Quipu: movimiento -> factura (cobro contabilizado) o
// movimiento -> cuenta contable (555 partidas pendientes, 526 dividendos...).
router.post('/movimientos/:movId/conciliar-factura', authorize('tesoreria:write'), bancosController.conciliarConFactura);
router.post('/movimientos/:movId/conciliar-cuenta', authorize('tesoreria:write'), bancosController.conciliarConCuenta);

export default router;
