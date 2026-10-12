/**
 * «Traer la contabilidad de 2026»: subir los ficheros de la gestoria,
 * analizarlos (sin escribir nada), confirmar una vez e importar por fases.
 */
import type { Request } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import { autorizado } from '../services/rbac.service';
import { reensamblarSubida, borrarSubida } from '../services/puestaEnMarcha/subidasTrozos';
import { aplicarFase, confirmarCarga, NOMBRE_FASE } from '../services/arranque/aplicar.service';
import { avisoArranque } from '../services/arranque/aviso.service';
import { deshacerCarga } from '../services/arranque/deshacer.service';
import { estadoArranque, quitarFichero, reanalizar, subirYAnalizar, validarEjercicio } from '../services/arranque/cargas.service';
import {
  aceptarAviso,
  comprobacionesArranque,
  crearSeriesDelEjercicio,
  guardarBancos,
  guardarDatosFiscales,
  volverLlevanzaApp,
} from '../services/arranque/seguimiento.service';

type ConFicheros = Request & { files?: Array<{ buffer: Buffer; originalname: string }> };

/** Un campo que puede llegar como JSON en texto (multipart) o ya como objeto. */
function json(v: unknown, campo: string): unknown {
  if (typeof v !== 'string') return v;
  if (!v.trim()) return undefined;
  try {
    return JSON.parse(v);
  } catch {
    throw badRequest(`El campo «${campo}» no es un JSON válido.`);
  }
}

/** Ids de subidas por trozos: lista JSON o separados por comas. */
function idsSubidas(v: unknown): string[] {
  const valor = json(v, 'subidaIds');
  if (valor === undefined || valor === null || valor === '') return [];
  const lista = Array.isArray(valor) ? valor : String(valor).split(',');
  return lista.map((x) => String(x).trim()).filter(Boolean).slice(0, 20);
}

/**
 * Si quien analiza puede dar de alta clientes (ventas:write) y proveedores
 * (compras:write), como en el traslado del plan; si no, sus subcuentas quedan
 * pendientes de enlazar en el resumen.
 */
function permisosAlta(req: Request) {
  return { cliente: autorizado(req.user!, req.companyId, ['ventas:write']), proveedor: autorizado(req.user!, req.companyId, ['compras:write']) };
}

export const arranqueController = {
  /** GET /aviso — aviso fijo del panel. */
  aviso: asyncHandler(async (req, res) => {
    sendOk(res, await avisoArranque(req.companyId!));
  }),

  /** GET /:ejercicio — carga vigente, borrador, la que se importa y versiones. */
  estado: asyncHandler(async (req, res) => {
    sendOk(res, { ...(await estadoArranque(req.companyId!, req.params.ejercicio)), fases: NOMBRE_FASE });
  }),

  /** POST /:ejercicio/cargas — sube ficheros (multipart «archivos» o «subidaIds») al borrador y lo analiza. */
  subir: asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const nuevos = ((req as ConFicheros).files ?? []).map((f) => ({ nombre: f.originalname, contenido: f.buffer }));
    const subidas = idsSubidas(body.subidaIds);
    for (const id of subidas) {
      const f = await reensamblarSubida(req.companyId!, id);
      nuevos.push({ nombre: f.originalname, contenido: f.buffer });
    }
    const r = await subirYAnalizar(req.companyId!, req.params.ejercicio, req.user!.userId, nuevos, json(body.ajustes, 'ajustes'), permisosAlta(req));
    // Los ficheros ya estan guardados en la carpeta de la carga: los trozos sobran.
    for (const id of subidas) await borrarSubida(req.companyId!, id);
    sendOk(res, r, undefined, 201);
  }),

  /** POST /:ejercicio/cargas/:cargaId/analizar — repite el analisis con ajustes. */
  analizar: asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    sendOk(res, await reanalizar(req.companyId!, req.params.ejercicio, req.params.cargaId, req.user!.userId, json(body.ajustes, 'ajustes'), permisosAlta(req)));
  }),

  /** DELETE /:ejercicio/cargas/:cargaId/ficheros/:sha — quita un fichero del borrador. */
  quitarFichero: asyncHandler(async (req, res) => {
    sendOk(res, await quitarFichero(req.companyId!, req.params.ejercicio, req.params.cargaId, req.params.sha));
  }),

  /** POST /:ejercicio/cargas/:cargaId/confirmar — { huella } del resumen revisado. */
  confirmar: asyncHandler(async (req, res) => {
    sendOk(res, await confirmarCarga(req.companyId!, req.params.ejercicio, req.params.cargaId, (req.body ?? {}).huella, req.user!.userId));
  }),

  /** POST /:ejercicio/cargas/:cargaId/aplicar — la siguiente fase (la pantalla la llama hasta «terminada»). */
  aplicar: asyncHandler(async (req, res) => {
    sendOk(res, await aplicarFase(req.companyId!, req.params.ejercicio, req.params.cargaId, req.user!.userId));
  }),

  /** GET /:ejercicio/cargas/:cargaId/deshacer — qué se revertiría (no cambia nada). */
  vistaDeshacer: asyncHandler(async (req, res) => {
    sendOk(res, await deshacerCarga(req.companyId!, req.params.ejercicio, req.params.cargaId, { simular: true }, req.user!.userId));
  }),

  /**
   * DELETE /:ejercicio/cargas/:cargaId — deshace la carga. Body opcional:
   * { devolverAsientos2026?: boolean, borrarFichas?: string[] }. Con ?simular=1, solo la vista previa.
   */
  deshacer: asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const simular = req.query.simular === '1' || req.query.simular === 'true';
    if (body.borrarFichas !== undefined && (!Array.isArray(body.borrarFichas) || body.borrarFichas.some((x) => typeof x !== 'string'))) {
      throw badRequest('«borrarFichas» tiene que ser una lista de fichas.', { campo: 'borrarFichas' });
    }
    const opciones = { simular, devolverAsientos2026: body.devolverAsientos2026 === true, borrarFichas: (body.borrarFichas as string[] | undefined) ?? [] };
    sendOk(res, await deshacerCarga(req.companyId!, req.params.ejercicio, req.params.cargaId, opciones, req.user!.userId));
  }),

  /** GET /:ejercicio/comprobaciones — A4 en vivo (o las del borrador; null si no hay nada). */
  comprobaciones: asyncHandler(async (req, res) => {
    sendOk(res, await comprobacionesArranque(req.companyId!, validarEjercicio(req.params.ejercicio)));
  }),

  /** POST /:ejercicio/avisos/:clave/aceptar — { motivo }. */
  aceptarAviso: asyncHandler(async (req, res) => {
    sendOk(res, await aceptarAviso(req.companyId!, req.params.ejercicio, req.params.clave, (req.body ?? {}).motivo, req.user!.userId));
  }),

  /** PUT /:ejercicio/bancos — { bancos: { '5720000001': { saldoExtracto, bankAccountId?, nueva?, aceptarDiferencia? } } }. */
  bancos: asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    sendOk(res, await guardarBancos(req.companyId!, req.params.ejercicio, body.bancos ?? body, req.user!.userId));
  }),

  /** PUT /:ejercicio/datos-fiscales — { resultado303T4, cuotasIvaACompensar, basesNegativas, deducciones, resultadoDeclarado }. */
  datosFiscales: asyncHandler(async (req, res) => {
    sendOk(res, await guardarDatosFiscales(req.companyId!, req.params.ejercicio, req.body ?? {}, req.user!.userId));
  }),

  /** POST /:ejercicio/series — crea F2027 y R2027 predeterminadas. */
  series: asyncHandler(async (req, res) => {
    sendOk(res, await crearSeriesDelEjercicio(req.companyId!, req.params.ejercicio, req.user!.userId), undefined, 201);
  }),

  /** POST /:ejercicio/ejercicios/llevanza — vuelve 2026 a la app (sin carga importada). */
  llevanza: asyncHandler(async (req, res) => {
    sendOk(res, await volverLlevanzaApp(req.companyId!, req.params.ejercicio, req.user!.userId));
  }),
};
