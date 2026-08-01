import { asyncHandler } from '../utils/async-handler';
import { productosService } from '../services/productos.service';
import { sendMessage, sendOk } from '../utils/response';

export const productosController = {
  list: asyncHandler(async (req, res) => {
    const data = await productosService.list(req.companyId!, req.query as Record<string, unknown>);
    sendOk(res, data);
  }),
  getById: asyncHandler(async (req, res) => {
    const data = await productosService.getById(req.companyId!, req.params.id);
    sendOk(res, data);
  }),
  create: asyncHandler(async (req, res) => {
    const data = await productosService.create(req.companyId!, req.body);
    sendOk(res, data, undefined, 201);
  }),
  update: asyncHandler(async (req, res) => {
    const data = await productosService.update(req.companyId!, req.params.id, req.body);
    sendOk(res, data);
  }),
  remove: asyncHandler(async (req, res) => {
    await productosService.remove(req.companyId!, req.params.id);
    sendMessage(res, 'Producto eliminado');
  }),
};
