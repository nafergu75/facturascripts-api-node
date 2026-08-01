import { asyncHandler } from '../utils/async-handler';
import { clientesService, buscarClientes } from '../services/clientes.service';
import { sendMessage, sendOk } from '../utils/response';

export const clientesController = {
  list: asyncHandler(async (req, res) => {
    const data = await clientesService.list(req.companyId!, req.query as Record<string, unknown>);
    sendOk(res, data);
  }),
  // Buscador de clientes para seleccionar al facturar (Feature 4).
  buscar: asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '');
    const limit = Math.min(Math.max(1, Number(req.query.limit ?? 20) || 20), 100);
    sendOk(res, await buscarClientes(req.companyId!, q, limit));
  }),
  getById: asyncHandler(async (req, res) => {
    const data = await clientesService.getById(req.companyId!, req.params.id);
    sendOk(res, data);
  }),
  create: asyncHandler(async (req, res) => {
    const data = await clientesService.create(req.companyId!, req.body);
    sendOk(res, data, undefined, 201);
  }),
  update: asyncHandler(async (req, res) => {
    const data = await clientesService.update(req.companyId!, req.params.id, req.body);
    sendOk(res, data);
  }),
  remove: asyncHandler(async (req, res) => {
    await clientesService.remove(req.companyId!, req.params.id);
    sendMessage(res, 'Cliente eliminado');
  }),
};
