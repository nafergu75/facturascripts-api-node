import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import { cambiarEstadoPeriodo, listarPeriodos } from '../services/periodos.service';
import { ejecutarCierreEjercicio } from '../services/cierreEjercicio.service';
import { EstadoPeriodo } from '../domain/periodos.model';
import { registrarAuditoria } from '../services/auditoria.service';

const ESTADOS: EstadoPeriodo[] = ['abierto', 'bloqueado', 'cerrado'];

function parseEjercicio(raw: unknown): number {
  const e = Number(raw);
  if (!Number.isInteger(e)) throw badRequest('Parametro "ejercicio" invalido.');
  return e;
}

export const periodosController = {
  listar: asyncHandler(async (req, res) => {
    sendOk(res, await listarPeriodos(req.companyId!, parseEjercicio(req.query.ejercicio)));
  }),
  cambiarEstado: asyncHandler(async (req, res) => {
    const ejercicio = parseEjercicio(req.query.ejercicio);
    const mes = Number(req.params.mes);
    if (!Number.isInteger(mes) || mes < 1 || mes > 12) throw badRequest('Mes invalido (1..12).');
    const estado = req.body?.estado as EstadoPeriodo;
    if (!ESTADOS.includes(estado)) throw badRequest(`estado invalido (${ESTADOS.join(', ')}).`);
    sendOk(res, await cambiarEstadoPeriodo(req.companyId!, ejercicio, mes, estado));
  }),
  cierre: asyncHandler(async (req, res) => {
    const ejercicio = parseEjercicio(req.query.ejercicio);
    try {
      const resultado = await ejecutarCierreEjercicio(req.companyId!, ejercicio);
      await registrarAuditoria({
        userId: req.user!.userId,
        companyId: req.companyId,
        action: 'CIERRE_EJERCICIO',
        resourceType: 'EJERCICIO',
        resourceId: String(ejercicio),
        meta: { resultadoEjercicio: resultado.resultadoEjercicio },
      });
      sendOk(res, resultado);
    } catch (err) {
      // Auditar intento de cierre bloqueado/fallido (cuadre de bancos, periodos, etc.)
      await registrarAuditoria({
        userId: req.user!.userId,
        companyId: req.companyId,
        action: 'CIERRE_EJERCICIO_BLOQUEADO',
        resourceType: 'EJERCICIO',
        resourceId: String(ejercicio),
        meta: { motivo: err instanceof Error ? err.message : 'desconocido' },
      });
      throw err;
    }
  }),
};
