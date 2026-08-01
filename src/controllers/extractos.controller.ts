import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import {
  generarExtractoBancario,
  exportarExtractoCSV,
  revisarExtractoContraContabilidad,
} from '../services/extractos.service';

function rango(req: { query: Record<string, unknown> }) {
  const desde = req.query.desde ? String(req.query.desde) : undefined;
  const hasta = req.query.hasta ? String(req.query.hasta) : undefined;
  const saldoInicial = req.query.saldoInicial !== undefined ? Number(req.query.saldoInicial) : undefined;
  if (saldoInicial !== undefined && !Number.isFinite(saldoInicial)) throw badRequest('saldoInicial invalido.');
  return { desde, hasta, saldoInicial };
}

function parseEjercicio(raw: unknown): number {
  const e = Number(raw);
  if (!Number.isInteger(e)) throw badRequest('Parametro "ejercicio" invalido.');
  return e;
}

export const extractosController = {
  extracto: asyncHandler(async (req, res) => {
    sendOk(res, await generarExtractoBancario(req.companyId!, req.params.cuentaId, rango(req)));
  }),

  extractoCsv: asyncHandler(async (req, res) => {
    const ext = await generarExtractoBancario(req.companyId!, req.params.cuentaId, rango(req));
    const csv = exportarExtractoCSV(ext);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="extracto_${req.params.cuentaId}.csv"`);
    res.status(200).send(csv);
  }),

  revision: asyncHandler(async (req, res) => {
    const ejercicio = parseEjercicio(req.query.ejercicio);
    sendOk(res, await revisarExtractoContraContabilidad(req.companyId!, req.params.cuentaId, ejercicio, rango(req)));
  }),
};
