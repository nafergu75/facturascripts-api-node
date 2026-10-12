import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import { proponerConciliaciones } from '../services/conciliacion.service';
import { MovimientoBanco } from '../domain/conciliacion.model';
import { validarEjercicio } from '../utils/anios';

export const conciliacionController = {
  // POST /companies/:companyId/conciliacion/proponer?ejercicio=2026  (body: MovimientoBanco[])
  proponer: asyncHandler(async (req, res) => {
    const ejercicio = validarEjercicio(req.query.ejercicio);
    if (!Array.isArray(req.body)) throw badRequest('El cuerpo debe ser un array de movimientos bancarios.');
    const sugerencias = await proponerConciliaciones(req.companyId!, ejercicio, req.body as MovimientoBanco[]);
    sendOk(res, sugerencias);
  }),
};
