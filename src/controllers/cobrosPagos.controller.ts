import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { registrarAuditoria } from '../services/auditoria.service';
import {
  anularCobroFactura,
  listarCobros,
  registrarCobroFactura,
  type TipoDocumento,
} from '../services/cobrosPagos.service';

/**
 * Cobros de facturas de venta (/income-invoices/:id/cobros) y pagos de facturas
 * de gasto (/expense-invoices/:id/pagos). Misma logica, distinto lado.
 */
function controlador(tipo: TipoDocumento) {
  const recurso = tipo === 'INGRESO' ? 'INCOME_INVOICE' : 'EXPENSE_INVOICE';
  const accion = tipo === 'INGRESO' ? 'COBRO' : 'PAGO';
  return {
    listar: asyncHandler(async (req, res) => {
      sendOk(res, await listarCobros(req.companyId!, tipo, req.params.id));
    }),

    registrar: asyncHandler(async (req, res) => {
      const b = req.body ?? {};
      const r = await registrarCobroFactura(req.companyId!, tipo, req.params.id, {
        fecha: b.fecha,
        importe: b.importe === undefined || b.importe === '' || b.importe === null ? undefined : Number(b.importe),
        cuentaBancariaId: b.cuentaBancariaId || undefined,
        caja: b.caja === true || b.caja === 'true',
        nota: b.nota,
        userId: req.user?.userId,
      });
      await registrarAuditoria({
        userId: req.user?.userId || 'unknown',
        companyId: req.companyId,
        action: `REGISTRAR_${accion}_FACTURA`,
        resourceType: recurso,
        resourceId: req.params.id,
        meta: { cobroId: r.cobro.id, importe: r.cobro.importe, fecha: r.cobro.fecha, asiento: r.cobro.asientoNumero },
      });
      sendOk(res, r, undefined, 201);
    }),

    anular: asyncHandler(async (req, res) => {
      const r = await anularCobroFactura(req.companyId!, tipo, req.params.id, req.params.cobroId, { fecha: req.body?.fecha });
      await registrarAuditoria({
        userId: req.user?.userId || 'unknown',
        companyId: req.companyId,
        action: `ANULAR_${accion}_FACTURA`,
        resourceType: recurso,
        resourceId: req.params.id,
        meta: { cobroId: req.params.cobroId, contraasiento: r.contraasiento },
      });
      sendOk(res, r);
    }),
  };
}

export const cobrosController = controlador('INGRESO');
export const pagosController = controlador('GASTO');
