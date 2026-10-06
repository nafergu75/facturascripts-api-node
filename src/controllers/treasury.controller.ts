import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { treasuryService } from '../services/treasury.service';
import { importarExtractoArchivo } from '../services/bancos.service';
import { badRequest } from '../utils/http-errors';

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

  subirExtractoArchivo: asyncHandler(async (req, res) => {
    const archivo = (req as unknown as { file?: { buffer: Buffer; originalname: string } }).file;
    if (!archivo) throw badRequest('Adjunta el extracto en el campo "archivo".');
    const vistaPrevia = ['1', 'true', 'si'].includes(String(req.query.vistaPrevia ?? ''));
    const r = await importarExtractoArchivo(req.companyId!, req.params.accountId, archivo.buffer, archivo.originalname, { vistaPrevia });
    sendOk(res, r, undefined, vistaPrevia ? 200 : 201);
  }),

  conciliar: asyncHandler(async (req, res) => {
    const { tipoOrigen, origenId } = req.body ?? {};
    sendOk(res, await treasuryService.conciliarMovimiento(req.companyId!, req.params.movementId, tipoOrigen, origenId), undefined, 201);
  }),
};
