import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import { obtenerReglas, guardarReglas } from '../services/reglasContables.service';
import { registrarAuditoria } from '../services/auditoria.service';

export const reglasContablesController = {
  // GET /companies/:companyId/reglas-contables
  get: asyncHandler(async (req, res) => {
    sendOk(res, await obtenerReglas(req.companyId!));
  }),

  // PUT /companies/:companyId/reglas-contables
  put: asyncHandler(async (req, res) => {
    if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) {
      throw badRequest('El cuerpo debe ser un objeto de reglas contables.');
    }
    const reglas = await guardarReglas(req.companyId!, req.body);
    await registrarAuditoria({
      userId: req.user!.userId,
      companyId: req.companyId,
      action: 'UPDATE_REGLAS',
      resourceType: 'REGLAS_CONTABLES',
      after: reglas,
    });
    sendOk(res, reglas);
  }),
};
