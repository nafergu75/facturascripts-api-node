import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import {
  sugerirSubcuentaParaFamiliaProducto,
  sugerirSubcuentaParaTercero,
} from '../services/sugerenciasContables.service';

export const sugerenciasController = {
  subcuentaTercero: asyncHandler(async (req, res) => {
    const { tipo, nombre, nif } = req.body ?? {};
    if (!['cliente', 'proveedor'].includes(tipo) || !nombre || !nif) {
      throw badRequest('Se requiere tipo (cliente|proveedor), nombre y nif.');
    }
    sendOk(res, await sugerirSubcuentaParaTercero(req.companyId!, req.body));
  }),
  subcuentaFamilia: asyncHandler(async (req, res) => {
    const { codigo, nombre, tipo } = req.body ?? {};
    if (!codigo || !nombre || !['mercaderia', 'servicio', 'otro'].includes(tipo)) {
      throw badRequest('Se requiere codigo, nombre y tipo (mercaderia|servicio|otro).');
    }
    sendOk(res, await sugerirSubcuentaParaFamiliaProducto(req.companyId!, req.body));
  }),
};
