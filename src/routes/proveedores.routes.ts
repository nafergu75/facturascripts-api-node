import { Router } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { makeScopedController } from '../controllers/scoped-crud.controller';
import { proveedoresService, buscarProveedores } from '../services/proveedores.service';
import { authorize } from '../middleware/authorize.middleware';

const c = makeScopedController(proveedoresService, 'Proveedor eliminado');
const router = Router({ mergeParams: true });

router.get('/', c.list);
// Buscador (antes de /:id) para seleccionar proveedor al registrar gastos.
router.get(
  '/buscar',
  authorize('ventas:read'),
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '');
    const limit = Math.min(Math.max(1, Number(req.query.limit ?? 20) || 20), 100);
    sendOk(res, await buscarProveedores(req.companyId!, q, limit));
  }),
);
router.get('/:id', c.getById);
router.post('/', c.create);
router.put('/:id', c.update);
router.delete('/:id', c.remove);

export default router;
