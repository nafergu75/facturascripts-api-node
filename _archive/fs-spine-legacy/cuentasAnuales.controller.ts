import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import {
  generarCuentasAnuales,
  generarEstadoFlujosEfectivo,
  generarLibroDiario,
  generarLibroInventarios,
} from '../services/cuentasAnuales.service';

function parseEjercicio(raw: unknown): number {
  const e = Number(raw);
  if (!Number.isInteger(e) || e < 2000) throw badRequest('Parametro "ejercicio" invalido.');
  return e;
}

export const cuentasAnualesController = {
  // GET /companies/:companyId/cuentas-anuales/preview?ejercicio=2026
  preview: asyncHandler(async (req, res) => {
    sendOk(res, await generarCuentasAnuales(req.companyId!, parseEjercicio(req.query.ejercicio)));
  }),
  libroDiario: asyncHandler(async (req, res) => {
    sendOk(res, await generarLibroDiario(req.companyId!, parseEjercicio(req.query.ejercicio)));
  }),
  libroInventarios: asyncHandler(async (req, res) => {
    sendOk(res, await generarLibroInventarios(req.companyId!, parseEjercicio(req.query.ejercicio)));
  }),
  efe: asyncHandler(async (req, res) => {
    sendOk(res, await generarEstadoFlujosEfectivo(req.companyId!, parseEjercicio(req.query.ejercicio)));
  }),
};
