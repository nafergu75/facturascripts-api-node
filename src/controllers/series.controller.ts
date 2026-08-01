import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import { listarSeries, crearSerie, actualizarSerie } from '../services/series.service';
import { SerieDocumento } from '../domain/series.model';

const TIPOS: SerieDocumento['tipoDocumento'][] = ['FACTURA', 'PEDIDO', 'ALBARAN', 'PRESUPUESTO'];

export const seriesController = {
  listar: asyncHandler(async (req, res) => {
    const tipo = req.query.tipoDocumento as SerieDocumento['tipoDocumento'] | undefined;
    if (tipo && !TIPOS.includes(tipo)) throw badRequest(`tipoDocumento invalido (${TIPOS.join(', ')}).`);
    sendOk(res, await listarSeries(req.companyId!, tipo));
  }),

  crear: asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.codigo) throw badRequest('codigo obligatorio.');
    if (!TIPOS.includes(b.tipoDocumento)) throw badRequest(`tipoDocumento invalido (${TIPOS.join(', ')}).`);
    const serie = await crearSerie(req.companyId!, {
      codigo: String(b.codigo),
      descripcion: b.descripcion ?? '',
      tipoDocumento: b.tipoDocumento,
      activa: b.activa ?? true,
      porDefecto: b.porDefecto ?? false,
    });
    sendOk(res, serie, undefined, 201);
  }),

  actualizar: asyncHandler(async (req, res) => {
    sendOk(res, await actualizarSerie(req.companyId!, req.params.id, req.body ?? {}));
  }),
};
