import { asyncHandler } from '../utils/async-handler';
import { contabilidadService } from '../services/contabilidad.service';
import { crearAsientoEnFacturascriptsDesdeFactura } from '../services/asientos.service';
import { sendMessage, sendOk } from '../utils/response';
import { registrarAuditoria } from '../services/auditoria.service';

export const contabilidadController = {
  list: asyncHandler(async (req, res) => {
    const data = await contabilidadService.list(req.companyId!, req.query as Record<string, unknown>);
    sendOk(res, data);
  }),
  getById: asyncHandler(async (req, res) => {
    const data = await contabilidadService.getById(req.companyId!, req.params.id);
    sendOk(res, data);
  }),
  create: asyncHandler(async (req, res) => {
    const data = await contabilidadService.create(req.companyId!, req.body);
    sendOk(res, data, undefined, 201);
  }),
  update: asyncHandler(async (req, res) => {
    const data = await contabilidadService.update(req.companyId!, req.params.id, req.body);
    sendOk(res, data);
  }),
  remove: asyncHandler(async (req, res) => {
    await contabilidadService.remove(req.companyId!, req.params.id);
    sendMessage(res, 'Asiento eliminado');
  }),

  /**
   * POST /companies/:companyId/facturas/:facturaId/contabilizar
   * Convierte una factura en su asiento contable (factura -> asiento) usando
   * FacturaScripts como backend. Body opcional: { tipo: 'venta' | 'compra' }.
   */
  contabilizarFactura: asyncHandler(async (req, res) => {
    const tipo = req.body?.tipo === 'compra' ? 'compra' : 'venta';
    const asiento = await crearAsientoEnFacturascriptsDesdeFactura(
      req.companyId!,
      req.params.facturaId,
      tipo,
    );
    await registrarAuditoria({
      userId: req.user!.userId,
      companyId: req.companyId,
      action: 'CONTABILIZAR_FACTURA',
      resourceType: 'ASIENTO',
      resourceId: req.params.facturaId,
      meta: { tipo },
    });
    sendOk(res, asiento, undefined, 201);
  }),
};
