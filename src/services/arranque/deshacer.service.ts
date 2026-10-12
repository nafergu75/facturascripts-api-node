/**
 * Deshacer una carga de «Traer la contabilidad de 2026» (la vigente o una que
 * se quedo a medias). Primero se puede ver que se revierte (simular) y despues
 * hacerlo (administrador de la empresa).
 *
 * No se puede si sus facturas pendientes ya tienen cobros o pagos de 2027, ni
 * si sus bienes tienen amortizacion apuntada: hay que anularlos antes.
 *
 * En orden inverso a la importacion:
 *  - comparativo de 2026: el de antes (o ninguno);
 *  - bancos: los valores de antes; las cuentas nuevas sin movimientos se borran;
 *  - inmovilizado: las fichas de la carga se borran; las de la version anterior vuelven;
 *  - facturas pendientes: las de la carga se anulan; las de la version anterior vuelven;
 *  - apertura y ajuste: anulados; la apertura de antes vuelve;
 *  - diario de 2026: anulado; el de la version anterior vuelve;
 *  - fichas: las enlazadas vuelven a su subcuenta de antes; las creadas por la
 *    carga sin facturas ni apuntes se borran solo si se piden una a una;
 *  - cuentas creadas sin apuntes: inactivas, con una nota (el codigo queda ocupado);
 *  - nombres de cuentas y longitud de las subcuentas de antes (la longitud,
 *    solo si ninguna ficha usa la nueva);
 *  - asientos de 2026 de la app retirados: vuelven si se pide;
 *  - 2026 vuelve a como estaba (llevado en la app o fuera).
 * La carga queda DESHECHA y, si sustituyo a otra, esa vuelve a ser la vigente.
 */
import { Prisma } from '@prisma/client';
import { prisma, type TransaccionBD } from '../../config/database';
import { badRequest, conflict } from '../../utils/http-errors';
import { registrarAuditoria } from '../auditoria.service';
import type { CreadoPorPlan } from '../puestaEnMarcha/planAnterior';
import { OPCIONES_TX, rangoEjercicio } from '../puestaEnMarcha/asientosEnBloque';
import { longitudSubcuentasGuardada } from '../terceros/subcuentas';
import { NOTA_CUENTA_DESHECHA, numeroDe } from './aplicar.service';
import { deshacerBancos } from './bancos.service';
import { partidasConMovimientos } from './partidas.service';
import { cargaDeEmpresa, validarEjercicio, type CargaFila } from './cargas.service';

const objeto = (v: Prisma.JsonValue | null | undefined): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const varios = (n: number, uno: string, muchos: string) => `${n.toLocaleString('es-ES')} ${n === 1 ? uno : muchos}`;
const VIVOS = ['POSTED', 'DRAFT', 'PENDING_REVIEW'];

export interface FichaCreada {
  id: string;
  tipo: 'cliente' | 'proveedor';
  nombre: string;
  nif: string;
  /** Sin facturas ni apuntes propios: se puede borrar. */
  borrable: boolean;
  motivo?: string;
}

export interface PlanDeshacer {
  cargaId: string;
  version: number;
  estado: string;
  puede: boolean;
  /** Por que no se puede (cobros, pagos o amortizacion apuntada). */
  bloqueos: string[];
  /** Lo que se va a revertir, en frases. */
  acciones: string[];
  fichasCreadas: FichaCreada[];
  /** Asientos de 2026 hechos en la app que la carga retiro y pueden volver. */
  asientos2026: number;
  /** Version que vuelve a ser la vigente, si esta sustituyo a otra. */
  vuelveVersion: number | null;
}

/** Ids de los asientos del diario historico de la carga (por su tramo de numeros). */
async function historicoDe(db: TransaccionBD | typeof prisma, companyId: string, anio: number, tramo: { desde: number; hasta: number } | null, estado: string): Promise<string[]> {
  if (!tramo) return [];
  const filas = await db.journalEntry.findMany({
    where: { companyId, estado, origen: { startsWith: 'HISTORICO' }, fecha: rangoEjercicio(anio), numeroAsiento: { startsWith: 'HIST-' } },
    select: { id: true, numeroAsiento: true },
  });
  return filas.filter((f) => {
    const n = numeroDe(f.numeroAsiento);
    return n !== null && n >= tramo.desde && n <= tramo.hasta;
  }).map((f) => f.id);
}

/** Tramo de numeros HIST- que grabo la carga. */
const tramoCarga = (creado: Record<string, unknown>): { desde: number; hasta: number } | null => {
  const h = creado.historico as { primero?: string | null; ultimo?: string | null } | undefined;
  const desde = h?.primero ? numeroDe(h.primero) : null;
  const hasta = h?.ultimo ? numeroDe(h.ultimo) : null;
  return desde !== null && hasta !== null ? { desde, hasta } : null;
};

/** Apuntes propios (sin la apertura ni el historico) en unas subcuentas. */
async function apuntesPropios(db: TransaccionBD | typeof prisma, companyId: string, codigos: string[]): Promise<Set<string>> {
  if (!codigos.length) return new Set();
  const usados = await db.journalEntryLine.groupBy({
    by: ['accountCode'],
    where: {
      companyId,
      accountCode: { in: codigos },
      entry: { estado: { in: VIVOS }, NOT: [{ origen: { in: ['APERTURA', 'APERTURA_AJUSTE'] } }, { origen: { startsWith: 'HISTORICO' } }] },
    },
    _count: { _all: true },
  });
  return new Set(usados.map((u) => u.accountCode));
}

async function fichasCreadas(db: TransaccionBD | typeof prisma, companyId: string, plan: CreadoPorPlan | undefined): Promise<FichaCreada[]> {
  if (!plan || !(plan.clientes.length + plan.proveedores.length)) return [];
  const [clientes, proveedores] = await Promise.all([
    db.customer.findMany({ where: { companyId, id: { in: plan.clientes } }, select: { id: true, nombreFiscal: true, nifCif: true, subcuenta430: true, _count: { select: { invoices: true } } } }),
    db.supplier.findMany({
      where: { companyId, id: { in: plan.proveedores } },
      select: { id: true, nombreFiscal: true, nifCif: true, subcuenta400: true, subcuenta410: true, _count: { select: { invoices: true, inmuebles: true } } },
    }),
  ]);
  const codigos = [...clientes.map((c) => c.subcuenta430), ...proveedores.flatMap((p) => [p.subcuenta400, p.subcuenta410])].filter((c): c is string => !!c);
  const usados = await apuntesPropios(db, companyId, codigos);
  const out: FichaCreada[] = [];
  for (const c of clientes) {
    const motivo = c._count.invoices ? 'tiene facturas' : c.subcuenta430 && usados.has(c.subcuenta430) ? 'tiene apuntes en su subcuenta' : undefined;
    out.push({ id: c.id, tipo: 'cliente', nombre: c.nombreFiscal, nif: c.nifCif, borrable: !motivo, ...(motivo ? { motivo } : {}) });
  }
  for (const p of proveedores) {
    const usa = [p.subcuenta400, p.subcuenta410].some((x) => x && usados.has(x));
    const motivo = p._count.invoices ? 'tiene facturas' : p._count.inmuebles ? 'tiene inmuebles' : usa ? 'tiene apuntes en sus subcuentas' : undefined;
    out.push({ id: p.id, tipo: 'proveedor', nombre: p.nombreFiscal, nif: p.nifCif, borrable: !motivo, ...(motivo ? { motivo } : {}) });
  }
  return out;
}

/** Lo que haria deshacer la carga, sin cambiar nada. */
export async function planDeshacer(c: CargaFila, db: TransaccionBD | typeof prisma = prisma): Promise<PlanDeshacer> {
  const creado = objeto(c.creado);
  const anterior = objeto(c.anterior);
  const anio = c.ejercicio - 1;
  const bloqueos: string[] = [];
  const otra = await db.cargaArranque.findFirst({ where: { companyId: c.companyId, ejercicio: c.ejercicio, estado: 'APLICANDO', NOT: { id: c.id } }, select: { version: true } });
  if (otra) bloqueos.push(`La versión ${otra.version} se está importando: termínala o deshazla antes.`);

  const partidas = await db.partidaPendiente.findMany({ where: { companyId: c.companyId, cargaId: c.id, estado: { not: 'ANULADA' } }, select: { id: true, numeroDocumento: true } });
  const movimientos = await partidasConMovimientos(db, c.companyId, partidas.map((p) => p.id));
  const docsDe = (ids: string[]) => {
    const docs = [...new Set(ids.map((id) => partidas.find((p) => p.id === id)!.numeroDocumento))];
    return { n: docs.length, texto: `${docs.slice(0, 10).join(', ')}${docs.length > 10 ? '…' : ''}` };
  };
  const conCobros = docsDe([...movimientos].filter(([, m]) => m.cobros > 0).map(([id]) => id));
  if (conCobros.n) {
    bloqueos.push(`${varios(conCobros.n, `factura pendiente de ${anio} ya tiene`, `facturas pendientes de ${anio} ya tienen`)} cobros o pagos de ${c.ejercicio} (${conCobros.texto}). Anúlalos antes en Cobros y pagos.`);
  }
  // Abonos del proveedor de este ejercicio ya descontados de una partida: cuentan como pagado.
  const conAbonos = docsDe([...movimientos].filter(([, m]) => m.abonos !== 0).map(([id]) => id));
  if (conAbonos.n) {
    bloqueos.push(
      `${varios(conAbonos.n, `factura pendiente de ${anio} ya tiene`, `facturas pendientes de ${anio} ya tienen`)} abonos de ${c.ejercicio} descontados (${conAbonos.texto}). Anula antes su aplicación en la ficha del abono, en Compras («Aplicado a otras facturas»).`,
    );
  }
  const activos = await db.activoFijo.findMany({ where: { companyId: c.companyId, cargaId: c.id }, select: { id: true, descripcion: true } });
  const dotados = activos.length
    ? await db.dotacionAmortizacion.findMany({ where: { companyId: c.companyId, anulada: false, activoFijoId: { in: activos.map((a) => a.id) } }, select: { activoFijoId: true, journalEntryId: true } })
    : [];
  const vivas = dotados.length ? await db.journalEntry.findMany({ where: { id: { in: dotados.map((d) => d.journalEntryId) }, estado: { in: VIVOS } }, select: { id: true } }) : [];
  const conAmortizacion = [...new Set(dotados.filter((d) => vivas.some((v) => v.id === d.journalEntryId)).map((d) => activos.find((a) => a.id === d.activoFijoId)!.descripcion))];
  if (conAmortizacion.length) {
    bloqueos.push(`${varios(conAmortizacion.length, 'bien tiene', 'bienes tienen')} amortización apuntada (${conAmortizacion.slice(0, 10).join(', ')}). Anúlala antes en Contabilidad > Inmovilizado.`);
  }

  const acciones: string[] = [];
  if (creado.comparativo) acciones.push(anterior.comparativo ? `El comparativo de ${anio} vuelve a ser el de antes.` : `Se borra el comparativo de ${anio}.`);
  const bancos = ((anterior.bancos as unknown[]) ?? []).length + ((creado.bancos as unknown[]) ?? []).length;
  if (bancos) acciones.push(`${varios(bancos, 'cuenta bancaria vuelve', 'cuentas bancarias vuelven')} a su saldo inicial de antes (las nuevas sin movimientos se borran).`);
  if (activos.length) acciones.push(`Se borran ${varios(activos.length, 'bien', 'bienes')} de inmovilizado de la carga.`);
  if (partidas.length) acciones.push(`Se anulan ${varios(partidas.length, 'factura pendiente', 'facturas pendientes')} de cobro o pago.`);
  if (creado.apertura || creado.ajuste) acciones.push(`Se anula la apertura del 1-1-${c.ejercicio}${creado.ajuste ? ' y su asiento de ajuste' : ''}.`);
  if (((anterior.aperturas as string[]) ?? []).length) acciones.push('Vuelve la apertura que había antes.');
  const tramo = tramoCarga(creado);
  if (tramo) acciones.push(`Se anula el diario de ${anio} importado (${varios(tramo.hasta - tramo.desde + 1, 'asiento', 'asientos')}).`);
  const plan = creado.plan as CreadoPorPlan | undefined;
  const fichas = await fichasCreadas(db, c.companyId, plan);
  if (plan?.enlaces.length) acciones.push('Los clientes y proveedores que ya existían vuelven a su subcuenta de antes (si no tienen apuntes en la nueva).');
  if (plan?.cuentas.length) acciones.push(`${varios(plan.cuentas.length, 'cuenta creada', 'cuentas creadas')} por la carga sin apuntes pasan a inactivas (el código queda ocupado).`);
  if (plan?.nombresAnteriores.length) acciones.push(`${varios(plan.nombresAnteriores.length, 'cuenta recupera', 'cuentas recuperan')} su nombre de antes.`);
  if (fichas.length) acciones.push(`${varios(fichas.length, 'ficha creada', 'fichas creadas')} por la carga: elige cuáles borrar (solo las que no tienen facturas ni apuntes).`);
  const asientos2026 = ((anterior.sustituidos as string[]) ?? []).length;
  if (asientos2026) acciones.push(`${varios(asientos2026, 'asiento', 'asientos')} de ${anio} hechos en la app que se retiraron pueden volver, si lo marcas.`);
  if (creado.llevanzaExterna && anterior.llevanza && anterior.llevanza !== 'EXTERNA') acciones.push(`${anio} vuelve a llevarse en la app.`);
  if (typeof creado.inicioEnApp === 'string') acciones.push('La fecha desde la que llevas los impuestos con la app vuelve a quedar sin indicar.');
  const previa = creado.sustituyeA ? await db.cargaArranque.findFirst({ where: { id: String(creado.sustituyeA) }, select: { version: true } }) : null;
  if (previa) acciones.push(`La versión ${previa.version} vuelve a ser la vigente.`);
  return {
    cargaId: c.id,
    version: c.version,
    estado: c.estado,
    puede: bloqueos.length === 0,
    bloqueos,
    acciones,
    fichasCreadas: fichas,
    asientos2026,
    vuelveVersion: previa?.version ?? null,
  };
}

export interface OpcionesDeshacer {
  simular?: boolean;
  /** Los asientos de 2026 hechos en la app que la carga retiro vuelven a contar. */
  devolverAsientos2026?: boolean;
  /** Fichas creadas por la carga que se borran (solo las borrables). */
  borrarFichas?: string[];
}

/** Deshace (o simula deshacer) una carga confirmada o a medias. */
export async function deshacerCarga(companyId: string, ejercicioRaw: unknown, cargaId: string, opciones: OpcionesDeshacer, userId: string): Promise<PlanDeshacer & { hecho?: string }> {
  const ejercicio = validarEjercicio(ejercicioRaw);
  const c0 = await cargaDeEmpresa(companyId, ejercicio, cargaId);
  if (c0.estado !== 'CONFIRMADA' && c0.estado !== 'APLICANDO') {
    throw conflict(c0.estado === 'BORRADOR' ? 'Esta carga es un borrador: no hay nada que deshacer (quita sus ficheros si no la quieres).' : 'Esta carga ya no está vigente.', { estado: c0.estado });
  }
  const plan0 = await planDeshacer(c0);
  if (opciones.simular) return plan0;
  if (!plan0.puede) throw conflict(plan0.bloqueos[0], { codigo: 'NO_SE_PUEDE_DESHACER', bloqueos: plan0.bloqueos });
  const borrar = new Set(opciones.borrarFichas ?? []);
  for (const id of borrar) {
    const f = plan0.fichasCreadas.find((x) => x.id === id);
    if (!f) throw badRequest('Solo se pueden borrar las fichas que creó esta carga.', { campo: 'borrarFichas' });
    if (!f.borrable) throw conflict(`«${f.nombre}» no se puede borrar: ${f.motivo}.`, { campo: 'borrarFichas' });
  }

  const hecho = await prisma.$transaction(async (tx) => {
    // Se bloquean la carga (para no cruzarse con un /aplicar), sus facturas pendientes (el mismo
    // bloqueo que toma un cobro) y sus bienes (el de una amortizacion), y se vuelven a mirar
    // los cobros y la amortizacion: si alguien ha cobrado o amortizado entre medias, 409.
    await tx.$queryRaw`SELECT id FROM CargaArranque WHERE id = ${c0.id} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM PartidaPendiente WHERE cargaId = ${c0.id} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM ActivoFijo WHERE cargaId = ${c0.id} FOR UPDATE`;
    const c = await tx.cargaArranque.findUniqueOrThrow({ where: { id: c0.id } });
    if (c.estado !== c0.estado || c.updatedAt.getTime() !== c0.updatedAt.getTime()) throw conflict('La carga ha cambiado mientras tanto: vuelve a cargar la página.');
    const ahora = await planDeshacer(c, tx);
    if (!ahora.puede) throw conflict(ahora.bloqueos[0], { codigo: 'NO_SE_PUEDE_DESHACER', bloqueos: ahora.bloqueos });
    const creado = objeto(c.creado);
    const anterior = objeto(c.anterior);
    const anio = c.ejercicio - 1;

    // Comparativo.
    if (creado.comparativo) {
      await tx.priorYearData.deleteMany({ where: { companyId, ejercicio: anio } });
      const previo = anterior.comparativo as Prisma.PriorYearDataUncheckedCreateInput | null | undefined;
      if (previo) await tx.priorYearData.create({ data: { ...previo, companyId, ejercicio: anio } });
    }
    // Bancos.
    await deshacerBancos(tx, companyId, anterior, creado);
    // Inmovilizado.
    const activos = await tx.activoFijo.findMany({ where: { companyId, cargaId: c.id }, select: { id: true } });
    const movidos = anterior.activosMovidos as { cargaId: string; ids: string[] } | undefined;
    const propios = activos.map((a) => a.id).filter((id) => !(movidos?.ids ?? []).includes(id));
    if (propios.length) {
      await tx.dotacionAmortizacion.deleteMany({ where: { companyId, activoFijoId: { in: propios } } });
      await tx.activoFijo.deleteMany({ where: { companyId, id: { in: propios } } });
    }
    if (movidos?.ids.length) await tx.activoFijo.updateMany({ where: { companyId, id: { in: movidos.ids } }, data: { cargaId: movidos.cargaId } });
    const retirados = (anterior.activosRetirados as string[] | undefined) ?? [];
    if (retirados.length) await tx.activoFijo.updateMany({ where: { companyId, id: { in: retirados } }, data: { activo: true } });
    // Facturas pendientes.
    const partidasMovidas = anterior.partidasMovidas as { cargaId: string; ids: string[] } | undefined;
    await tx.partidaPendiente.updateMany({ where: { companyId, cargaId: c.id, estado: { not: 'ANULADA' }, id: { notIn: partidasMovidas?.ids ?? [] } }, data: { estado: 'ANULADA' } });
    if (partidasMovidas?.ids.length) await tx.partidaPendiente.updateMany({ where: { companyId, id: { in: partidasMovidas.ids } }, data: { cargaId: partidasMovidas.cargaId } });
    const anuladas = anterior.partidasAnuladas;
    if (Array.isArray(anuladas) && anuladas.length) await tx.partidaPendiente.updateMany({ where: { companyId, id: { in: anuladas as string[] }, estado: 'ANULADA' }, data: { estado: 'PENDIENTE' } });
    // Apertura, ajuste y la apertura de antes.
    const propiasApertura = [creado.apertura, creado.ajuste].map((x) => (x as { id?: string } | undefined)?.id).filter((x): x is string => !!x);
    if (propiasApertura.length) await tx.journalEntry.updateMany({ where: { companyId, id: { in: propiasApertura } }, data: { estado: 'REVERSED' } });
    const aperturasAntes = (anterior.aperturas as string[] | undefined) ?? [];
    if (aperturasAntes.length) await tx.journalEntry.updateMany({ where: { companyId, id: { in: aperturasAntes }, estado: 'REVERSED' }, data: { estado: 'POSTED' } });
    // Diario de 2026: el de la carga se anula y el de la version anterior vuelve.
    const propiosHist = await historicoDe(tx, companyId, anio, tramoCarga(creado), 'POSTED');
    if (propiosHist.length) await tx.journalEntry.updateMany({ where: { id: { in: propiosHist } }, data: { estado: 'REVERSED' } });
    const antes = anterior.historicoAnulado as { desde: number; hasta: number } | null | undefined;
    const vuelven = antes && typeof antes === 'object' ? await historicoDe(tx, companyId, anio, antes, 'REVERSED') : [];
    if (vuelven.length) await tx.journalEntry.updateMany({ where: { id: { in: vuelven } }, data: { estado: 'POSTED' } });

    // Plan y fichas.
    const plan = creado.plan as CreadoPorPlan | undefined;
    let fichasBorradas = 0;
    if (plan) {
      const creadasIds = new Set([...plan.clientes, ...plan.proveedores]);
      const snap = objeto(anterior.fichas as Prisma.JsonValue);
      const antesCliente = new Map(((snap.clientes as Array<[string, string | null]>) ?? []).map(([id, s]) => [id, s]));
      const antesProv = new Map(((snap.proveedores as Array<[string, string | null, string | null]>) ?? []).map(([id, a, b]) => [id, [a, b] as const]));
      const nuevas = plan.enlaces.filter((e) => !creadasIds.has(e.fichaId)).map((e) => e.codigo);
      const conApuntes = await apuntesPropios(tx, companyId, nuevas);
      for (const e of plan.enlaces) {
        if (creadasIds.has(e.fichaId) || conApuntes.has(e.codigo)) continue;
        if (e.tipo === 'cliente') {
          await tx.customer.updateMany({ where: { id: e.fichaId, companyId, subcuenta430: e.codigo }, data: { subcuenta430: antesCliente.get(e.fichaId) ?? null } });
        } else {
          const [s400, s410] = antesProv.get(e.fichaId) ?? [null, null];
          const campo = e.codigo.startsWith('400') ? 'subcuenta400' : 'subcuenta410';
          await tx.supplier.updateMany({ where: { id: e.fichaId, companyId, [campo]: e.codigo }, data: { subcuenta400: s400, subcuenta410: s410 } });
        }
        if (e.sustituida) await tx.chartOfAccounts.updateMany({ where: { companyId, codigo: e.sustituida }, data: { activo: true } });
      }
      // Fichas creadas por la carga que se piden borrar.
      for (const id of borrar) {
        const f = plan0.fichasCreadas.find((x) => x.id === id)!;
        if (f.tipo === 'cliente') fichasBorradas += (await tx.customer.deleteMany({ where: { id, companyId } })).count;
        else fichasBorradas += (await tx.supplier.deleteMany({ where: { id, companyId } })).count;
      }
      // Cuentas creadas (o reactivadas) por la carga sin apuntes vivos ni ficha que las use: inactivas.
      const candidatas = [...new Set([...plan.cuentas, ...((anterior.reactivadas as string[] | undefined) ?? [])])];
      if (candidatas.length) {
        const usadas = await tx.journalEntryLine.groupBy({ by: ['accountCode'], where: { companyId, accountCode: { in: candidatas }, entry: { estado: { in: VIVOS } } }, _count: { _all: true } });
        const conUso = new Set(usadas.map((u) => u.accountCode));
        const [cs, ps] = await Promise.all([
          tx.customer.findMany({ where: { companyId, subcuenta430: { in: candidatas } }, select: { subcuenta430: true } }),
          tx.supplier.findMany({ where: { companyId, OR: [{ subcuenta400: { in: candidatas } }, { subcuenta410: { in: candidatas } }] }, select: { subcuenta400: true, subcuenta410: true } }),
        ]);
        for (const x of cs) if (x.subcuenta430) conUso.add(x.subcuenta430);
        for (const x of ps) for (const k of [x.subcuenta400, x.subcuenta410]) if (k) conUso.add(k);
        // Una cuenta madre sigue activa si alguna hija sigue en uso.
        const madres = new Set<string>();
        for (const k of conUso) for (let i = 1; i < k.length; i++) madres.add(k.slice(0, i));
        const inactivar = candidatas.filter((k) => !conUso.has(k) && !madres.has(k));
        if (inactivar.length) {
          await tx.chartOfAccounts.updateMany({ where: { companyId, codigo: { in: inactivar } }, data: { activo: false, notas: `${NOTA_CUENTA_DESHECHA} ${c.version} de la contabilidad de ${anio}. El código no se reutiliza.` } });
        }
      }
      for (const n of plan.nombresAnteriores) await tx.chartOfAccounts.updateMany({ where: { companyId, codigo: n.codigo }, data: { nombre: n.nombre } });
      // Longitud de antes, solo si ninguna ficha usa la nueva.
      const actual = await longitudSubcuentasGuardada(companyId, tx);
      if (actual !== null && actual !== plan.longitudAnterior) {
        const [cs, ps] = await Promise.all([
          tx.customer.findMany({ where: { companyId, subcuenta430: { not: null } }, select: { subcuenta430: true } }),
          tx.supplier.findMany({ where: { companyId, OR: [{ subcuenta400: { not: null } }, { subcuenta410: { not: null } }] }, select: { subcuenta400: true, subcuenta410: true } }),
        ]);
        const usan = [...cs.map((x) => x.subcuenta430), ...ps.flatMap((x) => [x.subcuenta400, x.subcuenta410])].some((k) => k && k.length === actual);
        if (!usan) {
          const reglas = await tx.reglasContables.findUnique({ where: { companyId }, select: { data: true } });
          const data = { ...objeto(reglas?.data as Prisma.JsonValue) };
          if (plan.longitudAnterior === null) delete data.longitudSubcuentas;
          else data.longitudSubcuentas = plan.longitudAnterior;
          await tx.reglasContables.update({ where: { companyId }, data: { data: data as Prisma.InputJsonValue } });
        }
      }
    }
    // Marca de plan anterior traido.
    if ('planAnterior' in anterior) {
      const reglas = await tx.reglasContables.findUnique({ where: { companyId }, select: { data: true } });
      if (reglas) {
        const data = { ...objeto(reglas.data as Prisma.JsonValue) };
        if (anterior.planAnterior) data.planAnterior = anterior.planAnterior;
        else delete data.planAnterior;
        await tx.reglasContables.update({ where: { companyId }, data: { data: data as Prisma.InputJsonValue } });
      }
    }
    // Asientos de 2026 retirados y llevanza.
    const sustituidos = (anterior.sustituidos as string[] | undefined) ?? [];
    if (opciones.devolverAsientos2026 && sustituidos.length) {
      await tx.journalEntry.updateMany({ where: { companyId, id: { in: sustituidos }, estado: 'SUSTITUIDO' }, data: { estado: 'POSTED' } });
    }
    if (creado.llevanzaExterna && typeof anterior.llevanza === 'string') {
      await tx.fiscalYear.updateMany({ where: { companyId, label: String(anio) }, data: { llevanza: anterior.llevanza } });
    }
    // Inicio en la app: vuelve el de antes, salvo que alguien lo haya cambiado despues en Configuracion.
    if (typeof creado.inicioEnApp === 'string') {
      const previo = (anterior.inicioEnApp ?? null) as { valor?: string | null } | null;
      await tx.ajustesFiscales.updateMany({ where: { companyId, inicioEnApp: creado.inicioEnApp }, data: { inicioEnApp: previo?.valor ?? null } });
    }
    // La carga queda deshecha y la que sustituyo vuelve.
    await tx.cargaArranque.update({ where: { id: c.id }, data: { estado: 'DESHECHA' } });
    if (creado.sustituyeA) await tx.cargaArranque.updateMany({ where: { id: String(creado.sustituyeA), estado: 'SUSTITUIDA' }, data: { estado: 'CONFIRMADA' } });
    return { fichasBorradas };
  }, OPCIONES_TX);

  await registrarAuditoria({
    userId,
    companyId,
    action: 'ARRANQUE_DESHECHA',
    resourceType: 'CargaArranque',
    resourceId: c0.id,
    meta: { version: c0.version, estado: c0.estado, acciones: plan0.acciones, fichasBorradas: hecho.fichasBorradas, devolverAsientos2026: !!opciones.devolverAsientos2026 },
  });
  return {
    ...plan0,
    hecho: `Carga ${c0.version} deshecha${plan0.vuelveVersion ? `: vuelve a estar vigente la versión ${plan0.vuelveVersion}` : ''}.${hecho.fichasBorradas ? ` ${varios(hecho.fichasBorradas, 'ficha borrada', 'fichas borradas')}.` : ''}`,
  };
}
