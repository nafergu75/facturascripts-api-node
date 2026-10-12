import { Router } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { aniosEmpresa } from '../utils/anios';

/**
 * Montado bajo /companies/:companyId/anios (scoped). Años de la empresa para
 * los desplegables: { primero, actual, conDatos, ejercicios: [{ anio, estado }] }.
 * Sin authorize a proposito: lo necesita cualquier miembro de la empresa
 * (tambien quien solo tiene impuestos o nominas), y solo devuelve años, nunca
 * importes. companyScope ya comprueba que el usuario es de la empresa.
 */
const router = Router({ mergeParams: true });

router.get(
  '/',
  asyncHandler(async (req, res) => {
    sendOk(res, await aniosEmpresa(req.companyId!));
  }),
);

export default router;
