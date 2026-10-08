/**
 * Corregir (PUT) y anular facturas de gasto sobre BD real, comprobando en cada
 * caso que el libro de IVA de recibidas, la 472 y los dos 303 siguen cuadrando
 * en cada trimestre:
 *  - con el periodo abierto se rehace el asiento (el anterior queda REVERSED);
 *  - un borrador del lector se rehace con el mismo numero;
 *  - con el periodo cerrado o el 303 presentado no se edita (409, anular);
 *  - anular con el periodo abierto: REVERSED y sin libros; con el periodo
 *    cerrado: contraasiento con fecha de la anulacion y filas negativas.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import expenseInvoicesRoutes from '../routes/expense-invoices.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { expenseInvoicesService } from '../services/expense-invoices.service';
import { cambiarEstadoPeriodo } from '../services/periodos.service';
import { registrarCobroFactura } from '../services/cobrosPagos.service';
import { calcularModelo111 } from '../services/impuestosCalculo.service';
import { periodoFiscal } from '../services/nominas/fiscal';
import { informeMayorTerceros, pendientesSegunFacturas } from '../services/informesContables.service';
import { controlCif } from '../utils/nif';
import { esperarCuadre } from './ayuda-cuadre-recibidas';

const SUFIJO = `${Date.now()}`;
let n = 0;
const cif = () => {
  const siete = String(3000000 + ((Date.now() + n++ * 15485863) % 6999999)).slice(0, 7);
  return `B${siete}${controlCif(siete).cifra}`;
};

async function nuevaEmpresa(nombre: string): Promise<string> {
  const id = `compras-corr-${nombre}-${SUFIJO}`;
  await prisma.company.create({ data: { id, name: `Corregir ${nombre} SL`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: id, denominacion: `Corregir ${nombre} SL`, nif: 'B10000000' } });
  return id;
}
const proveedor = async (companyId: string, nombre = 'Suministros Levante SL') =>
  (await prisma.supplier.create({ data: { companyId, nombreFiscal: nombre, nifCif: cif() } })).id;

function app(companyId: string) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { userId: 'u-corr', email: 'contable@test.local', roles: ['contable'], companies: [companyId], rolesPorEmpresa: { [companyId]: ['contable'] } } as never;
    req.companyId = companyId;
    next();
  });
  a.use('/expense-invoices', expenseInvoicesRoutes);
  a.use(errorMiddleware);
  return a;
}

const factura = (supplierId: string, extra: Record<string, unknown> = {}) => ({
  proveedor: { id: supplierId },
  numeroFacturaProveedor: 'S-100',
  fechaEmision: '2026-02-10',
  tipoGasto: 'SUMINISTROS',
  lineas: [{ descripcion: 'Luz', cantidad: 1, precioUnitario: 1000, tipoIva: 21 }],
  ...extra,
});
const profesional = (supplierId: string, extra: Record<string, unknown> = {}) =>
  factura(supplierId, {
    numeroFacturaProveedor: 'P-1',
    tipoGasto: 'SERVICIO_PROFESIONAL',
    lineas: [{ descripcion: 'Asesoría', cantidad: 1, precioUnitario: 1000, tipoIva: 21, tipoRetencion: 15 }],
    ...extra,
  });

async function alta(E: string, cuerpo: Record<string, unknown>) {
  const r = await request(app(E)).post('/expense-invoices').send(cuerpo);
  expect(r.status).toBe(201);
  return r.body.data as { id: string; numeroCompleto: string; asiento: { id: string; numeroAsiento: string } };
}

const asientosDe = (invoiceId: string) =>
  prisma.journalEntry.findMany({ where: { invoiceId, origen: 'FACTURA_GASTO' }, include: { lineas: true }, orderBy: { createdAt: 'asc' } });

async function banco(E: string) {
  return (await prisma.bankAccount.create({ data: { companyId: E, iban: `ES00${String(Date.now()).slice(-10)}${n++}`.padEnd(24, '0').slice(0, 24), bancoNombre: 'Banco', subcuentaCodigo: '5720001' } })).id;
}

describe('corregir con el periodo abierto', () => {
  it('se rehace el asiento (R1), el libro solo tiene la fila nueva y todo cuadra', async () => {
    const E = await nuevaEmpresa('abierto');
    const sup = await proveedor(E);
    const f = await alta(E, factura(sup));
    await esperarCuadre(expect, E, 2026, 1, 210, 1000);

    const r = await request(app(E))
      .put(`/expense-invoices/${f.id}`)
      .send(factura(sup, { lineas: [{ descripcion: 'Luz corregida', cantidad: 1, precioUnitario: 800, tipoIva: 10 }] }));
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ baseTotal: 800, ivaTotal: 80, totalFactura: 880, tipoIva: 10, estado: 'ACCOUNTED', asiento: { numeroAsiento: `FAC-GAST-${f.numeroCompleto}-R1`, estado: 'POSTED' } });

    const asientos = await asientosDe(f.id);
    expect(asientos.map((a) => [a.numeroAsiento, a.estado])).toEqual([
      [`FAC-GAST-${f.numeroCompleto}`, 'REVERSED'],
      [`FAC-GAST-${f.numeroCompleto}-R1`, 'POSTED'],
    ]);
    const libro = await prisma.vATBook.findMany({ where: { companyId: E } });
    expect(libro.map((l) => [l.cuotaIva, l.asientoId])).toEqual([[80, asientos[1].id]]);
    await esperarCuadre(expect, E, 2026, 1, 80, 800);
  });

  it('cambiando de trimestre: el 1T queda a cero y el 2T la lleva', async () => {
    const E = await nuevaEmpresa('trimestre');
    const sup = await proveedor(E);
    const f = await alta(E, factura(sup));
    const r = await request(app(E)).put(`/expense-invoices/${f.id}`).send(factura(sup, { fechaEmision: '2026-04-15' }));
    expect(r.status).toBe(200);
    await esperarCuadre(expect, E, 2026, 1, 0, 0);
    await esperarCuadre(expect, E, 2026, 2, 210, 1000);
  });

  it('un borrador del lector se rehace con el mismo numero y sin asientos anulados', async () => {
    const E = await nuevaEmpresa('borrador');
    const sup = await proveedor(E);
    const { factura: f, asientoId } = await expenseInvoicesService.registrarGasto(E, factura(sup), { contabilizar: 'DRAFT' });
    expect(f.estado).toBe('DRAFT');
    const r = await request(app(E)).put(`/expense-invoices/${f.id}`).send(factura(sup, { lineas: [{ descripcion: 'Luz', cantidad: 1, precioUnitario: 500, tipoIva: 21 }] }));
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ estado: 'DRAFT', baseTotal: 500, asiento: { numeroAsiento: `FAC-GAST-${f.numeroCompleto}`, estado: 'DRAFT' } });
    expect(r.body.data.asiento.id).not.toBe(asientoId);
    const asientos = await asientosDe(f.id);
    expect(asientos.map((a) => a.estado)).toEqual(['DRAFT']);
    expect(await prisma.journalEntry.count({ where: { id: asientoId } })).toBe(0);
    // Un borrador no cuenta en el IVA hasta aprobarlo.
    await esperarCuadre(expect, E, 2026, 1, 0, 0);
  });
});

describe('cuando no se puede corregir', () => {
  let E: string;
  let sup: string;
  beforeAll(async () => {
    E = await nuevaEmpresa('nopuede');
    sup = await proveedor(E);
  });

  it('con pagos activos: 409', async () => {
    const f = await alta(E, factura(sup, { numeroFacturaProveedor: 'PAG-1', fechaEmision: '2026-05-04' }));
    await registrarCobroFactura(E, 'GASTO', f.id, { fecha: '2026-05-05', importe: 100, cuentaBancariaId: await banco(E) });
    const r = await request(app(E)).put(`/expense-invoices/${f.id}`).send(factura(sup, { numeroFacturaProveedor: 'PAG-1', fechaEmision: '2026-05-04' }));
    expect(r.status).toBe(409);
    expect(r.body.message).toBe('La factura tiene pagos registrados: anúlalos antes de modificarla.');
    const ficha = await request(app(E)).get(`/expense-invoices/${f.id}`);
    expect(ficha.body.data.acciones.editar).toEqual({ permitido: false, motivo: 'La factura tiene pagos registrados: anúlalos antes de modificarla.' });
    expect(ficha.body.data).toMatchObject({ importePagado: 100, importePendiente: 1110, estadoPago: 'PARCIAL' });
  });

  it('con el periodo cerrado: 409 que pide anular', async () => {
    const f = await alta(E, factura(sup, { numeroFacturaProveedor: 'CER-1', fechaEmision: '2026-06-03' }));
    await cambiarEstadoPeriodo(E, 2026, 6, 'cerrado');
    try {
      const r = await request(app(E)).put(`/expense-invoices/${f.id}`).send(factura(sup, { numeroFacturaProveedor: 'CER-1', fechaEmision: '2026-06-03' }));
      expect(r.status).toBe(409);
      expect(r.body.message).toMatch(/^El periodo de 06\/2026 está cerrado: esta factura ya no se puede modificar\. Anúlala/);
      expect(r.body.details).toEqual({ accion: 'anular' });
      const ficha = await request(app(E)).get(`/expense-invoices/${f.id}`);
      expect(ficha.body.data.acciones).toMatchObject({ editar: { permitido: false }, anular: { permitido: true, conContraasiento: true } });
    } finally {
      await cambiarEstadoPeriodo(E, 2026, 6, 'abierto');
    }
  });

  it('con el 303 del trimestre presentado: 409', async () => {
    const f = await alta(E, factura(sup, { numeroFacturaProveedor: 'PRE-1', fechaEmision: '2026-08-03' }));
    await prisma.modeloImpuesto.create({ data: { companyId: E, codigo: '303', ejercicio: 2026, periodo: '3T', estado: 'presentado' } });
    const r = await request(app(E)).put(`/expense-invoices/${f.id}`).send(factura(sup, { numeroFacturaProveedor: 'PRE-1', fechaEmision: '2026-08-03' }));
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/^El 303 del 3T de 2026 ya está presentado: esta factura ya no se puede modificar/);
    expect(r.body.details).toEqual({ accion: 'anular' });
  });

  it('una anulada: 409', async () => {
    const f = await alta(E, factura(sup, { numeroFacturaProveedor: 'ANU-1', fechaEmision: '2026-10-01' }));
    await expenseInvoicesService.anularGasto(E, f.id, { motivo: 'Repetida' });
    const r = await request(app(E)).put(`/expense-invoices/${f.id}`).send(factura(sup, { numeroFacturaProveedor: 'ANU-1', fechaEmision: '2026-10-01' }));
    expect(r.status).toBe(409);
    expect(r.body.message).toBe('La factura está anulada: no se puede modificar.');
  });
});

describe('anular con el periodo abierto', () => {
  it('el asiento queda REVERSED, sin libros, y se puede volver a registrar el mismo numero', async () => {
    const E = await nuevaEmpresa('anular-abierto');
    const sup = await proveedor(E);
    const f = await alta(E, profesional(sup));
    const r = await request(app(E)).post(`/expense-invoices/${f.id}/anular`).send({ motivo: 'El proveedor la anuló' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ contraasiento: false, asientoAnulacionId: null, factura: { estado: 'ANULADA', estadoTexto: 'Anulada', anulacion: { motivo: 'El proveedor la anuló', contraasientoId: null } } });
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: f.asiento.id } })).estado).toBe('REVERSED');
    expect(await prisma.vATBook.count({ where: { companyId: E } })).toBe(0);
    expect(await prisma.retentionBook.count({ where: { companyId: E } })).toBe(0);
    expect((await prisma.expenseInvoice.findUniqueOrThrow({ where: { id: f.id } })).numeroProveedorActivo).toBeNull();
    await esperarCuadre(expect, E, 2026, 1, 0, 0);
    expect((await calcularModelo111(E, periodoFiscal(2026, '1T'))).retencionesActividades).toBe(0);

    const otra = await request(app(E)).post('/expense-invoices').send(profesional(sup));
    expect(otra.status).toBe(201);
    await esperarCuadre(expect, E, 2026, 1, 210, 1000);
  });
});

describe('anular con el periodo cerrado', () => {
  let E: string;
  let sup: string;
  let f: Awaited<ReturnType<typeof alta>>;
  let r: request.Response;

  beforeAll(async () => {
    E = await nuevaEmpresa('anular-cerrado');
    sup = await proveedor(E);
    f = await alta(E, profesional(sup, { fechaEmision: '2026-01-15' }));
    await cambiarEstadoPeriodo(E, 2026, 1, 'cerrado');
    r = await request(app(E)).post(`/expense-invoices/${f.id}/anular`).send({ motivo: 'Factura emitida por error', fecha: '2026-04-05' });
  });

  it('contraasiento POSTED en abril con las lineas invertidas; el original sigue POSTED', async () => {
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ contraasiento: true, factura: { estado: 'ANULADA', anulacion: { fecha: '2026-04-05' } } });
    const contra = await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.body.data.asientoAnulacionId }, include: { lineas: true } });
    expect(contra).toMatchObject({ numeroAsiento: `FAC-GAST-${f.numeroCompleto}-ANUL`, estado: 'POSTED', origen: 'FACTURA_GASTO', invoiceId: f.id, invoiceType: 'GASTO' });
    expect(contra.fecha.toISOString().slice(0, 10)).toBe('2026-04-05');
    expect(contra.descripcion).toBe(`Anulación de la factura P-1 (registro ${f.numeroCompleto}): Factura emitida por error`);
    expect(Object.fromEntries(contra.lineas.map((l) => [l.accountCode, [l.debe, l.haber]]))).toEqual({ '623': [0, 1000], '472': [0, 210], '4751': [150, 0], '410': [1060, 0] });
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: f.asiento.id } })).estado).toBe('POSTED');
  });

  it('filas negativas en el libro de IVA y en el de retenciones', async () => {
    const neg = await prisma.vATBook.findFirstOrThrow({ where: { companyId: E, numeroFactura: `${f.numeroCompleto}-ANUL` } });
    expect(neg).toMatchObject({ baseImponible: -1000, cuotaIva: -210, numeroFacturaEmisor: 'P-1', observaciones: 'Anulación de la factura del 15/01/2026' });
    expect(neg.fechaFactura.toISOString().slice(0, 10)).toBe('2026-04-05');
    const ret = await prisma.retentionBook.findMany({ where: { companyId: E }, orderBy: { mes: 'asc' } });
    expect(ret.map((x) => [x.mes, x.cuotaRetencion, x.baseImponible])).toEqual([[1, 150, 1000], [4, -150, -1000]]);
  });

  it('el 1T cuadra con la cuota original y el 2T con la misma en negativo; el 111 (sin presentar) no la cuenta en ninguno', async () => {
    await esperarCuadre(expect, E, 2026, 1, 210, 1000);
    await esperarCuadre(expect, E, 2026, 2, -210, -1000);
    // El 111 no admite negativos ni compensa entre trimestres: una anulada no resta.
    expect((await calcularModelo111(E, periodoFiscal(2026, '1T'))).retencionesActividades).toBe(0);
    expect((await calcularModelo111(E, periodoFiscal(2026, '2T'))).retencionesActividades).toBe(0);
  });

  it('el proveedor queda a cero en la 410 y la factura no esta pendiente', async () => {
    const m = await informeMayorTerceros(E, 'proveedores', { desde: '2026-01-01', hasta: '2026-12-31', ejercicio: 2026 });
    expect(m.terceros.find((t) => t.id === sup)).toMatchObject({ debe: 1060, haber: 1060, saldoFinal: 0, pendienteFacturas: 0 });
    expect((await pendientesSegunFacturas(E, 'proveedores', '2026-12-31')).some((p) => p.id === f.id)).toBe(false);
  });
});

describe('anular: errores', () => {
  let E: string;
  let sup: string;
  beforeAll(async () => {
    E = await nuevaEmpresa('anular-errores');
    sup = await proveedor(E);
  });

  it('sin motivo: 400; dos veces: 409', async () => {
    const f = await alta(E, factura(sup, { numeroFacturaProveedor: 'E-1', fechaEmision: '2026-03-02' }));
    const sin = await request(app(E)).post(`/expense-invoices/${f.id}/anular`).send({});
    expect(sin.status).toBe(400);
    expect(sin.body.message).toBe('Indica el motivo de la anulación.');
    expect((await request(app(E)).post(`/expense-invoices/${f.id}/anular`).send({ motivo: 'Repetida' })).status).toBe(200);
    const otra = await request(app(E)).post(`/expense-invoices/${f.id}/anular`).send({ motivo: 'Repetida' });
    expect(otra.status).toBe(409);
    expect(otra.body.message).toBe('La factura ya está anulada.');
  });

  it('con pagos: 409', async () => {
    const f = await alta(E, factura(sup, { numeroFacturaProveedor: 'E-2', fechaEmision: '2026-03-02' }));
    await registrarCobroFactura(E, 'GASTO', f.id, { fecha: '2026-03-03', importe: 10, cuentaBancariaId: await banco(E) });
    const r = await request(app(E)).post(`/expense-invoices/${f.id}/anular`).send({ motivo: 'Repetida' });
    expect(r.status).toBe(409);
  });

  it('con una fecha de anulacion cerrada (400) o declarada (409), nada cambia', async () => {
    const f = await alta(E, factura(sup, { numeroFacturaProveedor: 'E-3', fechaEmision: '2026-05-02' }));
    await cambiarEstadoPeriodo(E, 2026, 5, 'cerrado');
    await cambiarEstadoPeriodo(E, 2026, 7, 'cerrado');
    await prisma.modeloImpuesto.create({ data: { companyId: E, codigo: '303', ejercicio: 2026, periodo: '4T', estado: 'presentado' } });
    try {
      const antes = { asientos: await prisma.journalEntry.count({ where: { companyId: E } }), libro: await prisma.vATBook.count({ where: { companyId: E } }) };
      const cerrada = await request(app(E)).post(`/expense-invoices/${f.id}/anular`).send({ motivo: 'Error', fecha: '2026-07-10' });
      expect(cerrada.status).toBe(400);
      const declarada = await request(app(E)).post(`/expense-invoices/${f.id}/anular`).send({ motivo: 'Error', fecha: '2026-10-10' });
      expect(declarada.status).toBe(409);
      expect(declarada.body.message).toBe('El 303 del 4T de 2026 ya está presentado: elige una fecha de anulación de un periodo abierto.');
      expect((await prisma.expenseInvoice.findUniqueOrThrow({ where: { id: f.id } })).estado).toBe('ACCOUNTED');
      expect({ asientos: await prisma.journalEntry.count({ where: { companyId: E } }), libro: await prisma.vATBook.count({ where: { companyId: E } }) }).toEqual(antes);
    } finally {
      await cambiarEstadoPeriodo(E, 2026, 5, 'abierto');
      await cambiarEstadoPeriodo(E, 2026, 7, 'abierto');
    }
  });

  it('anular con el periodo abierto deja al proveedor a cero', async () => {
    const otro = await proveedor(E, 'Acreedor Cero SL');
    const f = await alta(E, factura(otro, { numeroFacturaProveedor: 'Z-1', fechaEmision: '2026-09-01' }));
    await expenseInvoicesService.anularGasto(E, f.id, { motivo: 'Repetida' });
    const m = await informeMayorTerceros(E, 'proveedores', { desde: '2026-01-01', hasta: '2026-12-31', ejercicio: 2026 });
    const t = m.terceros.find((x) => x.id === otro);
    expect(t?.saldoFinal ?? 0).toBe(0);
    expect((await pendientesSegunFacturas(E, 'proveedores', '2026-12-31')).some((p) => p.id === f.id)).toBe(false);
  });
});
