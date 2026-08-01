import { asyncHandler } from '../utils/async-handler';
import { usersService } from '../services/users.service';
import { sendMessage, sendOk } from '../utils/response';

export const usersController = {
  list: asyncHandler(async (req, res) => {
    const data = await usersService.list(req.query as Record<string, unknown>);
    sendOk(res, data);
  }),
  getById: asyncHandler(async (req, res) => {
    const data = await usersService.getById(req.params.id);
    sendOk(res, data);
  }),
  create: asyncHandler(async (req, res) => {
    const data = await usersService.create(req.body);
    sendOk(res, data, undefined, 201);
  }),
  update: asyncHandler(async (req, res) => {
    const data = await usersService.update(req.params.id, req.body);
    sendOk(res, data);
  }),
  remove: asyncHandler(async (req, res) => {
    await usersService.remove(req.params.id);
    sendMessage(res, 'Usuario eliminado');
  }),
};
