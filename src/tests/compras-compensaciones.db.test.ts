/**
 * Abonos de proveedor en la cartera: la compensacion automatica contra la
 * original, lo que queda a favor, la devolucion recibida (un pago en
 * negativo), la aplicacion a otra factura (tambien a una de fuera de la app),
 * el traspaso entre la 400N y la 410N, la anulacion, dos aplicaciones a la vez,
 * el borrador del lector y el cruce de la cartera con el mayor por proveedor.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { proveedoresService } from '../services/proveedores.service';
import { anularGasto, editarGasto, expenseInvoicesService, registrarGasto } from '../services/expense-invoices.service';
import { anularCobroFactura, listarCobros, registrarCobroFactura, totalCobradoEntre } from '../services/cobrosPagos.service';
import { anularCompensacion, aplicarAbono } from '../services/compensacionesGasto.service';
import { AccountingEngineController } from '../controllers/accounting-engine.controller';
import { asegurarPlanContableEmpresa } from '../services/chart-of-accounts.service';
import { informeMayorTerceros } from '../services/informesContables.service';
import { aCentimos } from '../utils/money';
import { controlCif } from '../utils/nif';

const SUFIJO = Date.now();
let n = 0;
function cif(): string {
  const siete = String(1000000 + ((SUFIJO + n++ * 7919) % 8999999)).slice(0, 7);
  return `B${siete}${controlCif(siete).cifra}`;
}

async function empresa(nombre: string): Promise<{ E: string; banco: string }> {
  const E = `comp-${nombre}-${SUFIJO}`;
  await prisma.company.create({ data: { id: E, name: `Compensaciones ${nombre} SL`, fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: E, denominacion: `Compensaciones ${nombre} SL`, nif: cif() } });
  await asegurarPlanContableEmpresa(E);
  const banco = (await prisma.bankAccount.create({ data: { companyId: E, iban: `ES00${SUFIJO}${n++}`, bancoNombre: 'Banco', subcuentaCodigo: '5720001' } })).id;
  return { E, banco };
}

const lin = (precio: number, extra: Record<string, unknown> = {}) => ({ descripcion: 'Concepto', cantidad: 1, precioUnitario: precio, tipoIva: 21, ...extra });

const factura = (supplierId: string, numero: string, fecha: string, precio: number, extra: Record<string, unknown> = {}) => ({
  proveedor: { id: supplierId },
  numeroFacturaProveedor: numero,
  fechaEmision: fecha,
  tipoGasto: 'COMPRA',
  lineas: [lin(precio)],
  ...extra,
});

const abonoDe = (supplierId: string, numero: string, fecha: string, precio: number, originales: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
  factura(supplierId, numero, fecha, precio, { lineas: [lin(precio, { cuenta: '608' })], rectificativa: { tipo: 'I', causa: 'DEVOLUCION', originales }, ...extra });

async function ficha(E: string, id: string) {
  return expenseInvoicesService.obtenerPorId(E, id);
}

async function error(p: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await p;
  } catch (e) {
    return { status: (e as { statusCode: number }).statusCode, message: (e as Error).message };
  }
  throw new Error('No dio error');
}

describe('compensación automática al registrar el abono', () => {
  let E: string;
  let banco: string;
  let prov: string;

  beforeAll(async () => {
    ({ E, banco } = await empresa('auto'));
    prov = (await proveedoresService.create(E, { nombreFiscal: 'Mayorista Turia SL', nifCif: cif() })).id;
  });

  it('resta de lo pendiente de la original; el abono queda aplicado', async () => {
    const o = await registrarGasto(E, factura(prov, 'F-1', '2027-01-10', 100), { contabilizar: 'POSTED' });
    const a = await registrarGasto(E, abonoDe(prov, 'R-1', '2027-01-20', -20, [{ id: o.factura.id }]), { contabilizar: 'POSTED' });
    const fo = await ficha(E, o.factura.id);
    expect(fo).toMatchObject({ importePendiente: 96.8, estadoPago: 'PARCIAL' });
    expect(fo.compensaciones).toEqual([expect.objectContaining({ origen: 'AUTO', importe: 24.2, estado: 'ACTIVO', otra: expect.objectContaining({ numero: 'R-1' }) })]);
    const fa = await ficha(E, a.factura.id);
    expect(fa).toMatchObject({ pendiente: 0, aFavor: 0, estadoPago: 'PAGADA' });
    // No se puede pagar de más la original: lo pendiente ya descuenta el abono.
    expect((await error(registrarCobroFactura(E, 'GASTO', o.factura.id, { importe: 100, cuentaBancariaId: banco, fecha: '2027-01-25' }))).message).toMatch(
      /supera lo pendiente de la factura \(96\.80/,
    );
    await registrarCobroFactura(E, 'GASTO', o.factura.id, { cuentaBancariaId: banco, fecha: '2027-01-25' });
    expect((await ficha(E, o.factura.id)).estadoPago).toBe('PAGADA');
  });

  it('original ya pagada: todo queda a favor y el abono sale pendiente, no pagado', async () => {
    const o = await registrarGasto(E, factura(prov, 'F-2', '2027-01-10', 100), { contabilizar: 'POSTED' });
    await registrarCobroFactura(E, 'GASTO', o.factura.id, { cuentaBancariaId: banco, fecha: '2027-01-12' });
    const a = await registrarGasto(E, abonoDe(prov, 'R-2', '2027-01-20', -50, [{ id: o.factura.id }]), { contabilizar: 'POSTED' });
    const fa = await ficha(E, a.factura.id);
    expect(fa).toMatchObject({ pendiente: -60.5, aFavor: 60.5, estadoPago: 'PENDIENTE', vencida: false, compensaciones: [] });
  });

  it('original pagada en parte: se compensa lo pendiente y el resto queda a favor', async () => {
    const o = await registrarGasto(E, factura(prov, 'F-3', '2027-01-10', 100), { contabilizar: 'POSTED' });
    await registrarCobroFactura(E, 'GASTO', o.factura.id, { importe: 100, cuentaBancariaId: banco, fecha: '2027-01-12' });
    const a = await registrarGasto(E, abonoDe(prov, 'R-3', '2027-01-20', -50, [{ id: o.factura.id }]), { contabilizar: 'POSTED' });
    expect(await ficha(E, o.factura.id)).toMatchObject({ importePendiente: 0, estadoPago: 'PAGADA' });
    expect(await ficha(E, a.factura.id)).toMatchObject({ aFavor: 39.5, estadoPago: 'PARCIAL' });
  });

  it('devolución recibida: un pago en negativo, banco al debe y proveedor al haber; no más de lo que queda a favor', async () => {
    const o = await registrarGasto(E, factura(prov, 'F-4', '2027-01-10', 100), { contabilizar: 'POSTED' });
    await registrarCobroFactura(E, 'GASTO', o.factura.id, { cuentaBancariaId: banco, fecha: '2027-01-12' });
    const a = await registrarGasto(E, abonoDe(prov, 'R-4', '2027-01-20', -100, [{ id: o.factura.id }]), { contabilizar: 'POSTED' });
    expect((await error(registrarCobroFactura(E, 'GASTO', a.factura.id, { importe: 130, cuentaBancariaId: banco, fecha: '2027-02-01' }))).message).toMatch(
      /supera lo que queda a tu favor en el abono \(121\.00/,
    );
    const r = await registrarCobroFactura(E, 'GASTO', a.factura.id, { importe: 121, cuentaBancariaId: banco, fecha: '2027-02-01' });
    expect(r.cobro).toMatchObject({ importe: -121, importeDoc: -121, importeTesoreria: -121 });
    expect(r.resumen).toMatchObject({ esAbono: true, importePendiente: 0, estado: 'PAGADA' });
    const lineas = await prisma.journalEntryLine.findMany({ where: { entryId: r.cobro.asientoId! } });
    const cuentaProveedor = (await prisma.journalEntryLine.findFirstOrThrow({ where: { entryId: a.asientoId, accountCode: { startsWith: '400' } } })).accountCode;
    expect(Object.fromEntries(lineas.map((l) => [l.accountCode, [Number(l.debe), Number(l.haber)]]))).toEqual({ '5720001': [121, 0], [cuentaProveedor]: [0, 121] });
    // Una devolución no es un pago a proveedores.
    expect(await totalCobradoEntre(E, 'GASTO', '2027-02-01', '2027-02-01')).toBe(0);
    expect((await ficha(E, a.factura.id)).estadoPago).toBe('PAGADA');
    // Anular la devolución la vuelve a dejar a favor; el abono no se anula con devoluciones activas.
    await anularCobroFactura(E, 'GASTO', a.factura.id, r.cobro.id);
    expect(await ficha(E, a.factura.id)).toMatchObject({ aFavor: 121, estadoPago: 'PENDIENTE' });
  });

  it('anular el abono anula su compensación AUTO y la original vuelve a estar pendiente', async () => {
    const o = await registrarGasto(E, factura(prov, 'F-5', '2027-01-10', 100), { contabilizar: 'POSTED' });
    const a = await registrarGasto(E, abonoDe(prov, 'R-5', '2027-01-20', -100, [{ id: o.factura.id }]), { contabilizar: 'POSTED' });
    expect(await ficha(E, o.factura.id)).toMatchObject({ importePendiente: 0, estadoPago: 'PAGADA' });
    await anularGasto(E, a.factura.id, { motivo: 'Error' });
    expect(await ficha(E, o.factura.id)).toMatchObject({ importePendiente: 121, estadoPago: 'PENDIENTE' });
    expect((await ficha(E, o.factura.id)).compensaciones).toEqual([expect.objectContaining({ estado: 'ANULADO' })]);
  });

  it('corregir el abono rehace su compensación AUTO', async () => {
    const o = await registrarGasto(E, factura(prov, 'F-6', '2027-01-10', 100), { contabilizar: 'POSTED' });
    const cuerpo = (p: number) => abonoDe(prov, 'R-6', '2027-01-20', p, [{ id: o.factura.id }]);
    const a = await registrarGasto(E, cuerpo(-10), { contabilizar: 'POSTED' });
    await editarGasto(E, a.factura.id, cuerpo(-30));
    const fo = await ficha(E, o.factura.id);
    expect(fo.importePendiente).toBe(84.7);
    expect(fo.compensaciones.filter((c) => c.estado === 'ACTIVO').map((c) => c.importe)).toEqual([36.3]);
  });
});

describe('aplicar un abono a otra factura', () => {
  let E: string;
  let banco: string;
  let prov: string;
  let otro: string;

  beforeAll(async () => {
    ({ E, banco } = await empresa('manual'));
    prov = (await proveedoresService.create(E, { nombreFiscal: 'Suministros Levante SL', nifCif: cif() })).id;
    otro = (await proveedoresService.create(E, { nombreFiscal: 'Otro SL', nifCif: cif() })).id;
  });

  async function abonoAFavor(numero: string, precio = -100) {
    const o = await registrarGasto(E, factura(prov, `${numero}-O`, '2027-01-10', -precio), { contabilizar: 'POSTED' });
    await registrarCobroFactura(E, 'GASTO', o.factura.id, { cuentaBancariaId: banco, fecha: '2027-01-11' });
    return (await registrarGasto(E, abonoDe(prov, numero, '2027-01-20', precio, [{ id: o.factura.id }]), { contabilizar: 'POSTED' })).factura.id;
  }

  it('a una factura del mismo proveedor, hasta lo que quede de los dos; la factura no se anula con la aplicación activa', async () => {
    const abono = await abonoAFavor('R-10');
    const f = await registrarGasto(E, factura(prov, 'F-10', '2027-01-25', 50), { contabilizar: 'POSTED' });
    expect((await error(aplicarAbono(E, abono, { facturaId: f.factura.id, importe: 70, fecha: '2027-02-01' }))).message).toMatch(
      /supera lo que queda pendiente de la factura F-10 \(60,50 €\)/,
    );
    const c = await aplicarAbono(E, abono, { facturaId: f.factura.id, fecha: '2027-02-01' });
    expect(c).toMatchObject({ origen: 'MANUAL', importe: 60.5, asientoId: null });
    expect(await ficha(E, f.factura.id)).toMatchObject({ importePendiente: 0, estadoPago: 'PAGADA' });
    expect(await ficha(E, abono)).toMatchObject({ aFavor: 60.5, estadoPago: 'PARCIAL' });
    // La ficha ya no ofrece anular ninguna de las dos mientras la aplicación siga activa.
    expect((await ficha(E, f.factura.id)).acciones.anular).toEqual({
      permitido: false,
      motivo: 'Tiene aplicado el abono R-10 por 60,50 €: anula antes esa aplicación.',
      conContraasiento: false,
    });
    expect((await ficha(E, abono)).acciones.anular).toMatchObject({ permitido: false, motivo: 'Este abono está aplicado a la factura F-10 por 60,50 €: anula antes esa aplicación.' });
    expect(await error(anularGasto(E, f.factura.id, { motivo: 'Error' }))).toEqual({
      status: 409,
      message: 'Tiene aplicado el abono R-10 por 60,50 €: anula antes esa aplicación.',
    });
    expect((await error(anularGasto(E, abono, { motivo: 'Error' }))).message).toBe('Este abono está aplicado a la factura F-10 por 60,50 €: anula antes esa aplicación.');
    await anularCompensacion(E, abono, c.id);
    expect(await ficha(E, f.factura.id)).toMatchObject({ importePendiente: 60.5, estadoPago: 'PENDIENTE' });
    expect(await ficha(E, abono)).toMatchObject({ aFavor: 121 });
  });

  it('a una factura de otro proveedor, no', async () => {
    const abono = await abonoAFavor('R-11');
    const f = await registrarGasto(E, factura(otro, 'X-11', '2027-01-25', 50), { contabilizar: 'POSTED' });
    expect(await error(aplicarAbono(E, abono, { facturaId: f.factura.id, fecha: '2027-02-01' }))).toEqual({ status: 400, message: 'La factura X-11 es de otro proveedor.' });
  });

  it('a una factura de fuera de la app (2026 llevada fuera): sin asiento', async () => {
    const abono = await abonoAFavor('R-12');
    const c = await aplicarAbono(E, abono, { numeroFuera: 'F-2026/77', fechaFuera: '2026-11-10', importe: 21, fecha: '2027-02-01' });
    expect(c).toMatchObject({ facturaId: null, importe: 21, asientoId: null, otra: { fuera: true, numero: 'F-2026/77', fecha: '2026-11-10' } });
    expect(await ficha(E, abono)).toMatchObject({ aFavor: 100 });
  });

  it('el alta con una original de fuera sin pagar («No, se descuenta de lo que le debo») la compensa entera', async () => {
    const a = await registrarGasto(
      E,
      factura(prov, 'R-13', '2027-01-20', -100, {
        lineas: [lin(-100, { cuenta: '608' })],
        rectificativa: { tipo: 'I', causa: 'DEVOLUCION', originales: [{ numero: 'F-2026/118', fecha: '2026-11-30' }], yaPagada: false },
      }),
      { contabilizar: 'POSTED' },
    );
    expect(await ficha(E, a.factura.id)).toMatchObject({ aFavor: 0, estadoPago: 'PAGADA' });
    expect((await ficha(E, a.factura.id)).compensaciones).toEqual([expect.objectContaining({ origen: 'AUTO', importe: 121, otra: expect.objectContaining({ fuera: true, numero: 'F-2026/118' }) })]);
  });

  it('entre la 400N y la 410N: asiento de traspaso con origen TESORERIA y sin factura; el pago siguiente va a su 410N', async () => {
    const abono = await abonoAFavor('R-14');
    const s = await registrarGasto(E, factura(prov, 'S-14', '2027-01-25', 200, { tipoGasto: 'SUMINISTROS' }), { contabilizar: 'POSTED' });
    const c = await aplicarAbono(E, abono, { facturaId: s.factura.id, importe: 50, fecha: '2027-02-01' });
    expect(c.asientoId).not.toBeNull();
    const a = await prisma.journalEntry.findUniqueOrThrow({ where: { id: c.asientoId! }, include: { lineas: true } });
    expect(a).toMatchObject({ origen: 'TESORERIA', invoiceId: null, estado: 'POSTED' });
    const c410 = (await prisma.journalEntryLine.findFirstOrThrow({ where: { entryId: s.asientoId, accountCode: { startsWith: '410' } } })).accountCode;
    const c400 = a.lineas.find((l) => l.accountCode.startsWith('400'))!.accountCode;
    expect(a.lineas.map((l) => [l.accountCode, Number(l.debe), Number(l.haber)]).sort()).toEqual([
      [c400, 0, 50],
      [c410, 50, 0],
    ]);
    const pago = await registrarCobroFactura(E, 'GASTO', s.factura.id, { cuentaBancariaId: banco, fecha: '2027-02-02' });
    expect(pago.cobro.importe).toBe(192);
    const lp = await prisma.journalEntryLine.findMany({ where: { entryId: pago.cobro.asientoId! } });
    expect(lp.find((l) => Number(l.debe) > 0)?.accountCode).toBe(c410);
    // Anular la aplicación deja el traspaso REVERSED.
    await anularCobroFactura(E, 'GASTO', s.factura.id, pago.cobro.id);
    await anularCompensacion(E, abono, c.id);
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: c.asientoId! } })).estado).toBe('REVERSED');
  });

  it('dos aplicaciones a la vez no pasan de lo que queda a favor', async () => {
    const abono = await abonoAFavor('R-15');
    const f1 = await registrarGasto(E, factura(prov, 'F-151', '2027-01-25', 100), { contabilizar: 'POSTED' });
    const f2 = await registrarGasto(E, factura(prov, 'F-152', '2027-01-25', 100), { contabilizar: 'POSTED' });
    const r = await Promise.allSettled([
      aplicarAbono(E, abono, { facturaId: f1.factura.id, importe: 100, fecha: '2027-02-01' }),
      aplicarAbono(E, abono, { facturaId: f2.factura.id, importe: 100, fecha: '2027-02-01' }),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const activas = await prisma.compensacionGasto.findMany({ where: { companyId: E, abonoId: abono, estado: 'ACTIVO' } });
    expect(activas.reduce((s, c) => s + aCentimos(Number(c.importe)), 0)).toBe(10000);
  });

  it('listado: insignia de abono, filtro por tipo, contador y totales a favor', async () => {
    const l = await expenseInvoicesService.listarGastos(E, { tipo: 'abonos', limit: 100 });
    expect(l.items.length).toBeGreaterThan(0);
    expect(l.items.every((i) => i.esRectificativa && i.esAbono)).toBe(true);
    expect(l.contadores.abonosAFavor).toBeGreaterThan(0);
    expect(l.totales.aFavor).toBeGreaterThan(0);
    const facturas = await expenseInvoicesService.listarGastos(E, { tipo: 'facturas', pago: 'por_pagar', limit: 100 });
    expect(facturas.items.some((i) => i.esAbono)).toBe(false);
    const vencidas = await expenseInvoicesService.listarGastos(E, { pago: 'vencida', limit: 100 });
    expect(vencidas.items.some((i) => i.esAbono)).toBe(false);
  });
});

describe('abono del lector y cruce con el mayor', () => {
  let E: string;
  let banco: string;
  let prov: string;

  beforeAll(async () => {
    ({ E, banco } = await empresa('lector'));
    prov = (await proveedoresService.create(E, { nombreFiscal: 'Papelería Lectora SL', nifCif: cif() })).id;
  });

  it('el borrador del lector no compensa hasta aprobar el asiento', async () => {
    const o = await registrarGasto(E, factura(prov, 'F-20', '2027-01-10', 100), { contabilizar: 'POSTED' });
    const a = await registrarGasto(E, abonoDe(prov, 'R-20', '2027-01-20', -100, [{ id: o.factura.id }]), { contabilizar: 'DRAFT' });
    expect(await ficha(E, o.factura.id)).toMatchObject({ importePendiente: 121 });
    await new AccountingEngineController().aprobarAsiento(E, a.asientoId, 'u-test');
    expect(await ficha(E, o.factura.id)).toMatchObject({ importePendiente: 0, estadoPago: 'PAGADA' });
    expect(await ficha(E, a.factura.id)).toMatchObject({ estado: 'ACCOUNTED', aFavor: 0 });
  });

  it('la cartera y el mayor por proveedor cuadran tras devoluciones y compensaciones', async () => {
    const o = await registrarGasto(E, factura(prov, 'F-21', '2027-02-01', 300), { contabilizar: 'POSTED' });
    await registrarCobroFactura(E, 'GASTO', o.factura.id, { importe: 100, cuentaBancariaId: banco, fecha: '2027-02-02' });
    const a = await registrarGasto(E, abonoDe(prov, 'R-21', '2027-02-05', -300, [{ id: o.factura.id }]), { contabilizar: 'POSTED' });
    await registrarCobroFactura(E, 'GASTO', a.factura.id, { importe: 50, cuentaBancariaId: banco, fecha: '2027-02-06' });
    const s = await registrarGasto(E, factura(prov, 'S-21', '2027-02-07', 40, { tipoGasto: 'SUMINISTROS' }), { contabilizar: 'POSTED' });
    await aplicarAbono(E, a.factura.id, { facturaId: s.factura.id, importe: 20, fecha: '2027-02-08' });
    const m = await informeMayorTerceros(E, 'proveedores', { desde: '2027-01-01', hasta: '2027-12-31', ejercicio: 2027 });
    const t = m.terceros.find((x) => x.id === prov)!;
    expect(t.pendienteFacturas).toBe(t.saldoFinal);
    const resumen = await listarCobros(E, 'GASTO', a.factura.id);
    expect(resumen).toMatchObject({ esAbono: true, importeCompensado: -283 });
  });
});
