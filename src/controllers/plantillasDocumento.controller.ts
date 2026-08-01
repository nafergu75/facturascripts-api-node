import { asyncHandler } from '../utils/async-handler';
import { sendMessage, sendOk } from '../utils/response';
import { badRequest, notFound } from '../utils/http-errors';
import { TipoDocumento, TIPOS_DOCUMENTO } from '../domain/plantillas-documento.model';
import {
  actualizarPlantilla,
  crearPlantilla,
  eliminarPlantilla,
  listarPlantillasPorEmpresaYTipo,
  obtenerPlantilla,
  obtenerPlantillaPredeterminada,
} from '../services/plantillasDocumento.service';
import { registrarAuditoria } from '../services/auditoria.service';

function validarTipo(tipo: unknown): TipoDocumento {
  if (!TIPOS_DOCUMENTO.includes(tipo as TipoDocumento)) {
    throw badRequest(`tipoDocumento invalido (use ${TIPOS_DOCUMENTO.join(', ')}).`);
  }
  return tipo as TipoDocumento;
}

export const plantillasController = {
  list: asyncHandler(async (req, res) => {
    const tipo = req.query.tipo ? validarTipo(req.query.tipo) : undefined;
    sendOk(res, await listarPlantillasPorEmpresaYTipo(req.companyId!, tipo));
  }),
  getById: asyncHandler(async (req, res) => {
    const p = await obtenerPlantilla(req.companyId!, req.params.plantillaId);
    if (!p) throw notFound('Plantilla no encontrada.');
    sendOk(res, p);
  }),
  predeterminada: asyncHandler(async (req, res) => {
    const tipo = validarTipo(req.params.tipoDocumento);
    const p = await obtenerPlantillaPredeterminada(req.companyId!, tipo);
    if (!p) throw notFound('No hay plantilla predeterminada para ese tipo.');
    sendOk(res, p);
  }),
  create: asyncHandler(async (req, res) => {
    validarTipo(req.body?.tipoDocumento);
    const p = await crearPlantilla(req.companyId!, req.body);
    await registrarAuditoria({ userId: req.user!.userId, companyId: req.companyId, action: 'CREATE_PLANTILLA', resourceType: 'PLANTILLA', resourceId: p.id });
    sendOk(res, p, undefined, 201);
  }),
  update: asyncHandler(async (req, res) => {
    if (req.body?.tipoDocumento) validarTipo(req.body.tipoDocumento);
    const p = await actualizarPlantilla(req.companyId!, req.params.plantillaId, req.body);
    if (!p) throw notFound('Plantilla no encontrada.');
    sendOk(res, p);
  }),
  remove: asyncHandler(async (req, res) => {
    const ok = await eliminarPlantilla(req.companyId!, req.params.plantillaId);
    if (!ok) throw notFound('Plantilla no encontrada.');
    sendMessage(res, 'Plantilla eliminada');
  }),
};
