import { asyncHandler } from '../utils/async-handler';
import { facturasService, crearFacturaIngreso, crearFacturaRectificativa } from '../services/facturas.service';
import { registrarCobro, registrarCobroVencimiento } from '../services/cobros.service';
import { listarVencimientos } from '../services/vencimientos.service';
import { registrarAuditoria } from '../services/auditoria.service';
import { sendOk, sendMessage } from '../utils/response';
import { badRequest, notImplemented } from '../utils/http-errors';

export const facturasController = {
  // POST /facturas/ingreso — flujo "Crear ingreso": cliente (existente o nuevo) +
  // serie + fechas + lineas (base/dto/IVA/retencion). Crea factura+lineas+totales
  // en FacturaScripts y el vencimiento. Estado inicial PENDING.
  crearIngreso: asyncHandler(async (req, res) => {
    const resp = await crearFacturaIngreso(req.companyId!, req.body ?? {});
    await registrarAuditoria({ userId: req.user!.userId, companyId: req.companyId, action: 'CREAR_FACTURA_INGRESO', resourceType: 'FACTURA', resourceId: resp.id, meta: { numeroCompleto: resp.numeroCompleto, total: resp.totalFactura } });
    sendOk(res, { invoice: resp }, undefined, 201);
  }),

  // PATCH /facturas/:id/estado — { estado: 'PAID', fechaCobro?, metodoCobro? }.
  // PAID liquida el pendiente generando el asiento de tesoreria (via unica).
  cambiarEstado: asyncHandler(async (req, res) => {
    const estado = String(req.body?.estado ?? '').toUpperCase();
    if (estado !== 'PAID') throw badRequest('Solo se admite estado=PAID (cobro). PENDING/OVERDUE se derivan de la fecha de vencimiento.');
    const factura = (await facturasService.getById(req.companyId!, req.params.id)) as Record<string, unknown>;
    const pendiente = Number(factura.importePendiente ?? factura.total ?? 0);
    if (pendiente <= 0) throw badRequest('La factura ya esta cobrada.');
    const fecha = String(req.body?.fechaCobro ?? new Date().toISOString().slice(0, 10));
    const r = await registrarCobro(req.companyId!, req.params.id, pendiente, fecha, req.body?.metodoCobro ? String(req.body.metodoCobro) : undefined);
    sendOk(res, { estado: 'PAID', cobro: r, importeCobrado: pendiente }, undefined, 200);
  }),

  // POST /facturas/:id/rectificativa — abono enlazado a la original (idfacturarect).
  rectificativa: asyncHandler(async (req, res) => {
    const resp = await crearFacturaRectificativa(req.companyId!, req.params.id, req.body?.lineas);
    await registrarAuditoria({ userId: req.user!.userId, companyId: req.companyId, action: 'FACTURA_RECTIFICATIVA', resourceType: 'FACTURA', resourceId: resp.id, meta: { original: req.params.id } });
    sendOk(res, { invoice: resp }, undefined, 201);
  }),

  // POST /facturas/:id/send-email — TODO: integrar SMTP + render PDF de la plantilla.
  enviarEmail: asyncHandler(async (req) => {
    void req;
    throw notImplemented('Envio por email pendiente: requiere configurar SMTP y el render del PDF (plantilla). El endpoint y el wiring estan listos.');
  }),

  // POST /facturas/:id/recurrente — TODO: persistir config de recurrencia + job
  // que genere las facturas (mensual/trimestral). Estructura lista.
  hacerRecurrente: asyncHandler(async (req) => {
    void req;
    throw notImplemented('Facturas periodicas pendientes: falta persistir la recurrencia y el job de generacion. Estructura lista.');
  }),
  // Cobro directo de factura. VIA UNICA (Critica 1): crea vencimiento ad-hoc y
  // lo liquida -> SIEMPRE genera el asiento de tesoreria (572 <-> 430).
  registrarCobro: asyncHandler(async (req, res) => {
    const importe = Number(req.body?.importe);
    if (!Number.isFinite(importe) || importe <= 0) throw badRequest('importe de cobro invalido.');
    const fecha = String(req.body?.fecha ?? new Date().toISOString().slice(0, 10));
    const formaPago = req.body?.formaPago ? String(req.body.formaPago) : undefined;
    sendOk(res, await registrarCobro(req.companyId!, req.params.id, importe, fecha, formaPago), undefined, 201);
  }),

  // Hallazgo 2 — vencimientos de una factura.
  listarVencimientos: asyncHandler(async (req, res) => {
    sendOk(res, await listarVencimientos(req.companyId!, { facturaId: req.params.id }));
  }),

  // Dashboard — vencimientos de TODA la empresa. ?estado=pendiente|liquidado&tipo=cobro|pago
  listarVencimientosEmpresa: asyncHandler(async (req, res) => {
    const estado = req.query.estado as 'pendiente' | 'liquidado' | undefined;
    if (estado && !['pendiente', 'liquidado'].includes(estado)) throw badRequest('estado invalido (pendiente|liquidado).');
    let lista = await listarVencimientos(req.companyId!, estado ? { estado } : {});
    const tipo = req.query.tipo ? String(req.query.tipo) : undefined;
    if (tipo) lista = lista.filter((v) => v.tipo === tipo);
    sendOk(res, lista);
  }),

  // Hallazgo 2 — liquidar un vencimiento (genera asiento de tesoreria 572<->430/400).
  liquidarVencimiento: asyncHandler(async (req, res) => {
    const fecha = String(req.body?.fecha ?? new Date().toISOString().slice(0, 10));
    const formaPago = req.body?.formaPago ? String(req.body.formaPago) : undefined;
    sendOk(res, await registrarCobroVencimiento(req.companyId!, req.params.vencimientoId, fecha, formaPago), undefined, 201);
  }),
  list: asyncHandler(async (req, res) => {
    const data = await facturasService.list(req.companyId!, req.query as Record<string, unknown>);
    sendOk(res, data);
  }),
  getById: asyncHandler(async (req, res) => {
    const data = await facturasService.getById(req.companyId!, req.params.id);
    sendOk(res, data);
  }),
  create: asyncHandler(async (req, res) => {
    const data = await facturasService.create(req.companyId!, req.body);
    sendOk(res, data, undefined, 201);
  }),
  update: asyncHandler(async (req, res) => {
    const data = await facturasService.update(req.companyId!, req.params.id, req.body);
    sendOk(res, data);
  }),
  remove: asyncHandler(async (req, res) => {
    await facturasService.remove(req.companyId!, req.params.id);
    sendMessage(res, 'Factura eliminada');
  }),
};
