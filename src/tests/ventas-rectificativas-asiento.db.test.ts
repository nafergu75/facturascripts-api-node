/**
 * Asiento y libro de expedidas de las rectificativas de venta (B6):
 *  - por diferencias, los negativos en el mismo lado, contra la 430N del
 *    cliente de la original: el espejo deja la 430N, la 700 y la 477 a cero;
 *  - por sustitucion, solo la diferencia con la original (antes contaba la
 *    factura corregida entera: observacion 17 de abonos-proveedor.md);
 *  - una linea a la 708 va a la 708;
 *  - el libro de expedidas dice que rectifica, el tipo, la forma y la causa.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { incomeInvoicesService, type CrearFacturaIngresoDTO } from '../services/income-invoices.service';
import { AccountingEngineController } from '../controllers/accounting-engine.controller';
import { asegurarPlanContableEmpresa } from '../services/chart-of-accounts.service';
import { aCentimos } from '../utils/money';

const E = `venta-rect-asiento-${Date.now()}`;
const motor = new AccountingEngineController();
let cliente = '';

const linea = (precio: number, extra: Record<string, unknown> = {}) => ({ descripcion: 'Servicio', cantidad: 1, precioUnitario: precio, tipoIva: 21, ...extra });
const emitir = (lineas: Array<ReturnType<typeof linea>>) =>
  incomeInvoicesService.crearIngreso({ companyId: E, customer: { id: cliente }, fechaEmision: '2026-09-15', lineas } as CrearFacturaIngresoDTO);
const rect = (rectificativa: Record<string, unknown>, lineas: Array<ReturnType<typeof linea>>) =>
  incomeInvoicesService.crearIngreso({
    companyId: E,
    customer: {},
    lineas,
    rectificativa: { ticket: false, forma: 'I', motivo: 'DEVOLUCION', explicacion: 'Devolución', ...rectificativa },
  } as unknown as CrearFacturaIngresoDTO);
const asientoDe = async (invoiceId: string) => {
  const r = await motor.contabilizarFacturaIngreso(E, invoiceId);
  return prisma.journalEntry.findUniqueOrThrow({ where: { id: r.journalEntryId }, include: { lineas: true } });
};
/** Saldo (debe - haber, en centimos) por cuenta de varios asientos. */
const saldos = (asientos: Array<{ lineas: Array<{ accountCode: string; debe: number; haber: number }> }>) => {
  const m = new Map<string, number>();
  for (const a of asientos) for (const l of a.lineas) m.set(l.accountCode, (m.get(l.accountCode) ?? 0) + aCentimos(Number(l.debe)) - aCentimos(Number(l.haber)));
  return m;
};
const cuadra = (a: { lineas: Array<{ debe: number; haber: number }> }) =>
  a.lineas.reduce((s, l) => s + aCentimos(Number(l.debe)), 0) === a.lineas.reduce((s, l) => s + aCentimos(Number(l.haber)), 0);

beforeAll(async () => {
  await prisma.company.create({ data: { id: E, name: 'Asiento Rectificativas SL', fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: E, denominacion: 'Asiento Rectificativas SL', nif: 'B40000004' } });
  await asegurarPlanContableEmpresa(E);
  cliente = (await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Cliente Asiento SL', nifCif: 'B50000031' } })).id;
});

describe('asiento de las rectificativas de venta', () => {
  it('el espejo de la original deja a cero la 430N, la 700 y la 477, contra la subcuenta del cliente', async () => {
    const a = await emitir([linea(333.33), linea(0.07, { tipoIva: 10 })]);
    const asOriginal = await asientoDe(a.id);
    const r = await rect({ originales: [{ id: a.id }] }, [
      { ...linea(333.33), cantidad: -1 },
      { ...linea(0.07, { tipoIva: 10 }), cantidad: -1 },
    ]);
    expect(r.totalFactura).toBe(-a.totalFactura);
    const asRect = await asientoDe(r.id);
    expect(cuadra(asRect)).toBe(true);
    const cuentaCliente = asOriginal.lineas.find((l) => l.accountCode.startsWith('43'))!.accountCode;
    expect(asRect.lineas.find((l) => l.accountCode.startsWith('43'))!.accountCode).toBe(cuentaCliente);
    const s = saldos([asOriginal, asRect]);
    for (const c of [cuentaCliente, '700', '477']) expect(s.get(c)).toBe(0);
    // Negativos en el mismo lado (observacion 17.2): la 430N al debe en negativo.
    expect(Number(asRect.lineas.find((l) => l.accountCode === cuentaCliente)!.debe)).toBe(r.totalFactura);
    expect(asRect.descripcion).toContain(`rectifica ${a.numeroCompleto}`);
  });

  it('por sustitución solo se mueve la diferencia, y el libro de expedidas lo explica', async () => {
    const a = await emitir([linea(100)]); // 121
    const asOriginal = await asientoDe(a.id);
    const s = await rect({ forma: 'S', motivo: 'ERROR', explicacion: 'El precio era 80' }, [linea(80)]).catch(() => null);
    expect(s).toBeNull(); // sin originales no vale
    const sust = await rect({ forma: 'S', motivo: 'ERROR', explicacion: 'El precio era 80', originales: [{ id: a.id }] }, [linea(80)]);
    expect(sust.totalFactura).toBe(96.8);
    const asSust = await asientoDe(sust.id);
    expect(cuadra(asSust)).toBe(true);
    const cuentaCliente = asOriginal.lineas.find((l) => l.accountCode.startsWith('43'))!.accountCode;
    const lin = (c: string) => asSust.lineas.find((l) => l.accountCode === c)!;
    expect([Number(lin(cuentaCliente).debe), Number(lin('700').haber), Number(lin('477').haber)]).toEqual([-24.2, -20, -4.2]);
    // El cliente debe lo de la factura corregida: 121 - 24,20 = 96,80.
    expect(saldos([asOriginal, asSust]).get(cuentaCliente)).toBe(9680);
    const libro = await prisma.vATBook.findMany({ where: { companyId: E, asientoId: asSust.id } });
    expect(libro.map((x) => [Number(x.baseImponible), Number(x.cuotaIva), Number(x.tipoIva)])).toEqual([[-20, -4.2, 21]]);
    expect(libro[0].observaciones).toBe(`Rectificativa (R4, por sustitución) de ${a.numeroCompleto} de 15/09/2026. Causa: error en datos o importes.`);
  });

  it('una línea a la 708 (devoluciones de ventas) va a la 708', async () => {
    const a = await emitir([linea(500)]);
    await asientoDe(a.id);
    const r = await rect({ originales: [{ id: a.id }] }, [{ ...linea(-100), cuenta: '708' } as ReturnType<typeof linea>]);
    const as = await asientoDe(r.id);
    expect(cuadra(as)).toBe(true);
    expect(Number(as.lineas.find((l) => l.accountCode === '708')!.haber)).toBe(-100);
    expect(as.lineas.some((l) => l.accountCode === '700')).toBe(false);
  });

  it('con varias originales, el libro cita todas', async () => {
    const a = await emitir([linea(100)]);
    const b = await emitir([linea(50)]);
    const r = await rect(
      { motivo: 'DESCUENTO', originales: [{ id: a.id, base: -10, cuota: -2.1 }, { id: b.id, base: -5, cuota: -1.05 }] },
      [linea(-10), linea(-5)],
    );
    const as = await asientoDe(r.id);
    expect(cuadra(as)).toBe(true);
    const libro = await prisma.vATBook.findFirstOrThrow({ where: { companyId: E, asientoId: as.id } });
    expect(libro.observaciones).toBe(
      `Rectificativa (R1, por diferencias) de ${a.numeroCompleto} de 15/09/2026, ${b.numeroCompleto} de 15/09/2026. Causa: descuento o bonificación posterior.`,
    );
  });
});
