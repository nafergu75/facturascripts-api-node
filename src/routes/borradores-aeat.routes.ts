/**
 * BORRADORES DE LOS MODELOS 349, 180 Y 202 con el diseno oficial de la AEAT
 * - /api/companies/:companyId/tax-models/...
 *
 * Cada modelo tiene:
 *  - GET  /<modelo>            borrador: las casillas y registros que lleva el fichero, errores y avisos
 *  - GET  /<modelo>/fichero    fichero para importar en la sede (ISO-8859-1); 400 si falta algo
 *  - PUT  /<modelo>/opciones   complementaria, sustitutiva, domiciliacion, base a mano...
 *  - POST /<modelo>/presentado marcarlo como presentado: se guarda lo presentado (justificante)
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
import { ejercicioDe, enviarFicheroAeat, guardarOpciones, guardarPresentacion, justificanteDe } from '../services/borradoresAeat/comun';
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

/** Complementaria o sustitutiva con el numero de la anterior (349 y 180). */
function opcionesDeclaracion(body: Record<string, unknown>, modelo: '349' | '180') {
  const out: Record<string, string | boolean | null> = {};
  if ('tipoDeclaracion' in body) {
    const t = body.tipoDeclaracion;
    if (t !== null && t !== '' && t !== 'C' && t !== 'S') throw badRequest('El tipo de declaración es C (complementaria), S (sustitutiva) o vacío.');
    out.tipoDeclaracion = t || null;
  }
  if ('declaracionAnterior' in body) {
    const n = String(body.declaracionAnterior ?? '').replace(/\D/g, '');
    if (n && !new RegExp(`^${modelo}\\d{10}$`).test(n)) throw badRequest(`El número de la declaración anterior tiene 13 cifras y empieza por ${modelo}.`);
    out.declaracionAnterior = n || null;
  }
  return out;
}

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
    const opciones: Record<string, string | boolean | null> = opcionesDeclaracion(req.body ?? {}, '349');
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
router.put(
  '/180/opciones',
  authorize('impuestos:write'),
  asyncHandler(async (req, res) => {
    const ejercicio = ejercicioDe(req.body?.ejercicio);
    await guardarOpciones(empresa(req), '180', ejercicio, '0A', opcionesDeclaracion(req.body ?? {}, '180'));
    sendOk(res, await calcularBorrador180(empresa(req), ejercicio));
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

// --- Presentados: se guarda lo que se presento (base de rectificaciones y complementarias) ---
router.post(
  '/:codigo(349|180|202)/presentado',
  authorize('impuestos:write'),
  asyncHandler(async (req, res) => {
    const companyId = empresa(req);
    const userId = (req.user as { userId?: string } | undefined)?.userId ?? 'SYSTEM';
    const ejercicio = ejercicioDe(req.body?.ejercicio);
    const justificante = justificanteDe(req.body ?? {});
    const codigo = req.params.codigo;
    const periodo = codigo === '180' ? '0A' : periodoDe(req.body?.periodo ?? (req.body?.trimestre ? `${req.body.trimestre}T` : ''));
    const b = codigo === '349' ? await calcularBorrador349(companyId, ejercicio, periodo) : codigo === '180' ? await calcularBorrador180(companyId, ejercicio) : await calcularBorrador202(companyId, ejercicio, periodo);
    if (b.errores.length) throw badRequest(`Corrige esto antes de marcarlo como presentado: ${b.errores.join(' ')}`, { errores: b.errores });
    const resumen: Record<string, number> =
      codigo === '349'
        ? { num_operadores: (b as Awaited<ReturnType<typeof calcularBorrador349>>).entrada.operadores.length }
        : codigo === '180'
          ? { num_perceptores: (b as Awaited<ReturnType<typeof calcularBorrador180>>).entrada.perceptores.length }
          : { '03': (b as Awaited<ReturnType<typeof calcularBorrador202>>).entrada.casillas['03'] ?? 0 };
    // El periodo normalizado del borrador ('05', '2T'...); el 180 es anual.
    const periodoGuardado = 'periodo' in b ? b.periodo : periodo;
    await guardarPresentacion(companyId, userId, codigo, ejercicio, periodoGuardado, b.entrada, justificante, resumen);
    sendOk(res, codigo === '349' ? await calcularBorrador349(companyId, ejercicio, periodo) : codigo === '180' ? await calcularBorrador180(companyId, ejercicio) : await calcularBorrador202(companyId, ejercicio, periodo));
  }),
);

export default router;
