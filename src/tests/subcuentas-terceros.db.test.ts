/**
 * Servicio de subcuentas de tercero sobre BD real: asignacion al dar de alta,
 * concurrencia, alta en el plan con el nombre fiscal, longitud por empresa,
 * mismo numero en la 400 y la 410, renombrado y retirada al borrar.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { asegurarPlanContableEmpresa } from '../services/chart-of-accounts.service';
import {
  asegurarSubcuentaEnPlan,
  crearClienteConSubcuenta,
  crearProveedorConSubcuenta,
  fichaDeSubcuenta,
  longitudSubcuentasEmpresa,
  retirarSubcuentasDeFicha,
  sincronizarNombreSubcuentas,
  subcuentaClienteParaApunte,
  subcuentaProveedorParaApunte,
} from '../services/terceros/subcuentas';

const SUFIJO = Date.now();
const EMPRESA = `subc-${SUFIJO}`;
const EMPRESA_10 = `subc10-${SUFIJO}`;
const EMPRESA_7 = `subc7-${SUFIJO}`;
const EMPRESA_FIJA = `subcfija-${SUFIJO}`;
const EMPRESA_4009 = `subc4009-${SUFIJO}`;

/** Cuenta de un plan traido (apertura, diario o plan anterior) colgando de `madre`. */
async function cuentaImportada(companyId: string, codigo: string, madre: string, nombre = `Importada ${codigo}`) {
  await prisma.chartOfAccounts.create({
    data: { companyId, codigo, nombre, grupo: 4, nivel: 4, naturaleza: codigo.startsWith('43') ? 'ACTIVO' : 'PASIVO', tipoUso: 'BALANCE', esBasePGC: false, esPersonalizadaEmpresa: true, parentCodigo: madre },
  });
}

async function crearEmpresa(id: string) {
  await prisma.company.create({ data: { id, name: `Empresa ${id}`, fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
  await asegurarPlanContableEmpresa(id);
}

beforeAll(async () => {
  await crearEmpresa(EMPRESA);
  await crearEmpresa(EMPRESA_10);
  await crearEmpresa(EMPRESA_7);
  await crearEmpresa(EMPRESA_FIJA);
  await crearEmpresa(EMPRESA_4009);
});

describe('alta de fichas', () => {
  it('cliente nuevo: 43000001 en la ficha, todavia no en el plan', async () => {
    const c = await crearClienteConSubcuenta({ companyId: EMPRESA, nombreFiscal: 'Primero SL', nifCif: 'B11111111' });
    expect(c.subcuenta430).toBe('43000001');
    expect(await prisma.chartOfAccounts.count({ where: { companyId: EMPRESA, codigo: '43000001' } })).toBe(0);
    const c2 = await crearClienteConSubcuenta({ companyId: EMPRESA, nombreFiscal: 'Segundo SL', nifCif: 'B22222222' });
    expect(c2.subcuenta430).toBe('43000002');
  });

  it('altas a la vez: codigos distintos (reintento ante el indice unico)', async () => {
    const altas = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => crearClienteConSubcuenta({ companyId: EMPRESA, nombreFiscal: `Concurrente ${i}`, nifCif: `C0000000${i}` })),
    );
    const codigos = altas.map((a) => a.subcuenta430);
    expect(new Set(codigos).size).toBe(5);
    expect([...codigos].sort()).toEqual(['43000003', '43000004', '43000005', '43000006', '43000007']);
  });

  it('proveedor nuevo: el mismo numero en la 400 y en la 410; numeracion aparte de los clientes', async () => {
    const p = await crearProveedorConSubcuenta({ companyId: EMPRESA, nombreFiscal: 'Proveedor Uno SL', nifCif: 'B33333333' });
    expect(p).toMatchObject({ subcuenta400: '40000001', subcuenta410: '41000001' });
    // Un 410 suelto en el plan ocupa ese numero tambien para la 400.
    await prisma.chartOfAccounts.create({
      data: { companyId: EMPRESA, codigo: '41000002', nombre: 'Acreedor importado', grupo: 4, nivel: 4, naturaleza: 'PASIVO', tipoUso: 'BALANCE', esBasePGC: false, esPersonalizadaEmpresa: true, parentCodigo: '410' },
    });
    const p2 = await crearProveedorConSubcuenta({ companyId: EMPRESA, nombreFiscal: 'Proveedor Dos SL', nifCif: 'B44444444' });
    expect(p2).toMatchObject({ subcuenta400: '40000003', subcuenta410: '41000003' });
  });
});

describe('al contabilizar', () => {
  it('ficha antigua sin subcuenta: se asigna y se da de alta en el plan con el nombre fiscal', async () => {
    const viejo = await prisma.customer.create({ data: { companyId: EMPRESA, nombreFiscal: 'Cliente Antiguo SA', nifCif: 'A55555555' } });
    const r = await prisma.$transaction((tx) => subcuentaClienteParaApunte(tx, EMPRESA, viejo.id));
    expect(r).toEqual({ codigo: '43000008', nombre: 'Cliente Antiguo SA' });
    const cuenta = await prisma.chartOfAccounts.findFirstOrThrow({ where: { companyId: EMPRESA, codigo: '43000008' } });
    const padre = await prisma.chartOfAccounts.findFirstOrThrow({ where: { companyId: EMPRESA, codigo: '430' } });
    expect(cuenta).toMatchObject({ nombre: 'Cliente Antiguo SA', grupo: 4, nivel: padre.nivel + 1, parentCodigo: '430', parentId: padre.id, naturaleza: padre.naturaleza, esBasePGC: false, esPersonalizadaEmpresa: true, activo: true });
    expect(cuenta.notas).toContain(viejo.id);
    // Segunda vez: la misma, sin duplicar.
    const otra = await prisma.$transaction((tx) => subcuentaClienteParaApunte(tx, EMPRESA, viejo.id));
    expect(otra.codigo).toBe('43000008');
    expect(await prisma.chartOfAccounts.count({ where: { companyId: EMPRESA, codigo: '43000008' } })).toBe(1);
  });

  it('dos contabilizaciones a la vez del mismo cliente nuevo: una sola subcuenta', async () => {
    const c = await prisma.customer.create({ data: { companyId: EMPRESA, nombreFiscal: 'Carrera SL', nifCif: 'B66666666' } });
    const { conReintentoSubcuenta } = await import('../services/terceros/subcuentas');
    const r = await Promise.all([1, 2, 3].map(() => conReintentoSubcuenta(() => prisma.$transaction((tx) => subcuentaClienteParaApunte(tx, EMPRESA, c.id)))));
    expect(new Set(r.map((x) => x.codigo)).size).toBe(1);
    const ficha = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
    expect(ficha.subcuenta430).toBe(r[0].codigo);
    expect(await prisma.chartOfAccounts.count({ where: { companyId: EMPRESA, codigo: r[0].codigo } })).toBe(1);
  });

  it('proveedor: la 400 en compras y la 410 en servicios; en el plan solo la que se usa', async () => {
    const p = await prisma.supplier.create({ data: { companyId: EMPRESA, nombreFiscal: 'Gestoria Lopez SL', nifCif: 'B77777777' } });
    const s = await prisma.$transaction((tx) => subcuentaProveedorParaApunte(tx, EMPRESA, p.id, 'SERVICIO_PROFESIONAL'));
    expect(s).toEqual({ codigo: '41000004', nombre: 'Gestoria Lopez SL' });
    expect(await prisma.chartOfAccounts.count({ where: { companyId: EMPRESA, codigo: '40000004' } })).toBe(0);
    const c = await prisma.$transaction((tx) => subcuentaProveedorParaApunte(tx, EMPRESA, p.id, 'COMPRA'));
    expect(c.codigo).toBe('40000004');
    expect((await prisma.chartOfAccounts.findFirstOrThrow({ where: { companyId: EMPRESA, codigo: '41000004' } })).parentCodigo).toBe('410');
  });

  it('proveedor con solo la 400: la 410 lleva su numero', async () => {
    const p = await prisma.supplier.create({ data: { companyId: EMPRESA, nombreFiscal: 'Solo Compras SL', nifCif: 'B88888888', subcuenta400: '40000050' } });
    const s = await prisma.$transaction((tx) => subcuentaProveedorParaApunte(tx, EMPRESA, p.id, 'ALQUILER'));
    expect(s.codigo).toBe('41000050');
  });
});

describe('longitud por empresa', () => {
  it('sin plan previo: 8', async () => {
    expect(await longitudSubcuentasEmpresa(EMPRESA)).toBe(8);
  });

  it('con un plan traido de otro programa a 10 digitos: 10, y sigue su numeracion', async () => {
    await prisma.chartOfAccounts.create({
      data: { companyId: EMPRESA_10, codigo: '4300000005', nombre: 'Cliente importado', grupo: 4, nivel: 4, naturaleza: 'ACTIVO', tipoUso: 'BALANCE', esBasePGC: false, esPersonalizadaEmpresa: true, parentCodigo: '430' },
    });
    expect(await longitudSubcuentasEmpresa(EMPRESA_10)).toBe(10);
    const c = await crearClienteConSubcuenta({ companyId: EMPRESA_10, nombreFiscal: 'Nuevo 2027 SL', nifCif: 'B99999999' });
    expect(c.subcuenta430).toBe('4300000006');
  });

  it('la guardada en las reglas manda (7 digitos)', async () => {
    await prisma.reglasContables.create({ data: { companyId: EMPRESA_7, data: { longitudSubcuentas: 7 } } });
    expect(await longitudSubcuentasEmpresa(EMPRESA_7)).toBe(7);
    const p = await crearProveedorConSubcuenta({ companyId: EMPRESA_7, nombreFiscal: 'Corto SL', nifCif: 'B12121212' });
    expect(p).toMatchObject({ subcuenta400: '4000001', subcuenta410: '4100001' });
  });
});

describe('longitud fijada desde la primera subcuenta', () => {
  it('la primera asignacion guarda la longitud y una cuenta importada despues de otra longitud ya no la cambia', async () => {
    const c1 = await crearClienteConSubcuenta({ companyId: EMPRESA_FIJA, nombreFiscal: 'Primero Fijo SL', nifCif: 'B10101010' });
    expect(c1.subcuenta430).toBe('43000001');
    const reglas = await prisma.reglasContables.findUniqueOrThrow({ where: { companyId: EMPRESA_FIJA } });
    expect((reglas.data as { longitudSubcuentas?: number }).longitudSubcuentas).toBe(8);
    // Una apertura o un diario traen despues subcuentas de 10 digitos.
    await cuentaImportada(EMPRESA_FIJA, '4300000001', '430');
    await cuentaImportada(EMPRESA_FIJA, '4300000002', '430');
    expect(await longitudSubcuentasEmpresa(EMPRESA_FIJA)).toBe(8);
    const c2 = await crearClienteConSubcuenta({ companyId: EMPRESA_FIJA, nombreFiscal: 'Segundo Fijo SL', nifCif: 'B20202020' });
    expect(c2.subcuenta430).toBe('43000002');
  });

  it('las demas reglas guardadas se conservan al fijar la longitud', async () => {
    const id = `subcreglas-${SUFIJO}`;
    await crearEmpresa(id);
    await prisma.reglasContables.create({ data: { companyId: id, data: { cuentasVentasPorFamilia: { SERVICIOS: '705' } } } });
    await crearProveedorConSubcuenta({ companyId: id, nombreFiscal: 'Con Reglas SL', nifCif: 'B30303030' });
    const reglas = await prisma.reglasContables.findUniqueOrThrow({ where: { companyId: id } });
    expect(reglas.data).toMatchObject({ cuentasVentasPorFamilia: { SERVICIOS: '705' }, longitudSubcuentas: 8 });
  });
});

describe('cuentas 4009, 4309... de un plan traido', () => {
  it('40090000 y 43090000 (facturas pendientes) no mueven la numeracion ni la longitud', async () => {
    await cuentaImportada(EMPRESA_4009, '4009', '400', 'Proveedores, facturas pendientes de recibir');
    await cuentaImportada(EMPRESA_4009, '4309', '430', 'Clientes, facturas pendientes de formalizar');
    await cuentaImportada(EMPRESA_4009, '40000001', '400', 'Proveedor importado');
    await cuentaImportada(EMPRESA_4009, '40090000', '4009');
    await cuentaImportada(EMPRESA_4009, '43090000', '4309');
    await cuentaImportada(EMPRESA_4009, '4309000001', '4309');
    expect(await longitudSubcuentasEmpresa(EMPRESA_4009)).toBe(8);
    const p = await crearProveedorConSubcuenta({ companyId: EMPRESA_4009, nombreFiscal: 'Proveedor Nuevo SL', nifCif: 'B40404040' });
    expect(p).toMatchObject({ subcuenta400: '40000002', subcuenta410: '41000002' });
    const c = await crearClienteConSubcuenta({ companyId: EMPRESA_4009, nombreFiscal: 'Cliente Nuevo SL', nifCif: 'B50505050' });
    expect(c.subcuenta430).toBe('43000001');
  });
});

describe('renombrar, retirar y consultar', () => {
  it('sincronizarNombreSubcuentas cambia el nombre en el plan', async () => {
    const c = await prisma.customer.findFirstOrThrow({ where: { companyId: EMPRESA, subcuenta430: '43000008' } });
    await prisma.$transaction((tx) => sincronizarNombreSubcuentas(tx, EMPRESA, [c.subcuenta430], 'Cliente Renombrado SA'));
    expect((await prisma.chartOfAccounts.findFirstOrThrow({ where: { companyId: EMPRESA, codigo: '43000008' } })).nombre).toBe('Cliente Renombrado SA');
  });

  it('asegurarSubcuentaEnPlan pone el nombre de la ficha si la cuenta ya estaba con otro', async () => {
    await prisma.$transaction((tx) => asegurarSubcuentaEnPlan(tx, EMPRESA, '41000002', 'Acreedor Vinculado SL', { tipo: 'proveedor', id: 'x' }));
    expect((await prisma.chartOfAccounts.findFirstOrThrow({ where: { companyId: EMPRESA, codigo: '41000002' } })).nombre).toBe('Acreedor Vinculado SL');
  });

  it('retirar: la subcuenta queda en el plan inactiva y el codigo no se vuelve a dar', async () => {
    const c = await crearClienteConSubcuenta({ companyId: EMPRESA, nombreFiscal: 'Efimero SL', nifCif: 'B13131313' });
    await prisma.$transaction(async (tx) => {
      await retirarSubcuentasDeFicha(tx, EMPRESA, [c.subcuenta430], { tipo: 'cliente', id: c.id, nombreFiscal: c.nombreFiscal }, '2026-10-11');
      await tx.customer.delete({ where: { id: c.id } });
    });
    const cuenta = await prisma.chartOfAccounts.findFirstOrThrow({ where: { companyId: EMPRESA, codigo: c.subcuenta430! } });
    expect(cuenta.activo).toBe(false);
    expect(cuenta.notas).toContain('Tercero borrado el 11/10/2026');
    const siguiente = await crearClienteConSubcuenta({ companyId: EMPRESA, nombreFiscal: 'Despues SL', nifCif: 'B14141414' });
    expect(Number(siguiente.subcuenta430)).toBe(Number(c.subcuenta430) + 1);
  });

  it('fichaDeSubcuenta enlaza cada codigo con su ficha', async () => {
    const mapa = await fichaDeSubcuenta(EMPRESA);
    expect(mapa.get('43000001')).toMatchObject({ tipo: 'cliente', nombre: 'Primero SL', nif: 'B11111111' });
    expect(mapa.get('40000001')).toMatchObject({ tipo: 'proveedor', nombre: 'Proveedor Uno SL' });
    expect(mapa.get('41000001')).toEqual(mapa.get('40000001'));
  });
});

describe('plan base', () => {
  it('asegurarPlanContableEmpresa trae 401, 407, 431, 436, 438 y 490 (bajo el subgrupo 49)', async () => {
    const cuentas = await prisma.chartOfAccounts.findMany({ where: { companyId: EMPRESA, codigo: { in: ['401', '407', '431', '436', '438', '49', '490'] } } });
    expect(cuentas.map((c) => c.codigo).sort()).toEqual(['401', '407', '431', '436', '438', '49', '490']);
    const sub49 = cuentas.find((c) => c.codigo === '49')!;
    expect(cuentas.find((c) => c.codigo === '490')).toMatchObject({ parentId: sub49.id, nivel: 3, esBasePGC: true });
  });
});
