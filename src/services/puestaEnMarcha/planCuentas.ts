import { randomUUID } from 'crypto';
import { prisma } from '../../config/database';
import { PGC_BASE } from '../../domain/pgc-model';
import { asegurarPlanContableEmpresa } from '../chart-of-accounts.service';
import type { Tx } from './asientosEnBloque';

/**
 * Cuentas que trae un fichero y que no estan en el plan de la empresa: se dan
 * de alta como subcuentas propias colgando de su cuenta del PGC (la de codigo
 * mas largo que sea prefijo suyo: 4300000001 -> 430).
 */

interface InfoCuenta {
  nombre: string;
}

export interface CuentaNueva {
  codigo: string;
  nombre: string;
  padre: string;
}

export interface AnalisisCuentas {
  /** Nombre en el plan (o el del fichero si es nueva), por codigo. */
  nombres: Map<string, string>;
  nuevas: CuentaNueva[];
  errores: string[];
}

/** Plan de la empresa mas el PGC base (por si aun no se ha copiado a la empresa). */
async function cargarPlan(companyId: string): Promise<Map<string, InfoCuenta>> {
  const plan = new Map<string, InfoCuenta>();
  for (const n of PGC_BASE) plan.set(n.code, { nombre: n.name });
  if (typeof (prisma as { chartOfAccounts?: { findMany?: unknown } }).chartOfAccounts?.findMany === 'function') {
    const filas = await prisma.chartOfAccounts.findMany({ where: { companyId }, select: { codigo: true, nombre: true } });
    for (const f of filas) plan.set(f.codigo, { nombre: f.nombre });
  }
  return plan;
}

/** Cuenta del plan de la que cuelga un codigo nuevo (prefijo mas largo, minimo 3 digitos). */
function buscarPadre(codigo: string, plan: Map<string, InfoCuenta>): string | null {
  for (let l = codigo.length - 1; l >= 3; l--) {
    const p = codigo.slice(0, l);
    if (plan.has(p)) return p;
  }
  return null;
}

export async function analizarCuentas(companyId: string, cuentas: Array<{ codigo: string; nombre: string }>): Promise<AnalisisCuentas> {
  const plan = await cargarPlan(companyId);
  const nombres = new Map<string, string>();
  const nuevas: CuentaNueva[] = [];
  const errores: string[] = [];
  const vistas = new Set<string>();
  for (const c of cuentas) {
    if (vistas.has(c.codigo)) continue;
    vistas.add(c.codigo);
    const enPlan = plan.get(c.codigo);
    if (enPlan) {
      nombres.set(c.codigo, c.nombre || enPlan.nombre);
      continue;
    }
    if (!/^[1-7]/.test(c.codigo)) {
      errores.push(`La cuenta ${c.codigo} es de los grupos 8 o 9 (o no es del PGC): no se puede importar en el balance ni en la cuenta de resultados.`);
      continue;
    }
    const padre = buscarPadre(c.codigo, plan);
    if (!padre) {
      errores.push(`La cuenta ${c.codigo} no encaja en el PGC (no existe la cuenta ${c.codigo.slice(0, 3)}). Corrígela en el fichero.`);
      continue;
    }
    const nombre = c.nombre || `${plan.get(padre)!.nombre} (${c.codigo})`;
    nombres.set(c.codigo, nombre);
    nuevas.push({ codigo: c.codigo, nombre, padre });
  }
  return { nombres, nuevas, errores };
}

/** Copia el PGC a la empresa si hace falta (fuera de la transaccion: es idempotente). */
export async function prepararPlanEmpresa(companyId: string): Promise<void> {
  await asegurarPlanContableEmpresa(companyId);
}

/** Da de alta las subcuentas nuevas dentro de la transaccion. */
export async function crearCuentasNuevas(tx: Tx, companyId: string, nuevas: CuentaNueva[]): Promise<number> {
  if (nuevas.length === 0) return 0;
  const padres = await tx.chartOfAccounts.findMany({
    where: { companyId, codigo: { in: [...new Set(nuevas.map((n) => n.padre))] } },
  });
  const porCodigo = new Map(padres.map((p) => [p.codigo, p]));
  const yaEstan = new Set(
    (await tx.chartOfAccounts.findMany({ where: { companyId, codigo: { in: nuevas.map((n) => n.codigo) } }, select: { codigo: true } })).map((c) => c.codigo),
  );
  const data = [];
  for (const n of nuevas) {
    if (yaEstan.has(n.codigo)) continue;
    const p = porCodigo.get(n.padre);
    if (!p) continue; // el padre deberia existir tras prepararPlanEmpresa
    data.push({
      id: randomUUID(),
      companyId,
      codigo: n.codigo,
      nombre: n.nombre.slice(0, 190),
      grupo: p.grupo,
      nivel: p.nivel + 1,
      naturaleza: p.naturaleza,
      tipoUso: p.tipoUso,
      esBasePGC: false,
      esPersonalizadaEmpresa: true,
      parentId: p.id,
      parentCodigo: p.codigo,
      notas: 'Creada al importar datos de otro programa (puesta en marcha).',
    });
  }
  if (data.length) await tx.chartOfAccounts.createMany({ data });
  return data.length;
}
