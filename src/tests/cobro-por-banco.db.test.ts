/**
 * Cobro por banco: la ficha de una factura emitida propone la cuenta bancaria
 * del IBAN que salio impreso (ibanCobro) y el alta rapida de una cuenta
 * bancaria (sin subcuenta, desde la ventana de cobro) le pone la siguiente 572
 * libre y la da de alta en el plan.
 *
 * Tambien: subcuentas de agrupacion y altas a la vez, la cuenta desactivada que
 * se reactiva, el cobro con una cuenta cuya subcuenta no es de bancos, el
 * cambio de subcuenta y POST /bancos/cuentas con las mismas comprobaciones.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import request from 'supertest';
import { app } from '../app';
import { prisma } from '../config/database';
import { authService } from '../services/auth.service';
import { anularCobroFactura, registrarCobroFactura } from '../services/cobrosPagos.service';
import { importarMovimientosDesdeCSV } from '../services/bancos.service';
import { conciliarMovimientoConCuenta } from '../services/conciliacionConfirmar.service';
import { resolverMedioPago } from '../services/nominas/tesoreria';
import type { CuentasNominas } from '../domain/nominas.model';
import { incomeInvoicesService } from '../services/income-invoices.service';
import { treasuryService } from '../services/treasury.service';
import { CODIGO_SUBCUENTA_POR_ELEGIR, esSubcuentaDeBanco, nombreSubcuentaBanco, siguienteSubcuenta572 } from '../services/subcuentaBanco.service';
import { HttpError } from '../utils/http-errors';
import { hashPassword } from '../utils/password';

const SUFIJO = Date.now();
const FACTURAS = `cobro-banco-fac-${SUFIJO}`;
const ALTAS = `cobro-banco-alta-${SUFIJO}`;
const PLAN_GESTORIA = `cobro-banco-plan-${SUFIJO}`;
const MANUAL = `cobro-banco-manual-${SUFIJO}`;
const A_LA_VEZ = `cobro-banco-vez-${SUFIJO}`;
const A_LA_VEZ_IBAN = `cobro-banco-vez-iban-${SUFIJO}`;
const COBROS = `cobro-banco-cobros-${SUFIJO}`;
const RUTAS = `cobro-banco-rutas-${SUFIJO}`;

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
let clienteCobros: string;

async function emitir(companyId = FACTURAS, cliente = customerId): Promise<string> {
  const f = await incomeInvoicesService.crearIngreso({
    companyId,
    customer: { id: cliente },
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
  await empresa(A_LA_VEZ);
  await empresa(A_LA_VEZ_IBAN);
  await empresa(COBROS);
  await empresa(RUTAS);
  customerId = (await prisma.customer.create({ data: { companyId: FACTURAS, nombreFiscal: 'Cliente Banco SL', nifCif: 'B20000000' } })).id;
  clienteCobros = (await prisma.customer.create({ data: { companyId: COBROS, nombreFiscal: 'Cliente Cobros SL', nifCif: 'B30000000' } })).id;
});

const errorDe = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

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

describe('subcuenta escrita: agrupaciones y altas a la vez', () => {
  it('es de bancos una 572 con cifras por debajo de las de agrupacion', () => {
    expect(['57200001', '572000', '5720001', '57201'].every(esSubcuentaDeBanco)).toBe(true);
    expect(['0001', '572', '5720', '5721', '57000001', '572A001', ''].some(esSubcuentaDeBanco)).toBe(false);
  });

  it('rechaza, junto al campo, las de agrupacion aunque esten en el plan (5720, 57200000)', async () => {
    for (const codigo of ['5720', '57200000']) {
      await prisma.chartOfAccounts.create({ data: { companyId: MANUAL, codigo, nombre: 'Bancos', grupo: 5, nivel: 4, naturaleza: 'ACTIVO', tipoUso: 'BALANCE' } });
      const e = await errorDe(treasuryService.crearCuentaBancaria(MANUAL, { iban: IBAN_C, subcuentaCodigo: codigo }));
      expect(e).toMatchObject({ statusCode: 400, details: { campo: 'subcuentaCodigo' } });
      expect((e as Error).message).toMatch(new RegExp(`La ${codigo} es la cuenta que agrupa los bancos.*por ejemplo 57200001`));
    }
    expect(await prisma.bankAccount.count({ where: { companyId: MANUAL, iban: IBAN_C } })).toBe(0);
  });

  it('dos altas a la vez con la misma subcuenta del plan: solo una se la queda', async () => {
    await prisma.chartOfAccounts.create({
      data: { companyId: A_LA_VEZ, codigo: '57200007', nombre: 'Banco de la gestoría', grupo: 5, nivel: 4, naturaleza: 'ACTIVO', tipoUso: 'BALANCE' },
    });
    const r = await Promise.allSettled([
      treasuryService.crearCuentaBancaria(A_LA_VEZ, { iban: IBAN_A, subcuentaCodigo: '57200007' }),
      treasuryService.crearCuentaBancaria(A_LA_VEZ, { iban: IBAN_B, subcuentaCodigo: '57200007' }),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const fallo = r.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(String(fallo.reason?.message)).toMatch(/57200007 ya es de otra cuenta bancaria/);
    expect(await prisma.bankAccount.count({ where: { companyId: A_LA_VEZ, subcuentaCodigo: '57200007' } })).toBe(1);
  });

  it('dos altas rapidas a la vez del mismo IBAN: una sola cuenta', async () => {
    const r = await Promise.allSettled([
      treasuryService.crearCuentaBancaria(A_LA_VEZ_IBAN, { iban: IBAN_D, bancoNombre: 'D' }),
      treasuryService.crearCuentaBancaria(A_LA_VEZ_IBAN, { iban: IBAN_D, bancoNombre: 'D' }),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(String((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason?.message)).toMatch(/Ya tienes dada de alta una cuenta con el IBAN/);
    expect(await prisma.bankAccount.count({ where: { companyId: A_LA_VEZ_IBAN } })).toBe(1);
  });

  it('el IBAN de una cuenta desactivada la reactiva con su subcuenta (no da un error sin salida)', async () => {
    const vieja = await prisma.bankAccount.create({ data: { companyId: A_LA_VEZ_IBAN, iban: IBAN_C, subcuentaCodigo: '57200009', activa: false } });
    const c = await treasuryService.crearCuentaBancaria(A_LA_VEZ_IBAN, { iban: IBAN_C.replace(/(.{4})/g, '$1 ') });
    expect(c).toMatchObject({ id: vieja.id, subcuentaCodigo: '57200009', estado: 'activa', reactivada: true });
    expect(await prisma.bankAccount.count({ where: { companyId: A_LA_VEZ_IBAN, iban: IBAN_C } })).toBe(1);
  });
});

describe('cobrar con una cuenta cuya subcuenta no es de bancos, y cambiarla', () => {
  let mala = '';

  it('no apunta el cobro en «0001»: dice que se cambie en Tesoreria (la caja sigue valiendo)', async () => {
    mala = (await prisma.bankAccount.create({ data: { companyId: COBROS, iban: IBAN_A, bancoNombre: 'BBVA', subcuentaCodigo: '0001' } })).id;
    const factura = await emitir(COBROS, clienteCobros);
    const e = await errorDe(registrarCobroFactura(COBROS, 'INGRESO', factura, { cuentaBancariaId: mala }));
    expect(e).toMatchObject({ statusCode: 400, details: { codigo: 'SUBCUENTA_BANCO_NO_VALIDA', cuentaBancariaId: mala, subcuenta: '0001' } });
    expect((e as Error).message).toMatch(/BBVA tiene como subcuenta «0001», que no es de bancos.*Tesorería > Cuentas bancarias/);
    // Sin cuenta indicada toma la primera activa: tampoco.
    await expect(registrarCobroFactura(COBROS, 'INGRESO', factura, {})).rejects.toMatchObject({ details: { codigo: 'SUBCUENTA_BANCO_NO_VALIDA' } });
    expect(await prisma.journalEntryLine.count({ where: { companyId: COBROS, accountCode: '0001' } })).toBe(0);
    const { cobro } = await registrarCobroFactura(COBROS, 'INGRESO', factura, { caja: true, importe: 1 });
    expect(cobro.cuentaTesoreria).toBe('570');
  });

  it('tampoco al conciliar un movimiento contra una cuenta ni al pagar una nomina', async () => {
    const [mov] = await importarMovimientosDesdeCSV(COBROS, mala, '2026-05-04;-90.00;Comision bancaria');
    await prisma.chartOfAccounts.upsert({
      where: { companyId_codigo: { companyId: COBROS, codigo: '555' } },
      update: { activo: true },
      create: { companyId: COBROS, codigo: '555', nombre: 'Partidas pendientes de aplicación', grupo: 5, nivel: 3, naturaleza: 'ACTIVO', tipoUso: 'BALANCE' },
    });
    const conciliar = await errorDe(conciliarMovimientoConCuenta(COBROS, mov.id));
    expect(conciliar).toMatchObject({ statusCode: 400, details: { codigo: 'SUBCUENTA_BANCO_NO_VALIDA', cuentaBancariaId: mala, subcuenta: '0001' } });
    expect((conciliar as Error).message).toMatch(/vuelve a conciliar el movimiento/);
    expect((await prisma.bankMovement.findUniqueOrThrow({ where: { id: mov.id } })).conciliado).toBe(false);

    const cuentasNominas = { caja: '570' } as CuentasNominas;
    for (const medio of [{ cuentaBancariaId: mala, fecha: '2026-05-31' }, { fecha: '2026-05-31' }, { movimientoId: mov.id }]) {
      const e = await errorDe(resolverMedioPago(COBROS, medio, cuentasNominas));
      expect(e).toMatchObject({ statusCode: 400, details: { codigo: 'SUBCUENTA_BANCO_NO_VALIDA', subcuenta: '0001' } });
      expect((e as Error).message).toMatch(/vuelve a registrar el pago/);
    }
    expect(await prisma.journalEntryLine.count({ where: { companyId: COBROS, accountCode: '0001' } })).toBe(0);
  });

  it('en la devolucion de un abono de venta el aviso habla de la devolucion, no del cobro', async () => {
    const abonoDe = async (companyId: string, cliente: string) => {
      const original = await emitir(companyId, cliente);
      return incomeInvoicesService.crearIngreso({
        companyId,
        customer: {},
        fechaEmision: '2026-05-05',
        lineas: [{ descripcion: 'Devolución', cantidad: 1, precioUnitario: -10, tipoIva: 21 }],
        rectificativa: { ticket: false, forma: 'I', motivo: 'DEVOLUCION', explicacion: 'Devolución', originales: [{ id: original }] },
      } as unknown as Parameters<typeof incomeInvoicesService.crearIngreso>[0]);
    };
    const abono = await abonoDe(COBROS, clienteCobros);
    const e = await errorDe(registrarCobroFactura(COBROS, 'INGRESO', abono.id, { cuentaBancariaId: mala }));
    expect(e).toMatchObject({ statusCode: 400, details: { codigo: 'SUBCUENTA_BANCO_NO_VALIDA' } });
    expect((e as Error).message).toMatch(/vuelve a registrar la devolución\.$/);
    // Sin ninguna cuenta bancaria.
    const SIN_BANCO = `${COBROS}-sin-banco`;
    await empresa(SIN_BANCO);
    const cliente = (await prisma.customer.create({ data: { companyId: SIN_BANCO, nombreFiscal: 'Cliente Sin Banco SL', nifCif: 'B40000000' } })).id;
    const sinBanco = await errorDe(registrarCobroFactura(SIN_BANCO, 'INGRESO', (await abonoDe(SIN_BANCO, cliente)).id, {}));
    expect((sinBanco as Error).message).toMatch(/^No hay ninguna cuenta bancaria activa para apuntar la devolución\./);
  });

  it('la lista de Tesoreria lo avisa', async () => {
    const [c] = await treasuryService.listarCuentasBancarias(COBROS);
    expect(c.avisoSubcuenta).toMatch(/«0001» no es de bancos/);
  });

  it('se cambia a una 572 (se da de alta en el plan) y entonces el cobro va a ella', async () => {
    const c = await treasuryService.cambiarSubcuentaCuentaBancaria(COBROS, mala, { subcuentaCodigo: '5720 0001' }, 'u-prueba');
    expect(c).toMatchObject({ subcuentaCodigo: '57200001', avisoSubcuenta: undefined });
    expect(await prisma.chartOfAccounts.findFirstOrThrow({ where: { companyId: COBROS, codigo: '57200001' } })).toMatchObject({ nombre: 'BBVA …1332' });
    expect(await prisma.auditLog.findFirst({ where: { companyId: COBROS, action: 'CUENTA_BANCARIA_SUBCUENTA' } })).toMatchObject({
      resourceId: mala,
      meta: { antes: '0001', despues: '57200001' },
    });
    const { cobro } = await registrarCobroFactura(COBROS, 'INGRESO', await emitir(COBROS, clienteCobros), { cuentaBancariaId: mala });
    expect(cobro.cuentaTesoreria).toBe('57200001');
  });

  it('no deja cambiarla si la de antes tiene saldo; anulados los cobros, si', async () => {
    const factura = await emitir(COBROS, clienteCobros);
    const { cobro } = await registrarCobroFactura(COBROS, 'INGRESO', factura, { cuentaBancariaId: mala });
    const e = await errorDe(treasuryService.cambiarSubcuentaCuentaBancaria(COBROS, mala, { subcuentaCodigo: '57200002' }));
    expect(e).toMatchObject({ statusCode: 409, details: { codigo: 'SUBCUENTA_BANCO_CON_SALDO', subcuenta: '57200001', saldo: 242 } });
    expect((e as Error).message).toMatch(/57200001 ya tiene apuntes de este banco con saldo \(242,00 €\)/);
    // Anula los dos cobros a la 57200001: queda sin saldo y ya se puede cambiar.
    const cobrados = await prisma.invoicePayment.findMany({ where: { companyId: COBROS, cuentaTesoreria: '57200001', estado: 'ACTIVO' } });
    for (const p of cobrados) await anularCobroFactura(COBROS, 'INGRESO', p.invoiceId, p.id);
    expect(cobrados.map((p) => p.id)).toContain(cobro.id);
    expect((await treasuryService.cambiarSubcuentaCuentaBancaria(COBROS, mala, { subcuentaCodigo: '57200002' })).subcuentaCodigo).toBe('57200002');
  });

  it('la nueva se comprueba como en el alta (formato y de otra cuenta)', async () => {
    const otra = await prisma.bankAccount.create({ data: { companyId: COBROS, iban: IBAN_B, subcuentaCodigo: '57200003' } });
    const formato = await errorDe(treasuryService.cambiarSubcuentaCuentaBancaria(COBROS, mala, { subcuentaCodigo: '0002' }));
    expect(formato).toMatchObject({ statusCode: 400, details: { campo: 'subcuentaCodigo' } });
    const usada = await errorDe(treasuryService.cambiarSubcuentaCuentaBancaria(COBROS, mala, { subcuentaCodigo: '57200003' }));
    expect((usada as Error).message).toMatch(/ya es de otra cuenta bancaria \(IBAN acabado en 7892\)/);
    // La suya, tal cual: no cambia nada.
    expect((await treasuryService.cambiarSubcuentaCuentaBancaria(COBROS, otra.id, { subcuentaCodigo: '57200003' })).subcuentaCodigo).toBe('57200003');
  });

  it('una 572 que no esta en el plan se da de alta al cobrar', async () => {
    const sinPlan = await prisma.bankAccount.create({ data: { companyId: COBROS, iban: IBAN_C, bancoNombre: 'Sabadell', subcuentaCodigo: '57200008' } });
    const { cobro } = await registrarCobroFactura(COBROS, 'INGRESO', await emitir(COBROS, clienteCobros), { cuentaBancariaId: sinPlan.id });
    expect(cobro.cuentaTesoreria).toBe('57200008');
    expect(await prisma.chartOfAccounts.findFirstOrThrow({ where: { companyId: COBROS, codigo: '57200008' } })).toMatchObject({ nombre: 'Sabadell …4567' });
  });
});

describe('rutas: POST /bancos/cuentas y PUT .../subcuenta', () => {
  const EMAIL = `cobro-banco-${SUFIJO}@test.local`;
  let token = '';
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { email: EMAIL, passwordHash: hashPassword(`x-${SUFIJO}-clave-larga`) } });
    await prisma.membership.create({ data: { userId: u.id, companyId: RUTAS, role: 'admin' } });
    token = authService.generateToken({ userId: u.id, email: EMAIL, roles: [], companies: [] });
  });

  it('POST /bancos/cuentas comprueba el IBAN y pone la 572 como Tesoreria', async () => {
    const mal = await request(app).post(`/companies/${RUTAS}/bancos/cuentas`).set('Authorization', `Bearer ${token}`).send({ iban: 'ES00', subcuentaCodigo: '0001' });
    expect(mal.status).toBe(400);
    const bien = await request(app).post(`/companies/${RUTAS}/bancos/cuentas`).set('Authorization', `Bearer ${token}`).send({ iban: IBAN_A, bancoNombre: 'BBVA' });
    expect(bien.status).toBe(201);
    expect(bien.body.data).toMatchObject({ iban: IBAN_A, subcuentaCodigo: '57200001', estado: 'activa' });
    const repetido = await request(app).post(`/companies/${RUTAS}/bancos/cuentas`).set('Authorization', `Bearer ${token}`).send({ iban: IBAN_A, subcuentaCodigo: '57200002' });
    expect(repetido.status).toBe(400);
  });

  it('PUT /treasury/bank-accounts/:id/subcuenta la cambia', async () => {
    const c = await prisma.bankAccount.findFirstOrThrow({ where: { companyId: RUTAS, iban: IBAN_A } });
    const r = await request(app)
      .put(`/companies/${RUTAS}/treasury/bank-accounts/${c.id}/subcuenta`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subcuentaCodigo: '57200005' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ id: c.id, subcuentaCodigo: '57200005' });
    const ajena = await request(app)
      .put(`/companies/${RUTAS}/treasury/bank-accounts/no-existe/subcuenta`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subcuentaCodigo: '57200006' });
    expect(ajena.status).toBe(404);
  });
});
