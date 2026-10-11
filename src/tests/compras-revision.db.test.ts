/**
 * Arreglos de la revision de Compras, sobre BD real:
 *  - el alta (manual y del lector) y la aprobacion del borrador no meten una
 *    factura en un trimestre con el 303 (o el 111/115) ya presentado;
 *  - el boton Contabilizar de una factura anterior usa su fecha de registro,
 *    su cuenta y la base de las lineas con retencion, y el proveedor en la
 *    misma cuenta (400/410) que sus pagos;
 *  - una factura anterior sin asiento de un trimestre declarado no se
 *    modifica ni se anula sin contraasiento;
 *  - el 347 no lleva las compras con retencion de IRPF (van en el 190 y el 180);
 *  - la fecha de anulacion tiene que existir y no ser anterior a la factura.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import expenseInvoicesRoutes from '../routes/expense-invoices.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { expenseInvoicesService } from '../services/expense-invoices.service';
import { AccountingEngineController } from '../controllers/accounting-engine.controller';
import { accountingEngineRoutes } from '../routes/accounting-engine.routes';
import { registrarCobroFactura } from '../services/cobrosPagos.service';
import { cambiarEstadoPeriodo } from '../services/periodos.service';
import { calcularModelo303, calcularModelo347 } from '../services/impuestosCalculo.service';
import { taxModelsService } from '../services/tax-models.service';
import { periodoFiscal } from '../services/nominas/fiscal';
import { controlCif } from '../utils/nif';
import { esperarCuadre } from './ayuda-cuadre-recibidas';

const SUFIJO = `${Date.now()}`;
const motor = new AccountingEngineController();
let n = 0;
const cif = () => {
  const siete = String(3000000 + ((Date.now() + n++ * 15485863) % 6999999)).slice(0, 7);
  return `B${siete}${controlCif(siete).cifra}`;
};

async function nuevaEmpresa(nombre: string): Promise<string> {
  const id = `compras-rev-${nombre}-${SUFIJO}`;
  await prisma.company.create({ data: { id, name: `Revision ${nombre} SL`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: id, denominacion: `Revision ${nombre} SL`, nif: 'B10000000' } });
  return id;
}
const proveedor = async (companyId: string, nombre = 'Suministros Levante SL') =>
  (await prisma.supplier.create({ data: { companyId, nombreFiscal: nombre, nifCif: cif() } })).id;

function app(companyId: string) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { userId: 'u-rev', email: 'contable@test.local', roles: ['contable'], companies: [companyId], rolesPorEmpresa: { [companyId]: ['contable'] } } as never;
    req.companyId = companyId;
    next();
  });
  a.use('/expense-invoices', expenseInvoicesRoutes);
  a.use(errorMiddleware);
  return a;
}

/** El motor contable montado como en routes/index.ts (/companies/:companyId/accounting). */
function appMotor(companyId: string) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    // sesionVerificada: authMiddleware de la ruta no vuelve a pedir el token.
    req.user = {
      userId: 'u-rev',
      email: 'contable@test.local',
      roles: ['contable'],
      companies: [companyId],
      rolesPorEmpresa: { [companyId]: ['contable'] },
      sesionVerificada: true,
    } as never;
    next();
  });
  a.use('/companies/:companyId/accounting', accountingEngineRoutes);
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

const presentar = (companyId: string, codigo: string, periodo: string, ejercicio = 2026) =>
  prisma.modeloImpuesto.create({ data: { companyId, codigo, ejercicio, periodo, estado: 'presentado' } });

describe('alta en un trimestre con el 303 presentado', () => {
  it('alta manual: 409 que pide la fecha de registro, y con ella entra en el 2T', async () => {
    const E = await nuevaEmpresa('alta303');
    const sup = await proveedor(E);
    await presentar(E, '303', '1T');
    const r = await request(app(E)).post('/expense-invoices').send(factura(sup, { fechaEmision: '2026-03-20' }));
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/^El 303 del 1T de 2026 ya está presentado: si la recibiste más tarde, indica en «¿La recibiste más tarde\?»/);
    expect(r.body.details).toEqual({ campo: 'fechaRegistro' });
    expect(await prisma.expenseInvoice.count({ where: { companyId: E } })).toBe(0);

    const ok = await request(app(E)).post('/expense-invoices').send(factura(sup, { fechaEmision: '2026-03-20', fechaRegistro: '2026-05-04' }));
    expect(ok.status).toBe(201);
    await esperarCuadre(expect, E, 2026, 1, 0, 0);
    await esperarCuadre(expect, E, 2026, 2, 210, 1000);
  });

  it('con el 111 presentado solo se bloquean las que llevan retención de profesionales', async () => {
    const E = await nuevaEmpresa('alta111');
    const sup = await proveedor(E);
    await presentar(E, '111', '1T');
    const sin = await request(app(E)).post('/expense-invoices').send(factura(sup, { numeroFacturaProveedor: 'L-1' }));
    expect(sin.status).toBe(201);
    const con = await request(app(E))
      .post('/expense-invoices')
      .send(factura(sup, { numeroFacturaProveedor: 'P-1', tipoGasto: 'SERVICIO_PROFESIONAL', lineas: [{ descripcion: 'Asesoría', cantidad: 1, precioUnitario: 1000, tipoIva: 21, tipoRetencion: 15 }] }));
    expect(con.status).toBe(409);
    expect(con.body.message).toMatch(/^El 111 del 1T de 2026 ya está presentado/);
  });

  it('lector: el borrador tampoco se crea en un trimestre presentado', async () => {
    const E = await nuevaEmpresa('lector303');
    const sup = await proveedor(E);
    await presentar(E, '303', '1T');
    await expect(expenseInvoicesService.registrarGasto(E, factura(sup), { contabilizar: 'DRAFT' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('aprobar un borrador cuyo trimestre se presentó después: 409 y nada cambia', async () => {
    const E = await nuevaEmpresa('aprobar303');
    const sup = await proveedor(E);
    const { factura: f, asientoId } = await expenseInvoicesService.registrarGasto(E, factura(sup), { contabilizar: 'DRAFT' });
    await presentar(E, '303', '1T');
    await expect(motor.aprobarAsiento(E, asientoId, 'u-rev')).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/^El 303 del 1T de 2026 ya está presentado\. Si la factura te llegó más tarde, ábrela/),
      // La pantalla abre la factura con «¿La recibiste más tarde?» desplegado.
      details: { campo: 'fechaRegistro', facturaId: f.id },
    });
    // Por la ruta (POST .../approve) tambien llegan los details.
    const porRuta = await request(appMotor(E)).post(`/companies/${E}/accounting/journal-entries/${asientoId}/approve`).send({});
    expect(porRuta.status).toBe(409);
    expect(porRuta.body.details).toEqual({ campo: 'fechaRegistro', facturaId: f.id });
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: asientoId } })).estado).toBe('DRAFT');
    expect((await prisma.expenseInvoice.findUniqueOrThrow({ where: { id: f.id } })).estado).toBe('DRAFT');
    await esperarCuadre(expect, E, 2026, 1, 0, 0);

    // Con la fecha de registro en el 2T, el borrador se rehace y ya se aprueba.
    const r = await request(app(E)).put(`/expense-invoices/${f.id}`).send(factura(sup, { fechaRegistro: '2026-04-06' }));
    expect(r.status).toBe(200);
    await motor.aprobarAsiento(E, r.body.data.asiento.id, 'u-rev');
    await esperarCuadre(expect, E, 2026, 1, 0, 0);
    await esperarCuadre(expect, E, 2026, 2, 210, 1000);
  });
});

/** Factura anterior al alta con asiento: PENDING y sin asiento (crearGasto sin opciones). */
async function anterior(E: string, sup: string, extra: Record<string, unknown> = {}) {
  return expenseInvoicesService.crearGasto({
    companyId: E,
    provider: { id: sup },
    serie: 'G',
    fechaEmision: '2026-02-10',
    fechaVencimiento: '2099-12-31',
    tipoGasto: 'SUMINISTROS',
    lineas: [{ descripcion: 'Luz', cantidad: 1, precioUnitario: 1000, tipoIva: 21 }],
    ...extra,
  });
}

async function banco(E: string) {
  return (await prisma.bankAccount.create({ data: { companyId: E, iban: `ES00${String(Date.now()).slice(-10)}${n++}`.padEnd(24, '0').slice(0, 24), bancoNombre: 'Banco', subcuentaCodigo: '5720001' } })).id;
}

async function saldos(E: string, cuentas: string[]) {
  const lineas = await prisma.journalEntryLine.findMany({ where: { companyId: E, entry: { estado: 'POSTED' } }, select: { accountCode: true, debe: true, haber: true } });
  return Object.fromEntries(cuentas.map((c) => [c, Math.round(lineas.filter((l) => l.accountCode === c).reduce((a, l) => a + Number(l.haber) - Number(l.debe), 0) * 100) / 100]));
}

describe('Contabilizar una factura anterior', () => {
  it('con la fecha de registro y la cuenta elegidas al modificarla: todo en el 2T y a la 629', async () => {
    const E = await nuevaEmpresa('anterior-fecha');
    const sup = await proveedor(E);
    const f = await anterior(E, sup);
    const put = await request(app(E)).put(`/expense-invoices/${f.id}`).send(factura(sup, { numeroFacturaProveedor: 'ANT-1', fechaRegistro: '2026-04-05', cuentaGasto: '629' }));
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({ estado: 'OVERDUE', asiento: null, acciones: { contabilizar: true } });

    await motor.contabilizarFacturaGasto(E, f.id);
    const asiento = await prisma.journalEntry.findFirstOrThrow({ where: { invoiceId: f.id, origen: 'FACTURA_GASTO' }, include: { lineas: true } });
    expect(asiento.fecha.toISOString().slice(0, 10)).toBe('2026-04-05');
    expect(Object.fromEntries(asiento.lineas.map((l) => [l.accountCode, [l.debe, l.haber]]))).toEqual({ '629': [1000, 0], '472': [210, 0], '410': [0, 1210] });
    const libro = await prisma.vATBook.findFirstOrThrow({ where: { companyId: E } });
    expect(libro).toMatchObject({ numeroFacturaEmisor: 'ANT-1', observaciones: 'Fecha de expedición: 10/02/2026' });
    await esperarCuadre(expect, E, 2026, 1, 0, 0);
    await esperarCuadre(expect, E, 2026, 2, 210, 1000);
  });

  it('con lineas con y sin retencion: el libro de retenciones lleva solo la base retenida', async () => {
    const E = await nuevaEmpresa('anterior-ret');
    const sup = await proveedor(E);
    const f = await anterior(E, sup, {
      tipoGasto: 'SERVICIO_PROFESIONAL',
      lineas: [
        { descripcion: 'Honorarios', cantidad: 1, precioUnitario: 1000, tipoIva: 21, tipoRetencion: 15 },
        { descripcion: 'Suplidos', cantidad: 1, precioUnitario: 200, tipoIva: 21 },
      ],
    });
    await motor.contabilizarFacturaGasto(E, f.id);
    const ret = await prisma.retentionBook.findMany({ where: { companyId: E } });
    expect(ret.map((r) => [r.baseImponible, r.porcentajeRetencion, r.cuotaRetencion, r.tipoRetencionNombre])).toEqual([[1000, 15, 150, 'PROFESIONAL']]);
  });

  it('pagada antes de contabilizarla: el pago y la factura van a la misma cuenta y el proveedor queda a cero', async () => {
    const E = await nuevaEmpresa('anterior-pago');
    const sup = await proveedor(E);
    const f = await anterior(E, sup);
    await registrarCobroFactura(E, 'GASTO', f.id, { fecha: '2026-02-20', importe: 1210, cuentaBancariaId: await banco(E) });
    await motor.contabilizarFacturaGasto(E, f.id);
    expect(await saldos(E, ['400', '410'])).toEqual({ '400': 0, '410': 0 });
  });

  it('pagos antiguos a la 400 de una factura de servicios: el asiento abona tambien la 400', async () => {
    const E = await nuevaEmpresa('anterior-pago400');
    const sup = await proveedor(E);
    // Se paga como compra (a la 400, como antes de separar la 410) y luego pasa a suministros.
    const f = await anterior(E, sup, { tipoGasto: 'COMPRA' });
    await registrarCobroFactura(E, 'GASTO', f.id, { fecha: '2026-02-20', importe: 1210, cuentaBancariaId: await banco(E) });
    await prisma.expenseInvoice.update({ where: { id: f.id }, data: { tipoGasto: 'SUMINISTROS' } });
    await motor.contabilizarFacturaGasto(E, f.id);
    const asiento = await prisma.journalEntry.findFirstOrThrow({ where: { invoiceId: f.id, origen: 'FACTURA_GASTO' }, include: { lineas: true } });
    expect(asiento.lineas.find((l) => l.haber > 0)?.accountCode).toBe('400');
    expect(await saldos(E, ['400', '410'])).toEqual({ '400': 0, '410': 0 });
  });
});

describe('factura anterior sin asiento con el 303 presentado', () => {
  it('no se modifica ni se anula; se contabiliza y despues se anula con contraasiento', async () => {
    const E = await nuevaEmpresa('anterior-303');
    const sup = await proveedor(E);
    const f = await anterior(E, sup);
    await presentar(E, '303', '1T');
    const cuota1T = async () => (await calcularModelo303(E, periodoFiscal(2026, '1T'))).totalCuotaDeducible;
    expect(await cuota1T()).toBe(210);

    const ficha = await request(app(E)).get(`/expense-invoices/${f.id}`);
    expect(ficha.body.data.acciones).toMatchObject({
      editar: { permitido: false, motivo: expect.stringMatching(/^El 303 del 1T de 2026 ya está presentado: esta factura ya cuenta en lo presentado y no se puede modificar así\. Contabilízala/) },
      anular: { permitido: false, conContraasiento: false, motivo: expect.stringMatching(/no se puede anular así/) },
      contabilizar: true,
    });
    const put = await request(app(E)).put(`/expense-invoices/${f.id}`).send(factura(sup, { lineas: [{ descripcion: 'Luz', cantidad: 1, precioUnitario: 500, tipoIva: 21 }] }));
    expect(put.status).toBe(409);
    expect(put.body.details).toEqual({ accion: 'contabilizar' });
    const anu = await request(app(E)).post(`/expense-invoices/${f.id}/anular`).send({ motivo: 'Repetida' });
    expect(anu.status).toBe(409);
    expect(await cuota1T()).toBe(210);

    // Mover la fecha a un trimestre declarado tampoco: una anterior del 2T no puede pasar al 1T.
    const otra = await anterior(E, sup, { fechaEmision: '2026-04-10' });
    const mover = await request(app(E)).put(`/expense-invoices/${otra.id}`).send(factura(sup, { numeroFacturaProveedor: 'MOV-1', fechaEmision: '2026-03-30' }));
    expect(mover.status).toBe(409);

    await motor.contabilizarFacturaGasto(E, f.id);
    const ok = await request(app(E)).post(`/expense-invoices/${f.id}/anular`).send({ motivo: 'Repetida', fecha: '2026-04-15' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.contraasiento).toBe(true);
    await esperarCuadre(expect, E, 2026, 1, 210, 1000);
  });
});

describe('347 sin las compras con retencion', () => {
  it('alquiler y profesional con retencion fuera; el suministro y la parte sin retencion, dentro', async () => {
    const E = await nuevaEmpresa('347');
    const alquiler = await proveedor(E, 'Arrendador Centro SL');
    const asesor = await proveedor(E, 'Asesoria Fiscal SL');
    const luz = await proveedor(E, 'Electrica del Turia SL');
    const linea = (precioUnitario: number, tipoRetencion = 0) => ({ descripcion: 'Concepto', cantidad: 1, precioUnitario, tipoIva: 21, tipoRetencion });
    for (const [i, fecha] of ['2026-01-10', '2026-04-10', '2026-07-10', '2026-10-10'].entries()) {
      for (const [sup, tipo, lineas] of [
        [alquiler, 'ALQUILER', [linea(1000, 19)]],
        [asesor, 'SERVICIO_PROFESIONAL', [linea(1000, 15), ...(i === 0 ? [linea(3000)] : [])]],
        [luz, 'SUMINISTROS', [linea(1000)]],
      ] as const) {
        const r = await request(app(E)).post('/expense-invoices').send(factura(sup, { numeroFacturaProveedor: `${tipo}-${i}`, fechaEmision: fecha, tipoGasto: tipo, lineas }));
        expect(r.status).toBe(201);
      }
    }
    const m = await calcularModelo347(E, 2026);
    expect(m.operaciones.map((o) => [o.nombre, o.baseAnual])).toEqual([
      ['Electrica del Turia SL', 4840],
      ['Asesoria Fiscal SL', 3630],
    ]);
    const fiscal = await taxModelsService.generarModelo347(E, 2026);
    expect(fiscal.terceros.map((t: { nombre: string; totalOperaciones: number }) => [t.nombre, t.totalOperaciones]).sort()).toEqual([
      ['Asesoria Fiscal SL', 3630],
      ['Electrica del Turia SL', 4840],
    ]);
  });
});

describe('anular: la fecha del contraasiento', () => {
  it('una fecha que no existe o anterior a la factura: 400 y nada cambia', async () => {
    const E = await nuevaEmpresa('anular-fecha');
    const sup = await proveedor(E);
    const r = await request(app(E)).post('/expense-invoices').send(factura(sup, { fechaEmision: '2026-03-15' }));
    expect(r.status).toBe(201);
    const id = r.body.data.id as string;
    await cambiarEstadoPeriodo(E, 2026, 3, 'cerrado');
    try {
      const antes = await prisma.journalEntry.count({ where: { companyId: E } });
      const noExiste = await request(app(E)).post(`/expense-invoices/${id}/anular`).send({ motivo: 'Error', fecha: '2026-06-31' });
      expect(noExiste.status).toBe(400);
      expect(noExiste.body).toMatchObject({ message: 'Esa fecha no existe.', details: { campo: 'fecha' } });
      const anterior = await request(app(E)).post(`/expense-invoices/${id}/anular`).send({ motivo: 'Error', fecha: '2026-01-10' });
      expect(anterior.status).toBe(400);
      expect(anterior.body).toMatchObject({ message: 'La fecha de anulación no puede ser anterior a la de registro de la factura (15/03/2026).', details: { campo: 'fecha' } });
      expect(await prisma.journalEntry.count({ where: { companyId: E } })).toBe(antes);
      expect((await prisma.expenseInvoice.findUniqueOrThrow({ where: { id } })).estado).toBe('ACCOUNTED');
    } finally {
      await cambiarEstadoPeriodo(E, 2026, 3, 'abierto');
    }
    const listado = await request(app(E)).get('/expense-invoices?desde=2026-02-30');
    expect(listado.status).toBe(400);
    expect(listado.body.message).toBe('La fecha «desde» no existe.');
  });
});

describe('modificar y anular a la vez (dos pestañas o dos usuarios)', () => {
  const asientosFirmes = (invoiceId: string) => prisma.journalEntry.count({ where: { invoiceId, origen: 'FACTURA_GASTO', estado: 'POSTED' } });

  it('dos PUT a la vez: un solo asiento en firme y el libro cuadra con la factura', async () => {
    const E = await nuevaEmpresa('carrera-put');
    const sup = await proveedor(E);
    for (let i = 0; i < 3; i++) {
      const num = `C-${i}`;
      const alta = await request(app(E)).post('/expense-invoices').send(factura(sup, { numeroFacturaProveedor: num, fechaEmision: '2026-05-04' }));
      expect(alta.status).toBe(201);
      const id = alta.body.data.id as string;
      const rs = await Promise.all([
        request(app(E)).put(`/expense-invoices/${id}`).send(factura(sup, { numeroFacturaProveedor: num, fechaEmision: '2026-05-04', lineas: [{ descripcion: 'Luz', cantidad: 1, precioUnitario: 800, tipoIva: 21 }] })),
        request(app(E)).put(`/expense-invoices/${id}`).send(factura(sup, { numeroFacturaProveedor: num, fechaEmision: '2026-05-04', lineas: [{ descripcion: 'Luz', cantidad: 1, precioUnitario: 600, tipoIva: 10 }] })),
      ]);
      for (const r of rs) expect([200, 409]).toContain(r.status);
      for (const r of rs.filter((x) => x.status === 409)) {
        expect(r.body.message).toBe('La factura ha cambiado mientras la modificabas: vuelve a abrirla.');
        expect(r.body.details).toEqual({ motivo: 'factura_cambiada' });
      }
      expect(await asientosFirmes(id)).toBe(1);
    }
    const facturas = await prisma.expenseInvoice.findMany({ where: { companyId: E } });
    const cuota = Math.round(facturas.reduce((a, f) => a + Number(f.ivaTotal), 0) * 100) / 100;
    await esperarCuadre(expect, E, 2026, 2, cuota);
  });

  it('anular y modificar a la vez: o queda anulada sin contar, o modificada; nunca las dos cosas', async () => {
    const E = await nuevaEmpresa('carrera-anular');
    const sup = await proveedor(E);
    for (let i = 0; i < 3; i++) {
      const num = `A-${i}`;
      const alta = await request(app(E)).post('/expense-invoices').send(factura(sup, { numeroFacturaProveedor: num, fechaEmision: '2026-05-04' }));
      const id = alta.body.data.id as string;
      const [anu, put] = await Promise.all([
        request(app(E)).post(`/expense-invoices/${id}/anular`).send({ motivo: 'Repetida' }),
        request(app(E)).put(`/expense-invoices/${id}`).send(factura(sup, { numeroFacturaProveedor: num, fechaEmision: '2026-05-04', lineas: [{ descripcion: 'Luz', cantidad: 1, precioUnitario: 800, tipoIva: 21 }] })),
      ]);
      const f = await prisma.expenseInvoice.findUniqueOrThrow({ where: { id } });
      if (f.estado === 'ANULADA') {
        expect(anu.status).toBe(200);
        expect(await asientosFirmes(id)).toBe(0);
        expect(f.numeroProveedorActivo).toBeNull();
      } else {
        expect(anu.status).toBe(409);
        expect(put.status).toBe(200);
        expect(f.anuladaEn).toBeNull();
        expect(await asientosFirmes(id)).toBe(1);
      }
    }
    const vigentes = await prisma.expenseInvoice.findMany({ where: { companyId: E, estado: { not: 'ANULADA' } } });
    const cuota = Math.round(vigentes.reduce((a, f) => a + Number(f.ivaTotal), 0) * 100) / 100;
    await esperarCuadre(expect, E, 2026, 2, cuota);
  });
});

describe('cuentas 640-642 con trabajadores dados de alta', () => {
  it('ni en la cuenta de la factura ni en la de una linea, al dar de alta ni al modificar', async () => {
    const E = await nuevaEmpresa('nominas640');
    const sup = await proveedor(E);
    await prisma.empleado.create({ data: { companyId: E, nif: '12345678Z', nombre: 'Trabajadora' } });
    const mensaje = 'Las cuentas 640, 641 y 642 son de nóminas: con trabajadores dados de alta, se registran en Nóminas, no como facturas de gasto.';

    const porLinea = await request(app(E))
      .post('/expense-invoices')
      .send(factura(sup, { lineas: [{ descripcion: 'Sueldos', cantidad: 1, precioUnitario: 1000, tipoIva: 0, cuenta: '640' }] }));
    expect(porLinea.status).toBe(400);
    expect(porLinea.body).toMatchObject({ message: mensaje, details: { campo: 'lineas.0.cuenta' } });
    const porFactura = await request(app(E)).post('/expense-invoices').send(factura(sup, { cuentaGasto: '642' }));
    expect(porFactura.status).toBe(400);
    expect(porFactura.body).toMatchObject({ message: mensaje, details: { campo: 'cuentaGasto' } });
    // El lector, con la clasificacion corregida a «factura» y la cuenta en la linea.
    await expect(
      expenseInvoicesService.registrarGasto(E, factura(sup, { lineas: [{ descripcion: 'RLC', cantidad: 1, precioUnitario: 300, tipoIva: 0, cuenta: '642' }] }), { contabilizar: 'DRAFT' }),
    ).rejects.toMatchObject({ statusCode: 400, message: mensaje });
    expect(await prisma.expenseInvoice.count({ where: { companyId: E } })).toBe(0);

    const ok = await request(app(E)).post('/expense-invoices').send(factura(sup));
    expect(ok.status).toBe(201);
    const put = await request(app(E)).put(`/expense-invoices/${ok.body.data.id}`).send(factura(sup, { cuentaGasto: '641' }));
    expect(put.status).toBe(400);
    expect(put.body.message).toBe(mensaje);
  });
});
