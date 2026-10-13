/**
 * Cobro por banco: la ficha de una factura emitida propone la cuenta bancaria
 * del IBAN que salio impreso (ibanCobro) y el alta rapida de una cuenta
 * bancaria (sin subcuenta, desde la ventana de cobro) le pone la siguiente 572
 * libre y la da de alta en el plan.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { incomeInvoicesService } from '../services/income-invoices.service';
import { treasuryService } from '../services/treasury.service';
import { CODIGO_SUBCUENTA_POR_ELEGIR, nombreSubcuentaBanco, siguienteSubcuenta572 } from '../services/subcuentaBanco.service';
import { HttpError } from '../utils/http-errors';

const SUFIJO = Date.now();
const FACTURAS = `cobro-banco-fac-${SUFIJO}`;
const ALTAS = `cobro-banco-alta-${SUFIJO}`;
const PLAN_GESTORIA = `cobro-banco-plan-${SUFIJO}`;
const MANUAL = `cobro-banco-manual-${SUFIJO}`;

// IBAN validos (digitos de control correctos).
const IBAN_A = 'ES9121000418450200051332';
const IBAN_B = 'ES6000491500051234567892';
const IBAN_C = 'ES1001822370420201234567';
const IBAN_D = 'ES5021007777440200099911';

async function empresa(id: string) {
  await prisma.company.create({ data: { id, name: `Empresa ${id}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: id, denominacion: `Empresa ${id}`, nif: 'B10000000' } });
}

let customerId: string;

async function emitir(): Promise<string> {
  const f = await incomeInvoicesService.crearIngreso({
    companyId: FACTURAS,
    customer: { id: customerId },
    fechaEmision: '2026-05-04',
    fechaVencimiento: '2099-12-31',
    lineas: [{ descripcion: 'Servicio', cantidad: 1, precioUnitario: 100, tipoIva: 21 }],
  });
  return f.id;
}

beforeAll(async () => {
  await empresa(FACTURAS);
  await empresa(ALTAS);
  await empresa(PLAN_GESTORIA);
  await empresa(MANUAL);
  customerId = (await prisma.customer.create({ data: { companyId: FACTURAS, nombreFiscal: 'Cliente Banco SL', nifCif: 'B20000000' } })).id;
});

describe('siguienteSubcuenta572', () => {
  it('toma la mayor de esa longitud + 1 y no cuenta la 572 ni otras longitudes', () => {
    expect(siguienteSubcuenta572([], 8)).toBe('57200001');
    expect(siguienteSubcuenta572(['572', '57200000', '57200003', '5720009', '57000001'], 8)).toBe('57200004');
    expect(siguienteSubcuenta572(['5720000007'], 10)).toBe('5720000008');
  });

  it('el nombre lleva el banco y las cuatro ultimas cifras del IBAN', () => {
    expect(nombreSubcuentaBanco('BBVA', IBAN_A)).toBe('BBVA …1332');
    expect(nombreSubcuentaBanco('  ', IBAN_A)).toBe('Banco …1332');
  });
});

describe('ficha de una factura emitida: cuenta propuesta para cobrarla', () => {
  it('sin cuentas bancarias no propone ninguna (y el IBAN impreso queda vacio)', async () => {
    const r = await incomeInvoicesService.obtenerPorId(FACTURAS, await emitir());
    expect(r.formaPago).toBe('TRANSFERENCIA');
    expect(r.ibanCobro).toBe('');
    expect(r.cuentaBancariaCobroId).toBeNull();
  });

  it('propone la cuenta del IBAN impreso aunque despues cambien los ajustes', async () => {
    const a = await prisma.bankAccount.create({ data: { companyId: FACTURAS, iban: IBAN_A, bancoNombre: 'A', subcuentaCodigo: '57200001' } });
    const b = await prisma.bankAccount.create({ data: { companyId: FACTURAS, iban: IBAN_B, bancoNombre: 'B', subcuentaCodigo: '57200002' } });
    // La que sale en las facturas es la B.
    await prisma.ajustesFacturacion.create({ data: { companyId: FACTURAS, cuentaBancariaId: b.id } });
    const id = await emitir();
    expect((await incomeInvoicesService.obtenerPorId(FACTURAS, id)).ibanCobro).toBe(IBAN_B);

    await prisma.ajustesFacturacion.update({ where: { companyId: FACTURAS }, data: { cuentaBancariaId: a.id } });
    expect((await incomeInvoicesService.obtenerPorId(FACTURAS, id)).cuentaBancariaCobroId).toBe(b.id);

    // Cuenta del IBAN impreso desactivada: la de los ajustes.
    await prisma.bankAccount.update({ where: { id: b.id }, data: { activa: false } });
    expect((await incomeInvoicesService.obtenerPorId(FACTURAS, id)).cuentaBancariaCobroId).toBe(a.id);
    await prisma.bankAccount.update({ where: { id: b.id }, data: { activa: true } });
  });

  it('factura anterior a la copia del IBAN (null) o emitida sin IBAN: la de los ajustes', async () => {
    const a = await prisma.bankAccount.findFirstOrThrow({ where: { companyId: FACTURAS, iban: IBAN_A } });
    const id = await emitir();
    await prisma.incomeInvoice.update({ where: { id }, data: { ibanCobro: null } });
    expect((await incomeInvoicesService.obtenerPorId(FACTURAS, id)).cuentaBancariaCobroId).toBe(a.id);
    await prisma.incomeInvoice.update({ where: { id }, data: { ibanCobro: '' } });
    expect((await incomeInvoicesService.obtenerPorId(FACTURAS, id)).cuentaBancariaCobroId).toBe(a.id);
  });

  it('el IBAN impreso se reconoce aunque lleve espacios', async () => {
    const b = await prisma.bankAccount.findFirstOrThrow({ where: { companyId: FACTURAS, iban: IBAN_B } });
    const id = await emitir();
    await prisma.incomeInvoice.update({ where: { id }, data: { ibanCobro: IBAN_B.replace(/(.{4})/g, '$1 ').trim() } });
    expect((await incomeInvoicesService.obtenerPorId(FACTURAS, id)).cuentaBancariaCobroId).toBe(b.id);
  });
});

describe('alta rapida de una cuenta bancaria (sin subcuenta)', () => {
  it('le pone la siguiente 572 libre y la da de alta en el plan con el nombre del banco', async () => {
    await prisma.chartOfAccounts.create({
      data: { companyId: ALTAS, codigo: '572', nombre: 'Bancos', grupo: 5, nivel: 3, naturaleza: 'ACTIVO', tipoUso: 'BALANCE' },
    });
    const c = await treasuryService.crearCuentaBancaria(ALTAS, { iban: 'es91 2100 0418 4502 0005 1332', bancoNombre: ' BBVA ' });
    expect(c).toMatchObject({ iban: IBAN_A, bancoNombre: 'BBVA', subcuentaCodigo: '57200001', estado: 'activa' });
    const plan = await prisma.chartOfAccounts.findFirstOrThrow({ where: { companyId: ALTAS, codigo: '57200001' } });
    expect(plan).toMatchObject({ nombre: 'BBVA …1332', grupo: 5, nivel: 4, naturaleza: 'ACTIVO', parentCodigo: '572', esPersonalizadaEmpresa: true });

    const otra = await treasuryService.crearCuentaBancaria(ALTAS, { iban: IBAN_B });
    expect(otra.subcuentaCodigo).toBe('57200002');
  });

  it('dos altas a la vez no se llevan la misma subcuenta', async () => {
    const [x, y] = await Promise.all([
      treasuryService.crearCuentaBancaria(ALTAS, { iban: IBAN_C, bancoNombre: 'C' }),
      treasuryService.crearCuentaBancaria(ALTAS, { iban: IBAN_D, bancoNombre: 'D' }),
    ]);
    expect([x.subcuentaCodigo, y.subcuentaCodigo].sort()).toEqual(['57200003', '57200004']);
  });

  it('sin subcuenta, un IBAN mal escrito no se guarda', async () => {
    await expect(treasuryService.crearCuentaBancaria(ALTAS, { iban: 'ES9121000418450200051333' })).rejects.toThrow(/IBAN no es válido/);
  });

  it('si el plan trae subcuentas de bancos sin cuenta bancaria, pide elegirla en Tesoreria (409)', async () => {
    await prisma.chartOfAccounts.create({
      data: { companyId: PLAN_GESTORIA, codigo: '57200005', nombre: 'Banco Sabadell', grupo: 5, nivel: 4, naturaleza: 'ACTIVO', tipoUso: 'BALANCE' },
    });
    const error = await treasuryService.crearCuentaBancaria(PLAN_GESTORIA, { iban: IBAN_A, bancoNombre: 'Sabadell' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ statusCode: 409, details: { codigo: CODIGO_SUBCUENTA_POR_ELEGIR, subcuentas: ['57200005'] } });
    expect((error as Error).message).toMatch(/57200005 Banco Sabadell.*Tesorería > Cuentas bancarias/);
    expect(await prisma.bankAccount.count({ where: { companyId: PLAN_GESTORIA } })).toBe(0);
  });
});

describe('alta en Tesoreria con la subcuenta propuesta o escrita', () => {
  const errorDe = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

  it('propone la siguiente 572 libre y enseña las del plan que aun no tienen cuenta', async () => {
    expect(await treasuryService.subcuentaPropuesta(MANUAL)).toEqual({ subcuentaCodigo: '57200001', longitud: 8, sinCuenta: [] });
    expect(await treasuryService.subcuentaPropuesta(PLAN_GESTORIA)).toEqual({
      subcuentaCodigo: '57200006',
      longitud: 8,
      sinCuenta: [{ codigo: '57200005', nombre: 'Banco Sabadell' }],
    });
  });

  it('la propuesta, tal cual: se da de alta en el plan con el nombre del banco', async () => {
    const c = await treasuryService.crearCuentaBancaria(MANUAL, { iban: IBAN_A, bancoNombre: 'BBVA', subcuentaCodigo: '57200001', saldoInicial: 1234.567 });
    expect(c).toMatchObject({ subcuentaCodigo: '57200001', saldoInicial: 1234.57 });
    expect(await prisma.chartOfAccounts.findFirstOrThrow({ where: { companyId: MANUAL, codigo: '57200001' } })).toMatchObject({ nombre: 'BBVA …1332' });
    expect((await treasuryService.subcuentaPropuesta(MANUAL)).subcuentaCodigo).toBe('57200002');
  });

  it('una que ya esta en el plan (la de la gestoria) se usa sin tocar el plan', async () => {
    const c = await treasuryService.crearCuentaBancaria(PLAN_GESTORIA, { iban: IBAN_B, bancoNombre: 'Sabadell', subcuentaCodigo: '57200005' });
    expect(c.subcuentaCodigo).toBe('57200005');
    expect(await prisma.chartOfAccounts.count({ where: { companyId: PLAN_GESTORIA, codigo: { startsWith: '572' } } })).toBe(1);
    expect((await treasuryService.subcuentaPropuesta(PLAN_GESTORIA)).sinCuenta).toEqual([]);
  });

  it('rechaza, junto al campo, una que no es 572, otra longitud o la de otra cuenta', async () => {
    const enCampo = (campo: string) => ({ statusCode: 400, details: { campo } });
    const formato = await errorDe(treasuryService.crearCuentaBancaria(MANUAL, { iban: IBAN_B, subcuentaCodigo: '0001' }));
    expect(formato).toMatchObject(enCampo('subcuentaCodigo'));
    expect((formato as Error).message).toMatch(/empieza por 572/);
    const longitud = await errorDe(treasuryService.crearCuentaBancaria(MANUAL, { iban: IBAN_B, subcuentaCodigo: '5720002' }));
    expect(longitud).toMatchObject(enCampo('subcuentaCodigo'));
    expect((longitud as Error).message).toMatch(/tienen 8 cifras.*57200001/);
    const usada = await errorDe(treasuryService.crearCuentaBancaria(MANUAL, { iban: IBAN_B, subcuentaCodigo: '57200001' }));
    expect(usada).toMatchObject(enCampo('subcuentaCodigo'));
    expect((usada as Error).message).toMatch(/ya es de otra cuenta bancaria \(IBAN acabado en 1332\)/);
    expect(await prisma.bankAccount.count({ where: { companyId: MANUAL } })).toBe(1);
  });

  it('rechaza, junto al campo, un IBAN mal escrito o repetido aunque lleve subcuenta', async () => {
    const mal = await errorDe(treasuryService.crearCuentaBancaria(MANUAL, { iban: 'ES9121000418450200051333', subcuentaCodigo: '57200002' }));
    expect(mal).toMatchObject({ statusCode: 400, details: { campo: 'iban' } });
    const sinPais = await errorDe(treasuryService.crearCuentaBancaria(MANUAL, { iban: '21000418450200051332', subcuentaCodigo: '57200002' }));
    expect((sinPais as Error).message).toMatch(/empezando por las letras del país/);
    const repetido = await errorDe(treasuryService.crearCuentaBancaria(MANUAL, { iban: IBAN_A.replace(/(.{4})/g, '$1 '), subcuentaCodigo: '57200002' }));
    expect(repetido).toMatchObject({ statusCode: 400, details: { campo: 'iban' } });
    expect(await prisma.chartOfAccounts.count({ where: { companyId: MANUAL, codigo: '57200002' } })).toBe(0);
  });
});
