/**
 * Mayor de un cliente o proveedor: las facturas que no salen en él (el mayor
 * solo cuenta asientos aprobados). El usuario lo vio con NZ004_26 el 13-10: el
 * mayor salía a cero y facturación decía 8.654,68 € pendientes, porque la
 * factura se quedó sin asiento. El detalle del tercero las devuelve con su id,
 * su estado (SIN_ASIENTO o BORRADOR) y el enlace para contabilizarlas o
 * aprobarlas, y lo dice en una nota (también en el PDF y el Excel).
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
import { facturasFueraDelMayor, informeDetalleTercero, informeMayor, terceroParaMayor } from '../services/informesContables.service';

const SUF = `${Date.now()}${randomBytes(3).toString('hex')}`;
const E = `mayor-fuera-${SUF}`;
const ANIO = { desde: '2026-01-01', hasta: '2026-12-31', ejercicio: 2026 };

const ids: Record<string, string> = {};
let n = 0;
let cliente = '';
let proveedor = '';

async function venta(clave: string, d: { fecha: string; total: number; estadoDocumento?: string; numero?: string; asientos?: Array<{ estado: string; origen?: string }> }) {
  const i = ++n;
  const f = await prisma.incomeInvoice.create({
    data: {
      companyId: E,
      customerId: cliente,
      serie: 'NZ',
      numero: d.estadoDocumento === 'BORRADOR' ? null : i,
      numeroCompleto: d.estadoDocumento === 'BORRADOR' ? null : (d.numero ?? `NZ-${i}`),
      estadoDocumento: d.estadoDocumento ?? 'FINAL',
      estado: d.estadoDocumento === 'BORRADOR' ? 'DRAFT' : 'PENDING',
      fechaEmision: d.fecha,
      fechaVencimiento: d.fecha,
      origen: 'lector',
      baseTotal: d.total,
      ivaTotal: 0,
      totalFactura: d.total,
    },
  });
  ids[clave] = f.id;
  for (const [k, a] of (d.asientos ?? []).entries()) {
    const asiento = await prisma.journalEntry.create({
      data: { companyId: E, fecha: new Date(`${d.fecha}T00:00:00Z`), numeroAsiento: `A-${clave}-${k}`, descripcion: clave, origen: a.origen ?? 'FACTURA_INGRESO', estado: a.estado, invoiceId: f.id, invoiceType: 'INGRESO' },
    });
    ids[`${clave}-asiento-${k}`] = asiento.id;
  }
}

async function gasto(clave: string, d: { fecha: string; total: number; estado: string; asiento?: string; fechaRegistro?: string }) {
  const i = ++n;
  const f = await prisma.expenseInvoice.create({
    data: {
      companyId: E,
      supplierId: proveedor,
      serie: 'G',
      numero: i,
      numeroCompleto: `G-${i}`,
      numeroFacturaProveedor: `PROV-${i}`,
      fechaEmision: d.fecha,
      fechaVencimiento: d.fecha,
      ...(d.fechaRegistro ? { fechaRegistro: d.fechaRegistro } : {}),
      estado: d.estado,
      tipoGasto: 'SUMINISTROS',
      baseTotal: d.total,
      ivaTotal: 0,
      totalFactura: d.total,
    },
  });
  ids[clave] = f.id;
  if (d.asiento) {
    const a = await prisma.journalEntry.create({
      data: { companyId: E, fecha: new Date(`${d.fecha}T00:00:00Z`), numeroAsiento: `G-${clave}`, descripcion: clave, origen: 'FACTURA_GASTO', estado: d.asiento, invoiceId: f.id, invoiceType: 'GASTO' },
    });
    ids[`${clave}-asiento`] = a.id;
  }
}

beforeAll(async () => {
  await prisma.company.create({ data: { id: E, name: 'Mayor Fuera SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: E, denominacion: 'Mayor Fuera SL', nif: 'B70000003' } });
  // 2025 lo llevó la gestoría: sus facturas no cuentan (su saldo entró con la apertura).
  await prisma.fiscalYear.create({ data: { companyId: E, label: '2025', fechaInicio: '2025-01-01', fechaFin: '2025-12-31', llevanza: 'EXTERNA' } });
  cliente = (await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'MANUEL EUSEBIO DIAZ', nifCif: '12345678Z' } })).id;
  proveedor = (await prisma.supplier.create({ data: { companyId: E, nombreFiscal: 'Proveedor Fuera SL', nifCif: 'B70000004' } })).id;

  await venta('sinAsiento', { fecha: '2026-10-13', total: 8654.68, numero: 'NZ004_26' });
  await venta('borrador', { fecha: '2026-10-01', total: 121, asientos: [{ estado: 'DRAFT' }] });
  await venta('aprobada', { fecha: '2026-09-01', total: 242, asientos: [{ estado: 'POSTED' }] });
  await venta('anulado', { fecha: '2026-08-01', total: 50, asientos: [{ estado: 'REVERSED' }] });
  await venta('soloCobro', { fecha: '2026-07-01', total: 60, asientos: [{ estado: 'POSTED', origen: 'TESORERIA' }] });
  await venta('facturaBorrador', { fecha: '2026-06-01', total: 70, estadoDocumento: 'BORRADOR' });
  await venta('posterior', { fecha: '2027-01-10', total: 80 });
  await venta('deLaGestoria', { fecha: '2025-11-10', total: 90 });

  await gasto('lectorSinRevisar', { fecha: '2026-05-05', total: 30, estado: 'DRAFT', asiento: 'DRAFT' });
  await gasto('contabilizado', { fecha: '2026-05-06', total: 40, estado: 'ACCOUNTED', asiento: 'POSTED' });
  await gasto('sinAsientoGasto', { fecha: '2026-05-07', total: 45, estado: 'PENDING' });
  await gasto('anulada', { fecha: '2026-05-08', total: 50, estado: 'ANULADA' });
  // Factura de diciembre registrada en enero: cuenta en el mayor de 2027 (fecha de registro), no en el de 2026.
  await gasto('registradaEnEnero', { fecha: '2026-12-20', fechaRegistro: '2027-01-05', total: 55, estado: 'PENDING' });
});

describe('facturas que no salen en el mayor del tercero', () => {
  it('cliente: la que no tiene asiento (también con el asiento anulado o solo el del cobro) y la del asiento en borrador, con su enlace', async () => {
    const fuera = await facturasFueraDelMayor(E, 'clientes', cliente, ANIO.hasta);
    expect(fuera.map((f) => f.id).sort()).toEqual([ids.sinAsiento, ids.borrador, ids.anulado, ids.soloCobro].sort());
    expect(fuera.find((f) => f.id === ids.sinAsiento)).toEqual({
      id: ids.sinAsiento,
      tipo: 'venta',
      numeroCompleto: 'NZ004_26',
      fechaEmision: '2026-10-13',
      totalFactura: 8654.68,
      estadoContable: 'SIN_ASIENTO',
      asientoId: null,
      accion: 'CONTABILIZAR',
      enlace: `/dashboard/facturas/${ids.sinAsiento}`,
    });
    expect(fuera.find((f) => f.id === ids.borrador)).toMatchObject({
      estadoContable: 'BORRADOR',
      asientoId: ids['borrador-asiento-0'],
      accion: 'APROBAR',
      enlace: `/dashboard/motor-contable/${ids['borrador-asiento-0']}`,
    });
    expect(fuera.find((f) => f.id === ids.anulado)).toMatchObject({ estadoContable: 'SIN_ASIENTO' });
    expect(fuera.find((f) => f.id === ids.soloCobro)).toMatchObject({ estadoContable: 'SIN_ASIENTO' });
  });

  it('proveedor: la del lector sin revisar (asiento en borrador) y la que no tiene asiento; sin las anuladas', async () => {
    const fuera = await facturasFueraDelMayor(E, 'proveedores', proveedor, ANIO.hasta);
    expect(fuera.map((f) => [f.id, f.estadoContable, f.numeroCompleto])).toEqual([
      [ids.lectorSinRevisar, 'BORRADOR', expect.stringMatching(/^PROV-/)],
      [ids.sinAsientoGasto, 'SIN_ASIENTO', expect.stringMatching(/^PROV-/)],
    ]);
    expect(fuera[1].enlace).toBe(`/dashboard/compras/${ids.sinAsientoGasto}`);
  });

  it('proveedor: un gasto cuenta por su fecha de registro (el de diciembre registrado en enero sale en el mayor del año siguiente)', async () => {
    const en2026 = await facturasFueraDelMayor(E, 'proveedores', proveedor, '2026-12-31');
    expect(en2026.map((f) => f.id)).not.toContain(ids.registradaEnEnero);
    const en2027 = await facturasFueraDelMayor(E, 'proveedores', proveedor, '2027-12-31');
    expect(en2027.find((f) => f.id === ids.registradaEnEnero)).toMatchObject({ estadoContable: 'SIN_ASIENTO', accion: 'CONTABILIZAR', fechaEmision: '2026-12-20' });
  });

  it('el Libro mayor de un cliente o proveedor (con su subcuenta) también las devuelve y lo dice; el de una cuenta, no', async () => {
    const r = await informeMayor(E, ANIO, {}, await terceroParaMayor(E, 'cliente', cliente));
    expect(r.facturasFueraDelMayor?.map((f) => f.id).sort()).toEqual([ids.sinAsiento, ids.borrador, ids.anulado, ids.soloCobro].sort());
    expect(r.tabla.notas?.some((x) => x.startsWith('4 facturas no salen en este mayor'))).toBe(true);
    const p = await informeMayor(E, ANIO, {}, await terceroParaMayor(E, 'proveedor', proveedor));
    expect(p.facturasFueraDelMayor?.map((f) => f.estadoContable)).toEqual(['BORRADOR', 'SIN_ASIENTO']);
    const cuenta = await informeMayor(E, ANIO, { cuenta: '430' });
    expect(cuenta).not.toHaveProperty('facturasFueraDelMayor');
    expect(cuenta.tabla.notas?.some((x) => x.includes('no salen en este mayor'))).toBe(false);
  });

  it('el detalle del tercero las devuelve y lo explica en una nota', async () => {
    const r = await informeDetalleTercero(E, 'clientes', ANIO, cliente);
    expect(r.tercero.saldoFinal).toBe(0);
    expect(r.facturasFueraDelMayor).toHaveLength(4);
    const nota = r.tabla.notas?.find((x) => x.includes('no salen en este mayor'));
    expect(nota).toMatch(/^4 facturas no salen en este mayor, que solo cuenta los asientos aprobados\. Sin asiento: .*NZ004_26 \(8\.654,68\u00a0€\).*; contabilízalas desde la factura\. Con el asiento en borrador: .*; apruébalo en el Motor contable\.$/);
    // Sin facturas fuera, ni la lista ni la nota.
    const otro = await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Sin Facturas SL', nifCif: 'B70000005' } });
    const vacio = await informeDetalleTercero(E, 'clientes', ANIO, otro.id);
    expect(vacio.facturasFueraDelMayor).toEqual([]);
    expect(vacio.tabla.notas?.some((x) => x.includes('no salen en este mayor'))).toBe(false);
  });

  it('por la API (GET /terceros/clientes/:id) con contabilidad:read', async () => {
    const a = express();
    a.use((req, _res, next) => {
      req.user = { userId: 'u', email: 'u@test.local', roles: ['x'], companies: [E], rolesPorEmpresa: { [E]: ['x'] }, permisosPorEmpresa: { [E]: ['contabilidad:read'] } } as never;
      req.companyId = E;
      next();
    });
    a.use('/informes', informesContablesRoutes);
    a.use(errorMiddleware);
    const r = await request(a).get(`/informes/terceros/clientes/${cliente}?desde=2026-01-01&hasta=2026-12-31`);
    expect(r.status).toBe(200);
    expect((r.body.data.facturasFueraDelMayor as Array<{ id: string; estadoContable: string }>).find((f) => f.id === ids.sinAsiento)).toMatchObject({ estadoContable: 'SIN_ASIENTO' });
    // Libro mayor con el cliente (GET /mayor?tercero=&tipoTercero=cliente): lo mismo.
    const m = await request(a).get(`/informes/mayor?tercero=${cliente}&tipoTercero=cliente&desde=2026-01-01&hasta=2026-12-31`);
    expect(m.status).toBe(200);
    expect((m.body.data.facturasFueraDelMayor as Array<{ id: string; accion: string }>).find((f) => f.id === ids.borrador)).toMatchObject({ accion: 'APROBAR' });
  });
});
