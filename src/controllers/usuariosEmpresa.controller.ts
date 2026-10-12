import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { auditarAcceso, auditarAltaUsuario, auditarCambioUsuario, auditarQuitarAcceso } from './admin.controller';
import {
  altaEnEmpresa,
  catalogoUsuariosEmpresa,
  comprobarCorreo,
  editarEnEmpresa,
  listarUsuariosEmpresa,
  nuevaContrasenaEnEmpresa,
  quitarDeEmpresa,
  usuarioDeEmpresa,
  type Actor,
} from '../services/usuariosEmpresa.service';

/** Las respuestas que pueden llevar una contrasena provisional no se guardan en ninguna cache. */
const sinCache = (res: Response) => res.setHeader('Cache-Control', 'no-store');

const actorDe = (req: Request): Actor => ({ userId: req.user!.userId, esAdminGlobal: req.user!.esAdminGlobal === true });

/**
 * Configuracion > Usuarios (/companies/:companyId/usuarios). La empresa es
 * siempre req.companyId (companyScope), nunca la del cuerpo. Cada cambio queda
 * en AuditLog con la empresa desde la que se hizo; la contrasena, nunca.
 */
export const usuariosEmpresaController = {
  listar: asyncHandler(async (req, res) => {
    sendOk(res, await listarUsuariosEmpresa(actorDe(req), req.companyId!));
  }),

  catalogo: asyncHandler(async (_req, res) => {
    sendOk(res, catalogoUsuariosEmpresa());
  }),

  comprobarCorreo: asyncHandler(async (req, res) => {
    sendOk(res, await comprobarCorreo(req.companyId!, req.body.email));
  }),

  /** 201 con la contrasena provisional (una vez) si el usuario es nuevo; 200 si ya existia. */
  alta: asyncHandler(async (req, res) => {
    const actor = actorDe(req);
    const companyId = req.companyId!;
    const r = await altaEnEmpresa(actor, companyId, req.body);
    if (r.usuarioNuevo) await auditarAltaUsuario(actor.userId, r.usuarioCreado);
    else await auditarAcceso(actor.userId, r.userId, companyId, r.acceso);
    const usuario = await usuarioDeEmpresa(actor, companyId, r.userId);
    sinCache(res);
    if (r.usuarioNuevo) sendOk(res, { usuarioNuevo: true, usuario, contrasenaProvisional: r.contrasenaProvisional }, undefined, 201);
    else sendOk(res, { usuarioNuevo: false, usuario });
  }),

  editar: asyncHandler(async (req, res) => {
    const actor = actorDe(req);
    const companyId = req.companyId!;
    const { userId } = req.params;
    const { acceso, email, cambios } = await editarEnEmpresa(actor, companyId, userId, req.body);
    await auditarAcceso(actor.userId, userId, companyId, acceso);
    await auditarCambioUsuario(actor.userId, userId, email, cambios, companyId);
    const usuario = await usuarioDeEmpresa(actor, companyId, userId);
    sendOk(res, { ...usuario, cambiado: acceso.cambiado || Object.keys(cambios).length > 0 });
  }),

  nuevaContrasena: asyncHandler(async (req, res) => {
    const actor = actorDe(req);
    const companyId = req.companyId!;
    const { userId } = req.params;
    const r = await nuevaContrasenaEnEmpresa(actor, companyId, userId);
    await auditarCambioUsuario(actor.userId, userId, r.email, r.cambios, companyId);
    sinCache(res);
    sendOk(res, {
      userId,
      contrasenaProvisional: r.contrasenaProvisional,
      contrasenaProvisionalHasta: r.contrasenaProvisionalHasta,
      estado: 'contrasena_pendiente',
    });
  }),

  quitar: asyncHandler(async (req, res) => {
    const actor = actorDe(req);
    const companyId = req.companyId!;
    const { userId } = req.params;
    await auditarQuitarAcceso(actor.userId, userId, companyId, await quitarDeEmpresa(actor, companyId, userId));
    sendOk(res, { userId, companyId, quitado: true });
  }),
};
