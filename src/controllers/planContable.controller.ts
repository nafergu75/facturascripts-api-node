import { asyncHandler } from '../utils/async-handler';
import { sendMessage, sendOk } from '../utils/response';
import { badRequest, notFound } from '../utils/http-errors';
import {
  actualizarSubcuentaEmpresa,
  crearSubcuentaEmpresa,
  crearSubcuentaGastoEmpresa,
  desactivarSubcuentaEmpresa,
  listarCuentasBase,
  listarGruposBase,
  listarSubcuentasEmpresa,
  listarSubgruposBase,
} from '../services/planContable.service';
import { registrarAuditoria } from '../services/auditoria.service';

export const planContableController = {
  // --- Plan base (lectura, sin empresa) ---
  grupos: asyncHandler(async (_req, res) => sendOk(res, listarGruposBase())),
  subgrupos: asyncHandler(async (_req, res) => sendOk(res, listarSubgruposBase())),
  cuentas: asyncHandler(async (_req, res) => sendOk(res, listarCuentasBase())),

  // --- Subcuentas por empresa ---
  listarSubcuentas: asyncHandler(async (req, res) => {
    sendOk(res, await listarSubcuentasEmpresa(req.companyId!));
  }),
  crearSubcuenta: asyncHandler(async (req, res) => {
    if (!req.body?.codigo || !req.body?.cuentaBaseCodigo) {
      throw badRequest('codigo y cuentaBaseCodigo son obligatorios.');
    }
    const sub = await crearSubcuentaEmpresa(req.companyId!, {
      codigo: req.body.codigo,
      nombre: req.body.nombre ?? '',
      cuentaBaseCodigo: req.body.cuentaBaseCodigo,
      activa: req.body.activa ?? true,
      analitica: req.body.analitica,
    });
    await registrarAuditoria({ userId: req.user!.userId, companyId: req.companyId, action: 'CREATE_SUBCUENTA', resourceType: 'SUBCUENTA', resourceId: sub.id, after: sub });
    sendOk(res, sub, undefined, 201);
  }),
  // Alta rapida de subcuenta de GASTO (concreta el gasto, ej. 'Luz oficina').
  crearSubcuentaGasto: asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.cuentaBaseCodigo || !b.nombre) throw badRequest('cuentaBaseCodigo y nombre son obligatorios.');
    const sub = await crearSubcuentaGastoEmpresa(req.companyId!, String(b.cuentaBaseCodigo), String(b.nombre), b.sufijoOpcional ? String(b.sufijoOpcional) : undefined);
    await registrarAuditoria({ userId: req.user!.userId, companyId: req.companyId, action: 'CREATE_SUBCUENTA_GASTO', resourceType: 'SUBCUENTA', resourceId: sub.id, after: sub });
    sendOk(res, sub, undefined, 201);
  }),
  actualizarSubcuenta: asyncHandler(async (req, res) => {
    const sub = await actualizarSubcuentaEmpresa(req.companyId!, req.params.id, req.body);
    if (!sub) throw notFound('Subcuenta no encontrada.');
    await registrarAuditoria({ userId: req.user!.userId, companyId: req.companyId, action: 'UPDATE_SUBCUENTA', resourceType: 'SUBCUENTA', resourceId: sub.id, after: sub });
    sendOk(res, sub);
  }),
  desactivarSubcuenta: asyncHandler(async (req, res) => {
    const ok = await desactivarSubcuentaEmpresa(req.companyId!, req.params.id);
    if (!ok) throw notFound('Subcuenta no encontrada.');
    sendMessage(res, 'Subcuenta desactivada');
  }),
};
