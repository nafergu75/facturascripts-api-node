/**
 * Informes con subcuentas de tercero (R1): Libro mayor de un cliente o
 * proveedor, buscador de terceros, Sumas y saldos con filtro de cuentas y
 * subtotales por cuenta de 3 digitos, Mayor de terceros que lee primero la
 * subcuenta, y balance sin compensar saldos entre clientes.
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
import { asegurarSubcuentaEnPlan } from '../services/terceros/subcuentas';
import {
  buscarTerceros,
  informeBalance,
  informeDetalleTercero,
  informeMayor,
  informeMayorTerceros,
  informeSumasYSaldos,
  terceroParaMayor,
} from '../services/informesContables.service';
import { informesContablesRoutes } from '../routes/informesContables.routes';
import { errorMiddleware } from '../middleware/error.middleware';

const SUFIJO = Date.now();
const E = `inf-subc-${SUFIJO}`;
const P = { desde: '2026-01-01', hasta: '2026-12-31', ejercicio: 2026 };
let n = 0;
let asientoN = 0;

function cif(): string {
  const siete = String(1000000 + ((SUFIJO + n++ * 7919) % 8999999)).slice(0, 7);
  return `B${siete}${controlCif(siete).cifra}`;
}

/** Asiento POSTED con sus lineas [cuenta, debe, haber]. */
async function apunte(fecha: string, concepto: string, lineas: Array<[string, number, number]>, extra: { invoiceId?: string; invoiceType?: string } = {}) {
  return prisma.journalEntry.create({
    data: {
      companyId: E,
      fecha: new Date(`${fecha}T00:00:00.000Z`),
      numeroAsiento: `T-${++asientoN}`,
      descripcion: concepto,
      origen: 'AJUSTE_MANUAL',
      estado: 'POSTED',
      ...extra,
      lineas: { create: lineas.map(([accountCode, debe, haber]) => ({ accountCode, accountName: accountCode, debe, haber, companyId: E })) },
    },
  });
}

let ana: { id: string; sub: string };
let beto: { id: string; sub: string };
let sinSub: string;
let prov: { id: string; s400: string; s410: string };

beforeAll(async () => {
  await prisma.company.create({ data: { id: E, name: 'Informes Subcuentas SL', fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: E, denominacion: 'Informes Subcuentas SL', nif: 'B10000000' } });
  await asegurarPlanContableEmpresa(E);
  const a = (await clientesService.create(E, { nombreFiscal: 'Ánade Construcciones SL', nifCif: cif() })) as unknown as { id: string; subcuenta430: string };
  const b = (await clientesService.create(E, { nombreFiscal: 'Beto Reformas SL', nifCif: cif() })) as unknown as { id: string; subcuenta430: string };
  ana = { id: a.id, sub: a.subcuenta430 };
  beto = { id: b.id, sub: b.subcuenta430 };
  sinSub = (await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Sin Subcuenta SA', nifCif: cif() } })).id;
  const p = await proveedoresService.create(E, { nombreFiscal: 'Papelería Centro SL', nifCif: cif() });
  prov = { id: p.id, s400: p.subcuenta400!, s410: p.subcuenta410! };
  await prisma.$transaction(async (tx) => {
    for (const [c, nombre, tipo, id] of [
      [ana.sub, 'Ánade Construcciones SL', 'cliente', ana.id],
      [beto.sub, 'Beto Reformas SL', 'cliente', beto.id],
      [prov.s400, 'Papelería Centro SL', 'proveedor', prov.id],
      [prov.s410, 'Papelería Centro SL', 'proveedor', prov.id],
    ] as const) {
      await asegurarSubcuentaEnPlan(tx, E, c, nombre, { tipo, id });
    }
  });
  // Una subcuenta suelta sin movimientos (traida del plan anterior).
  await prisma.chartOfAccounts.create({
    data: { companyId: E, codigo: '43000099', nombre: 'Cliente antiguo', grupo: 4, nivel: 4, naturaleza: 'ACTIVO', tipoUso: 'BALANCE', esBasePGC: false, esPersonalizadaEmpresa: true, parentCodigo: '430' },
  });

  // Ventas a Ana (1.210) y a Beto (605); Beto paga 1.000 (le sobran 395: saldo acreedor).
  await apunte('2026-02-01', 'Factura A-1 Ana', [[ana.sub, 1210, 0], ['700', 0, 1000], ['477', 0, 210]]);
  await apunte('2026-02-02', 'Factura A-2 Beto', [[beto.sub, 605, 0], ['700', 0, 500], ['477', 0, 105]]);
  await apunte('2026-02-10', 'Cobro Beto', [['572', 1000, 0], [beto.sub, 0, 1000]]);
  // Compra y servicio al proveedor; deterioro de un credito.
  await apunte('2026-03-01', 'Compra papel', [['600', 100, 0], ['472', 21, 0], [prov.s400, 0, 121]]);
  await apunte('2026-03-02', 'Mantenimiento', [['622', 50, 0], ['472', 10.5, 0], [prov.s410, 0, 60.5]]);
  await apunte('2026-03-03', 'Deterioro', [['694', 100, 0], ['490', 0, 100]]);
  // Apunte en la subcuenta de Ana enlazado a una factura de Beto (mal imputado): es de Ana.
  const facturaBeto = await prisma.incomeInvoice.create({
    data: { companyId: E, customerId: beto.id, serie: 'X', fechaEmision: '2026-04-01', fechaVencimiento: '2026-04-30', numeroCompleto: `X-${SUFIJO}` },
  });
  await apunte('2026-04-01', 'Ajuste', [[ana.sub, 10, 0], ['759', 0, 10]], { invoiceId: facturaBeto.id, invoiceType: 'INGRESO' });
});

describe('Libro mayor de un cliente o proveedor', () => {
  it('cliente: solo su subcuenta, con saldo acumulado', async () => {
    const r = await informeMayor(E, P, {}, await terceroParaMayor(E, 'cliente', ana.id));
    expect(r.cuentas.map((c) => c.cuenta)).toEqual([ana.sub]);
    expect(r.cuentas[0].movimientos.map((m) => m.saldo)).toEqual([1210, 1220]);
    expect(r.tabla.periodo).toContain('Ánade Construcciones SL');
    expect(r.tabla.periodo).toContain(ana.sub);
  });

  it('proveedor: su 400N y su 410N', async () => {
    const r = await informeMayor(E, P, {}, await terceroParaMayor(E, 'proveedor', prov.id));
    expect(r.cuentas.map((c) => [c.cuenta, c.saldoFinal])).toEqual([
      [prov.s400, -121],
      [prov.s410, -60.5],
    ]);
  });

  it('ficha sin subcuenta: sin movimientos y lo explica', async () => {
    const r = await informeMayor(E, P, {}, await terceroParaMayor(E, 'cliente', sinSub));
    expect(r.cuentas).toEqual([]);
    expect((r.tabla.notas ?? []).join(' ')).toMatch(/aún no tiene subcuenta/);
  });

  it('una ficha de otra empresa: 404', async () => {
    await expect(terceroParaMayor('otra-empresa', 'cliente', ana.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('el rango 430-430 saca todos los clientes con sus subcuentas', async () => {
    const r = await informeMayor(E, P, { desde: '430', hasta: '430' });
    expect(r.cuentas.map((c) => c.cuenta)).toEqual([ana.sub, beto.sub]);
  });
});

describe('buscador de clientes y proveedores', () => {
  it('por nombre sin tildes, por NIF y por subcuenta', async () => {
    expect((await buscarTerceros(E, 'anade')).map((t) => t.id)).toEqual([ana.id]);
    const nif = (await prisma.customer.findUniqueOrThrow({ where: { id: beto.id } })).nifCif;
    expect(await buscarTerceros(E, nif.toLowerCase())).toEqual([{ tipo: 'cliente', id: beto.id, nombre: 'Beto Reformas SL', nif, subcuentas: [beto.sub] }]);
    expect((await buscarTerceros(E, prov.s410)).map((t) => [t.tipo, t.id])).toEqual([['proveedor', prov.id]]);
    expect((await buscarTerceros(E, 'SL', 'proveedor')).every((t) => t.tipo === 'proveedor')).toBe(true);
    expect(await buscarTerceros(E, 'a')).toEqual([]);
  });
});

describe('sumas y saldos', () => {
  it('filtro 430-430 con el subtotal de la 430; deudor y acreedor sin compensar', async () => {
    const r = await informeSumasYSaldos(E, P, 'subcuenta', { filtro: { desde: '430', hasta: '430' } });
    expect(r.filas.map((f) => [f.cuenta, f.saldoDeudor, f.saldoAcreedor])).toEqual([
      [ana.sub, 1220, 0],
      [beto.sub, 0, 395],
    ]);
    expect(r.subtotales).toEqual([{ cuenta: '430', nombre: expect.any(String), saldoInicial: 0, debe: 1825, haber: 1000, saldoDeudor: 1220, saldoAcreedor: 395 }]);
    const subtotal = r.tabla.filas.find((f) => f.estilo === 'subtotal');
    expect(subtotal?.celdas.slice(0, 1)).toEqual(['430']);
    expect((r.tabla.notas ?? []).join(' ')).toContain('Solo cuentas 430');
    expect((r.tabla.notas ?? []).join(' ')).not.toContain('no cuadran');
  });

  it('subtotales tras cada grupo con subcuentas; la 700 sola no lleva subtotal', async () => {
    const r = await informeSumasYSaldos(E, P, 'subcuenta');
    expect(r.subtotales.map((s) => s.cuenta)).toEqual(['400', '410', '430']);
    const cuentas = r.tabla.filas.map((f) => `${f.estilo ?? ''}${f.celdas[0]}`);
    expect(cuentas.indexOf('subtotal430')).toBe(cuentas.indexOf(beto.sub) + 1);
    expect(cuentas).not.toContain('subtotal700');
    expect(r.cuadra).toBe(true);
  });

  it('con «ocultar sin movimientos» desactivado salen las subcuentas del plan a cero', async () => {
    const oculto = await informeSumasYSaldos(E, P, 'subcuenta', { filtro: { cuenta: '430' } });
    expect(oculto.filas.map((f) => f.cuenta)).not.toContain('43000099');
    const todo = await informeSumasYSaldos(E, P, 'subcuenta', { filtro: { cuenta: '430' }, ocultarSinMovimiento: false });
    expect(todo.filas.find((f) => f.cuenta === '43000099')).toMatchObject({ debe: 0, haber: 0, nombre: 'Cliente antiguo' });
  });
});

describe('mayor de terceros', () => {
  it('lee primero la subcuenta: el apunte mal enlazado a una factura de Beto es de Ana', async () => {
    const r = await informeMayorTerceros(E, 'clientes', P);
    const porId = new Map(r.terceros.map((t) => [t.id, t]));
    expect(porId.get(ana.id)).toMatchObject({ debe: 1220, saldoFinal: 1220, subcuentas: [ana.sub] });
    expect(porId.get(beto.id)).toMatchObject({ debe: 605, haber: 1000, saldoFinal: -395 });
    expect(r.tabla.columnas.map((c) => c.titulo)).toContain('Subcuenta');
    expect(r.tabla.filas[0].celdas[2]).toBe(ana.sub);
  });

  it('detalle de una ficha sin movimientos: devuelve su subcuenta', async () => {
    const c = (await clientesService.create(E, { nombreFiscal: 'Nuevo Sin Movimientos SL', nifCif: cif() })) as unknown as { id: string; subcuenta430: string };
    const r = await informeDetalleTercero(E, 'clientes', P, c.id);
    expect(r.tercero).toMatchObject({ saldoFinal: 0, subcuentas: [c.subcuenta430] });
    expect((r.tabla.notas ?? []).join(' ')).toContain(c.subcuenta430);
  });
});

describe('balance sin compensar clientes', () => {
  it('Ana en deudores, Beto (saldo acreedor) en el pasivo y el deterioro restando en clientes', async () => {
    const r = await informeBalance(E, P);
    const importe = (lista: Array<{ codigo: string; importe: number }>, codigo: string) => lista.find((p) => p.codigo === codigo)?.importe ?? 0;
    // 1.220 de Ana menos 100 de deterioro; los 395 de Beto no restan aqui.
    expect(importe(r.balance.activoCorriente, 'B.III.1')).toBe(1120);
    // Beto (395) y el IVA repercutido (315) en otros acreedores.
    expect(importe(r.balance.pasivoCorriente, 'D.IV.2')).toBe(395 + 315 + 60.5);
    expect(r.cuadra).toBe(true);
  });
});

describe('rutas', () => {
  function app(permisos: string[]) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      req.user = { userId: 'u', email: 'u@test.local', roles: ['x'], companies: [E], rolesPorEmpresa: { [E]: ['x'] }, permisosPorEmpresa: { [E]: permisos } } as never;
      req.companyId = E;
      next();
    });
    a.use('/informes-contables', informesContablesRoutes);
    a.use(errorMiddleware);
    return a;
  }

  it('mayor por tercero (json y Excel), sin filtro 400, y buscador solo con contabilidad:read', async () => {
    const c = app(['contabilidad:read']);
    const r = await request(c).get(`/informes-contables/mayor?ejercicio=2026&tercero=${ana.id}&tipoTercero=cliente`);
    expect(r.status).toBe(200);
    expect((r.body.data ?? r.body).cuentas[0].cuenta).toBe(ana.sub);
    const x = await request(c).get(`/informes-contables/mayor?ejercicio=2026&tercero=${prov.id}&tipoTercero=proveedor&formato=xlsx`);
    expect(x.status).toBe(200);
    expect(x.headers['content-type']).toContain('spreadsheetml');
    expect((await request(c).get('/informes-contables/mayor?ejercicio=2026')).status).toBe(400);
    expect((await request(c).get(`/informes-contables/mayor?ejercicio=2026&tercero=${ana.id}`)).status).toBe(400);
    expect((await request(c).get('/informes-contables/buscar-tercero?q=beto')).body.data?.[0]?.id ?? null).toBe(beto.id);
    expect((await request(app(['ventas:read'])).get('/informes-contables/buscar-tercero?q=beto')).status).toBe(403);
  });

  it('sumas y saldos con rango y sin ocultar', async () => {
    const r = await request(app(['contabilidad:read'])).get('/informes-contables/sumas-saldos?ejercicio=2026&cuentaDesde=430&cuentaHasta=430&ocultarSinMovimiento=0');
    expect(r.status).toBe(200);
    expect((r.body.data ?? r.body).filas.map((f: { cuenta: string }) => f.cuenta)).toContain('43000099');
  });
});
