import { asyncHandler } from '../utils/async-handler';
import { sendMessage, sendOk } from '../utils/response';
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

  /** GET /logo — la imagen del logo (404 si no hay). */
  obtenerLogo: asyncHandler(async (req, res) => {
    const logo = await legalConfigService.obtenerLogo(req.companyId!);
    if (!logo) {
      res.status(404).json({ message: 'La empresa no tiene logo.' });
      return;
    }
    res.setHeader('Content-Type', logo.mime);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.send(logo.bytes);
  }),

  /** PUT /logo — sube o cambia el logo (campo de formulario "logo"). */
  guardarLogo: asyncHandler(async (req, res) => {
    await legalConfigService.guardarLogo(req.companyId!, req.file?.buffer);
    await registrarAuditoria({
      userId: req.user!.userId,
      companyId: req.companyId,
      action: 'UPDATE_COMPANY_LOGO',
      resourceType: 'LEGAL_CONFIG',
      resourceId: req.companyId!,
    });
    sendMessage(res, 'Logo guardado.');
  }),

  /** DELETE /logo — quita el logo. */
  borrarLogo: asyncHandler(async (req, res) => {
    await legalConfigService.borrarLogo(req.companyId!);
    sendMessage(res, 'Logo eliminado.');
  }),
};
