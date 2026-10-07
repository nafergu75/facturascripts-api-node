import { NextFunction, Request, Response, Router } from 'express';
import { prisma } from '../config/database';
import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { notFound } from '../utils/http-errors';
import { hoyEspana } from '../utils/fechas';
import { esVencida, textoEstadoGasto, textoEstadoPago } from '../domain/factura-gasto.model';
import { proveedoresService, buscarProveedores } from '../services/proveedores.service';
import { authorize } from '../middleware/authorize.middleware';
import * as contactos from '../services/suppliers/supplierContact.service';
import * as cuentas from '../services/suppliers/supplierBankAccount.service';
import * as auditoria from '../services/suppliers/supplierAudit.service';
import { exportSupplierData, getSafeFileName } from '../services/suppliers/supplierExport.service';

const router = Router({ mergeParams: true });
const empresa = (req: Request) => String(req.companyId ?? req.params.companyId);

// Lecturas: Compras o Contabilidad (el admin, todo). Escrituras: compras:write.
// Listado con busqueda en el servidor (q), activo y paginacion (page, limit).
router.get('/', authorize('compras:read', 'contabilidad:read'), asyncHandler(async (req, res) => {
  sendOk(res, await proveedoresService.list(empresa(req), req.query as Record<string, unknown>));
}));
// Buscador (antes de /:id) para seleccionar proveedor al registrar gastos (?activos=true: solo los activos).
router.get(
  '/buscar',
  authorize('compras:read', 'contabilidad:read'),
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '');
    const limit = Math.min(Math.max(1, Number(req.query.limit ?? 20) || 20), 100);
    sendOk(res, await buscarProveedores(empresa(req), q, limit, req.query.activos === 'true'));
  }),
);
// Por NIF (el lector y el alta): antes de /:id.
router.get('/por-nif/:nif', authorize('compras:read', 'contabilidad:read'), asyncHandler(async (req, res) => {
  sendOk(res, await proveedoresService.porNif(empresa(req), req.params.nif));
}));
router.get('/:id', authorize('compras:read', 'contabilidad:read'), asyncHandler(async (req, res) => {
  sendOk(res, await proveedoresService.getById(empresa(req), req.params.id));
}));
router.post('/', authorize('compras:write'), asyncHandler(async (req, res) => {
  sendOk(res, await proveedoresService.create(empresa(req), req.body ?? {}, req.user?.email), undefined, 201);
}));
// PUT y PATCH: modificacion parcial (solo los campos que llegan). La pestana "Datos" de la ficha guarda con PATCH.
router.put('/:id', authorize('compras:write'), asyncHandler(async (req, res) => {
  sendOk(res, await proveedoresService.update(empresa(req), req.params.id, req.body ?? {}, req.user?.email));
}));
router.patch('/:id', authorize('compras:write'), asyncHandler(async (req, res) => {
  sendOk(res, await proveedoresService.update(empresa(req), req.params.id, req.body ?? {}, req.user?.email));
}));
router.delete('/:id', authorize('compras:write'), asyncHandler(async (req, res) => {
  await proveedoresService.remove(empresa(req), req.params.id, req.user?.email);
  sendOk(res, { message: 'Proveedor eliminado' });
}));

// ---------------------------------------------------------------------------
// Ficha del proveedor: contactos, cuentas bancarias, historial, facturas, export.
// ---------------------------------------------------------------------------

type ProveedorFicha = { id: string; companyId: string; nombreFiscal?: string; nifCif?: string };

/**
 * Los servicios de la ficha reciben solo el supplierId. Este paso comprueba
 * antes que el proveedor es de la empresa de la ruta: sin el, se podian leer o
 * cambiar los contactos y las cuentas bancarias de otra empresa con su id.
 */
const proveedorDeLaEmpresa = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  const companyId = req.companyId ?? req.params.companyId;
  const proveedor = (await prisma.supplier.findUnique({ where: { id: String(req.params.supplierId) } })) as ProveedorFicha | null;
  if (!proveedor || String(proveedor.companyId) !== String(companyId)) throw notFound('Proveedor no encontrado.');
  res.locals.proveedor = proveedor;
  next();
});

const email = (req: Request) => req.user?.email;

// Contactos
router.get('/:supplierId/contacts', authorize('compras:read', 'contabilidad:read'), proveedorDeLaEmpresa, asyncHandler(async (req, res) => {
  sendOk(res, await contactos.listContactsBySupplier(req.params.supplierId));
}));
router.post('/:supplierId/contacts', authorize('compras:write'), proveedorDeLaEmpresa, asyncHandler(async (req, res) => {
  const contacto = await contactos.createContact(req.params.supplierId, req.body ?? {});
  await auditoria.logContactChange(req.params.supplierId, 'create', contacto.nombre, email(req));
  sendOk(res, contacto, undefined, 201);
}));
router.put('/:supplierId/contacts/:contactId', authorize('compras:write'), proveedorDeLaEmpresa, asyncHandler(async (req, res) => {
  const contacto = await contactos.updateContact(req.params.supplierId, req.params.contactId, req.body ?? {});
  await auditoria.logContactChange(req.params.supplierId, 'update', contacto.nombre, email(req));
  sendOk(res, contacto);
}));
router.delete('/:supplierId/contacts/:contactId', authorize('compras:write'), proveedorDeLaEmpresa, asyncHandler(async (req, res) => {
  const contacto = await contactos.getContact(req.params.supplierId, req.params.contactId);
  await contactos.deleteContact(req.params.supplierId, req.params.contactId);
  await auditoria.logContactChange(req.params.supplierId, 'delete', contacto.nombre, email(req));
  sendOk(res, { message: 'Contacto eliminado' });
}));

// Cuentas bancarias
router.get('/:supplierId/bank-accounts', authorize('compras:read', 'contabilidad:read'), proveedorDeLaEmpresa, asyncHandler(async (req, res) => {
  sendOk(res, await cuentas.listBankAccountsBySupplier(req.params.supplierId));
}));
router.post('/:supplierId/bank-accounts', authorize('compras:write'), proveedorDeLaEmpresa, asyncHandler(async (req, res) => {
  const cuenta = await cuentas.createBankAccount(req.params.supplierId, req.body ?? {});
  await auditoria.logBankAccountChange(req.params.supplierId, 'create', cuenta.iban, email(req));
  sendOk(res, cuenta, undefined, 201);
}));
router.put('/:supplierId/bank-accounts/:accountId', authorize('compras:write'), proveedorDeLaEmpresa, asyncHandler(async (req, res) => {
  const cuenta = await cuentas.updateBankAccount(req.params.supplierId, req.params.accountId, req.body ?? {});
  await auditoria.logBankAccountChange(req.params.supplierId, 'update', cuenta.iban, email(req));
  sendOk(res, cuenta);
}));
router.put('/:supplierId/bank-accounts/:accountId/set-principal', authorize('compras:write'), proveedorDeLaEmpresa, asyncHandler(async (req, res) => {
  const cuenta = await cuentas.setBankAccountPrincipal(req.params.supplierId, req.params.accountId);
  await auditoria.logBankAccountChange(req.params.supplierId, 'update', cuenta.iban, email(req));
  sendOk(res, cuenta);
}));
router.delete('/:supplierId/bank-accounts/:accountId', authorize('compras:write'), proveedorDeLaEmpresa, asyncHandler(async (req, res) => {
  const cuenta = await cuentas.getBankAccount(req.params.supplierId, req.params.accountId);
  await cuentas.deleteBankAccount(req.params.supplierId, req.params.accountId);
  await auditoria.logBankAccountChange(req.params.supplierId, 'delete', cuenta.iban, email(req));
  sendOk(res, { message: 'Cuenta bancaria eliminada' });
}));

// Historial de cambios (?tipoAccion=create|update|delete para filtrar)
router.get('/:supplierId/audit-trail', authorize('compras:read', 'contabilidad:read'), proveedorDeLaEmpresa, asyncHandler(async (req, res) => {
  const tipo = String(req.query.tipoAccion ?? '');
  const entradas =
    tipo === 'create' || tipo === 'update' || tipo === 'delete'
      ? await auditoria.listByAction(req.params.supplierId, tipo)
      : await auditoria.listBySupplier(req.params.supplierId);
  sendOk(res, entradas);
}));

/** Lo pagado por factura (pagos activos). Sin la tabla (tests con prisma simulado), nada. */
async function pagadoPorFactura(companyId: string, ids: string[]): Promise<Map<string, number>> {
  const tabla = (prisma as unknown as { invoicePayment?: { groupBy?: unknown } }).invoicePayment;
  if (!ids.length || typeof tabla?.groupBy !== 'function') return new Map();
  const filas = await prisma.invoicePayment.groupBy({
    by: ['invoiceId'],
    where: { companyId, invoiceType: 'GASTO', estado: 'ACTIVO', invoiceId: { in: ids } },
    _sum: { importe: true },
  });
  return new Map(filas.map((r) => [r.invoiceId, Number(r._sum.importe ?? 0)]));
}

// Facturas de gasto del proveedor, con su estado, su pago y lo pendiente
router.get('/:supplierId/invoices', authorize('compras:read', 'contabilidad:read'), proveedorDeLaEmpresa, asyncHandler(async (req, res) => {
  const companyId = String(req.companyId ?? req.params.companyId);
  const facturas = await prisma.expenseInvoice.findMany({
    where: { companyId, supplierId: req.params.supplierId },
    orderBy: { fechaEmision: 'desc' },
    select: {
      id: true,
      numeroCompleto: true,
      numeroFacturaProveedor: true,
      fechaEmision: true,
      fechaVencimiento: true,
      baseTotal: true,
      ivaTotal: true,
      totalFactura: true,
      estado: true,
      estadoPago: true,
      tipoGasto: true,
    },
  });
  const pagado = await pagadoPorFactura(companyId, facturas.map((f) => f.id));
  const hoy = hoyEspana();
  sendOk(
    res,
    facturas.map((f) => {
      const vencida = !!f.fechaVencimiento && !!f.estadoPago && esVencida(f as { estado: string; estadoPago: string; fechaVencimiento: string }, hoy);
      const total = Number(f.totalFactura ?? 0);
      return {
        ...f,
        estadoTexto: textoEstadoGasto(String(f.estado ?? '')),
        estadoPagoTexto: textoEstadoPago(String(f.estadoPago ?? 'PENDIENTE'), vencida),
        vencida,
        importePendiente: f.estado === 'ANULADA' ? 0 : Math.round((total - (pagado.get(f.id) ?? 0)) * 100) / 100,
      };
    }),
  );
}));

// Exportacion (CSV o JSON) como descarga
router.get('/:supplierId/export', authorize('compras:read', 'contabilidad:read'), proveedorDeLaEmpresa, asyncHandler(async (req, res) => {
  const formato = req.query.formato === 'json' ? 'json' : 'csv';
  const si = (v: unknown) => v === 'true';
  const contenido = await exportSupplierData(String(req.companyId ?? req.params.companyId), req.params.supplierId, {
    formato,
    fechaDesde: req.query.fechaDesde ? String(req.query.fechaDesde) : undefined,
    fechaHasta: req.query.fechaHasta ? String(req.query.fechaHasta) : undefined,
    incluirFacturas: si(req.query.incluirFacturas),
    incluirContactos: si(req.query.incluirContactos),
    incluirCuentasBancarias: si(req.query.incluirCuentasBancarias),
  });
  const p = res.locals.proveedor as ProveedorFicha;
  res.setHeader('Content-Type', formato === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${getSafeFileName(p.nombreFiscal ?? 'proveedor', p.nifCif ?? '', formato)}"`);
  res.send(contenido);
}));

export default router;
