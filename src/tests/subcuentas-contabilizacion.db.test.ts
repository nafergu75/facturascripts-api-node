/**
 * Todo lo que contabiliza contra 430/400/410 usa la subcuenta propia del
 * tercero: altas de fichas, ventas y rectificativas, gastos (alta, lector,
 * edicion y boton Contabilizar), cobros y pagos, conciliacion, ajustar linea
 * de un borrador, el plan contable (permisos y subcuentas enlazadas) y el
 * borrado de fichas.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import { controlCif } from '../utils/nif';
import { clientesService } from '../services/clientes.service';
import { proveedoresService } from '../services/proveedores.service';
import { incomeInvoicesService } from '../services/income-invoices.service';
import { editarGasto, expenseInvoicesService, registrarGasto } from '../services/expense-invoices.service';
import { AccountingEngineController } from '../controllers/accounting-engine.controller';
import { listarCobros, registrarCobroFactura } from '../services/cobrosPagos.service';
import { conciliarMovimientoConCuenta, conciliarMovimientoConFactura } from '../services/conciliacionConfirmar.service';
import { importarMovimientosDesdeCSV } from '../services/bancos.service';
import { actualizarCuenta, asegurarPlanContableEmpresa, crearSubcuentaPersonalizada } from '../services/chart-of-accounts.service';
import chartOfAccountsRoutes from '../routes/chart-of-accounts.routes';
import { errorMiddleware } from '../middleware/error.middleware';

const SUFIJO = Date.now();
const E = `subc-cont-${SUFIJO}`;
const motor = new AccountingEngineController();
let bancoId: string;
let n = 0;

/** CIF valido distinto en cada llamada. */
function cif(): string {
  const siete = String(1000000 + ((SUFIJO + n++ * 7919) % 8999999)).slice(0, 7);
  return `B${siete}${controlCif(siete).cifra}`;
}

const lineaVenta = (precio: number) => ({ descripcion: 'Servicio', cantidad: 1, precioUnitario: precio, tipoIva: 21 });

async function asiento(id: string) {
  return prisma.journalEntry.findUniqueOrThrow({ where: { id }, include: { lineas: true } });
}
const porCuenta = (lineas: Array<{ accountCode: string; debe: number; haber: number }>) =>
  Object.fromEntries(lineas.map((l) => [l.accountCode, [l.debe, l.haber]]));
const nombreDe = (lineas: Array<{ accountCode: string; accountName: string }>, codigo: string) => lineas.find((l) => l.accountCode === codigo)?.accountName;

async function asientoDeFactura(invoiceId: string) {
  return prisma.journalEntry.findFirstOrThrow({
    where: { companyId: E, invoiceId, origen: { not: 'TESORERIA' }, estado: { not: 'REVERSED' } },
    include: { lineas: true },
    orderBy: { createdAt: 'desc' },
  });
}

beforeAll(async () => {
  await prisma.company.create({ data: { id: E, name: 'Subcuentas Cont SL', fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: E, denominacion: 'Subcuentas Cont SL', nif: 'B10000000' } });
  await asegurarPlanContableEmpresa(E);
  bancoId = (await prisma.bankAccount.create({ data: { companyId: E, iban: `ES00${SUFIJO}`, bancoNombre: 'Banco', subcuentaCodigo: '5720001' } })).id;
  await prisma.chartOfAccounts.create({
    data: { companyId: E, codigo: '5720001', nombre: 'Banco', grupo: 5, nivel: 4, naturaleza: 'ACTIVO', tipoUso: 'BALANCE', esBasePGC: false, esPersonalizadaEmpresa: true, parentCodigo: '572' },
  });
});

describe('altas', () => {
  it('cliente desde la ficha: subcuenta asignada y aun sin movimientos en el plan', async () => {
    const c = (await clientesService.create(E, { nombreFiscal: 'Ferretería López SL', nifCif: cif() })) as unknown as Record<string, unknown>;
    expect(c).toMatchObject({ subcuenta430: '43000001', subcuentasEnPlan: [] });
  });

  it('proveedor desde la ficha: 400N y 410N con el mismo numero', async () => {
    const p = await proveedoresService.create(E, { nombreFiscal: 'Asesoría Pérez SL', nifCif: cif() });
    expect(p).toMatchObject({ subcuenta400: '40000001', subcuenta410: '41000001', subcuentasEnPlan: [] });
  });

  it('cliente nuevo desde una factura de venta: con su subcuenta', async () => {
    const f = await incomeInvoicesService.crearIngreso({
      companyId: E,
      customer: { nuevo: { nombreFiscal: 'Cliente Desde Factura SL', nifCif: cif() } },
      fechaEmision: '2026-03-01',
      fechaVencimiento: '2099-12-31',
      lineas: [lineaVenta(100)],
    });
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: f.customerId } });
    expect(c.subcuenta430).toBe('43000002');
  });
});

describe('ventas', () => {
  let clienteId: string;
  let facturaId: string;

  beforeAll(async () => {
    clienteId = String(((await clientesService.create(E, { nombreFiscal: 'Bar Pepe SL', nifCif: cif() })) as unknown as { id: string }).id);
  });

  it('emitir y contabilizar: la linea del cliente va a su subcuenta con su nombre, y la cuenta queda en el plan', async () => {
    const f = await incomeInvoicesService.crearIngreso({ companyId: E, customer: { id: clienteId }, fechaEmision: '2026-03-02', fechaVencimiento: '2099-12-31', lineas: [lineaVenta(1000)] });
    facturaId = f.id;
    const r = await motor.contabilizarFacturaIngreso(E, f.id);
    const a = await asiento(r.journalEntryId);
    expect(porCuenta(a.lineas)).toMatchObject({ '43000003': [1210, 0], '700': [0, 1000], '477': [0, 210] });
    expect(nombreDe(a.lineas, '43000003')).toBe('Bar Pepe SL');
    expect(await prisma.chartOfAccounts.findFirst({ where: { companyId: E, codigo: '43000003' } })).toMatchObject({ nombre: 'Bar Pepe SL', parentCodigo: '430', activo: true });
    expect(await clientesService.getById(E, clienteId)).toMatchObject({ subcuenta430: '43000003', subcuentasEnPlan: ['43000003'] });
  });

  it('la rectificativa va a la misma subcuenta', async () => {
    const rect = await incomeInvoicesService.crearRectificativa(E, facturaId, { motivo: 'Devolución' });
    const r = await motor.contabilizarFacturaIngreso(E, rect.id);
    expect(porCuenta((await asiento(r.journalEntryId)).lineas)['43000003']).toEqual([-1210, 0]);
  });

  it('cliente antiguo sin subcuenta (creado por otro camino): se le asigna al contabilizar', async () => {
    const viejo = await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Antiguo SA', nifCif: cif() } });
    const f = await incomeInvoicesService.crearIngreso({ companyId: E, customer: { id: viejo.id }, fechaEmision: '2026-03-03', fechaVencimiento: '2099-12-31', lineas: [lineaVenta(10)] });
    const r = await motor.contabilizarFacturaIngreso(E, f.id);
    const codigo = (await prisma.customer.findUniqueOrThrow({ where: { id: viejo.id } })).subcuenta430!;
    expect(codigo).toMatch(/^430\d{5}$/);
    expect(porCuenta((await asiento(r.journalEntryId)).lineas)[codigo]).toEqual([12.1, 0]);
  });

  it('el cobro hereda la subcuenta y lleva su nombre', async () => {
    const { cobro } = await registrarCobroFactura(E, 'INGRESO', facturaId, { fecha: '2026-03-10', importe: 100, cuentaBancariaId: bancoId });
    const a = await asiento(cobro.asientoId!);
    expect(porCuenta(a.lineas)).toEqual({ '5720001': [100, 0], '43000003': [0, 100] });
    expect(nombreDe(a.lineas, '43000003')).toBe('Bar Pepe SL');
  });

  it('los cobros de la factura dicen contra que subcuenta van (para la pantalla)', async () => {
    expect((await listarCobros(E, 'INGRESO', facturaId)).cuentaTercero).toBe('43000003');
    // Sin asiento: la subcuenta de la ficha, sin asignar nada nuevo.
    const f = await incomeInvoicesService.crearIngreso({ companyId: E, customer: { id: clienteId }, fechaEmision: '2026-03-04', fechaVencimiento: '2099-12-31', lineas: [lineaVenta(5)] });
    expect((await listarCobros(E, 'INGRESO', f.id)).cuentaTercero).toBe('43000003');
  });

  it('cobro de una factura aun sin asiento: a la subcuenta del cliente', async () => {
    const f = await incomeInvoicesService.crearIngreso({ companyId: E, customer: { id: clienteId }, fechaEmision: '2026-03-04', fechaVencimiento: '2099-12-31', lineas: [lineaVenta(50)] });
    const { cobro } = await registrarCobroFactura(E, 'INGRESO', f.id, { fecha: '2026-03-11', caja: true });
    expect(porCuenta((await asiento(cobro.asientoId!)).lineas)).toEqual({ '570': [60.5, 0], '43000003': [0, 60.5] });
  });

  it('la conciliacion con factura crea el cobro (InvoicePayment) contra la subcuenta', async () => {
    const f = await incomeInvoicesService.crearIngreso({ companyId: E, customer: { id: clienteId }, fechaEmision: '2026-03-05', fechaVencimiento: '2099-12-31', lineas: [lineaVenta(200)] });
    await motor.contabilizarFacturaIngreso(E, f.id);
    const [mov] = await importarMovimientosDesdeCSV(E, bancoId, '2026-03-20;242,00;Transferencia Bar Pepe');
    const r = await conciliarMovimientoConFactura(E, mov.id, f.id);
    expect(r).toMatchObject({ movimientoConciliado: true, estado: { estadoCobro: 'cobrada', importeCobrado: 242, importePendiente: 0 } });
    const pago = await prisma.invoicePayment.findUniqueOrThrow({ where: { id: r.cobroId } });
    expect(pago).toMatchObject({ invoiceType: 'INGRESO', invoiceId: f.id, importe: 242, cuentaTesoreria: '5720001', bankAccountId: bancoId, estado: 'ACTIVO' });
    expect(porCuenta((await asiento(pago.journalEntryId!)).lineas)).toEqual({ '5720001': [242, 0], '43000003': [0, 242] });
  });

  it('la conciliacion contra una cuenta exige que exista y este activa; el banco va con su codigo real', async () => {
    const [mov] = await importarMovimientosDesdeCSV(E, bancoId, '2026-03-21;-15,00;Comisión');
    await expect(conciliarMovimientoConCuenta(E, mov.id, '5550000000')).rejects.toThrow(/no está en el plan contable/);
    // Los grupos y subgrupos (4, 43...) estan en el plan pero no llevan apuntes.
    for (const g of ['4', '43', '55']) await expect(conciliarMovimientoConCuenta(E, mov.id, g)).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('grupo o subgrupo') });
    const r = await conciliarMovimientoConCuenta(E, mov.id);
    const lineas = await prisma.journalEntryLine.findMany({ where: { entryId: String((r.asiento as Record<string, unknown>).idasiento) } });
    expect(porCuenta(lineas)).toEqual({ '555': [15, 0], '5720001': [0, 15] });
  });
});

describe('gastos', () => {
  let provId: string;

  const compra = (extra: Record<string, unknown> = {}) => ({
    proveedor: { id: provId },
    numeroFacturaProveedor: `C-${n++}`,
    fechaEmision: '2026-04-03',
    tipoGasto: 'COMPRA',
    lineas: [{ descripcion: 'Material', cantidad: 1, precioUnitario: 100, tipoIva: 21 }],
    ...extra,
  });

  beforeAll(async () => {
    provId = (await proveedoresService.create(E, { nombreFiscal: 'Suministros Valencia SL', nifCif: cif() })).id;
  });

  it('alta de una compra: abono a la 400N con el nombre del proveedor; la 410N no se da de alta', async () => {
    const r = await registrarGasto(E, compra(), { contabilizar: 'POSTED' });
    const a = await asiento(r.asientoId);
    expect(porCuenta(a.lineas)).toMatchObject({ '600': [100, 0], '40000002': [0, 121] });
    expect(nombreDe(a.lineas, '40000002')).toBe('Suministros Valencia SL');
    expect(await prisma.chartOfAccounts.count({ where: { companyId: E, codigo: '41000002' } })).toBe(0);
  });

  it('un servicio del mismo proveedor va a la 410N (mismo numero)', async () => {
    const r = await registrarGasto(E, compra({ tipoGasto: 'SUMINISTROS' }), { contabilizar: 'POSTED' });
    expect(porCuenta((await asiento(r.asientoId)).lineas)).toMatchObject({ '628': [100, 0], '41000002': [0, 121] });
  });

  it('proveedor nuevo desde la factura: con sus subcuentas', async () => {
    const r = await registrarGasto(E, { ...compra(), proveedor: { nuevo: { nombreFiscal: 'Nuevo Desde Gasto SL', nifCif: cif() } } }, { contabilizar: 'POSTED' });
    const s = await prisma.supplier.findFirstOrThrow({ where: { companyId: E, nombreFiscal: 'Nuevo Desde Gasto SL' } });
    expect(s).toMatchObject({ subcuenta400: '40000003', subcuenta410: '41000003' });
    expect(porCuenta((await asiento(r.asientoId)).lineas)['40000003']).toEqual([0, 121]);
  });

  it('editar una compra contabilizada pasandola a servicio: asiento -R1 en la 410N', async () => {
    const alta = await registrarGasto(E, compra(), { contabilizar: 'POSTED' });
    const id = alta.factura.id;
    await editarGasto(E, id, compra({ tipoGasto: 'SUMINISTROS', numeroFacturaProveedor: alta.factura.numeroFacturaProveedor }));
    const nuevo = await asientoDeFactura(id);
    expect(nuevo.numeroAsiento).toMatch(/-R1$/);
    expect(porCuenta(nuevo.lineas)).toMatchObject({ '41000002': [0, 121] });
    expect((await asiento(alta.asientoId)).estado).toBe('REVERSED');
  });

  it('lector (borrador): la subcuenta ya esta en el plan y el asiento se aprueba', async () => {
    const p = await proveedoresService.create(E, { nombreFiscal: 'Proveedor Lector SL', nifCif: cif() });
    const r = await registrarGasto(E, compra({ proveedor: { id: p.id } }), { contabilizar: 'DRAFT' });
    expect(porCuenta((await asiento(r.asientoId)).lineas)[p.subcuenta400!]).toEqual([0, 121]);
    await expect(motor.aprobarAsiento(E, r.asientoId, 'u1')).resolves.toMatchObject({ estado: 'POSTED' });
  });

  it('pago antes de contabilizar: a la 410N; al contabilizar despues, el asiento usa la misma', async () => {
    const g = await expenseInvoicesService.crearGasto({
      companyId: E,
      provider: { id: provId },
      serie: 'P',
      fechaEmision: '2026-05-01',
      fechaVencimiento: '2026-06-01',
      tipoGasto: 'SUMINISTROS',
      lineas: [{ descripcion: 'Luz', cantidad: 1, precioUnitario: 100, tipoIva: 21 }],
    });
    const { cobro } = await registrarCobroFactura(E, 'GASTO', g.id, { fecha: '2026-05-02', importe: 50, cuentaBancariaId: bancoId });
    const pago = await asiento(cobro.asientoId!);
    expect(porCuenta(pago.lineas)).toEqual({ '41000002': [50, 0], '5720001': [0, 50] });
    expect(nombreDe(pago.lineas, '41000002')).toBe('Suministros Valencia SL');
    expect((await listarCobros(E, 'GASTO', g.id)).cuentaTercero).toBe('41000002');
    const r = await motor.contabilizarFacturaGasto(E, g.id);
    expect(porCuenta((await asiento(r.journalEntryId)).lineas)['41000002']).toEqual([0, 121]);
  });

  it('boton Contabilizar de un gasto anterior sin pagos: a la subcuenta segun el tipo', async () => {
    const g = await expenseInvoicesService.crearGasto({
      companyId: E,
      provider: { id: provId },
      serie: 'P',
      fechaEmision: '2026-05-03',
      fechaVencimiento: '2026-06-03',
      tipoGasto: 'COMPRA',
      lineas: [{ descripcion: 'Género', cantidad: 2, precioUnitario: 50, tipoIva: 21 }],
    });
    const r = await motor.contabilizarFacturaGasto(E, g.id);
    expect(porCuenta((await asiento(r.journalEntryId)).lineas)['40000002']).toEqual([0, 121]);
  });
});

describe('ajustar linea de un borrador', () => {
  let asientoId: string;
  let lineaProveedor: string;
  let otro: { id: string; subcuenta400: string | null };
  let propio: { subcuenta400: string | null; subcuenta410: string | null };

  beforeAll(async () => {
    const p = await proveedoresService.create(E, { nombreFiscal: 'Ajustes SL', nifCif: cif() });
    propio = p;
    otro = await proveedoresService.create(E, { nombreFiscal: 'Otro Proveedor SL', nifCif: cif() });
    // Que la 400 del otro este en el plan.
    await registrarGasto(E, { proveedor: { id: otro.id }, numeroFacturaProveedor: 'OT-1', fechaEmision: '2026-04-05', tipoGasto: 'COMPRA', lineas: [{ descripcion: 'x', cantidad: 1, precioUnitario: 10, tipoIva: 21 }] }, { contabilizar: 'POSTED' });
    const r = await registrarGasto(E, { proveedor: { id: p.id }, numeroFacturaProveedor: 'AJ-1', fechaEmision: '2026-04-06', tipoGasto: 'COMPRA', lineas: [{ descripcion: 'x', cantidad: 1, precioUnitario: 10, tipoIva: 21 }] }, { contabilizar: 'DRAFT' });
    asientoId = r.asientoId;
    lineaProveedor = (await asiento(asientoId)).lineas.find((l) => l.accountCode === p.subcuenta400)!.id;
  });

  it('rechaza un codigo que no esta en el plan', async () => {
    await expect(motor.ajustarLineaAsiento(E, asientoId, lineaProveedor, { accountCode: '40099999' }, 'u1')).rejects.toThrow(/no está en el plan contable/);
  });

  it('rechaza la subcuenta de otro proveedor y una cuenta que no es de proveedores', async () => {
    await expect(motor.ajustarLineaAsiento(E, asientoId, lineaProveedor, { accountCode: otro.subcuenta400! }, 'u1')).rejects.toThrow(/es de Otro Proveedor SL/);
    await expect(motor.ajustarLineaAsiento(E, asientoId, lineaProveedor, { accountCode: '572' }, 'u1')).rejects.toThrow(/solo puede ir a una cuenta de proveedores/);
  });

  it('acepta la generica y la 410N del mismo proveedor (con el nombre del plan)', async () => {
    await expect(motor.ajustarLineaAsiento(E, asientoId, lineaProveedor, { accountCode: '400' }, 'u1')).resolves.toMatchObject({ lineaActualizada: { accountCode: '400', accountName: 'Proveedores' } });
    await prisma.$transaction(async (tx) => {
      const { asegurarSubcuentaEnPlan } = await import('../services/terceros/subcuentas');
      await asegurarSubcuentaEnPlan(tx, E, propio.subcuenta410!, 'Ajustes SL', { tipo: 'proveedor', id: 'x' });
    });
    await expect(motor.ajustarLineaAsiento(E, asientoId, lineaProveedor, { accountCode: propio.subcuenta410! }, 'u1')).resolves.toMatchObject({
      lineaActualizada: { accountCode: propio.subcuenta410, accountName: 'Ajustes SL' },
    });
  });

  it('rechaza los grupos y subgrupos del plan (4, 40, 43)', async () => {
    for (const g of ['4', '40', '43']) {
      await expect(motor.ajustarLineaAsiento(E, asientoId, lineaProveedor, { accountCode: g }, 'u1')).rejects.toThrow(/grupo o subgrupo/);
    }
  });

  it('otra linea del asiento (gasto, IVA) no pasa a la subcuenta de otro proveedor o cliente', async () => {
    const lineas = (await asiento(asientoId)).lineas;
    const lineaIva = lineas.find((l) => l.accountCode === '472')!;
    await expect(motor.ajustarLineaAsiento(E, asientoId, lineaIva.id, { accountCode: otro.subcuenta400! }, 'u1')).rejects.toThrow(
      /es de Otro Proveedor SL, no del cliente o proveedor de este asiento/,
    );
    const deCliente = await prisma.customer.findFirstOrThrow({ where: { companyId: E, subcuenta430: '43000003' } });
    await expect(motor.ajustarLineaAsiento(E, asientoId, lineaIva.id, { accountCode: deCliente.subcuenta430! }, 'u1')).rejects.toThrow(/no del cliente o proveedor de este asiento/);
    // A una cuenta que no es de nadie, si.
    await expect(motor.ajustarLineaAsiento(E, asientoId, lineaIva.id, { accountCode: '473' }, 'u1')).resolves.toBeDefined();
    await motor.ajustarLineaAsiento(E, asientoId, lineaIva.id, { accountCode: '472' }, 'u1');
  });

  it('en un asiento sin cliente ni proveedor la contrapartida puede ir a la subcuenta de cualquiera', async () => {
    const a = await prisma.journalEntry.create({
      data: {
        companyId: E,
        fecha: new Date('2026-06-02'),
        numeroAsiento: `SINT-${SUFIJO}`,
        descripcion: 'Cobro sin factura',
        origen: 'TESORERIA',
        estado: 'DRAFT',
        lineas: { create: [{ companyId: E, accountCode: '5720001', accountName: 'Banco', debe: 30, haber: 0 }, { companyId: E, accountCode: '555', accountName: 'Partidas pendientes', debe: 0, haber: 30 }] },
      },
      include: { lineas: true },
    });
    const l555 = a.lineas.find((l) => l.accountCode === '555')!;
    await expect(motor.ajustarLineaAsiento(E, a.id, l555.id, { accountCode: '43000003' }, 'u1')).resolves.toMatchObject({ lineaActualizada: { accountCode: '43000003' } });
  });

  it('un ajuste que descuadra no se guarda', async () => {
    await expect(motor.ajustarLineaAsiento(E, asientoId, lineaProveedor, { haber: 1 }, 'u1')).rejects.toThrow(/desequilibra/);
    expect((await prisma.journalEntryLine.findUniqueOrThrow({ where: { id: lineaProveedor } })).haber).toBe(12.1);
  });
});

describe('fichas: nombre, plan y borrado', () => {
  it('renombrar el cliente cambia el nombre de su subcuenta en el plan, no el de los apuntes', async () => {
    const c = await prisma.customer.findFirstOrThrow({ where: { companyId: E, subcuenta430: '43000003' } });
    await clientesService.update(E, c.id, { nombreFiscal: 'Bar Pepe e Hijos SL' });
    expect((await prisma.chartOfAccounts.findFirstOrThrow({ where: { companyId: E, codigo: '43000003' } })).nombre).toBe('Bar Pepe e Hijos SL');
    expect(await prisma.journalEntryLine.count({ where: { companyId: E, accountCode: '43000003', accountName: 'Bar Pepe SL' } })).toBeGreaterThan(0);
  });

  it('renombrar el proveedor cambia el nombre de sus subcuentas en el plan', async () => {
    const s = await prisma.supplier.findFirstOrThrow({ where: { companyId: E, subcuenta400: '40000002' } });
    await proveedoresService.update(E, s.id, { nombreFiscal: 'Suministros Valencia 2027 SL' });
    const nombres = await prisma.chartOfAccounts.findMany({ where: { companyId: E, codigo: { in: ['40000002', '41000002'] } }, select: { nombre: true } });
    expect(nombres.map((x) => x.nombre)).toEqual(['Suministros Valencia 2027 SL', 'Suministros Valencia 2027 SL']);
  });

  it('desde el plan no se toca una subcuenta de tercero (409) ni se crean subcuentas sueltas bajo 430/400/410', async () => {
    const cuenta = await prisma.chartOfAccounts.findFirstOrThrow({ where: { companyId: E, codigo: '43000003' } });
    await expect(actualizarCuenta(cuenta.id, E, { nombre: 'Otro' })).rejects.toMatchObject({ statusCode: 409, message: 'Esta subcuenta es del cliente Bar Pepe e Hijos SL: cámbiala desde su ficha.' });
    await expect(actualizarCuenta(cuenta.id, E, { activo: false })).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      crearSubcuentaPersonalizada({ companyId: E, codigo: '43000099', nombre: 'Suelta', parentCodigo: '430', naturaleza: '', tipoUso: '' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    // Tampoco colgandola de la 43, la 40, la 41 o la 4: se mira el codigo.
    for (const [codigo, madre] of [['43089999', '43'], ['40000099', '40'], ['41000099', '41'], ['43000098', '4']]) {
      await expect(
        crearSubcuentaPersonalizada({ companyId: E, codigo, nombre: 'Suelta', parentCodigo: madre, naturaleza: '', tipoUso: '' }),
      ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining(codigo.startsWith('43') ? 'créalo en Clientes' : 'créalo en Proveedores') });
    }
    expect(await prisma.chartOfAccounts.count({ where: { companyId: E, codigo: { in: ['43089999', '40000099', '41000099', '43000098'] } } })).toBe(0);
  });

  it('cambiar activo del cliente desde su ficha', async () => {
    const c = await prisma.customer.findFirstOrThrow({ where: { companyId: E, subcuenta430: '43000003' } });
    expect(await clientesService.update(E, c.id, { activo: false })).toMatchObject({ activo: false });
    await expect(clientesService.update(E, c.id, { activo: 'quizá' })).rejects.toMatchObject({ statusCode: 400 });
    await clientesService.update(E, c.id, { activo: true });
  });

  it('borrar un cliente con facturas o apuntes: 409', async () => {
    const c = await prisma.customer.findFirstOrThrow({ where: { companyId: E, subcuenta430: '43000003' } });
    await expect(clientesService.remove(E, c.id)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('tiene facturas o movimientos contables') });
    // Con apuntes en su subcuenta aunque no tenga facturas.
    const sinFacturas = await clientesService.create(E, { nombreFiscal: 'Solo Apuntes SL', nifCif: cif() }) as unknown as { id: string; subcuenta430: string };
    const a = await prisma.journalEntry.create({ data: { companyId: E, fecha: new Date('2026-06-01'), numeroAsiento: `AJ-${SUFIJO}`, descripcion: 'x', origen: 'AJUSTE_MANUAL', estado: 'DRAFT' } });
    await prisma.journalEntryLine.create({ data: { entryId: a.id, companyId: E, accountCode: sinFacturas.subcuenta430, accountName: 'x', debe: 1, haber: 0 } });
    await expect(clientesService.remove(E, sinFacturas.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('borrar un cliente sin nada: su subcuenta queda inactiva en el plan y el codigo no se reutiliza', async () => {
    const c = (await clientesService.create(E, { nombreFiscal: 'Se Borra SL', nifCif: cif() })) as unknown as { id: string; subcuenta430: string };
    await clientesService.remove(E, c.id);
    expect(await prisma.customer.count({ where: { id: c.id } })).toBe(0);
    expect(await prisma.chartOfAccounts.findFirstOrThrow({ where: { companyId: E, codigo: c.subcuenta430 } })).toMatchObject({ activo: false });
    const siguiente = (await clientesService.create(E, { nombreFiscal: 'Despues SL', nifCif: cif() })) as unknown as { subcuenta430: string };
    expect(Number(siguiente.subcuenta430)).toBe(Number(c.subcuenta430) + 1);
  });

  it('borrar un proveedor sin facturas pero con apuntes: 409; sin nada: subcuentas inactivas', async () => {
    const p = await proveedoresService.create(E, { nombreFiscal: 'Proveedor Apuntes SL', nifCif: cif() });
    const a = await prisma.journalEntry.create({ data: { companyId: E, fecha: new Date('2026-06-01'), numeroAsiento: `AJP-${SUFIJO}`, descripcion: 'x', origen: 'AJUSTE_MANUAL', estado: 'DRAFT' } });
    await prisma.journalEntryLine.create({ data: { entryId: a.id, companyId: E, accountCode: p.subcuenta410!, accountName: 'x', debe: 1, haber: 0 } });
    await expect(proveedoresService.remove(E, p.id)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('movimientos contables') });
    const q = await proveedoresService.create(E, { nombreFiscal: 'Proveedor Vacío SL', nifCif: cif() });
    await proveedoresService.remove(E, q.id);
    const cuentas = await prisma.chartOfAccounts.findMany({ where: { companyId: E, codigo: { in: [q.subcuenta400!, q.subcuenta410!] } } });
    expect(cuentas.map((c) => c.activo)).toEqual([false, false]);
  });
});

describe('el plan contable solo con contabilidad:read', () => {
  /** Usuario con esos permisos en la empresa (como los pone authMiddleware desde la BD). */
  function app(rol: string, permisos: string[]) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      req.user = { userId: `u-${rol}`, email: `${rol}@test.local`, roles: [rol], companies: [E], rolesPorEmpresa: { [E]: [rol] }, permisosPorEmpresa: { [E]: permisos } } as never;
      req.companyId = E;
      next();
    });
    a.use('/accounting/chart-of-accounts', chartOfAccountsRoutes);
    a.use(errorMiddleware);
    return a;
  }

  it('un usuario solo de ventas: 403 en la lista, el arbol y una cuenta', async () => {
    for (const ruta of ['/accounting/chart-of-accounts', '/accounting/chart-of-accounts/arbol', '/accounting/chart-of-accounts/43000003']) {
      expect((await request(app('ventas', ['ventas:read', 'ventas:write'])).get(ruta)).status).toBe(403);
    }
  });

  it('un contable si lo ve', async () => {
    expect((await request(app('contable', ['contabilidad:read'])).get('/accounting/chart-of-accounts/43000003')).status).toBe(200);
  });

  it('la lista dice de que cliente o proveedor es cada subcuenta', async () => {
    const r = await request(app('contable', ['contabilidad:read'])).get('/accounting/chart-of-accounts');
    expect(r.status).toBe(200);
    const cuentas = r.body.data.cuentas as Array<{ codigo: string; tercero: { tipo: string; id: string; nombre: string } | null }>;
    const c = await prisma.customer.findFirstOrThrow({ where: { companyId: E, subcuenta430: '43000003' } });
    expect(cuentas.find((x) => x.codigo === '43000003')?.tercero).toMatchObject({ tipo: 'cliente', id: c.id, nombre: c.nombreFiscal });
    expect(cuentas.find((x) => x.codigo === '430')?.tercero).toBeNull();
  });
});

describe('sugerencia de subcuenta de tercero', () => {
  it('con la ficha ya dada de alta: su subcuenta; sin ficha: la que recibira', async () => {
    const { sugerirSubcuentaParaTercero } = await import('../services/sugerenciasContables.service');
    const c = await prisma.customer.findFirstOrThrow({ where: { companyId: E, subcuenta430: '43000003' } });
    expect(await sugerirSubcuentaParaTercero(E, { tipo: 'cliente', nombre: 'x', nif: c.nifCif })).toMatchObject({ codigoPropuesto: '43000003', cuentaBaseCodigo: '430' });
    const libre = await sugerirSubcuentaParaTercero(E, { tipo: 'proveedor', nombre: 'Nuevo', nif: 'B00000000' });
    expect(libre.codigoPropuesto).toMatch(/^400\d{5}$/);
    // Solo lee: no da de alta nada.
    expect(await prisma.supplier.count({ where: { companyId: E, OR: [{ subcuenta400: libre.codigoPropuesto }] } })).toBe(0);
  });
});
