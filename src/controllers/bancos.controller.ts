import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import {
  crearCuentaBancaria,
  importarMovimientosDesdeCSV,
  listarCuentasBancarias,
  listarMovimientos,
} from '../services/bancos.service';
import {
  conciliarMovimientoConFactura,
  conciliarMovimientoConCuenta,
} from '../services/conciliacionConfirmar.service';

export const bancosController = {
  listarCuentas: asyncHandler(async (req, res) => {
    sendOk(res, await listarCuentasBancarias(req.companyId!));
  }),
  crearCuenta: asyncHandler(async (req, res) => {
    const { iban, subcuentaCodigo } = req.body ?? {};
    if (!iban || !subcuentaCodigo) throw badRequest('Se requiere iban y subcuentaCodigo (572xxx).');
    const cuenta = await crearCuentaBancaria(req.companyId!, {
      iban,
      bancoNombre: req.body.bancoNombre,
      subcuentaCodigo,
      activa: req.body.activa ?? true,
    });
    sendOk(res, cuenta, undefined, 201);
  }),
  importarCsv: asyncHandler(async (req, res) => {
    const csv = typeof req.body === 'string' ? req.body : (req.body?.csv as string);
    if (!csv) throw badRequest('Envia el contenido CSV (texto) en el cuerpo o en { csv }.');
    const movs = await importarMovimientosDesdeCSV(req.companyId!, req.params.cuentaId, csv);
    sendOk(res, { importados: movs.length, movimientos: movs }, undefined, 201);
  }),
  listarMovs: asyncHandler(async (req, res) => {
    sendOk(res, await listarMovimientos(req.companyId!, req.query.cuentaId as string | undefined));
  }),

  // Patron Quipu: validar conciliacion movimiento<->factura = cobro contabilizado.
  conciliarConFactura: asyncHandler(async (req, res) => {
    const facturaId = String(req.body?.facturaId ?? '');
    if (!facturaId) throw badRequest('facturaId obligatorio.');
    sendOk(res, await conciliarMovimientoConFactura(req.companyId!, req.params.movId, facturaId), undefined, 201);
  }),

  // Patron Quipu: conciliar movimiento sin documento contra cuenta (555 por defecto).
  conciliarConCuenta: asyncHandler(async (req, res) => {
    const subcuenta = req.body?.subcuenta ? String(req.body.subcuenta) : undefined;
    const concepto = req.body?.concepto ? String(req.body.concepto) : undefined;
    sendOk(res, await conciliarMovimientoConCuenta(req.companyId!, req.params.movId, subcuenta, concepto), undefined, 201);
  }),
};
