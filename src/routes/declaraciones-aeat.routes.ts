/**
 * HISTORIAL DE DECLARACIONES DE LOS MODELOS DE LA AEAT (B4 y B5)
 * - /api/companies/:companyId/tax-models/:codigo/...
 *
 * Igual para el 303, 111, 115, 202, 390, 200, 347, 349, 180 y 190:
 *  - GET    /:codigo/declaraciones?ejercicio&periodo         historial, declaración en curso y (complementaria de una informativa) registros
 *  - POST   /:codigo/declaraciones/numero                     número identificativo de la declaración en curso (347, 349, 180, 190)
 *  - POST   /:codigo/declaraciones/rectificacion              prepara una complementaria (C) o sustitutiva (S) de la presentada
 *  - PUT    /:codigo/declaraciones/rectificacion/registros    registros elegidos para la complementaria de una informativa
 *  - DELETE /:codigo/declaraciones/rectificacion              cancela la complementaria o sustitutiva en curso
 *  - POST   /:codigo/presentado                               marca como presentada la declaración en curso (congela su instantánea)
 *
 * El GET solo lee. Lo demás pide impuestos:write; en el 190 basta también con
 * nominas:write (su fichero lleva los datos de la plantilla).
 */
import { Router, type Request } from 'express';
import { authorize } from '../middleware/authorize.middleware';
import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import { ejercicioDe } from '../services/borradoresAeat/comun';
import {
  asignarNumero,
  cancelarRectificacion,
  configModelo,
  guardarRegistros,
  historialDeclaraciones,
  justificanteDe,
  periodoDeclaracion,
  type CodigoAeat,
} from '../services/declaracionesAeat/declaraciones.service';
import { historialConRegistros, prepararRectificacionModelo, presentarDeclaracion } from '../services/declaracionesAeat/presentar';
import { esEmpresaEspanolaFiscal, MENSAJE_SIN_MODELOS } from '../services/impuestosCalculo.service';

const router = Router({ mergeParams: true });

const usuario = (req: Request) => (req.user as { userId?: string } | undefined)?.userId ?? 'SYSTEM';

/** Modelo, ejercicio y periodo de la petición (cuerpo o query). 400 si no valen. */
async function declaracionDe(req: Request, fuente: Record<string, unknown>): Promise<{ companyId: string; codigo: CodigoAeat; ejercicio: number; periodo: string }> {
  const codigo = configModelo(String(req.params.codigo)).codigo;
  const companyId = req.companyId!;
  if (!(await esEmpresaEspanolaFiscal(companyId))) throw badRequest(MENSAJE_SIN_MODELOS);
  const ejercicio = ejercicioDe(fuente.ejercicio);
  // `trimestre` (1-4): lo que mandaba la pantalla antigua del 303, 111 y 115.
  const periodo = periodoDeclaracion(codigo, fuente.periodo ?? (fuente.trimestre ? `${fuente.trimestre}T` : undefined));
  return { companyId, codigo, ejercicio, periodo };
}

const cuerpo = (req: Request) => (req.body ?? {}) as Record<string, unknown>;

// --- Lectura ---
const historial = asyncHandler(async (req, res) => {
  const d = await declaracionDe(req, req.query as Record<string, unknown>);
  sendOk(res, await historialConRegistros(d.companyId, d.codigo, d.ejercicio, d.periodo));
});
router.get('/:codigo(303|111|115|202|390|200|347|349|180)/declaraciones', authorize('impuestos:read'), historial);
router.get('/:codigo(190)/declaraciones', authorize('impuestos:read', 'nominas:read'), historial);

// --- Escritura ---
const numero = asyncHandler(async (req, res) => {
  const d = await declaracionDe(req, cuerpo(req));
  await asignarNumero(d.companyId, usuario(req), d.codigo, d.ejercicio, d.periodo);
  sendOk(res, await historialDeclaraciones(d.companyId, d.codigo, d.ejercicio, d.periodo));
});
router.post('/:codigo(347|349|180)/declaraciones/numero', authorize('impuestos:write'), numero);
router.post('/:codigo(190)/declaraciones/numero', authorize('impuestos:write', 'nominas:write'), numero);

const rectificacion = asyncHandler(async (req, res) => {
  const d = await declaracionDe(req, cuerpo(req));
  sendOk(res, await prepararRectificacionModelo(d.companyId, usuario(req), d.codigo, d.ejercicio, d.periodo, cuerpo(req)), undefined, 201);
});
router.post('/:codigo(303|111|115|202|390|200|347|349|180)/declaraciones/rectificacion', authorize('impuestos:write'), rectificacion);
router.post('/:codigo(190)/declaraciones/rectificacion', authorize('impuestos:write', 'nominas:write'), rectificacion);

const registros = asyncHandler(async (req, res) => {
  const d = await declaracionDe(req, cuerpo(req));
  await guardarRegistros(d.companyId, d.codigo, d.ejercicio, d.periodo, cuerpo(req).registros);
  sendOk(res, await historialConRegistros(d.companyId, d.codigo, d.ejercicio, d.periodo));
});
router.put('/:codigo(347|349|180)/declaraciones/rectificacion/registros', authorize('impuestos:write'), registros);
router.put('/:codigo(190)/declaraciones/rectificacion/registros', authorize('impuestos:write', 'nominas:write'), registros);

const cancelar = asyncHandler(async (req, res) => {
  const d = await declaracionDe(req, req.query as Record<string, unknown>);
  await cancelarRectificacion(d.companyId, usuario(req), d.codigo, d.ejercicio, d.periodo);
  sendOk(res, await historialDeclaraciones(d.companyId, d.codigo, d.ejercicio, d.periodo));
});
router.delete('/:codigo(303|111|115|202|390|200|347|349|180)/declaraciones/rectificacion', authorize('impuestos:write'), cancelar);
router.delete('/:codigo(190)/declaraciones/rectificacion', authorize('impuestos:write', 'nominas:write'), cancelar);

/**
 * POST /:codigo/presentado { ejercicio, periodo (o trimestre), justificante: { numero, fecha }, opciones? }
 * `opciones` solo en el 303: el tipo de declaración, las cuotas a compensar y
 * la cuenta bancaria elegidos en la pantalla (lo que se presenta).
 */
const presentado = asyncHandler(async (req, res) => {
  const d = await declaracionDe(req, cuerpo(req));
  const opciones = (cuerpo(req).opciones ?? {}) as Record<string, unknown>;
  sendOk(res, await presentarDeclaracion(d.companyId, usuario(req), d.codigo, d.ejercicio, d.periodo, justificanteDe(cuerpo(req)), opciones), {
    message: `Modelo ${d.codigo} marcado como presentado`,
  });
});
router.post('/:codigo(303|111|115|202|390|200|347|349|180)/presentado', authorize('impuestos:write'), presentado);
router.post('/:codigo(190)/presentado', authorize('impuestos:write', 'nominas:write'), presentado);

export default router;
