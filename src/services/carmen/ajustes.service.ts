/**
 * Ajustes de Carmen por empresa: interruptor de la IA (apagado por defecto),
 * tope propio de preguntas diarias a la IA y días que se guardan las
 * conversaciones. Solo los cambia un administrador de la empresa o el admin
 * global (la ruta lleva authorize('admin:empresa')).
 */
import { z } from 'zod';
import { prisma } from '../../config/database';
import { config } from '../../config/env';
import { badRequest } from '../../utils/http-errors';

export const CONSERVAR_DIAS_DEFECTO = 90;
/** Las conversaciones se pueden guardar menos tiempo, nunca más de 90 días. */
export const CONSERVAR_DIAS_MAX = 90;
export const CONSERVAR_DIAS_MIN = 7;

export interface AjustesCarmen {
  iaActiva: boolean;
  /** Tope propio de la empresa; null = el general. */
  topeConsultasDia: number | null;
  conservarDias: number;
  actualizadoPor?: string | null;
  actualizadoEn?: string | null;
}

export async function leerAjustes(companyId: string): Promise<AjustesCarmen> {
  const fila = await prisma.carmenAjustes.findUnique({ where: { companyId } });
  if (!fila) return { iaActiva: false, topeConsultasDia: null, conservarDias: CONSERVAR_DIAS_DEFECTO };
  return {
    iaActiva: fila.iaActiva,
    topeConsultasDia: fila.topeConsultasDia,
    conservarDias: Math.min(CONSERVAR_DIAS_MAX, Math.max(CONSERVAR_DIAS_MIN, fila.conservarDias)),
    actualizadoPor: fila.actualizadoPor,
    actualizadoEn: fila.actualizadoEn.toISOString(),
  };
}

/** Tope de preguntas diarias a la IA que se aplica a la empresa (el propio, sin pasar del general). */
export function topeEmpresaDia(ajustes: Pick<AjustesCarmen, 'topeConsultasDia'>): number {
  const general = config.carmen.topeEmpresaDia;
  return ajustes.topeConsultasDia ? Math.min(ajustes.topeConsultasDia, general) : general;
}

export const esquemaAjustes = z
  .object({
    iaActiva: z.boolean().optional(),
    topeConsultasDia: z.number().int().min(1).nullable().optional(),
    conservarDias: z.number().int().min(CONSERVAR_DIAS_MIN).max(CONSERVAR_DIAS_MAX).optional(),
  })
  .strict();

export async function guardarAjustes(companyId: string, userId: string, entrada: unknown): Promise<AjustesCarmen> {
  const r = esquemaAjustes.safeParse(entrada);
  if (!r.success) throw badRequest('Ajustes de Carmen no válidos.', r.error.flatten().fieldErrors);
  const cambios = r.data;
  if (cambios.topeConsultasDia && cambios.topeConsultasDia > config.carmen.topeEmpresaDia) {
    throw badRequest(`El tope de la empresa no puede pasar del general (${config.carmen.topeEmpresaDia} preguntas al día).`);
  }
  await prisma.carmenAjustes.upsert({
    where: { companyId },
    create: {
      companyId,
      iaActiva: cambios.iaActiva ?? false,
      topeConsultasDia: cambios.topeConsultasDia ?? null,
      conservarDias: cambios.conservarDias ?? CONSERVAR_DIAS_DEFECTO,
      actualizadoPor: userId,
    },
    update: {
      ...(cambios.iaActiva !== undefined ? { iaActiva: cambios.iaActiva } : {}),
      ...(cambios.topeConsultasDia !== undefined ? { topeConsultasDia: cambios.topeConsultasDia } : {}),
      ...(cambios.conservarDias !== undefined ? { conservarDias: cambios.conservarDias } : {}),
      actualizadoPor: userId,
    },
  });
  return leerAjustes(companyId);
}
