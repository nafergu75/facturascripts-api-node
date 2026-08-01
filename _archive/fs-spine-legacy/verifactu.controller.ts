import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { listarHuellasFactura, registrarHuellaFactura } from '../services/verifactu.service';
import { getFsClientForCompany } from '../services/facturascripts-client';

export const verifactuController = {
  // GET /companies/:companyId/facturas/:id/huellas
  listar: asyncHandler(async (req, res) => {
    sendOk(res, await listarHuellasFactura(req.companyId!, req.params.id));
  }),
  // POST /companies/:companyId/facturas/:id/huellas -> genera y registra la huella actual
  registrar: asyncHandler(async (req, res) => {
    const fs = await getFsClientForCompany(req.companyId!);
    const factura = (await fs.getOne('facturaclientes', req.params.id)) as Record<string, unknown>;
    const huella = await registrarHuellaFactura(req.companyId!, factura);
    sendOk(res, huella, undefined, 201);
  }),
};
