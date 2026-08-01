import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import { calcularCuadreBancos } from '../services/cuadreBancos.service';
import { obtenerCierreConfig, actualizarCierreConfig } from '../services/cierreConfig.service';

function parseEjercicio(raw: unknown): number {
  const e = Number(raw);
  if (!Number.isInteger(e)) throw badRequest('Parametro "ejercicio" invalido.');
  return e;
}

export const cuadreBancosController = {
  cuadre: asyncHandler(async (req, res) => {
    sendOk(res, await calcularCuadreBancos(req.companyId!, parseEjercicio(req.query.ejercicio)));
  }),

  /** Chequeo previo al cierre: indica si se puede cerrar segun el cuadre y la config. */
  chequeoCierre: asyncHandler(async (req, res) => {
    const ejercicio = parseEjercicio(req.query.ejercicio);
    const config = await obtenerCierreConfig(req.companyId!);
    const cuadre = await calcularCuadreBancos(req.companyId!, ejercicio, config.toleranciaCuadre);
    const puedeCerrar = !config.exigirCuadreBancos || cuadre.todasCuadran;
    sendOk(res, {
      puedeCerrar,
      motivo: puedeCerrar ? null : 'Hay cuentas bancarias descuadradas con la contabilidad.',
      config,
      cuadre,
    });
  }),

  getConfig: asyncHandler(async (req, res) => {
    sendOk(res, await obtenerCierreConfig(req.companyId!));
  }),

  putConfig: asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    if (body.exigirCuadreBancos !== undefined && typeof body.exigirCuadreBancos !== 'boolean') {
      throw badRequest('exigirCuadreBancos debe ser booleano.');
    }
    if (body.toleranciaCuadre !== undefined && !Number.isFinite(Number(body.toleranciaCuadre))) {
      throw badRequest('toleranciaCuadre debe ser numerico.');
    }
    sendOk(
      res,
      await actualizarCierreConfig(req.companyId!, {
        exigirCuadreBancos: body.exigirCuadreBancos,
        toleranciaCuadre: body.toleranciaCuadre !== undefined ? Number(body.toleranciaCuadre) : undefined,
      }),
    );
  }),
};
