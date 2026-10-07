/**
 * Contabilidad e impuestos con divisas y tipo de operacion, sobre BD real:
 *  - exportacion de 10.000 USD a 1 USD = 0,90 EUR: asiento sin 477, libro de
 *    IVA con E2, [60] = 9.000 € en el 303 y fuera del 349 y del 347;
 *  - entrega intracomunitaria: [59] y clave E en el 349;
 *  - cobro en USD con diferencia de cambio positiva (768) y negativa (668),
 *    comision (626), anulacion y lo pendiente en dolares;
 *  - una factura en divisa sin tipo fijado no se contabiliza;
 *  - empresa de EE. UU.: asiento sin libro de IVA y sin modelos;
 *  - facturas EUR anteriores (sin tipo de operacion): exactamente lo de antes.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
// Sin red: el BCE "no responde" y los tipos se indican a mano.
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    get: jest.fn(async () => {
      throw new Error('BCE caído');
    }),
  },
}));

import { describe, it, expect, beforeAll, beforeEach } from '@jest/globals';
import { prisma } from '../config/database';
import { incomeInvoicesService, type CrearLineaIngresoDTO } from '../services/income-invoices.service';
import { AccountingEngineController } from '../controllers/accounting-engine.controller';
import { accountingHooksService } from '../services/accounting-hooks.service';
import { anularCobroFactura, registrarCobroFactura } from '../services/cobrosPagos.service';
import {
  agregar303,
  agregar347,
  agregar349,
  agregar390,
  calcularModelo303,
  calcularModelo347,
  calcularModelo349,
  obtenerFacturasFiscales,
} from '../services/impuestosCalculo.service';
import { listarModelosImpuesto } from '../services/impuestosModulo.service';
import { generarPaginaModelo303_03 } from '../services/impuestosExport.service';
import { informeMayorTerceros } from '../services/informesContables.service';
import { limpiarMemoTiposCambio } from '../services/tiposCambio.service';
import { previsualizarCierre } from '../services/cierreEjercicio.service';
import { agregar303Anterior, agregar347Anterior, agregar349Anterior, agregar390Anterior } from './agregadores-anteriores';
import type { PeriodoFiscal } from '../domain/impuestos.model';

const motor = new AccountingEngineController();
const T1: PeriodoFiscal = { ejercicio: 2026, periodo: '1T', tipo: 'trimestral', fechaInicio: '2026-01-01', fechaFin: '2026-03-31' };

let n = 0;
async function empresa(legal: { pais?: string; monedaCuenta?: string } = {}): Promise<string> {
  const id = `conta-divisas-${Date.now()}-${++n}`;
  await prisma.company.create({ data: { id, name: `Contabilidad divisas ${n}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: id, denominacion: `Contabilidad divisas ${n}`, nif: 'B00000000', ...legal } });
  return id;
}
async function cliente(companyId: string, nifCif: string, pais = 'ES'): Promise<string> {
  return (await prisma.customer.create({ data: { companyId, nombreFiscal: `Cliente ${nifCif}`, nifCif, pais } })).id;
}
async function banco(companyId: string): Promise<string> {
  return (await prisma.bankAccount.create({ data: { companyId, iban: `ES00${Date.now()}`, bancoNombre: 'Banco', subcuentaCodigo: '5720001' } })).id;
}
const linea = (precio: number, tipoIva = 0, extra: Partial<CrearLineaIngresoDTO> = {}): CrearLineaIngresoDTO => ({
  descripcion: 'Mercancía',
  cantidad: 1,
  precioUnitario: precio,
  tipoIva,
  ...extra,
});
async function lineasAsiento(id: string) {
  const a = await prisma.journalEntry.findUniqueOrThrow({ where: { id }, include: { lineas: true } });
  return { asiento: a, porCuenta: Object.fromEntries(a.lineas.map((l) => [l.accountCode, [l.debe, l.haber]])) };
}

beforeEach(() => {
  limpiarMemoTiposCambio();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('exportacion en USD de una empresa espanola', () => {
  let companyId: string;
  let exportacionId: string;

  beforeAll(async () => {
    companyId = await empresa();
  });

  it('10.000 USD a 1 USD = 0,90 EUR (1 EUR = 1,11111111 USD): 9.000 € sin 477 y libro de IVA E2', async () => {
    const us = await cliente(companyId, '12-3456789', 'US');
    const f = await incomeInvoicesService.crearIngreso({
      companyId,
      customer: { id: us },
      fechaEmision: '2026-03-10',
      moneda: 'USD',
      tipoCambio: 1.11111111,
      tipoOperacion: 'EXPORTACION',
      lineas: [linea(10000, 0, { moneda: 'USD' })],
    });
    exportacionId = f.id;
    expect(f).toMatchObject({ estadoDocumento: 'FINAL', tipoOperacion: 'EXPORTACION', fuenteTipoCambio: 'MANUAL', baseTotal: 9000, ivaTotal: 0, totalFactura: 9000, totalFacturaDoc: 10000 });

    const r = await motor.contabilizarFacturaIngreso(companyId, f.id);
    const { asiento, porCuenta } = await lineasAsiento(r.journalEntryId);
    expect(porCuenta).toEqual({ '430': [9000, 0], '700': [0, 9000] });
    expect(asiento.descripcion).toContain('(10.000,00 USD; 1 EUR = 1,1111 USD, tipo indicado a mano)');

    const libro = await prisma.vATBook.findMany({ where: { companyId, numeroFactura: f.numeroCompleto! } });
    expect(libro.map((l) => [l.tipoIva, l.baseImponible, l.cuotaIva, l.tipoOperacion, l.causaExencion])).toEqual([[0, 9000, 0, 'EXPORTACION', 'E2']]);
  });

  it('303: [60] = 9.000 € y nada devengado; fuera del 349 y del 347', async () => {
    const m303 = await calcularModelo303(companyId, T1);
    expect(m303.exportaciones).toBe(9000);
    expect(m303.totalCuotaDevengada).toBe(0);
    expect(generarPaginaModelo303_03(m303).slice(28, 45)).toBe('00000000000900000'); // [60]@29
    expect((await calcularModelo349(companyId, T1)).operaciones).toEqual([]);
    expect((await calcularModelo347(companyId, 2026)).operaciones).toEqual([]);
  });

  it('la rectificativa total hereda tipo y moneda, se contabiliza en negativo y deja la 430 y la 700 a cero', async () => {
    const r = await incomeInvoicesService.crearRectificativa(companyId, exportacionId, { motivo: 'Devolución' });
    expect(r).toMatchObject({ tipoOperacion: 'EXPORTACION', fuenteTipoCambio: 'HEREDADO', baseTotal: -9000, totalFacturaDoc: -10000 });
    // Con base negativa tambien se contabiliza al emitir (antes se quedaba sin asiento).
    const res = await accountingHooksService.onIncomeInvoiceConfirmed(companyId, r.id);
    expect(res.contabilizada).toBe(true);
    const lineas = await prisma.journalEntryLine.findMany({ where: { companyId, entry: { origen: 'FACTURA_INGRESO' } } });
    const saldo = (cuenta: string) => Math.round(lineas.filter((l) => l.accountCode === cuenta).reduce((s, l) => s + l.debe - l.haber, 0) * 100) / 100;
    expect([saldo('430'), saldo('700'), saldo('477')]).toEqual([0, 0, 0]);
  });
});

describe('entrega intracomunitaria', () => {
  it('[59] en el 303 y clave E en el 349, sin 477 y libro de IVA E5', async () => {
    const companyId = await empresa();
    const fr = await cliente(companyId, 'FR12345678901', 'FR');
    const f = await incomeInvoicesService.crearIngreso({
      companyId,
      customer: { id: fr },
      fechaEmision: '2026-02-10',
      tipoOperacion: 'INTRACOMUNITARIA',
      lineas: [linea(2000)],
    });
    const r = await motor.contabilizarFacturaIngreso(companyId, f.id);
    expect((await lineasAsiento(r.journalEntryId)).porCuenta).toEqual({ '430': [2000, 0], '700': [0, 2000] });
    expect((await prisma.vATBook.findFirstOrThrow({ where: { companyId } })).causaExencion).toBe('E5');

    const m303 = await calcularModelo303(companyId, T1);
    expect(m303.entregasIntracomunitarias).toBe(2000);
    expect(m303.totalCuotaDevengada).toBe(0);
    expect((await calcularModelo349(companyId, T1)).operaciones).toEqual([
      { cifnif: 'FR12345678901', nombre: 'Cliente FR12345678901', clave: 'E', base: 2000 },
    ]);
  });
});

describe('cobro de una factura en USD', () => {
  let companyId: string;
  let bancoId: string;
  let facturaId: string;
  let clienteId: string;

  beforeAll(async () => {
    companyId = await empresa();
    bancoId = await banco(companyId);
    clienteId = await cliente(companyId, '98-7654321', 'US');
    // 1.000 USD a 1,10 = 909,09 €.
    const f = await incomeInvoicesService.crearIngreso({
      companyId,
      customer: { id: clienteId },
      fechaEmision: '2026-03-01',
      fechaVencimiento: '2099-12-31',
      moneda: 'USD',
      tipoCambio: 1.1,
      tipoOperacion: 'EXPORTACION',
      lineas: [linea(1000, 0, { moneda: 'USD' })],
    });
    facturaId = f.id;
    await motor.contabilizarFacturaIngreso(companyId, f.id);
  });

  it('parcial de 400 USD a 1,05: 572 D 380,95 / 430 H 363,64 / 768 H 17,31; lo pendiente en dolares', async () => {
    const { cobro, resumen } = await registrarCobroFactura(companyId, 'INGRESO', facturaId, {
      fecha: '2026-03-15',
      importeDoc: 400,
      tipoCambio: '1,05',
      cuentaBancariaId: bancoId,
    });
    expect(cobro).toMatchObject({ moneda: 'USD', importeDoc: 400, importe: 363.64, importeTesoreria: 380.95, tipoCambio: 1.05, fuenteTipoCambio: 'MANUAL', diferenciaCambio: 17.31 });
    expect(resumen).toMatchObject({ moneda: 'USD', monedaCuenta: 'EUR', totalFactura: 1000, importeCobrado: 400, importePendiente: 600, importePendienteCuenta: 545.45, estado: 'PENDING' });
    expect((await lineasAsiento(cobro.asientoId!)).porCuenta).toEqual({ '5720001': [380.95, 0], '430': [0, 363.64], '768': [0, 17.31] });
    // La 768 se ha anadido al plan de una empresa que ya existia.
    expect(await prisma.chartOfAccounts.count({ where: { companyId, codigo: '768' } })).toBe(1);
  });

  it('resto de 600 USD a 1,12: 668 D 9,74 y la 430 de la factura queda a cero; PAID', async () => {
    const { cobro, resumen } = await registrarCobroFactura(companyId, 'INGRESO', facturaId, {
      fecha: '2026-03-20',
      importeDoc: 600,
      tipoCambio: 1.12,
      cuentaBancariaId: bancoId,
    });
    expect((await lineasAsiento(cobro.asientoId!)).porCuenta).toEqual({ '5720001': [535.71, 0], '668': [9.74, 0], '430': [0, 545.45] });
    expect(resumen).toMatchObject({ importePendiente: 0, importePendienteCuenta: 0, estado: 'PAID' });
    expect((await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: facturaId } })).estado).toBe('PAID');

    const mayor = await informeMayorTerceros(companyId, 'clientes', { desde: '2026-01-01', hasta: '2026-12-31', ejercicio: 2026 });
    expect(mayor.terceros.find((t) => t.id === clienteId)).toMatchObject({ debe: 909.09, haber: 909.09, saldoFinal: 0, pendienteFacturas: 0 });
  });

  it('anular el ultimo cobro: su asiento (con la 668) deja de contar y vuelven a quedar 600 USD', async () => {
    await expect(
      registrarCobroFactura(companyId, 'INGRESO', facturaId, { fecha: '2026-03-21', importeDoc: 1, tipoCambio: 1.1, cuentaBancariaId: bancoId }),
    ).rejects.toThrow(/ya está cobrada/);
    const cobros = await prisma.invoicePayment.findMany({ where: { companyId, invoiceId: facturaId }, orderBy: { fecha: 'asc' } });
    const { resumen } = await anularCobroFactura(companyId, 'INGRESO', facturaId, cobros[1].id);
    expect(resumen).toMatchObject({ importeCobrado: 400, importePendiente: 600, importePendienteCuenta: 545.45, estado: 'PENDING' });
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: cobros[1].journalEntryId! } })).estado).toBe('REVERSED');
  });

  it('con lo recibido en el banco y la comision: 626 y 768 por la diferencia', async () => {
    const { cobro } = await registrarCobroFactura(companyId, 'INGRESO', facturaId, {
      fecha: '2026-03-25',
      importeDoc: 600,
      importeRecibido: 560,
      comisionBancaria: 5,
      cuentaBancariaId: bancoId,
    });
    expect(cobro).toMatchObject({ fuenteTipoCambio: 'BANCO', importe: 545.45, importeTesoreria: 560, comisionBancaria: 5, diferenciaCambio: 19.55 });
    expect((await lineasAsiento(cobro.asientoId!)).porCuenta).toEqual({ '5720001': [560, 0], '626': [5, 0], '430': [0, 545.45], '768': [0, 19.55] });
  });

  it('en divisa el importe va en importeDoc; sin BCE ni tipo, se pide; en euros no se admite tipo', async () => {
    const otra = await incomeInvoicesService.crearIngreso({
      companyId,
      customer: { id: clienteId },
      fechaEmision: '2026-03-26',
      moneda: 'USD',
      tipoCambio: 1.1,
      tipoOperacion: 'EXPORTACION',
      lineas: [linea(100, 0, { moneda: 'USD' })],
    });
    await expect(registrarCobroFactura(companyId, 'INGRESO', otra.id, { fecha: '2026-03-27', importe: 50, cuentaBancariaId: bancoId })).rejects.toThrow(
      /importeDoc/,
    );
    await expect(registrarCobroFactura(companyId, 'INGRESO', otra.id, { fecha: '2026-03-27', cuentaBancariaId: bancoId })).rejects.toThrow(
      /indica el tipo de cambio del día o lo recibido/,
    );
    await expect(
      registrarCobroFactura(companyId, 'INGRESO', otra.id, { fecha: '2026-03-27', importeDoc: 150, tipoCambio: 1.1, cuentaBancariaId: bancoId }),
    ).rejects.toThrow(/supera lo pendiente de la factura \(100\.00 USD\)/);

    const es = await cliente(companyId, 'B55555555');
    const eur = await incomeInvoicesService.crearIngreso({ companyId, customer: { id: es }, fechaEmision: '2026-03-27', lineas: [linea(100, 21)] });
    await expect(
      registrarCobroFactura(companyId, 'INGRESO', eur.id, { fecha: '2026-03-28', importe: 10, tipoCambio: 1.1, cuentaBancariaId: bancoId }),
    ).rejects.toThrow(/solo se indican en cobros de facturas en otra moneda/);
  });

  it('el cierre del ejercicio avisa de las facturas en divisa pendientes (el ajuste al tipo de cierre no se hace)', async () => {
    const v = await previsualizarCierre(companyId, 2026);
    const aviso = v.avisos.find((a) => /en otra moneda pendientes de cobro/.test(a));
    expect(aviso).toMatch(/NRV 11/);
    expect(aviso).toMatch(/\(USD\)/);
  });
});

describe('factura en divisa sin tipo de cambio fijado', () => {
  it('no se contabiliza: la emision lo dice (contabilizada: false)', async () => {
    const companyId = await empresa();
    const es = await cliente(companyId, 'B66666666');
    const f = await prisma.incomeInvoice.create({
      data: {
        companyId,
        customerId: es,
        serie: 'A',
        numero: 1,
        numeroCompleto: 'A-1',
        fechaEmision: '2026-03-05',
        fechaVencimiento: '2026-03-20',
        moneda: 'USD',
        fuenteTipoCambio: 'PENDIENTE',
        tipoOperacion: 'NACIONAL',
        baseTotal: 0,
        ivaTotal: 0,
        totalFactura: 0,
        baseTotalDoc: 100,
        ivaTotalDoc: 21,
        retencionTotalDoc: 0,
        totalFacturaDoc: 121,
        lineas: { create: [{ descripcion: 'x', cantidad: 1, precioUnitario: 0, baseLine: 1, ivaImporte: 0, tipoIva: 21, precioUnitarioDoc: 100, baseLineDoc: 100, ivaImporteDoc: 21 }] },
      },
    });
    await expect(motor.contabilizarFacturaIngreso(companyId, f.id)).rejects.toThrow('Factura en USD sin tipo de cambio: no se contabiliza.');
    await prisma.incomeInvoice.update({ where: { id: f.id }, data: { baseTotal: 100 } });
    const r = await accountingHooksService.onIncomeInvoiceConfirmed(companyId, f.id);
    expect(r).toMatchObject({ contabilizada: false, motivo: expect.stringContaining('sin tipo de cambio') });
    expect(await prisma.journalEntry.count({ where: { companyId } })).toBe(0);
  });
});

describe('empresa de EE. UU. (sin IVA en la app)', () => {
  it('asiento 430/700 sin libro de IVA, fuera de los modelos y sin calendario de la AEAT', async () => {
    const companyId = await empresa({ pais: 'US', monedaCuenta: 'USD' });
    const us = await cliente(companyId, '11-1111111', 'US');
    const f = await incomeInvoicesService.crearIngreso({ companyId, customer: { id: us }, fechaEmision: '2026-03-02', lineas: [linea(1000, 21)] });
    expect(f).toMatchObject({ tipoOperacion: 'EMPRESA_EXTRANJERA', moneda: 'USD', totalFactura: 1000 });

    const r = await motor.contabilizarFacturaIngreso(companyId, f.id);
    expect((await lineasAsiento(r.journalEntryId)).porCuenta).toEqual({ '430': [1000, 0], '700': [0, 1000] });
    expect(await prisma.vATBook.count({ where: { companyId } })).toBe(0);

    expect(await obtenerFacturasFiscales(companyId, '2026-01-01', '2026-12-31')).toEqual([]);
    await expect(calcularModelo303(companyId, T1)).rejects.toThrow(/no está establecida en España/);
    await expect(calcularModelo347(companyId, 2026)).rejects.toThrow(/no está establecida en España/);
    expect(await listarModelosImpuesto(companyId, 2026)).toEqual([]);
    expect(await prisma.modeloImpuesto.count({ where: { companyId } })).toBe(0);
  });
});

describe('facturas EUR anteriores (sin tipo de operacion): exactamente lo de antes', () => {
  it('modelos, asiento y libro de IVA como siempre', async () => {
    const companyId = await empresa();
    const es = await cliente(companyId, 'B77777777');
    const fra = await cliente(companyId, 'FR99999999999', 'FRA'); // ISO-3: intracomunitaria, como siempre
    const fr2 = await cliente(companyId, 'FR88888888888', 'FR'); // ISO-2: la tabla de siempre la daba como exportacion
    const antigua = (customerId: string, numero: number, base: number, iva: number) =>
      prisma.incomeInvoice.create({
        data: {
          companyId,
          customerId,
          serie: 'L',
          numero,
          numeroCompleto: `L-${numero}`,
          fechaEmision: `2026-02-0${numero}`,
          fechaVencimiento: '2026-03-31',
          baseTotal: base,
          ivaTotal: iva,
          totalFactura: base + iva,
          lineas: { create: [{ descripcion: 'Antigua', cantidad: 1, precioUnitario: base, baseLine: base, ivaImporte: iva, tipoIva: iva ? 21 : 0 }] },
        },
      });
    const a1 = await antigua(es, 1, 4000, 840);
    await antigua(fra, 2, 2000, 0);
    await antigua(fr2, 3, 700, 0);

    const fiscales = (await obtenerFacturasFiscales(companyId, '2026-01-01', '2026-12-31')).sort((a, b) =>
      String(a.idFactura).localeCompare(String(b.idFactura)),
    );
    // Sin campos nuevos y con la clasificacion de siempre.
    expect(fiscales.map((f) => [f.idFactura, f.operacion, Object.keys(f).sort().join(',')])).toEqual([
      ['L-1', 'interior', 'cifnif,fecha,idFactura,lineas,nombreTercero,operacion,tipo'],
      ['L-2', 'intracomunitaria', 'cifnif,fecha,idFactura,lineas,nombreTercero,operacion,tipo'],
      ['L-3', 'exportacion', 'cifnif,fecha,idFactura,lineas,nombreTercero,operacion,tipo'],
    ]);
    expect(agregar303(fiscales, T1)).toEqual(agregar303Anterior(fiscales, T1));
    expect(agregar347(fiscales, 2026)).toEqual(agregar347Anterior(fiscales, 2026));
    expect(agregar349(fiscales, T1)).toEqual(agregar349Anterior(fiscales, T1));
    const { volumen: _v, advertencias: _a, ...a390 } = agregar390(fiscales, 2026);
    expect(a390).toEqual(agregar390Anterior(fiscales, 2026));
    expect((await calcularModelo303(companyId, T1)).exportaciones).toBe(700);

    const r = await motor.contabilizarFacturaIngreso(companyId, a1.id);
    const { asiento, porCuenta } = await lineasAsiento(r.journalEntryId);
    expect(porCuenta).toEqual({ '430': [4840, 0], '700': [0, 4000], '477': [0, 840] });
    expect(asiento.descripcion).toBe('Factura de ingreso #L-1 - Cliente B77777777');
    const libro = await prisma.vATBook.findMany({ where: { companyId } });
    expect(libro.map((l) => [l.tipoIva, l.baseImponible, l.cuotaIva, l.tipoOperacion, l.causaExencion])).toEqual([[21, 4000, 840, null, null]]);
  });
});
