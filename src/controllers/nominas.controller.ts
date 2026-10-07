import type { Request } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest, HttpError } from '../utils/http-errors';
import { registrarAuditoria } from '../services/auditoria.service';
import {
  actualizarNomina,
  anularNominas,
  borrarNomina,
  confirmarImportacion,
  contabilizarNominas,
  crearNomina,
  generarPlantillaNominas,
  listarNominas,
  listarResumenesNominas,
  obtenerNomina,
  previsualizarAsientos,
  previsualizarImportacion,
  resumenPeriodo,
  type EntradaImportacion,
} from '../services/nominas.service';
import { ETIQUETAS_CAMPOS, filasDesdeJson, leerNominas, type BrutoConEspecie, type OpcionesLecturaNominas } from '../services/nominas/lector';
import { ejercicio as esquemaEjercicio, mes as esquemaMes, parsear, seleccionSchema } from '../services/nominas/esquemas';
import { ESTADOS_NOMINA } from '../domain/nominas.model';
import { borrarSubida, reensamblarSubida, recibirTrozo } from '../services/puestaEnMarcha/subidasTrozos';

type ConFichero = Request & { file?: { buffer: Buffer; originalname: string } };

const si = (v: unknown) => ['1', 'true', 'si', 'sí', 'on'].includes(String(v ?? '').toLowerCase());

function json(v: unknown, que: string): unknown {
  if (typeof v !== 'string' || !v.trim()) return v;
  try {
    return JSON.parse(v);
  } catch {
    throw badRequest(`${que} no es un JSON válido.`);
  }
}

/** Entero de la URL o de la query (400 si no lo es). */
function entero(v: unknown, esquema: typeof esquemaEjercicio | typeof esquemaMes, nombre: string): number {
  const n = Number(v);
  const r = esquema.safeParse(n);
  if (!r.success) throw badRequest(`Parámetro "${nombre}" no válido.`);
  return r.data;
}

function enteroOpcional(v: unknown, esquema: typeof esquemaEjercicio | typeof esquemaMes, nombre: string): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return entero(v, esquema, nombre);
}

function opcionesLectura(body: Record<string, unknown>): OpcionesLecturaNominas {
  const dec = String(body.separadorDecimal ?? '');
  const fila = body.filaCabecera !== undefined && body.filaCabecera !== '' ? Number(body.filaCabecera) : undefined;
  const especie = String(body.brutoIncluyeEspecie ?? 'auto');
  return {
    mapeo: json(body.mapeo, 'El mapeo de columnas'),
    filaCabecera: Number.isInteger(fila) ? fila : undefined,
    separadorDecimal: dec === ',' || dec === '.' ? dec : undefined,
    ejercicio: enteroOpcional(body.ejercicio, esquemaEjercicio, 'ejercicio'),
    mes: enteroOpcional(body.mes, esquemaMes, 'mes'),
    brutoIncluyeEspecie: (['auto', 'si', 'no'].includes(especie) ? especie : 'auto') as BrutoConEspecie,
  };
}

/**
 * Lo que se importa: el fichero (campo "archivo" o "subidaId" de una subida
 * por trozos) o las filas ya revisadas (campo "filas", JSON).
 */
async function entradaImportacion(req: ConFichero): Promise<EntradaImportacion> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (body.filas !== undefined && body.filas !== '') return { filas: filasDesdeJson(body.filas) };
  let fichero: { buffer: Buffer; originalname: string } | null = req.file ?? null;
  if (!fichero && body.subidaId) fichero = await reensamblarSubida(req.companyId!, body.subidaId);
  if (!fichero) throw badRequest('Adjunta el Excel de nóminas en el campo "archivo".');
  return { lectura: leerNominas(fichero.buffer, fichero.originalname, opcionesLectura(body)) };
}

function seleccion(req: Request) {
  const body = (req.body ?? {}) as Record<string, unknown>;
  return parsear(seleccionSchema, body);
}

export const nominasController = {
  listar: asyncHandler(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const estado = q.estado ? String(q.estado).toUpperCase() : undefined;
    if (estado && !(ESTADOS_NOMINA as readonly string[]).includes(estado)) throw badRequest('Parámetro "estado" no válido.');
    sendOk(
      res,
      await listarNominas(req.companyId!, {
        ejercicio: enteroOpcional(q.ejercicio, esquemaEjercicio, 'ejercicio'),
        mes: enteroOpcional(q.mes, esquemaMes, 'mes'),
        empleadoId: q.empleadoId ? String(q.empleadoId) : undefined,
        estado,
      }),
    );
  }),

  obtener: asyncHandler(async (req, res) => {
    sendOk(res, await obtenerNomina(req.companyId!, req.params.id));
  }),

  crear: asyncHandler(async (req, res) => {
    sendOk(res, await crearNomina(req.companyId!, req.body), undefined, 201);
  }),

  actualizar: asyncHandler(async (req, res) => {
    sendOk(res, await actualizarNomina(req.companyId!, req.params.id, req.body));
  }),

  borrar: asyncHandler(async (req, res) => {
    await borrarNomina(req.companyId!, req.params.id);
    await registrarAuditoria({ userId: req.user!.userId, companyId: req.companyId, action: 'BORRAR_NOMINA', resourceType: 'NOMINA', resourceId: req.params.id });
    sendOk(res, { borrada: true });
  }),

  plantilla: asyncHandler(async (_req, res) => {
    const buffer = generarPlantillaNominas();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla-nominas.xlsx"');
    res.send(buffer);
  }),

  /** GET /resumen — totales por mes (calculados con las nominas por trabajador). */
  resumen: asyncHandler(async (req, res) => {
    sendOk(res, await listarResumenesNominas(req.companyId!, entero(req.query.ejercicio, esquemaEjercicio, 'ejercicio')));
  }),

  /** POST /resumen — ya no se usa: grababa solo totales y el 111 contaba mal los perceptores. */
  resumenObsoleto: asyncHandler(async () => {
    throw badRequest(
      'El registro de nóminas por totales ya no se usa. Importa el Excel de la gestoría (POST /nominas/importar) o da de alta cada nómina (POST /nominas).',
    );
  }),

  /** POST /importar/subidas — un trozo de un fichero grande. */
  subirTrozo: asyncHandler(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const f = (req as ConFichero).file;
    sendOk(
      res,
      await recibirTrozo(req.companyId!, { subidaId: b.subidaId as string | undefined, indice: b.indice, total: b.total, nombre: b.nombre, tamano: b.tamano, hash: b.hash }, f?.buffer),
      undefined,
      201,
    );
  }),

  descartarSubida: asyncHandler(async (req, res) => {
    await borrarSubida(req.companyId!, req.params.subidaId);
    sendOk(res, { descartada: true });
  }),

  /**
   * POST /importar/vista-previa — no guarda nada. Si no se reconocen las
   * columnas, responde 200 con `necesitaMapeo` y las columnas del fichero.
   */
  vistaPrevia: asyncHandler(async (req, res) => {
    try {
      const entrada = await entradaImportacion(req as ConFichero);
      sendOk(res, await previsualizarImportacion(req.companyId!, entrada));
    } catch (e) {
      const d = e instanceof HttpError ? (e.details as { necesitaMapeo?: boolean; columnas?: unknown; mapeo?: unknown } | undefined) : undefined;
      if (!d?.necesitaMapeo) throw e;
      sendOk(res, { necesitaMapeo: true, mensaje: (e as Error).message, columnas: d.columnas, mapeo: d.mapeo ?? {}, campos: ETIQUETAS_CAMPOS });
    }
  }),

  /** POST /importar — confirma: trabajadores nuevos y nominas en borrador (y, con contabilizar, sus asientos). */
  importar: asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const entrada = await entradaImportacion(req as ConFichero);
    const r = await confirmarImportacion(req.companyId!, entrada, { contabilizar: si(body.contabilizar) });
    if (!(req as ConFichero).file && body.subidaId) await borrarSubida(req.companyId!, body.subidaId);
    await registrarAuditoria({
      userId: req.user!.userId,
      companyId: req.companyId,
      action: 'IMPORTAR_NOMINAS',
      resourceType: 'NOMINA',
      resourceId: r.loteImportacionId,
      meta: {
        nominasCreadas: r.nominasCreadas,
        nominasSustituidas: r.nominasSustituidas,
        empleadosCreados: r.empleadosCreados,
        periodos: r.periodos,
        contabilizadas: r.contabilizacion?.reduce((a, c) => a + c.contabilizadas, 0) ?? 0,
      },
    });
    sendOk(res, r, undefined, 201);
  }),

  periodo: asyncHandler(async (req, res) => {
    sendOk(res, await resumenPeriodo(req.companyId!, entero(req.params.ejercicio, esquemaEjercicio, 'ejercicio'), entero(req.params.mes, esquemaMes, 'mes')));
  }),

  asientoPreview: asyncHandler(async (req, res) => {
    const ids = req.query.nominaIds ? String(req.query.nominaIds).split(',').filter(Boolean) : undefined;
    sendOk(
      res,
      await previsualizarAsientos(req.companyId!, entero(req.params.ejercicio, esquemaEjercicio, 'ejercicio'), entero(req.params.mes, esquemaMes, 'mes'), ids),
    );
  }),

  contabilizar: asyncHandler(async (req, res) => {
    const ejercicio = entero(req.params.ejercicio, esquemaEjercicio, 'ejercicio');
    const mes = entero(req.params.mes, esquemaMes, 'mes');
    const s = seleccion(req);
    const r = await contabilizarNominas(req.companyId!, ejercicio, mes, s.nominaIds);
    await registrarAuditoria({
      userId: req.user!.userId,
      companyId: req.companyId,
      action: 'CONTABILIZAR_NOMINAS',
      resourceType: 'NOMINA',
      resourceId: `${ejercicio}-${String(mes).padStart(2, '0')}`,
      meta: { asientos: r.asientos.map((a) => a.numero), subcuentasCreadas: r.subcuentasCreadas },
    });
    sendOk(res, r, undefined, 201);
  }),

  anular: asyncHandler(async (req, res) => {
    const ejercicio = entero(req.params.ejercicio, esquemaEjercicio, 'ejercicio');
    const mes = entero(req.params.mes, esquemaMes, 'mes');
    const s = seleccion(req);
    const r = await anularNominas(req.companyId!, ejercicio, mes, { nominaIds: s.nominaIds, fecha: s.fecha, dejarAnuladas: s.dejarAnuladas });
    await registrarAuditoria({
      userId: req.user!.userId,
      companyId: req.companyId,
      action: 'ANULAR_NOMINAS',
      resourceType: 'NOMINA',
      resourceId: `${ejercicio}-${String(mes).padStart(2, '0')}`,
      meta: { motivo: s.motivo ?? null, anuladas: r.anuladas, estadoFinal: r.estadoFinal, revertidos: r.asientosRevertidos, contraasientos: r.contraasientos.map((c) => c.numero) },
    });
    sendOk(res, r);
  }),
};
