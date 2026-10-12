/**
 * BORRADORES DE LOS MODELOS 349, 180 Y 202 con el diseno oficial de la AEAT
 * - /api/companies/:companyId/tax-models/...
 *
 * Cada modelo tiene:
 *  - GET  /<modelo>            borrador: las casillas y registros que lleva el fichero, errores y avisos
 *  - GET  /<modelo>/fichero    fichero para importar en la sede (ISO-8859-1); 400 si falta algo;
 *                              409 si una informativa aun no tiene numero (lo pone POST .../declaraciones/numero)
 *  - PUT  /<modelo>/opciones   cambio de periodicidad (349), domiciliacion y base a mano (202),
 *                              forma de pago (111 y 115)
 * Los GET calculan y no guardan nada (B6). Presentar, complementarias y
 * sustitutivas: declaraciones-aeat.routes (comun a todos los modelos).
 * Y los datos que piden por factura:
 *  - /180/inmuebles (GET, POST, PUT /:id) inmuebles alquilados de cada proveedor
 *  - PUT /180/facturas/:invoiceId/inmueble   inmueble de una factura de alquiler
 *  - PUT /349/compras/:invoiceId/clave       clave A o I de una compra a la UE
 */
import { Router, type Request } from 'express';
import { authorize } from '../middleware/authorize.middleware';
import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import { calcularBorrador349, ficheroModelo349 } from '../services/borradoresAeat/borrador349.service';
import { calcularBorrador180, ficheroModelo180 } from '../services/borradoresAeat/borrador180.service';
import { calcularBorrador202, ficheroModelo202, opcionesEntrada202 } from '../services/borradoresAeat/borrador202.service';
import { ejercicioDe, enviarFicheroAeat, guardarOpciones } from '../services/borradoresAeat/comun';
import { ficheroRetenciones, periodoRetenciones, taxModelsService } from '../services/tax-models.service';
import {
  actualizarInmueble,
  asignarClave349Compra,
  asignarInmuebleAFactura,
  crearInmueble,
  listarInmuebles,
} from '../services/borradoresAeat/inmuebles.service';

const router = Router({ mergeParams: true });
const empresa = (req: Request) => req.companyId!;
const periodoDe = (raw: unknown) => {
  const p = String(raw ?? '').trim().toUpperCase();
  if (!p) throw badRequest('Indica el periodo.');
  return p;
};

// --- 349 ---
router.get(
  '/349',
  authorize('impuestos:read'),
  asyncHandler(async (req, res) => sendOk(res, await calcularBorrador349(empresa(req), ejercicioDe(req.query.ejercicio), periodoDe(req.query.periodo)))),
);
router.get(
  '/349/fichero',
  authorize('impuestos:read'),
  asyncHandler(async (req, res) => {
    const { nombre, contenido } = await ficheroModelo349(empresa(req), ejercicioDe(req.query.ejercicio), periodoDe(req.query.periodo));
    enviarFicheroAeat(res, nombre, contenido);
  }),
);
router.put(
  '/349/opciones',
  authorize('impuestos:write'),
  asyncHandler(async (req, res) => {
    const ejercicio = ejercicioDe(req.body?.ejercicio);
    const periodo = periodoDe(req.body?.periodo);
    const opciones: Record<string, string | boolean | null> = {};
    if ('tipoDeclaracion' in (req.body ?? {}) || 'declaracionAnterior' in (req.body ?? {})) {
      throw badRequest('La complementaria o sustitutiva del 349 se prepara desde su historial de declaraciones, después de marcar la anterior como presentada.');
    }
    if ('cambioPeriodicidad' in (req.body ?? {})) {
      if (typeof req.body.cambioPeriodicidad !== 'boolean') throw badRequest('"cambioPeriodicidad" tiene que ser sí o no.');
      opciones.cambioPeriodicidad = req.body.cambioPeriodicidad || null;
    }
    await guardarOpciones(empresa(req), '349', ejercicio, periodo, opciones);
    sendOk(res, await calcularBorrador349(empresa(req), ejercicio, periodo));
  }),
);
router.put(
  '/349/compras/:invoiceId/clave',
  authorize('compras:write', 'impuestos:write'),
  asyncHandler(async (req, res) => sendOk(res, await asignarClave349Compra(empresa(req), req.params.invoiceId, req.body?.clave ?? null))),
);

// --- 180 ---
router.get(
  '/180',
  authorize('impuestos:read'),
  asyncHandler(async (req, res) => sendOk(res, await calcularBorrador180(empresa(req), ejercicioDe(req.query.ejercicio)))),
);
router.get(
  '/180/fichero',
  authorize('impuestos:read'),
  asyncHandler(async (req, res) => {
    const { nombre, contenido } = await ficheroModelo180(empresa(req), ejercicioDe(req.query.ejercicio));
    enviarFicheroAeat(res, nombre, contenido);
  }),
);
router.get(
  '/180/inmuebles',
  authorize('impuestos:read', 'compras:read'),
  asyncHandler(async (req, res) => sendOk(res, await listarInmuebles(empresa(req), req.query.supplierId ? String(req.query.supplierId) : undefined))),
);
router.post(
  '/180/inmuebles',
  authorize('compras:write', 'impuestos:write'),
  asyncHandler(async (req, res) => {
    sendOk(res, await crearInmueble(empresa(req), req.body ?? {}), undefined, 201);
  }),
);
router.put(
  '/180/inmuebles/:id',
  authorize('compras:write', 'impuestos:write'),
  asyncHandler(async (req, res) => sendOk(res, await actualizarInmueble(empresa(req), req.params.id, req.body ?? {}))),
);
router.put(
  '/180/facturas/:invoiceId/inmueble',
  authorize('compras:write', 'impuestos:write'),
  asyncHandler(async (req, res) => sendOk(res, await asignarInmuebleAFactura(empresa(req), req.params.invoiceId, req.body?.inmuebleArrendadoId ?? null))),
);

// --- 202 ---
router.get(
  '/202',
  authorize('impuestos:read'),
  asyncHandler(async (req, res) => sendOk(res, await calcularBorrador202(empresa(req), ejercicioDe(req.query.ejercicio), periodoDe(req.query.periodo)))),
);
router.get(
  '/202/fichero',
  authorize('impuestos:read'),
  asyncHandler(async (req, res) => {
    const { nombre, contenido } = await ficheroModelo202(empresa(req), ejercicioDe(req.query.ejercicio), periodoDe(req.query.periodo));
    enviarFicheroAeat(res, nombre, contenido);
  }),
);
router.put(
  '/202/opciones',
  authorize('impuestos:write'),
  asyncHandler(async (req, res) => {
    const ejercicio = ejercicioDe(req.body?.ejercicio);
    const periodo = periodoDe(req.body?.periodo);
    if (!['1P', '2P', '3P'].includes(periodo)) throw badRequest('El 202 tiene tres periodos: 1P, 2P y 3P.');
    await guardarOpciones(empresa(req), '202', ejercicio, periodo, opcionesEntrada202(req.body ?? {}));
    sendOk(res, await calcularBorrador202(empresa(req), ejercicio, periodo));
  }),
);

// --- 111 y 115: fichero (solo lee) ---
router.get(
  '/:codigo(111|115)/fichero',
  authorize('impuestos:read'),
  asyncHandler(async (req, res) => {
    const { nombre, contenido } = await ficheroRetenciones(empresa(req), req.params.codigo as '111' | '115', ejercicioDe(req.query.ejercicio), String(req.query.periodo ?? ''));
    enviarFicheroAeat(res, nombre, contenido);
  }),
);

// --- 111 y 115: forma de pago (la complementaria la pone el historial de declaraciones) ---
router.put(
  '/:codigo(111|115)/opciones',
  authorize('impuestos:write'),
  asyncHandler(async (req, res) => {
    const codigo = req.params.codigo as '111' | '115';
    const ejercicio = ejercicioDe(req.body?.ejercicio);
    const periodo = periodoRetenciones(String(req.body?.periodo ?? ''));
    const forma = req.body?.formaPago === null || req.body?.formaPago === '' ? null : String(req.body?.formaPago ?? '').toUpperCase();
    if (forma !== null && !['I', 'U', 'G'].includes(forma)) throw badRequest('La forma de pago es I (ingreso), U (domiciliación) o G (cuenta corriente tributaria).');
    await guardarOpciones(empresa(req), codigo, ejercicio, periodo, { forma_pago: forma });
    sendOk(res, codigo === '111' ? await taxModelsService.generarModelo111(empresa(req), ejercicio, periodo) : await taxModelsService.generarModelo115(empresa(req), ejercicio, periodo));
  }),
);

export default router;
