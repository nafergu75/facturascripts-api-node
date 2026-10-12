import type { RequestHandler } from 'express';
import { confirmadoSinPlanAnterior, exigirPlanAnteriorAntesDeAlta } from '../services/terceros/planAnteriorAlta';

/**
 * Antes de las seis entradas que pueden dar de alta el primer cliente o
 * proveedor (Clientes, Proveedores, factura nueva, compra nueva y los dos
 * lectores): si la empresa aun no ha traido el plan de cuentas de la gestoria,
 * 409 PLAN_ANTERIOR_PENDIENTE hasta que el cuerpo lleve
 * «confirmarSinPlanAnterior: true». La marca se quita del cuerpo para que el
 * resto de la ruta no la vea.
 *
 * Va despues de authorize: quien no puede dar de alta recibe antes el 403.
 */
export const exigirPlanAnterior: RequestHandler = async (req, _res, next) => {
  try {
    const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : null;
    const confirmado = confirmadoSinPlanAnterior(body?.confirmarSinPlanAnterior);
    if (body && 'confirmarSinPlanAnterior' in body) delete body.confirmarSinPlanAnterior;
    if (req.companyId) await exigirPlanAnteriorAntesDeAlta(req.companyId, confirmado, req.user?.userId ?? 'desconocido');
    next();
  } catch (e) {
    next(e);
  }
};
