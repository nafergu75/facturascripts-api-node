import { asyncHandler } from '../utils/async-handler';
import { sendMessage, sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import {
  asignarUsuarioAEmpresa,
  crearEmpresa,
  crearUsuario,
  listarEmpresas,
} from '../services/admin.service';
import { registrarAuditoria } from '../services/auditoria.service';

export const adminController = {
  listarEmpresas: asyncHandler(async (_req, res) => {
    sendOk(res, await listarEmpresas());
  }),

  crearEmpresa: asyncHandler(async (req, res) => {
    const { nombre, fsBaseUrl, fsApiKey, codigo } = req.body ?? {};
    if (!nombre || !fsBaseUrl || !fsApiKey) throw badRequest('Se requiere nombre, fsBaseUrl y fsApiKey.');
    const empresa = await crearEmpresa({ nombre, fsBaseUrl, fsApiKey, codigo });
    await registrarAuditoria({ userId: req.user!.userId, companyId: empresa.id, action: 'CREATE_EMPRESA', resourceType: 'EMPRESA', resourceId: empresa.id, after: { nombre, codigo } });
    sendOk(res, empresa, undefined, 201);
  }),

  crearUsuario: asyncHandler(async (req, res) => {
    const { email, password, esAdminGlobal } = req.body ?? {};
    if (!email || !password) throw badRequest('Se requiere email y password.');
    const usuario = await crearUsuario({ email, password, esAdminGlobal: esAdminGlobal === true });
    await registrarAuditoria({ userId: req.user!.userId, action: 'CREATE_USUARIO', resourceType: 'USUARIO', resourceId: usuario.id, after: { email, esAdminGlobal: usuario.esAdminGlobal } });
    sendOk(res, usuario, undefined, 201);
  }),

  asignar: asyncHandler(async (req, res) => {
    const role = (req.body?.role as string) ?? (Array.isArray(req.body?.roles) ? req.body.roles[0] : '');
    await asignarUsuarioAEmpresa(req.params.userId, req.params.companyId, role);
    await registrarAuditoria({
      userId: req.user!.userId,
      companyId: req.params.companyId,
      action: 'ASIGNAR_USUARIO_EMPRESA',
      resourceType: 'MEMBERSHIP',
      resourceId: req.params.userId,
      meta: { targetUserId: req.params.userId, companyId: req.params.companyId, role },
    });
    sendMessage(res, 'Usuario asignado a la empresa');
  }),
};
