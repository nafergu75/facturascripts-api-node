import { timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest, notFound } from '../utils/http-errors';
import { config } from '../config/env';
import { construirContexto } from '../services/carmen/contexto';
import { atender, catalogoParaPagina } from '../services/carmen/enrutador';
import { borrarSesion, listarSesiones, mensajesDeSesion, purgarSiToca, purgarTodas, valorarMensaje } from '../services/carmen/sesiones';
import { HttpError } from '../utils/http-errors';
import { logger } from '../config/logger';
import { guardarAjustes, leerAjustes, topeEmpresaDia } from '../services/carmen/ajustes.service';
import { leerUso, motivoConfiguracion, motivoSinIA, TEXTO_MOTIVO } from '../services/carmen/presupuesto.service';
import type { Request } from 'express';

/** Longitud máxima de una pregunta a Carmen. */
export const MAX_MENSAJE = 500;

const ID = /^[A-Za-z0-9_-]{1,40}$/;

const esquemaHuecos = z
  .object({
    periodo: z.string().max(30).optional(),
    sentido: z.enum(['cobros', 'pagos']).optional(),
    modelo: z.string().max(5).optional(),
    terceroId: z.string().regex(ID).optional(),
    rol: z.enum(['cliente', 'proveedor', 'banco']).optional(),
    importeMinimo: z.number().positive().max(1e10).optional(),
    diasMinimos: z.number().int().positive().max(3650).optional(),
    ibanFinal: z.string().regex(/^\d{4}$/).optional(),
    numeroFactura: z.string().regex(/^[A-Za-z0-9/-]{1,30}$/).optional(),
    soloVencidas: z.boolean().optional(),
    foco: z.enum(['ventas', 'gastos']).optional(),
  })
  .strict();

const esquemaAccion = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('intencion'), id: z.string().max(40), huecos: esquemaHuecos.optional() }).strict(),
  z.object({ tipo: z.literal('faq'), id: z.string().max(80) }).strict(),
  z.object({ tipo: z.literal('tercero'), terceroId: z.string().regex(ID), rol: z.enum(['cliente', 'proveedor', 'banco']), intencion: z.string().max(40).optional() }).strict(),
  z.object({ tipo: z.literal('ia') }).strict(),
  z.object({ tipo: z.literal('catalogo') }).strict(),
  // «No era esto»: la pregunta original va en message; la intención descartada no se vuelve a ofrecer.
  z.object({ tipo: z.literal('noEraEsto'), intencion: z.string().max(40).optional() }).strict(),
]);

export const esquemaChat = z
  .object({
    message: z.string().trim().min(1, 'La pregunta está vacía.').max(MAX_MENSAJE, `La pregunta no puede pasar de ${MAX_MENSAJE} caracteres.`).optional(),
    accion: esquemaAccion.optional(),
    sessionId: z.string().regex(ID, 'sessionId no válido.').optional(),
    currentPage: z.string().max(200).regex(/^\//).optional(),
    // Texto del botón que ha pulsado el usuario: es lo que se guarda como su pregunta en el historial.
    textoBoton: z.string().trim().min(1).max(120).optional(),
  })
  .refine((b) => b.message !== undefined || b.accion !== undefined, { message: 'Hace falta "message" o "accion".' });

function contexto(req: Request) {
  return construirContexto(req.user!, req.companyId!);
}

function idDeRuta(valor: string | undefined, que: string): string {
  if (!valor || !ID.test(valor)) throw notFound(`${que} no encontrada.`);
  return valor;
}

export const chatAssistantController = {
  // POST /companies/:companyId/chat-assistant
  chat: asyncHandler(async (req, res) => {
    const r = esquemaChat.safeParse(req.body ?? {});
    if (!r.success) throw badRequest('Datos de entrada no válidos.', r.error.flatten());
    sendOk(res, await atender(contexto(req), r.data));
  }),

  // GET /companies/:companyId/chat-assistant/sesiones?pagina=
  sesiones: asyncHandler(async (req, res) => {
    const ctx = contexto(req);
    const ajustes = await leerAjustes(ctx.companyId);
    const lista = await listarSesiones(ctx, Number(req.query.pagina ?? 1), ajustes.conservarDias);
    // Lo caducado ya no se lista; además se borra (sin esperar a que alguien pregunte).
    await purgarSiToca(ctx.companyId, ajustes.conservarDias);
    sendOk(res, lista);
  }),

  // GET /companies/:companyId/chat-assistant/:sessionId/messages
  getHistory: asyncHandler(async (req, res) => {
    const ctx = contexto(req);
    const sessionId = idDeRuta(req.params.sessionId, 'Conversación');
    const ajustes = await leerAjustes(ctx.companyId);
    // Primero la conversación (una ajena o caducada da 404 sin leer nada); después la purga.
    const mensajes = await mensajesDeSesion(ctx, sessionId, ajustes.conservarDias);
    await purgarSiToca(ctx.companyId, ajustes.conservarDias);
    sendOk(res, mensajes);
  }),

  // DELETE /companies/:companyId/chat-assistant/:sessionId
  borrar: asyncHandler(async (req, res) => {
    await borrarSesion(contexto(req), idDeRuta(req.params.sessionId, 'Conversación'));
    sendOk(res, { borrada: true });
  }),

  // POST /companies/:companyId/chat-assistant/mensajes/:id/valoracion
  valorar: asyncHandler(async (req, res) => {
    const r = z.object({ util: z.boolean() }).strict().safeParse(req.body ?? {});
    if (!r.success) throw badRequest('Indica si la respuesta te ha servido (util: true o false).');
    await valorarMensaje(contexto(req), idDeRuta(req.params.id, 'Respuesta'), r.data.util);
    sendOk(res, { guardada: true });
  }),

  // GET /companies/:companyId/chat-assistant/catalogo?pagina=
  catalogo: asyncHandler(async (req, res) => {
    const pagina = typeof req.query.pagina === 'string' && req.query.pagina.startsWith('/') ? req.query.pagina.slice(0, 200) : undefined;
    sendOk(res, await catalogoParaPagina(contexto(req), pagina));
  }),

  // GET /companies/:companyId/chat-assistant/estado
  estado: asyncHandler(async (req, res) => {
    const ctx = contexto(req);
    const ajustes = await leerAjustes(ctx.companyId);
    await purgarSiToca(ctx.companyId, ajustes.conservarDias);
    const tope = topeEmpresaDia(ajustes);
    const previo = motivoConfiguracion(ajustes.iaActiva);
    const uso = previo && !ctx.esAdminEmpresa ? null : await leerUso(ctx.companyId, ctx.userId, ctx.hoy, tope);
    const motivo = previo ?? (uso ? motivoSinIA({ iaActivaEmpresa: ajustes.iaActiva }, uso) : null);
    sendOk(res, {
      iaDisponible: !motivo,
      iaActivaEmpresa: ajustes.iaActiva,
      ...(motivo ? { motivo, textoMotivo: TEXTO_MOTIVO[motivo] } : {}),
      // El uso y el gasto solo los ven los administradores.
      ...(ctx.esAdminEmpresa && uso
        ? {
            usoMes: {
              gastoMesEur: uso.gastoMesEur,
              topeMesEur: uso.topeMesEur,
              porcentajeMes: uso.porcentajeMes,
              avisoTope: uso.avisoTope,
              consultasEmpresaHoy: uso.consultasEmpresaHoy,
              topeEmpresaDia: uso.topeEmpresaDia,
              consultasEmpresaMes: uso.consultasEmpresaMes,
              gastoEmpresaMesEur: uso.gastoEmpresaMesEur,
            },
          }
        : {}),
    });
  }),

  // GET /companies/:companyId/chat-assistant/ajustes (admin de la empresa)
  getAjustes: asyncHandler(async (req, res) => {
    const ajustes = await leerAjustes(req.companyId!);
    sendOk(res, { ...ajustes, topeGeneralDia: config.carmen.topeEmpresaDia, llmActivoPlataforma: config.carmen.llmActivo });
  }),

  // PUT /companies/:companyId/chat-assistant/ajustes (admin de la empresa)
  putAjustes: asyncHandler(async (req, res) => {
    sendOk(res, await guardarAjustes(req.companyId!, req.user!.userId, req.body ?? {}));
  }),

  // GET /companies/:companyId/chat-assistant/uso (admin de la empresa)
  uso: asyncHandler(async (req, res) => {
    const ctx = contexto(req);
    const ajustes = await leerAjustes(ctx.companyId);
    const uso = await leerUso(ctx.companyId, ctx.userId, ctx.hoy, topeEmpresaDia(ajustes));
    sendOk(res, {
      mes: ctx.hoy.slice(0, 7),
      consultasEmpresaMes: uso.consultasEmpresaMes,
      gastoEmpresaMesEur: uso.gastoEmpresaMesEur,
      consultasEmpresaHoy: uso.consultasEmpresaHoy,
      topeEmpresaDia: uso.topeEmpresaDia,
      porcentajeTopeGlobal: uso.porcentajeMes,
      avisoTope: uso.avisoTope,
    });
  }),

  // GET /cron/carmen-purga (Vercel Cron, una vez al día): borra lo caducado de todas las empresas.
  cronPurga: asyncHandler(async (req, res) => {
    const secreto = config.cronSecret;
    if (!secreto) throw new HttpError(503, 'La tarea programada no está configurada (CRON_SECRET).');
    const recibido = Buffer.from(req.get('authorization') ?? '');
    const esperado = Buffer.from(`Bearer ${secreto}`);
    if (recibido.length !== esperado.length || !timingSafeEqual(recibido, esperado)) throw new HttpError(401, 'No autorizado.');
    const borrados = await purgarTodas();
    logger.info(`carmen: purga diaria, ${borrados} mensajes caducados borrados`);
    sendOk(res, { borrados });
  }),
};
