import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import {
  actualizarEmpresa,
  actualizarUsuario,
  asignarRol,
  catalogoPermisos,
  crearEmpresa,
  crearUsuario,
  listarEmpresas,
  listarUsuarios,
  quitarAcceso,
} from '../services/admin.service';
import { registrarAuditoria } from '../services/auditoria.service';
import type { CambiosUsuario } from '../services/admin.service';
import type { AccesoAsignado } from '../domain/admin.model';
import type { Response } from 'express';
import type { UsuarioConContrasena } from '../domain/admin.model';

/** Las respuestas que pueden llevar una contrasena provisional no se guardan en ninguna cache. */
const sinCache = (res: Response) => res.setHeader('Cache-Control', 'no-store');

/**
 * Auditoria del alta de un usuario. Nunca la contrasena: solo que es
 * provisional y si la genero el servidor. (La usa tambien POST /users.)
 */
export async function auditarAltaUsuario(actorId: string, usuario: UsuarioConContrasena): Promise<void> {
  await registrarAuditoria({
    userId: actorId,
    companyId: usuario.empresas?.[0]?.companyId,
    action: 'CREATE_USUARIO',
    resourceType: 'USUARIO',
    resourceId: usuario.id,
    after: {
      email: usuario.email,
      esAdminGlobal: usuario.esAdminGlobal,
      contrasenaProvisional: true,
      contrasenaGenerada: typeof usuario.contrasenaProvisional === 'string',
      empresas: usuario.empresas?.map((e) => ({ companyId: e.companyId, rol: e.rol, personalizado: e.personalizado, areas: e.areas })),
    },
  });
}

/**
 * Auditoria de un cambio de usuario, si lo hubo. (La usan tambien PUT/DELETE
 * /users y Configuracion > Usuarios, que indica la empresa desde la que se hizo.)
 */
export async function auditarCambioUsuario(
  actorId: string,
  userId: string,
  email: string,
  cambios: CambiosUsuario,
  companyId?: string,
): Promise<void> {
  if (!Object.keys(cambios).length) return;
  await registrarAuditoria({
    userId: actorId,
    companyId,
    action: 'UPDATE_USUARIO',
    resourceType: 'USUARIO',
    resourceId: userId,
    // Solo QUE cambio: de la contrasena, que se restablecio, nunca cual es.
    meta: { email, ...cambios },
  });
}

/**
 * Auditoria de dar o cambiar un acceso (si cambio algo): ASIGNAR_USUARIO_EMPRESA,
 * CAMBIAR_ROL_EMPRESA o CAMBIAR_PERMISOS_EMPRESA. (La usa tambien Configuracion > Usuarios.)
 */
export async function auditarAcceso(actorId: string, userId: string, companyId: string, r: AccesoAsignado): Promise<void> {
  if (!r.cambiado) return;
  const base = { targetUserId: userId, companyId, rol: r.rol, personalizado: r.personalizado, areas: r.areas };
  const [action, meta] = !r.rolAnterior
    ? ['ASIGNAR_USUARIO_EMPRESA', base]
    : r.rolAnterior !== r.rol
      ? ['CAMBIAR_ROL_EMPRESA', { ...base, rolAnterior: r.rolAnterior, areasAnteriores: r.areasAnteriores }]
      : ['CAMBIAR_PERMISOS_EMPRESA', { ...base, personalizadoAntes: r.personalizadoAntes, areasAnteriores: r.areasAnteriores }];
  await registrarAuditoria({ userId: actorId, companyId, action: action as string, resourceType: 'MEMBERSHIP', resourceId: userId, meta });
}

/** Auditoria de quitar el acceso a una empresa. (La usa tambien Configuracion > Usuarios.) */
export async function auditarQuitarAcceso(
  actorId: string,
  userId: string,
  companyId: string,
  r: { rolAnterior: string; personalizadoAntes: boolean },
): Promise<void> {
  await registrarAuditoria({
    userId: actorId,
    companyId,
    action: 'QUITAR_USUARIO_EMPRESA',
    resourceType: 'MEMBERSHIP',
    resourceId: userId,
    meta: { targetUserId: userId, companyId, rolAnterior: r.rolAnterior, personalizadoAntes: r.personalizadoAntes },
  });
}

/** Panel de administracion de la plataforma. Cada cambio queda en la auditoria. */
export const adminController = {
  listarEmpresas: asyncHandler(async (_req, res) => {
    sendOk(res, await listarEmpresas());
  }),

  crearEmpresa: asyncHandler(async (req, res) => {
    // `datos`: los de la empresa (LegalConfig). Opcional para no romper a quien
    // solo envie nombre y codigo; el panel los manda siempre.
    const { nombre, codigo, datos } = req.body ?? {};
    const empresa = await crearEmpresa({ nombre, codigo, datos }, req.user!.userId);
    await registrarAuditoria({
      userId: req.user!.userId,
      companyId: empresa.id,
      action: 'CREATE_EMPRESA',
      resourceType: 'EMPRESA',
      resourceId: empresa.id,
      after: {
        nombre: empresa.nombre,
        codigo: empresa.codigo,
        denominacion: empresa.denominacion,
        nif: empresa.nif,
        pais: empresa.pais,
        pendientes: empresa.pendientes,
      },
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

  /** Areas, niveles y perfiles de la matriz de permisos (lo pinta el panel). */
  catalogoPermisos: asyncHandler(async (_req, res) => {
    sendOk(res, catalogoPermisos());
  }),

  /**
   * Alta: sin `password`, la genera el servidor y va en la respuesta UNA vez
   * (contrasenaProvisional). Con ella escrita, no se repite. Siempre provisional.
   */
  crearUsuario: asyncHandler(async (req, res) => {
    const { email, password, esAdminGlobal, companyId, rol, role, areas, nombre, telefono } = req.body ?? {};
    const usuario = await crearUsuario(
      { email, password, esAdminGlobal, companyId, rol: rol ?? role, areas, nombre, telefono },
      { generarSiFalta: true },
    );
    await auditarAltaUsuario(req.user!.userId, usuario);
    sinCache(res);
    sendOk(res, usuario, undefined, 201);
  }),

  actualizarUsuario: asyncHandler(async (req, res) => {
    const { activo, esAdminGlobal, nuevaContrasena, restablecerContrasena, exigirCambioContrasena, nombre, telefono } = req.body ?? {};
    const { usuario, cambios, contrasenaProvisional } = await actualizarUsuario(req.user!.userId, req.params.userId, {
      activo,
      esAdminGlobal,
      nuevaContrasena,
      restablecerContrasena,
      exigirCambioContrasena,
      nombre,
      telefono,
    });
    await auditarCambioUsuario(req.user!.userId, req.params.userId, usuario.email, cambios);
    sinCache(res);
    sendOk(res, contrasenaProvisional ? { ...usuario, contrasenaProvisional } : usuario);
  }),

  /**
   * Da o cambia el acceso (sustitucion completa: rol y areas). El cuerpo ya
   * viene validado (admin.routes, solo rol/role/roles/areas). Sin cambios no se
   * audita nada.
   */
  asignarRol: asyncHandler(async (req, res) => {
    const pedido = req.body?.rol ?? req.body?.role ?? (Array.isArray(req.body?.roles) ? req.body.roles[0] : undefined);
    const { userId, companyId } = req.params;
    const r = await asignarRol(userId, companyId, pedido, req.body?.areas);
    await auditarAcceso(req.user!.userId, userId, companyId, r);
    sendOk(res, {
      userId,
      companyId,
      rol: r.rol,
      rolAnterior: r.rolAnterior,
      personalizado: r.personalizado,
      areas: r.areas,
      areasAnteriores: r.areasAnteriores,
      cambiado: r.cambiado,
    });
  }),

  quitarAcceso: asyncHandler(async (req, res) => {
    const { userId, companyId } = req.params;
    await auditarQuitarAcceso(req.user!.userId, userId, companyId, await quitarAcceso(userId, companyId));
    sendOk(res, { userId, companyId, quitado: true });
  }),
};
