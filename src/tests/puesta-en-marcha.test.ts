/**
 * Puesta en marcha y cierre sobre BD real: importar un balance genera un
 * asiento de apertura cuadrado (y no se puede duplicar), el diario importado se
 * graba por asientos, y el cierre crea regularizacion, cierre y apertura del
 * siguiente una sola vez; deshacerlo deja el ejercicio abierto otra vez.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { leerBalance, leerDiario } from '../services/puestaEnMarcha/lectorContable';
import {
  confirmarApertura,
  confirmarComparativo,
  confirmarDiario,
  previsualizarApertura,
  saldosComparativosImportados,
} from '../services/puestaEnMarcha/puestaEnMarcha.service';
import { deshacerCierreEjercicio, ejecutarCierreEjercicio, previsualizarCierre } from '../services/cierreEjercicio.service';
import { calcularEstadosFinancieros } from '../services/impuestoSociedadesCalculo.service';

const COMPANY_ID = `apertura-test-${Date.now()}`;

// Balance de sumas y saldos a 31/12/2025 de "otro programa", con 6/7 sin regularizar.
const BALANCE_CSV = [
  'Cuenta;Descripción;Saldo deudor;Saldo acreedor',
  '1000000000;Capital social;;3.000,00',
  '4300000001;Cliente Uno SL;1.210,00;',
  '4000000099;Proveedor nuevo SL;;500,00',
  '5720000001;Banco Demo;4.290,00;',
  '6000000000;Compras de mercaderías;1.000,00;',
  '7000000000;Ventas de mercaderías;;3.000,00',
].join('\n');

const DIARIO_CSV = [
  'Fecha;Asiento;Cuenta;Concepto;Debe;Haber',
  '01/01/2026;1;5720000001;Asiento de apertura;4.290,00;',
  '01/01/2026;1;1000000000;Asiento de apertura;;4.290,00',
  '15/01/2026;2;4300000001;Factura 1;242,00;',
  '15/01/2026;2;7000000000;Factura 1;;200,00',
  '15/01/2026;2;4770000000;Factura 1;;42,00',
  '20/01/2026;3;6000000000;Compra;150,00;',
  '20/01/2026;3;5720000001;Compra;;150,00',
].join('\n');

const balance = () => ({ lectura: leerBalance(Buffer.from(BALANCE_CSV, 'utf8'), 'balance.csv') });

beforeAll(async () => {
  await prisma.company.create({
    data: { id: COMPANY_ID, name: 'Apertura Test SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'test-key' },
  });
  // Sin cuentas bancarias que cuadrar.
  await prisma.companyCierreConfig.create({ data: { companyId: COMPANY_ID, exigirCuadreBancos: false, toleranciaCuadre: 0.01 } });
});

describe('Asiento de apertura desde un balance importado', () => {
  it('la vista previa cuadra, lleva el resultado a la 129 y detecta las cuentas nuevas', async () => {
    const v = await previsualizarApertura(COMPANY_ID, balance(), { ejercicio: 2026 });
    expect(v.fecha).toBe('2026-01-01');
    expect(v.totales.cuadra).toBe(true);
    expect(v.pyg.resultado).toBe(2000);
    expect(v.pyg.cuentaResultado).toBe('1290000000');
    expect(v.asiento.lineas.find((l) => l.cuenta === '1290000000')).toMatchObject({ debe: 0, haber: 2000 });
    expect(v.asiento.lineas.some((l) => l.cuenta.startsWith('6') || l.cuenta.startsWith('7'))).toBe(false);
    expect(v.asiento.debe).toBe(5500);
    expect(v.asiento.haber).toBe(5500);
    expect(v.cuentasNuevas.map((c) => c.codigo)).toEqual(expect.arrayContaining(['4000000099', '5720000001']));
    expect(v.puedeConfirmar).toBe(true);
  });

  it('al confirmar graba el asiento POSTED, crea las subcuentas y guarda el comparativo', async () => {
    const r = await confirmarApertura(COMPANY_ID, balance(), { ejercicio: 2026, guardarComparativo: true });
    expect(r.asiento.numero).toBe('APERT-00001');
    const asiento = await prisma.journalEntry.findUnique({ where: { id: r.asiento.id }, include: { lineas: true } });
    expect(asiento?.origen).toBe('APERTURA');
    expect(asiento?.estado).toBe('POSTED');
    const debe = asiento!.lineas.reduce((s, l) => s + Number(l.debe), 0);
    const haber = asiento!.lineas.reduce((s, l) => s + Number(l.haber), 0);
    expect(Math.round(debe * 100)).toBe(Math.round(haber * 100));

    const sub = await prisma.chartOfAccounts.findFirst({ where: { companyId: COMPANY_ID, codigo: '4000000099' } });
    expect(sub?.parentCodigo).toBe('400');
    expect(sub?.nombre).toBe('Proveedor nuevo SL');

    const fy = await prisma.fiscalYear.findFirst({ where: { companyId: COMPANY_ID, label: '2026' } });
    expect(fy?.estado).toBe('OPEN');

    const comp = await saldosComparativosImportados(COMPANY_ID, 2025);
    expect(comp?.pyg.get('7000000000')).toBe(-3000);
  });

  it('no deja crear una segunda apertura del mismo ejercicio sin reemplazar', async () => {
    await expect(confirmarApertura(COMPANY_ID, balance(), { ejercicio: 2026 })).rejects.toThrow(/Ya hay un asiento de apertura/);
    const r = await confirmarApertura(COMPANY_ID, balance(), { ejercicio: 2026, reemplazar: true });
    expect(r.anulados).toBe(1);
    expect(r.asiento.numero).toBe('APERT-00002');
    const vivas = await prisma.journalEntry.count({ where: { companyId: COMPANY_ID, origen: 'APERTURA', estado: 'POSTED' } });
    expect(vivas).toBe(1);
  });

  it('la columna N-1 de los estados sale del comparativo importado', async () => {
    const e = await calcularEstadosFinancieros(COMPANY_ID, 2026);
    expect(e.anterior.pyg.resultadoEjercicio).toBe(2000);
  });
});

describe('Diario importado del ejercicio en curso', () => {
  it('omite la apertura del fichero, graba los asientos y no duplica', async () => {
    const lectura = () => leerDiario(Buffer.from(DIARIO_CSV, 'utf8'), 'diario.csv');
    const r = await confirmarDiario(COMPANY_ID, lectura(), {});
    expect(r.vista.excluidos).toHaveLength(1);
    expect(r.asientosCreados).toBe(2);
    await expect(confirmarDiario(COMPANY_ID, lectura(), {})).rejects.toThrow(/Ya se importaron|Ya hay asientos importados/);
    const r2 = await confirmarDiario(COMPANY_ID, lectura(), { reemplazar: true });
    expect(r2.anulados).toBe(2);
    expect(await prisma.journalEntry.count({ where: { companyId: COMPANY_ID, origen: 'IMPORTACION', estado: 'POSTED' } })).toBe(2);
  });
});

describe('Comparativo de un ejercicio anterior', () => {
  it('guarda balance y PyG sin crear asientos', async () => {
    const antes = await prisma.journalEntry.count({ where: { companyId: COMPANY_ID } });
    const v = await confirmarComparativo(COMPANY_ID, balance(), { ejercicio: 2024, parte: 'pyg' });
    expect(v.resumen.resultado).toBe(2000);
    expect(await prisma.journalEntry.count({ where: { companyId: COMPANY_ID } })).toBe(antes);
    const s = await saldosComparativosImportados(COMPANY_ID, 2024);
    expect(s?.balance.size).toBe(0);
    expect(s?.pyg.size).toBe(2);
  });
});

describe('Cierre del ejercicio y traspaso de saldos', () => {
  it('crea regularizacion, cierre y apertura del siguiente, y cierra el ejercicio', async () => {
    const v = await previsualizarCierre(COMPANY_ID, 2026);
    expect(v.estado).toBe('ABIERTO');
    expect(v.resultado).toBe(50); // ventas 200 - compras 150
    expect(v.asientos.map((a) => a.tipo)).toEqual(['REGULARIZACION', 'CIERRE', 'APERTURA']);
    expect(v.puedeCerrar).toBe(true);

    const r = await ejecutarCierreEjercicio(COMPANY_ID, 2026);
    expect(r.resultadoEjercicio).toBe(50);
    expect(Object.keys(r.numeros)).toEqual(['REGULARIZACION', 'CIERRE', 'APERTURA']);

    const creados = await prisma.journalEntry.findMany({
      where: { companyId: COMPANY_ID, estado: 'POSTED', origen: { in: ['REGULARIZACION', 'CIERRE', 'APERTURA'] } },
      include: { lineas: true },
    });
    const del2027 = creados.filter((a) => a.fecha.getUTCFullYear() === 2027);
    expect(del2027).toHaveLength(1);
    expect(del2027[0].origen).toBe('APERTURA');
    for (const a of creados) {
      const d = a.lineas.reduce((s, l) => s + Number(l.debe), 0);
      const h = a.lineas.reduce((s, l) => s + Number(l.haber), 0);
      expect(Math.round(d * 100)).toBe(Math.round(h * 100));
    }
    // 129: resultado anterior (2000) + el del ejercicio (50), acreedor.
    const l129 = del2027[0].lineas.filter((l) => l.accountCode === '1290000000');
    expect(l129.reduce((s, l) => s + Number(l.haber) - Number(l.debe), 0)).toBe(2050);

    const fy = await prisma.fiscalYear.findFirst({ where: { companyId: COMPANY_ID, label: '2026' } });
    expect(fy?.estado).toBe('CLOSED');
    expect(await prisma.fiscalYear.count({ where: { companyId: COMPANY_ID, label: '2027' } })).toBe(1);
    const abiertos = await prisma.periodo.count({ where: { companyId: COMPANY_ID, ejercicio: 2026, estado: 'abierto' } });
    expect(abiertos).toBe(0);
  });

  it('una segunda ejecucion se rechaza sin crear asientos', async () => {
    const antes = await prisma.journalEntry.count({ where: { companyId: COMPANY_ID } });
    await expect(ejecutarCierreEjercicio(COMPANY_ID, 2026)).rejects.toThrow(/ya está cerrado/);
    expect(await prisma.journalEntry.count({ where: { companyId: COMPANY_ID } })).toBe(antes);
  });

  it('se puede deshacer mientras el siguiente solo tenga la apertura, y volver a cerrar', async () => {
    const d = await deshacerCierreEjercicio(COMPANY_ID, 2026);
    expect(d.anulados).toBe(3);
    const fy = await prisma.fiscalYear.findFirst({ where: { companyId: COMPANY_ID, label: '2026' } });
    expect(fy?.estado).toBe('OPEN');

    const r = await ejecutarCierreEjercicio(COMPANY_ID, 2026);
    expect(r.numeros.CIERRE).toBe('CIERRE-00002');

    // Con un asiento normal en 2027 ya no se puede deshacer.
    await prisma.journalEntry.create({
      data: {
        companyId: COMPANY_ID,
        fecha: new Date('2027-02-01T00:00:00Z'),
        numeroAsiento: 'AJUSTE-T1',
        descripcion: 'Movimiento 2027',
        origen: 'AJUSTE_MANUAL',
        estado: 'POSTED',
        lineas: {
          create: [
            { accountCode: '5720000001', accountName: 'Banco', debe: 10, haber: 0, companyId: COMPANY_ID },
            { accountCode: '4300000001', accountName: 'Cliente', debe: 0, haber: 10, companyId: COMPANY_ID },
          ],
        },
      },
    });
    const v = await previsualizarCierre(COMPANY_ID, 2026);
    expect(v.puedeDeshacer).toBe(false);
    await expect(deshacerCierreEjercicio(COMPANY_ID, 2026)).rejects.toThrow(/además de la apertura/);
  });
});
