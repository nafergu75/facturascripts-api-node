import type { Request } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest, HttpError } from '../utils/http-errors';
import { registrarAuditoria } from '../services/auditoria.service';
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

/** Saldos: del fichero (campo "archivo") o ya mapeados (campo "cuentas", JSON). */
function entradaSaldos(req: ConFichero): { lectura?: LecturaBalance; cuentas?: ReturnType<typeof cuentasDesdeJson> } {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (req.file) return { lectura: leerBalance(req.file.buffer, req.file.originalname, opcionesLectura<CampoBalance>(body)) };
  if (body.cuentas !== undefined) return { cuentas: cuentasDesdeJson(body.cuentas) };
  throw badRequest('Adjunta el fichero en el campo "archivo".');
}

function lecturaDiario(req: ConFichero) {
  if (!req.file) throw badRequest('Adjunta el fichero del diario o del mayor en el campo "archivo".');
  return leerDiario(req.file.buffer, req.file.originalname, opcionesLectura<CampoDiario>((req.body ?? {}) as Record<string, unknown>));
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

function ejercicioDe(raw: unknown): number {
  const e = Number(raw);
  if (!Number.isInteger(e)) throw badRequest('Parámetro "ejercicio" no válido.');
  return e;
}

export const puestaEnMarchaController = {
  estado: asyncHandler(async (req, res) => {
    sendOk(res, await estadoPuestaEnMarcha(req.companyId!));
  }),

  vistaApertura: asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    sendOk(res, await conMapeo(() => previsualizarApertura(req.companyId!, entradaSaldos(req as ConFichero), { ejercicio: b.ejercicio, fecha: b.fecha, reemplazar: si(b.reemplazar) })));
  }),

  confirmarApertura: asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const r = await confirmarApertura(req.companyId!, entradaSaldos(req as ConFichero), {
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
      await conMapeo(() =>
        previsualizarDiario(req.companyId!, lecturaDiario(req as ConFichero), {
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
    const r = await confirmarDiario(req.companyId!, lecturaDiario(req as ConFichero), {
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
    sendOk(res, await conMapeo(() => previsualizarComparativo(req.companyId!, entradaSaldos(req as ConFichero), { ejercicio: b.ejercicio, parte: (b.parte || 'todo') as ParteComparativo })));
  }),

  confirmarComparativo: asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const r = await confirmarComparativo(req.companyId!, entradaSaldos(req as ConFichero), { ejercicio: b.ejercicio, parte: (b.parte || 'todo') as ParteComparativo });
    sendOk(res, r, undefined, 201);
  }),

  borrarComparativo: asyncHandler(async (req, res) => {
    sendOk(res, await borrarComparativo(req.companyId!, ejercicioDe(req.params.ejercicio)));
  }),
};
