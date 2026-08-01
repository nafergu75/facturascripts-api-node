import { CompanyScopedService } from '../domain/common.types';
import { asyncHandler } from '../utils/async-handler';
import { sendMessage, sendOk } from '../utils/response';

/**
 * Construye un controller CRUD para un recurso acotado a empresa. Toma el
 * companyId de req.companyId (lo fija companyScope) y delega en el service.
 */
export function makeScopedController(service: CompanyScopedService, removedMsg = 'Registro eliminado') {
  return {
    list: asyncHandler(async (req, res) => {
      sendOk(res, await service.list(req.companyId!, req.query as Record<string, unknown>));
    }),
    getById: asyncHandler(async (req, res) => {
      sendOk(res, await service.getById(req.companyId!, req.params.id));
    }),
    create: asyncHandler(async (req, res) => {
      sendOk(res, await service.create(req.companyId!, req.body), undefined, 201);
    }),
    update: asyncHandler(async (req, res) => {
      sendOk(res, await service.update(req.companyId!, req.params.id, req.body));
    }),
    remove: asyncHandler(async (req, res) => {
      await service.remove(req.companyId!, req.params.id);
      sendMessage(res, removedMsg);
    }),
  };
}
