import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { prisma } from '../config/database';
import { cambiarInterruptorRed, estadoRedEmpresa, leerInterruptorRed, type EstadoInterruptor } from '../services/verifactu/redSeguridad';

/** Estado del interruptor con el email de quien lo cambio (no su id). */
async function conQuien(estado: EstadoInterruptor) {
  const quien = estado.cambiadoPor
    ? await prisma.user.findUnique({ where: { id: estado.cambiadoPor }, select: { email: true } })
    : null;
  return { ...estado, cambiadoPor: quien?.email ?? null };
}

export const verifactuController = {
  /** GET /companies/:companyId/verifactu/red-seguridad: si la red bloquea la emision y el aviso previo. */
  estadoRedEmpresa: asyncHandler(async (req, res) => {
    sendOk(res, await estadoRedEmpresa(req.companyId!));
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
