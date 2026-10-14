/**
 * Contabilidad > Movimientos enseña los APUNTES de los asientos (14-10-2026):
 * la pantalla leía solo la tabla Movement antigua y salía vacía. Comprueba el
 * listado paginado (GET /informes-contables/apuntes) con ventas, compras,
 * cobros y pagos, un borrador marcado, un asiento anulado que no sale, los
 * filtros, los totales, el nombre de cada cuenta, el documento de origen, la
 * descarga en PDF y Excel, el permiso y el aislamiento entre dos empresas.
 * La regularizacion y el cierre no salen salvo que se pidan: con ellos la
 * diferencia de una cuenta o de un cliente ya no seria su saldo del mayor.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { randomBytes } from 'crypto';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import { errorMiddleware } from '../middleware/error.middleware';
import { informesContablesRoutes } from '../routes/informesContables.routes';
import { filtroApuntesDeConsulta, informeApuntes, listarApuntes, MAX_DESCARGA, periodoApuntes, type Apunte } from '../services/apuntesContables.service';
import { informeDiario, informeMayor } from '../services/informesContables.service';

const SUF = `${Date.now()}${randomBytes(3).toString('hex')}`;
const E = `apuntes-${SUF}`;
const F = `apuntes-otra-${SUF}`;

const ids: Record<string, string> = {};
let barPepe = '';
let otroCliente = '';
let luz = '';
let clienteDeF = '';

type Linea = [cuenta: string, nombre: string, debe: number, haber: number];

async function asiento(
  companyId: string,
  clave: string,
  d: { fecha: string; numero: string; concepto: string; origen: string; estado?: string; invoiceId?: string; invoiceType?: string; lineas: Linea[] },
) {
  const a = await prisma.journalEntry.create({
    data: {
      companyId,
      fecha: new Date(`${d.fecha}T00:00:00Z`),
      numeroAsiento: d.numero,
      descripcion: d.concepto,
      origen: d.origen,
      estado: d.estado ?? 'POSTED',
      invoiceId: d.invoiceId ?? null,
      invoiceType: d.invoiceType ?? null,
    },
  });
  // Una a una, con su hora: el orden de grabación es el orden del asiento.
  for (const [i, [cuenta, nombre, debe, haber]] of d.lineas.entries()) {
    await prisma.journalEntryLine.create({
      data: { entryId: a.id, companyId, accountCode: cuenta, accountName: nombre, debe, haber, referencia: d.numero, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) },
    });
  }
  ids[clave] = a.id;
}

async function venta(companyId: string, clave: string, customerId: string, numero: string, fecha: string, total: number) {
  const f = await prisma.incomeInvoice.create({
    data: {
      companyId,
      customerId,
      serie: 'A',
      numero: Number(numero.replace(/\D/g, '')) || 1,
      numeroCompleto: numero,
      estadoDocumento: 'FINAL',
      estado: 'PENDING',
      fechaEmision: fecha,
      fechaVencimiento: fecha,
      baseTotal: total,
      ivaTotal: 0,
      totalFactura: total,
    },
  });
  ids[clave] = f.id;
  return f.id;
}

async function compra(clave: string, numero: string, numeroProveedor: string, fecha: string, total: number) {
  const f = await prisma.expenseInvoice.create({
    data: {
      companyId: E,
      supplierId: luz,
      serie: 'G',
      numero: Number(numero.replace(/\D/g, '')) || 1,
      numeroCompleto: numero,
      numeroFacturaProveedor: numeroProveedor,
      fechaEmision: fecha,
      fechaVencimiento: fecha,
      estado: 'ACCOUNTED',
      tipoGasto: 'SUMINISTROS',
      baseTotal: total,
      ivaTotal: 0,
      totalFactura: total,
    },
  });
  ids[clave] = f.id;
  return f.id;
}

beforeAll(async () => {
  for (const [id, nombre, nif] of [
    [E, 'Apuntes SL', 'B71000001'],
    [F, 'Otra Empresa SL', 'B71000002'],
  ]) {
    await prisma.company.create({ data: { id, name: nombre, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    await prisma.legalConfig.create({ data: { companyId: id, denominacion: nombre, nif } });
  }
  barPepe = (await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Bar Pepe SL', nifCif: 'B71000011', subcuenta430: '4300001' } })).id;
  otroCliente = (await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Otro Cliente SL', nifCif: 'B71000012', subcuenta430: '4300002' } })).id;
  luz = (await prisma.supplier.create({ data: { companyId: E, nombreFiscal: 'Luz del Turia SA', nifCif: 'A71000013', subcuenta410: '4100001' } })).id;
  clienteDeF = (await prisma.customer.create({ data: { companyId: F, nombreFiscal: 'Cliente de la otra SL', nifCif: 'B71000014', subcuenta430: '4300001' } })).id;
  // Nombre del plan de la empresa (manda sobre el del apunte).
  await prisma.chartOfAccounts.create({
    data: { companyId: E, codigo: '5720001', nombre: 'Banco Sabadell', grupo: 5, nivel: 4, naturaleza: 'ACTIVO', tipoUso: 'BALANCE', esBasePGC: false, esPersonalizadaEmpresa: true, parentCodigo: '572' },
  });

  const v1 = await venta(E, 'fv1', barPepe, 'A-1', '2026-01-15', 121);
  const v2 = await venta(E, 'fv2', otroCliente, 'A-2', '2026-04-05', 242);
  const v3 = await venta(E, 'fv3', barPepe, 'A-3', '2026-03-01', 999);
  const v4 = await venta(E, 'fv4', barPepe, 'A-4', '2026-05-01', 50);
  const g1 = await compra('fg1', 'G-1', 'LUZ-2026-02', '2026-02-10', 60.5);

  // Mismo día: el cobro va detrás de la venta aunque «COBRO-…» sea anterior a «FAC-ING-…».
  await asiento(E, 'cobro1', {
    fecha: '2026-01-15', numero: 'COBRO-00001', concepto: 'Cobro factura A-1', origen: 'TESORERIA', invoiceId: v1, invoiceType: 'INGRESO',
    lineas: [['5720001', 'Bancos', 121, 0], ['4300001', 'Clientes', 0, 121]],
  });
  await asiento(E, 'venta1', {
    fecha: '2026-01-15', numero: 'FAC-ING-A-1', concepto: 'Factura A-1 Bar Pepe', origen: 'FACTURA_INGRESO', invoiceId: v1, invoiceType: 'INGRESO',
    // El haber se graba antes que el debe: en el listado el cargo sale primero.
    lineas: [['700', 'Ventas', 0, 100], ['477', 'IVA repercutido', 0, 21], ['4300001', 'Clientes', 121, 0]],
  });
  await asiento(E, 'compra1', {
    fecha: '2026-02-10', numero: 'FAC-GAST-G-1', concepto: 'Factura LUZ febrero', origen: 'FACTURA_GASTO', invoiceId: g1, invoiceType: 'GASTO',
    lineas: [['628', 'Suministros', 50, 0], ['472', 'IVA soportado', 10.5, 0], ['4100001', 'Acreedores', 0, 60.5]],
  });
  await asiento(E, 'pago1', {
    fecha: '2026-02-20', numero: 'PAGO-00001', concepto: 'Pago factura LUZ-2026-02', origen: 'TESORERIA', invoiceId: g1, invoiceType: 'GASTO',
    lineas: [['4100001', 'Acreedores', 60.5, 0], ['5720001', 'Bancos', 0, 60.5]],
  });
  await asiento(E, 'anulado', {
    fecha: '2026-03-01', numero: 'FAC-ING-A-3', concepto: 'Factura A-3 anulada', origen: 'FACTURA_INGRESO', estado: 'REVERSED', invoiceId: v3, invoiceType: 'INGRESO',
    lineas: [['4300001', 'Clientes', 999, 0], ['700', 'Ventas', 0, 999]],
  });
  await asiento(E, 'sustituido', {
    fecha: '2026-03-02', numero: 'AS-RETIRADO', concepto: 'Retirado al traer la gestoría', origen: 'AJUSTE_MANUAL', estado: 'SUSTITUIDO',
    lineas: [['629', 'Otros servicios', 888, 0], ['5720001', 'Bancos', 0, 888]],
  });
  await asiento(E, 'nomina', {
    fecha: '2026-03-31', numero: 'NOM-00001', concepto: 'Nómina marzo 2026', origen: 'NOMINA', invoiceId: 'nomina-x', invoiceType: 'NOMINA',
    lineas: [['640', 'Sueldos y salarios', 1000, 0], ['476', 'Organismos de la Seguridad Social', 0, 300], ['465', 'Remuneraciones pendientes', 0, 700]],
  });
  await asiento(E, 'borrador', {
    fecha: '2026-04-05', numero: 'FAC-ING-A-2', concepto: 'Factura A-2 Otro Cliente', origen: 'FACTURA_INGRESO', estado: 'DRAFT', invoiceId: v2, invoiceType: 'INGRESO',
    lineas: [['4300002', 'Clientes', 242, 0], ['700', 'Ventas', 0, 200], ['477', 'IVA repercutido', 0, 42]],
  });
  await asiento(E, 'revisar', {
    fecha: '2026-04-06', numero: 'FAC-GAST-G-2', concepto: 'Factura del lector sin revisar', origen: 'FACTURA_GASTO', estado: 'PENDING_REVIEW',
    lineas: [['628', 'Suministros', 30, 0], ['4100001', 'Acreedores', 0, 30]],
  });
  // De antes de las subcuentas: la 430 general, de una factura de Bar Pepe, y un apunte mal puesto en la subcuenta de otro.
  await asiento(E, 'antiguo', {
    fecha: '2026-05-01', numero: 'FAC-ING-A-4', concepto: 'Factura A-4 (cuenta general)', origen: 'FACTURA_INGRESO', invoiceId: v4, invoiceType: 'INGRESO',
    lineas: [['430', 'Clientes', 50, 0], ['4300002', 'Clientes', 5, 0], ['700', 'Ventas', 0, 55]],
  });
  // Otro año: no sale en 2026.
  await asiento(E, 'anterior', {
    fecha: '2025-12-31', numero: 'AS-2025', concepto: 'Asiento de 2025', origen: 'AJUSTE_MANUAL',
    lineas: [['629', 'Otros servicios', 10, 0], ['5720001', 'Bancos', 0, 10]],
  });
  // La otra empresa: misma subcuenta 4300001 y mismo concepto; nunca sale en la primera.
  const vf = await venta(F, 'fvF', clienteDeF, 'A-1', '2026-01-15', 777);
  await asiento(F, 'ventaF', {
    fecha: '2026-01-15', numero: 'FAC-ING-A-1', concepto: 'Factura A-1 Bar Pepe', origen: 'FACTURA_INGRESO', invoiceId: vf, invoiceType: 'INGRESO',
    lineas: [['4300001', 'Clientes', 777, 0], ['700', 'Ventas', 0, 777]],
  });
  // Un movimiento anotado a mano antes: la pantalla enseña el enlace a «Movimientos antiguos».
  await prisma.movement.create({ data: { companyId: E, type: 'income', amount: 10, category: 'ventas', description: 'Anotado a mano', date: new Date('2026-01-02T00:00:00Z'), fiscalYear: 2026 } });
});

const ANIO = { ejercicio: '2026' };
const filtro = (q: Record<string, unknown>, companyId = E) => filtroApuntesDeConsulta(companyId, { ...ANIO, ...q });
const lista = async (q: Record<string, unknown> = {}, pagina?: { pagina?: number; porPagina?: number }) =>
  listarApuntes(E, await filtro(q), { porPagina: 200, ...pagina });
const clave = (a: Apunte) => `${a.asiento} ${a.cuenta} ${a.debe}/${a.haber}`;

describe('listado de apuntes', () => {
  it('ventas, compras, cobros, pagos, nóminas y borradores, por fecha y en el orden del asiento; sin anulados, retirados ni otros años', async () => {
    const r = await lista();
    expect(r.apuntes.map(clave)).toEqual([
      'FAC-ING-A-1 4300001 121/0',
      'FAC-ING-A-1 700 0/100',
      'FAC-ING-A-1 477 0/21',
      'COBRO-00001 5720001 121/0',
      'COBRO-00001 4300001 0/121',
      'FAC-GAST-G-1 628 50/0',
      'FAC-GAST-G-1 472 10.5/0',
      'FAC-GAST-G-1 4100001 0/60.5',
      'PAGO-00001 4100001 60.5/0',
      'PAGO-00001 5720001 0/60.5',
      'NOM-00001 640 1000/0',
      'NOM-00001 476 0/300',
      'NOM-00001 465 0/700',
      'FAC-ING-A-2 4300002 242/0',
      'FAC-ING-A-2 700 0/200',
      'FAC-ING-A-2 477 0/42',
      'FAC-GAST-G-2 628 30/0',
      'FAC-GAST-G-2 4100001 0/30',
      'FAC-ING-A-4 430 50/0',
      'FAC-ING-A-4 4300002 5/0',
      'FAC-ING-A-4 700 0/55',
    ]);
    expect(r.apuntes.some((a) => [ids.anulado, ids.sustituido, ids.anterior].includes(a.asientoId))).toBe(false);
    // Todo cuadra: Debe = Haber.
    expect(r.totales).toEqual({ apuntes: 21, debe: 1690, haber: 1690, diferencia: 0, enBorrador: 5, deCierre: 0 });
    expect(r.movimientosAntiguos).toBe(1);
  });

  it('cada apunte con su estado, el enlace a su asiento, el nombre de su cuenta, su documento y su tercero', async () => {
    const r = await lista();
    const de = (asiento: string, cuenta: string) => r.apuntes.find((a) => a.asientoId === ids[asiento] && a.cuenta === cuenta)!;

    const cargo = de('venta1', '4300001');
    expect(cargo).toMatchObject({
      fecha: '2026-01-15',
      asiento: 'FAC-ING-A-1',
      estado: 'APROBADO',
      enlaceAsiento: `/dashboard/motor-contable/${ids.venta1}`,
      // La subcuenta de un cliente lleva su nombre, no el del apunte.
      nombreCuenta: 'Bar Pepe SL',
      concepto: 'Factura A-1 Bar Pepe',
      debe: 121,
      haber: 0,
      documento: { tipo: 'FACTURA_VENTA', texto: 'Factura A-1', enlace: `/dashboard/facturas/${ids.fv1}` },
      tercero: { tipo: 'cliente', id: barPepe, nombre: 'Bar Pepe SL' },
    });
    // La línea de ventas: el nombre del apunte (sin plan) y el cliente de la factura.
    expect(de('venta1', '700')).toMatchObject({ nombreCuenta: 'Ventas', tercero: { tipo: 'cliente', id: barPepe } });
    // Cobro: el banco con el nombre del plan de la empresa.
    expect(de('cobro1', '5720001')).toMatchObject({
      nombreCuenta: 'Banco Sabadell',
      documento: { tipo: 'COBRO', texto: 'Cobro de la factura A-1', enlace: `/dashboard/facturas/${ids.fv1}` },
    });
    expect(de('compra1', '4100001')).toMatchObject({
      nombreCuenta: 'Luz del Turia SA',
      documento: { tipo: 'FACTURA_COMPRA', texto: 'Factura LUZ-2026-02', enlace: `/dashboard/compras/${ids.fg1}` },
      tercero: { tipo: 'proveedor', id: luz, nombre: 'Luz del Turia SA' },
    });
    expect(de('pago1', '4100001').documento).toEqual({ tipo: 'PAGO', texto: 'Pago de la factura LUZ-2026-02', enlace: `/dashboard/compras/${ids.fg1}` });
    expect(de('nomina', '640')).toMatchObject({ documento: { tipo: 'NOMINA', texto: 'Nómina', enlace: '/dashboard/nominas' }, tercero: null });
    // Borradores: DRAFT y PENDING_REVIEW.
    expect(de('borrador', '4300002').estado).toBe('BORRADOR');
    expect(de('revisar', '628')).toMatchObject({ estado: 'BORRADOR', documento: null, tercero: null });
    // Un apunte en la subcuenta de otro cliente es de ese otro, aunque la factura sea de Bar Pepe.
    expect(de('antiguo', '4300002').tercero).toMatchObject({ id: otroCliente, nombre: 'Otro Cliente SL' });
  });

  it('estado: solo aprobados o solo borradores', async () => {
    const aprobados = await lista({ estado: 'aprobados' });
    expect(aprobados.apuntes.every((a) => a.estado === 'APROBADO')).toBe(true);
    expect(aprobados.totales).toMatchObject({ apuntes: 16, enBorrador: 0, diferencia: 0 });
    const borradores = await lista({ estado: 'borradores' });
    expect(borradores.apuntes.map((a) => a.asientoId)).toEqual([ids.borrador, ids.borrador, ids.borrador, ids.revisar, ids.revisar]);
    expect(borradores.totales).toEqual({ apuntes: 5, debe: 272, haber: 272, diferencia: 0, enBorrador: 5, deCierre: 0 });
  });

  it('cuenta o prefijo: 43 trae las 43… con su diferencia; 572 el banco', async () => {
    const clientes = await lista({ cuenta: '43' });
    expect(clientes.apuntes.map(clave)).toEqual([
      'FAC-ING-A-1 4300001 121/0',
      'COBRO-00001 4300001 0/121',
      'FAC-ING-A-2 4300002 242/0',
      'FAC-ING-A-4 430 50/0',
      'FAC-ING-A-4 4300002 5/0',
    ]);
    expect(clientes.totales).toEqual({ apuntes: 5, debe: 418, haber: 121, diferencia: 297, enBorrador: 1, deCierre: 0 });
    const banco = await lista({ cuenta: '572' });
    expect(banco.totales).toMatchObject({ apuntes: 2, debe: 121, haber: 60.5, diferencia: 60.5 });
    // Solo con cifras: «572 Banco» vale 572.
    expect((await filtro({ cuenta: '572 Banco' })).cuenta).toBe('572');
  });

  it('cliente o proveedor: los apuntes de su cuenta (subcuenta propia y la general de sus facturas), no los de otros', async () => {
    const r = await lista({ tercero: barPepe, tipoTercero: 'cliente' });
    expect(r.apuntes.map(clave)).toEqual(['FAC-ING-A-1 4300001 121/0', 'COBRO-00001 4300001 0/121', 'FAC-ING-A-4 430 50/0']);
    expect(r.totales).toMatchObject({ debe: 171, haber: 121, diferencia: 50 });
    expect(r.filtro.tercero).toMatchObject({ id: barPepe, nombre: 'Bar Pepe SL', subcuentas: ['4300001'] });
    const p = await lista({ tercero: luz, tipoTercero: 'proveedor' });
    expect(p.apuntes.map(clave)).toEqual(['FAC-GAST-G-1 4100001 0/60.5', 'PAGO-00001 4100001 60.5/0', 'FAC-GAST-G-2 4100001 0/30']);
    expect(p.totales).toMatchObject({ debe: 60.5, haber: 90.5, diferencia: -30, enBorrador: 1 });
  });

  it('texto en el concepto (sin distinguir mayúsculas), en el número de asiento o en la referencia', async () => {
    const r = await lista({ texto: 'luz' });
    expect(new Set(r.apuntes.map((a) => a.asientoId))).toEqual(new Set([ids.compra1, ids.pago1]));
    expect((await lista({ texto: 'NOM-0000' })).totales.apuntes).toBe(3);
    // % y _ se buscan tal cual, no como comodines.
    expect((await lista({ texto: '%' })).totales.apuntes).toBe(0);
  });

  it('importe mínimo y máximo, sin signo, con coma decimal', async () => {
    const r = await lista({ importeMin: '100', importeMax: '242' });
    expect(r.apuntes.map((a) => Math.max(a.debe, a.haber)).sort((a, b) => a - b)).toEqual([100, 121, 121, 121, 200, 242]);
    expect((await lista({ importeMin: '60,5', importeMax: '60,50' })).totales.apuntes).toBe(3);
    expect((await lista({ importeMax: '1.000,00', importeMin: '1000' })).apuntes.map(clave)).toEqual(['NOM-00001 640 1000/0']);
  });

  it('periodo: trimestre, mes y fechas desde y hasta', async () => {
    expect(periodoApuntes({ ejercicio: '2026', trimestre: '1' })).toEqual({ desde: '2026-01-01', hasta: '2026-03-31', nombre: '1.er trimestre de 2026' });
    expect(periodoApuntes({ ejercicio: '2024', mes: '2' })).toMatchObject({ desde: '2024-02-01', hasta: '2024-02-29' });
    expect(periodoApuntes({ desde: '2026-02-01' })).toEqual({ desde: '2026-02-01', hasta: '2026-12-31', nombre: null });
    const t1 = await lista({ trimestre: '1' });
    expect(new Set(t1.apuntes.map((a) => a.asientoId))).toEqual(new Set([ids.venta1, ids.cobro1, ids.compra1, ids.pago1, ids.nomina]));
    const febrero = await lista({ mes: '2' });
    expect(new Set(febrero.apuntes.map((a) => a.asientoId))).toEqual(new Set([ids.compra1, ids.pago1]));
    // Las fechas mandan sobre el año: el último día entra entero.
    const dias = await lista({ desde: '2026-02-20', hasta: '2026-03-31' });
    expect(new Set(dias.apuntes.map((a) => a.asientoId))).toEqual(new Set([ids.pago1, ids.nomina]));
    const de2025 = await listarApuntes(E, await filtroApuntesDeConsulta(E, { ejercicio: '2025' }));
    expect(de2025.apuntes.map((a) => a.asientoId)).toEqual([ids.anterior, ids.anterior]);
  });

  it('paginado: la página pedida, y los totales y el número de páginas de todo el filtro', async () => {
    const r = await listarApuntes(E, await filtro({}), { pagina: 2, porPagina: 4 });
    expect(r).toMatchObject({ pagina: 2, porPagina: 4, paginas: 6 });
    expect(r.apuntes.map(clave)).toEqual(['COBRO-00001 4300001 0/121', 'FAC-GAST-G-1 628 50/0', 'FAC-GAST-G-1 472 10.5/0', 'FAC-GAST-G-1 4100001 0/60.5']);
    expect(r.totales.apuntes).toBe(21);
    const ultima = await listarApuntes(E, await filtro({}), { pagina: 6, porPagina: 4 });
    expect(ultima.apuntes.map(clave)).toEqual(['FAC-ING-A-4 700 0/55']);
    expect((await listarApuntes(E, await filtro({}), { pagina: 9, porPagina: 4 })).apuntes).toEqual([]);
  });

  it('sin apuntes: lista vacía y totales a cero', async () => {
    const r = await listarApuntes(E, await filtroApuntesDeConsulta(E, { ejercicio: '2027' }));
    expect(r.apuntes).toEqual([]);
    expect(r.totales).toEqual({ apuntes: 0, debe: 0, haber: 0, diferencia: 0, enBorrador: 0, deCierre: 0 });
    expect(r.paginas).toBe(1);
  });
});

describe('dos empresas', () => {
  it('cada una ve solo sus apuntes, aunque compartan subcuenta y concepto', async () => {
    const enF = await listarApuntes(F, await filtro({}, F));
    expect(enF.apuntes.map(clave)).toEqual(['FAC-ING-A-1 4300001 777/0', 'FAC-ING-A-1 700 0/777']);
    expect(enF.apuntes[0]).toMatchObject({ nombreCuenta: 'Cliente de la otra SL', tercero: { id: clienteDeF } });
    expect(enF.movimientosAntiguos).toBe(0);
    const enE = await lista({ texto: 'Bar Pepe' });
    expect(enE.apuntes.every((a) => a.debe !== 777)).toBe(true);
  });

  it('el cliente de otra empresa no vale como filtro (404)', async () => {
    await expect(filtro({ tercero: clienteDeF, tipoTercero: 'cliente' })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('descarga en PDF y Excel', () => {
  it('tabla con Fecha, Asiento, Cuenta, Nombre de la cuenta, Concepto, Debe y Haber, el total, los borradores marcados y la diferencia', async () => {
    const r = await informeApuntes(E, await filtro({ cuenta: '43' }));
    expect(r.tabla.columnas.map((c) => c.titulo)).toEqual(['Fecha', 'Asiento', 'Cuenta', 'Nombre de la cuenta', 'Concepto', 'Debe', 'Haber']);
    expect(r.tabla.columnas.map((c) => c.tipo)).toEqual(['fecha', 'codigo', 'codigo', 'texto', 'texto', 'importe', 'importe']);
    expect(r.tabla.filas[0].celdas).toEqual(['2026-01-15', 'FAC-ING-A-1', '4300001', 'Bar Pepe SL', 'Factura A-1 Bar Pepe', 121, 0]);
    expect(r.tabla.filas[2].celdas.slice(0, 3)).toEqual(['2026-04-05', 'FAC-ING-A-2 (borrador)', '4300002']);
    expect(r.tabla.filas.at(-1)).toEqual({ celdas: [null, null, null, null, 'Total (5 apuntes)', 418, 121], estilo: 'total' });
    expect(r.tabla.periodo).toBe('Ejercicio 2026 · cuenta 43');
    expect(r.tabla.notas?.[0]).toBe('Diferencia (Debe − Haber): 297,00\u00a0€ de saldo deudor.');
    expect(r.tabla.notas?.some((n) => n.startsWith('Un apunte es de asientos en borrador'))).toBe(true);
    const t = await informeApuntes(E, await filtro({ trimestre: '1', tercero: barPepe, tipoTercero: 'cliente', estado: 'aprobados' }));
    expect(t.tabla.periodo).toBe('1.er trimestre de 2026 (del 01/01/2026 al 31/03/2026) · cliente Bar Pepe SL (B71000011) · solo asientos aprobados');
    // Las notas dicen lo que se ha pedido: solo aprobados, solo borradores o los dos; y sin la regularización ni el cierre.
    expect(t.tabla.notas).toContain('Apuntes de los asientos aprobados, por fecha de asiento. Los asientos anulados no salen.');
    expect(t.tabla.notas).toContain('Sin los asientos de regularización ni de cierre del ejercicio, como en el libro diario.');
    expect(r.tabla.notas).toContain('Apuntes de los asientos aprobados y de los que están en borrador, por fecha de asiento. Los asientos anulados no salen.');
    const b = await informeApuntes(E, await filtro({ estado: 'borradores' }));
    expect(b.tabla.notas).toContain('Apuntes de los asientos que están en borrador, por fecha de asiento. Los asientos anulados no salen.');
  });

  it('por la API: PDF y Excel con contabilidad:read; JSON paginado; errores claros', async () => {
    const app = (permisos: string[], companyId = E) => {
      const a = express();
      a.use((req, _res, next) => {
        req.user = { userId: 'u', email: 'u@test.local', roles: ['x'], companies: [companyId], rolesPorEmpresa: { [companyId]: ['x'] }, permisosPorEmpresa: { [companyId]: permisos } } as never;
        req.companyId = companyId;
        next();
      });
      a.use('/informes', informesContablesRoutes);
      a.use(errorMiddleware);
      return a;
    };
    const conta = app(['contabilidad:read']);

    const json = await request(conta).get('/informes/apuntes?ejercicio=2026&porPagina=5&pagina=1&estado=todos');
    expect(json.status).toBe(200);
    expect(json.body.data).toMatchObject({ pagina: 1, porPagina: 5, paginas: 5, totales: { apuntes: 21 }, movimientosAntiguos: 1 });
    expect(json.body.data.apuntes).toHaveLength(5);

    const pdf = await request(conta).get('/informes/apuntes?ejercicio=2026&formato=pdf').buffer(true).parse((res, cb) => {
      const trozos: Buffer[] = [];
      res.on('data', (c: Buffer) => trozos.push(c));
      res.on('end', () => cb(null, Buffer.concat(trozos)));
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toContain('apuntes_2026-01-01_2026-12-31.pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    const xlsx = await request(conta).get('/informes/apuntes?ejercicio=2026&cuenta=43&formato=xlsx');
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');

    // Sin permiso de contabilidad, 403; con datos mal puestos, 400 con el campo.
    expect((await request(app(['ventas:read'])).get('/informes/apuntes?ejercicio=2026')).status).toBe(403);
    const malos: Array<[string, string]> = [
      ['estado=raro', 'estado'],
      ['importeMin=500&importeMax=100', 'importeMin'],
      ['importeMin=-5', 'importeMin'],
      ['pagina=0', 'pagina'],
      ['porPagina=500', 'porPagina'],
      ['trimestre=5', 'trimestre'],
      ['desde=2026-02-30', 'desde'],
      ['desde=2026-05-01&hasta=2026-04-01', 'desde'],
    ];
    for (const [q, campo] of malos) {
      const r = await request(conta).get(`/informes/apuntes?ejercicio=2026&${q}`);
      expect([q, r.status]).toEqual([q, 400]);
      expect(r.body.details?.campo).toBe(campo);
    }
    expect((await request(conta).get('/informes/apuntes')).status).toBe(400);
    expect((await request(conta).get('/informes/apuntes?ejercicio=2026&formato=csv')).status).toBe(400);
    // El cliente de otra empresa: 404.
    expect((await request(conta).get(`/informes/apuntes?ejercicio=2026&tercero=${clienteDeF}&tipoTercero=cliente`)).status).toBe(404);
  });

  it('con demasiados apuntes, el PDF pide acotar o bajar el Excel; el Excel sí sale', async () => {
    const G = `apuntes-muchos-${SUF}`;
    await prisma.company.create({ data: { id: G, name: 'Muchos Apuntes SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    const a = await prisma.journalEntry.create({
      data: { companyId: G, fecha: new Date('2026-06-30T00:00:00Z'), numeroAsiento: 'AS-MUCHOS', descripcion: 'Remesa', origen: 'AJUSTE_MANUAL', estado: 'POSTED' },
    });
    await prisma.journalEntryLine.createMany({
      data: [
        ...Array.from({ length: 2000 }, () => ({ entryId: a.id, companyId: G, accountCode: '4300001', accountName: 'Clientes', debe: 1, haber: 0 })),
        { entryId: a.id, companyId: G, accountCode: '5720001', accountName: 'Bancos', debe: 0, haber: 2000 },
      ],
    });
    // El PDF admite 2.000: el exportador tarda unos 3,5 ms por fila y en Vercel más.
    expect(MAX_DESCARGA.pdf).toBe(2000);
    await expect(informeApuntes(G, await filtro({}, G), 'pdf')).rejects.toMatchObject({
      statusCode: 400,
      message: 'Hay 2.001 apuntes con este filtro y el PDF admite 2.000 como mucho. Acota el periodo (un trimestre o un mes) o añade un filtro, o descarga el Excel, que admite hasta 20.000.',
      details: { codigo: 'DEMASIADOS_APUNTES', apuntes: 2001, maximo: 2000 },
    });
    const excel = await informeApuntes(G, await filtro({}, G), 'xlsx');
    expect(excel.apuntes).toBe(2001);
    expect(excel.tabla.filas.at(-1)?.celdas).toEqual([null, null, null, null, 'Total (2.001 apuntes)', 2000, 2000]);
    // Acotado a la cuenta del banco, el PDF sí sale.
    expect((await informeApuntes(G, await filtro({ cuenta: '572' }, G), 'pdf')).apuntes).toBe(1);
  });
});

describe('regularización y cierre', () => {
  // Empresa aparte: un año cerrado (2026) y un año de la gestoría (2025).
  const H = `apuntes-cierre-${SUF}`;
  let cliente = '';
  const anio = (ejercicio: string, q: Record<string, unknown> = {}) => filtroApuntesDeConsulta(H, { ejercicio, ...q });
  const listaH = async (ejercicio: string, q: Record<string, unknown> = {}) => listarApuntes(H, await anio(ejercicio, q), { porPagina: 200 });

  beforeAll(async () => {
    await prisma.company.create({ data: { id: H, name: 'Cierre SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    await prisma.legalConfig.create({ data: { companyId: H, denominacion: 'Cierre SL', nif: 'B71000003' } });
    cliente = (await prisma.customer.create({ data: { companyId: H, nombreFiscal: 'Cliente Cierre SL', nifCif: 'B71000015', subcuenta430: '4300001' } })).id;
    const fv = await venta(H, 'hFv', cliente, 'A-1', '2026-03-10', 242);
    await asiento(H, 'hVenta', {
      fecha: '2026-03-10', numero: 'FAC-ING-A-1', concepto: 'Factura A-1', origen: 'FACTURA_INGRESO', invoiceId: fv, invoiceType: 'INGRESO',
      lineas: [['4300001', 'Clientes', 242, 0], ['700', 'Ventas', 0, 200], ['477', 'IVA repercutido', 0, 42]],
    });
    await asiento(H, 'hCobro', {
      fecha: '2026-06-10', numero: 'COBRO-00001', concepto: 'Cobro parcial factura A-1', origen: 'TESORERIA', invoiceId: fv, invoiceType: 'INGRESO',
      lineas: [['572', 'Bancos', 100, 0], ['4300001', 'Clientes', 0, 100]],
    });
    // Pago del 111 desde Nóminas.
    await asiento(H, 'hPago111', {
      fecha: '2026-07-20', numero: 'PAGO-00001', concepto: 'Pago modelo 111 2T/2026', origen: 'TESORERIA', invoiceId: '2026-2T', invoiceType: 'MODELO_111',
      lineas: [['4751', 'HP acreedora por retenciones', 15, 0], ['572', 'Bancos', 0, 15]],
    });
    await asiento(H, 'hGasto', {
      fecha: '2026-09-01', numero: 'AS-0001', concepto: 'Comisión bancaria', origen: 'AJUSTE_MANUAL',
      lineas: [['629', 'Otros servicios', 50, 0], ['572', 'Bancos', 0, 50]],
    });
    // El 31-12, el cierre se graba antes y su número va antes por orden alfabético; la regularización tiene que salir primero.
    await asiento(H, 'hCierre', {
      fecha: '2026-12-31', numero: 'CIERRE-2026', concepto: 'Cierre ejercicio 2026', origen: 'CIERRE',
      lineas: [['477', 'IVA repercutido', 42, 0], ['129', 'Resultado', 150, 0], ['4300001', 'Clientes', 0, 142], ['572', 'Bancos', 0, 35], ['4751', 'HP acreedora', 0, 15]],
    });
    await asiento(H, 'hRegul', {
      fecha: '2026-12-31', numero: 'REGUL-2026', concepto: 'Regularización ejercicio 2026', origen: 'REGULARIZACION',
      lineas: [['700', 'Ventas', 200, 0], ['629', 'Otros servicios', 0, 50], ['129', 'Resultado', 0, 150]],
    });
    // 2025, de la gestoría: apertura, un asiento suyo, su regularización y un cierre antiguo (reconocido por el concepto).
    await asiento(H, 'hAsiento2025', {
      fecha: '2025-01-01', numero: 'AAA-0001', concepto: 'Gasto del primer día', origen: 'AJUSTE_MANUAL',
      lineas: [['629', 'Otros servicios', 5, 0], ['572', 'Bancos', 0, 5]],
    });
    await asiento(H, 'hApertura2025', {
      fecha: '2025-01-01', numero: 'H-0001', concepto: 'Asiento de apertura', origen: 'HISTORICO_APERTURA',
      lineas: [['572', 'Bancos', 10, 0], ['100', 'Capital social', 0, 10]],
    });
    await asiento(H, 'hHistorico2025', {
      fecha: '2025-06-01', numero: 'H-0010', concepto: 'Comisión', origen: 'HISTORICO',
      lineas: [['629', 'Otros servicios', 1, 0], ['572', 'Bancos', 0, 1]],
    });
    await asiento(H, 'hCierre2025', {
      fecha: '2025-12-31', numero: 'AS-0099', concepto: 'Cierre ejercicio 2025', origen: 'AJUSTE_MANUAL',
      lineas: [['100', 'Capital social', 10, 0], ['572', 'Bancos', 0, 4], ['129', 'Resultado', 0, 6]],
    });
    await asiento(H, 'hRegul2025', {
      fecha: '2025-12-31', numero: 'H-0098', concepto: 'Asiento de regularización', origen: 'HISTORICO_REGULARIZACION',
      lineas: [['129', 'Resultado', 6, 0], ['629', 'Otros servicios', 0, 6]],
    });
  });

  it('por defecto no salen: la diferencia de una cuenta, de un cliente o de la 700 es lo que mueve en el mayor', async () => {
    const r = await listaH('2026');
    expect(r.apuntes.map(clave)).toEqual([
      'FAC-ING-A-1 4300001 242/0',
      'FAC-ING-A-1 700 0/200',
      'FAC-ING-A-1 477 0/42',
      'COBRO-00001 572 100/0',
      'COBRO-00001 4300001 0/100',
      'PAGO-00001 4751 15/0',
      'PAGO-00001 572 0/15',
      'AS-0001 629 50/0',
      'AS-0001 572 0/50',
    ]);
    expect(r.totales).toEqual({ apuntes: 9, debe: 407, haber: 407, diferencia: 0, enBorrador: 0, deCierre: 8 });
    expect(r.filtro.incluirCierre).toBe(false);

    const periodo = { desde: '2026-01-01', hasta: '2026-12-31', ejercicio: 2026 };
    // Lo que se mueve en el año según el mayor (Debe − Haber; el saldo inicial de 2025 aparte).
    const saldoMayor = async (cuenta: string) => {
      const c = (await informeMayor(H, periodo, { cuenta })).cuentas[0];
      return Math.round((c.totalDebe - c.totalHaber) * 100) / 100;
    };
    const banco = await listaH('2026', { cuenta: '572', estado: 'aprobados' });
    expect(banco.totales).toMatchObject({ debe: 100, haber: 65, diferencia: 35, deCierre: 1 });
    expect(banco.totales.diferencia).toBe(await saldoMayor('572'));
    const ventas = await listaH('2026', { cuenta: '700' });
    expect(ventas.totales.diferencia).toBe(-200);
    expect(ventas.totales.diferencia).toBe(await saldoMayor('700'));
    const delCliente = await listaH('2026', { tercero: cliente, tipoTercero: 'cliente' });
    expect(delCliente.totales).toMatchObject({ debe: 242, haber: 100, diferencia: 142, deCierre: 1 });
    expect(delCliente.totales.diferencia).toBe(await saldoMayor('4300001'));
    // El 4.º trimestre y diciembre, también sin ellos.
    expect((await listaH('2026', { trimestre: '4' })).totales).toMatchObject({ apuntes: 0, deCierre: 8 });
    expect((await listaH('2026', { mes: '12' })).apuntes).toEqual([]);
  });

  it('con incluirCierre salen marcados, la regularización antes que el cierre, igual que en el diario', async () => {
    const r = await listaH('2026', { incluirCierre: '1' });
    expect(r.apuntes.slice(-8).map(clave)).toEqual([
      'REGUL-2026 700 200/0',
      'REGUL-2026 629 0/50',
      'REGUL-2026 129 0/150',
      'CIERRE-2026 129 150/0',
      'CIERRE-2026 477 42/0',
      'CIERRE-2026 4300001 0/142',
      'CIERRE-2026 572 0/35',
      'CIERRE-2026 4751 0/15',
    ]);
    expect(r.totales).toMatchObject({ apuntes: 17, debe: 799, haber: 799, deCierre: 8 });
    expect(r.filtro.incluirCierre).toBe(true);
    expect(r.apuntes.find((a) => a.asiento === 'REGUL-2026')).toMatchObject({
      tipoAsiento: 'REGULARIZACION',
      documento: { tipo: 'REGULARIZACION', texto: 'Regularización', enlace: '/dashboard/contabilidad/cierre-ejercicio' },
    });
    expect(r.apuntes.find((a) => a.asiento === 'CIERRE-2026')?.tipoAsiento).toBe('CIERRE');
    expect(r.apuntes.find((a) => a.asiento === 'AS-0001')?.tipoAsiento).toBe('NORMAL');
    // Con el cierre, la cuenta queda a cero.
    expect((await listaH('2026', { cuenta: '572', incluirCierre: 'true' })).totales).toMatchObject({ diferencia: 0, deCierre: 1 });
    // El diario completo lleva el mismo orden el 31-12.
    const diario = await informeDiario(H, { desde: '2026-01-01', hasta: '2026-12-31', ejercicio: 2026 }, true);
    expect(diario.asientos.slice(-2).map((a) => a.numero)).toEqual(['REGUL-2026', 'CIERRE-2026']);
  });

  it('diario de la gestoría: la apertura la primera del día; la regularización y el cierre antiguos se reconocen y no enlazan al cierre de la app', async () => {
    const sin = await listaH('2025');
    expect(sin.apuntes.map((a) => a.asiento)).toEqual(['H-0001', 'H-0001', 'AAA-0001', 'AAA-0001', 'H-0010', 'H-0010']);
    expect(sin.totales).toMatchObject({ apuntes: 6, deCierre: 5 });
    expect(sin.apuntes[0]).toMatchObject({ tipoAsiento: 'APERTURA', documento: { tipo: 'APERTURA', texto: 'Apertura (diario de la gestoría)', enlace: null } });
    expect(sin.apuntes.find((a) => a.asiento === 'H-0010')?.documento).toEqual({ tipo: 'GESTORIA', texto: 'Diario de la gestoría', enlace: null });

    const con = await listaH('2025', { incluirCierre: 'si' });
    expect([...new Set(con.apuntes.map((a) => a.asiento))]).toEqual(['H-0001', 'AAA-0001', 'H-0010', 'H-0098', 'AS-0099']);
    expect(con.apuntes.find((a) => a.asiento === 'H-0098')).toMatchObject({
      tipoAsiento: 'REGULARIZACION',
      documento: { tipo: 'REGULARIZACION', texto: 'Regularización (diario de la gestoría)', enlace: null },
    });
    // Un cierre antiguo, grabado como asiento manual: se reconoce por el concepto, como en el diario.
    expect(con.apuntes.find((a) => a.asiento === 'AS-0099')).toMatchObject({ tipoAsiento: 'CIERRE', documento: { tipo: 'CIERRE' } });
  });

  it('el pago del modelo 111 desde Nóminas enlaza a Nóminas', async () => {
    const r = await listaH('2026', { cuenta: '4751' });
    expect(r.apuntes[0].documento).toEqual({ tipo: 'RETENCIONES', texto: 'Pago del modelo 111 2T/2026', enlace: '/dashboard/nominas' });
  });

  it('PDF y Excel: sin ellos lo dicen las notas; con ellos, el nombre delante del concepto', async () => {
    const sin = await informeApuntes(H, await anio('2026'));
    expect(sin.tabla.notas).toContain('Sin los asientos de regularización ni de cierre del ejercicio (8 apuntes con este filtro), como en el libro diario.');
    expect(sin.tabla.periodo).toBe('Ejercicio 2026');
    const con = await informeApuntes(H, await anio('2026', { incluirCierre: '1' }));
    expect(con.tabla.periodo).toBe('Ejercicio 2026 · con la regularización y el cierre');
    expect(con.tabla.notas?.some((n) => n.startsWith('Incluye la regularización y el cierre del ejercicio (8 apuntes)'))).toBe(true);
    // El concepto ya dice «Regularización…»: no se repite. El cierre antiguo de 2025 tampoco.
    expect(con.tabla.filas.find((f) => f.celdas[1] === 'REGUL-2026')?.celdas[4]).toBe('Regularización ejercicio 2026');
    const h2025 = await informeApuntes(H, await anio('2025', { incluirCierre: '1' }));
    expect(h2025.tabla.filas.find((f) => f.celdas[1] === 'H-0098')?.celdas[4]).toBe('Regularización: Asiento de regularización');
    expect(h2025.tabla.filas.find((f) => f.celdas[1] === 'AS-0099')?.celdas[4]).toBe('Cierre ejercicio 2025');
  });

  it('por la API: incluirCierre=1', async () => {
    const a = express();
    a.use((req, _res, next) => {
      req.user = { userId: 'u', email: 'u@test.local', roles: ['x'], companies: [H], rolesPorEmpresa: { [H]: ['x'] }, permisosPorEmpresa: { [H]: ['contabilidad:read'] } } as never;
      req.companyId = H;
      next();
    });
    a.use('/informes', informesContablesRoutes);
    a.use(errorMiddleware);
    const sin = await request(a).get('/informes/apuntes?ejercicio=2026');
    expect(sin.body.data.totales).toMatchObject({ apuntes: 9, deCierre: 8 });
    const con = await request(a).get('/informes/apuntes?ejercicio=2026&incluirCierre=1');
    expect(con.body.data.totales).toMatchObject({ apuntes: 17, deCierre: 8 });
    expect(con.body.data.filtro.incluirCierre).toBe(true);
  });
});
