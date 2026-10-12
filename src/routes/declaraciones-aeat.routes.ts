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
 * nominas:write (su fichero lleva los datos de la plantilla). En el 190, la
 * lista de perceptores (GET) solo sale con nominas:read, y elegirlos (PUT
 * .../registros) pide nominas:write.
 */
import { Router, type Request } from 'express';
import { authorize } from '../middleware/authorize.middleware';
import { autorizado } from '../services/rbac.service';
import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import { ejercicioDe } from '../services/borradoresAeat/comun';
import {
  asignarNumero,
  cancelarRectificacion,
  configModelo,
  historialDeclaraciones,
  justificanteDe,
  periodoDeclaracion,
  type CodigoAeat,
} from '../services/declaracionesAeat/declaraciones.service';
import { guardarRegistrosModelo, historialConRegistros, prepararRectificacionModelo, presentarDeclaracion } from '../services/declaracionesAeat/presentar';
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

/**
 * Lista de perceptores del 190 (nombre, percepción íntegra y clave interna de
 * cada trabajador o profesional): son datos de la plantilla y solo los ve
 * quien tiene permiso de Nóminas, igual que /nominas/190/:ejercicio/perceptores.
 * A quien entra solo con impuestos:read se le quita la lista y se le dice por qué.
 */
const AVISO_REGISTROS_NOMINAS = 'La lista de perceptores del 190 es de Nóminas: pide al administrador permiso de Nóminas para verla y elegirlos.';
function conRegistrosPermitidos<T extends { registros: unknown; enCurso?: { registros?: unknown } | null }>(req: Request, codigo: CodigoAeat, h: T): T {
  if (codigo !== '190' || autorizado(req.user!, req.companyId, ['nominas:read'])) return h;
  const oculto = h.registros !== null || !!h.enCurso?.registros;
  return {
    ...h,
    registros: null,
    ...(h.enCurso ? { enCurso: { ...h.enCurso, registros: null } } : {}),
    ...(oculto ? { avisoRegistros: AVISO_REGISTROS_NOMINAS } : {}),
  };
}

// --- Lectura ---
const historial = asyncHandler(async (req, res) => {
  const d = await declaracionDe(req, req.query as Record<string, unknown>);
  sendOk(res, conRegistrosPermitidos(req, d.codigo, await historialConRegistros(d.companyId, d.codigo, d.ejercicio, d.periodo)));
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
  await guardarRegistrosModelo(d.companyId, d.codigo, d.ejercicio, d.periodo, cuerpo(req).registros);
  sendOk(res, conRegistrosPermitidos(req, d.codigo, await historialConRegistros(d.companyId, d.codigo, d.ejercicio, d.periodo)));
});
router.put('/:codigo(347|349|180)/declaraciones/rectificacion/registros', authorize('impuestos:write'), registros);
// Elegir perceptores es tocar datos de la plantilla: solo con nominas:write.
router.put('/:codigo(190)/declaraciones/rectificacion/registros', authorize('nominas:write'), registros);

const cancelar = asyncHandler(async (req, res) => {
  const d = await declaracionDe(req, req.query as Record<string, unknown>);
  await cancelarRectificacion(d.companyId, usuario(req), d.codigo, d.ejercicio, d.periodo);
  sendOk(res, await historialDeclaraciones(d.companyId, d.codigo, d.ejercicio, d.periodo));
});
router.delete('/:codigo(303|111|115|202|390|200|347|349|180)/declaraciones/rectificacion', authorize('impuestos:write'), cancelar);
router.delete('/:codigo(190)/declaraciones/rectificacion', authorize('impuestos:write', 'nominas:write'), cancelar);

/**
 * POST /:codigo/presentado { ejercicio, periodo (o trimestre), justificante: { numero, fecha }, opciones? }
 * `opciones`: lo elegido en la pantalla que no se guarda, para presentar lo
 * mismo que se ve (303: tipo de declaración, cuotas a compensar y cuenta; 390:
 * último periodo; 200: bases negativas, pagos fraccionados y retenciones).
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
