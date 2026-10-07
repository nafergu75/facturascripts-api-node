import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { registrarAuditoria } from '../services/auditoria.service';
import {
  actualizarEmpleado,
  borrarEmpleado,
  crearEmpleado,
  darDeBajaEmpleado,
  listarEmpleados,
  obtenerEmpleado,
} from '../services/empleados.service';

export const empleadosController = {
  listar: asyncHandler(async (req, res) => {
    const activos = req.query.activos === undefined ? undefined : ['1', 'true', 'si', 'sí'].includes(String(req.query.activos).toLowerCase());
    sendOk(res, await listarEmpleados(req.companyId!, { activos, q: req.query.q ? String(req.query.q) : undefined }));
  }),

  obtener: asyncHandler(async (req, res) => {
    sendOk(res, await obtenerEmpleado(req.companyId!, req.params.id));
  }),

  crear: asyncHandler(async (req, res) => {
    const e = await crearEmpleado(req.companyId!, req.body);
    await registrarAuditoria({ userId: req.user!.userId, companyId: req.companyId, action: 'CREAR_EMPLEADO', resourceType: 'EMPLEADO', resourceId: e.id });
    sendOk(res, e, undefined, 201);
  }),

  actualizar: asyncHandler(async (req, res) => {
    const e = await actualizarEmpleado(req.companyId!, req.params.id, req.body);
    await registrarAuditoria({ userId: req.user!.userId, companyId: req.companyId, action: 'EDITAR_EMPLEADO', resourceType: 'EMPLEADO', resourceId: e.id });
    sendOk(res, e);
  }),

  baja: asyncHandler(async (req, res) => {
    const e = await darDeBajaEmpleado(req.companyId!, req.params.id, req.body);
    await registrarAuditoria({ userId: req.user!.userId, companyId: req.companyId, action: 'BAJA_EMPLEADO', resourceType: 'EMPLEADO', resourceId: e.id, meta: { fechaBaja: e.fechaBaja } });
    sendOk(res, e);
  }),

  borrar: asyncHandler(async (req, res) => {
    await borrarEmpleado(req.companyId!, req.params.id);
    await registrarAuditoria({ userId: req.user!.userId, companyId: req.companyId, action: 'BORRAR_EMPLEADO', resourceType: 'EMPLEADO', resourceId: req.params.id });
    sendOk(res, { borrado: true });
  }),
};
