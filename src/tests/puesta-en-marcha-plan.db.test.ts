/**
 * Traslado del plan contable anterior (R3): todas las cuentas y subcuentas con
 * su nombre y su longitud, la longitud de la empresa fijada desde el plan y las
 * subcuentas 430/400/410 enlazadas a fichas por NIF (o pendientes de enlazar).
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
import { asegurarPlanContableEmpresa } from '../services/chart-of-accounts.service';
import { crearClienteConSubcuenta, crearProveedorConSubcuenta, longitudSubcuentasEmpresa, longitudSubcuentasGuardada } from '../services/terceros/subcuentas';
import { esSubcuentaDeTercero } from '../services/terceros/numeracion';
import {
  confirmarPlan,
  enlazarSubcuenta,
  leerPlanDeFilas,
  longitudDelPlan,
  nombreComparable,
  previsualizarPlan,
  subcuentasSinEnlazar,
  type CuentaDelPlan,
} from '../services/puestaEnMarcha/planAnterior';
import puestaEnMarchaRoutes from '../routes/puestaEnMarcha.routes';
import { errorMiddleware } from '../middleware/error.middleware';

const SUFIJO = Date.now();
let n = 0;

function cif(): string {
  const siete = String(1000000 + ((SUFIJO + n++ * 7919) % 8999999)).slice(0, 7);
  return `B${siete}${controlCif(siete).cifra}`;
}

async function empresa(id: string) {
  await prisma.company.create({ data: { id, name: `Plan ${id}`, fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: id, denominacion: `Plan ${id}`, nif: 'B10000000' } });
  await asegurarPlanContableEmpresa(id);
}

describe('lectura del fichero del plan (sin BD)', () => {
  it('con titulos: cuenta, nombre y NIF; sin titulos: codigo y nombre', () => {
    const con = leerPlanDeFilas([
      ['Plan de cuentas 2026'],
      ['Subcuenta', 'Descripción', 'N.I.F.'],
      ['430.0001', 'Cliente Uno SL', 'es-b12345678'],
      ['6280001', 'Luz oficina', ''],
      ['', 'fila vacía', ''],
    ]);
    expect(con.cuentas).toEqual([
      { codigo: '4300001', nombre: 'Cliente Uno SL', nif: 'B12345678' },
      { codigo: '6280001', nombre: 'Luz oficina' },
    ]);
    expect(con.columnas).toEqual({ cuenta: 0, nombre: 1, nif: 2 });
    const sin = leerPlanDeFilas([['4000001', 'Proveedor SA'], ['4100001 Acreedor SL']]);
    expect(sin.cuentas.map((c) => [c.codigo, c.nombre])).toEqual([
      ['4000001', 'Proveedor SA'],
      ['4100001', 'Acreedor SL'],
    ]);
    expect(sin.avisos.join(' ')).toMatch(/no trae títulos/);
    expect(() => leerPlanDeFilas([['hola'], ['adios']])).toThrow(/No encuentro cuentas/);
  });

  it('la longitud del plan: la de sus subcuentas de terceros; si no tiene, la del resto', () => {
    expect(longitudDelPlan(['4300001', '4300002', '43000003', '6280001'], esSubcuentaDeTercero)).toBe(7);
    expect(longitudDelPlan(['62800001', '57200001', '6290001'], esSubcuentaDeTercero)).toBe(8);
    expect(longitudDelPlan(['4300', '6281'], esSubcuentaDeTercero)).toBeNull();
  });
});

describe('empresa nueva: todo el plan, longitud 7 y fichas por NIF', () => {
  const E = `plan-ant-${SUFIJO}`;
  const nifA = cif();
  const nifP = cif();
  const nifQ = cif();
  const plan = (): CuentaDelPlan[] => [
    { codigo: '430', nombre: 'Clientes' },
    { codigo: '4300001', nombre: 'Cliente A SL', nif: nifA },
    { codigo: '4300002', nombre: 'Cliente Sin Nif SL' },
    { codigo: '4000001', nombre: 'Proveedor P SL', nif: nifP },
    { codigo: '4100001', nombre: 'Proveedor P SL', nif: nifP },
    { codigo: '4100003', nombre: 'Acreedor Q SL' },
    { codigo: '6280001', nombre: 'Luz oficina' },
    { codigo: '6290001', nombre: 'Material de oficina' },
    { codigo: '5720001', nombre: 'Banco Sabadell' },
    { codigo: '800', nombre: 'Gastos financieros por valoración' },
  ];
  // El NIF de Q viene en el listado de proveedores, no en el plan.
  const listado = () => [{ subcuenta: '4100003', nif: nifQ, nombre: 'Acreedor Q SL' }];

  beforeAll(() => empresa(E));

  it('vista previa: cuentas nuevas, omitidas, longitud del plan y lo que se hace con cada tercero', async () => {
    const v = await previsualizarPlan(E, { cuentas: plan(), terceros: listado() });
    expect(v.cuentasNuevas.map((c) => [c.codigo, c.madre])).toEqual([
      ['4000001', '400'],
      ['4100001', '410'],
      ['4100003', '410'],
      ['4300001', '430'],
      ['4300002', '430'],
      ['5720001', '572'],
      ['6280001', '628'],
      ['6290001', '629'],
    ]);
    expect(v.omitidas.map((o) => o.codigo)).toEqual(['800']);
    expect(v.longitud).toMatchObject({ delPlan: 7, actual: 8, seFija: true });
    expect(v.terceros.map((t) => [t.codigo, t.accion])).toEqual([
      ['4000001', 'crear'],
      ['4100001', 'crear'],
      ['4100003', 'crear'],
      ['4300001', 'crear'],
      ['4300002', 'pendiente'],
    ]);
    expect(v.resumen).toEqual({ enlazar: 0, crear: 4, pendientes: 1, yaEnlazadas: 0, noSeEnlazan: 0 });
    // La vista previa no toca nada.
    expect(await prisma.chartOfAccounts.count({ where: { companyId: E, codigo: '6280001' } })).toBe(0);
  });

  it('confirmar: crea todo, fija la longitud y enlaza; las fichas nuevas siguen la numeracion', async () => {
    const r = await confirmarPlan(E, { cuentas: plan(), terceros: listado() });
    expect(r).toMatchObject({ cuentasCreadas: 8, fichasCreadas: 3, fichasEnlazadas: 0, pendientes: 1, longitudFijada: 7 });
    expect(await longitudSubcuentasGuardada(E)).toBe(7);
    expect(await prisma.chartOfAccounts.findFirst({ where: { companyId: E, codigo: '6280001' } })).toMatchObject({ nombre: 'Luz oficina', parentCodigo: '628', activo: true });
    const a = await prisma.customer.findFirstOrThrow({ where: { companyId: E, nifCif: nifA } });
    expect(a).toMatchObject({ nombreFiscal: 'Cliente A SL', subcuenta430: '4300001' });
    const p = await prisma.supplier.findFirstOrThrow({ where: { companyId: E, nifCif: nifP } });
    expect(p).toMatchObject({ subcuenta400: '4000001', subcuenta410: '4100001' });
    // Q solo traia la 410: la 400 lleva el mismo numero.
    expect(await prisma.supplier.findFirstOrThrow({ where: { companyId: E, nifCif: nifQ } })).toMatchObject({ subcuenta400: '4000003', subcuenta410: '4100003' });
    // El plan conserva la subcuenta sin ficha; la siguiente ficha nueva toma el siguiente numero libre.
    const nuevo = (await clientesService.create(E, { nombreFiscal: 'Cliente Nuevo 2027 SL', nifCif: cif() })) as unknown as { subcuenta430: string };
    expect(nuevo.subcuenta430).toBe('4300003');
  });

  it('repetir el traslado no duplica nada', async () => {
    const r = await confirmarPlan(E, { cuentas: plan(), terceros: listado() });
    expect(r).toMatchObject({ cuentasCreadas: 0, fichasCreadas: 0, fichasEnlazadas: 0, longitudFijada: null });
    expect(r.vista.terceros.filter((t) => t.accion === 'ya-enlazada').map((t) => t.codigo)).toEqual(['4000001', '4100001', '4100003', '4300001']);
  });

  it('subcuentas sin enlazar y enlace a mano creando la ficha con su NIF', async () => {
    expect((await subcuentasSinEnlazar(E)).map((s) => [s.codigo, s.tipo])).toEqual([['4300002', 'cliente']]);
    await expect(enlazarSubcuenta(E, { codigo: '4300002' })).rejects.toMatchObject({ statusCode: 400 });
    const nif = cif();
    const r = await enlazarSubcuenta(E, { codigo: '4300002', nueva: { nombreFiscal: 'Cliente Sin Nif SL', nifCif: nif } });
    expect(r).toMatchObject({ codigo: '4300002', tipo: 'cliente', fichaCreada: true });
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: r.fichaId } })).toMatchObject({ subcuenta430: '4300002', nifCif: nif });
    expect(await subcuentasSinEnlazar(E)).toEqual([]);
    // Ya es de una ficha: otra no la puede tomar.
    const otro = (await clientesService.create(E, { nombreFiscal: 'Otro SL', nifCif: cif() })) as unknown as { id: string };
    await expect(enlazarSubcuenta(E, { codigo: '4300002', fichaId: otro.id })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('empresa con fichas ya dadas de alta en la app', () => {
  const E = `plan-ant2-${SUFIJO}`;
  let sinMovimientos: { id: string; nif: string; sub: string };
  let conMovimientos: { id: string; nif: string; sub: string };

  beforeAll(async () => {
    await empresa(E);
    const a = (await clientesService.create(E, { nombreFiscal: 'Ya Estaba SL', nifCif: cif() })) as unknown as { id: string; nifCif: string; subcuenta430: string };
    sinMovimientos = { id: a.id, nif: a.nifCif, sub: a.subcuenta430 };
    const p = await proveedoresService.create(E, { nombreFiscal: 'Proveedor Con Apuntes SL', nifCif: cif() });
    conMovimientos = { id: p.id, nif: p.nifCif, sub: p.subcuenta400! };
    await prisma.journalEntry.create({
      data: {
        companyId: E,
        fecha: new Date('2026-05-01T00:00:00Z'),
        numeroAsiento: `X-${SUFIJO}`,
        descripcion: 'Compra',
        origen: 'AJUSTE_MANUAL',
        estado: 'POSTED',
        lineas: { create: [{ accountCode: '600', accountName: 'Compras', debe: 10, haber: 0, companyId: E }, { accountCode: p.subcuenta400!, accountName: 'x', debe: 0, haber: 10, companyId: E }] },
      },
    });
  });

  it('una ficha sin movimientos cambia su subcuenta por la del plan; una con movimientos no, y la longitud no se cambia', async () => {
    expect(sinMovimientos.sub).toBe('43000001');
    const cuentas: CuentaDelPlan[] = [
      { codigo: '4300005', nombre: 'Ya Estaba SL', nif: sinMovimientos.nif },
      { codigo: '4000009', nombre: 'Proveedor Con Apuntes SL', nif: conMovimientos.nif },
    ];
    const v = await previsualizarPlan(E, { cuentas });
    expect(v.terceros.map((t) => [t.codigo, t.accion, t.sustituye ?? null])).toEqual([
      ['4000009', 'no-se-enlaza', null],
      ['4300005', 'enlazar', '43000001'],
    ]);
    // La 40000001 de 8 digitos con apuntes se queda: las nuevas siguen con 8.
    expect(v.longitud).toMatchObject({ delPlan: 7, actual: 8, seFija: false });
    expect(v.longitud.motivo).toMatch(/seguirán con 8/);
    // El motivo va en su recuadro, no repetido en los avisos.
    expect(v.avisos).not.toContain(v.longitud.motivo);

    const r = await confirmarPlan(E, { cuentas });
    // La 8 ya quedo guardada al asignar la primera subcuenta: el plan de 7 no la cambia.
    expect(r).toMatchObject({ fichasEnlazadas: 1, longitudFijada: null });
    expect(await longitudSubcuentasGuardada(E)).toBe(8);
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: sinMovimientos.id } })).toMatchObject({ subcuenta430: '4300005' });
    expect(await prisma.chartOfAccounts.findFirst({ where: { companyId: E, codigo: '4300005' } })).toMatchObject({ nombre: 'Ya Estaba SL', activo: true });
    expect(await prisma.supplier.findUniqueOrThrow({ where: { id: conMovimientos.id } })).toMatchObject({ subcuenta400: conMovimientos.sub });
    expect(await longitudSubcuentasEmpresa(E)).toBe(8);
    // La 4000009 queda en el plan sin enlazar.
    expect((await subcuentasSinEnlazar(E)).map((s) => s.codigo)).toEqual(['4000009']);
  });

  it('un codigo que en la app ya es de otro NIF no se mueve solo', async () => {
    const otro = cif();
    const v = await previsualizarPlan(E, { cuentas: [{ codigo: conMovimientos.sub, nombre: 'Otro', nif: otro }] });
    expect(v.terceros[0]).toMatchObject({ accion: 'no-se-enlaza', motivo: expect.stringContaining('revísalo') });
  });
});

describe('plan PGC completo: subcuentas bajo 4300, 4000 y 4100', () => {
  const E = `plan-ant4-${SUFIJO}`;
  const nifCliente = cif();
  const nifProveedor = cif();
  beforeAll(() => empresa(E));

  it('enlaza por NIF las que cuelgan de 4300/4000/4100 y no las de 4009/4309', async () => {
    const cuentas: CuentaDelPlan[] = [
      { codigo: '4300', nombre: 'Clientes (euros)' },
      { codigo: '43000001', nombre: 'Cliente Euros SL', nif: nifCliente },
      { codigo: '43000003', nombre: 'Cliente Sin Nif SL' },
      { codigo: '4000', nombre: 'Proveedores (euros)' },
      { codigo: '40000001', nombre: 'Proveedor Euros SL', nif: nifProveedor },
      { codigo: '4009', nombre: 'Proveedores, facturas pendientes de recibir' },
      { codigo: '40090000', nombre: 'Facturas pendientes de recibir' },
      { codigo: '4309', nombre: 'Clientes, facturas pendientes de formalizar' },
      { codigo: '43090000', nombre: 'Facturas pendientes de formalizar' },
    ];
    const v = await previsualizarPlan(E, { cuentas });
    expect(v.terceros.map((t) => [t.codigo, t.accion])).toEqual([
      ['40000001', 'crear'],
      ['43000001', 'crear'],
      ['43000003', 'pendiente'],
    ]);
    expect(v.longitud).toMatchObject({ delPlan: 8, seFija: true });
    expect(v.avisos.join(' ')).toMatch(/40090000, 43090000\) se traen como cuentas, sin enlazarlas/);

    const r = await confirmarPlan(E, { cuentas });
    expect(r).toMatchObject({ fichasCreadas: 2, pendientes: 1, longitudFijada: 8 });
    expect(await prisma.customer.findFirstOrThrow({ where: { companyId: E, nifCif: nifCliente } })).toMatchObject({ subcuenta430: '43000001' });
    expect(await prisma.supplier.findFirstOrThrow({ where: { companyId: E, nifCif: nifProveedor } })).toMatchObject({ subcuenta400: '40000001', subcuenta410: '41000001' });
    expect(await prisma.chartOfAccounts.findFirstOrThrow({ where: { companyId: E, codigo: '43000001' } })).toMatchObject({ parentCodigo: '4300' });
    // La que no trae NIF queda para enlazarla a mano, aunque cuelgue de la 4300.
    expect((await subcuentasSinEnlazar(E)).map((x) => x.codigo)).toEqual(['43000003']);
    // Las fichas nuevas siguen la numeracion: ni 43090001 ni 40090001.
    expect((await crearClienteConSubcuenta({ companyId: E, nombreFiscal: 'Cliente 2027 SL', nifCif: cif() })).subcuenta430).toBe('43000004');
    expect(await crearProveedorConSubcuenta({ companyId: E, nombreFiscal: 'Proveedor 2027 SL', nifCif: cif() })).toMatchObject({ subcuenta400: '40000002' });
  });
});

describe('sin NIF: propuesta por nombre', () => {
  const E = `plan-ant5-${SUFIJO}`;
  beforeAll(async () => {
    await empresa(E);
    await proveedoresService.create(E, { nombreFiscal: 'Suministros Valencia SL', nifCif: cif() });
    await clientesService.create(E, { nombreFiscal: 'Bar Repetido SL', nifCif: cif() });
    await clientesService.create(E, { nombreFiscal: 'BAR REPETIDO, S.L.', nifCif: cif() });
  });

  it('nombre comparable: sin tildes, signos ni forma juridica', () => {
    expect(nombreComparable('Suministros Valencia, S.L.')).toBe('SUMINISTROS VALENCIA');
    expect(nombreComparable('Ferretería López SLU')).toBe('FERRETERIA LOPEZ');
    expect(nombreComparable('Talleres Pérez Sociedad Limitada')).toBe('TALLERES PEREZ');
    expect(nombreComparable('SL')).toBe('SL');
  });

  it('una sola ficha con ese nombre: se propone enlazarla, avisando; varias: pendiente', async () => {
    const v = await previsualizarPlan(E, {
      cuentas: [
        { codigo: '4000000001', nombre: 'Suministros Valencia, S.L.' },
        { codigo: '4300000001', nombre: 'Bar Repetido SL' },
        { codigo: '4300000002', nombre: 'Nadie Con Este Nombre SL' },
      ],
    });
    const porCodigo = new Map(v.terceros.map((t) => [t.codigo, t]));
    expect(porCodigo.get('4000000001')).toMatchObject({
      accion: 'enlazar',
      ficha: { nombre: 'Suministros Valencia SL' },
      motivo: 'Coincide por nombre con la ficha Suministros Valencia SL: compruébalo antes de confirmar.',
    });
    expect(porCodigo.get('4300000001')).toMatchObject({ accion: 'pendiente', motivo: expect.stringContaining('hay 2 fichas con ese nombre') });
    expect(porCodigo.get('4300000002')).toMatchObject({ accion: 'pendiente', motivo: 'Sin NIF: enlázala a una ficha después.' });
    // Las dos pendientes son por el NIF, y el aviso concuerda en plural.
    expect(v.avisos).toContain('2 subcuentas de clientes o proveedores no traen un NIF válido: quedan en el plan para enlazarlas después a su ficha.');
    expect(v.avisos.join(' ')).not.toMatch(/permiso/);
  });
});

describe('dar de alta fichas exige ventas:write o compras:write', () => {
  const E = `plan-ant6-${SUFIJO}`;
  beforeAll(() => empresa(E));

  it('sin permiso de alta, las que se crearian quedan pendientes; enlazar con ficha nueva da 403', async () => {
    const cuentas: CuentaDelPlan[] = [
      { codigo: '43000001', nombre: 'Cliente Permiso SL', nif: cif() },
      { codigo: '40000001', nombre: 'Proveedor Permiso SL', nif: cif() },
      { codigo: '43000002', nombre: 'Cliente Sin Nif Ni Ficha SL' },
    ];
    const v = await previsualizarPlan(E, { cuentas, permisos: { cliente: false, proveedor: true } });
    const porCodigo = new Map(v.terceros.map((t) => [t.codigo, t]));
    expect(porCodigo.get('43000001')).toMatchObject({ accion: 'pendiente', motivo: expect.stringContaining('No tienes permiso para dar de alta clientes (Ventas «Modificar»): enlázala') });
    expect(porCodigo.get('40000001')).toMatchObject({ accion: 'crear' });
    expect(porCodigo.get('43000002')).toMatchObject({ accion: 'pendiente', motivo: 'Sin NIF: enlázala a una ficha después.' });
    // Dos pendientes por motivos distintos: cada aviso dice el suyo, con su recuento y en singular.
    expect(v.resumen.pendientes).toBe(2);
    expect(v.avisos).toContain('1 subcuenta de cliente o proveedor no trae un NIF válido: queda en el plan para enlazarla después a su ficha.');
    expect(v.avisos).toContain(
      '1 subcuenta de cliente necesita una ficha nueva y no tienes permiso para dar de alta clientes (Ventas «Modificar»): queda en el plan para enlazarla a una ficha que ya exista, o para que el administrador la cree.',
    );
    expect(v.avisos.join(' ')).not.toMatch(/dar de alta proveedores/);
    const r = await confirmarPlan(E, { cuentas, permisos: { cliente: false, proveedor: true } });
    expect(r).toMatchObject({ fichasCreadas: 1, pendientes: 2 });
    expect(await prisma.customer.count({ where: { companyId: E } })).toBe(0);
    await expect(enlazarSubcuenta(E, { codigo: '43000001', nueva: { nombreFiscal: 'Cliente Permiso SL', nifCif: cif() } }, { cliente: false, proveedor: true })).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining('No tienes permiso para dar de alta clientes (Ventas «Modificar»). Enlázala'),
    });
    expect(await prisma.customer.count({ where: { companyId: E } })).toBe(0);
  });
});

describe('rutas', () => {
  const E = `plan-ant3-${SUFIJO}`;
  beforeAll(() => empresa(E));

  function app(permisos: string[]) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      req.user = { userId: 'u', email: 'u@test.local', roles: ['x'], companies: [E], rolesPorEmpresa: { [E]: ['x'] }, permisosPorEmpresa: { [E]: permisos } } as never;
      req.companyId = E;
      next();
    });
    a.use('/puesta-en-marcha', puestaEnMarchaRoutes);
    a.use(errorMiddleware);
    return a;
  }

  it('fichero CSV: vista previa y confirmacion con contabilidad:write; solo lectura no importa', async () => {
    const csv = Buffer.from(`Cuenta;Nombre;NIF\n4300001;Cliente Csv SL;${cif()}\n6280001;Luz\n`, 'utf8');
    // Solo contabilidad: trae el plan, pero no da de alta al cliente (eso es de Ventas).
    const soloContabilidad = await request(app(['contabilidad:write', 'contabilidad:read'])).post('/puesta-en-marcha/plan/vista-previa').attach('archivo', csv, 'plan.csv');
    expect((soloContabilidad.body.data ?? soloContabilidad.body).terceros.map((t: { accion: string }) => t.accion)).toEqual(['pendiente']);
    const sinAlta = await request(app(['contabilidad:write'])).post('/puesta-en-marcha/plan/enlazar').send({ codigo: '4300001', nueva: { nifCif: cif() } });
    expect(sinAlta.status).toBe(403);
    const c = app(['contabilidad:write', 'contabilidad:read', 'ventas:write']);
    const v = await request(c).post('/puesta-en-marcha/plan/vista-previa').attach('archivo', csv, 'plan.csv');
    expect(v.status).toBe(200);
    expect((v.body.data ?? v.body).terceros.map((t: { accion: string }) => t.accion)).toEqual(['crear']);
    expect((await request(app(['contabilidad:read'])).post('/puesta-en-marcha/plan').attach('archivo', csv, 'plan.csv')).status).toBe(403);
    const r = await request(c).post('/puesta-en-marcha/plan').attach('archivo', csv, 'plan.csv');
    expect(r.status).toBe(201);
    expect((r.body.data ?? r.body).cuentasCreadas).toBe(2);
    expect((await request(c).get('/puesta-en-marcha/plan/sin-enlazar')).status).toBe(200);
  });
});
