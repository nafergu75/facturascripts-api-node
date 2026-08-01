import { asyncHandler } from '../utils/async-handler';
import { authService } from '../services/auth.service';
import { sendOk } from '../utils/response';
import { registrarAuditoria } from '../services/auditoria.service';

export const authController = {
  health: asyncHandler(async (_req, res) => {
    res.status(200).json({ ok: true, service: 'auth', status: 'up' });
  }),

  login: asyncHandler(async (req, res) => {
    const tokens = await authService.login(req.body);
    // Auditoria de acceso (Seccion 6): LOGIN.
    await registrarAuditoria({
      userId: tokens.user.id,
      companyId: tokens.empresaSeleccionada,
      action: 'LOGIN',
      resourceType: 'AUTH',
      resourceId: tokens.user.id,
      meta: { email: tokens.user.email, esAdminGlobal: tokens.user.esAdminGlobal, empresaSeleccionada: tokens.empresaSeleccionada },
    });
    sendOk(res, tokens);
  }),

  refresh: asyncHandler(async (req, res) => {
    const tokens = await authService.refresh(req.body?.refreshToken);
    sendOk(res, tokens);
  }),

  logout: asyncHandler(async (req, res) => {
    await authService.logout(req.body?.refreshToken);
    sendOk(res, { ok: true });
  }),

  devLogin: asyncHandler(async (req, res) => {
    const tokens = await authService.devLogin();
    res.status(200).json(tokens);
  }),
};
