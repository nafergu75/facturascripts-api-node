/**
 * Cuanto trabajo hace la transaccion de contabilizar una factura, sobre BD real.
 *
 * Regresion (13-10-2026): en produccion (Vercel + TiDB Serverless, donde cada
 * sentencia es un viaje de red) la transaccion de contabilizar una venta leida
 * paso de 5 s y la venta quedo sin asiento. Dentro iban una sentencia por
 * linea del asiento y por fila del libro de IVA, ademas de lecturas que no
 * necesitan ir dentro (la subcuenta del cliente, el plan, los nombres de las
 * cuentas). Ahora las lecturas van antes y el asiento se escribe con sus
 * lineas de una vez. Estos tests miden las sentencias de la transaccion y
 * comprueban que el asiento sale igual.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { prisma } from '../config/database';
import { AccountingEngineController } from '../controllers/accounting-engine.controller';
import { clientesService } from '../services/clientes.service';
import { expenseInvoicesService } from '../services/expense-invoices.service';
import { incomeInvoicesService } from '../services/income-invoices.service';
import { proveedoresService } from '../services/proveedores.service';
import { consultasEnTransacciones } from './consultas-transaccion';

const SUFIJO = `${Date.now()}`;
const E = `conta-consultas-${SUFIJO}`;
const motor = new AccountingEngineController();

/** Lineas del asiento por cuenta: [debe, haber]. */
async function asientoPorCuenta(journalEntryId: string): Promise<Record<string, [number, number]>> {
  const a = await prisma.journalEntry.findUniqueOrThrow({ where: { id: journalEntryId }, include: { lineas: true } });
  return Object.fromEntries(a.lineas.map((l) => [l.accountCode, [Number(l.debe), Number(l.haber)]]));
}

beforeAll(async () => {
  await prisma.company.create({ data: { id: E, name: 'Consultas Contables SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: E, denominacion: 'Consultas Contables SL', nif: 'B12345674' } });
});

describe('contabilizar una venta desde su ficha', () => {
  it('cliente recien dado de alta y una linea a la 701: asiento y libro de IVA completos, con pocas sentencias en la transaccion', async () => {
    const cliente = (await clientesService.create(E, { nombreFiscal: 'Logistica Turia SL', nifCif: 'B87654323' })) as { id: string };
    const crear = (numero: string) =>
      incomeInvoicesService.crearIngreso({
        companyId: E,
        customer: { id: cliente.id },
        fechaEmision: '2026-10-13',
        lineas: [{ descripcion: `Transporte ${numero}`, cantidad: 1, precioUnitario: 1000, tipoIva: 21, cuenta: '701' }],
      } as never);
    const f1 = await crear('1');

    const { resultado, porTransaccion } = await consultasEnTransacciones(() => motor.contabilizarFacturaIngreso(E, f1.id, 'MANUAL'));
    const ficha = await prisma.customer.findUniqueOrThrow({ where: { id: cliente.id } });
    expect(await asientoPorCuenta(resultado.journalEntryId)).toEqual({ [ficha.subcuenta430!]: [1210, 0], '701': [0, 1000], '477': [0, 210] });
    const lineas = await prisma.journalEntryLine.findMany({ where: { entryId: resultado.journalEntryId } });
    expect(Object.fromEntries(lineas.map((l) => [l.accountCode, l.accountName]))).toEqual({
      [ficha.subcuenta430!]: 'Logistica Turia SL',
      '701': 'Ventas de productos terminados',
      '477': 'IVA repercutido',
    });
    // La subcuenta del cliente queda dada de alta en el plan, en la misma transaccion.
    expect(await prisma.chartOfAccounts.findFirst({ where: { companyId: E, codigo: ficha.subcuenta430! } })).toMatchObject({ nombre: 'Logistica Turia SL', parentCodigo: '430' });
    const libro = await prisma.vATBook.findMany({ where: { companyId: E, asientoId: resultado.journalEntryId } });
    expect(libro.map((l) => [l.tipoLibro, Number(l.baseImponible), l.tipoIva, Number(l.cuotaIva), l.nifTercero])).toEqual([['EMITIDAS', 1000, 21, 210, 'B87654323']]);

    // Una sola transaccion. Antes de este arreglo mandaba 16 sentencias (y
    // leia la fecha por otra conexion mientras tanto); ahora 5: alta de la
    // subcuenta, asiento con sus lineas (3) y libro de IVA.
    expect(porTransaccion).toHaveLength(1);
    expect(porTransaccion[0]).toBeLessThanOrEqual(5);

    // La segunda venta del mismo cliente: la subcuenta ya esta en el plan, no se toca.
    const f2 = await crear('2');
    const segunda = await consultasEnTransacciones(() => motor.contabilizarFacturaIngreso(E, f2.id, 'MANUAL'));
    expect(await asientoPorCuenta(segunda.resultado.journalEntryId)).toEqual({ [ficha.subcuenta430!]: [1210, 0], '701': [0, 1000], '477': [0, 210] });
    expect(segunda.porTransaccion).toHaveLength(1);
    expect(segunda.porTransaccion[0]).toBeLessThanOrEqual(4); // antes, 13
  });
});

describe('dos ventas del mismo cliente nuevo a la vez', () => {
  it('las dos con su asiento y una sola subcuenta en el plan (la que pierde repite con lo nuevo)', async () => {
    const cliente = (await clientesService.create(E, { nombreFiscal: 'Transportes Albufera SL', nifCif: 'B45678901' })) as { id: string };
    const facturas = await Promise.all(
      ['A', 'B'].map((n) =>
        incomeInvoicesService.crearIngreso({
          companyId: E,
          customer: { id: cliente.id },
          fechaEmision: '2026-10-13',
          lineas: [{ descripcion: `Porte ${n}`, cantidad: 1, precioUnitario: 100, tipoIva: 21 }],
        } as never),
      ),
    );
    const r = await Promise.all(facturas.map((f) => motor.contabilizarFacturaIngreso(E, f.id, 'MANUAL')));
    const ficha = await prisma.customer.findUniqueOrThrow({ where: { id: cliente.id } });
    for (const x of r) expect(await asientoPorCuenta(x.journalEntryId)).toEqual({ [ficha.subcuenta430!]: [121, 0], '700': [0, 100], '477': [0, 21] });
    expect(await prisma.chartOfAccounts.count({ where: { companyId: E, codigo: ficha.subcuenta430! } })).toBe(1);
  });
});

describe('contabilizar una compra desde su ficha', () => {
  it('proveedor con retencion y dos tipos de IVA: asiento, libro de IVA y de retenciones completos, con pocas sentencias', async () => {
    const proveedor = (await proveedoresService.create(E, { nombreFiscal: 'Asesores del Turia SL', nifCif: 'B98765431' })) as { id: string };
    const f = await expenseInvoicesService.crearGasto({
      companyId: E,
      provider: { id: proveedor.id },
      serie: 'G',
      fechaEmision: '2026-10-13',
      fechaVencimiento: '2099-12-31',
      tipoGasto: 'SERVICIO_PROFESIONAL',
      lineas: [
        { descripcion: 'Asesoria', cantidad: 1, precioUnitario: 1000, tipoIva: 21, tipoRetencion: 15 },
        { descripcion: 'Libros', cantidad: 1, precioUnitario: 100, tipoIva: 4, tipoRetencion: 15 },
      ],
    } as never);

    const { resultado, porTransaccion } = await consultasEnTransacciones(() => motor.contabilizarFacturaGasto(E, f.id, 'MANUAL'));
    const ficha = await prisma.supplier.findUniqueOrThrow({ where: { id: proveedor.id } });
    expect(await asientoPorCuenta(resultado.journalEntryId)).toMatchObject({ '623': [1100, 0], '4751': [0, 165], [ficha.subcuenta410!]: [0, 1149] });
    const a = await prisma.journalEntry.findUniqueOrThrow({ where: { id: resultado.journalEntryId }, include: { lineas: true } });
    expect(a.lineas.filter((l) => l.accountCode === '472').map((l) => Number(l.debe)).sort((x, y) => x - y)).toEqual([4, 210]);
    const libro = await prisma.vATBook.findMany({ where: { companyId: E, asientoId: resultado.journalEntryId }, orderBy: { tipoIva: 'asc' } });
    expect(libro.map((l) => [l.tipoLibro, Number(l.baseImponible), l.tipoIva, Number(l.cuotaIva)])).toEqual([
      ['RECIBIDAS', 100, 4, 4],
      ['RECIBIDAS', 1000, 21, 210],
    ]);
    const retenciones = await prisma.retentionBook.findMany({ where: { companyId: E, asientoId: resultado.journalEntryId } });
    expect(retenciones.map((r) => [Number(r.baseImponible), r.porcentajeRetencion, Number(r.cuotaRetencion)])).toEqual([[1100, 15, 165]]);
    expect(await prisma.expenseInvoice.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({ estado: 'ACCOUNTED' });

    // Antes: 28 sentencias. Ahora 9: alta de la subcuenta, asiento con sus
    // lineas (3), los dos libros y la factura marcada como contabilizada (3).
    expect(porTransaccion).toHaveLength(1);
    expect(porTransaccion[0]).toBeLessThanOrEqual(9);
  });
});
