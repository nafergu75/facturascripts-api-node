import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { forbidden, notFound, notImplemented } from '../utils/http-errors';
import { listarEmpresasUsuario, obtenerEmpresa } from '../services/companies.service';

export const companiesController = {
  // GET /companies -> empresas del usuario autenticado
  list: asyncHandler(async (req, res) => {
    let empresas = await listarEmpresasUsuario(req.user!.userId);

    // Si no hay empresas en BD, intentar obtener desde token (dev mode)
    if (!empresas || empresas.length === 0) {
      const companyIds = req.user!.companies ?? [];
      if (companyIds.length > 0) {
        empresas = [];
        for (const id of companyIds) {
          const empresa = await obtenerEmpresa(id);
          if (empresa) {
            // Mapear a EmpresaUsuario con role default 'user'
            empresas.push({
              id: empresa.id,
              name: empresa.name,
              isActive: empresa.isActive,
              role: 'user', // role por defecto para fallback de token
            });
          }
        }
      }
    }

    sendOk(res, empresas || []);
  }),
  // GET /companies/:id -> datos de una empresa a la que el usuario tiene acceso
  getById: asyncHandler(async (req, res) => {
    if (!(req.user!.companies ?? []).includes(req.params.id)) {
      throw forbidden('No tienes acceso a esta empresa.');
    }
    const empresa = await obtenerEmpresa(req.params.id);
    if (!empresa) throw notFound('Empresa no encontrada.');
    sendOk(res, empresa);
  }),
  // Alta/baja/edicion de empresas: aprovisionamiento (TODO, fuera de alcance actual)
  create: asyncHandler(async () => {
    throw notImplemented('Alta de empresas: pendiente (aprovisionamiento de instancia FS + cifrado de API Key).');
  }),
  update: asyncHandler(async () => {
    throw notImplemented('Edicion de empresas: pendiente.');
  }),
  remove: asyncHandler(async () => {
    throw notImplemented('Baja de empresas: pendiente.');
  }),
};
