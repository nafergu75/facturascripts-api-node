import type { Request } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest, HttpError } from '../utils/http-errors';
import { registrarAuditoria } from '../services/auditoria.service';
import { autorizado } from '../services/rbac.service';
import {
  leerBalance,
  leerDiario,
  type Agrupacion,
  type CampoBalance,
  type CampoDiario,
  type ConvencionSigno,
  type LecturaBalance,
  type OpcionesLectura,
  type SeparadorDecimal,
} from '../services/puestaEnMarcha/lectorContable';
import {
  anularApertura,
  anularDiarioImportado,
  borrarComparativo,
  confirmarApertura,
  confirmarComparativo,
  confirmarDiario,
  cuentasDesdeJson,
  estadoPuestaEnMarcha,
  previsualizarApertura,
  previsualizarComparativo,
  previsualizarDiario,
  type ParteComparativo,
} from '../services/puestaEnMarcha/puestaEnMarcha.service';
import { borrarSubida, reensamblarSubida, recibirTrozo } from '../services/puestaEnMarcha/subidasTrozos';
import {
  confirmarPlan,
  cuentasPlanDesdeJson,
  enlazarSubcuenta,
  leerPlan,
  previsualizarPlan,
  subcuentasSinEnlazar,
  tercerosDesdeJson,
} from '../services/puestaEnMarcha/planAnterior';

type ConFichero = Request & { file?: { buffer: Buffer; originalname: string } };

const si = (v: unknown) => ['1', 'true', 'si', 'sí', 'on'].includes(String(v ?? '').toLowerCase());

function json(v: unknown): unknown {
  if (typeof v !== 'string' || !v.trim()) return v;
  try {
    return JSON.parse(v);
  } catch {
    throw badRequest('El mapeo de columnas no es un JSON válido.');
  }
}

function opcionesLectura<C extends string>(body: Record<string, unknown>): OpcionesLectura<C> {
  const conv = String(body.convencionSigno ?? 'auto') as ConvencionSigno;
  const dec = String(body.separadorDecimal ?? '');
  const fila = body.filaCabecera !== undefined && body.filaCabecera !== '' ? Number(body.filaCabecera) : undefined;
  return {
    mapeo: json(body.mapeo),
    filaCabecera: Number.isInteger(fila) ? fila : undefined,
    convencionSigno: ['auto', 'deudor', 'naturaleza'].includes(conv) ? conv : 'auto',
    separadorDecimal: dec === ',' || dec === '.' ? (dec as SeparadorDecimal) : undefined,
  };
}

/**
 * El fichero de la peticion: subido directamente (campo "archivo") o ya subido
 * por trozos (campo "subidaId", ver subidasTrozos.ts). Null si no hay ninguno.
 */
async function ficheroDe(req: ConFichero): Promise<{ buffer: Buffer; originalname: string } | null> {
  if (req.file) return req.file;
  const subidaId = (req.body ?? {}).subidaId;
  if (subidaId) return reensamblarSubida(req.companyId!, subidaId);
  return null;
}

/** Tras confirmar, los trozos ya no hacen falta. */
async function limpiarSubida(req: ConFichero): Promise<void> {
  const subidaId = (req.body ?? {}).subidaId;
  if (!req.file && subidaId) await borrarSubida(req.companyId!, subidaId);
}

/** Saldos: del fichero (campo "archivo" o "subidaId") o ya mapeados (campo "cuentas", JSON). */
async function entradaSaldos(req: ConFichero): Promise<{ lectura?: LecturaBalance; cuentas?: ReturnType<typeof cuentasDesdeJson> }> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const f = await ficheroDe(req);
  if (f) return { lectura: leerBalance(f.buffer, f.originalname, opcionesLectura<CampoBalance>(body)) };
  if (body.cuentas !== undefined) return { cuentas: cuentasDesdeJson(body.cuentas) };
  throw badRequest('Adjunta el fichero en el campo "archivo".');
}

async function lecturaDiario(req: ConFichero) {
  const f = await ficheroDe(req);
  if (!f) throw badRequest('Adjunta el fichero del diario o del mayor en el campo "archivo".');
  return leerDiario(f.buffer, f.originalname, opcionesLectura<CampoDiario>((req.body ?? {}) as Record<string, unknown>));
}

/**
 * En la vista previa, si no se reconocen las columnas, se responde 200 con las
 * columnas del fichero para que el usuario indique cual es cada dato.
 */
async function conMapeo<T>(fn: () => Promise<T>): Promise<T | { necesitaMapeo: true; mensaje: string; columnas: unknown; mapeo?: unknown }> {
  try {
    return await fn();
  } catch (e) {
    const d = e instanceof HttpError ? (e.details as { necesitaMapeo?: boolean; columnas?: unknown; mapeo?: unknown } | undefined) : undefined;
    if (d?.necesitaMapeo) return { necesitaMapeo: true, mensaje: (e as Error).message, columnas: d.columnas, mapeo: d.mapeo };
    throw e;
  }
}

/**
 * El traslado del plan exige contabilidad:write; dar de alta una ficha de
 * cliente o de proveedor, ademas, ventas:write o compras:write, como en
 * Clientes y Proveedores (el administrador siempre puede).
 */
function permisosAlta(req: Request) {
  return { cliente: autorizado(req.user!, req.companyId, ['ventas:write']), proveedor: autorizado(req.user!, req.companyId, ['compras:write']) };
}

/** Plan del ejercicio anterior: del fichero (campo "archivo" o "subidaId") o ya mapeado (campo "cuentas"), con el listado de terceros opcional. */
async function entradaPlan(req: ConFichero) {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const terceros = tercerosDesdeJson(body.terceros);
  const permisos = permisosAlta(req);
  const f = await ficheroDe(req);
  if (f) return { lectura: leerPlan(f.buffer, f.originalname), terceros, permisos };
  if (body.cuentas !== undefined) return { cuentas: cuentasPlanDesdeJson(body.cuentas), terceros, permisos };
  throw badRequest('Adjunta el fichero del plan de cuentas en el campo "archivo".');
}

function ejercicioDe(raw: unknown): number {
  const e = Number(raw);
  if (!Number.isInteger(e)) throw badRequest('Parámetro "ejercicio" no válido.');
  return e;
}

export const puestaEnMarchaController = {
  /** POST /subidas — un trozo de un fichero grande (campo "trozo"). */
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

  /** DELETE /subidas/:subidaId — descarta una subida que no se va a usar. */
  descartarSubida: asyncHandler(async (req, res) => {
    await borrarSubida(req.companyId!, req.params.subidaId);
    sendOk(res, { descartada: true });
  }),

  estado: asyncHandler(async (req, res) => {
    sendOk(res, await estadoPuestaEnMarcha(req.companyId!));
  }),

  vistaApertura: asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    sendOk(res, await conMapeo(async () => previsualizarApertura(req.companyId!, await entradaSaldos(req as ConFichero), { ejercicio: b.ejercicio, fecha: b.fecha, reemplazar: si(b.reemplazar) })));
  }),

  confirmarApertura: asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const r = await confirmarApertura(req.companyId!, await entradaSaldos(req as ConFichero), {
      ejercicio: b.ejercicio,
      fecha: b.fecha,
      reemplazar: si(b.reemplazar),
      guardarComparativo: si(b.guardarComparativo),
    });
    await registrarAuditoria({
      userId: req.user!.userId,
      companyId: req.companyId,
      action: 'IMPORTAR_APERTURA',
      resourceType: 'ASIENTO',
      resourceId: r.asiento.id,
      meta: { ejercicio: r.vista.ejercicio, numero: r.asiento.numero, cuentas: r.vista.cuentas.length, anulados: r.anulados },
    });
    await limpiarSubida(req as ConFichero);
    sendOk(res, r, undefined, 201);
  }),

  anularApertura: asyncHandler(async (req, res) => {
    const ejercicio = ejercicioDe(req.query.ejercicio);
    const r = await anularApertura(req.companyId!, ejercicio);
    await registrarAuditoria({ userId: req.user!.userId, companyId: req.companyId, action: 'ANULAR_APERTURA', resourceType: 'EJERCICIO', resourceId: String(ejercicio), meta: r });
    sendOk(res, r);
  }),

  vistaDiario: asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    sendOk(
      res,
      await conMapeo(async () =>
        previsualizarDiario(req.companyId!, await lecturaDiario(req as ConFichero), {
          ejercicio: b.ejercicio,
          agrupacion: (b.agrupacion || 'auto') as Agrupacion,
          incluirEspeciales: si(b.incluirEspeciales),
          reemplazar: si(b.reemplazar),
        }),
      ),
    );
  }),

  confirmarDiario: asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const r = await confirmarDiario(req.companyId!, await lecturaDiario(req as ConFichero), {
      ejercicio: b.ejercicio,
      agrupacion: (b.agrupacion || 'auto') as Agrupacion,
      incluirEspeciales: si(b.incluirEspeciales),
      reemplazar: si(b.reemplazar),
    });
    await registrarAuditoria({
      userId: req.user!.userId,
      companyId: req.companyId,
      action: 'IMPORTAR_DIARIO',
      resourceType: 'EJERCICIO',
      resourceId: String(r.vista.ejercicio),
      meta: { asientos: r.asientosCreados, anulados: r.anulados, cuentasCreadas: r.cuentasCreadas },
    });
    await limpiarSubida(req as ConFichero);
    sendOk(res, r, undefined, 201);
  }),

  anularDiario: asyncHandler(async (req, res) => {
    const ejercicio = ejercicioDe(req.query.ejercicio);
    const r = await anularDiarioImportado(req.companyId!, ejercicio);
    await registrarAuditoria({ userId: req.user!.userId, companyId: req.companyId, action: 'ANULAR_DIARIO_IMPORTADO', resourceType: 'EJERCICIO', resourceId: String(ejercicio), meta: r });
    sendOk(res, r);
  }),

  vistaComparativo: asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    sendOk(res, await conMapeo(async () => previsualizarComparativo(req.companyId!, await entradaSaldos(req as ConFichero), { ejercicio: b.ejercicio, parte: (b.parte || 'todo') as ParteComparativo })));
  }),

  confirmarComparativo: asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const r = await confirmarComparativo(req.companyId!, await entradaSaldos(req as ConFichero), { ejercicio: b.ejercicio, parte: (b.parte || 'todo') as ParteComparativo });
    await limpiarSubida(req as ConFichero);
    sendOk(res, r, undefined, 201);
  }),

  /** POST /plan/vista-previa — lo que haria el traslado del plan anterior, sin tocar nada. */
  vistaPlan: asyncHandler(async (req, res) => {
    sendOk(res, await previsualizarPlan(req.companyId!, await entradaPlan(req as ConFichero)));
  }),

  /** POST /plan — crea las cuentas, fija la longitud y enlaza las subcuentas de terceros. */
  confirmarPlan: asyncHandler(async (req, res) => {
    const r = await confirmarPlan(req.companyId!, await entradaPlan(req as ConFichero));
    await registrarAuditoria({
      userId: req.user!.userId,
      companyId: req.companyId,
      action: 'IMPORTAR_PLAN_ANTERIOR',
      resourceType: 'PLAN_CONTABLE',
      resourceId: req.companyId!,
      meta: {
        cuentasCreadas: r.cuentasCreadas,
        fichasEnlazadas: r.fichasEnlazadas,
        fichasCreadas: r.fichasCreadas,
        pendientes: r.pendientes,
        longitudFijada: r.longitudFijada,
      },
    });
    await limpiarSubida(req as ConFichero);
    sendOk(res, r, undefined, 201);
  }),

  /** GET /plan/sin-enlazar — subcuentas de clientes y proveedores del plan que no son de ninguna ficha. */
  sinEnlazar: asyncHandler(async (req, res) => {
    sendOk(res, await subcuentasSinEnlazar(req.companyId!));
  }),

  /** POST /plan/enlazar — { codigo, fichaId } o { codigo, nueva: { nombreFiscal, nifCif } }. */
  enlazar: asyncHandler(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const r = await enlazarSubcuenta(
      req.companyId!,
      { codigo: b.codigo, fichaId: b.fichaId, nueva: (b.nueva as { nombreFiscal?: unknown; nifCif?: unknown } | undefined) ?? null },
      permisosAlta(req),
    );
    await registrarAuditoria({
      userId: req.user!.userId,
      companyId: req.companyId,
      action: 'ENLAZAR_SUBCUENTA_TERCERO',
      resourceType: r.tipo === 'cliente' ? 'CLIENTE' : 'PROVEEDOR',
      resourceId: r.fichaId,
      meta: r,
    });
    sendOk(res, r);
  }),

  borrarComparativo: asyncHandler(async (req, res) => {
    sendOk(res, await borrarComparativo(req.companyId!, ejercicioDe(req.params.ejercicio)));
  }),
};
