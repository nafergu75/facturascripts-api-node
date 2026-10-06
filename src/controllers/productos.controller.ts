import { asyncHandler } from '../utils/async-handler';
import {
  actualizarFamilia,
  borrarFamilia,
  crearFamilia,
  importarProductos,
  listarFamilias,
  productosService,
  siguienteCodigo,
} from '../services/productos.service';
import { sendMessage, sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';

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
    sendMessage(res, 'Producto eliminado (o dado de baja si ya se había facturado).');
  }),

  listarFamilias: asyncHandler(async (req, res) => {
    sendOk(res, await listarFamilias(req.companyId!));
  }),
  crearFamilia: asyncHandler(async (req, res) => {
    sendOk(res, await crearFamilia(req.companyId!, req.body ?? {}), undefined, 201);
  }),
  actualizarFamilia: asyncHandler(async (req, res) => {
    sendOk(res, await actualizarFamilia(req.companyId!, req.params.familiaId, req.body ?? {}));
  }),
  borrarFamilia: asyncHandler(async (req, res) => {
    await borrarFamilia(req.companyId!, req.params.familiaId);
    sendMessage(res, 'Familia borrada.');
  }),
  siguienteCodigo: asyncHandler(async (req, res) => {
    sendOk(res, { codigo: await siguienteCodigo(req.companyId!, req.query.familiaId ? String(req.query.familiaId) : undefined) });
  }),
  importar: asyncHandler(async (req, res) => {
    const archivo = (req as unknown as { file?: { buffer: Buffer; originalname: string } }).file;
    if (!archivo) throw badRequest('Adjunta el catálogo en el campo "archivo".');
    const vistaPrevia = ['1', 'true', 'si'].includes(String(req.query.vistaPrevia ?? ''));
    sendOk(res, await importarProductos(req.companyId!, archivo.buffer, archivo.originalname, vistaPrevia), undefined, vistaPrevia ? 200 : 201);
  }),
};
