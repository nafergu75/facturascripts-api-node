/**
 * Nominas conectadas con tesoreria, impuestos y archivo: pagos de liquidos,
 * seguros sociales, 111 (retenciones y su pago), 190 por perceptor, PDF de la
 * gestoria, coste de personal y prevision de pagos. Rutas en nominas.routes.ts
 * (todas con nominas:read o nominas:write).
 */
import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import { registrarAuditoria } from '../services/auditoria.service';
import { calcularModelo111, esEmpresaEspanolaFiscal, MENSAJE_SIN_MODELOS } from '../services/impuestosCalculo.service';
import {
  anularPago111Schema,
  anularPagoSchema,
  anularPagoSegurosSocialesSchema,
  ejercicio as esquemaEjercicio,
  mes as esquemaMes,
  pago111Schema,
  pagoNominasSchema,
  pagoSegurosSocialesSchema,
  parsear,
  segurosSocialesSchema,
} from '../services/nominas/esquemas';
import { anularPagoModelo111, anularPagoNominas, importePago111, pagarModelo111, pagarNominas, pagoModelo111 } from '../services/nominas/tesoreria';
import {
  anularPagoSegurosSociales,
  guardarSegurosSociales,
  listarSegurosSociales,
  obtenerSegurosSociales,
  pagarSegurosSociales,
} from '../services/nominas/segurosSociales';
import { calcularModelo190, periodoFiscal, presenta111Mensual, retencionesTrabajo } from '../services/nominas/fiscal';
import { comprobarDiseno190, errorNifPerceptor190, idRegistro190, informe190Excel, resumen190 } from '../services/nominas/modelo190';
import { ficheroModelo190 } from '../services/nominas/fichero190';
import { contextoDeclaracion, datosDe, incluyeRegistro } from '../services/declaracionesAeat/declaraciones.service';
import {
  anularDocumentoNominas,
  descargarDocumentoNominas,
  listarDocumentosNominas,
  subirDocumentoNominas,
  zipDocumentosNominas,
  type FicheroSubido,
} from '../services/nominas/documentos';
import { cargosParaPago, informeCoste, informeCosteExcel, previsionPagos, sugerenciasMovimiento } from '../services/nominas/informes';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function entero(v: unknown, esquema: typeof esquemaEjercicio | typeof esquemaMes, nombre: string): number {
  const r = esquema.safeParse(Number(v));
  if (!r.success) throw badRequest(`Parámetro "${nombre}" no válido.`);
  return r.data;
}
const enteroOpcional = (v: unknown, esquema: typeof esquemaEjercicio | typeof esquemaMes, nombre: string) =>
  v === undefined || v === null || v === '' ? undefined : entero(v, esquema, nombre);
const ejercicioDe = (req: Request) => entero(req.params.ejercicio ?? req.query.ejercicio, esquemaEjercicio, 'ejercicio');
const mesDe = (req: Request) => entero(req.params.mes, esquemaMes, 'mes');
const periodo111De = (req: Request) => periodoFiscal(ejercicioDe(req), String(req.params.periodo ?? ''));
const texto = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : String(v));
const quiereExcel = (req: Request) => String(req.query.formato ?? '').toLowerCase() === 'xlsx';

function descargar(res: Response, nombre: string, tipo: string, contenido: Buffer): void {
  res.setHeader('Content-Type', tipo);
  res.setHeader('Content-Disposition', `attachment; filename="${nombre.replace(/"/g, '')}"`);
  res.send(contenido);
}

function auditar(req: Request, action: string, resourceId: string, meta?: Record<string, unknown>) {
  return registrarAuditoria({ userId: req.user!.userId, companyId: req.companyId, action, resourceType: 'NOMINA', resourceId, meta });
}

export const nominasConexionesController = {
  // --- Pago de los liquidos ---

  /** POST /periodos/:ejercicio/:mes/pago — 465 de cada trabajador contra 572/570 (o un cargo del extracto). */
  pagar: asyncHandler(async (req, res) => {
    const ejercicio = ejercicioDe(req);
    const mes = mesDe(req);
    const r = await pagarNominas(req.companyId!, ejercicio, mes, parsear(pagoNominasSchema, req.body));
    await auditar(req, 'PAGAR_NOMINAS', `${ejercicio}-${String(mes).padStart(2, '0')}`, { asiento: r.asiento.numero, importe: r.importe, nominas: r.pagadas, movimientoId: r.movimientoId });
    sendOk(res, r, undefined, 201);
  }),

  /** POST /periodos/:ejercicio/:mes/pago/anular — el pago se anula entero (REVERSED o contraasiento). */
  anularPago: asyncHandler(async (req, res) => {
    const ejercicio = ejercicioDe(req);
    const mes = mesDe(req);
    const d = parsear(anularPagoSchema, req.body);
    const r = await anularPagoNominas(req.companyId!, ejercicio, mes, d);
    await auditar(req, 'ANULAR_PAGO_NOMINAS', `${ejercicio}-${String(mes).padStart(2, '0')}`, {
      motivo: d.motivo ?? null,
      nominas: r.nominas,
      revertidos: r.asientosRevertidos,
      contraasientos: r.contraasientos.map((c) => c.numero),
    });
    sendOk(res, r);
  }),

  // --- Seguros sociales ---

  listarSegurosSociales: asyncHandler(async (req, res) => {
    sendOk(res, await listarSegurosSociales(req.companyId!, entero(req.query.ejercicio, esquemaEjercicio, 'ejercicio')));
  }),

  obtenerSegurosSociales: asyncHandler(async (req, res) => {
    sendOk(res, await obtenerSegurosSociales(req.companyId!, ejercicioDe(req), mesDe(req), texto(req.query.tipo)));
  }),

  /** PUT /seguros-sociales/:ejercicio/:mes — RLC real, IT compensada, fecha de cargo. */
  guardarSegurosSociales: asyncHandler(async (req, res) => {
    sendOk(res, await guardarSegurosSociales(req.companyId!, ejercicioDe(req), mesDe(req), parsear(segurosSocialesSchema, req.body)));
  }),

  /** POST /seguros-sociales/:ejercicio/:mes/pago — 476 (y ajustes a 642/471) contra 572/570. */
  pagarSegurosSociales: asyncHandler(async (req, res) => {
    const ejercicio = ejercicioDe(req);
    const mes = mesDe(req);
    const r = await pagarSegurosSociales(req.companyId!, ejercicio, mes, parsear(pagoSegurosSocialesSchema, req.body));
    await auditar(req, 'PAGAR_SEGUROS_SOCIALES', `${ejercicio}-${String(mes).padStart(2, '0')}`, { asiento: r.asiento.numero, importe: r.importe, diferencia: r.diferencia });
    sendOk(res, r, undefined, 201);
  }),

  anularPagoSegurosSociales: asyncHandler(async (req, res) => {
    const ejercicio = ejercicioDe(req);
    const mes = mesDe(req);
    const d = parsear(anularPagoSegurosSocialesSchema, req.body);
    const r = await anularPagoSegurosSociales(req.companyId!, ejercicio, mes, d);
    await auditar(req, 'ANULAR_PAGO_SEGUROS_SOCIALES', `${ejercicio}-${String(mes).padStart(2, '0')}`, { motivo: d.motivo ?? null, revertido: r.asientoRevertido, contraasiento: r.contraasiento?.numero ?? null });
    sendOk(res, r);
  }),

  // --- Retenciones (111) ---

  /** GET /retenciones/:ejercicio/:periodo — casillas del 111 (misma fuente que Impuestos) y su pago. */
  retenciones: asyncHandler(async (req, res) => {
    const periodo = periodo111De(req);
    // Una empresa no establecida en Espana no presenta el 111 (como en Impuestos).
    if (!(await esEmpresaEspanolaFiscal(req.companyId!))) throw badRequest(MENSAJE_SIN_MODELOS);
    const [d, trabajo, pago, aPagar, mensual] = await Promise.all([
      calcularModelo111(req.companyId!, periodo),
      retencionesTrabajo(req.companyId!, periodo),
      pagoModelo111(req.companyId!, periodo.ejercicio, periodo.periodo),
      importePago111(req.companyId!, periodo),
      presenta111Mensual(req.companyId!),
    ]);
    sendOk(res, {
      periodo,
      // Gran empresa: el 111 se presenta cada mes (la pantalla de Nóminas abre el mes).
      mensual,
      casillas: {
        '01': d.nPerceptoresTrabajo,
        '02': d.percepcionesTrabajo,
        '03': d.retencionesTrabajo,
        '04': d.nPerceptoresEspecie ?? 0,
        '05': d.percepcionesEspecie ?? 0,
        '06': d.ingresosACuentaEspecie ?? 0,
        '07': d.nPerceptoresActividades ?? 0,
        '08': d.percepcionesActividades ?? 0,
        '09': d.retencionesActividades ?? 0,
        '28': d.totalRetenciones,
        '30': d.resultadoIngresar,
      },
      nominas: trabajo.nominas,
      borradores: trabajo.borradores,
      mesesResumenAntiguo: trabajo.mesesResumenAntiguo,
      pago: pago ? { asientoId: pago.id, numero: pago.numeroAsiento, fecha: pago.fecha.toISOString().slice(0, 10) } : null,
      // Lo que se paga (lo presentado o editado en Impuestos manda sobre el calculo).
      aPagar: { importe: aPagar.total, fuente: aPagar.fuente, trabajo: aPagar.trabajoNominas + aPagar.trabajoResumenAntiguo, profesionales: aPagar.profesionales },
      avisos: aPagar.avisos,
    });
  }),

  /** POST /retenciones/:ejercicio/:periodo/pago — 4751 (trabajo y profesionales) contra 572/570. */
  pagar111: asyncHandler(async (req, res) => {
    const periodo = periodo111De(req);
    const r = await pagarModelo111(req.companyId!, periodo.ejercicio, periodo.periodo, parsear(pago111Schema, req.body));
    await auditar(req, 'PAGAR_MODELO_111', `${periodo.ejercicio}-${periodo.periodo}`, { asiento: r.asiento.numero, importe: r.importe });
    sendOk(res, r, undefined, 201);
  }),

  anularPago111: asyncHandler(async (req, res) => {
    const periodo = periodo111De(req);
    const d = parsear(anularPago111Schema, req.body);
    const r = await anularPagoModelo111(req.companyId!, periodo.ejercicio, periodo.periodo, d);
    await auditar(req, 'ANULAR_PAGO_MODELO_111', `${periodo.ejercicio}-${periodo.periodo}`, { motivo: d.motivo ?? null, revertido: r.asientoRevertido, contraasiento: r.contraasiento?.numero ?? null });
    sendOk(res, r);
  }),

  // --- Modelo 190 ---

  /** GET /190/:ejercicio/perceptores — un registro por perceptor y clave (JSON, o Excel con ?formato=xlsx). */
  perceptores190: asyncHandler(async (req, res) => {
    const ejercicio = ejercicioDe(req);
    if (!(await esEmpresaEspanolaFiscal(req.companyId!))) throw badRequest(MENSAJE_SIN_MODELOS);
    const m = await calcularModelo190(req.companyId!, ejercicio);
    if (quiereExcel(req)) {
      // Exportacion masiva con los datos de toda la plantilla: queda en la auditoria.
      await auditar(req, 'EXPORTAR_PERCEPTORES_190', String(ejercicio), { ejercicio, registros: m.totales.registros, perceptores: m.totales.perceptores });
      return descargar(res, `modelo190_${ejercicio}.xlsx`, XLSX_MIME, informe190Excel(m));
    }
    // Sin diseño publicado del ejercicio se genera con el ultimo, como borrador (avisoDiseno).
    const diseno = (() => {
      try {
        return comprobarDiseno190(ejercicio);
      } catch {
        return null;
      }
    })();
    // Declaracion en curso del historial (B4): numero, tipo y perceptores elegidos para una complementaria.
    const decl = await contextoDeclaracion(req.companyId!, '190', ejercicio, '0A');
    // Complementaria: los elegidos y los que han aparecido después de prepararla (sin presentar antes).
    const incluye = incluyeRegistro(decl);
    const elegidos = incluye ? m.perceptores.filter((p) => incluye(idRegistro190(p))) : m.perceptores;
    // Presentada (congelada): la lista y el resumen son los de lo presentado. Los
    // perceptores que han aparecido después no se mezclan: se cuentan aparte.
    const presentados = decl.congelada ? m.perceptores.filter((p) => decl.registrosPresentados.has(idRegistro190(p))) : null;
    const nuevos = decl.congelada ? m.perceptores.length - (presentados?.length ?? 0) : 0;
    const totalesPresentados = decl.congelada ? (datosDe(decl.ultimaPresentada).fila?.datos as { totales?: { registros: number; percepciones: number; retenciones: number } } | undefined)?.totales : undefined;
    const resumen = presentados
      ? resumen190(presentados).map((r) => {
          if (!totalesPresentados) return r;
          const v = r.tipo === 'numero' ? totalesPresentados.registros : /retenc/i.test(r.rotulo) ? totalesPresentados.retenciones : totalesPresentados.percepciones;
          return { ...r, valor: v, signo: r.tipo === 'importe' && v < 0 ? ('N' as const) : (' ' as const) };
        })
      : resumen190(elegidos);
    sendOk(res, {
      ...m,
      // Cada registro con su id: con el se eligen los que van en una complementaria.
      perceptores: (presentados ?? m.perceptores).map((p) => ({
        ...p,
        id: idRegistro190(p),
        presentado: decl.registrosPresentados.has(idRegistro190(p)),
        incluido: incluye ? incluye(idRegistro190(p)) : true,
        // NIF con la letra o el control mal: se ve aquí antes de descargar (el fichero da 400).
        errorNif: errorNifPerceptor190(p),
      })),
      ficheroDisponible: diseno !== null,
      avisoDiseno: diseno?.aviso ?? null,
      // En una complementaria, el resumen 01-03 es el de los perceptores elegidos; presentada, el de lo presentado.
      resumen,
      avisoCongelada:
        decl.congelada && nuevos > 0
          ? `Se enseñan los perceptores de la declaración presentada. Desde entonces hay ${nuevos} ${nuevos === 1 ? 'registro nuevo' : 'registros nuevos'}: si hay que declararlos, prepara una complementaria.`
          : null,
      declaracion: { tipo: decl.tipo, numero: decl.numero, justificanteAnterior: decl.justificanteAnterior, congelada: decl.congelada },
    });
  }),

  /**
   * GET /190/:ejercicio/fichero — TXT de la AEAT (ISO-8859-1). 409 si el ejercicio
   * es anterior al primer diseño verificado o si la declaracion aun no tiene
   * numero identificativo (lo pone POST /tax-models/190/declaraciones/numero,
   * con permiso de escritura: este GET no escribe). Para un ejercicio posterior
   * al ultimo diseño publicado sale como borrador con ese diseño (cabecera
   * X-Avisos-Aeat). 400 si faltan datos (tambien la persona de contacto y el
   * telefono de Datos de la empresa).
   */
  fichero190: asyncHandler(async (req, res) => {
    const ejercicio = ejercicioDe(req);
    // Una empresa no establecida en Espana no presenta modelos de la AEAT (divisas-iva).
    if (!(await esEmpresaEspanolaFiscal(req.companyId!))) throw badRequest(MENSAJE_SIN_MODELOS);
    const f = await ficheroModelo190(req.companyId!, ejercicio);
    // Cabecera ASCII (sin tildes): los avisos con texto completo estan en /190/:ejercicio/perceptores.
    if (f.avisos.length) res.setHeader('X-Avisos-Aeat', encodeURIComponent(f.avisos.join(' | ')));
    res.setHeader('X-Numero-Declaracion', f.numeroDeclaracion);
    await auditar(req, 'EXPORTAR_MODELO_190', String(ejercicio), { registros: f.registros, numeroDeclaracion: f.numeroDeclaracion });
    descargar(res, `190_${ejercicio}.txt`, 'text/plain; charset=ISO-8859-1', Buffer.from(f.contenido, 'latin1'));
  }),

  // --- PDF de la gestoria ---

  listarDocumentosMes: asyncHandler(async (req, res) => {
    sendOk(res, await listarDocumentosNominas(req.companyId!, { ejercicio: ejercicioDe(req), mes: mesDe(req) }));
  }),

  listarDocumentos: asyncHandler(async (req, res) => {
    const trimestre = req.query.trimestre ? Number(req.query.trimestre) : undefined;
    if (trimestre !== undefined && ![1, 2, 3, 4].includes(trimestre)) throw badRequest('Parámetro "trimestre" no válido.');
    sendOk(
      res,
      await listarDocumentosNominas(req.companyId!, {
        ejercicio: entero(req.query.ejercicio, esquemaEjercicio, 'ejercicio'),
        mes: enteroOpcional(req.query.mes, esquemaMes, 'mes'),
        trimestre,
      }),
    );
  }),

  /** POST /periodos/:ejercicio/:mes/documentos — multipart: archivo, tipo (nomina|rlc|rnt), nominaId, observaciones. */
  subirDocumento: asyncHandler(async (req, res) => {
    const ejercicio = ejercicioDe(req);
    const mes = mesDe(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const doc = await subirDocumentoNominas(req.companyId!, ejercicio, mes, (req as Request & { file?: FicheroSubido }).file, {
      clase: texto(b.tipo),
      nominaId: texto(b.nominaId),
      observaciones: texto(b.observaciones),
      userId: req.user?.userId,
    });
    await auditar(req, 'SUBIR_DOCUMENTO_NOMINAS', doc.id, { ejercicio, mes, clase: doc.clase, nominaId: doc.nominaId });
    sendOk(res, doc, undefined, 201);
  }),

  zipDocumentos: asyncHandler(async (req, res) => {
    const trimestre = req.query.trimestre ? Number(req.query.trimestre) : undefined;
    if (trimestre !== undefined && ![1, 2, 3, 4].includes(trimestre)) throw badRequest('Parámetro "trimestre" no válido.');
    const z = await zipDocumentosNominas(req.companyId!, {
      ejercicio: entero(req.query.ejercicio, esquemaEjercicio, 'ejercicio'),
      mes: enteroOpcional(req.query.mes, esquemaMes, 'mes'),
      trimestre,
    });
    await auditar(req, 'DESCARGAR_ZIP_NOMINAS', z.nombre);
    descargar(res, z.nombre, 'application/zip', z.contenido);
  }),

  descargarDocumento: asyncHandler(async (req, res) => {
    const d = await descargarDocumentoNominas(req.companyId!, req.params.documentoId);
    await auditar(req, 'DESCARGAR_DOCUMENTO_NOMINAS', req.params.documentoId);
    descargar(res, d.nombre, d.tipo || 'application/octet-stream', d.buffer);
  }),

  anularDocumento: asyncHandler(async (req, res) => {
    await anularDocumentoNominas(req.companyId!, req.params.documentoId);
    await auditar(req, 'ANULAR_DOCUMENTO_NOMINAS', req.params.documentoId);
    sendOk(res, { anulado: true });
  }),

  // --- Informes y tesoreria ---

  /** GET /informes/coste?ejercicio&agrupar=mes|empleado&formato=xlsx */
  informeCoste: asyncHandler(async (req, res) => {
    const ejercicio = entero(req.query.ejercicio, esquemaEjercicio, 'ejercicio');
    const agrupar = String(req.query.agrupar ?? 'mes');
    if (agrupar !== 'mes' && agrupar !== 'empleado') throw badRequest('Parámetro "agrupar" no válido: mes o empleado.');
    const inf = await informeCoste(req.companyId!, ejercicio, agrupar);
    if (quiereExcel(req)) {
      await auditar(req, 'EXPORTAR_COSTE_PERSONAL', `${ejercicio}-${agrupar}`, { ejercicio, agrupar, filas: inf.filas.length, trabajadores: inf.totales.trabajadores });
      return descargar(res, `coste_personal_${ejercicio}_${agrupar}.xlsx`, XLSX_MIME, informeCosteExcel(inf));
    }
    sendOk(res, inf);
  }),

  /** GET /prevision?desde&hasta — pagos de nominas, seguros sociales y 111 previstos. */
  prevision: asyncHandler(async (req, res) => {
    sendOk(res, await previsionPagos(req.companyId!, texto(req.query.desde), texto(req.query.hasta)));
  }),

  /**
   * GET /conciliacion/cargos?importe&fecha — cargos del extracto sin conciliar por
   * ese importe exacto (para pagar liquidos, seguros sociales o el 111 eligiendo
   * el cargo, que queda conciliado con el asiento del pago).
   */
  cargos: asyncHandler(async (req, res) => {
    const importe = Number(String(req.query.importe ?? '').replace(',', '.'));
    if (!Number.isFinite(importe) || importe <= 0) throw badRequest('Parámetro "importe" no válido.');
    sendOk(res, await cargosParaPago(req.companyId!, importe, texto(req.query.fecha)));
  }),

  /** GET /conciliacion/sugerencias?movimientoId — pagos de nominas que cuadran con un cargo del banco. */
  sugerencias: asyncHandler(async (req, res) => {
    const id = texto(req.query.movimientoId);
    if (!id) throw badRequest('Indica el movimiento del banco (movimientoId).');
    sendOk(res, await sugerenciasMovimiento(req.companyId!, id));
  }),
};
