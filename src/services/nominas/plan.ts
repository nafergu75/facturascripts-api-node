/**
 * Cuentas de las nominas en el plan de la empresa: longitud de los codigos,
 * subcuentas de 640/642/476/4751... y la subcuenta 465 propia de cada
 * trabajador (colgando de la 465, con su nombre), igual que la puesta en
 * marcha da de alta las subcuentas que trae un fichero.
 */
import { randomUUID } from 'crypto';
import { prisma, type TransaccionBD } from '../../config/database';
import type { CuentasNominas } from '../../domain/nominas.model';
import { obtenerReglas } from '../reglasContables.service';
import { crearCuentasNuevas, prepararPlanEmpresa, type CuentaNueva } from '../puestaEnMarcha/planCuentas';
import { longitudMasHabitual, NOMBRES_CUENTAS, resolverCuentasNominas, siguienteSubcuenta465 } from './calculo';

/**
 * Longitud de los codigos de la empresa: la mas habitual entre los de sus
 * asientos y sus subcuentas propias (hoy conviven 3, 6 y 10 digitos; usar otra
 * longitud duplicaria cuentas en el mayor). Sin datos, 6.
 */
export async function longitudCuentasEmpresa(companyId: string, db: TransaccionBD | typeof prisma = prisma): Promise<number> {
  const [lineas, propias] = await Promise.all([
    db.journalEntryLine.findMany({ where: { companyId }, distinct: ['accountCode'], select: { accountCode: true }, take: 5000 }),
    db.chartOfAccounts.findMany({ where: { companyId, esPersonalizadaEmpresa: true }, select: { codigo: true }, take: 5000 }),
  ]);
  return longitudMasHabitual([...lineas.map((l) => l.accountCode), ...propias.map((c) => c.codigo)]);
}

/** Cuentas de nominas de la empresa (reglas contables + longitud de su plan). */
export async function cuentasNominasEmpresa(companyId: string): Promise<{ cuentas: CuentasNominas; longitud: number }> {
  const [reglas, longitud] = await Promise.all([obtenerReglas(companyId), longitudCuentasEmpresa(companyId)]);
  return { cuentas: resolverCuentasNominas(reglas.nominas, longitud), longitud };
}

/** Cuentas del PGC que usan las nominas y no estan en el plan base de la app. */
const CUENTAS_PGC_QUE_FALTAN: Record<string, string> = {
  '460': 'Anticipos de remuneraciones',
  '471': 'Organismos de la Seguridad Social, deudores',
};

/**
 * Da de alta en el plan las subcuentas de nominas que falten (fuera de la 465
 * de cada trabajador), colgando de su cuenta del PGC (la de codigo mas largo que
 * sea prefijo suyo), como la puesta en marcha. Si falta la propia cuenta del PGC
 * (460, 471), se crea antes bajo su subgrupo. Antes, fuera de la transaccion:
 * prepararPlanEmpresa(companyId).
 */
export async function asegurarCuentasNominas(tx: TransaccionBD, companyId: string, cuentas: CuentasNominas, usadas: Set<string>): Promise<void> {
  // Una cuenta puede servir para dos cosas (las dietas van por defecto a la 640): una sola vez.
  const porCodigo = new Map<string, string>();
  for (const k of Object.keys(cuentas) as Array<keyof CuentasNominas>) {
    if (usadas.has(cuentas[k]) && !porCodigo.has(cuentas[k])) porCodigo.set(cuentas[k], NOMBRES_CUENTAS[k]);
  }
  const pedir = [...porCodigo].map(([codigo, nombre]) => ({ codigo, nombre }));
  if (!pedir.length) return;
  const prefijos = new Set<string>();
  for (const p of pedir) for (let l = 2; l <= p.codigo.length; l++) prefijos.add(p.codigo.slice(0, l));
  const enPlan = new Set(
    (await tx.chartOfAccounts.findMany({ where: { companyId, codigo: { in: [...prefijos] } }, select: { codigo: true } })).map((c) => c.codigo),
  );
  for (const [codigo, nombre] of Object.entries(CUENTAS_PGC_QUE_FALTAN)) {
    if (enPlan.has(codigo) || !pedir.some((p) => p.codigo.startsWith(codigo))) continue;
    const subgrupo = await tx.chartOfAccounts.findFirst({ where: { companyId, codigo: codigo.slice(0, 2) } });
    await tx.chartOfAccounts.create({
      data: {
        id: randomUUID(),
        companyId,
        codigo,
        nombre,
        grupo: Number(codigo[0]),
        nivel: 3,
        naturaleza: codigo === '460' || codigo === '471' ? 'ACTIVO' : (subgrupo?.naturaleza ?? 'PASIVO'),
        tipoUso: 'BALANCE',
        esBasePGC: true,
        esPersonalizadaEmpresa: false,
        parentId: subgrupo?.id ?? null,
        parentCodigo: subgrupo?.codigo ?? codigo.slice(0, 2),
      },
    });
    enPlan.add(codigo);
  }
  const nuevas: CuentaNueva[] = [];
  for (const p of pedir) {
    if (enPlan.has(p.codigo)) continue;
    let padre: string | null = null;
    for (let l = p.codigo.length - 1; l >= 3 && !padre; l--) if (enPlan.has(p.codigo.slice(0, l))) padre = p.codigo.slice(0, l);
    if (padre) nuevas.push({ codigo: p.codigo, nombre: p.nombre, padre });
  }
  await crearCuentasNuevas(tx, companyId, nuevas);
}

export { prepararPlanEmpresa };

export interface TrabajadorPlan {
  id: string;
  nombreCompleto: string;
  subcuenta465: string | null;
}

/**
 * Subcuenta 465 del trabajador: la que ya tiene o una nueva (siguiente libre),
 * creada en el plan con su nombre y guardada en su ficha. Dentro de la
 * transaccion: si dos procesos eligen el mismo codigo, el indice unico del plan
 * hace fallar a uno y la transaccion se reintenta.
 */
export async function asegurarSubcuenta465(
  tx: TransaccionBD,
  companyId: string,
  trabajador: TrabajadorPlan,
  cuentas: CuentasNominas,
  longitud: number,
  ocupadas: Set<string>,
): Promise<string> {
  if (trabajador.subcuenta465) {
    const existe = await tx.chartOfAccounts.findFirst({ where: { companyId, codigo: trabajador.subcuenta465 }, select: { id: true } });
    if (!existe) await crearSubcuenta465(tx, companyId, trabajador.subcuenta465, trabajador.nombreCompleto);
    return trabajador.subcuenta465;
  }
  const codigo = siguienteSubcuenta465(ocupadas, longitud, cuentas);
  ocupadas.add(codigo);
  await crearSubcuenta465(tx, companyId, codigo, trabajador.nombreCompleto);
  await tx.empleado.update({ where: { id: trabajador.id }, data: { subcuenta465: codigo } });
  trabajador.subcuenta465 = codigo;
  return codigo;
}

async function crearSubcuenta465(tx: TransaccionBD, companyId: string, codigo: string, nombre: string): Promise<void> {
  const padre =
    (await tx.chartOfAccounts.findFirst({ where: { companyId, codigo: '465' } })) ??
    (await tx.chartOfAccounts.findFirst({ where: { companyId, codigo: { in: ['46', '4'] } }, orderBy: { codigo: 'desc' } }));
  await tx.chartOfAccounts.create({
    data: {
      id: randomUUID(),
      companyId,
      codigo,
      nombre: nombre.slice(0, 190) || `Trabajador ${codigo}`,
      grupo: 4,
      nivel: (padre?.nivel ?? 3) + 1,
      naturaleza: padre?.naturaleza ?? 'PASIVO',
      tipoUso: padre?.tipoUso ?? 'BALANCE',
      esBasePGC: false,
      esPersonalizadaEmpresa: true,
      parentId: padre?.id ?? null,
      parentCodigo: padre?.codigo ?? '465',
      notas: 'Remuneraciones pendientes de pago del trabajador (creada al contabilizar sus nóminas).',
    },
  });
}

/** Codigos 465 ya usados en el plan o asignados a trabajadores de la empresa. */
export async function subcuentas465Ocupadas(tx: TransaccionBD, companyId: string): Promise<Set<string>> {
  const [plan, empleados] = await Promise.all([
    tx.chartOfAccounts.findMany({ where: { companyId, codigo: { startsWith: '465' } }, select: { codigo: true } }),
    tx.empleado.findMany({ where: { companyId, subcuenta465: { not: null } }, select: { subcuenta465: true } }),
  ]);
  return new Set([...plan.map((c) => c.codigo), ...empleados.map((e) => e.subcuenta465!)]);
}

/** Cambia el nombre de la subcuenta 465 del trabajador en el plan (al cambiar su nombre). */
export async function renombrarSubcuenta465(companyId: string, codigo: string | null, nombre: string): Promise<void> {
  if (!codigo) return;
  await prisma.chartOfAccounts.updateMany({ where: { companyId, codigo, esPersonalizadaEmpresa: true }, data: { nombre: nombre.slice(0, 190) } });
}
