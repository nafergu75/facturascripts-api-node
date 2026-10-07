import { asyncHandler } from '../utils/async-handler';
import { usersService } from '../services/users.service';
import { actualizarUsuario, crearUsuario } from '../services/admin.service';
import { auditarAltaUsuario, auditarCambioUsuario } from './admin.controller';
import { sendMessage, sendOk } from '../utils/response';

/**
 * API antigua de usuarios (/users). Las escrituras pasan por admin.service, el
 * mismo que /admin/usuarios: sin atajos que se salten sus protecciones.
 */
export const usersController = {
  list: asyncHandler(async (req, res) => {
    const data = await usersService.list(req.query as Record<string, unknown>);
    sendOk(res, data);
  }),
  getById: asyncHandler(async (req, res) => {
    const data = await usersService.getById(req.params.id);
    sendOk(res, data);
  }),
  create: asyncHandler(async (req, res) => {
    const { email, password } = req.body ?? {};
    const usuario = await crearUsuario({ email, password });
    await auditarAltaUsuario(req.user!.userId, usuario);
    sendOk(res, await usersService.getById(usuario.id), undefined, 201);
  }),
  // Cuerpo { isActive?, password? }: se traduce al de /admin/usuarios.
  update: asyncHandler(async (req, res) => {
    const { isActive, password } = req.body ?? {};
    const { usuario, cambios } = await actualizarUsuario(req.user!.userId, req.params.id, {
      activo: isActive,
      nuevaContrasena: password,
    });
    await auditarCambioUsuario(req.user!.userId, req.params.id, usuario.email, cambios);
    sendOk(res, await usersService.getById(req.params.id));
  }),
  // Baja LOGICA (isActive=false): conserva auditoria y accesos.
  remove: asyncHandler(async (req, res) => {
    const { usuario, cambios } = await actualizarUsuario(req.user!.userId, req.params.id, { activo: false });
    await auditarCambioUsuario(req.user!.userId, req.params.id, usuario.email, cambios);
    sendMessage(res, 'Usuario desactivado');
  }),
};
