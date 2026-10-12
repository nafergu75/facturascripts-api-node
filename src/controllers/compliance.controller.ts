import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { generarAlertasCompliance, listarAlertasGuardadas } from '../services/compliance.service';
import { validarEjercicio } from '../utils/anios';

/** Ejercicio de la consulta: de 1990 al año que viene (hora de España). */
const parseEjercicio = (raw: unknown): number => validarEjercicio(raw);

export const complianceController = {
  alertas: asyncHandler(async (req, res) => {
    sendOk(res, await generarAlertasCompliance(req.companyId!, parseEjercicio(req.query.ejercicio)));
  }),
  historico: asyncHandler(async (req, res) => {
    sendOk(res, await listarAlertasGuardadas(req.companyId!, parseEjercicio(req.query.ejercicio)));
  }),
};
