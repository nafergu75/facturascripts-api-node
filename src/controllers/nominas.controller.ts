import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import { importarResumenNominas, listarResumenesNominas } from '../services/nominas.service';

export const nominasController = {
  importar: asyncHandler(async (req, res) => {
    const { mes, ejercicio, totalBruto } = req.body ?? {};
    if (!Number.isInteger(mes) || mes < 1 || mes > 12 || !Number.isInteger(ejercicio) || typeof totalBruto !== 'number') {
      throw badRequest('Se requiere mes (1..12), ejercicio y totalBruto.');
    }
    const resumen = await importarResumenNominas(req.companyId!, {
      companyId: req.companyId!,
      mes,
      ejercicio,
      totalBruto,
      totalSeguridadSocialEmpresa: req.body.totalSeguridadSocialEmpresa ?? 0,
      totalSeguridadSocialTrabajador: req.body.totalSeguridadSocialTrabajador ?? 0,
      totalIRPF: req.body.totalIRPF ?? 0,
      totalLiquido: req.body.totalLiquido ?? 0,
    });
    sendOk(res, resumen, undefined, 201);
  }),
  listar: asyncHandler(async (req, res) => {
    const ejercicio = Number(req.query.ejercicio);
    if (!Number.isInteger(ejercicio)) throw badRequest('Parametro "ejercicio" invalido.');
    sendOk(res, await listarResumenesNominas(req.companyId!, ejercicio));
  }),
};
