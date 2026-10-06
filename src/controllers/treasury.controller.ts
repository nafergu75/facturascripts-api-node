import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { treasuryService } from '../services/treasury.service';

export const treasuryController = {
  resumen: asyncHandler(async (req, res) => {
    sendOk(res, await treasuryService.obtenerResumen(req.companyId!));
  }),

  listarCuentas: asyncHandler(async (req, res) => {
    sendOk(res, await treasuryService.listarCuentasBancarias(req.companyId!));
  }),

  crearCuenta: asyncHandler(async (req, res) => {
    sendOk(res, await treasuryService.crearCuentaBancaria(req.companyId!, req.body ?? {}), undefined, 201);
  }),

  listarMovimientos: asyncHandler(async (req, res) => {
    const estado = req.query.estado ? String(req.query.estado) : undefined;
    sendOk(res, await treasuryService.listarMovimientos(req.companyId!, req.params.accountId, estado));
  }),

  subirExtracto: asyncHandler(async (req, res) => {
    sendOk(res, await treasuryService.subirExtracto(req.companyId!, req.params.accountId, req.body?.contenidoCSV), undefined, 201);
  }),

  conciliar: asyncHandler(async (req, res) => {
    const { tipoOrigen, origenId } = req.body ?? {};
    sendOk(res, await treasuryService.conciliarMovimiento(req.companyId!, req.params.movementId, tipoOrigen, origenId), undefined, 201);
  }),
};
