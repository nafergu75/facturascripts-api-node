import { Router } from 'express';
import { authorize } from '../middleware/authorize.middleware';
import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import {
  actualizarActivo,
  anularDotacionMes,
  calcularDotaciones,
  crearActivo,
  darDeBaja,
  listarActivos,
  mesesSinDotar,
} from '../services/arranque/inmovilizado.service';

/**
 * Inmovilizado y su amortizacion (/companies/:companyId/inmovilizado).
 *
 *   GET  /                          fichas con lo amortizado y el valor neto (?todos=1 incluye las de baja)
 *   GET  /pendiente?hasta=AAAA-MM   meses con amortizacion por apuntar
 *   POST /                          alta de un bien
 *   PUT  /:id                       cambio de un bien (solo sin amortizacion apuntada)
 *   POST /:id/baja                  { fechaBaja }
 *   POST /dotaciones                { hasta: 'AAAA-MM' } asientos en borrador mes a mes
 *   POST /dotaciones/:periodo/anular   anula la amortizacion de un mes
 */
const router = Router({ mergeParams: true });

router.get(
  '/',
  authorize('contabilidad:read'),
  asyncHandler(async (req, res) => {
    const todos = req.query.todos === '1' || req.query.todos === 'true';
    const [lista, pendiente] = await Promise.all([listarActivos(req.companyId!, { todos }), mesesSinDotar(req.companyId!)]);
    sendOk(res, { ...lista, pendiente });
  }),
);

router.get(
  '/pendiente',
  authorize('contabilidad:read'),
  asyncHandler(async (req, res) => {
    const hasta = typeof req.query.hasta === 'string' && /^\d{4}-\d{2}$/.test(req.query.hasta) ? req.query.hasta : undefined;
    sendOk(res, await mesesSinDotar(req.companyId!, hasta));
  }),
);

router.post(
  '/',
  authorize('contabilidad:write'),
  asyncHandler(async (req, res) => {
    sendOk(res, await crearActivo(req.companyId!, req.body, req.user!.userId), undefined, 201);
  }),
);

router.put(
  '/:id',
  authorize('contabilidad:write'),
  asyncHandler(async (req, res) => {
    sendOk(res, await actualizarActivo(req.companyId!, req.params.id, req.body, req.user!.userId));
  }),
);

router.post(
  '/:id/baja',
  authorize('contabilidad:write'),
  asyncHandler(async (req, res) => {
    sendOk(res, await darDeBaja(req.companyId!, req.params.id, (req.body ?? {}).fechaBaja, req.user!.userId));
  }),
);

router.post(
  '/dotaciones',
  authorize('contabilidad:write'),
  asyncHandler(async (req, res) => {
    sendOk(res, await calcularDotaciones(req.companyId!, (req.body ?? {}).hasta, req.user!.userId));
  }),
);

router.post(
  '/dotaciones/:periodo/anular',
  authorize('contabilidad:write'),
  asyncHandler(async (req, res) => {
    sendOk(res, await anularDotacionMes(req.companyId!, req.params.periodo, req.user!.userId));
  }),
);

export default router;
