import { badRequest, notFound } from '../utils/http-errors';
import { randomUUID } from 'crypto';
import { prisma } from '../config/database';
import { PGC_BASE, PgcNode } from '../domain/pgc-model';

export interface CrearCuentaDTO {
  companyId: string;
  codigo: string;
  nombre: string;
  parentCodigo: string;
  naturaleza: string;
  tipoUso: string;
  notas?: string;
}

// --- Plan de cuentas de cada empresa ---
//
// Sale de la misma lista que el plan base (domain/pgc-model.ts, PGC_BASE). Antes
// este fichero tenia una tercera copia, con nombres cambiados (620 "transporte",
// 622 "arrendamiento"...) y sin cuentas que usa el motor contable (473, 4751,
// 628...): contabilizar una factura fallaba con "Cuenta PGC ... no encontrada".

const NIVEL: Record<PgcNode['level'], number> = { group: 1, subgroup: 2, account: 3, subaccount: 4 };

/** Grupos 1-5 van al balance; 6 y 7, a la cuenta de perdidas y ganancias. */
function tipoUsoDe(grupo: number): string {
  return grupo >= 6 ? 'PYG' : 'BALANCE';
}

export interface ResultadoPlanEmpresa {
  creadas: number;
  renombradas: number;
}

/**
 * Deja el plan de cuentas de la empresa al dia con el plan base: crea las cuentas
 * que falten y corrige el nombre de las del PGC que lo tengan distinto. No toca
 * las subcuentas propias de la empresa. Se puede llamar las veces que haga falta.
 */
export async function asegurarPlanContableEmpresa(
  companyId: string,
  versionPGC: string = '2021',
  gruposAIncluir: number[] = [1, 2, 3, 4, 5, 6, 7],
): Promise<ResultadoPlanEmpresa> {
  const empresa = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
  if (!empresa) throw badRequest('Empresa no encontrada.');

  // versionPGC es clave ajena a ChartOfAccountsVersion.
  await prisma.chartOfAccountsVersion.upsert({
    where: { version: versionPGC },
    update: {},
    create: { version: versionPGC, descripcion: `PGC PYMES (RD 1515/2007), revisión ${versionPGC}` },
  });

  const nodos = PGC_BASE.filter((n) => gruposAIncluir.includes(Number(n.code[0])));
  const existentes = await prisma.chartOfAccounts.findMany({
    where: { companyId, codigo: { in: nodos.map((n) => n.code) } },
    select: { id: true, codigo: true, nombre: true, esBasePGC: true },
  });
  const idPorCodigo = new Map(existentes.map((c) => [c.codigo, c.id]));

  // PGC_BASE va ordenado por codigo: el padre siempre aparece antes que el hijo.
  const nuevas = [];
  for (const n of nodos) {
    if (idPorCodigo.has(n.code)) continue;
    const id = randomUUID();
    idPorCodigo.set(n.code, id);
    const grupo = Number(n.code[0]);
    nuevas.push({
      id,
      companyId,
      codigo: n.code,
      nombre: n.name,
      grupo,
      nivel: NIVEL[n.level],
      naturaleza: n.type.toUpperCase(),
      tipoUso: tipoUsoDe(grupo),
      esBasePGC: true,
      esPersonalizadaEmpresa: false,
      versionPGC,
      parentCodigo: n.parentCode ?? null,
      parentId: n.parentCode ? idPorCodigo.get(n.parentCode) ?? null : null,
    });
  }
  if (nuevas.length) await prisma.chartOfAccounts.createMany({ data: nuevas });

  const nombreOficial = new Map(nodos.map((n) => [n.code, n.name]));
  const aRenombrar = existentes.filter((c) => c.esBasePGC && c.nombre !== nombreOficial.get(c.codigo));
  for (const c of aRenombrar) {
    await prisma.chartOfAccounts.update({ where: { id: c.id }, data: { nombre: nombreOficial.get(c.codigo)! } });
  }

  return { creadas: nuevas.length, renombradas: aRenombrar.length };
}

/** Alias historico (tests y llamadas antiguas). Ya no falla si el plan existe. */
export const inicializarPlanContableEmpresa = asegurarPlanContableEmpresa;

/**
 * Listar plan contable con filtros.
 */
export async function listarPlanContable(
  companyId: string,
  filtros?: {
    grupo?: number;
    nivel?: number;
    naturaleza?: string;
    soloActivas?: boolean;
  },
) {
  const where: any = { companyId };

  if (filtros?.grupo) where.grupo = filtros.grupo;
  if (filtros?.nivel) where.nivel = filtros.nivel;
  if (filtros?.naturaleza) where.naturaleza = filtros.naturaleza;
  if (filtros?.soloActivas) where.activo = true;

  const cuentas = await prisma.chartOfAccounts.findMany({
    where,
    include: { children: true },
    orderBy: [{ grupo: 'asc' }, { codigo: 'asc' }],
  });

  return cuentas;
}

/**
 * Obtener una cuenta por código.
 */
export async function obtenerCuentaPorCodigo(
  companyId: string,
  codigo: string,
) {
  const cuenta = await prisma.chartOfAccounts.findFirst({
    where: { companyId, codigo },
    include: { children: true },
  });

  if (!cuenta) throw notFound(`Cuenta ${codigo} no encontrada.`);
  return cuenta;
}

/**
 * Crear subcuenta personalizada.
 */
export async function crearSubcuentaPersonalizada(
  dtoEntrada: CrearCuentaDTO,
) {
  const codigo = String(dtoEntrada.codigo ?? '').trim();
  const nombre = String(dtoEntrada.nombre ?? '').trim();
  const parentCodigo = String(dtoEntrada.parentCodigo ?? '').trim();
  if (!codigo || !nombre || !parentCodigo) throw badRequest('codigo, nombre y parentCodigo son obligatorios.');
  // En el PGC una subcuenta amplia el codigo de su cuenta: 6290001 cuelga de 629.
  if (!/^\d+$/.test(codigo) || !codigo.startsWith(parentCodigo) || codigo.length <= parentCodigo.length) {
    throw badRequest(`El código ${codigo} tiene que empezar por ${parentCodigo} y ser más largo (solo dígitos).`);
  }
  const dto: CrearCuentaDTO = { ...dtoEntrada, codigo, nombre, parentCodigo };

  // Validar que el padre existe
  const padre = await prisma.chartOfAccounts.findFirst({
    where: { companyId: dto.companyId, codigo: dto.parentCodigo },
  });
  if (!padre) throw badRequest(`Cuenta padre ${dto.parentCodigo} no encontrada.`);

  // Validar que no existe ya
  const existe = await prisma.chartOfAccounts.findFirst({
    where: { companyId: dto.companyId, codigo: dto.codigo },
  });
  if (existe) throw badRequest(`Cuenta ${dto.codigo} ya existe.`);

  // Determinar nivel (padre.nivel + 1)
  const nivel = padre.nivel + 1;

  const nueva = await prisma.chartOfAccounts.create({
    data: {
      companyId: dto.companyId,
      codigo: dto.codigo,
      nombre: dto.nombre,
      grupo: padre.grupo,
      nivel,
      naturaleza: dto.naturaleza || padre.naturaleza,
      tipoUso: dto.tipoUso || padre.tipoUso,
      esBasePGC: false,
      esPersonalizadaEmpresa: true,
      parentId: padre.id,
      parentCodigo: padre.codigo,
      notas: dto.notas,
    },
  });

  return nueva;
}

/**
 * Actualizar cuenta (solo personalizadas).
 */
export async function actualizarCuenta(
  id: string,
  companyId: string,
  datos: { nombre?: string; activo?: boolean; notas?: string },
) {
  const cuenta = await prisma.chartOfAccounts.findFirst({
    where: { id, companyId },
  });

  if (!cuenta) throw notFound('Cuenta no encontrada.');
  if (cuenta.esBasePGC && datos.nombre) {
    throw badRequest('No se puede editar el nombre de cuentas del PGC base.');
  }

  const actualizada = await prisma.chartOfAccounts.update({
    where: { id },
    data: datos,
  });

  return actualizada;
}

/**
 * Obtener estructura jerárquica completa (árbol).
 */
export async function obtenerArbolPlanContable(
  companyId: string,
  grupoFilro?: number,
) {
  const grupos = await prisma.chartOfAccounts.findMany({
    where: {
      companyId,
      nivel: 1,
      ...(grupoFilro && { grupo: grupoFilro }),
    },
    include: {
      children: {
        include: {
          children: {
            include: {
              children: true,
            },
          },
        },
      },
    },
    orderBy: { codigo: 'asc' },
  });

  return grupos;
}

export const chartOfAccountsService = {
  inicializarPlanContableEmpresa,
  asegurarPlanContableEmpresa,
  listarPlanContable,
  obtenerCuentaPorCodigo,
  crearSubcuentaPersonalizada,
  actualizarCuenta,
  obtenerArbolPlanContable,
};
