import { RequestHandler } from 'express';
import { forbidden } from '../utils/http-errors';
import { estadoPeriodoEnFecha } from '../services/periodos.service';

/**
 * Impide crear/modificar asientos o documentos cuya fecha caiga en un periodo
 * CERRADO. Toma la fecha de body.fecha o query.fecha (yyyy-mm-dd).
 */
export const bloquearPeriodoCerrado: RequestHandler = async (req, _res, next) => {
  const fecha = (req.body?.fecha as string) ?? (req.query.fecha as string) ?? '';
  if (!fecha) return next();

  const estado = await estadoPeriodoEnFecha(req.companyId!, fecha);
  if (estado === 'cerrado') {
    return next(forbidden(`El periodo de la fecha ${fecha} esta cerrado; no se permiten cambios.`));
  }
  return next();
};
