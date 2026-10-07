import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import {
  actualizarEmpresa,
  actualizarUsuario,
  asignarRol,
  crearEmpresa,
  crearUsuario,
  listarEmpresas,
  listarUsuarios,
  quitarAcceso,
} from '../services/admin.service';
import { registrarAuditoria } from '../services/auditoria.service';
import type { CambiosUsuario } from '../services/admin.service';
import type { UsuarioAdmin } from '../domain/admin.model';

/** Auditoria del alta de un usuario. Nunca la contrasena. (La usa tambien POST /users.) */
export async function auditarAltaUsuario(actorId: string, usuario: UsuarioAdmin): Promise<void> {
  await registrarAuditoria({
    userId: actorId,
    companyId: usuario.empresas?.[0]?.companyId,
    action: 'CREATE_USUARIO',
    resourceType: 'USUARIO',
    resourceId: usuario.id,
    after: { email: usuario.email, esAdminGlobal: usuario.esAdminGlobal, empresas: usuario.empresas?.map((e) => ({ companyId: e.companyId, rol: e.rol })) },
  });
}

/** Auditoria de un cambio de usuario, si lo hubo. (La usa tambien PUT/DELETE /users.) */
export async function auditarCambioUsuario(actorId: string, userId: string, email: string, cambios: CambiosUsuario): Promise<void> {
  if (!Object.keys(cambios).length) return;
  await registrarAuditoria({
    userId: actorId,
    action: 'UPDATE_USUARIO',
    resourceType: 'USUARIO',
    resourceId: userId,
    // Solo QUE cambio: de la contrasena, que se restablecio, nunca cual es.
    meta: { email, ...cambios },
  });
}

/** Panel de administracion de la plataforma. Cada cambio queda en la auditoria. */
export const adminController = {
  listarEmpresas: asyncHandler(async (_req, res) => {
    sendOk(res, await listarEmpresas());
  }),

  crearEmpresa: asyncHandler(async (req, res) => {
    const { nombre, codigo } = req.body ?? {};
    const empresa = await crearEmpresa({ nombre, codigo }, req.user!.userId);
    await registrarAuditoria({
      userId: req.user!.userId,
      companyId: empresa.id,
      action: 'CREATE_EMPRESA',
      resourceType: 'EMPRESA',
      resourceId: empresa.id,
      after: { nombre: empresa.nombre, codigo: empresa.codigo },
    });
    sendOk(res, empresa, undefined, 201);
  }),

  actualizarEmpresa: asyncHandler(async (req, res) => {
    const { nombre, activa } = req.body ?? {};
    const r = await actualizarEmpresa(req.params.id, { nombre, activa });
    await registrarAuditoria({
      userId: req.user!.userId,
      companyId: req.params.id,
      action: 'UPDATE_EMPRESA',
      resourceType: 'EMPRESA',
      resourceId: req.params.id,
      meta: { antes: r.antes, despues: r.despues },
    });
    sendOk(res, { id: req.params.id, ...r.despues });
  }),

  listarUsuarios: asyncHandler(async (_req, res) => {
    sendOk(res, await listarUsuarios());
  }),

  crearUsuario: asyncHandler(async (req, res) => {
    const { email, password, esAdminGlobal, companyId, rol, role } = req.body ?? {};
    const usuario = await crearUsuario({ email, password, esAdminGlobal, companyId, rol: rol ?? role });
    await auditarAltaUsuario(req.user!.userId, usuario);
    sendOk(res, usuario, undefined, 201);
  }),

  actualizarUsuario: asyncHandler(async (req, res) => {
    const { activo, esAdminGlobal, nuevaContrasena } = req.body ?? {};
    const { usuario, cambios } = await actualizarUsuario(req.user!.userId, req.params.userId, { activo, esAdminGlobal, nuevaContrasena });
    await auditarCambioUsuario(req.user!.userId, req.params.userId, usuario.email, cambios);
    sendOk(res, usuario);
  }),

  asignarRol: asyncHandler(async (req, res) => {
    const pedido = req.body?.rol ?? req.body?.role ?? (Array.isArray(req.body?.roles) ? req.body.roles[0] : undefined);
    const { userId, companyId } = req.params;
    const { rol, rolAnterior } = await asignarRol(userId, companyId, pedido);
    await registrarAuditoria({
      userId: req.user!.userId,
      companyId,
      action: rolAnterior ? 'CAMBIAR_ROL_EMPRESA' : 'ASIGNAR_USUARIO_EMPRESA',
      resourceType: 'MEMBERSHIP',
      resourceId: userId,
      meta: { targetUserId: userId, companyId, rol, rolAnterior },
    });
    sendOk(res, { userId, companyId, rol, rolAnterior });
  }),

  quitarAcceso: asyncHandler(async (req, res) => {
    const { userId, companyId } = req.params;
    const { rolAnterior } = await quitarAcceso(userId, companyId);
    await registrarAuditoria({
      userId: req.user!.userId,
      companyId,
      action: 'QUITAR_USUARIO_EMPRESA',
      resourceType: 'MEMBERSHIP',
      resourceId: userId,
      meta: { targetUserId: userId, companyId, rolAnterior },
    });
    sendOk(res, { userId, companyId, quitado: true });
  }),
};
