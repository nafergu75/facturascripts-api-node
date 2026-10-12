/**
 * Migracion de lo ya contabilizado contra las cuentas genericas 430, 400 y
 * 410 a la subcuenta propia de cada cliente y proveedor (decision del usuario
 * del 08-10-2026: los datos actuales son de prueba y se reescriben en el
 * sitio, como si se hubiera hecho asi desde el principio).
 *
 * Por empresa, en UNA transaccion:
 *  0. Plan base al dia y longitud de las subcuentas fijada en sus reglas: la
 *     que ya tenga guardada o la de las subcuentas de tercero que ya haya en
 *     su plan; si no hay ninguna, la indicada con `longitud` (--longitud N).
 *     Sin ninguna de las tres no se elige 8 por su cuenta: se para, porque si
 *     la empresa va a traer su plan de 2026 (R3) la longitud debe ser la de
 *     ese plan, y despues de migrar ya no se podria cambiar.
 *  1. Subcuenta para todas las fichas que no la tienen (por fecha de alta).
 *  2. Lineas en la generica (430, 4300..., 400, 410...) de los asientos de una
 *     factura (de la factura, de sus cobros o pagos y sus anulaciones, en
 *     cualquier estado): a la subcuenta del tercero de la factura; en gastos,
 *     la 400N o la 410N segun el prefijo DE LA PROPIA LINEA.
 *  3. Alta en el plan (con el nombre fiscal) de las subcuentas usadas y el
 *     nombre fiscal en las lineas reescritas.
 *  4. Informe: lineas reescritas por tercero y lineas que se quedan en la
 *     generica, con su motivo.
 *
 * SIMULACION por defecto: hace todo dentro de la transaccion y la deshace al
 * final, asi que el informe es exactamente lo que haria. Con `aplicar`, la
 * confirma. Idempotente: solo toca lineas en la generica; una segunda pasada
 * no reescribe nada. Si la empresa tiene algun ejercicio cerrado se para (sus
 * asientos de cierre y apertura llevan el saldo agregado): con
 * `incluirCerrados` sigue, para el caso en que el usuario los reabre antes.
 */
import { prisma, type TransaccionBD } from '../../config/database';
import { asegurarPlanContableEmpresa } from '../chart-of-accounts.service';
import { ejercicioCerrado } from '../periodos.service';
import {
  asegurarSubcuentaEnPlan,
  asignarSubcuentaCliente,
  asignarSubcuentasProveedor,
  codigosDeTerceros,
  guardarLongitudSiFalta,
  longitudSubcuentasGuardada,
  nombreDeSubcuenta,
} from './subcuentas';
import {
  esLongitudSubcuentasValida,
  esSubcuentaGenerica,
  LONGITUD_SUBCUENTAS_DEFECTO,
  LONGITUD_SUBCUENTAS_MAX,
  LONGITUD_SUBCUENTAS_MIN,
  longitudEnUso,
} from './numeracion';

export interface OpcionesMigracion {
  /** Confirmar los cambios. Sin el, simulacion: no se escribe nada. */
  aplicar?: boolean;
  /** Seguir aunque haya ejercicios cerrados (reabiertos antes por el usuario). */
  incluirCerrados?: boolean;
  /** Longitud de las subcuentas (7-10) para una empresa que aun no tiene ninguna. */
  longitud?: number;
}

export interface LineaSinReasignar {
  asiento: string;
  numeroAsiento: string;
  fecha: string;
  origen: string;
  cuenta: string;
  debe: number;
  haber: number;
  motivo: string;
}

export interface InformeMigracion {
  companyId: string;
  simulacion: boolean;
  longitud: number;
  /** La longitud no estaba guardada en las reglas y se fija ahora. */
  longitudFijada: boolean;
  fichasConSubcuentaNueva: Array<{ tipo: 'cliente' | 'proveedor'; id: string; nombre: string; subcuentas: string[] }>;
  lineasReescritas: number;
  porTercero: Array<{ tipo: 'cliente' | 'proveedor'; id: string; nombre: string; cuenta: string; lineas: number }>;
  cuentasDadasDeAltaEnPlan: string[];
  sinReasignar: LineaSinReasignar[];
}

/** Se lanza al final de la simulacion para deshacer la transaccion. */
class FinSimulacion extends Error {
  constructor(public readonly informe: InformeMigracion) {
    super('simulacion');
  }
}

export class EjerciciosCerradosError extends Error {
  constructor(public readonly ejercicios: number[]) {
    super(
      `La empresa tiene ejercicios cerrados (${ejercicios.join(', ')}): sus asientos de cierre y apertura llevan el saldo de la cuenta genérica. ` +
        'Reábrelos antes, migra con --incluir-cerrados y vuelve a cerrarlos para que salgan por subcuenta.',
    );
  }
}

/** La empresa no tiene longitud guardada ni subcuentas de tercero, y no se ha indicado --longitud. */
export class LongitudSinFijarError extends Error {
  constructor() {
    super(
      'Aún no tiene fijada la longitud de las subcuentas de clientes y proveedores. ' +
        'Si vas a traer su plan contable de 2026, tráelo primero desde la app, ya con este backend publicado ' +
        '(Contabilidad > Puesta en marcha > 1. Plan de cuentas), y repite: se usará la longitud de ese plan. ' +
        `Si no lo vas a traer, repite con --longitud N (de ${LONGITUD_SUBCUENTAS_MIN} a ${LONGITUD_SUBCUENTAS_MAX}; lo habitual, 8). ` +
        'Ojo: la longitud queda fijada para siempre; si después traes un plan con otra, convivirán las dos.',
    );
  }
}

const OPCIONES_TX = { timeout: 10 * 60_000, maxWait: 30_000 };

/** Años con asientos o con ejercicio dado de alta que estan cerrados. */
async function ejerciciosCerradosDe(companyId: string): Promise<number[]> {
  const [fys, rango] = await Promise.all([
    prisma.fiscalYear.findMany({ where: { companyId }, select: { label: true } }),
    prisma.journalEntry.aggregate({ where: { companyId }, _min: { fecha: true }, _max: { fecha: true } }),
  ]);
  const anios = new Set<number>();
  for (const f of fys) if (/^\d{4}$/.test(f.label)) anios.add(Number(f.label));
  if (rango._min.fecha && rango._max.fecha) {
    for (let a = rango._min.fecha.getUTCFullYear(); a <= rango._max.fecha.getUTCFullYear(); a++) anios.add(a);
  }
  const cerrados: number[] = [];
  for (const a of [...anios].sort()) if (await ejercicioCerrado(companyId, a)) cerrados.push(a);
  return cerrados;
}

function motivoSinFactura(origen: string): string {
  if (origen === 'IMPORTACION' || origen === 'APERTURA') return 'Apertura o importación sin detalle por cliente o proveedor: el saldo está en la cuenta genérica.';
  if (origen === 'CIERRE' || origen === 'REGULARIZACION') return 'Asiento de cierre: lleva el saldo agregado de la cuenta genérica.';
  if (origen === 'TESORERIA') return 'Movimiento de tesorería sin factura (conciliación contra una cuenta suelta).';
  return 'Asiento sin factura: no se sabe de qué cliente o proveedor es.';
}

export async function migrarSubcuentasTerceros(companyId: string, opciones: OpcionesMigracion = {}): Promise<InformeMigracion> {
  const empresa = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
  if (!empresa) throw new Error(`No existe la empresa ${companyId}.`);
  if (!opciones.incluirCerrados) {
    const cerrados = await ejerciciosCerradosDe(companyId);
    if (cerrados.length) throw new EjerciciosCerradosError(cerrados);
  }
  // Fuera de la transaccion e idempotente (solo anade las cuentas del PGC que falten).
  if (opciones.aplicar) await asegurarPlanContableEmpresa(companyId);

  try {
    return await prisma.$transaction(async (tx) => {
      const informe = await migrarEnTx(tx, companyId, !opciones.aplicar, opciones.longitud);
      if (!opciones.aplicar) throw new FinSimulacion(informe);
      return informe;
    }, OPCIONES_TX);
  } catch (e) {
    if (e instanceof FinSimulacion) return e.informe;
    throw e;
  }
}

/** Longitud con la que migra la empresa y si hay que guardarla (punto 0 de la cabecera). */
async function longitudDeMigracion(tx: TransaccionBD, companyId: string, pedida: number | undefined): Promise<{ longitud: number; guardar: boolean }> {
  const guardada = await longitudSubcuentasGuardada(companyId, tx);
  const actual = guardada ?? longitudEnUso(await codigosDeTerceros(tx, companyId));
  if (pedida !== undefined) {
    if (!esLongitudSubcuentasValida(pedida)) throw new Error(`--longitud tiene que ser un número de ${LONGITUD_SUBCUENTAS_MIN} a ${LONGITUD_SUBCUENTAS_MAX}.`);
    if (actual !== null && actual !== pedida) {
      throw new Error(`Ya usa subcuentas de ${actual} dígitos: no se puede migrar con --longitud ${pedida}. Quita la opción o pon --longitud ${actual}.`);
    }
    return { longitud: pedida, guardar: guardada === null };
  }
  if (actual !== null) return { longitud: actual, guardar: guardada === null };
  // Sin longitud: solo hace falta si alguna ficha va a recibir subcuenta.
  const [clientes, proveedores] = await Promise.all([
    tx.customer.count({ where: { companyId, subcuenta430: null } }),
    tx.supplier.count({ where: { companyId, OR: [{ subcuenta400: null }, { subcuenta410: null }] } }),
  ]);
  if (clientes + proveedores > 0) throw new LongitudSinFijarError();
  return { longitud: LONGITUD_SUBCUENTAS_DEFECTO, guardar: false };
}

async function migrarEnTx(tx: TransaccionBD, companyId: string, simulacion: boolean, longitudPedida?: number): Promise<InformeMigracion> {
  // 0. Longitud guardada en las reglas antes de asignar nada.
  const { longitud, guardar: longitudFijada } = await longitudDeMigracion(tx, companyId, longitudPedida);
  if (longitudFijada) await guardarLongitudSiFalta(tx, companyId, longitud);

  // 1. Subcuenta para todas las fichas que no la tienen (cliente n.º 1 = el mas antiguo).
  const fichasConSubcuentaNueva: InformeMigracion['fichasConSubcuentaNueva'] = [];
  const clientes = await tx.customer.findMany({ where: { companyId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  for (const c of clientes) {
    if (c.subcuenta430) continue;
    await asignarSubcuentaCliente(tx, companyId, c);
    fichasConSubcuentaNueva.push({ tipo: 'cliente', id: c.id, nombre: c.nombreFiscal, subcuentas: [c.subcuenta430!] });
  }
  const proveedores = await tx.supplier.findMany({ where: { companyId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  for (const s of proveedores) {
    if (s.subcuenta400 && s.subcuenta410) continue;
    await asignarSubcuentasProveedor(tx, companyId, s);
    fichasConSubcuentaNueva.push({ tipo: 'proveedor', id: s.id, nombre: s.nombreFiscal, subcuentas: [s.subcuenta400!, s.subcuenta410!] });
  }
  const clientePorId = new Map(clientes.map((c) => [c.id, c]));
  const proveedorPorId = new Map(proveedores.map((s) => [s.id, s]));

  // 2. Lineas en la generica de la empresa, con su asiento.
  const lineas = await tx.journalEntryLine.findMany({
    where: { companyId, OR: [{ accountCode: { startsWith: '430' } }, { accountCode: { startsWith: '400' } }, { accountCode: { startsWith: '410' } }] },
    include: { entry: { select: { id: true, numeroAsiento: true, fecha: true, origen: true, invoiceId: true, invoiceType: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const genericas = lineas.filter((l) => esSubcuentaGenerica(l.accountCode));

  // Tercero de cada factura enlazada.
  const idsIngreso = [...new Set(genericas.filter((l) => l.entry.invoiceType === 'INGRESO' && l.entry.invoiceId).map((l) => l.entry.invoiceId!))];
  const idsGasto = [...new Set(genericas.filter((l) => l.entry.invoiceType === 'GASTO' && l.entry.invoiceId).map((l) => l.entry.invoiceId!))];
  const [ventas, gastos] = await Promise.all([
    tx.incomeInvoice.findMany({ where: { companyId, id: { in: idsIngreso } }, select: { id: true, customerId: true } }),
    tx.expenseInvoice.findMany({ where: { companyId, id: { in: idsGasto } }, select: { id: true, supplierId: true } }),
  ]);
  const clienteDeFactura = new Map(ventas.map((v) => [v.id, v.customerId]));
  const proveedorDeFactura = new Map(gastos.map((g) => [g.id, g.supplierId]));

  const sinReasignar: LineaSinReasignar[] = [];
  const porTerceroMapa = new Map<string, InformeMigracion['porTercero'][number]>();
  const usadas = new Map<string, { tipo: 'cliente' | 'proveedor'; id: string; nombre: string }>();
  let lineasReescritas = 0;

  for (const l of genericas) {
    const e = l.entry;
    const prefijo = l.accountCode.slice(0, 3);
    const base = {
      asiento: e.id,
      numeroAsiento: e.numeroAsiento,
      fecha: e.fecha.toISOString().slice(0, 10),
      origen: e.origen,
      cuenta: l.accountCode,
      debe: Number(l.debe),
      haber: Number(l.haber),
    };
    if (!e.invoiceId || (e.invoiceType !== 'INGRESO' && e.invoiceType !== 'GASTO')) {
      sinReasignar.push({ ...base, motivo: motivoSinFactura(e.origen) });
      continue;
    }
    let destino: { tipo: 'cliente' | 'proveedor'; id: string; nombre: string; cuenta: string } | null = null;
    if (prefijo === '430') {
      if (e.invoiceType !== 'INGRESO') {
        sinReasignar.push({ ...base, motivo: 'Cuenta de clientes en el asiento de una factura de gasto: revísalo a mano.' });
        continue;
      }
      const c = clientePorId.get(clienteDeFactura.get(e.invoiceId) ?? '');
      if (c) destino = { tipo: 'cliente', id: c.id, nombre: c.nombreFiscal, cuenta: c.subcuenta430! };
    } else {
      if (e.invoiceType !== 'GASTO') {
        sinReasignar.push({ ...base, motivo: 'Cuenta de proveedores en el asiento de una factura de venta: revísalo a mano.' });
        continue;
      }
      const s = proveedorPorId.get(proveedorDeFactura.get(e.invoiceId) ?? '');
      if (s) destino = { tipo: 'proveedor', id: s.id, nombre: s.nombreFiscal, cuenta: prefijo === '400' ? s.subcuenta400! : s.subcuenta410! };
    }
    if (!destino) {
      sinReasignar.push({ ...base, motivo: 'La factura de este asiento ya no existe (o es de otra empresa): no se sabe de qué tercero es.' });
      continue;
    }
    await tx.journalEntryLine.update({
      where: { id: l.id },
      data: { accountCode: destino.cuenta, accountName: nombreDeSubcuenta(destino.nombre, destino.cuenta) },
    });
    lineasReescritas++;
    usadas.set(destino.cuenta, destino);
    const clave = `${destino.tipo}|${destino.id}|${destino.cuenta}`;
    const t = porTerceroMapa.get(clave) ?? { tipo: destino.tipo, id: destino.id, nombre: destino.nombre, cuenta: destino.cuenta, lineas: 0 };
    t.lineas++;
    porTerceroMapa.set(clave, t);
  }

  // 3. Alta en el plan de las subcuentas usadas, con el nombre fiscal.
  const enPlanAntes = new Set(
    (await tx.chartOfAccounts.findMany({ where: { companyId, codigo: { in: [...usadas.keys()] } }, select: { codigo: true } })).map((c) => c.codigo),
  );
  for (const [codigo, ficha] of usadas) await asegurarSubcuentaEnPlan(tx, companyId, codigo, ficha.nombre, { tipo: ficha.tipo, id: ficha.id });

  return {
    companyId,
    simulacion,
    longitud,
    longitudFijada,
    fichasConSubcuentaNueva,
    lineasReescritas,
    porTercero: [...porTerceroMapa.values()].sort((a, b) => a.cuenta.localeCompare(b.cuenta)),
    cuentasDadasDeAltaEnPlan: [...usadas.keys()].filter((c) => !enPlanAntes.has(c)).sort(),
    sinReasignar,
  };
}

/** Informe en texto para la consola (lo imprime el script). */
export function informeEnTexto(r: InformeMigracion): string {
  const out: string[] = [];
  out.push(`Empresa ${r.companyId} — ${r.simulacion ? 'SIMULACIÓN (no se ha escrito nada)' : 'APLICADO'}`);
  out.push(`Longitud de las subcuentas: ${r.longitud} dígitos${r.longitudFijada ? ' (se guarda ahora en las reglas de la empresa)' : ''}.`);
  out.push(`Fichas que reciben subcuenta: ${r.fichasConSubcuentaNueva.length}`);
  for (const f of r.fichasConSubcuentaNueva) out.push(`  ${f.tipo === 'cliente' ? 'Cliente  ' : 'Proveedor'} ${f.subcuentas.join(' / ')}  ${f.nombre}`);
  out.push(`Líneas reescritas: ${r.lineasReescritas}`);
  for (const t of r.porTercero) out.push(`  ${t.cuenta}  ${t.nombre}: ${t.lineas} línea(s)`);
  out.push(`Subcuentas dadas de alta en el plan: ${r.cuentasDadasDeAltaEnPlan.length ? r.cuentasDadasDeAltaEnPlan.join(', ') : 'ninguna'}`);
  out.push(`Líneas que se quedan en la cuenta genérica: ${r.sinReasignar.length}`);
  for (const l of r.sinReasignar) {
    out.push(`  ${l.fecha} ${l.numeroAsiento} cuenta ${l.cuenta} debe ${l.debe.toFixed(2)} haber ${l.haber.toFixed(2)} — ${l.motivo}`);
  }
  return out.join('\n');
}
