/**
 * Subcuenta contable propia de cada cliente (430N), proveedor (400N) y
 * acreedor (410N), con el mismo numero N en la 400 y en la 410 de un proveedor.
 *
 * - El codigo se asigna al dar de alta la ficha (en la misma transaccion) y,
 *   como red de seguridad, al contabilizar si la ficha aun no lo tiene.
 * - La cuenta se da de alta en el plan al primer uso (justo antes del primer
 *   apunte, borradores incluidos) con el NOMBRE FISCAL del tercero: el plan
 *   solo lo ven los usuarios con contabilidad:read.
 * - Todo lo que contabiliza contra 430/400/410 pasa por
 *   subcuentaClienteParaApunte o subcuentaProveedorParaApunte.
 *
 * Concurrencia: si dos transacciones eligen el mismo codigo salta el indice
 * unico de la ficha o el del plan (P2002); conReintentoSubcuenta repite la
 * transaccion entera solo ante esos indices.
 */
import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma, type TransaccionBD } from '../../config/database';
import { notFound } from '../../utils/http-errors';
import { conReintento } from '../../utils/reintento';
import { esTipoGasto, TIPO_GASTO_INFO } from '../../domain/factura-gasto.model';
import {
  codigoSubcuenta,
  esLongitudSubcuentasValida,
  esSubcuentaDeTercero,
  LONGITUD_SUBCUENTAS_DEFECTO,
  longitudEnUso,
  numeroDeSubcuenta,
  PREFIJOS_PROVEEDOR,
  siguienteNumeroTercero,
  type PrefijoTercero,
} from './numeracion';

type Db = TransaccionBD | typeof prisma;

export type TipoFicha = 'cliente' | 'proveedor';

/** Indices unicos que saltan si dos procesos sacan el mismo codigo. */
export const INDICES_SUBCUENTA = ['subcuenta430', 'subcuenta400', 'subcuenta410', 'ChartOfAccounts_companyId_codigo'];

/**
 * Repite la operacion (una transaccion entera) si dos procesos han sacado la
 * misma subcuenta. Cinco veces: con N altas a la vez, cada vuelta gana una.
 */
export function conReintentoSubcuenta<T>(fn: () => Promise<T>): Promise<T> {
  return conReintento(fn, { indices: INDICES_SUBCUENTA, intentos: 5 });
}

/** Nombre de la subcuenta en el plan y en los apuntes: el nombre fiscal (las columnas admiten 191). */
export function nombreDeSubcuenta(nombreFiscal: string, codigo: string): string {
  const n = (nombreFiscal ?? '').trim();
  return (n || `Subcuenta ${codigo}`).slice(0, 190);
}

// ---------------------------------------------------------------------------
// Longitud
// ---------------------------------------------------------------------------

/** Longitud guardada en las reglas contables de la empresa, o null si no se ha fijado. */
export async function longitudSubcuentasGuardada(companyId: string, db: Db = prisma): Promise<number | null> {
  // Los tests con prisma simulado no tienen la tabla de reglas: sin longitud guardada.
  if (typeof (db as { reglasContables?: { findUnique?: unknown } }).reglasContables?.findUnique !== 'function') return null;
  const fila = await db.reglasContables.findUnique({ where: { companyId }, select: { data: true } });
  const n = (fila?.data as { longitudSubcuentas?: unknown } | null)?.longitudSubcuentas;
  return esLongitudSubcuentasValida(n) ? n : null;
}

/** Codigos 430/400/410 del plan de la empresa y de las fichas (todas las longitudes). */
export async function codigosDeTerceros(db: Db, companyId: string, prefijos: PrefijoTercero[] = ['430', '400', '410']): Promise<string[]> {
  const [plan, clientes, proveedores] = await Promise.all([
    db.chartOfAccounts.findMany({ where: { companyId, OR: prefijos.map((p) => ({ codigo: { startsWith: p } })) }, select: { codigo: true } }),
    prefijos.includes('430')
      ? db.customer.findMany({ where: { companyId, subcuenta430: { not: null } }, select: { subcuenta430: true } })
      : Promise.resolve([]),
    prefijos.some((p) => p !== '430')
      ? db.supplier.findMany({
          where: { companyId, OR: [{ subcuenta400: { not: null } }, { subcuenta410: { not: null } }] },
          select: { subcuenta400: true, subcuenta410: true },
        })
      : Promise.resolve([]),
  ]);
  const out = plan.map((c) => c.codigo);
  for (const c of clientes as Array<{ subcuenta430: string | null }>) if (c.subcuenta430) out.push(c.subcuenta430);
  for (const s of proveedores as Array<{ subcuenta400: string | null; subcuenta410: string | null }>) {
    if (s.subcuenta400) out.push(s.subcuenta400);
    if (s.subcuenta410) out.push(s.subcuenta410);
  }
  return out.filter((c) => prefijos.some((p) => c.startsWith(p)));
}

/**
 * Longitud de las subcuentas de la empresa: la guardada en sus reglas; si no,
 * la que ya usan sus subcuentas de tercero (plan traido de otro programa); si
 * no hay ninguna, 8.
 */
export async function longitudSubcuentasEmpresa(companyId: string, db: Db = prisma): Promise<number> {
  const guardada = await longitudSubcuentasGuardada(companyId, db);
  if (guardada) return guardada;
  return longitudEnUso(await codigosDeTerceros(db, companyId)) ?? LONGITUD_SUBCUENTAS_DEFECTO;
}

/**
 * Guarda la longitud en las reglas de la empresa si aun no hay ninguna y
 * devuelve la que queda guardada (la de otro proceso, si se adelanto). Es una
 * sola sentencia (INSERT ... ON DUPLICATE KEY UPDATE) para que dos altas a la
 * vez no choquen al crear la fila de reglas. Con una BD simulada sin la tabla
 * de reglas no guarda nada.
 */
export async function guardarLongitudSiFalta(tx: Db, companyId: string, longitud: number): Promise<number> {
  if (typeof (tx as { reglasContables?: { findUnique?: unknown } }).reglasContables?.findUnique !== 'function') return longitud;
  await tx.$executeRaw`
    INSERT INTO ReglasContables (companyId, data, updatedAt)
    VALUES (${companyId}, JSON_OBJECT('longitudSubcuentas', ${longitud}), NOW(3))
    ON DUPLICATE KEY UPDATE
      data = IF(JSON_EXTRACT(data, '$.longitudSubcuentas') IS NULL, JSON_SET(data, '$.longitudSubcuentas', ${longitud}), data),
      updatedAt = NOW(3)`;
  // Lectura con bloqueo: ve lo ultimo confirmado aunque la transaccion ya tuviera su foto.
  const filas = await tx.$queryRaw<Array<{ l: unknown }>>`
    SELECT JSON_EXTRACT(data, '$.longitudSubcuentas') AS l FROM ReglasContables WHERE companyId = ${companyId} FOR UPDATE`;
  const n = Number(String(filas[0]?.l ?? '').replace(/"/g, ''));
  return esLongitudSubcuentasValida(n) ? n : longitud;
}

/**
 * Longitud con la que se asigna una subcuenta NUEVA. Si la empresa aun no la
 * tiene guardada, se guarda ahora, en la misma transaccion que la asignacion:
 * desde la primera subcuenta la longitud queda fija, y una cuenta importada
 * despues con otra longitud (apertura, diario) ya no la cambia.
 */
async function longitudParaAsignar(tx: TransaccionBD, companyId: string): Promise<number> {
  const guardada = await longitudSubcuentasGuardada(companyId, tx);
  if (guardada) return guardada;
  return guardarLongitudSiFalta(tx, companyId, await longitudSubcuentasEmpresa(companyId, tx));
}

/** Hay alguna subcuenta de tercero asignada (en una ficha o en el plan). */
export async function haySubcuentasDeTercero(companyId: string, db: Db = prisma): Promise<boolean> {
  return (await codigosDeTerceros(db, companyId)).some(esSubcuentaDeTercero);
}

// ---------------------------------------------------------------------------
// Asignacion del codigo a la ficha
// ---------------------------------------------------------------------------

export interface ClienteSubcuenta {
  id: string;
  subcuenta430?: string | null;
}

export interface ProveedorSubcuenta {
  id: string;
  subcuenta400?: string | null;
  subcuenta410?: string | null;
}

/**
 * Subcuenta 430 del cliente: la que tiene o una nueva (siguiente libre),
 * guardada en su ficha. No la da de alta en el plan. Bloquea la fila del
 * cliente para leer su valor actual (no el de la foto de la transaccion).
 */
export async function asignarSubcuentaCliente(tx: TransaccionBD, companyId: string, cliente: ClienteSubcuenta): Promise<string> {
  if (cliente.subcuenta430) return cliente.subcuenta430;
  const filas = await tx.$queryRaw<Array<{ subcuenta430: string | null }>>`SELECT subcuenta430 FROM Customer WHERE id = ${cliente.id} FOR UPDATE`;
  if (filas[0]?.subcuenta430) {
    cliente.subcuenta430 = filas[0].subcuenta430;
    return filas[0].subcuenta430;
  }
  const longitud = await longitudParaAsignar(tx, companyId);
  const n = siguienteNumeroTercero(await codigosDeTerceros(tx, companyId, ['430']), ['430'], longitud);
  const codigo = codigoSubcuenta('430', n, longitud);
  await tx.customer.update({ where: { id: cliente.id }, data: { subcuenta430: codigo } });
  cliente.subcuenta430 = codigo;
  return codigo;
}

/**
 * Subcuentas 400 y 410 del proveedor, con el mismo numero. Si tiene una, la
 * otra lleva su numero (si esta libre); si no tiene ninguna, numero nuevo. Se
 * guardan las dos en la ficha; en el plan solo se da de alta la que se use.
 */
export async function asignarSubcuentasProveedor(
  tx: TransaccionBD,
  companyId: string,
  proveedor: ProveedorSubcuenta,
): Promise<{ s400: string; s410: string }> {
  if (proveedor.subcuenta400 && proveedor.subcuenta410) return { s400: proveedor.subcuenta400, s410: proveedor.subcuenta410 };
  const filas = await tx.$queryRaw<Array<{ subcuenta400: string | null; subcuenta410: string | null }>>`
    SELECT subcuenta400, subcuenta410 FROM Supplier WHERE id = ${proveedor.id} FOR UPDATE`;
  let s400 = filas[0]?.subcuenta400 ?? proveedor.subcuenta400 ?? null;
  let s410 = filas[0]?.subcuenta410 ?? proveedor.subcuenta410 ?? null;
  if (!s400 || !s410) {
    const ocupadas = new Set(await codigosDeTerceros(tx, companyId, PREFIJOS_PROVEEDOR));
    const una = s400 ?? s410;
    if (una) {
      // La que falta, con el numero de la que tiene (o uno nuevo si ese ya es de otro).
      const prefijoFalta = s400 ? '410' : '400';
      const n = numeroDeSubcuenta(una);
      let gemela = n !== null ? codigoSubcuenta(prefijoFalta, n, una.length) : null;
      if (!gemela || ocupadas.has(gemela)) gemela = codigoSubcuenta(prefijoFalta, siguienteNumeroTercero(ocupadas, PREFIJOS_PROVEEDOR, una.length), una.length);
      if (s400) s410 = gemela;
      else s400 = gemela;
    } else {
      const longitud = await longitudParaAsignar(tx, companyId);
      const n = siguienteNumeroTercero(ocupadas, PREFIJOS_PROVEEDOR, longitud);
      s400 = codigoSubcuenta('400', n, longitud);
      s410 = codigoSubcuenta('410', n, longitud);
    }
    await tx.supplier.update({ where: { id: proveedor.id }, data: { subcuenta400: s400, subcuenta410: s410 } });
  }
  proveedor.subcuenta400 = s400;
  proveedor.subcuenta410 = s410;
  return { s400: s400!, s410: s410! };
}

// ---------------------------------------------------------------------------
// Alta en el plan
// ---------------------------------------------------------------------------

const TEXTO_FICHA: Record<TipoFicha, string> = { cliente: 'del cliente', proveedor: 'del proveedor' };

/** La subcuenta en el plan (si ya esta) y, si no, la cuenta de la que colgara. */
export interface SubcuentaEnPlan {
  existe: { id: string; nombre: string } | null;
  padre: { id: string; codigo: string; nivel: number; naturaleza: string; tipoUso: string } | null;
}

/** Lee como esta la subcuenta en el plan. Solo lee: se puede hacer fuera de la transaccion. */
export async function leerSubcuentaEnPlan(db: Db, companyId: string, codigo: string): Promise<SubcuentaEnPlan> {
  const existe = await db.chartOfAccounts.findFirst({ where: { companyId, codigo }, select: { id: true, nombre: true } });
  if (existe) return { existe, padre: null };
  const prefijo = codigo.slice(0, 3);
  const columnas = { id: true, codigo: true, nivel: true, naturaleza: true, tipoUso: true } as const;
  const padre =
    (await db.chartOfAccounts.findFirst({ where: { companyId, codigo: prefijo }, select: columnas })) ??
    (await db.chartOfAccounts.findFirst({ where: { companyId, codigo: { in: [prefijo.slice(0, 2), '4'] } }, orderBy: { codigo: 'desc' }, select: columnas }));
  return { existe: null, padre };
}

/**
 * Escribe en el plan lo que falte segun lo leido: la da de alta (colgando de
 * 430/400/410, nivel del padre + 1, con su naturaleza) o le pone el nombre de
 * la ficha. Si otro proceso la ha dado de alta entretanto, salta el indice
 * unico del plan y conReintentoSubcuenta repite la operacion entera.
 */
async function escribirSubcuentaEnPlan(
  tx: TransaccionBD,
  companyId: string,
  codigo: string,
  nombreFiscal: string,
  ficha: { tipo: TipoFicha; id: string },
  plan: SubcuentaEnPlan,
): Promise<void> {
  const nombre = nombreDeSubcuenta(nombreFiscal, codigo);
  if (plan.existe) {
    if (plan.existe.nombre !== nombre) await tx.chartOfAccounts.update({ where: { id: plan.existe.id }, data: { nombre } });
    return;
  }
  const prefijo = codigo.slice(0, 3);
  const padre = plan.padre;
  // createMany: una sola sentencia (create vuelve a leer la fila y no hace falta).
  await tx.chartOfAccounts.createMany({
    data: [
      {
        id: randomUUID(),
        companyId,
        codigo,
        nombre,
        grupo: 4,
        nivel: (padre?.nivel ?? 3) + 1,
        naturaleza: padre?.naturaleza ?? (prefijo === '430' ? 'ACTIVO' : 'PASIVO'),
        tipoUso: padre?.tipoUso ?? 'BALANCE',
        esBasePGC: false,
        esPersonalizadaEmpresa: true,
        parentId: padre?.id ?? null,
        parentCodigo: padre?.codigo ?? prefijo,
        notas: `Subcuenta ${TEXTO_FICHA[ficha.tipo]} ${ficha.id} (asignada automáticamente).`,
      },
    ],
  });
}

/**
 * Da de alta la subcuenta en el plan si falta (colgando de 430/400/410, nivel
 * del padre + 1, con su naturaleza) con el nombre fiscal. Si ya esta con otro
 * nombre, se le pone el de la ficha.
 */
export async function asegurarSubcuentaEnPlan(
  tx: TransaccionBD,
  companyId: string,
  codigo: string,
  nombreFiscal: string,
  ficha: { tipo: TipoFicha; id: string },
): Promise<void> {
  await escribirSubcuentaEnPlan(tx, companyId, codigo, nombreFiscal, ficha, await leerSubcuentaEnPlan(tx, companyId, codigo));
}

// ---------------------------------------------------------------------------
// Entrada unica para los sitios que contabilizan
// ---------------------------------------------------------------------------

export interface SubcuentaApunte {
  codigo: string;
  nombre: string;
}

/** Subcuenta 430 del cliente para un apunte: la asigna si falta y la da de alta en el plan. */
export async function subcuentaClienteParaApunte(tx: TransaccionBD, companyId: string, customerId: string): Promise<SubcuentaApunte> {
  const c = await tx.customer.findFirst({ where: { id: customerId, companyId }, select: { id: true, nombreFiscal: true, subcuenta430: true } });
  if (!c) throw notFound('Cliente no encontrado.');
  const codigo = await asignarSubcuentaCliente(tx, companyId, c);
  await asegurarSubcuentaEnPlan(tx, companyId, codigo, c.nombreFiscal, { tipo: 'cliente', id: c.id });
  return { codigo, nombre: nombreDeSubcuenta(c.nombreFiscal, codigo) };
}

/**
 * La subcuenta de un tercero leida ANTES de la transaccion que contabiliza: en
 * produccion (TiDB) cada consulta dentro alarga la transaccion, que tiene un
 * tiempo maximo. Dentro, aplicarSubcuentaPreparada solo escribe lo que falte.
 */
export interface SubcuentaPreparada {
  ficha: { tipo: TipoFicha; id: string; nombreFiscal: string };
  codigo: string;
  plan: SubcuentaEnPlan;
}

/**
 * La 430N del cliente si ya la tiene asignada (todos los de alta desde las
 * subcuentas), con su estado en el plan. null si aun no la tiene: entonces se
 * asigna dentro de la transaccion (subcuentaClienteParaApunte), con bloqueo.
 */
export async function prepararSubcuentaCliente(
  companyId: string,
  cliente: { id: string; nombreFiscal: string; subcuenta430?: string | null },
  db: Db = prisma,
): Promise<SubcuentaPreparada | null> {
  if (!cliente.subcuenta430) return null;
  return { ficha: { tipo: 'cliente', id: cliente.id, nombreFiscal: cliente.nombreFiscal }, codigo: cliente.subcuenta430, plan: await leerSubcuentaEnPlan(db, companyId, cliente.subcuenta430) };
}

/**
 * La 400N o la 410N del proveedor (segun el tipo de gasto) si ya tiene las
 * dos asignadas, con su estado en el plan. null si le falta alguna: se
 * asignan dentro de la transaccion (subcuentaProveedorParaApunte).
 */
export async function prepararSubcuentaProveedor(
  companyId: string,
  proveedor: { id: string; nombreFiscal: string; subcuenta400?: string | null; subcuenta410?: string | null },
  tipoGastoOPrefijo: string | null | undefined,
  db: Db = prisma,
): Promise<SubcuentaPreparada | null> {
  if (!proveedor.subcuenta400 || !proveedor.subcuenta410) return null;
  const codigo = prefijoAcreedor(tipoGastoOPrefijo) === '400' ? proveedor.subcuenta400 : proveedor.subcuenta410;
  return { ficha: { tipo: 'proveedor', id: proveedor.id, nombreFiscal: proveedor.nombreFiscal }, codigo, plan: await leerSubcuentaEnPlan(db, companyId, codigo) };
}

/** Dentro de la transaccion: da de alta en el plan (o renombra) la subcuenta preparada, sin volver a leer. */
export async function aplicarSubcuentaPreparada(tx: TransaccionBD, companyId: string, p: SubcuentaPreparada): Promise<SubcuentaApunte> {
  await escribirSubcuentaEnPlan(tx, companyId, p.codigo, p.ficha.nombreFiscal, { tipo: p.ficha.tipo, id: p.ficha.id }, p.plan);
  return { codigo: p.codigo, nombre: nombreDeSubcuenta(p.ficha.nombreFiscal, p.codigo) };
}

/** 400 (compras) o 410 (servicios) segun el tipo de gasto; tambien admite el prefijo. */
export function prefijoAcreedor(tipoGastoOPrefijo: string | null | undefined): '400' | '410' {
  if (tipoGastoOPrefijo === '400' || tipoGastoOPrefijo === '410') return tipoGastoOPrefijo;
  return esTipoGasto(tipoGastoOPrefijo) ? TIPO_GASTO_INFO[tipoGastoOPrefijo].acreedor : '400';
}

/**
 * Subcuenta 400N o 410N del proveedor para un apunte (segun el tipo de gasto
 * de la factura): asigna el numero si falta y da de alta en el plan la que se usa.
 */
export async function subcuentaProveedorParaApunte(
  tx: TransaccionBD,
  companyId: string,
  supplierId: string,
  tipoGastoOPrefijo: string | null | undefined,
): Promise<SubcuentaApunte> {
  const s = await tx.supplier.findFirst({
    where: { id: supplierId, companyId },
    select: { id: true, nombreFiscal: true, subcuenta400: true, subcuenta410: true },
  });
  if (!s) throw notFound('Proveedor no encontrado.');
  const { s400, s410 } = await asignarSubcuentasProveedor(tx, companyId, s);
  const codigo = prefijoAcreedor(tipoGastoOPrefijo) === '400' ? s400 : s410;
  await asegurarSubcuentaEnPlan(tx, companyId, codigo, s.nombreFiscal, { tipo: 'proveedor', id: s.id });
  return { codigo, nombre: nombreDeSubcuenta(s.nombreFiscal, codigo) };
}

// ---------------------------------------------------------------------------
// Altas de fichas con su subcuenta
// ---------------------------------------------------------------------------

/** Alta de un cliente con su subcuenta asignada, en una transaccion (con reintento si dos altas sacan el mismo codigo). */
export function crearClienteConSubcuenta(data: Prisma.CustomerUncheckedCreateInput) {
  return conReintentoSubcuenta(() =>
    prisma.$transaction(async (tx) => {
      const c = await tx.customer.create({ data });
      await asignarSubcuentaCliente(tx, data.companyId, c);
      return c;
    }),
  );
}

/** Alta de un proveedor con sus subcuentas 400N y 410N asignadas, en una transaccion (con reintento). */
export function crearProveedorConSubcuenta(data: Prisma.SupplierUncheckedCreateInput) {
  return conReintentoSubcuenta(() =>
    prisma.$transaction(async (tx) => {
      const s = await tx.supplier.create({ data });
      await asignarSubcuentasProveedor(tx, data.companyId, s);
      return s;
    }),
  );
}

// ---------------------------------------------------------------------------
// Renombrar, borrar y consultar
// ---------------------------------------------------------------------------

/** Pone el nombre fiscal nuevo a las subcuentas de la ficha que ya estan en el plan. */
export async function sincronizarNombreSubcuentas(tx: TransaccionBD, companyId: string, codigos: Array<string | null | undefined>, nombreFiscal: string): Promise<number> {
  const lista = codigos.filter((c): c is string => !!c);
  if (!lista.length) return 0;
  const r = await tx.chartOfAccounts.updateMany({ where: { companyId, codigo: { in: lista } }, data: { nombre: nombreDeSubcuenta(nombreFiscal, lista[0]) } });
  return r.count;
}

/** Codigos de la lista que ya estan dados de alta en el plan de la empresa. */
export async function subcuentasEnPlan(db: Db, companyId: string, codigos: Array<string | null | undefined>): Promise<string[]> {
  const lista = codigos.filter((c): c is string => !!c);
  if (!lista.length) return [];
  const filas = await db.chartOfAccounts.findMany({ where: { companyId, codigo: { in: lista } }, select: { codigo: true } });
  return filas.map((f) => f.codigo).sort();
}

/** Apuntes (en cualquier estado) en esas subcuentas. */
export async function apuntesEnSubcuentas(db: Db, companyId: string, codigos: Array<string | null | undefined>): Promise<number> {
  const lista = codigos.filter((c): c is string => !!c);
  if (!lista.length) return 0;
  return db.journalEntryLine.count({ where: { companyId, accountCode: { in: lista } } });
}

/**
 * Al borrar una ficha, sus subcuentas quedan en el plan INACTIVAS con una
 * nota: el codigo sigue ocupado y no se le da nunca a otro tercero.
 */
export async function retirarSubcuentasDeFicha(
  tx: TransaccionBD,
  companyId: string,
  codigos: Array<string | null | undefined>,
  ficha: { tipo: TipoFicha; id: string; nombreFiscal: string },
  hoy: string,
): Promise<void> {
  const nota = `Tercero borrado el ${hoy.slice(8, 10)}/${hoy.slice(5, 7)}/${hoy.slice(0, 4)} (${ficha.nombreFiscal}). El código no se reutiliza.`;
  for (const codigo of codigos.filter((c): c is string => !!c)) {
    await asegurarSubcuentaEnPlan(tx, companyId, codigo, ficha.nombreFiscal, ficha);
    await tx.chartOfAccounts.updateMany({ where: { companyId, codigo }, data: { activo: false, notas: nota } });
  }
}

export interface FichaDeSubcuenta {
  tipo: TipoFicha;
  id: string;
  nombre: string;
  nif: string;
}

/** codigo -> ficha de cliente o proveedor a la que pertenece (para informes, el plan y Carmen). */
export async function fichaDeSubcuenta(companyId: string, db: Db = prisma): Promise<Map<string, FichaDeSubcuenta>> {
  const [clientes, proveedores] = await Promise.all([
    db.customer.findMany({ where: { companyId, subcuenta430: { not: null } }, select: { id: true, nombreFiscal: true, nifCif: true, subcuenta430: true } }),
    db.supplier.findMany({
      where: { companyId, OR: [{ subcuenta400: { not: null } }, { subcuenta410: { not: null } }] },
      select: { id: true, nombreFiscal: true, nifCif: true, subcuenta400: true, subcuenta410: true },
    }),
  ]);
  const mapa = new Map<string, FichaDeSubcuenta>();
  for (const c of clientes) mapa.set(c.subcuenta430!, { tipo: 'cliente', id: c.id, nombre: c.nombreFiscal, nif: c.nifCif });
  for (const s of proveedores) {
    const f: FichaDeSubcuenta = { tipo: 'proveedor', id: s.id, nombre: s.nombreFiscal, nif: s.nifCif };
    if (s.subcuenta400) mapa.set(s.subcuenta400, f);
    if (s.subcuenta410) mapa.set(s.subcuenta410, f);
  }
  return mapa;
}
