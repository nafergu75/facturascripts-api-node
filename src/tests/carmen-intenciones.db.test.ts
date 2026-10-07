/**
 * Carmen, intenciones de datos sobre BD real (MySQL/MariaDB de pruebas):
 *  - cifras exactas: cada intención da la cifra que calcula a mano el test y
 *    la misma que el servicio de origen (pendientesSegunFacturas,
 *    resumenFiscalPeriodo, listarCobros, informePerdidasGanancias,
 *    calcularModelo303 y el modelo guardado, calendarioFiscalSoloLectura);
 *  - solo lectura: con todas las intenciones ejecutadas contra la BD, ninguna
 *    sentencia SQL escribe (se capturan todas las consultas del cliente
 *    Prisma) y el CHECKSUM de todas las tablas no cambia.
 *
 * La API de Anthropic no interviene: aquí no hay capa de IA.
 */
const mockSql: string[] = [];
jest.mock('../config/database', () => {
  const { PrismaClient } = jest.requireActual('@prisma/client');
  const { importesComoNumero } = jest.requireActual('../config/decimales');
  const { reintentoConexion } = jest.requireActual('../config/reintentoConexion');
  const base = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
  base.$on('query', (e: { query: string }) => mockSql.push(e.query));
  return { prisma: base.$extends(reintentoConexion).$extends(importesComoNumero) };
});

import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { construirContexto } from '../services/carmen/contexto';
import { INTENCIONES, intencionPorId } from '../services/carmen/intenciones/catalogo';
import { olvidarIndices } from '../services/carmen/terceros';
import { resolverCodigoPeriodo } from '../services/carmen/huecos/periodo';
import { pendientesSegunFacturas, informePerdidasGanancias } from '../services/informesContables.service';
import { resumenFiscalPeriodo } from '../services/resumenFiscal.service';
import { listarCobros } from '../services/cobrosPagos.service';
import { calcularModelo303 } from '../services/impuestosCalculo.service';
import { calendarioFiscalSoloLectura } from '../services/impuestosModulo.service';
import type { AuthUser } from '../types/express';
import type { HuecosResueltos, RespuestaDatos } from '../services/carmen/tipos';

const SUF = Date.now();
const EMPRESA = `carmen-int-${SUF}`;
const EMPRESA_PYG = `carmen-pyg-${SUF}`;
const HOY = '2026-10-07';

const usuario = (roles: string[]): AuthUser => ({
  userId: `u-${SUF}`,
  roles,
  rolesPorEmpresa: { [EMPRESA]: roles, [EMPRESA_PYG]: roles },
  companies: [EMPRESA, EMPRESA_PYG],
});
const ctx = (roles: string[], empresa = EMPRESA) => construirContexto(usuario(roles), empresa, HOY);
const ejecutar = (id: string, h: HuecosResueltos = {}, roles = ['admin'], empresa = EMPRESA) => intencionPorId(id)!.ejecutar(ctx(roles, empresa), h);
const cifras = (r: RespuestaDatos) => {
  if (r.sinPermiso || r.sinCifras) throw new Error(`sin cifras: ${JSON.stringify(r)}`);
  return r;
};

const ids: Record<string, string> = {};

async function venta(
  clave: string,
  datos: {
    customerId: string;
    serie: string;
    numero: number | null;
    fecha: string;
    vence: string;
    base: number;
    estado?: string;
    estadoDocumento?: string;
    facturaOriginalId?: string;
    tipoRectificativa?: string;
  },
) {
  const iva = Math.round(datos.base * 21) / 100;
  const f = await prisma.incomeInvoice.create({
    data: {
      companyId: EMPRESA,
      customerId: datos.customerId,
      serie: datos.serie,
      numero: datos.numero,
      numeroCompleto: datos.numero === null ? null : `${datos.serie}-${datos.numero}`,
      estadoDocumento: datos.estadoDocumento ?? 'FINAL',
      fechaEmision: datos.fecha,
      fechaVencimiento: datos.vence,
      estado: datos.estado ?? 'PENDING',
      ...(datos.facturaOriginalId ? { facturaOriginalId: datos.facturaOriginalId, tipoRectificativa: datos.tipoRectificativa ?? 'I' } : {}),
      baseTotal: datos.base,
      ivaTotal: iva,
      totalFactura: datos.base + iva,
      lineas: { create: [{ descripcion: 'Servicio', cantidad: 1, precioUnitario: datos.base, baseLine: datos.base, tipoIva: 21, ivaImporte: iva }] },
    },
  });
  ids[clave] = f.id;
}

async function compra(
  clave: string,
  datos: { supplierId: string; serie: string; numero: number; fecha: string; vence: string; base: number; estado?: string; estadoPago?: string },
) {
  const iva = Math.round(datos.base * 21) / 100;
  const f = await prisma.expenseInvoice.create({
    data: {
      companyId: EMPRESA,
      supplierId: datos.supplierId,
      serie: datos.serie,
      numero: datos.numero,
      numeroCompleto: `${datos.serie}-${datos.numero}`,
      fechaEmision: datos.fecha,
      fechaVencimiento: datos.vence,
      estado: datos.estado ?? 'CONFIRMED',
      estadoPago: datos.estadoPago ?? 'PENDIENTE',
      baseTotal: datos.base,
      ivaTotal: iva,
      totalFactura: datos.base + iva,
      lineas: { create: [{ descripcion: 'Suministro', cantidad: 1, precioUnitario: datos.base, baseLine: datos.base, tipoIva: 21, ivaImporte: iva }] },
    },
  });
  ids[clave] = f.id;
}

const cobro = (invoiceType: 'INGRESO' | 'GASTO', invoiceId: string, fecha: string, importe: number) =>
  prisma.invoicePayment.create({ data: { companyId: EMPRESA, invoiceType, invoiceId, fecha, importe, cuentaTesoreria: '570', estado: 'ACTIVO' } });

let numeroAsiento = 0;
const asiento = (fecha: string, lineas: Array<[string, number, number]>, estado = 'POSTED') =>
  prisma.journalEntry.create({
    data: {
      companyId: EMPRESA_PYG,
      fecha: new Date(`${fecha}T00:00:00Z`),
      numeroAsiento: `PYG-${++numeroAsiento}`,
      descripcion: `Asiento ${numeroAsiento}`,
      origen: 'AJUSTE_MANUAL',
      estado,
      lineas: { create: lineas.map(([accountCode, debe, haber]) => ({ accountCode, accountName: `Cuenta ${accountCode}`, debe, haber, companyId: EMPRESA_PYG })) },
    },
  });

beforeAll(async () => {
  for (const [id, nif] of [[EMPRESA, 'B71000000'], [EMPRESA_PYG, 'B72000000']]) {
    await prisma.company.create({ data: { id, name: `Carmen ${id}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    await prisma.legalConfig.create({ data: { companyId: id, denominacion: `Carmen ${id}`, nif } });
  }
  const perez = await prisma.customer.create({ data: { companyId: EMPRESA, nombreFiscal: 'Construcciones Pérez SL', nifCif: 'B73000001' } });
  const ruiz = await prisma.customer.create({ data: { companyId: EMPRESA, nombreFiscal: 'Hermanos Ruiz SL', nifCif: 'B73000002' } });
  const iberdrola = await prisma.supplier.create({ data: { companyId: EMPRESA, nombreFiscal: 'Iberdrola Clientes SAU', nifCif: 'A73000003' } });
  const papeleria = await prisma.supplier.create({ data: { companyId: EMPRESA, nombreFiscal: 'Papelería Gómez SL', nifCif: 'B73000004' } });
  ids.perez = perez.id;
  ids.iberdrola = iberdrola.id;

  // Ventas: V1 (3T 2025, cobrada a mano), V2 (vencida, cobrada en parte), V3 (sin vencer) y un borrador que no cuenta.
  await venta('v1', { customerId: perez.id, serie: '2025', numero: 7, fecha: '2025-08-20', vence: '2025-09-19', base: 1000, estado: 'PAID' });
  await venta('v2', { customerId: perez.id, serie: '2026', numero: 3, fecha: '2026-08-01', vence: '2026-08-31', base: 2000 });
  await venta('v3', { customerId: ruiz.id, serie: '2026', numero: 4, fecha: '2026-09-15', vence: '2026-11-15', base: 500 });
  await venta('borrador', { customerId: ruiz.id, serie: '2026', numero: null, fecha: '2026-09-20', vence: '2026-10-20', base: 999, estadoDocumento: 'BORRADOR', estado: 'DRAFT' });
  await cobro('INGRESO', ids.v2, '2026-09-20', 420);
  // 2024 (fuera de los periodos de las demás cifras): la 2024-8 abonada entera por la rectificativa
  // R24-1 y un borrador antiguo (estado DRAFT con documento FINAL), que no es una factura emitida.
  await venta('v6', { customerId: ruiz.id, serie: '2024', numero: 8, fecha: '2024-03-01', vence: '2024-03-31', base: 1000 });
  await venta('r1', { customerId: ruiz.id, serie: 'R24', numero: 1, fecha: '2024-03-10', vence: '2024-03-10', base: -1000, facturaOriginalId: ids.v6 });
  await venta('antiguo', { customerId: ruiz.id, serie: '2024', numero: 31, fecha: '2024-05-01', vence: '2024-05-31', base: 300, estado: 'DRAFT' });

  // Compras: G1 (vencida, pagada en parte), G2 (vence esta semana) y G3 en borrador (no cuenta).
  await compra('g1', { supplierId: iberdrola.id, serie: 'IB', numero: 1, fecha: '2026-09-01', vence: '2026-09-30', base: 250, estadoPago: 'PARCIAL' });
  await compra('g2', { supplierId: papeleria.id, serie: 'PG', numero: 12, fecha: '2026-10-01', vence: '2026-10-09', base: 100 });
  await compra('g3', { supplierId: iberdrola.id, serie: 'IB', numero: 2, fecha: '2026-09-10', vence: '2026-10-10', base: 800, estado: 'DRAFT' });
  await cobro('GASTO', ids.g1, '2026-09-15', 100);

  // 303 del 2T guardado y presentado (con un cambio a mano).
  await prisma.modeloImpuesto.create({
    data: { companyId: EMPRESA, codigo: '303', ejercicio: 2026, periodo: '2T', estado: 'presentado', origen: 'manual-mixto', casillas: { '71_resultado': 250.75, '27_total_devengado': 300, '45_total_deducir': 49.25 } },
  });

  // 303 del 4T de 2024 guardado por la pantalla Modelo 303 (formato de tax-models) y presentado.
  await prisma.modeloImpuesto.create({
    data: {
      companyId: EMPRESA,
      codigo: '303',
      ejercicio: 2024,
      periodo: '4T',
      estado: 'presentado',
      origen: 'autorrelleno',
      casillas: { '01': { numero: '01', valor: 1500 }, '02': { numero: '02', valor: 315 }, '05': { numero: '05', valor: 400 }, '06': { numero: '06', valor: 84 }, '13': { numero: '13', valor: 231 } },
    },
  });

  // Banco con un movimiento (para que INT-24/25 lean algo).
  const banco = await prisma.bankAccount.create({ data: { companyId: EMPRESA, iban: 'ES7600000000000000004321', bancoNombre: 'Banco Sabadell', subcuentaCodigo: '572001', saldoInicial: 1000 } });
  await prisma.bankMovement.create({ data: { companyId: EMPRESA, cuentaBancariaId: banco.id, fecha: '2026-10-02', importe: -60.5, concepto: 'RECIBO IBERDROLA', origen: 'csv' } });

  // Contabilidad de la otra empresa: 2025 (8.000 - 3.000 - 500) y 2026 (10.000 - 4.000 - 1.000), uno futuro y un borrador.
  await asiento('2025-03-01', [['430', 8000, 0], ['700', 0, 8000]]);
  await asiento('2025-05-01', [['640', 3000, 0], ['572', 0, 3000]]);
  await asiento('2025-06-01', [['629', 500, 0], ['572', 0, 500]]);
  await asiento('2026-02-01', [['430', 10000, 0], ['700', 0, 10000]]);
  await asiento('2026-03-01', [['640', 4000, 0], ['572', 0, 4000]]);
  await asiento('2026-04-01', [['629', 1000, 0], ['572', 0, 1000]]);
  await asiento('2026-11-01', [['430', 5000, 0], ['700', 0, 5000]]);
  await asiento('2026-05-01', [['430', 777, 0], ['700', 0, 777]], 'DRAFT');
  olvidarIndices();
});

describe('cifras exactas con BD', () => {
  it('INT-06: lo que se debe a proveedores, sin borradores y menos lo pagado', async () => {
    const servicio = await pendientesSegunFacturas(EMPRESA, 'proveedores', HOY);
    expect(servicio.map((f) => [f.numeroCompleto, f.importePendiente]).sort()).toEqual([['IB-1', 202.5], ['PG-12', 121]]);

    const r = cifras(await ejecutar('INT-06'));
    expect(r.texto).toBe(
      'Debes 323,50 € a tus proveedores en 2 facturas de 2 proveedores. 1 está vencida (202,50 €). Cuenta el total a pagar de cada factura recibida (sin borradores) menos los pagos registrados hasta hoy.',
    );
    const iberdrola = cifras(await ejecutar('INT-06', { terceroId: ids.iberdrola, rol: 'proveedor' }));
    expect(iberdrola.texto).toMatch(/^Le debes 202,50 € a Iberdrola Clientes SAU en 1 factura\. Todas están vencidas\./);
    const semana = cifras(await ejecutar('INT-06', { periodo: resolverCodigoPeriodo('esta-semana', HOY)! }));
    expect(semana.kpis?.[0]).toEqual({ etiqueta: 'Vence en esta semana', valor: '121,00 €', detalle: '1 factura' });
  });

  it('INT-09: lo facturado y gastado en el 3T de 2026 frente al 3T de 2025 (resumenFiscalPeriodo)', async () => {
    const actual = await resumenFiscalPeriodo(EMPRESA, '2026-07-01', '2026-09-30');
    const anterior = await resumenFiscalPeriodo(EMPRESA, '2025-07-01', '2025-09-30');
    expect([actual.ventas.base, actual.ventas.facturas, actual.gastos.base, anterior.ventas.base]).toEqual([2500, 2, 250, 1000]);

    const r = cifras(await ejecutar('INT-09', { periodo: resolverCodigoPeriodo('2026-3T', HOY)! }));
    expect(r.texto).toBe(
      'En el 3T de 2026 has facturado 2.500,00 € en 2 facturas; en el mismo periodo de 2025, 1.000,00 € (+150,0 %). ' +
        'Has gastado 250,00 € en 1 factura; en el mismo periodo de 2025 no hay facturas. ' +
        'Cuenta las facturas emitidas y recibidas con fecha en el periodo, sin borradores ni proformas; importes sin IVA.',
    );
    expect(r.tabla?.filas.map((f) => f.celdas)).toEqual([
      ['Ventas (base imponible)', 2500, 1000],
      ['IVA repercutido', 525, 210],
      ['Gastos (base imponible)', 250, 0],
      ['IVA soportado', 52.5, 0],
    ]);
  });

  it('INT-13: busca la factura sin ceros a la izquierda y da su estado con listarCobros', async () => {
    const servicio = await listarCobros(EMPRESA, 'INGRESO', ids.v2);
    expect([servicio.totalFactura, servicio.importeCobrado, servicio.importePendiente]).toEqual([2420, 420, 2000]);
    const r = cifras(await ejecutar('INT-13', { numeroFactura: '2026-0003' }));
    expect(r.texto).toBe(
      'La factura 2026-3 emitida a Construcciones Pérez SL, del 01/08/2026, es de 2.420,00 €. Lleva 420,00 € cobrados y quedan 2.000,00 € pendientes de cobro. Venció el 31/08/2026 (hace 37 días).',
    );
    expect(r.enlaces?.[0].href).toBe(`/dashboard/facturas/${ids.v2}`);
    const aMano = cifras(await ejecutar('INT-13', { numeroFactura: '2025-07' }));
    expect(aMano.texto).toMatch(/Está cobrada\.$/);
    const compra = cifras(await ejecutar('INT-13', { numeroFactura: 'ib-01' }));
    expect(compra.texto).toMatch(/^La factura IB-1 recibida de Iberdrola Clientes SAU, del 01\/09\/2026, es de 302,50 €\. Lleva 100,00 € pagados y quedan 202,50 € pendientes de pago\./);
    // El borrador de compra IB-2 no se encuentra.
    const borrador = await ejecutar('INT-13', { numeroFactura: 'IB-2' });
    expect(!borrador.sinPermiso && borrador.sinCifras).toBe(true);
  });

  it('INT-13: una factura abonada por su rectificativa no queda pendiente; un borrador antiguo no se encuentra', async () => {
    const abonada = cifras(await ejecutar('INT-13', { numeroFactura: '2024-8' }));
    expect(abonada.texto).toBe(
      'La factura 2024-8 emitida a Hermanos Ruiz SL, del 01/03/2024, es de 1.210,00 €. No queda nada pendiente de cobro: la rectificativa R24-1 la abona.',
    );
    expect(abonada.kpis?.find((k) => k.etiqueta === 'Pendiente')?.valor).toBe('0,00 €');
    const rectificativa = cifras(await ejecutar('INT-13', { numeroFactura: 'R24-1' }));
    expect(rectificativa.texto).toMatch(/^La factura R24-1 es una rectificativa en negativo \(un abono\) de la factura 2024-8, del 10\/03\/2024, por -1\.210,00 €\./);
    const antiguo = await ejecutar('INT-13', { numeroFactura: '2024-31' });
    expect(!antiguo.sinPermiso && antiguo.sinCifras).toBe(true);
  });

  it('INT-13: una venta en dólares sale en moneda de cuenta (total − cobrado = pendiente) y con su importe en USD aparte', async () => {
    // 1.391,50 USD a 1,15 = 1.210 €; cobrados 695,75 USD = 605 €. Se borra al acabar para no tocar las demás cifras.
    const f = await prisma.incomeInvoice.create({
      data: {
        companyId: EMPRESA,
        customerId: ids.perez,
        serie: 'X',
        numero: 77,
        numeroCompleto: 'X-77',
        estadoDocumento: 'FINAL',
        fechaEmision: '2026-09-01',
        fechaVencimiento: '2026-12-01',
        estado: 'PENDING',
        moneda: 'USD',
        tipoCambio: 1.15,
        fuenteTipoCambio: 'MANUAL',
        baseTotal: 1000,
        ivaTotal: 210,
        totalFactura: 1210,
        baseTotalDoc: 1150,
        ivaTotalDoc: 241.5,
        totalFacturaDoc: 1391.5,
      },
    });
    const p = await prisma.invoicePayment.create({
      data: { companyId: EMPRESA, invoiceType: 'INGRESO', invoiceId: f.id, fecha: '2026-09-20', importe: 605, moneda: 'USD', importeDoc: 695.75, tipoCambio: 1.15, cuentaTesoreria: '570', estado: 'ACTIVO' },
    });
    try {
      const r = cifras(await ejecutar('INT-13', { numeroFactura: 'X-77' }));
      expect(r.texto).toBe(
        'La factura X-77 emitida a Construcciones Pérez SL, del 01/09/2026, es de 1.210,00 €. Lleva 605,00 € cobrados y quedan 605,00 € pendientes de cobro. Vence el 01/12/2026.',
      );
      expect(r.kpis?.map((k) => [k.etiqueta, k.valor])).toEqual([
        ['Total', '1.210,00 €'],
        ['Cobrado', '605,00 €'],
        ['Pendiente', '605,00 €'],
      ]);
      expect(r.kpis?.[0].detalle).toBe('1.391,50 USD');
      expect(r.avisos).toEqual([
        'La factura está en USD: 1.391,50 USD, con 695,75 USD cobrados y 695,75 USD pendientes. Las cifras de arriba van en la moneda de la contabilidad, al tipo de cambio de la factura.',
      ]);
      expect(r.tabla?.filas.map((x) => x.celdas[2])).toEqual([605]);
    } finally {
      await prisma.invoicePayment.delete({ where: { id: p.id } });
      await prisma.incomeInvoice.delete({ where: { id: f.id } });
    }
  });

  it('INT-18: el resultado es el de informePerdidasGanancias, hasta hoy y sin borradores', async () => {
    const servicio = await informePerdidasGanancias(EMPRESA_PYG, { desde: '2026-01-01', hasta: HOY, ejercicio: 2026 });
    expect(servicio.actual.resultadoEjercicio).toBe(5000);
    const r = cifras(await ejecutar('INT-18', {}, ['contable'], EMPRESA_PYG));
    expect(r.kpis).toEqual([
      { etiqueta: 'Cifra de negocios', valor: '10.000,00 €' },
      { etiqueta: 'Resultado', valor: '5.000,00 €', detalle: '01/01/2026 a 07/10/2026' },
      { etiqueta: 'Mismo periodo de 2025', valor: '4.500,00 €' },
    ]);
    expect(r.avisos).toEqual(['Hay 1 asiento sin aprobar con fecha en ese periodo: no cuenta hasta que lo apruebes.']);
    expect(r.tabla?.filas.map((f) => f.celdas[0])).toContain('6. Gastos de personal');
    // Sin acceso a nóminas (solo lectura): fuera los gastos de personal.
    const lectura = cifras(await ejecutar('INT-18', {}, ['solo_lectura'], EMPRESA_PYG));
    expect(lectura.tabla?.filas.map((f) => f.celdas[0])).not.toContain('6. Gastos de personal');
    expect(lectura.kpis?.[1].valor).toBe('5.000,00 €');
  });

  it('INT-28: el 303 guardado manda; si no hay, calcularModelo303 del trimestre', async () => {
    const calc = await calcularModelo303(EMPRESA, { ejercicio: 2026, periodo: '3T', tipo: 'trimestral', fechaInicio: '2026-07-01', fechaFin: '2026-09-30' });
    expect([calc.totalCuotaDevengada, calc.totalCuotaDeducible, calc.resultadoFinal]).toEqual([525, 52.5, 472.5]);
    const tercero = cifras(await ejecutar('INT-28'));
    expect(tercero.kpis?.map((k) => k.valor)).toEqual(['525,00 €', '52,50 €', '472,50 €']);
    expect(tercero.texto).toMatch(/^El 303 del 3T de 2026 sale a ingresar 472,50 €\. Todavía no lo tienes guardado en la app/);
    expect(tercero.texto).toContain('se presenta hasta el 20/10/2026 (quedan 13 días)');

    const segundo = cifras(await ejecutar('INT-28', { periodo: resolverCodigoPeriodo('2026-2T', HOY)! }));
    expect(segundo.texto).toBe(
      'El 303 del 2T de 2026 sale a ingresar 250,75 €. Es el importe del modelo guardado en Fiscalidad → Modelo 303, con cambios hechos a mano. En la app consta como presentado.',
    );
  });

  it('INT-28: lee el 303 que guarda la pantalla Modelo 303 (casillas 02 y 06) y no lo recalcula', async () => {
    const r = cifras(await ejecutar('INT-28', { periodo: resolverCodigoPeriodo('2024-4T', HOY)! }));
    expect(r.texto).toBe('El 303 del 4T de 2024 sale a ingresar 231,00 €. Es el importe del modelo guardado en Fiscalidad → Modelo 303. En la app consta como presentado.');
    expect(r.kpis?.map((k) => k.valor)).toEqual(['315,00 €', '84,00 €', '231,00 €']);
  });

  it('INT-24 e INT-39: el saldo es el saldo inicial más los movimientos (1.000 - 60,50 = 939,50)', async () => {
    const saldo = cifras(await ejecutar('INT-24'));
    expect(saldo.kpis?.[0].valor).toBe('939,50 €');
    expect(saldo.texto).toMatch(/^El saldo de Banco Sabadell …4321 es 939,50 €, según los extractos importados hasta el 02\/10\/2026\.$/);
    const resumen = cifras(await ejecutar('INT-39'));
    expect(resumen.kpis?.find((k) => k.etiqueta === 'Saldo en bancos')?.valor).toBe('939,50 €');
  });

  it('INT-30: el estado de los modelos de la empresa, sin crear las filas del calendario', async () => {
    const antes = await prisma.modeloImpuesto.count({ where: { companyId: EMPRESA } });
    const servicio = await calendarioFiscalSoloLectura(EMPRESA, HOY);
    const caducados = servicio.filter((m) => m.estado === 'expirado');
    // 2025: 4 trimestrales x 4 + 390, 347, 200 y 190 (anual de retenciones, de nominas);
    // 2026: 1T y 2T de los 4 trimestrales, menos el 303 del 2T presentado.
    expect(caducados).toHaveLength(27);
    const r = cifras(await ejecutar('INT-30'));
    expect(r.texto).toMatch(
      /^Tienes 27 modelos con el plazo ya pasado que en la app no constan como presentados ni omitidos \(el más antiguo, el 111 del 1T de 2025\)\. El próximo es el 111 \(retenciones de trabajo y profesionales\) del 3T de 2026, hasta el 20\/10\/2026 \(quedan 13 días\)\./,
    );
    expect(r.kpis?.[0]).toEqual({ etiqueta: 'Plazo pasado sin presentar', valor: '27' });
    expect(await prisma.modeloImpuesto.count({ where: { companyId: EMPRESA } })).toBe(antes);
  });
});

describe('solo lectura con BD', () => {
  it('ninguna intención escribe: ni una sentencia de escritura y el CHECKSUM de todas las tablas no cambia', async () => {
    const tablas = (await prisma.$queryRawUnsafe<Array<{ TABLE_NAME: string }>>(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'",
    )).map((t) => t.TABLE_NAME);
    const checksum = async () =>
      (await prisma.$queryRawUnsafe<Array<{ Table: string; Checksum: bigint | number | null }>>(`CHECKSUM TABLE ${tablas.map((t) => `\`${t}\``).join(', ')}`)).map(
        (f) => `${f.Table}:${String(f.Checksum)}`,
      );
    const antes = await checksum();

    // La captura sí ve las escrituras: las de los datos de prueba del beforeAll están ahí.
    expect(mockSql.some((q) => /^\s*INSERT\b/i.test(q))).toBe(true);
    mockSql.length = 0;
    const variantes: HuecosResueltos[] = [
      {},
      { periodo: resolverCodigoPeriodo('2026-3T', HOY)! },
      { periodo: resolverCodigoPeriodo('esta-semana', HOY)!, soloVencidas: true },
      { terceroId: ids.perez, rol: 'cliente' },
      { terceroId: ids.iberdrola, rol: 'proveedor' },
      { numeroFactura: '2026-3', sentido: 'pagos', foco: 'gastos' },
    ];
    let ejecutadas = 0;
    for (const i of INTENCIONES) {
      for (const h of variantes) {
        for (const [roles, empresa] of [[['admin'], EMPRESA], [['solo_lectura'], EMPRESA], [['contable'], EMPRESA_PYG]] as const) {
          await i.ejecutar(ctx([...roles], empresa), { ...h });
          ejecutadas++;
        }
      }
    }
    expect(ejecutadas).toBe(INTENCIONES.length * variantes.length * 3);
    expect(mockSql.length).toBeGreaterThan(0);
    const escrituras = mockSql.filter((q) => /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|TRUNCATE|MERGE)\b/i.test(q));
    expect(escrituras).toEqual([]);
    expect(await checksum()).toEqual(antes);
  });
});
