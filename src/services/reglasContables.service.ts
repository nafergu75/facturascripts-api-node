import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { ReglasContablesEmpresa, reglasPorDefecto } from '../domain/reglas-contables.model';
import { badRequest, conflict } from '../utils/http-errors';
import { esLongitudSubcuentasValida, LONGITUD_SUBCUENTAS_MAX, LONGITUD_SUBCUENTAS_MIN } from './terceros/numeracion';
import { haySubcuentasDeTercero, longitudSubcuentasEmpresa, longitudSubcuentasGuardada } from './terceros/subcuentas';

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
  // La longitud de las subcuentas pasa por su comprobacion (7-10 y sin subcuentas
  // asignadas) y se guarda como NUMERO: en texto ("9") se leeria como no guardada.
  if (reglas.longitudSubcuentas !== undefined) {
    reglas = { ...reglas, longitudSubcuentas: await comprobarCambioLongitud(companyId, reglas.longitudSubcuentas) };
  }
  const actuales = await obtenerReglas(companyId);
  const merged: ReglasContablesEmpresa = { ...actuales, ...reglas };

  await prisma.reglasContables.upsert({
    where: { companyId },
    update: { data: merged as unknown as Prisma.InputJsonValue },
    create: { companyId, data: merged as unknown as Prisma.InputJsonValue },
  });

  return merged;
}

// ---------------------------------------------------------------------------
// Longitud de las subcuentas de clientes y proveedores
// ---------------------------------------------------------------------------

export const TEXTO_LONGITUD_BLOQUEADA =
  'La longitud de las subcuentas ya no se puede cambiar: hay clientes o proveedores con subcuenta asignada.';

export interface EstadoLongitudSubcuentas {
  /** La que se usa (la guardada; si no, la del plan de la empresa; si no, 8). */
  longitud: number;
  /** Esta fijada en las reglas de la empresa. */
  guardada: boolean;
  /** Ya hay subcuentas de tercero: no se puede cambiar. */
  bloqueada: boolean;
  motivo: string | null;
  minimo: number;
  maximo: number;
}

export async function estadoLongitudSubcuentas(companyId: string): Promise<EstadoLongitudSubcuentas> {
  const [longitud, guardada, bloqueada] = await Promise.all([
    longitudSubcuentasEmpresa(companyId),
    longitudSubcuentasGuardada(companyId),
    haySubcuentasDeTercero(companyId),
  ]);
  return {
    longitud,
    guardada: guardada !== null,
    bloqueada,
    motivo: bloqueada ? TEXTO_LONGITUD_BLOQUEADA : null,
    minimo: LONGITUD_SUBCUENTAS_MIN,
    maximo: LONGITUD_SUBCUENTAS_MAX,
  };
}

/** 400 si no es de 7 a 10; 409 si cambia y ya hay subcuentas de tercero asignadas. */
async function comprobarCambioLongitud(companyId: string, valor: unknown): Promise<number> {
  const n = typeof valor === 'string' && /^\d+$/.test(valor.trim()) ? Number(valor) : valor;
  if (!esLongitudSubcuentasValida(n)) {
    throw badRequest(`La longitud de las subcuentas tiene que ser un número de ${LONGITUD_SUBCUENTAS_MIN} a ${LONGITUD_SUBCUENTAS_MAX} dígitos.`, {
      campo: 'longitudSubcuentas',
    });
  }
  const actual = await longitudSubcuentasEmpresa(companyId);
  if (n !== actual && (await haySubcuentasDeTercero(companyId))) {
    throw conflict(TEXTO_LONGITUD_BLOQUEADA, { campo: 'longitudSubcuentas', longitud: actual });
  }
  return n;
}

/** Fija la longitud de las subcuentas de clientes y proveedores (Configuracion). */
export async function cambiarLongitudSubcuentas(companyId: string, valor: unknown): Promise<EstadoLongitudSubcuentas> {
  const n = await comprobarCambioLongitud(companyId, valor);
  await guardarReglas(companyId, { longitudSubcuentas: n });
  return estadoLongitudSubcuentas(companyId);
}
