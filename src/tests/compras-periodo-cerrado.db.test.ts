/**
 * Facturas de gasto con el mes bloqueado o cerrado, sobre BD real y por la API
 * (integracion de Compras con Configuracion):
 *  - una factura anterior sin asiento cuyo mes se bloquea: Contabilizar no
 *    manda a modificarla, y Modificar y Anular no mandan a Contabilizar (antes
 *    se mandaban la una a la otra y no habia salida). Las tres dicen que hay
 *    que desbloquear el mes; desbloqueado, se corrige y se contabiliza;
 *  - el borrador del lector cuyo mes se bloquea despues: aprobarlo da el 409
 *    con { campo: 'fechaRegistro', facturaId } (antes la comprobacion general
 *    se adelantaba con un 400 que invitaba a cambiar la fecha).
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
import { cambiarEstadoPeriodo } from '../services/periodos.service';
import { controlCif } from '../utils/nif';

const SUFIJO = `${Date.now()}`;
const motor = new AccountingEngineController();
let n = 0;
const cif = () => {
  const siete = String(3000000 + ((Date.now() + n++ * 15485863) % 6999999)).slice(0, 7);
  return `B${siete}${controlCif(siete).cifra}`;
};

async function nuevaEmpresa(nombre: string, legal: { pais?: string; monedaCuenta?: string } = {}): Promise<string> {
  const id = `compras-percer-${nombre}-${SUFIJO}`;
  await prisma.company.create({ data: { id, name: `Periodo ${nombre} SL`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: id, denominacion: `Periodo ${nombre} SL`, nif: 'B10000000', ...legal } });
  return id;
}
const proveedor = async (companyId: string) =>
  (await prisma.supplier.create({ data: { companyId, nombreFiscal: 'Suministros Levante SL', nifCif: cif() } })).id;

const usuario = (companyId: string) =>
  ({
    userId: 'u-percer',
    email: 'contable@test.local',
    roles: ['contable'],
    companies: [companyId],
    rolesPorEmpresa: { [companyId]: ['contable'] },
    sesionVerificada: true,
  }) as never;

function app(companyId: string) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = usuario(companyId);
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
    req.user = usuario(companyId);
    next();
  });
  a.use('/companies/:companyId/accounting', accountingEngineRoutes);
  a.use(errorMiddleware);
  return a;
}

const factura = (supplierId: string, extra: Record<string, unknown> = {}) => ({
  proveedor: { id: supplierId },
  numeroFacturaProveedor: 'S-100',
  fechaEmision: '2026-03-10',
  tipoGasto: 'SUMINISTROS',
  lineas: [{ descripcion: 'Luz', cantidad: 1, precioUnitario: 1000, tipoIva: 21 }],
  ...extra,
});

/** Factura anterior al alta con asiento: PENDING y sin asiento (crearGasto sin opciones). */
const anterior = (E: string, sup: string) =>
  expenseInvoicesService.crearGasto({
    companyId: E,
    provider: { id: sup },
    serie: 'G',
    fechaEmision: '2026-03-10',
    fechaVencimiento: '2099-12-31',
    tipoGasto: 'SUMINISTROS',
    lineas: [{ descripcion: 'Luz', cantidad: 1, precioUnitario: 1000, tipoIva: 21 }],
  });

describe('factura anterior sin asiento con su mes bloqueado', () => {
  it('Contabilizar, Modificar y Anular dicen que hay que desbloquear el mes; desbloqueado, se corrige y se contabiliza', async () => {
    const E = await nuevaEmpresa('anterior');
    const sup = await proveedor(E);
    const f = await anterior(E, sup);
    await cambiarEstadoPeriodo(E, 2026, 3, 'bloqueado');
    const enlace = '/dashboard/configuracion/ejercicios';

    // Contabilizar: no manda a modificarla (eso tampoco se puede con el mes bloqueado).
    const conta = await request(appMotor(E)).post(`/companies/${E}/accounting/contabilizar/${f.id}?tipo=GASTO`).send({});
    expect(conta.status).toBe(400);
    expect(conta.body.error).toMatch(/^No se puede contabilizar la factura de gasto con fecha 10\/03\/2026: el mes 03\/2026 está bloqueado\. No cambies la fecha de la factura/);
    expect(conta.body.error).toMatch(/desbloquéalo antes en Configuración > Ejercicios y periodos/);
    expect(conta.body.error).not.toMatch(/modifica la factura/);
    expect(conta.body.details).toEqual({ motivo: 'periodo_bloqueado', enlace });

    // Modificar (tambien la fecha de registro) y Anular: no mandan a Contabilizar.
    const put = await request(app(E)).put(`/expense-invoices/${f.id}`).send(factura(sup, { fechaRegistro: '2026-04-05' }));
    expect(put.status).toBe(409);
    expect(put.body.message).toMatch(/^El mes 03\/2026 está bloqueado: esta factura cuenta en ese periodo y no se puede modificar mientras siga así\./);
    expect(put.body.message).not.toMatch(/ya cuenta en lo presentado|Contabilízala/);
    expect(put.body.details).toEqual({ motivo: 'periodo_bloqueado', enlace });
    const anu = await request(app(E)).post(`/expense-invoices/${f.id}/anular`).send({ motivo: 'Repetida' });
    expect(anu.status).toBe(409);
    expect(anu.body.message).toMatch(/^El mes 03\/2026 está bloqueado: esta factura cuenta en ese periodo y no se puede anular mientras siga así\./);
    expect(anu.body.details).toEqual({ motivo: 'periodo_bloqueado', enlace });
    // La ficha dice lo mismo.
    const ficha = await request(app(E)).get(`/expense-invoices/${f.id}`);
    expect(ficha.body.data.acciones.editar).toEqual({ permitido: false, motivo: put.body.message });
    expect(ficha.body.data.acciones.anular).toEqual({ permitido: false, conContraasiento: false, motivo: anu.body.message });
    expect((await prisma.expenseInvoice.findUniqueOrThrow({ where: { id: f.id } })).estado).toBe('PENDING');

    // Desbloqueado el mes: se pone la fecha en que se recibio y se contabiliza en abril.
    await cambiarEstadoPeriodo(E, 2026, 3, 'abierto');
    const ok = await request(app(E)).put(`/expense-invoices/${f.id}`).send(factura(sup, { fechaRegistro: '2026-04-05' }));
    expect(ok.status).toBe(200);
    await cambiarEstadoPeriodo(E, 2026, 3, 'bloqueado');
    const r = await motor.contabilizarFacturaGasto(E, f.id);
    const asiento = await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.journalEntryId } });
    expect(asiento.fecha.toISOString().slice(0, 10)).toBe('2026-04-05');
  });

  it('con el 303 presentado y el mes bloqueado: primero desbloquear; despues Modificar manda a Contabilizar, y Contabilizar funciona', async () => {
    const E = await nuevaEmpresa('anterior303');
    const sup = await proveedor(E);
    const f = await anterior(E, sup);
    await prisma.modeloImpuesto.create({ data: { companyId: E, codigo: '303', ejercicio: 2026, periodo: '1T', estado: 'presentado' } });
    await cambiarEstadoPeriodo(E, 2026, 3, 'bloqueado');
    const bloqueado = await request(app(E)).put(`/expense-invoices/${f.id}`).send(factura(sup));
    expect(bloqueado.status).toBe(409);
    expect(bloqueado.body.details).toMatchObject({ motivo: 'periodo_bloqueado' });

    await cambiarEstadoPeriodo(E, 2026, 3, 'abierto');
    const presentado = await request(app(E)).put(`/expense-invoices/${f.id}`).send(factura(sup));
    expect(presentado.status).toBe(409);
    expect(presentado.body.message).toMatch(/^El 303 del 1T de 2026 ya está presentado: esta factura ya cuenta en lo presentado/);
    expect(presentado.body.details).toEqual({ accion: 'contabilizar' });
    await expect(motor.contabilizarFacturaGasto(E, f.id)).resolves.toMatchObject({ estado: 'POSTED' });
  });

  it('con el mes cerrado por el cierre: manda a deshacer el cierre, no a modificarla', async () => {
    const E = await nuevaEmpresa('anterior-cerrado');
    const sup = await proveedor(E);
    const f = await anterior(E, sup);
    await cambiarEstadoPeriodo(E, 2026, 3, 'cerrado');
    const err = await motor.contabilizarFacturaGasto(E, f.id).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 400, details: { motivo: 'periodo_cerrado', enlace: '/dashboard/contabilidad/cierre-ejercicio?ejercicio=2026' } });
    expect(err.message).toMatch(/deshacer antes el cierre en Contabilidad > Cierre y traspaso de saldos/);
    expect(err.message).not.toMatch(/modifica la factura/);
    const put = await request(app(E)).put(`/expense-invoices/${f.id}`).send(factura(sup));
    expect(put.status).toBe(409);
    expect(put.body.details).toMatchObject({ motivo: 'periodo_cerrado' });
  });
});

describe('aprobar el borrador del lector con su mes bloqueado', () => {
  it('409 con campo fechaRegistro y facturaId (por el controlador y por la ruta); con la fecha de registro en abril, se aprueba', async () => {
    const E = await nuevaEmpresa('lector');
    const sup = await proveedor(E);
    const { factura: f, asientoId } = await expenseInvoicesService.registrarGasto(E, factura(sup, { fechaEmision: '2026-03-04' }), { contabilizar: 'DRAFT' });
    await cambiarEstadoPeriodo(E, 2026, 3, 'bloqueado');

    await expect(motor.aprobarAsiento(E, asientoId, 'u-percer')).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/^El periodo de 03\/2026 está bloqueado\. Si la factura te llegó más tarde, ábrela y pon la fecha de recepción en «¿La recibiste más tarde\?»\. Después aprueba el asiento\./),
      details: { campo: 'fechaRegistro', facturaId: f.id },
    });
    const porRuta = await request(appMotor(E)).post(`/companies/${E}/accounting/journal-entries/${asientoId}/approve`).send({});
    expect(porRuta.status).toBe(409);
    expect(porRuta.body.error).toMatch(/Si te llegó en ese mes, desbloquéalo antes en Configuración > Ejercicios y periodos\.$/);
    expect(porRuta.body.details).toEqual({ campo: 'fechaRegistro', facturaId: f.id });
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: asientoId } })).estado).toBe('DRAFT');

    // El borrador si se modifica con el mes bloqueado: la fecha de registro pasa a abril y se aprueba.
    const put = await request(app(E)).put(`/expense-invoices/${f.id}`).send(factura(sup, { fechaEmision: '2026-03-04', fechaRegistro: '2026-04-06' }));
    expect(put.status).toBe(200);
    await expect(motor.aprobarAsiento(E, put.body.data.asiento.id, 'u-percer')).resolves.toMatchObject({ estado: 'POSTED' });
    expect((await prisma.expenseInvoice.findUniqueOrThrow({ where: { id: f.id } })).estado).toBe('ACCOUNTED');
  });

  it('un asiento que no es de una factura de gasto sigue con el 400 general', async () => {
    const E = await nuevaEmpresa('manual');
    await cambiarEstadoPeriodo(E, 2026, 3, 'bloqueado');
    const borrador = await prisma.journalEntry.create({
      data: { companyId: E, fecha: new Date('2026-03-04T00:00:00Z'), numeroAsiento: 'PC-1', descripcion: 'Borrador', origen: 'MANUAL', estado: 'DRAFT' },
    });
    await expect(motor.aprobarAsiento(E, borrador.id, 'u')).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/^No se puede aprobar el asiento con fecha 04\/03\/2026: el mes 03\/2026 está bloqueado/),
    });
  });
});

// ---------------------------------------------------------------------------
// Abonos de proveedor con el 303 presentado (seccion 11 de la especificacion)
// ---------------------------------------------------------------------------

const linea = (precio: number, extra: Record<string, unknown> = {}) => ({ descripcion: 'Mercancía', cantidad: 1, precioUnitario: precio, tipoIva: 21, ...extra });
const compra = (supplierId: string, numero: string, fecha: string, lineas: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
  proveedor: { id: supplierId },
  numeroFacturaProveedor: numero,
  fechaEmision: fecha,
  tipoGasto: 'COMPRA',
  lineas,
  ...extra,
});
const presentar = (companyId: string, codigo: string, ejercicio: number, periodo: string) =>
  prisma.modeloImpuesto.create({ data: { companyId, codigo, ejercicio, periodo, estado: 'presentado' } });
/** Abono de 100 € + 21 % de la factura `originalId`, con la causa indicada. */
const abonoDe = (sup: string, originalId: string, numero: string, fecha: string, causa = 'DEVOLUCION', extra: Record<string, unknown> = {}) => ({
  ...compra(sup, numero, fecha, [linea(-100, { cuenta: '608' })]),
  rectificativa: { tipo: 'I', causa, originales: [{ id: originalId }], ...extra } as Record<string, unknown>,
});
const ENLACE_303 = '/dashboard/fiscal/modelo-303';
const RECARGO = 'saldrá más a ingresar y fuera de plazo, con el recargo y, en su caso, los intereses del art. 27 LGT.';

describe('abonos con el 303 presentado', () => {
  it('art. 80 que reduce, con el 303 de su trimestre presentado: 409 rectificar_303; confirmado, se registra con la marca y el aviso', async () => {
    const E = await nuevaEmpresa('rect303');
    const sup = await proveedor(E);
    const o = await request(app(E)).post('/expense-invoices').send(compra(sup, 'F-1', '2027-01-10', [linea(1000)]));
    expect(o.status).toBe(201);
    await presentar(E, '303', 2027, '1T');

    const abono = abonoDe(sup, o.body.data.id, 'R-1', '2027-02-15');
    const r = await request(app(E)).post('/expense-invoices').send(abono);
    expect(r.status).toBe(409);
    expect(r.body.message).toBe(
      `Esta rectificativa reduce el IVA que dedujiste y se declara en el periodo en que la recibiste. El 303 del 1T de 2027 ya está presentado. Si la recibiste en ese periodo, regístrala igualmente y presenta una autoliquidación rectificativa de ese 303: ${RECARGO} Si te llegó más tarde, pon la fecha en que te llegó.`,
    );
    expect(r.body.details).toEqual({ campo: 'fechaRegistro', motivo: 'rectificar_303', modelo: '303', ejercicio: 2027, periodo: '1T', enlace: ENLACE_303 });

    const ok = await request(app(E))
      .post('/expense-invoices')
      .send({ ...abono, rectificativa: { ...abono.rectificativa, confirmaRectificar303: true } });
    expect(ok.status).toBe(201);
    const f = await prisma.expenseInvoice.findUniqueOrThrow({ where: { id: ok.body.data.id } });
    expect(f.rectificar303ConfirmadoEn).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(ok.body.data.avisos).toContainEqual(
      'Registrada en el 1T de 2027, que ya está presentado: prepara la autoliquidación rectificativa de ese 303. En la contabilidad, apunta a mano la regularización del IVA (472 y 4750), el recargo (678) y los intereses de demora (669) cuando los pagues.',
    );
    const marca = await prisma.auditLog.findFirstOrThrow({ where: { companyId: E, action: 'RECTIFICAR_303_PENDIENTE', resourceId: f.id } });
    expect(marca.meta).toMatchObject({ modelo: '303', ejercicio: 2027, periodo: '1T', cuota: -21 });
    // El asiento va en el periodo abierto (solo esta presentado el 303).
    const asiento = await prisma.journalEntry.findFirstOrThrow({ where: { companyId: E, invoiceId: f.id, origen: 'FACTURA_GASTO' } });
    expect(asiento).toMatchObject({ estado: 'POSTED' });
    expect(asiento.fecha.toISOString().slice(0, 10)).toBe('2027-02-15');
  });

  it('un cargo (lo aumenta) con el 303 presentado: el texto de siempre, sin rectificar_303', async () => {
    const E = await nuevaEmpresa('cargo303');
    const sup = await proveedor(E);
    const o = await request(app(E)).post('/expense-invoices').send(compra(sup, 'F-1', '2027-01-10', [linea(1000)]));
    await presentar(E, '303', 2027, '1T');
    const r = await request(app(E))
      .post('/expense-invoices')
      .send(compra(sup, 'R-2', '2027-02-15', [linea(50)], { rectificativa: { tipo: 'I', causa: 'ERROR_DERECHO', originales: [{ id: o.body.data.id }], confirmaRectificar303: true } }));
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/^El 303 del 1T de 2027 ya está presentado: si la recibiste más tarde/);
    expect(r.body.details).toEqual({ campo: 'fechaRegistro' });
  });

  it('con el 111 presentado y retención en el abono, confirmar el 303 no basta', async () => {
    const E = await nuevaEmpresa('ret111');
    const sup = await proveedor(E);
    const prof = (lineas: Array<Record<string, unknown>>, numero: string, fecha: string, extra: Record<string, unknown> = {}) => ({
      ...compra(sup, numero, fecha, lineas, extra),
      tipoGasto: 'SERVICIO_PROFESIONAL',
    });
    const o = await request(app(E)).post('/expense-invoices').send(prof([linea(1000, { tipoRetencion: 15 })], 'P-1', '2027-01-10'));
    expect(o.status).toBe(201);
    await presentar(E, '303', 2027, '1T');
    await presentar(E, '111', 2027, '1T');
    const r = await request(app(E))
      .post('/expense-invoices')
      .send(
        prof([linea(-100, { tipoRetencion: 15 })], 'P-1R', '2027-02-15', {
          rectificativa: { tipo: 'I', causa: 'ANULACION_PRECIO', originales: [{ id: o.body.data.id }], confirmaRectificar303: true },
        }),
      );
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/^El 111 del 1T de 2027 ya está presentado/);
    expect(r.body.details).toEqual({ campo: 'fechaRegistro' });
  });

  it('ERROR_IVA que reduce: se mira el 303 de la original, no el de la fecha de registro', async () => {
    const E = await nuevaEmpresa('erroriva');
    const sup = await proveedor(E);
    const o = await request(app(E)).post('/expense-invoices').send(compra(sup, 'F-1', '2027-01-10', [linea(1000)]));
    const cuerpo = compra(sup, 'R-3', '2027-05-10', [linea(-100), linea(100, { tipoIva: 10 })], {
      rectificativa: { tipo: 'I', causa: 'ERROR_IVA', originales: [{ id: o.body.data.id }] },
    });

    await presentar(E, '303', 2027, '2T');
    await presentar(E, '303', 2027, '1T');
    const r = await request(app(E)).post('/expense-invoices').send(cuerpo);
    expect(r.status).toBe(409);
    expect(r.body.message).toBe(
      `Esta rectificativa corrige un IVA mal aplicado y reduce el que dedujiste: se declara en el periodo de la factura que corrige. El 303 del 1T de 2027 ya está presentado. Regístrala igualmente y presenta una autoliquidación rectificativa de ese 303: ${RECARGO}`,
    );
    expect(r.body.details).toEqual({ campo: 'rectificativa', motivo: 'rectificar_303', modelo: '303', ejercicio: 2027, periodo: '1T', enlace: ENLACE_303 });

    // Sin el 1T presentado se registra, aunque el 2T (el de la fecha de registro) lo este: su IVA va al 1T.
    await prisma.modeloImpuesto.deleteMany({ where: { companyId: E, codigo: '303', periodo: '1T' } });
    const ok = await request(app(E)).post('/expense-invoices').send(cuerpo);
    expect(ok.status).toBe(201);
    expect(ok.body.data.rectificativa.imputacionIva).toEqual({ fecha: '2027-01-10', casillas: '28-29' });

    // Presentado despues el 1T: anularla hace contraasiento (no REVERSED), porque ya cuenta en lo presentado.
    await presentar(E, '303', 2027, '1T');
    await prisma.modeloImpuesto.deleteMany({ where: { companyId: E, codigo: '303', periodo: '2T' } });
    const ficha = await request(app(E)).get(`/expense-invoices/${ok.body.data.id}`);
    expect(ficha.body.data.acciones.anular).toMatchObject({ permitido: true, conContraasiento: true });
    const anu = await request(app(E)).post(`/expense-invoices/${ok.body.data.id}/anular`).send({ motivo: 'Mal registrada', fecha: '2027-05-20' });
    expect(anu.status).toBe(200);
    expect(anu.body.data.contraasiento).toBe(true);
  });

  it('el borrador de un abono confirmado se aprueba sin 409; uno sin confirmar da rectificar_303 y se confirma al aprobar', async () => {
    const E = await nuevaEmpresa('aprobar303');
    const sup = await proveedor(E);
    const o = await expenseInvoicesService.registrarGasto(E, compra(sup, 'F-1', '2027-01-10', [linea(1000)]), { contabilizar: 'POSTED' });

    // Sin confirmar: el borrador se dio de alta antes de presentar el 303.
    const sinConfirmar = await expenseInvoicesService.registrarGasto(E, abonoDe(sup, o.factura.id, 'R-A', '2027-02-15'), { contabilizar: 'DRAFT' });
    await presentar(E, '303', 2027, '1T');
    await expect(motor.aprobarAsiento(E, sinConfirmar.asientoId, 'u-percer')).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/^Esta rectificativa reduce el IVA que dedujiste/),
      details: { campo: 'fechaRegistro', facturaId: sinConfirmar.factura.id, motivo: 'rectificar_303', modelo: '303', ejercicio: 2027, periodo: '1T', enlace: ENLACE_303 },
    });
    const porRuta = await request(appMotor(E)).post(`/companies/${E}/accounting/journal-entries/${sinConfirmar.asientoId}/approve`).send({ confirmaRectificar303: true });
    expect(porRuta.status).toBe(200);
    const f = await prisma.expenseInvoice.findUniqueOrThrow({ where: { id: sinConfirmar.factura.id } });
    expect(f).toMatchObject({ estado: 'ACCOUNTED' });
    expect(f.rectificar303ConfirmadoEn).toBeTruthy();
    expect(await prisma.auditLog.count({ where: { companyId: E, action: 'RECTIFICAR_303_PENDIENTE', resourceId: f.id } })).toBe(1);

    // Confirmado en el alta (como lo manda el lector): se aprueba sin mas.
    const confirmado = await expenseInvoicesService.registrarGasto(E, abonoDe(sup, o.factura.id, 'R-B', '2027-02-16', 'DEVOLUCION', { confirmaRectificar303: true }), {
      contabilizar: 'DRAFT',
    });
    await expect(motor.aprobarAsiento(E, confirmado.asientoId, 'u-percer')).resolves.toMatchObject({ estado: 'POSTED' });
  });

  it('un abono confirmado se puede corregir sin volver a frenar; llevarlo a otro periodo presentado pide confirmar de nuevo', async () => {
    const E = await nuevaEmpresa('editar303');
    const sup = await proveedor(E);
    const o = await expenseInvoicesService.registrarGasto(E, compra(sup, 'F-1', '2027-01-10', [linea(1000)]), { contabilizar: 'POSTED' });
    await presentar(E, '303', 2027, '1T');
    const cuerpo = abonoDe(sup, o.factura.id, 'R-1', '2027-02-15', 'DEVOLUCION', { confirmaRectificar303: true });
    const r = await expenseInvoicesService.registrarGasto(E, cuerpo, { contabilizar: 'POSTED' });
    const sinRepetir = { ...cuerpo, observaciones: 'Cajas rotas', rectificativa: { ...cuerpo.rectificativa, confirmaRectificar303: undefined } };
    const put = await request(app(E)).put(`/expense-invoices/${r.factura.id}`).send(sinRepetir);
    expect(put.status).toBe(200);
    expect(put.body.data.observaciones).toBe('Cajas rotas');

    await presentar(E, '303', 2027, '04');
    const otro = await request(app(E)).put(`/expense-invoices/${r.factura.id}`).send({ ...sinRepetir, fechaRegistro: '2027-04-03' });
    expect(otro.status).toBe(409);
    expect(otro.body.details).toMatchObject({ motivo: 'rectificar_303', periodo: '04' });
  });
});
