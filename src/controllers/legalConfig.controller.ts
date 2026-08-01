import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { legalConfigService } from '../services/legalConfig.service';
import { registrarAuditoria } from '../services/auditoria.service';

/** Rutas montadas bajo /companies/:companyId/legal-config (companyScope puebla req.companyId). */
export const legalConfigController = {
  obtener: asyncHandler(async (req, res) => {
    sendOk(res, await legalConfigService.obtener(req.companyId!));
  }),

  actualizar: asyncHandler(async (req, res) => {
    const cfg = await legalConfigService.actualizar(req.companyId!, req.body ?? {});
    await registrarAuditoria({
      userId: req.user!.userId,
      companyId: req.companyId,
      action: 'UPDATE_LEGAL_CONFIG',
      resourceType: 'LEGAL_CONFIG',
      resourceId: cfg.id,
    });
    sendOk(res, cfg);
  }),
};
