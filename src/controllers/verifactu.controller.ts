import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { prisma } from '../config/database';
import {
  cambiarInterruptorRed,
  estadoRedEmpresa,
  fijarExclusion,
  leerExclusion,
  leerInterruptorRed,
  type EstadoInterruptor,
} from '../services/verifactu/redSeguridad';
import { borrarCertificado, subirCertificado } from '../services/verifactu/certificado.service';
import { probarConexion } from '../services/verifactu/conexion.service';
import { configuracionVerifactu } from '../services/verifactu/configuracion.service';

/** Estado del interruptor con el email de quien lo cambio (no su id). */
async function conQuien(estado: EstadoInterruptor) {
  const quien = estado.cambiadoPor
    ? await prisma.user.findUnique({ where: { id: estado.cambiadoPor }, select: { email: true } })
    : null;
  return { ...estado, cambiadoPor: quien?.email ?? null };
}

export const verifactuController = {
  /** GET /companies/:companyId/verifactu/configuracion (administrador de la empresa): la pantalla Configuracion > VERI*FACTU. */
  configuracion: asyncHandler(async (req, res) => {
    sendOk(res, await configuracionVerifactu(req.companyId!));
  }),

  /**
   * PUT /companies/:companyId/verifactu/certificado (config:write), multipart:
   * `certificado` (el .pfx/.p12), `contrasena` y, si el titular no es la
   * empresa, `actuaComo` (APODERADO | COLABORADOR). Nunca devuelve el
   * certificado ni la contraseña.
   */
  subirCertificado: asyncHandler(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    sendOk(res, await subirCertificado(req.companyId!, req.user!.userId, { pfx: req.file?.buffer, contrasena: b.contrasena, actuaComo: b.actuaComo }));
  }),

  /** DELETE /companies/:companyId/verifactu/certificado (config:write). Con VERI*FACTU activo, 409. */
  borrarCertificado: asyncHandler(async (req, res) => {
    sendOk(res, await borrarCertificado(req.companyId!, req.user!.userId));
  }),

  /**
   * POST /companies/:companyId/verifactu/certificado/probar (config:write).
   * Siempre contra el entorno de pruebas de la AEAT en esta fase: se ignora
   * cualquier entorno del cuerpo. Una conexion fallida tambien da 200 (ok:false).
   */
  probarConexion: asyncHandler(async (req, res) => {
    sendOk(res, { resultado: await probarConexion(req.companyId!, req.user!.userId) });
  }),

  /** GET /companies/:companyId/verifactu/red-seguridad: si la red bloquea la emision y el aviso previo. */
  estadoRedEmpresa: asyncHandler(async (req, res) => {
    sendOk(res, await estadoRedEmpresa(req.companyId!));
  }),

  /** GET /companies/:companyId/verifactu/exclusion (administrador de la empresa). */
  leerExclusion: asyncHandler(async (req, res) => {
    sendOk(res, await leerExclusion(req.companyId!));
  }),

  /**
   * PUT /companies/:companyId/verifactu/exclusion (administrador de la empresa).
   * { motivoExclusion: 'SII' | 'FORAL' | null, motivo }. La auditoria va dentro del servicio.
   */
  fijarExclusion: asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    sendOk(res, await fijarExclusion(req.companyId!, req.user!.userId, { motivoExclusion: b.motivoExclusion, motivo: b.motivo }));
  }),

  /** GET /admin/verifactu/red-seguridad (solo administrador global). */
  leerInterruptor: asyncHandler(async (_req, res) => {
    sendOk(res, await conQuien(await leerInterruptorRed()));
  }),

  /**
   * PUT /admin/verifactu/red-seguridad (solo administrador global).
   * { activa: false, referenciaBoe: 'BOE-A-AAAA-NNNNN', motivo } o { activa: true, motivo? }.
   * La auditoria va dentro del servicio, en la misma transaccion que el cambio.
   */
  cambiarInterruptor: asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    sendOk(res, await conQuien(await cambiarInterruptorRed(req.user!.userId, { activa: b.activa, referenciaBoe: b.referenciaBoe, motivo: b.motivo })));
  }),
};
