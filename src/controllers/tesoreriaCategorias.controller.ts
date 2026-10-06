import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import * as servicio from '../services/tesoreriaCategorias.service';

/** Rutas bajo /companies/:companyId/treasury (companyScope pone req.companyId). */
export const tesoreriaCategoriasController = {
  listarCategorias: asyncHandler(async (req, res) => {
    sendOk(res, await servicio.listarCategorias(req.companyId!));
  }),

  crearCategoria: asyncHandler(async (req, res) => {
    sendOk(res, await servicio.crearCategoria(req.companyId!, req.body ?? {}), undefined, 201);
  }),

  actualizarCategoria: asyncHandler(async (req, res) => {
    sendOk(res, await servicio.actualizarCategoria(req.companyId!, req.params.categoriaId, req.body ?? {}));
  }),

  borrarCategoria: asyncHandler(async (req, res) => {
    sendOk(res, await servicio.borrarCategoria(req.companyId!, req.params.categoriaId));
  }),

  listarMovimientos: asyncHandler(async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    sendOk(
      res,
      await servicio.listarMovimientosTesoreria(req.companyId!, {
        tipo: q.tipo === 'cobros' || q.tipo === 'pagos' ? q.tipo : undefined,
        cuentaId: q.cuentaId,
        desde: q.desde,
        hasta: q.hasta,
        categoriaId: q.categoriaId,
        estado: q.estado === 'sin-categoria' || q.estado === 'categorizados' || q.estado === 'ignorados' ? q.estado : undefined,
        q: q.q,
        pagina: q.pagina ? Number(q.pagina) : undefined,
      }),
    );
  }),

  categorizar: asyncHandler(async (req, res) => {
    sendOk(res, await servicio.categorizarMovimiento(req.companyId!, req.params.movementId, req.body ?? {}));
  }),

  aplicarASimilares: asyncHandler(async (req, res) => {
    const recordar = (req.body ?? {}).recordar !== false;
    sendOk(res, await servicio.aplicarASimilares(req.companyId!, req.params.movementId, recordar));
  }),

  ignorar: asyncHandler(async (req, res) => {
    sendOk(res, await servicio.ignorarMovimiento(req.companyId!, req.params.movementId, (req.body ?? {}).ignorado !== false));
  }),

  desglosar: asyncHandler(async (req, res) => {
    sendOk(res, await servicio.desglosarMovimiento(req.companyId!, req.params.movementId, (req.body ?? {}).partes));
  }),

  deshacerDesglose: asyncHandler(async (req, res) => {
    sendOk(res, await servicio.deshacerDesglose(req.companyId!, req.params.movementId));
  }),
};
