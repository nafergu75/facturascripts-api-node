/**
 * Facturas de gasto con el mes bloqueado o cerrado, sobre BD real y por la API
 * (integracion de Compras con Configuracion):
 *  - una factura anterior sin asiento cuyo mes se bloquea: Contabilizar no
 *    manda a modificarla, y Modificar y Anular no mandan a Contabilizar (antes
 *    se mandaban la una a la otra y no habia salida). Las tres dicen que hay
 *    que desbloquear el mes; desbloqueado, se corrige y se contabiliza.
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
