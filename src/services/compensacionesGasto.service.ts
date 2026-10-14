/**
 * Compensaciones de abonos de proveedor (CompensacionGasto): aplicar un abono
 * (factura de gasto con total < 0) a una factura del mismo proveedor, sin
 * movimiento de dinero.
 *
 *  - AUTO: al quedar contabilizado el abono (alta en firme o aprobacion del
 *    borrador del lector), contra cada original de la app por lo que quede
 *    pendiente de ella, hasta la parte del abono que le toca. Se anula con el
 *    abono y se rehace al corregirlo.
 *  - MANUAL: «Aplicar a otra factura» del mismo proveedor, o a una factura de
 *    fuera de la app (2026 llevada fuera: numero y fecha, sin asiento).
 *
 * Si abono y factura van a subcuentas distintas (400N frente a 410N), un
 * asiento de traspaso con origen TESORERIA e invoiceId null: la de la factura
 * al debe y la del abono al haber. Si comparten subcuenta, no hace falta.
 *
 * Lo aplicado a cada factura (pagos mas compensaciones) lo suma
 * aplicadoPorFactura (cobrosPagos.service).
 */
import { prisma, type TransaccionBD } from '../config/database';
import { badRequest, conflict, notFound } from '../utils/http-errors';
import { aCentimos, importeTexto } from '../utils/money';
import { hoyEspana } from '../utils/fechas';
import { conReintento } from '../utils/reintento';
import { fechaContableGasto } from '../domain/factura-gasto.model';
import { esFechaReal } from '../schemas/factura-gasto.schemas';
import { comprobarFechaAbierta } from './periodos.service';
import { aplicadoPorFactura, recalcularEstadoPagoGasto } from './cobrosPagos.service';
import { cuentaProveedorDeFactura } from './rectificativasGasto.service';
import { registrarAuditoria } from './auditoria.service';
import { partidasDeCompensacion, pendientePorPartida, recalcularEstadoPartidas } from './arranque/partidas.service';

type Db = TransaccionBD | typeof prisma;

const ddmmaaaa = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}`;
const numeroDe = (f: { numeroFacturaProveedor: string | null; numeroCompleto: string }) => f.numeroFacturaProveedor ?? f.numeroCompleto;

export interface CompensacionResp {
  id: string;
  abonoId: string;
  facturaId: string | null;
  /** La otra parte: la factura que recibe el abono (en el abono) o el abono que se aplica (en la factura). */
  otra: { id: string | null; numeroCompleto: string | null; numero: string | null; fecha: string | null; fuera: boolean };
  fecha: string;
  importe: number;
  origen: string;
  estado: string;
  asientoId: string | null;
  anuladaEn: string | null;
}

/** Bloquea las facturas (SELECT ... FOR UPDATE) en orden de id, para que dos aplicaciones a la vez no se crucen. */
async function bloquear(tx: TransaccionBD, ids: string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) await tx.$queryRaw`SELECT id FROM ExpenseInvoice WHERE id = ${id} FOR UPDATE`;
}

/**
 * Pendiente con signo (total - aplicado) de cada factura, leido dentro de la
 * transaccion. Una factura de 2026 que la gestoria trajo pendiente (partida de
 * «Traer la contabilidad de 2026» enlazada) se paga contra su partida: lo que
 * queda es lo de la partida, no lo de la factura.
 */
async function pendientes(tx: TransaccionBD, companyId: string, fs: Array<{ id: string; totalFactura: number }>): Promise<Map<string, number>> {
  const ids = fs.map((f) => f.id);
  const [aplicado, partidas] = await Promise.all([aplicadoPorFactura(companyId, ids, undefined, tx), partidasDeCompensacion(tx, companyId, { facturaIds: ids })]);
  const quedaPartida = await pendientePorPartida(tx, companyId, partidas.map((p) => p.id));
  const porFactura = new Map(partidas.map((p) => [p.expenseInvoiceId!, aCentimos(quedaPartida.get(p.id) ?? 0)]));
  return new Map(fs.map((f) => [f.id, porFactura.get(f.id) ?? aCentimos(Number(f.totalFactura)) - aCentimos(aplicado.get(f.id) ?? 0)]));
}

/**
 * Partida de 2026 de una factura de fuera de la app (mismo proveedor y mismo
 * numero) y lo que queda de ella en centimos; null si la gestoria no la trajo.
 */
async function partidaFuera(tx: TransaccionBD, companyId: string, supplierId: string, numero: string | null | undefined): Promise<{ id: string; quedaCent: number } | null> {
  if (!numero) return null;
  const [p] = await partidasDeCompensacion(tx, companyId, { fuera: { supplierId, numero } });
  if (!p) return null;
  const queda = await pendientePorPartida(tx, companyId, [p.id]);
  return { id: p.id, quedaCent: aCentimos(queda.get(p.id) ?? 0) };
}

/** Partidas de 2026 que toca una compensacion (las de sus dos facturas o la de fuera con su numero). */
async function partidasTocadas(tx: TransaccionBD, companyId: string, c: { abonoId: string; facturaId: string | null; numeroFuera?: string | null }): Promise<string[]> {
  const facturaIds = [c.abonoId, ...(c.facturaId ? [c.facturaId] : [])];
  let fuera: { supplierId: string; numero: string } | undefined;
  if (!c.facturaId && c.numeroFuera) {
    const abono = await tx.expenseInvoice.findFirst({ where: { id: c.abonoId, companyId }, select: { supplierId: true } });
    if (abono) fuera = { supplierId: abono.supplierId, numero: c.numeroFuera };
  }
  return (await partidasDeCompensacion(tx, companyId, { facturaIds, fuera })).map((p) => p.id);
}

/**
 * Asiento de traspaso entre la subcuenta de la factura y la del abono, si son
 * distintas (null si comparten subcuenta). Origen TESORERIA e invoiceId null:
 * asi no se toma por el asiento de ninguna de las dos facturas.
 */
async function asientoTraspaso(
  tx: TransaccionBD,
  companyId: string,
  p: { fecha: string; importeCent: number; abono: { id: string; numero: string }; factura: { id: string; numero: string }; proveedor: string },
): Promise<string | null> {
  const [cuentaAbono, cuentaFactura] = await Promise.all([cuentaProveedorDeFactura(tx, companyId, p.abono.id), cuentaProveedorDeFactura(tx, companyId, p.factura.id)]);
  if (!cuentaAbono || !cuentaFactura || cuentaAbono === cuentaFactura) return null;
  await comprobarFechaAbierta(companyId, p.fecha, 'aplicar el abono', tx);
  const nombres = await tx.chartOfAccounts.findMany({ where: { companyId, codigo: { in: [cuentaAbono, cuentaFactura] } }, select: { codigo: true, nombre: true } });
  const nombre = (c: string) => nombres.find((x) => x.codigo === c)?.nombre ?? p.proveedor;
  const existentes = await tx.journalEntry.findMany({ where: { companyId, numeroAsiento: { startsWith: 'COMP-' } }, select: { numeroAsiento: true } });
  const siguiente = existentes.reduce((m, e) => Math.max(m, Number(e.numeroAsiento.slice(5)) || 0), 0) + 1;
  const importe = p.importeCent / 100;
  const a = await tx.journalEntry.create({
    data: {
      companyId,
      fecha: new Date(`${p.fecha}T00:00:00.000Z`),
      numeroAsiento: `COMP-${String(siguiente).padStart(5, '0')}`,
      descripcion: `Abono ${p.abono.numero} aplicado a la factura ${p.factura.numero} - ${p.proveedor}`.slice(0, 190),
      origen: 'TESORERIA',
      estado: 'POSTED',
      lineas: {
        create: [
          { accountCode: cuentaFactura, accountName: nombre(cuentaFactura).slice(0, 190), debe: importe, haber: 0, referencia: p.factura.numero.slice(0, 190), companyId },
          { accountCode: cuentaAbono, accountName: nombre(cuentaAbono).slice(0, 190), debe: 0, haber: importe, referencia: p.abono.numero.slice(0, 190), companyId },
        ],
      },
    },
  });
  return a.id;
}

/**
 * Compensaciones AUTO de un abono recien contabilizado: contra cada original
 * de la app, min(|parte del abono|, pendiente de la original), con la fecha
 * contable del abono; y, si el alta lo pidio, la «de fuera» contra su
 * original de fuera de la app. Dentro de la transaccion del alta o de la
 * aprobacion. Recalcula el estado de pago de todas.
 */
export async function crearCompensacionesAuto(tx: TransaccionBD, companyId: string, abonoId: string, opciones: { userId?: string | null; fuera?: boolean } = {}): Promise<void> {
  const abono = await tx.expenseInvoice.findFirst({
    where: { id: abonoId, companyId },
    include: { rectifica: true, supplier: { select: { nombreFiscal: true } } },
  });
  if (!abono || !abono.esRectificativa || abono.estado !== 'ACCOUNTED' || aCentimos(Number(abono.totalFactura)) >= 0) return;
  const conOriginal = abono.rectifica.filter((e) => e.originalId);
  const originales = conOriginal.length
    ? await tx.expenseInvoice.findMany({ where: { companyId, id: { in: conOriginal.map((e) => e.originalId!) }, estado: { not: 'ANULADA' } } })
    : [];
  await bloquear(tx, [abonoId, ...originales.map((o) => o.id)]);
  const pend = await pendientes(tx, companyId, [abono, ...originales]);
  let aFavor = -(pend.get(abonoId) ?? 0);
  const fecha = fechaContableGasto(abono);
  for (const e of conOriginal) {
    const o = originales.find((x) => x.id === e.originalId);
    if (!o || aFavor <= 0) continue;
    const parte = -(aCentimos(Number(e.baseRectificada ?? 0)) + aCentimos(Number(e.cuotaRectificada ?? 0)) - aCentimos(Number(e.retencionRectificada ?? 0)));
    const importe = Math.min(parte, Math.max(0, pend.get(o.id) ?? 0), aFavor);
    if (importe <= 0) continue;
    const journalEntryId = await asientoTraspaso(tx, companyId, {
      fecha,
      importeCent: importe,
      abono: { id: abono.id, numero: numeroDe(abono) },
      factura: { id: o.id, numero: numeroDe(o) },
      proveedor: abono.supplier.nombreFiscal,
    });
    await tx.compensacionGasto.create({
      data: { companyId, abonoId, facturaId: o.id, fecha, importe: importe / 100, origen: 'AUTO', journalEntryId, userId: opciones.userId ?? null },
    });
    aFavor -= importe;
    pend.set(o.id, (pend.get(o.id) ?? 0) - importe);
    await recalcularEstadoPagoGasto(tx, companyId, o.id);
  }
  // «No, se descuenta de lo que le debo»: el abono de una factura llevada fuera se aplica a ella.
  // Sin `fuera` (aprobacion del borrador del lector), la respuesta guardada en el alta.
  const fuera = abono.rectifica.find((e) => !e.originalId && !e.periodoDesde && e.numeroOriginal && e.fechaOriginal);
  const tocadas = new Set((await partidasDeCompensacion(tx, companyId, { facturaIds: [abonoId, ...originales.map((o) => o.id)] })).map((p) => p.id));
  if ((opciones.fuera ?? abono.compensarFuera === true) && fuera && aFavor > 0) {
    // Si la gestoria trajo esa factura entre las pendientes de 2026, el abono
    // rebaja su partida, como mucho hasta lo que quede de ella.
    const partida = await partidaFuera(tx, companyId, abono.supplierId, fuera.numeroOriginal);
    const importe = partida ? Math.min(aFavor, Math.max(0, partida.quedaCent)) : aFavor;
    if (importe > 0) {
      await tx.compensacionGasto.create({
        data: { companyId, abonoId, facturaId: null, numeroFuera: fuera.numeroOriginal, fechaFuera: fuera.fechaOriginal, fecha, importe: importe / 100, origen: 'AUTO', userId: opciones.userId ?? null },
      });
      if (partida) tocadas.add(partida.id);
    }
  }
  await recalcularEstadoPagoGasto(tx, companyId, abonoId);
  await recalcularEstadoPartidas(tx, companyId, [...tocadas]);
}

/** Anula una compensacion dentro de una transaccion: su asiento de traspaso pasa a REVERSED (o contraasiento si su periodo esta cerrado). */
async function anularEnTx(
  tx: TransaccionBD,
  companyId: string,
  c: { id: string; abonoId: string; facturaId: string | null; numeroFuera?: string | null; journalEntryId: string | null },
  fecha: string,
): Promise<void> {
  // Partidas de 2026 que vuelven a tener pendiente lo que se les habia descontado.
  const tocadas = await partidasTocadas(tx, companyId, c);
  const r = await tx.compensacionGasto.updateMany({ where: { id: c.id, estado: 'ACTIVO' }, data: { estado: 'ANULADO', anuladaEn: fecha } });
  if (r.count !== 1) throw conflict('Esa aplicación ya está anulada.');
  if (c.journalEntryId) {
    const a = await tx.journalEntry.findFirst({ where: { id: c.journalEntryId, companyId }, include: { lineas: true } });
    if (a && a.estado !== 'REVERSED') {
      let abierto = true;
      try {
        await comprobarFechaAbierta(companyId, a.fecha.toISOString().slice(0, 10), undefined, tx);
      } catch {
        abierto = false;
      }
      if (abierto) await tx.journalEntry.update({ where: { id: a.id }, data: { estado: 'REVERSED' } });
      else {
        await comprobarFechaAbierta(companyId, fecha, 'anular la aplicación del abono', tx);
        await tx.journalEntry.create({
          data: {
            companyId,
            fecha: new Date(`${fecha}T00:00:00.000Z`),
            numeroAsiento: `${a.numeroAsiento}-ANUL`.slice(0, 190),
            descripcion: `Anulación: ${a.descripcion}`.slice(0, 190),
            origen: 'TESORERIA',
            estado: 'POSTED',
            lineas: { create: a.lineas.map((l) => ({ accountCode: l.accountCode, accountName: l.accountName, debe: l.haber, haber: l.debe, referencia: l.referencia, companyId })) },
          },
        });
      }
    }
  }
  await recalcularEstadoPagoGasto(tx, companyId, c.abonoId);
  if (c.facturaId) await recalcularEstadoPagoGasto(tx, companyId, c.facturaId);
  await recalcularEstadoPartidas(tx, companyId, tocadas);
}

/** Anula las compensaciones AUTO de un abono (al anularlo o antes de rehacerlas al corregirlo). */
export async function anularCompensacionesAuto(tx: TransaccionBD, companyId: string, abonoId: string, fecha: string = hoyEspana()): Promise<void> {
  const autos = await tx.compensacionGasto.findMany({ where: { companyId, abonoId, origen: 'AUTO', estado: 'ACTIVO' } });
  for (const c of autos) await anularEnTx(tx, companyId, c, fecha);
}

/** Texto de una lista de compensaciones activas: «el abono R-4 por 30,00 €, …». */
async function listaCompensaciones(db: Db, companyId: string, cs: Array<{ abonoId: string; facturaId: string | null; numeroFuera: string | null; importe: number }>, desde: 'factura' | 'abono'): Promise<string> {
  const ids = cs.map((c) => (desde === 'factura' ? c.abonoId : c.facturaId)).filter((x): x is string => !!x);
  const fs = ids.length ? await db.expenseInvoice.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, numeroCompleto: true, numeroFacturaProveedor: true } }) : [];
  const num = (id: string | null, fuera: string | null) => {
    const f = fs.find((x) => x.id === id);
    return f ? numeroDe(f) : (fuera ?? '');
  };
  return cs.map((c) => `${desde === 'factura' ? 'el abono' : 'la factura'} ${num(desde === 'factura' ? c.abonoId : c.facturaId, c.numeroFuera)} por ${importeTexto(c.importe)}`).join(', ');
}

/**
 * 409 si la factura tiene compensaciones que impiden anularla o corregirla:
 * las que ha recibido (se tratan como pagos; al corregir solo si el total
 * nuevo baja de lo compensado) y, si es un abono, sus aplicaciones MANUAL.
 */
export async function comprobarCompensaciones(db: Db, companyId: string, id: string, opciones: { totalNuevo?: number } = {}): Promise<void> {
  const recibidas = await db.compensacionGasto.findMany({ where: { companyId, facturaId: id, estado: 'ACTIVO' } });
  const recibido = recibidas.reduce((a, c) => a + aCentimos(Number(c.importe)), 0);
  if (recibidas.length && (opciones.totalNuevo === undefined || aCentimos(opciones.totalNuevo) < recibido)) {
    const lista = await listaCompensaciones(db, companyId, recibidas, 'factura');
    throw conflict(`Tiene aplicado ${lista}: anula antes ${recibidas.length === 1 ? 'esa aplicación' : 'esas aplicaciones'}.`, { motivo: 'tiene_compensaciones' });
  }
  const manuales = await db.compensacionGasto.findMany({ where: { companyId, abonoId: id, origen: 'MANUAL', estado: 'ACTIVO' } });
  if (manuales.length) {
    const lista = await listaCompensaciones(db, companyId, manuales, 'abono');
    throw conflict(`Este abono está aplicado a ${lista}: anula antes ${manuales.length === 1 ? 'esa aplicación' : 'esas aplicaciones'}.`, { motivo: 'tiene_compensaciones' });
  }
}

/**
 * «Aplicar a otra factura» (MANUAL): el abono `abonoId` a una factura del
 * mismo proveedor sin anular y con algo pendiente, o a una factura de fuera de
 * la app (numeroFuera y fechaFuera). Importe: por defecto lo que quede de los
 * dos; nunca mas.
 */
export async function aplicarAbono(
  companyId: string,
  abonoId: string,
  datos: { facturaId?: unknown; numeroFuera?: unknown; fechaFuera?: unknown; importe?: unknown; fecha?: unknown },
  ctx: { userId?: string } = {},
): Promise<CompensacionResp> {
  const abono = await prisma.expenseInvoice.findFirst({ where: { id: abonoId, companyId }, include: { supplier: { select: { nombreFiscal: true } } } });
  if (!abono) throw notFound('Factura de gasto no encontrada.');
  if (aCentimos(Number(abono.totalFactura)) >= 0) throw badRequest('Solo un abono (una factura con importe negativo) se puede aplicar a otra factura.');
  if (abono.estado === 'ANULADA') throw badRequest('El abono está anulado.');
  if (abono.estado !== 'ACCOUNTED') throw badRequest('Aprueba antes el asiento del abono en el Motor contable.');

  const fecha = typeof datos.fecha === 'string' && datos.fecha ? datos.fecha : hoyEspana();
  if (!esFechaReal(fecha)) throw badRequest('La fecha no es válida (AAAA-MM-DD).', { campo: 'fecha' });
  if (fecha < fechaContableGasto(abono)) throw badRequest(`La fecha no puede ser anterior a la del abono (${ddmmaaaa(fechaContableGasto(abono))}).`, { campo: 'fecha' });
  const facturaId = typeof datos.facturaId === 'string' && datos.facturaId.trim() ? datos.facturaId.trim() : null;
  const numeroFuera = typeof datos.numeroFuera === 'string' && datos.numeroFuera.trim() ? datos.numeroFuera.trim().slice(0, 60) : null;
  const fechaFuera = typeof datos.fechaFuera === 'string' && datos.fechaFuera ? datos.fechaFuera : null;
  if (!facturaId && !numeroFuera) throw badRequest('Elige la factura a la que aplicas el abono, o escribe el número de una factura de fuera de la app.', { campo: 'facturaId' });
  if (!facturaId && (!fechaFuera || !esFechaReal(fechaFuera))) throw badRequest('Indica la fecha de esa factura de fuera de la app.', { campo: 'fechaFuera' });
  let solicitado: number | null = null;
  if (datos.importe !== undefined && datos.importe !== null && datos.importe !== '') {
    solicitado = aCentimos(Number(datos.importe));
    if (!Number.isFinite(Number(datos.importe)) || solicitado <= 0) throw badRequest('El importe tiene que ser mayor que cero.', { campo: 'importe' });
  }

  const factura = facturaId ? await prisma.expenseInvoice.findFirst({ where: { id: facturaId, companyId } }) : null;
  if (facturaId) {
    if (!factura) throw notFound('No se encuentra la factura a la que aplicas el abono.');
    if (factura.id === abono.id) throw badRequest('Un abono no se aplica a sí mismo.', { campo: 'facturaId' });
    if (factura.supplierId !== abono.supplierId) throw badRequest(`La factura ${numeroDe(factura)} es de otro proveedor.`, { campo: 'facturaId' });
    if (factura.estado === 'ANULADA') throw badRequest(`La factura ${numeroDe(factura)} está anulada.`, { campo: 'facturaId' });
    if (factura.estado === 'DRAFT') throw badRequest(`Aprueba antes la factura ${numeroDe(factura)}: está pendiente de revisar.`, { campo: 'facturaId' });
    if (aCentimos(Number(factura.totalFactura)) <= 0) throw badRequest(`${numeroDe(factura)} es otro abono: elige una factura.`, { campo: 'facturaId' });
  }
  await comprobarFechaAbierta(companyId, fecha, 'aplicar el abono');

  const id = await conReintento(() =>
    prisma.$transaction(async (tx) => {
      await bloquear(tx, [abono.id, ...(factura ? [factura.id] : [])]);
      // Con las dos bloqueadas se vuelven a leer: otra peticion pudo anularlas o corregirlas despues de la primera lectura.
      const [abonoAhora, facturaAhora] = await Promise.all([
        tx.expenseInvoice.findFirst({ where: { id: abono.id, companyId } }),
        factura ? tx.expenseInvoice.findFirst({ where: { id: factura.id, companyId } }) : Promise.resolve(null),
      ]);
      const cambiado =
        !abonoAhora ||
        abonoAhora.estado !== 'ACCOUNTED' ||
        aCentimos(Number(abonoAhora.totalFactura)) >= 0 ||
        (factura &&
          (!facturaAhora ||
            facturaAhora.supplierId !== abono.supplierId ||
            facturaAhora.estado === 'ANULADA' ||
            facturaAhora.estado === 'DRAFT' ||
            aCentimos(Number(facturaAhora.totalFactura)) <= 0));
      if (cambiado) {
        throw conflict(
          factura && abonoAhora?.estado === 'ACCOUNTED'
            ? `La factura ${numeroDe(factura)} ha cambiado mientras aplicabas el abono: vuelve a abrirla.`
            : `El abono ${numeroDe(abono)} ha cambiado mientras lo aplicabas: vuelve a abrirlo.`,
          { motivo: 'factura_cambiada' },
        );
      }
      const pend = await pendientes(tx, companyId, [abonoAhora, ...(facturaAhora ? [facturaAhora] : [])]);
      const aFavor = -(pend.get(abono.id) ?? 0);
      if (aFavor <= 0) throw conflict(`No queda nada a tu favor en el abono ${numeroDe(abono)}: ya está devuelto o aplicado.`);
      // Factura de fuera que la gestoria trajo entre las pendientes de 2026: como mucho, lo que quede de ella.
      const partida = factura ? null : await partidaFuera(tx, companyId, abono.supplierId, numeroFuera);
      if (partida && partida.quedaCent <= 0) {
        throw conflict(`La factura ${numeroFuera} ya no tiene nada pendiente de pago: está entre las pendientes de 2026 que trajo la gestoría y ya se pagó.`);
      }
      const tope = factura ? Math.min(aFavor, pend.get(factura.id) ?? 0) : partida ? Math.min(aFavor, partida.quedaCent) : aFavor;
      if (factura && tope <= 0) throw conflict(`La factura ${numeroDe(factura)} no tiene nada pendiente de pago.`);
      const importe = solicitado ?? tope;
      if (importe > tope) {
        const deFactura = (factura || partida) && tope < aFavor;
        throw badRequest(
          `El importe (${importeTexto(importe / 100)}) supera lo que queda ${deFactura ? `pendiente de la factura ${factura ? numeroDe(factura) : numeroFuera}` : 'a tu favor en el abono'} (${importeTexto(tope / 100)}).`,
          { campo: 'importe' },
        );
      }
      const journalEntryId = factura
        ? await asientoTraspaso(tx, companyId, {
            fecha,
            importeCent: importe,
            abono: { id: abono.id, numero: numeroDe(abono) },
            factura: { id: factura.id, numero: numeroDe(factura) },
            proveedor: abono.supplier.nombreFiscal,
          })
        : null;
      const c = await tx.compensacionGasto.create({
        data: {
          companyId,
          abonoId: abono.id,
          facturaId: factura?.id ?? null,
          numeroFuera: factura ? null : numeroFuera,
          fechaFuera: factura ? null : fechaFuera,
          fecha,
          importe: importe / 100,
          origen: 'MANUAL',
          journalEntryId,
          userId: ctx.userId ?? null,
        },
      });
      await recalcularEstadoPagoGasto(tx, companyId, abono.id);
      if (factura) await recalcularEstadoPagoGasto(tx, companyId, factura.id);
      await recalcularEstadoPartidas(tx, companyId, await partidasTocadas(tx, companyId, c));
      return c.id;
    }),
  );
  await registrarAuditoria({
    userId: ctx.userId ?? 'SYSTEM',
    companyId,
    action: 'APLICAR_ABONO_GASTO',
    resourceType: 'CompensacionGasto',
    resourceId: id,
    meta: { abonoId, facturaId: factura?.id ?? null, numeroFuera },
  });
  return (await compensacionesDe(companyId, abono.id)).find((c) => c.id === id)!;
}

/** Anula una aplicacion de un abono (MANUAL o AUTO). */
export async function anularCompensacion(companyId: string, abonoId: string, compensacionId: string, datos: { fecha?: unknown } = {}, ctx: { userId?: string } = {}): Promise<CompensacionResp[]> {
  const c = await prisma.compensacionGasto.findFirst({ where: { id: compensacionId, companyId, abonoId } });
  if (!c) throw notFound('Aplicación no encontrada.');
  if (c.estado !== 'ACTIVO') throw conflict('Esa aplicación ya está anulada.');
  const fecha = typeof datos.fecha === 'string' && datos.fecha ? datos.fecha : hoyEspana();
  if (!esFechaReal(fecha)) throw badRequest('La fecha no es válida (AAAA-MM-DD).', { campo: 'fecha' });
  await conReintento(() =>
    prisma.$transaction(async (tx) => {
      await bloquear(tx, [c.abonoId, ...(c.facturaId ? [c.facturaId] : [])]);
      await anularEnTx(tx, companyId, c, fecha);
    }),
  );
  await registrarAuditoria({ userId: ctx.userId ?? 'SYSTEM', companyId, action: 'ANULAR_APLICACION_ABONO_GASTO', resourceType: 'CompensacionGasto', resourceId: c.id, meta: { abonoId } });
  return compensacionesDe(companyId, abonoId);
}

/** Compensaciones de una factura: las del abono (si lo es) y las que ha recibido. */
export async function compensacionesDe(companyId: string, invoiceId: string): Promise<CompensacionResp[]> {
  const cs = await prisma.compensacionGasto.findMany({
    where: { companyId, OR: [{ abonoId: invoiceId }, { facturaId: invoiceId }] },
    orderBy: [{ fecha: 'asc' }, { createdAt: 'asc' }],
  });
  const ids = [...new Set(cs.flatMap((c) => [c.abonoId, c.facturaId]).filter((x): x is string => !!x && x !== invoiceId))];
  const fs = ids.length ? await prisma.expenseInvoice.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, numeroCompleto: true, numeroFacturaProveedor: true, fechaEmision: true } }) : [];
  return cs.map((c) => {
    const otraId = c.abonoId === invoiceId ? c.facturaId : c.abonoId;
    const f = fs.find((x) => x.id === otraId);
    return {
      id: c.id,
      abonoId: c.abonoId,
      facturaId: c.facturaId,
      otra: f
        ? { id: f.id, numeroCompleto: f.numeroCompleto, numero: f.numeroFacturaProveedor, fecha: f.fechaEmision, fuera: false }
        : { id: null, numeroCompleto: null, numero: c.numeroFuera, fecha: c.fechaFuera, fuera: true },
      fecha: c.fecha,
      importe: c.importe,
      origen: c.origen,
      estado: c.estado,
      asientoId: c.journalEntryId,
      anuladaEn: c.anuladaEn,
    };
  });
}
