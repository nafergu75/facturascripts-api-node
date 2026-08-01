import { asyncHandler } from '../utils/async-handler';
import { inventarioService } from '../services/inventario.service';
import { sendMessage, sendOk } from '../utils/response';

export const inventarioController = {
  list: asyncHandler(async (req, res) => {
    const data = await inventarioService.list(req.companyId!, req.query as Record<string, unknown>);
    sendOk(res, data);
  }),
  getById: asyncHandler(async (req, res) => {
    const data = await inventarioService.getById(req.companyId!, req.params.id);
    sendOk(res, data);
  }),
  create: asyncHandler(async (req, res) => {
    const data = await inventarioService.create(req.companyId!, req.body);
    sendOk(res, data, undefined, 201);
  }),
  update: asyncHandler(async (req, res) => {
    const data = await inventarioService.update(req.companyId!, req.params.id, req.body);
    sendOk(res, data);
  }),
  remove: asyncHandler(async (req, res) => {
    await inventarioService.remove(req.companyId!, req.params.id);
    sendMessage(res, 'Registro eliminado');
  }),
};
