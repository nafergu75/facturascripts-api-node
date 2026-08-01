import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import { generarAlertasCompliance, listarAlertasGuardadas } from '../services/compliance.service';

function parseEjercicio(raw: unknown): number {
  const e = Number(raw);
  if (!Number.isInteger(e)) throw badRequest('Parametro "ejercicio" invalido.');
  return e;
}

export const complianceController = {
  alertas: asyncHandler(async (req, res) => {
    sendOk(res, await generarAlertasCompliance(req.companyId!, parseEjercicio(req.query.ejercicio)));
  }),
  historico: asyncHandler(async (req, res) => {
    sendOk(res, await listarAlertasGuardadas(req.companyId!, parseEjercicio(req.query.ejercicio)));
  }),
};
