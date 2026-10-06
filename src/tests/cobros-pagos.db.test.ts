/**
 * Cobros de facturas de venta y pagos de facturas de gasto sobre BD real:
 * cobro parcial y total con su asiento enlazado a la factura, anulacion
 * (REVERSED o contraasiento si el periodo esta cerrado), PATCH status PAID
 * compatible, pagos de gasto y cruce del mayor de clientes y proveedores.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { incomeInvoicesService } from '../services/income-invoices.service';
import { expenseInvoicesService } from '../services/expense-invoices.service';
import { AccountingEngineController } from '../controllers/accounting-engine.controller';
import { anularCobroFactura, listarCobros, registrarCobroFactura } from '../services/cobrosPagos.service';
import { informeDetalleTercero, informeMayorTerceros } from '../services/informesContables.service';
import { cambiarEstadoPeriodo } from '../services/periodos.service';

const COMPANY_ID = `cobros-test-${Date.now()}`;
const motor = new AccountingEngineController();
let customerId: string;
let supplierId: string;
let bancoId: string;
const PERIODO_2026 = { desde: '2026-01-01', hasta: '2026-12-31', ejercicio: 2026 };

const linea = (precio: number) => ({ descripcion: 'Servicio', cantidad: 1, precioUnitario: precio, tipoIva: 21 });

async function facturaVenta(base: number, fecha = '2026-03-01') {
  const f = await incomeInvoicesService.crearIngreso({
    companyId: COMPANY_ID,
    customer: { id: customerId },
    fechaEmision: fecha,
    fechaVencimiento: '2099-12-31',
    lineas: [linea(base)],
  });
  return f;
}

/** Contabiliza la factura con el motor y aprueba su asiento (POSTED), como haria el usuario. */
async function contabilizarVenta(id: string) {
  const r = await motor.contabilizarFacturaIngreso(COMPANY_ID, id);
  await prisma.journalEntry.update({ where: { id: r.journalEntryId }, data: { estado: 'POSTED' } });
  return r.journalEntryId;
}

async function asientoDe(cobroAsientoId: string | null) {
  return prisma.journalEntry.findUniqueOrThrow({ where: { id: cobroAsientoId! }, include: { lineas: true } });
}

beforeAll(async () => {
  await prisma.company.create({ data: { id: COMPANY_ID, name: 'Cobros Test SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: COMPANY_ID, denominacion: 'Cobros Test SL', nif: 'B10000000' } });
  customerId = (await prisma.customer.create({ data: { companyId: COMPANY_ID, nombreFiscal: 'Cliente Cobros SL', nifCif: 'B20000000' } })).id;
  supplierId = (await prisma.supplier.create({ data: { companyId: COMPANY_ID, nombreFiscal: 'Proveedor Pagos SL', nifCif: 'B30000000' } })).id;
  bancoId = (
    await prisma.bankAccount.create({ data: { companyId: COMPANY_ID, iban: 'ES0000000000000000000001', bancoNombre: 'Banco Test', subcuentaCodigo: '5720001' } })
  ).id;
});

describe('cobros de facturas de venta', () => {
  let facturaId: string;
  let numero: string;

  it('contabilizar la factura no toca su estado de cobro', async () => {
    const f = await facturaVenta(1000);
    facturaId = f.id;
    numero = f.numeroCompleto!;
    await contabilizarVenta(f.id);
    const r = await listarCobros(COMPANY_ID, 'INGRESO', f.id);
    expect(r).toMatchObject({ totalFactura: 1210, importeCobrado: 0, importePendiente: 1210, estado: 'PENDING' });
    expect((await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: f.id } })).estado).toBe('PENDING');
  });

  it('cobro parcial: asiento POSTED 572/430 enlazado a la factura y estado PENDING', async () => {
    const { cobro, resumen } = await registrarCobroFactura(COMPANY_ID, 'INGRESO', facturaId, {
      fecha: '2026-03-10',
      importe: 500,
      cuentaBancariaId: bancoId,
      nota: 'Primer plazo',
    });
    expect(resumen).toMatchObject({ importeCobrado: 500, importePendiente: 710, estado: 'PENDING' });
    expect(cobro).toMatchObject({ importe: 500, cuentaTesoreria: '5720001', medio: 'BANCO', estado: 'ACTIVO' });
    expect(cobro.asientoNumero).toMatch(/^COBRO-\d{5}$/);

    const a = await asientoDe(cobro.asientoId);
    expect(a).toMatchObject({ estado: 'POSTED', origen: 'TESORERIA', invoiceId: facturaId, invoiceType: 'INGRESO' });
    expect(a.descripcion).toContain(numero);
    const porCuenta = Object.fromEntries(a.lineas.map((l) => [l.accountCode, [l.debe, l.haber, l.referencia]]));
    expect(porCuenta).toEqual({ '5720001': [500, 0, numero], '430': [0, 500, numero] });
    expect((await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: facturaId } })).estado).toBe('PENDING');
  });

  it('no deja cobrar mas de lo pendiente', async () => {
    await expect(
      registrarCobroFactura(COMPANY_ID, 'INGRESO', facturaId, { fecha: '2026-03-11', importe: 710.01, cuentaBancariaId: bancoId }),
    ).rejects.toThrow(/supera lo pendiente/);
  });

  it('cobro del resto (sin importe): la factura queda PAID', async () => {
    const { resumen } = await registrarCobroFactura(COMPANY_ID, 'INGRESO', facturaId, { fecha: '2026-03-20', caja: true });
    expect(resumen).toMatchObject({ importeCobrado: 1210, importePendiente: 0, estado: 'PAID' });
    expect(resumen.cobros[1]).toMatchObject({ importe: 710, cuentaTesoreria: '570', medio: 'CAJA' });
    expect((await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: facturaId } })).estado).toBe('PAID');
    await expect(registrarCobroFactura(COMPANY_ID, 'INGRESO', facturaId, { importe: 1 })).rejects.toThrow(/ya está cobrada/);
  });

  it('el mayor de clientes atribuye los cobros al cliente y cuadra con lo pendiente', async () => {
    const r = await informeMayorTerceros(COMPANY_ID, 'clientes', PERIODO_2026);
    const t = r.terceros.find((x) => x.id === customerId)!;
    expect(t).toMatchObject({ debe: 1210, haber: 1210, saldoFinal: 0, pendienteFacturas: 0 });
    expect(r.terceros.some((x) => x.id === 'sin-identificar')).toBe(false);
  });

  it('anular un cobro: asiento REVERSED y la factura vuelve a pendiente', async () => {
    const antes = await listarCobros(COMPANY_ID, 'INGRESO', facturaId);
    const primero = antes.cobros[0];
    const { resumen, contraasiento } = await anularCobroFactura(COMPANY_ID, 'INGRESO', facturaId, primero.id);
    expect(contraasiento).toBe(false);
    expect(resumen).toMatchObject({ importeCobrado: 710, importePendiente: 500, estado: 'PENDING' });
    expect(resumen.cobros[0].estado).toBe('ANULADO');
    expect((await asientoDe(primero.asientoId)).estado).toBe('REVERSED');
    await expect(anularCobroFactura(COMPANY_ID, 'INGRESO', facturaId, primero.id)).rejects.toThrow(/ya está anulado/);

    // Cruce: 500 pendientes segun facturas y 500 de saldo contable.
    const r = await informeMayorTerceros(COMPANY_ID, 'clientes', PERIODO_2026);
    expect(r.terceros.find((x) => x.id === customerId)).toMatchObject({ saldoFinal: 500, pendienteFacturas: 500 });
    const d = await informeDetalleTercero(COMPANY_ID, 'clientes', PERIODO_2026, customerId);
    expect(d.facturasPendientes).toEqual([expect.objectContaining({ id: facturaId, importePendiente: 500 })]);
    expect(d.totalPendiente).toBe(500);
  });

  it('un cobro antes de contabilizar no impide contabilizar la factura despues', async () => {
    const f = await facturaVenta(100, '2026-03-05');
    await registrarCobroFactura(COMPANY_ID, 'INGRESO', f.id, { fecha: '2026-03-06', importe: 50, cuentaBancariaId: bancoId });
    await expect(contabilizarVenta(f.id)).resolves.toEqual(expect.any(String));
  });

  it('periodo bloqueado: no se cobra con esa fecha; anular hace contraasiento en un periodo abierto', async () => {
    const f = await facturaVenta(200, '2026-04-02');
    await contabilizarVenta(f.id);
    const { cobro } = await registrarCobroFactura(COMPANY_ID, 'INGRESO', f.id, { fecha: '2026-04-05', cuentaBancariaId: bancoId });
    await cambiarEstadoPeriodo(COMPANY_ID, 2026, 4, 'cerrado');
    try {
      await expect(
        registrarCobroFactura(COMPANY_ID, 'INGRESO', (await facturaVenta(10, '2026-04-03')).id, { fecha: '2026-04-20', cuentaBancariaId: bancoId }),
      ).rejects.toThrow(/está cerrado/);

      const { resumen, contraasiento } = await anularCobroFactura(COMPANY_ID, 'INGRESO', f.id, cobro.id, { fecha: '2026-05-02' });
      expect(contraasiento).toBe(true);
      expect(resumen).toMatchObject({ importePendiente: 242, estado: 'PENDING' });
      expect((await asientoDe(cobro.asientoId)).estado).toBe('POSTED');
      const pago = await prisma.invoicePayment.findUniqueOrThrow({ where: { id: cobro.id } });
      const contra = await asientoDe(pago.anulacionEntryId);
      expect(contra).toMatchObject({ estado: 'POSTED', invoiceId: f.id, invoiceType: 'INGRESO' });
      expect(contra.fecha.toISOString().slice(0, 10)).toBe('2026-05-02');
      expect(Object.fromEntries(contra.lineas.map((l) => [l.accountCode, [l.debe, l.haber]]))).toEqual({ '5720001': [0, 242], '430': [242, 0] });
    } finally {
      await cambiarEstadoPeriodo(COMPANY_ID, 2026, 4, 'abierto');
    }
  });

  it('PATCH status PAID sin datos: cobro por lo pendiente con la primera cuenta bancaria', async () => {
    const f = await facturaVenta(300, '2026-06-01');
    await contabilizarVenta(f.id);
    const r = await incomeInvoicesService.cambiarEstado(COMPANY_ID, f.id, 'PAID');
    expect(r.estado).toBe('PAID');
    const c = await listarCobros(COMPANY_ID, 'INGRESO', f.id);
    expect(c.cobros).toHaveLength(1);
    expect(c.cobros[0]).toMatchObject({ importe: 363, cuentaTesoreria: '5720001', fecha: new Date().toISOString().slice(0, 10) });
    // Marcar PAID otra vez no duplica el cobro.
    await incomeInvoicesService.cambiarEstado(COMPANY_ID, f.id, 'PAID');
    expect((await listarCobros(COMPANY_ID, 'INGRESO', f.id)).cobros).toHaveLength(1);
    // Con cobros registrados no se "desmarca": hay que anularlos.
    await expect(incomeInvoicesService.cambiarEstado(COMPANY_ID, f.id, 'PENDING')).rejects.toThrow(/anula esos cobros/);
  });

  it('sin cuenta bancaria activa: error claro que sugiere crearla', async () => {
    const otra = `cobros-sin-banco-${Date.now()}`;
    await prisma.company.create({ data: { id: otra, name: 'Sin banco', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    const cli = await prisma.customer.create({ data: { companyId: otra, nombreFiscal: 'Cliente', nifCif: 'B40000000' } });
    const f = await prisma.incomeInvoice.create({
      data: { companyId: otra, customerId: cli.id, serie: 'A', numero: 1, numeroCompleto: 'A-1', fechaEmision: '2026-02-01', fechaVencimiento: '2026-03-01', totalFactura: 100 },
    });
    await expect(incomeInvoicesService.cambiarEstado(otra, f.id, 'PAID')).rejects.toThrow(/Créala en Tesorería/);
    // Y una cuenta bancaria de otra empresa no vale.
    await expect(registrarCobroFactura(otra, 'INGRESO', f.id, { cuentaBancariaId: bancoId })).rejects.toThrow(/no existe en esta empresa/);
  });

  it('una factura marcada como cobrada antes de existir los cobros cuenta como cobrada', async () => {
    const f = await prisma.incomeInvoice.create({
      data: { companyId: COMPANY_ID, customerId, serie: 'L', numero: 1, numeroCompleto: 'L-1', fechaEmision: '2026-01-10', fechaVencimiento: '2026-01-10', totalFactura: 50, estado: 'PAID' },
    });
    expect(await listarCobros(COMPANY_ID, 'INGRESO', f.id)).toMatchObject({ importePendiente: 0, estado: 'PAID', cobros: [] });
  });
});

describe('pagos de facturas de gasto', () => {
  let gastoId: string;

  it('pago parcial y total: asientos 400/572 enlazados y estadoPago', async () => {
    const g = await expenseInvoicesService.crearGasto({
      companyId: COMPANY_ID,
      provider: { id: supplierId },
      serie: 'P',
      fechaEmision: '2026-02-01',
      fechaVencimiento: '2026-03-01',
      lineas: [{ descripcion: 'Material', cantidad: 1, precioUnitario: 400, tipoIva: 21 }],
    });
    gastoId = g.id;
    expect(g.estadoPago).toBe('PENDIENTE');
    const r = await motor.contabilizarFacturaGasto(COMPANY_ID, g.id);
    await prisma.journalEntry.update({ where: { id: r.journalEntryId }, data: { estado: 'POSTED' } });

    const p1 = await registrarCobroFactura(COMPANY_ID, 'GASTO', g.id, { fecha: '2026-02-15', importe: 84, cuentaBancariaId: bancoId });
    expect(p1.resumen).toMatchObject({ totalFactura: 484, importeCobrado: 84, importePendiente: 400, estado: 'PARCIAL' });
    expect(p1.cobro.asientoNumero).toMatch(/^PAGO-\d{5}$/);
    const a = await asientoDe(p1.cobro.asientoId);
    expect(a).toMatchObject({ estado: 'POSTED', origen: 'TESORERIA', invoiceId: g.id, invoiceType: 'GASTO' });
    expect(Object.fromEntries(a.lineas.map((l) => [l.accountCode, [l.debe, l.haber]]))).toEqual({ '400': [84, 0], '5720001': [0, 84] });
    expect((await prisma.expenseInvoice.findUniqueOrThrow({ where: { id: g.id } })).estadoPago).toBe('PARCIAL');

    // Mayor de proveedores cruzado: saldo contable 400 = pendiente segun facturas 400.
    const m = await informeMayorTerceros(COMPANY_ID, 'proveedores', PERIODO_2026);
    expect(m.terceros.find((t) => t.id === supplierId)).toMatchObject({ debe: 84, haber: 484, saldoFinal: 400, pendienteFacturas: 400 });
    expect(m.tabla.columnas.map((c) => c.titulo)).toContain('Pendiente s/ facturas');
    const d = await informeDetalleTercero(COMPANY_ID, 'proveedores', PERIODO_2026, supplierId);
    expect(d.totalPendiente).toBe(400);
    expect(d.tabla.notas?.join(' ')).toContain('pendiente(s) de pago');

    const p2 = await registrarCobroFactura(COMPANY_ID, 'GASTO', g.id, { fecha: '2026-02-20', cuentaBancariaId: bancoId });
    expect(p2.resumen).toMatchObject({ importePendiente: 0, estado: 'PAGADA' });
    expect((await expenseInvoicesService.obtenerPorId(COMPANY_ID, g.id)).estadoPago).toBe('PAGADA');
    const m2 = await informeMayorTerceros(COMPANY_ID, 'proveedores', PERIODO_2026);
    expect(m2.terceros.find((t) => t.id === supplierId)).toMatchObject({ saldoFinal: 0, pendienteFacturas: 0 });
  });

  it('anular un pago devuelve la factura a parcial', async () => {
    const r = await listarCobros(COMPANY_ID, 'GASTO', gastoId);
    const { resumen } = await anularCobroFactura(COMPANY_ID, 'GASTO', gastoId, r.cobros[1].id);
    expect(resumen).toMatchObject({ importeCobrado: 84, importePendiente: 400, estado: 'PARCIAL' });
    expect((await prisma.expenseInvoice.findUniqueOrThrow({ where: { id: gastoId } })).estadoPago).toBe('PARCIAL');
  });

  it('un pago de otra empresa no se encuentra', async () => {
    await expect(listarCobros('otra-empresa', 'GASTO', gastoId)).rejects.toThrow(/no encontrada/);
  });
});
