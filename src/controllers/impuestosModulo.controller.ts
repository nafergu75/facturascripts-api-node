import { Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import {
  listarModelosImpuesto,
  omitirModelo,
  recuperarModeloOmitido,
  marcarModeloListoParaPresentar,
  marcarModeloNoPresentado,
  obtenerDetalleModelo,
  autorrellenarModelo,
  guardarModeloManual,
  generarTxtModelo,
  generarPdfModelo,
  exportarIngresosGastosExcel,
  calcularCasillasModelo,
  filaPorId,
  hayHistorialDeclaraciones,
  marcarEjercicioPresentadoFueraApp,
  marcarPresentadoFueraApp,
  ORIGEN_FUERA_APP,
} from '../services/impuestosModulo.service';
import { anularUltimaPresentacion, justificanteDe, MODELOS_AEAT, type CodigoAeat } from '../services/declaracionesAeat/declaraciones.service';
import { presentarDeclaracion } from '../services/declaracionesAeat/presentar';
import { fichaModelo } from '../services/impuestosTextos';
import { generarPdfSimple } from '../utils/pdf-simple';
import { registrarAuditoria } from '../services/auditoria.service';
import { validarEjercicio } from '../utils/anios';

/** Ejercicio de la consulta: de 1990 al año que viene (hora de España). */
const parseEjercicio = (raw: unknown): number => validarEjercicio(raw);

function enviarTxt(res: Response, nombre: string, contenido: string): void {
  res.setHeader('Content-Type', 'text/plain; charset=ISO-8859-1');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  res.status(200).send(Buffer.from(contenido, 'latin1'));
}

export const impuestosModuloController = {
  /** Lista del calendario: ?ejercicio=2026&tab=activos|omitidos|presentados */
  listar: asyncHandler(async (req, res) => {
    const ejercicio = parseEjercicio(req.query.ejercicio);
    const tab = String(req.query.tab ?? 'activos') as 'activos' | 'omitidos' | 'presentados';
    if (!['activos', 'omitidos', 'presentados'].includes(tab)) throw badRequest('tab invalida (activos|omitidos|presentados).');
    sendOk(res, await listarModelosImpuesto(req.companyId!, ejercicio, tab));
  }),

  detalle: asyncHandler(async (req, res) => {
    sendOk(res, await obtenerDetalleModelo(req.companyId!, req.params.modeloId));
  }),

  /** "Recalcular importes": autorrellena desde contabilidad y GUARDA (pisa lo manual). */
  recalcular: asyncHandler(async (req, res) => {
    sendOk(res, await autorrellenarModelo(req.companyId!, req.params.modeloId));
  }),

  /** "Guardar": conserva ediciones manuales (no recalcula totales dependientes). */
  guardar: asyncHandler(async (req, res) => {
    const casillas = req.body?.casillas ?? req.body;
    if (!casillas || typeof casillas !== 'object' || Array.isArray(casillas)) {
      throw badRequest('Envia { casillas: { "01": 123.45, ... } } con los cambios manuales.');
    }
    sendOk(res, await guardarModeloManual(req.companyId!, req.params.modeloId, casillas));
  }),

  omitir: asyncHandler(async (req, res) => {
    sendOk(res, await omitirModelo(req.companyId!, req.params.modeloId));
  }),
  recuperar: asyncHandler(async (req, res) => {
    sendOk(res, await recuperarModeloOmitido(req.companyId!, req.params.modeloId));
  }),
  /**
   * Marcar como presentado: los modelos con historial (303, 111, 115, 202, 390,
   * 200, 347, 349, 180 y 190) pasan por el mismo camino que su pantalla y
   * congelan lo presentado (B4); el justificante es opcional aquí.
   */
  listoParaPresentar: asyncHandler(async (req, res) => {
    const f = await filaPorId(req.companyId!, req.params.modeloId);
    if (hayHistorialDeclaraciones() && f.codigo in MODELOS_AEAT) {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const justificante = body.justificante ? justificanteDe(body) : null;
      sendOk(res, await presentarDeclaracion(req.companyId!, req.user!.userId, f.codigo as CodigoAeat, f.ejercicio, f.periodo, justificante));
      return;
    }
    const r = await marcarModeloListoParaPresentar(req.companyId!, req.params.modeloId);
    await registrarAuditoria({
      userId: req.user!.userId,
      companyId: req.companyId,
      action: 'MODELO_LISTO_PRESENTAR',
      resourceType: 'MODELO_IMPUESTO',
      resourceId: req.params.modeloId,
      meta: { codigo: r.codigo, periodo: r.periodoEtiqueta },
    });
    sendOk(res, r);
  }),
  /**
   * «No presentado»: con historial, la última presentada queda anulada (se
   * marcó por error). Lo marcado como presentado fuera de la app no tiene
   * historial: vuelve a pendiente.
   */
  noPresentado: asyncHandler(async (req, res) => {
    const f = await filaPorId(req.companyId!, req.params.modeloId);
    if (f.origen === ORIGEN_FUERA_APP) {
      const r = await marcarModeloNoPresentado(req.companyId!, req.params.modeloId);
      await registrarAuditoria({
        userId: req.user!.userId,
        companyId: req.companyId,
        action: 'MODELO_NO_PRESENTADO_FUERA_APP',
        resourceType: 'MODELO_IMPUESTO',
        resourceId: r.id,
        meta: { codigo: r.codigo, periodo: r.periodoEtiqueta },
      });
      sendOk(res, r);
      return;
    }
    if (hayHistorialDeclaraciones() && f.codigo in MODELOS_AEAT && f.estado === 'presentado') {
      await anularUltimaPresentacion(req.companyId!, req.user!.userId, f.codigo, f.ejercicio, f.periodo);
      sendOk(res, await obtenerDetalleModelo(req.companyId!, f.id));
      return;
    }
    sendOk(res, await marcarModeloNoPresentado(req.companyId!, req.params.modeloId));
  }),

  /** POST /modelos/:modeloId/presentado-fuera-app: lo presentó otro (gestoría, sede); deja de estar pendiente. */
  presentadoFueraApp: asyncHandler(async (req, res) => {
    const r = await marcarPresentadoFueraApp(req.companyId!, req.params.modeloId);
    await registrarAuditoria({
      userId: req.user!.userId,
      companyId: req.companyId,
      action: 'MODELO_PRESENTADO_FUERA_APP',
      resourceType: 'MODELO_IMPUESTO',
      resourceId: r.id,
      meta: { codigo: r.codigo, periodo: r.periodoEtiqueta },
    });
    sendOk(res, r);
  }),

  /** POST /ejercicios/:ejercicio/presentado-fuera-app: todo lo ya terminado del ejercicio, presentado fuera de la app. */
  ejercicioPresentadoFueraApp: asyncHandler(async (req, res) => {
    const ejercicio = validarEjercicio(req.params.ejercicio, { hasta: 'actual' });
    const r = await marcarEjercicioPresentadoFueraApp(req.companyId!, ejercicio);
    await registrarAuditoria({
      userId: req.user!.userId,
      companyId: req.companyId,
      action: 'EJERCICIO_PRESENTADO_FUERA_APP',
      resourceType: 'MODELO_IMPUESTO',
      resourceId: String(ejercicio),
      meta: { ejercicio, modelos: r.marcados.map((m) => `${m.codigo} ${m.periodoEtiqueta}`) },
    });
    sendOk(res, r);
  }),

  txt: asyncHandler(async (req, res) => {
    const { nombre, contenido } = await generarTxtModelo(req.companyId!, req.params.modeloId);
    enviarTxt(res, nombre, contenido);
  }),

  pdf: asyncHandler(async (req, res) => {
    const { nombre, contenido } = await generarPdfModelo(req.companyId!, req.params.modeloId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
    res.status(200).send(contenido);
  }),

  /**
   * GET /impuestos/calculate?model_type=303|111&year=2026&period=1T
   * Devuelve el JSON de CASILLAS OFICIALES calculadas desde las facturas de
   * ingresos/gastos del periodo (303: filas [01]-[09] por tipo de IVA, [27],
   * [28]/[29], [45]/[46]/[71]; 111: trabajo [01]-[03] + profesionales [07]-[09]).
   * El taxpayer es la propia empresa (companyId): su NIF viaja en config.
   */
  calculate: asyncHandler(async (req, res) => {
    const modelType = String(req.query.model_type ?? req.query.modelo ?? '');
    const year = parseEjercicio(req.query.year ?? req.query.ejercicio);
    const period = String(req.query.period ?? req.query.periodo ?? '0A').toUpperCase().replace('Q', '').replace(/^([1-4])$/, '$1T');
    if (!/^\d{3}$/.test(modelType)) throw badRequest('model_type invalido (303, 111, 347, 349, 390, 115, 200).');
    if (!/^([1-4]T|0A)$/.test(period)) throw badRequest('period invalido (1T..4T o 0A).');
    const { casillas } = await calcularCasillasModelo(req.companyId!, modelType, year, period);
    sendOk(res, { model_type: modelType, year, period, casillas });
  }),

  /**
   * POST /impuestos/generate-pdf  body: { modelo, ejercicio?, periodo?, casillas }
   * Genera un PDF con las casillas RECIBIDAS (p.ej. tras edicion manual en el
   * front), sin tocar el borrador guardado. TODO: volcado sobre la plantilla
   * PDF oficial AEAT con pdf-lib cuando se aporte el formulario base (la AEAT
   * no publica AcroForm rellenable del 303 actual; la presentacion real es por
   * fichero TXT, ya soportado).
   */
  generatePdf: asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const modelo = String(b.modelo ?? b.model_type ?? '');
    const casillas = b.casillas;
    if (!/^\d{3}$/.test(modelo)) throw badRequest('modelo obligatorio (ej. "303").');
    if (!casillas || typeof casillas !== 'object' || Array.isArray(casillas)) {
      throw badRequest('Envia { modelo, casillas: { "01": 1000, ... } }.');
    }
    const titulo = fichaModelo(modelo).titulo;
    const sub = [b.ejercicio, b.periodo].filter(Boolean).join(' ');
    const lineas: string[] = [titulo, sub ? `Periodo: ${sub}` : '', ''.padEnd(90, '-')];
    for (const [k, v] of Object.entries(casillas as Record<string, unknown>)) {
      const valor = typeof v === 'number' ? v.toFixed(2) : String(v ?? '');
      lineas.push(`${k.padEnd(40, '.')} ${valor}`);
    }
    lineas.push(''.padEnd(90, '-'), 'Copia informativa generada por la API (no valida para presentacion).');
    const pdf = generarPdfSimple(`Modelo ${modelo}${sub ? ' - ' + sub : ''}`, lineas.filter((l) => l !== ''));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${modelo}${sub ? '_' + sub.replace(/\s+/g, '_') : ''}.pdf"`);
    res.status(200).send(pdf);
  }),

  /** Excel de ingresos/gastos del periodo (flujo de validacion del video). */
  excelIngresosGastos: asyncHandler(async (req, res) => {
    const ejercicio = parseEjercicio(req.query.ejercicio);
    const periodo = req.query.periodo ? String(req.query.periodo) : undefined;
    const buffer = await exportarIngresosGastosExcel(req.companyId!, { ejercicio, periodo });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="ingresos_gastos_${ejercicio}${periodo ? '_' + periodo : ''}.xlsx"`);
    res.status(200).send(buffer);
  }),
};
