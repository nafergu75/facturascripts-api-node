/**
 * Alta de facturas de gasto desde el panel (POST /expense-invoices) sobre BD
 * real: la factura nace con su asiento en firme, su libro de IVA (con el
 * numero del proveedor) y su libro de retenciones, y el libro, la 472 y los
 * dos 303 cuadran. Duplicados, proveedor nuevo, periodo cerrado, fecha de
 * registro y permisos de lectura.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import * as supplierAudit from '../services/suppliers/supplierAudit.service';
import { exigirPlanAnteriorAntesDeAlta } from '../services/terceros/planAnteriorAlta';
import expenseInvoicesRoutes from '../routes/expense-invoices.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { cambiarEstadoPeriodo } from '../services/periodos.service';
import { controlCif } from '../utils/nif';
import { esperarCuadre } from './ayuda-cuadre-recibidas';

const SUFIJO = `${Date.now()}`;
let n = 0;

/** CIF valido distinto en cada llamada. */
export function cifValido(): string {
  const siete = String(1000000 + ((Date.now() + n++ * 7919) % 8999999)).slice(0, 7);
  return `B${siete}${controlCif(siete).cifra}`;
}

async function nuevaEmpresa(nombre: string): Promise<string> {
  const id = `compras-alta-${nombre}-${SUFIJO}`;
  await prisma.company.create({ data: { id, name: `Compras ${nombre} SL`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: id, denominacion: `Compras ${nombre} SL`, nif: 'B10000000' } });
  // Empresa nueva sin plan de la gestoria: se confirma de antemano el aviso del primer cliente o proveedor.
  await exigirPlanAnteriorAntesDeAlta(id, true, 'test');
  return id;
}

async function proveedor(companyId: string, nombre = 'Asesoría Pérez SL') {
  return (await prisma.supplier.create({ data: { companyId, nombreFiscal: nombre, nifCif: cifValido() } })).id;
}

function app(companyId: string, rol = 'contable') {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { userId: `u-${rol}`, email: `${rol}@test.local`, roles: [rol], companies: [companyId], rolesPorEmpresa: { [companyId]: [rol] } } as never;
    req.companyId = companyId;
    next();
  });
  a.use('/expense-invoices', expenseInvoicesRoutes);
  a.use(errorMiddleware);
  return a;
}

const profesional = (supplierId: string, extra: Record<string, unknown> = {}) => ({
  proveedor: { id: supplierId },
  numeroFacturaProveedor: 'F2026/0012',
  fechaEmision: '2026-04-03',
  tipoGasto: 'SERVICIO_PROFESIONAL',
  lineas: [{ descripcion: 'Asesoría abril', cantidad: 1, precioUnitario: 1000, tipoIva: 21, tipoRetencion: 15 }],
  ...extra,
});

const porCuenta = (lineas: Array<{ accountCode: string; debe: number; haber: number }>) =>
  Object.fromEntries(lineas.map((l) => [l.accountCode, [l.debe, l.haber]]));

async function contar(companyId: string) {
  return {
    facturas: await prisma.expenseInvoice.count({ where: { companyId } }),
    asientos: await prisma.journalEntry.count({ where: { companyId } }),
    libro: await prisma.vATBook.count({ where: { companyId } }),
    proveedores: await prisma.supplier.count({ where: { companyId } }),
  };
}

describe('alta de una factura de un profesional', () => {
  let E: string;
  let sup: string;
  let res: request.Response;

  beforeAll(async () => {
    E = await nuevaEmpresa('prof');
    sup = await proveedor(E);
    res = await request(app(E)).post('/expense-invoices').send(profesional(sup));
  });

  it('201 con la factura contabilizada y su asiento en firme', () => {
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      numeroCompleto: 'G-1',
      numeroFacturaProveedor: 'F2026/0012',
      estado: 'ACCOUNTED',
      estadoTexto: 'Contabilizada',
      estadoPago: 'PENDIENTE',
      baseTotal: 1000,
      ivaTotal: 210,
      retencionTotal: 150,
      totalFactura: 1060,
      tipoIva: 21,
      tipoRetencion: 15,
      asiento: { numeroAsiento: 'FAC-GAST-G-1', estado: 'POSTED', fecha: '2026-04-03' },
      acciones: { editar: { permitido: true }, anular: { permitido: true, conContraasiento: false }, contabilizar: false },
    });
    // Un solo sobre: { ok, data: GastoDetalle }.
    expect(res.body.data.data).toBeUndefined();
  });

  it('asiento 623 D 1000 / 472 D 210 / 4751 H 150 / 410 H 1060', async () => {
    const a = await prisma.journalEntry.findUniqueOrThrow({ where: { id: res.body.data.asiento.id }, include: { lineas: true } });
    expect(porCuenta(a.lineas)).toEqual({ '623': [1000, 0], '472': [210, 0], '4751': [0, 150], '41000001': [0, 1060] });
    expect(a).toMatchObject({ origen: 'FACTURA_GASTO', invoiceType: 'GASTO', invoiceId: res.body.data.id });
  });

  it('libro de IVA con el numero interno y el del proveedor, y libro de retenciones PROFESIONAL al 15 %', async () => {
    const libro = await prisma.vATBook.findMany({ where: { companyId: E } });
    expect(libro).toHaveLength(1);
    expect(libro[0]).toMatchObject({ tipoLibro: 'RECIBIDAS', numeroFactura: 'G-1', numeroFacturaEmisor: 'F2026/0012', baseImponible: 1000, cuotaIva: 210, tipoIva: 21 });
    const ret = await prisma.retentionBook.findMany({ where: { companyId: E } });
    expect(ret).toHaveLength(1);
    expect(ret[0]).toMatchObject({ tipoRetencionNombre: 'PROFESIONAL', porcentajeRetencion: 15, baseImponible: 1000, cuotaRetencion: 150, ano: 2026, mes: 4 });
  });

  it('el libro, la 472 y los dos 303 cuadran', async () => {
    await esperarCuadre(expect, E, 2026, 2, 210, 1000);
  });

  it('la lista la devuelve con sus contadores', async () => {
    const r = await request(app(E)).get('/expense-invoices');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ total: 1, page: 1, limit: 25, contadores: { todas: 1, contabilizadas: 1 } });
    expect(r.body.data.items[0]).toMatchObject({ numeroCompleto: 'G-1', numeroFacturaProveedor: 'F2026/0012', estadoTexto: 'Contabilizada', importePendiente: 1060 });
  });
});

describe('alta de una compra con IVA al 21 % y al 10 %', () => {
  it('600 y la 400, dos lineas 472, dos filas del libro, y cuadra', async () => {
    const E = await nuevaEmpresa('compra');
    const sup = await proveedor(E, 'Mayorista SA');
    const r = await request(app(E))
      .post('/expense-invoices')
      .send({
        proveedor: { id: sup },
        numeroFacturaProveedor: 'A-77',
        fechaEmision: '2026-05-10',
        tipoGasto: 'COMPRA',
        lineas: [
          { descripcion: 'Género', cantidad: 2, precioUnitario: 500, tipoIva: 21 },
          { descripcion: 'Alimentación', cantidad: 1, precioUnitario: 300, tipoIva: 10 },
        ],
        totalDocumento: 1540,
      });
    expect(r.status).toBe(201);
    const a = await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.body.data.asiento.id }, include: { lineas: true } });
    expect(a.lineas.filter((l) => l.accountCode === '472').map((l) => l.debe).sort((x, y) => x - y)).toEqual([30, 210]);
    expect(a.lineas.find((l) => l.accountCode === '600')?.debe).toBe(1300);
    expect(a.lineas.find((l) => l.accountCode === '40000001')?.haber).toBe(1540);
    expect(await prisma.vATBook.count({ where: { companyId: E } })).toBe(2);
    await esperarCuadre(expect, E, 2026, 2, 240, 1300);
  });
});

describe('proveedor nuevo con la factura', () => {
  let E: string;
  beforeAll(async () => {
    E = await nuevaEmpresa('nuevo');
  });

  it('se crea el proveedor, con su entrada en el historial', async () => {
    const nif = cifValido();
    const r = await request(app(E))
      .post('/expense-invoices')
      .send({ ...profesional('x'), proveedor: { nuevo: { nombreFiscal: 'Gestoría Nueva SL', nifCif: nif.toLowerCase(), cp: '46001', provincia: 'Valencia' } } });
    expect(r.status).toBe(201);
    const s = await prisma.supplier.findFirstOrThrow({ where: { companyId: E, nifCif: nif } });
    expect(s).toMatchObject({ nombreFiscal: 'Gestoría Nueva SL', pais: 'ES', cp: '46001' });
    expect(r.body.data.supplier).toMatchObject({ id: s.id, nifCif: nif });
    expect(await prisma.supplierAudit.count({ where: { supplierId: s.id, tipoAccion: 'create' } })).toBe(1);
  });

  it('si la base de datos falla al anotar el alta en el historial del proveedor, la factura se registra igual', async () => {
    const espia = jest
      .spyOn(supplierAudit, 'logCreate')
      .mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection from the connection pool.', { code: 'P2024', clientVersion: Prisma.prismaVersion.client }));
    const nif = cifValido();
    const r = await request(app(E))
      .post('/expense-invoices')
      .send({ ...profesional('x'), numeroFacturaProveedor: 'HIST-1', proveedor: { nuevo: { nombreFiscal: 'Historial Caído SL', nifCif: nif } } });
    espia.mockRestore();
    expect(r.status).toBe(201);
    const s = await prisma.supplier.findFirstOrThrow({ where: { companyId: E, nifCif: nif } });
    expect(await prisma.expenseInvoice.count({ where: { companyId: E, supplierId: s.id, numeroFacturaProveedor: 'HIST-1' } })).toBe(1);
  });

  it('si el NIF ya existe: 409 con el proveedor, y no se crea nada', async () => {
    const nif = cifValido();
    const ya = await prisma.supplier.create({ data: { companyId: E, nombreFiscal: 'Ya Existe SL', nifCif: nif } });
    const antes = await contar(E);
    const r = await request(app(E))
      .post('/expense-invoices')
      .send({ ...profesional('x'), numeroFacturaProveedor: 'OTRA-1', proveedor: { nuevo: { nombreFiscal: 'Repetido SL', nifCif: nif } } });
    expect(r.status).toBe(409);
    expect(r.body.message).toBe('Ya existe un proveedor con ese NIF: Ya Existe SL');
    expect(r.body.details).toMatchObject({ campo: 'proveedor.nifCif', proveedorId: ya.id });
    expect(await contar(E)).toEqual(antes);
  });

  it('un NIF español mal escrito: 400 en el campo del proveedor', async () => {
    const r = await request(app(E))
      .post('/expense-invoices')
      .send({ ...profesional('x'), numeroFacturaProveedor: 'OTRA-2', proveedor: { nuevo: { nombreFiscal: 'Mal SL', nifCif: 'B12345678' } } });
    expect(r.status).toBe(400);
    expect(r.body.details.campo).toBe('proveedor.nifCif');
  });
});

describe('duplicados', () => {
  it('mismo proveedor y numero (aunque se escriba distinto): 409; otro proveedor: 201', async () => {
    const E = await nuevaEmpresa('dup');
    const sup = await proveedor(E);
    const otro = await proveedor(E, 'Otro Proveedor SL');
    const primera = await request(app(E)).post('/expense-invoices').send(profesional(sup));
    expect(primera.status).toBe(201);
    const antes = await contar(E);
    const r = await request(app(E)).post('/expense-invoices').send(profesional(sup, { numeroFacturaProveedor: ' f2026/0012 ' }));
    expect(r.status).toBe(409);
    expect(r.body.message).toBe('Esta factura ya está registrada: Asesoría Pérez SL, nº F2026/0012 (registro G-1).');
    expect(r.body.details).toEqual({ campo: 'numeroFacturaProveedor', facturaId: primera.body.data.id });
    expect(await contar(E)).toEqual(antes);
    const otra = await request(app(E)).post('/expense-invoices').send(profesional(otro));
    expect(otra.status).toBe(201);
    expect(otra.body.data.numeroCompleto).toBe('G-2');
  });
});

describe('periodo cerrado', () => {
  it('400 y no se crea nada', async () => {
    const E = await nuevaEmpresa('cerrado');
    const sup = await proveedor(E);
    await cambiarEstadoPeriodo(E, 2026, 3, 'cerrado');
    const antes = await contar(E);
    const r = await request(app(E)).post('/expense-invoices').send(profesional(sup, { fechaEmision: '2026-03-15' }));
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/03\/2026 está cerrado/);
    expect(await contar(E)).toEqual(antes);
  });
});

describe('fecha de registro', () => {
  it('factura de marzo recibida en abril: asiento y libro en abril, con la fecha de expedicion anotada', async () => {
    const E = await nuevaEmpresa('registro');
    const sup = await proveedor(E);
    const r = await request(app(E)).post('/expense-invoices').send(profesional(sup, { fechaEmision: '2026-03-20', fechaRegistro: '2026-04-06' }));
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ fechaEmision: '2026-03-20', fechaRegistro: '2026-04-06', asiento: { fecha: '2026-04-06' } });
    const libro = await prisma.vATBook.findFirstOrThrow({ where: { companyId: E } });
    expect(libro.fechaFactura.toISOString().slice(0, 10)).toBe('2026-04-06');
    expect(libro.observaciones).toBe('Fecha de expedición: 20/03/2026');
    const ret = await prisma.retentionBook.findFirstOrThrow({ where: { companyId: E } });
    expect(ret.mes).toBe(4);
    // El IVA se deduce en el 2T (el de la fecha de registro), no en el 1T.
    await esperarCuadre(expect, E, 2026, 2, 210, 1000);
    await esperarCuadre(expect, E, 2026, 1, 0, 0);
  });
});

describe('permisos y empresa', () => {
  let E: string;
  let id: string;
  beforeAll(async () => {
    E = await nuevaEmpresa('permisos');
    const sup = await proveedor(E);
    id = (await request(app(E)).post('/expense-invoices').send(profesional(sup))).body.data.id;
  });

  it('un usuario de ventas (con contabilidad:read) ve la lista y la ficha, pero no da de alta', async () => {
    const ventas = app(E, 'ventas');
    expect((await request(ventas).get('/expense-invoices')).status).toBe(200);
    expect((await request(ventas).get(`/expense-invoices/${id}`)).status).toBe(200);
    expect((await request(ventas).post('/expense-invoices').send(profesional('x'))).status).toBe(403);
  });

  it('la factura de otra empresa: 404', async () => {
    const otra = await nuevaEmpresa('otra');
    const r = await request(app(otra)).get(`/expense-invoices/${id}`);
    expect(r.status).toBe(404);
    expect(r.body.message).toBe('Factura de gasto no encontrada.');
  });

  it('un proveedor de otra empresa: 404', async () => {
    const otra = await nuevaEmpresa('otra2');
    const supOtra = await proveedor(otra);
    const r = await request(app(E)).post('/expense-invoices').send(profesional(supOtra, { numeroFacturaProveedor: 'X-1' }));
    expect(r.status).toBe(404);
    expect(r.body.message).toBe('Proveedor no encontrado.');
  });
});

describe('empresa no establecida en España', () => {
  let E: string;
  let sup: string;
  beforeAll(async () => {
    E = `compras-alta-us-${SUFIJO}`;
    await prisma.company.create({ data: { id: E, name: 'Purchases Inc', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    await prisma.legalConfig.create({ data: { companyId: E, denominacion: 'Purchases Inc', nif: '12-3456789', pais: 'US', monedaCuenta: 'USD' } });
    sup = await proveedor(E);
  });

  it('con IVA o retención: 400 en la línea, sin factura ni libros', async () => {
    const r = await request(app(E, 'admin')).post('/expense-invoices').send(profesional(sup));
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/^La empresa no está establecida en España: sus facturas de gasto no llevan IVA español ni retención de IRPF/);
    expect(r.body.details).toMatchObject({ campo: 'lineas.0.tipoIva' });
    const soloRetencion = await request(app(E, 'admin'))
      .post('/expense-invoices')
      .send(profesional(sup, { lineas: [{ descripcion: 'Asesoría', cantidad: 1, precioUnitario: 1000, tipoIva: 0, tipoRetencion: 15 }] }));
    expect(soloRetencion.status).toBe(400);
    expect(soloRetencion.body.details).toMatchObject({ campo: 'lineas.0.tipoRetencion' });
    expect(await contar(E)).toMatchObject({ facturas: 0, asientos: 0, libro: 0 });
    expect(await prisma.retentionBook.count({ where: { companyId: E } })).toBe(0);
  });

  it('sin IVA ni retención: 201 con su asiento, sin libro de IVA ni de retenciones; y no se le puede poner IVA al modificarla', async () => {
    const sinImpuestos = { lineas: [{ descripcion: 'Asesoría', cantidad: 1, precioUnitario: 1000, tipoIva: 0, tipoRetencion: 0 }] };
    const r = await request(app(E, 'admin')).post('/expense-invoices').send(profesional(sup, sinImpuestos));
    expect(r.status).toBe(201);
    expect(await contar(E)).toMatchObject({ facturas: 1, asientos: 1, libro: 0 });
    expect(await prisma.retentionBook.count({ where: { companyId: E } })).toBe(0);
    const lineas = await prisma.journalEntryLine.findMany({ where: { entry: { companyId: E } } });
    expect(lineas.map((l) => l.accountCode).sort()).toEqual(['41000001', '623']);

    const put = await request(app(E, 'admin')).put(`/expense-invoices/${r.body.data.id}`).send(profesional(sup));
    expect(put.status).toBe(400);
    expect(put.body.details).toMatchObject({ campo: 'lineas.0.tipoIva' });
    expect(await prisma.vATBook.count({ where: { companyId: E } })).toBe(0);
  });
});
