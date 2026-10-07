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
      meta: {
        email: tokens.user.email,
        esAdminGlobal: tokens.user.esAdminGlobal,
        empresaSeleccionada: tokens.empresaSeleccionada,
        debeCambiarContrasena: tokens.user.debeCambiarContrasena,
      },
    });
    sendOk(res, tokens);
  }),

  /** GET /auth/me — usuario y permisos actuales de la sesion. */
  me: asyncHandler(async (req, res) => {
    sendOk(res, await authService.me(req.user!.userId));
  }),

  /**
   * POST /auth/cambiar-contrasena — el usuario cambia la suya (tambien la
   * provisional). Devuelve tokens nuevos: no-store para que nada los guarde.
   */
  cambiarContrasena: asyncHandler(async (req, res) => {
    const userId = req.user!.userId;
    const { actual, nueva } = req.body as { actual: string; nueva: string };
    const { eraProvisional, ...resultado } = await authService.cambiarContrasena(userId, actual, nueva);
    // Solo que se cambio y si era la provisional: nunca ninguna de las dos contrasenas.
    await registrarAuditoria({
      userId,
      action: 'CAMBIAR_CONTRASENA_PROPIA',
      resourceType: 'USUARIO',
      resourceId: userId,
      meta: { eraProvisional },
    });
    res.setHeader('Cache-Control', 'no-store');
    sendOk(res, resultado);
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
