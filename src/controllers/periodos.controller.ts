import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import { cambiarBloqueoMes, listarPeriodos, modelosPresentadosDelMes, type EstadoMesManual } from '../services/periodos.service';
import { deshacerCierreEjercicio, ejecutarCierreEjercicio, previsualizarCierre } from '../services/cierreEjercicio.service';
import { registrarAuditoria } from '../services/auditoria.service';
import { validarEjercicio } from '../utils/anios';

// A mano solo se bloquea o se desbloquea un mes: 'cerrado' lo pone el cierre del ejercicio.
const ESTADOS_MANUALES: EstadoMesManual[] = ['abierto', 'bloqueado'];

/**
 * Año del ejercicio de la consulta: de 1990 al año que viene, como al crear un
 * ejercicio. Leer los meses los crea si faltan: sin este limite, cualquiera con
 * permiso de lectura creaba 12 filas por cada año que pidiera (y uno enorme daba 500).
 */
const parseEjercicio = (raw: unknown): number => validarEjercicio(raw);

export const periodosController = {
  /** Los 12 meses, cada uno con los 303/111 ya presentados que lo cubren (para avisar antes de desbloquear). */
  listar: asyncHandler(async (req, res) => {
    const ejercicio = parseEjercicio(req.query.ejercicio);
    const periodos = await listarPeriodos(req.companyId!, ejercicio);
    const conModelos = await Promise.all(
      periodos.map(async (p) => ({ ...p, modelosPresentados: await modelosPresentadosDelMes(req.companyId!, ejercicio, p.mes) })),
    );
    sendOk(res, conModelos);
  }),
  cambiarEstado: asyncHandler(async (req, res) => {
    const ejercicio = parseEjercicio(req.query.ejercicio);
    const mes = Number(req.params.mes);
    if (!Number.isInteger(mes) || mes < 1 || mes > 12) throw badRequest('El mes tiene que ser un número del 1 al 12.', { campo: 'mes' });
    const estado = req.body?.estado as EstadoMesManual;
    if (!ESTADOS_MANUALES.includes(estado)) {
      throw badRequest('Aquí solo se puede bloquear o desbloquear un mes (estado "bloqueado" o "abierto"): los meses se cierran con el cierre del ejercicio.', {
        campo: 'estado',
      });
    }
    const confirmar = req.body?.confirmar === true;
    const r = await cambiarBloqueoMes(req.companyId!, ejercicio, mes, estado, { confirmar });
    await registrarAuditoria({
      userId: req.user!.userId,
      companyId: req.companyId,
      action: estado === 'bloqueado' ? 'BLOQUEAR_MES' : 'DESBLOQUEAR_MES',
      resourceType: 'PERIODO',
      resourceId: `${ejercicio}-${String(mes).padStart(2, '0')}`,
      meta: r.modelosPresentados ? { modelosPresentados: r.modelosPresentados } : undefined,
    });
    sendOk(res, r);
  }),
  cierre: asyncHandler(async (req, res) => {
    const ejercicio = parseEjercicio(req.query.ejercicio);
    try {
      const reemplazarApertura = ['1', 'true'].includes(String(req.body?.reemplazarApertura ?? req.query.reemplazarApertura ?? ''));
      const resultado = await ejecutarCierreEjercicio(req.companyId!, ejercicio, { reemplazarApertura });
      await registrarAuditoria({
        userId: req.user!.userId,
        companyId: req.companyId,
        action: 'CIERRE_EJERCICIO',
        resourceType: 'EJERCICIO',
        resourceId: String(ejercicio),
        meta: { resultadoEjercicio: resultado.resultadoEjercicio, asientos: resultado.numeros },
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
  vistaCierre: asyncHandler(async (req, res) => {
    const reemplazarApertura = ['1', 'true'].includes(String(req.query.reemplazarApertura ?? ''));
    sendOk(res, await previsualizarCierre(req.companyId!, parseEjercicio(req.query.ejercicio), { reemplazarApertura }));
  }),
  deshacerCierre: asyncHandler(async (req, res) => {
    const ejercicio = parseEjercicio(req.query.ejercicio);
    const r = await deshacerCierreEjercicio(req.companyId!, ejercicio);
    await registrarAuditoria({
      userId: req.user!.userId,
      companyId: req.companyId,
      action: 'DESHACER_CIERRE_EJERCICIO',
      resourceType: 'EJERCICIO',
      resourceId: String(ejercicio),
      meta: r,
    });
    sendOk(res, r);
  }),
};
