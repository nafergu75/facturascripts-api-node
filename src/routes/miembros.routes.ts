import { Router } from 'express';
import { authorize } from '../middleware/authorize.middleware';
import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { listarMiembros } from '../services/miembros.service';

// Montado bajo /companies/:companyId/miembros (scoped). Solo lectura y solo para
// el administrador de la empresa (o el admin global). La gestion de usuarios
// sigue en Administracion global.
const router = Router({ mergeParams: true });

router.get(
  '/',
  authorize('admin:empresa'),
  asyncHandler(async (req, res) => {
    sendOk(res, await listarMiembros(req.companyId!));
  }),
);

export default router;
