import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { registrarAuditoria } from '../services/auditoria.service';
import { guardarAjustesFacturacion, obtenerAjustesFacturacion } from '../services/ajustesFacturacion.service';

/** Configuración: valores por defecto de facturación y ajustes fiscales. */
export const ajustesController = {
  leerFacturacion: asyncHandler(async (req, res) => {
    sendOk(res, await obtenerAjustesFacturacion(req.companyId!));
  }),

  guardarFacturacion: asyncHandler(async (req, res) => {
    const ajustes = await guardarAjustesFacturacion(req.companyId!, req.user!.userId, req.body);
    await registrarAuditoria({
      userId: req.user!.userId,
      companyId: req.companyId,
      action: 'UPDATE_AJUSTES_FACTURACION',
      resourceType: 'AJUSTES_FACTURACION',
      resourceId: req.companyId,
      meta: { campos: Object.keys(req.body ?? {}) },
    });
    sendOk(res, ajustes);
  }),
};
