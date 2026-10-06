import { randomUUID } from 'crypto';
import {
  CuentaContableBase,
  GrupoCuenta,
  SubcuentaEmpresa,
  SubgrupoCuenta,
} from '../domain/plan-contable.model';
import { badRequest } from '../utils/http-errors';
import { PGC_BASE } from '../domain/pgc-model';

// --- Plan base PGC-PYME (grupos 1-7) ---
// Una sola fuente: domain/pgc-model.ts (PGC_BASE). Antes este fichero tenia su
// propia copia (33 cuentas, sin tildes) y la pantalla Plan contable usaba otra
// (44 cuentas): se podia ofrecer crear una subcuenta que luego se rechazaba.

const GRUPOS_BASE: GrupoCuenta[] = PGC_BASE.filter((n) => n.level === 'group').map((n) => ({
  codigo: n.code,
  nombre: n.name,
}));

const SUBGRUPOS_BASE: SubgrupoCuenta[] = PGC_BASE.flatMap((n) =>
  n.level === 'subgroup' ? [{ codigo: n.code, nombre: n.name, grupoCodigo: n.groupCode }] : [],
);

const CUENTAS_BASE: CuentaContableBase[] = PGC_BASE.flatMap((n) =>
  n.level === 'account' ? [{ codigo: n.code, nombre: n.name, subgrupoCodigo: n.subgroupCode, tipo: n.type }] : [],
);

export function listarGruposBase(): GrupoCuenta[] {
  return GRUPOS_BASE;
}
export function listarSubgruposBase(): SubgrupoCuenta[] {
  return SUBGRUPOS_BASE;
}
export function listarCuentasBase(): CuentaContableBase[] {
  return CUENTAS_BASE;
}

// --- Subcuentas por empresa: almacenamiento en memoria. ---
//
// PENDIENTE BLOQUEADO (no resuelto en esta ronda): existe un sistema PARALELO ya
// persistido en Prisma para el mismo concepto — modelo ChartOfAccounts +
// chart-of-accounts.service.ts (montado en /accounting/chart-of-accounts), con
// jerarquia, version PGC y distincion base/personalizada de empresa. Esta
// implementacion en memoria (montada en /plan-contable) es la que usa hoy el
// frontend vanilla (frontend/), por lo que NO se ha podido retirar sin antes
// decidir cual de los dos sistemas es el canonico y migrar datos/consumidores.
// Mientras se decide, se bloquea en produccion para evitar perdida silenciosa de
// subcuentas personalizadas en cada reinicio.
// NOTA (deploy Vercel): el guard que LANZABA en produccion se ha rebajado a
// AVISO para permitir el despliegue. El almacenamiento sigue siendo en memoria
// (no persiste en serverless): pendiente consolidar /plan-contable con el modelo
// ChartOfAccounts (ya en Prisma) o darle persistencia propia (TODO produccion).
if (process.env.NODE_ENV !== 'test') {
  console.warn(
    '\x1b[33m[planContable.service] ADVERTENCIA: subcuentas de empresa en memoria. Se perderan al reiniciar.\x1b[0m',
  );
}

const subcuentasStore = new Map<string, SubcuentaEmpresa>(); // id -> subcuenta
const ahora = (): string => new Date().toISOString();

export async function listarSubcuentasEmpresa(companyId: string): Promise<SubcuentaEmpresa[]> {
  return [...subcuentasStore.values()].filter((s) => s.companyId === companyId);
}

export async function crearSubcuentaEmpresa(
  companyId: string,
  data: Omit<SubcuentaEmpresa, 'id' | 'companyId' | 'creadoEn' | 'actualizadoEn'>,
): Promise<SubcuentaEmpresa> {
  if (!CUENTAS_BASE.some((c) => c.codigo === data.cuentaBaseCodigo)) {
    throw badRequest(`cuentaBaseCodigo '${data.cuentaBaseCodigo}' no existe en el plan base.`);
  }
  const subcuenta: SubcuentaEmpresa = { ...data, id: randomUUID(), companyId, creadoEn: ahora(), actualizadoEn: ahora() };
  subcuentasStore.set(subcuenta.id, subcuenta);
  return subcuenta;
}

export async function actualizarSubcuentaEmpresa(
  companyId: string,
  subcuentaId: string,
  data: Partial<Omit<SubcuentaEmpresa, 'id' | 'companyId' | 'creadoEn'>>,
): Promise<SubcuentaEmpresa | null> {
  const actual = subcuentasStore.get(subcuentaId);
  if (!actual || actual.companyId !== companyId) return null;
  if (data.cuentaBaseCodigo && !CUENTAS_BASE.some((c) => c.codigo === data.cuentaBaseCodigo)) {
    throw badRequest(`cuentaBaseCodigo '${data.cuentaBaseCodigo}' no existe en el plan base.`);
  }
  const actualizada: SubcuentaEmpresa = { ...actual, ...data, id: actual.id, companyId, creadoEn: actual.creadoEn, actualizadoEn: ahora() };
  subcuentasStore.set(subcuentaId, actualizada);
  return actualizada;
}

export async function desactivarSubcuentaEmpresa(companyId: string, subcuentaId: string): Promise<boolean> {
  const actual = subcuentasStore.get(subcuentaId);
  if (!actual || actual.companyId !== companyId) return false;
  actual.activa = false;
  actual.actualizadoEn = ahora();
  return true;
}

/**
 * Alta rapida de una subcuenta de GASTO para concretar mejor el gasto (ej.
 * '6270001 Luz oficina', '6270002 Luz almacen'). Valida que la cuenta base es de
 * tipo 'gasto' y genera un codigo correlativo a partir del codigo base.
 *
 * @param cuentaBaseCodigo cuenta base PGC de gasto (ej. '627', '628', '629').
 * @param nombre           descripcion de la subcuenta.
 * @param sufijoOpcional   si se aporta y es numerico, fija el correlativo; si no,
 *                         se autogenera el siguiente disponible.
 */
export async function crearSubcuentaGastoEmpresa(
  companyId: string,
  cuentaBaseCodigo: string,
  nombre: string,
  sufijoOpcional?: string,
): Promise<SubcuentaEmpresa> {
  const base = CUENTAS_BASE.find((c) => c.codigo === cuentaBaseCodigo);
  if (!base) throw badRequest(`cuentaBaseCodigo '${cuentaBaseCodigo}' no existe en el plan base.`);
  if (base.tipo !== 'gasto') throw badRequest(`La cuenta '${cuentaBaseCodigo}' no es de tipo gasto (es '${base.tipo}').`);

  // Longitud objetivo de subcuenta (PGC PYME suele usar 7). El codigo se forma
  // como cuentaBase + correlativo, rellenando a la derecha hasta LONG_SUBCUENTA.
  const LONG_SUBCUENTA = 7;
  const existentes = [...subcuentasStore.values()].filter(
    (s) => s.companyId === companyId && s.cuentaBaseCodigo === cuentaBaseCodigo,
  );

  let correlativo: string;
  if (sufijoOpcional && /^\d+$/.test(sufijoOpcional)) {
    correlativo = sufijoOpcional;
  } else {
    correlativo = String(existentes.length + 1);
  }
  const digitosCorrelativo = LONG_SUBCUENTA - cuentaBaseCodigo.length;
  let codigo = (cuentaBaseCodigo + correlativo.padStart(Math.max(1, digitosCorrelativo), '0')).slice(0, LONG_SUBCUENTA);

  // Evita colisiones de codigo subiendo el correlativo.
  let intento = existentes.length + 1;
  while (existentes.some((s) => s.codigo === codigo) || [...subcuentasStore.values()].some((s) => s.companyId === companyId && s.codigo === codigo)) {
    codigo = (cuentaBaseCodigo + String(++intento).padStart(Math.max(1, digitosCorrelativo), '0')).slice(0, LONG_SUBCUENTA);
  }

  return crearSubcuentaEmpresa(companyId, { codigo, nombre, cuentaBaseCodigo, activa: true });
}

// INTEGRACION FUTURA con contabilidadReglas.service:
// - Al crear ficha de cliente/proveedor -> crearSubcuentaEmpresa('430xxxxx'|'400xxxxx').
// - El motor de asientos resolvera cliente/proveedor/ventas/compras/IVA/tesoreria
//   contra SubcuentaEmpresa (validando que existe y esta activa) en vez de codigos fijos.
