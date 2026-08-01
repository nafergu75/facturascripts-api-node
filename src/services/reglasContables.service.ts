import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { ReglasContablesEmpresa, reglasPorDefecto } from '../domain/reglas-contables.model';

/**
 * Carga las reglas contables de una empresa desde la BD propia. Si no hay
 * configuracion guardada, devuelve las reglas por defecto (PGC España). Las
 * guardadas se fusionan sobre las por defecto para tolerar configuraciones
 * parciales.
 */
export async function obtenerReglas(companyId: string): Promise<ReglasContablesEmpresa> {
  try {
    const row = await prisma.reglasContables.findUnique({ where: { companyId } });
    if (!row) return reglasPorDefecto();
    return { ...reglasPorDefecto(), ...(row.data as object) } as ReglasContablesEmpresa;
  } catch {
    // BD no disponible (tests/arranque sin MySQL): reglas por defecto.
    return reglasPorDefecto();
  }
}

/** Crea o actualiza (merge) las reglas contables de una empresa. */
export async function guardarReglas(
  companyId: string,
  reglas: Partial<ReglasContablesEmpresa>,
): Promise<ReglasContablesEmpresa> {
  const actuales = await obtenerReglas(companyId);
  const merged: ReglasContablesEmpresa = { ...actuales, ...reglas };

  await prisma.reglasContables.upsert({
    where: { companyId },
    update: { data: merged as unknown as Prisma.InputJsonValue },
    create: { companyId, data: merged as unknown as Prisma.InputJsonValue },
  });

  return merged;
}
