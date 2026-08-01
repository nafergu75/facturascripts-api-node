/**
 * Facturas LEGACY (spine FacturaScripts; crea/lee facturaclientes en FS). El
 * flujo de ingreso canónico es /invoices (income-invoices, Prisma) + /accounting
 * para contabilizar, usados por el frontend Chakra. Algunas funciones FS
 * (Veri*Factu, cobros) aún no tienen equivalente Prisma. Ver ADR-002.
 */
import { Router } from 'express';
import { facturasController } from '../controllers/facturas.controller';
import { contabilidadController } from '../controllers/contabilidad.controller';
import { bloquearPeriodoCerrado } from '../middleware/periodo.middleware';
import { verifactuController } from '../controllers/verifactu.controller';
import { authorize } from '../middleware/authorize.middleware';
import { deprecacion } from '../middleware/deprecation.middleware';

const router = Router({ mergeParams: true });
router.use(deprecacion('/companies/:companyId/invoices'));

// Crear factura de INGRESO completa (cliente+serie+lineas+totales). Antes de '/:id'.
router.post('/ingreso', authorize('ventas:write'), bloquearPeriodoCerrado, facturasController.crearIngreso);

router.get('/', facturasController.list);
// Vencimientos de TODA la empresa (panel a cobrar/a pagar del dashboard).
// Antes de '/:id' para que 'vencimientos' no se interprete como id de factura.
router.get('/vencimientos', facturasController.listarVencimientosEmpresa);
router.get('/:id', facturasController.getById);

// Estados finales del flujo de ingreso
router.patch('/:id/estado', authorize('ventas:write'), facturasController.cambiarEstado);
router.post('/:id/rectificativa', authorize('ventas:write'), facturasController.rectificativa);
router.post('/:id/send-email', authorize('ventas:write'), facturasController.enviarEmail);
router.post('/:id/recurrente', authorize('ventas:write'), facturasController.hacerRecurrente);
router.post('/', bloquearPeriodoCerrado, facturasController.create);
router.put('/:id', facturasController.update);
router.delete('/:id', facturasController.remove);

// Factura -> asiento contable (contabilidad inteligente)
router.post('/:facturaId/contabilizar', contabilidadController.contabilizarFactura);

// Estado de cobro: registrar un cobro imputado a la factura (Feature 3)
router.post('/:id/cobros', facturasController.registrarCobro);

// Vencimientos y su liquidacion contable (Hallazgo 2)
router.get('/:id/vencimientos', facturasController.listarVencimientos);
router.post('/vencimientos/:vencimientoId/liquidar', facturasController.liquidarVencimiento);

// Veri*Factu: huellas de inalterabilidad de la factura
router.get('/:id/huellas', verifactuController.listar);
router.post('/:id/huellas', verifactuController.registrar);

export default router;
