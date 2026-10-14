import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import { listarSeriesConUso, crearSerie, actualizarSerie, contextoPlantillas } from '../services/series.service';
import { TIPOS_DOCUMENTO_SERIE as TIPOS, esTipoDocumentoSerie } from '../domain/series.model';
import { catalogoPlantillas } from '../domain/plantillasFactura';

const tipoNoValido = () => badRequest(`Tipo de documento no válido. Usa: ${TIPOS.join(', ')}.`, { campo: 'tipoDocumento' });

export const seriesController = {
  listar: asyncHandler(async (req, res) => {
    const tipo = req.query.tipoDocumento;
    if (tipo !== undefined && !esTipoDocumentoSerie(tipo)) throw tipoNoValido();
    sendOk(res, await listarSeriesConUso(req.companyId!, tipo));
  }),

  /** Catalogo de plantillas de factura de venta (la A y la B, solo en empresas espanolas; en seriesAutomaticas, las series A, B o C que usan cada una sin elegirla). */
  plantillas: asyncHandler(async (req, res) => {
    sendOk(res, catalogoPlantillas(await contextoPlantillas(req.companyId!)));
  }),

  crear: asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    if (!b.codigo) throw badRequest('El código de la serie es obligatorio.', { campo: 'codigo' });
    if (!esTipoDocumentoSerie(b.tipoDocumento)) throw tipoNoValido();
    const serie = await crearSerie(req.companyId!, {
      codigo: String(b.codigo),
      descripcion: b.descripcion ?? '',
      tipoDocumento: b.tipoDocumento,
      activa: b.activa ?? true,
      porDefecto: b.porDefecto ?? false,
      numeroInicial: b.numeroInicial,
      plantilla: b.plantilla,
      observacionesDefecto: b.observacionesDefecto,
    });
    sendOk(res, serie, undefined, 201);
  }),

  actualizar: asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    // Solo lo que se puede cambiar: el codigo y el tipo no; el numero inicial, solo sin documentos.
    // La plantilla vale para lo que se cree o se guarde despues (las emitidas conservan la suya).
    sendOk(
      res,
      await actualizarSerie(req.companyId!, req.params.id, {
        descripcion: b.descripcion,
        activa: b.activa,
        porDefecto: b.porDefecto,
        numeroInicial: b.numeroInicial,
        plantilla: b.plantilla,
        observacionesDefecto: b.observacionesDefecto,
      }),
    );
  }),
};
