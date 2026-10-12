/**
 * Aviso antes de dar de alta el primer cliente o proveedor sin haber traido el
 * plan de cuentas de la gestoria.
 *
 * El plan de 2026 fija la longitud de las subcuentas de clientes y
 * proveedores. Si se da de alta un tercero antes, su subcuenta sale con 8
 * digitos y deja de seguir la numeracion que usaba la gestoria. Por eso, en
 * una empresa española sin ninguna ficha de cliente ni de proveedor, sin plan
 * anterior traido (ni con la puesta en marcha ni con «Traer la contabilidad de
 * 2026») y sin carga confirmada, el primer alta da 409 y pide confirmacion.
 *
 * Con la confirmacion (confirmarSinPlanAnterior) sigue: queda la marca
 * altaSinPlanAnterior en las reglas contables y AuditLog
 * ALTA_SIN_PLAN_ANTERIOR, y ya no vuelve a preguntar.
 *
 * Las empresas extranjeras no lo ven. El traslado del plan y la carga no lo
 * llaman (son justo lo que se recomienda hacer).
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { conflict } from '../../utils/http-errors';
import { registrarAuditoria } from '../auditoria.service';
import { ENLACE_ARRANQUE } from '../periodos.service';
import { esEmpresaEspanola } from '../perfilEmpresa.service';

export const CODIGO_PLAN_ANTERIOR_PENDIENTE = 'PLAN_ANTERIOR_PENDIENTE';

export const TEXTO_PLAN_ANTERIOR_PENDIENTE =
  'Antes de dar de alta el primer cliente o proveedor conviene traer el plan de cuentas de 2026 de tu gestoría. Si no, sus subcuentas empezarán con 8 dígitos y no seguirán la numeración que usaba la gestoría.';

/** true si el alta de un tercero en esta empresa tiene que pedir confirmacion. */
export async function faltaPlanAnterior(companyId: string): Promise<boolean> {
  const [cliente, proveedor] = await Promise.all([
    prisma.customer.findFirst({ where: { companyId }, select: { id: true } }),
    prisma.supplier.findFirst({ where: { companyId }, select: { id: true } }),
  ]);
  if (cliente || proveedor) return false;
  if (!(await esEmpresaEspanola(companyId))) return false;
  const [reglas, planPuestaEnMarcha, carga] = await Promise.all([
    prisma.reglasContables.findUnique({ where: { companyId }, select: { data: true } }),
    prisma.auditLog.count({ where: { companyId, action: 'IMPORTAR_PLAN_ANTERIOR' } }),
    prisma.cargaArranque.count({ where: { companyId, estado: 'CONFIRMADA' } }),
  ]);
  const data = (reglas?.data ?? {}) as { planAnterior?: unknown; altaSinPlanAnterior?: unknown };
  return !(data.planAnterior || data.altaSinPlanAnterior || planPuestaEnMarcha || carga);
}

/** Lee la marca de confirmacion del cuerpo (JSON o formulario). */
export const confirmadoSinPlanAnterior = (v: unknown): boolean => v === true || v === 'true' || v === '1';

/**
 * 409 PLAN_ANTERIOR_PENDIENTE si hace falta confirmar; con la confirmacion,
 * guarda la marca y sigue.
 */
export async function exigirPlanAnteriorAntesDeAlta(companyId: string, confirmado: boolean, userId: string): Promise<void> {
  if (!(await faltaPlanAnterior(companyId))) return;
  if (!confirmado) throw conflict(TEXTO_PLAN_ANTERIOR_PENDIENTE, { codigo: CODIGO_PLAN_ANTERIOR_PENDIENTE, enlace: ENLACE_ARRANQUE });
  const marca = { userId, fecha: new Date().toISOString() };
  const reglas = await prisma.reglasContables.findUnique({ where: { companyId }, select: { data: true } });
  const data = { ...((reglas?.data ?? {}) as Record<string, unknown>), altaSinPlanAnterior: marca } as Prisma.InputJsonValue;
  await prisma.reglasContables.upsert({ where: { companyId }, update: { data }, create: { companyId, data } });
  await registrarAuditoria({ userId, companyId, action: 'ALTA_SIN_PLAN_ANTERIOR', resourceType: 'ReglasContables', resourceId: companyId, meta: marca });
}
