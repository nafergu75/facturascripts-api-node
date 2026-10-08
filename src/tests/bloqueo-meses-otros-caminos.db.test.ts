/**
 * Un mes bloqueado (p. ej. con su 303 presentado) tampoco se toca por los
 * caminos que antes no lo miraban, sobre BD real:
 *  - conciliar un movimiento con una cuenta o con una factura;
 *  - registrar un cobro de vencimiento (cobros.service);
 *  - la puesta en marcha (apertura, diario y sus anulaciones);
 *  - el antiguo POST /accounting/closures/generar-asiento, que ahora responde 409.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import { cambiarEstadoPeriodo } from '../services/periodos.service';
import { conciliarMovimientoConCuenta, conciliarMovimientoConFactura } from '../services/conciliacionConfirmar.service';
import { registrarCobro, registrarCobroVencimiento } from '../services/cobros.service';
import { anularDiarioImportado, previsualizarApertura, previsualizarDiario } from '../services/puestaEnMarcha/puestaEnMarcha.service';
import { leerDiario } from '../services/puestaEnMarcha/lectorContable';
import accountingClosureRoutes from '../routes/accounting-closure.routes';
import { errorMiddleware } from '../middleware/error.middleware';

const SUFIJO = Date.now();
const EMPRESA = `bloqueo-caminos-${SUFIJO}`;
const ids: Record<string, string> = {};

beforeAll(async () => {
  await prisma.company.create({ data: { id: EMPRESA, name: 'Bloqueo Caminos SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  // Marzo de 2026 bloqueado (su 303 del 1T ya se presentó).
  await cambiarEstadoPeriodo(EMPRESA, 2026, 3, 'bloqueado');
  const cuenta = await prisma.bankAccount.create({ data: { companyId: EMPRESA, iban: 'ES9121000418450200051332', subcuentaCodigo: '572000' } });
  const mov = (fecha: string, importe: number) =>
    prisma.bankMovement.create({ data: { companyId: EMPRESA, cuentaBancariaId: cuenta.id, fecha, importe, concepto: 'Transferencia', origen: 'csv' } });
  ids.movMarzo = (await mov('2026-03-10', 121)).id;
  ids.movMarzo2 = (await mov('2026-03-11', 242)).id;
  // Un asiento importado en marzo (para anular la importacion).
  await prisma.journalEntry.create({
    data: { companyId: EMPRESA, fecha: new Date('2026-03-05T00:00:00Z'), numeroAsiento: `IMP-${SUFIJO}`, descripcion: 'Importado', origen: 'IMPORTACION', estado: 'POSTED' },
  });
});

describe('conciliacion y cobros', () => {
  it('conciliar con una cuenta un movimiento de un mes bloqueado: 400 y nada creado', async () => {
    await expect(conciliarMovimientoConCuenta(EMPRESA, ids.movMarzo)).rejects.toThrow(/03\/2026 está bloqueado/);
    expect((await prisma.bankMovement.findUniqueOrThrow({ where: { id: ids.movMarzo } })).conciliado).toBe(false);
    expect(await prisma.journalEntry.count({ where: { companyId: EMPRESA, origen: 'TESORERIA' } })).toBe(0);
  });

  it('conciliar con una factura un movimiento de un mes bloqueado: 400 antes de registrar el cobro', async () => {
    await expect(conciliarMovimientoConFactura(EMPRESA, ids.movMarzo2, 'fact-1')).rejects.toThrow(/bloqueado/);
    expect(await prisma.vencimiento.count({ where: { companyId: EMPRESA } })).toBe(0);
  });

  it('registrar un cobro con fecha de un mes bloqueado: 400 sin crear el vencimiento', async () => {
    await expect(registrarCobro(EMPRESA, 'fact-1', 100, '2026-03-20')).rejects.toThrow(/bloqueado/);
    await expect(registrarCobroVencimiento(EMPRESA, 'venc-x', '2026-03-20')).rejects.toThrow(/bloqueado/);
    expect(await prisma.vencimiento.count({ where: { companyId: EMPRESA } })).toBe(0);
  });
});

describe('puesta en marcha', () => {
  it('apertura con fecha de un mes bloqueado: error en la vista previa', async () => {
    const v = await previsualizarApertura(
      EMPRESA,
      { cuentas: [{ codigo: '5720000001', nombre: 'Banco', saldo: 100 }, { codigo: '1000000000', nombre: 'Capital', saldo: -100 }] },
      { ejercicio: 2026, fecha: '2026-03-01' },
    );
    expect(v.puedeConfirmar).toBe(false);
    expect(v.errores.join(' ')).toMatch(/03\/2026 está bloqueado o cerrado/);
  });

  it('diario con asientos de un mes bloqueado: error en la vista previa', async () => {
    const csv = ['Fecha;Asiento;Cuenta;Concepto;Debe;Haber', '15/03/2026;1;5720000001;Cobro;10,00;', '15/03/2026;1;4300000001;Cobro;;10,00'].join('\n');
    const v = await previsualizarDiario(EMPRESA, leerDiario(Buffer.from(csv, 'utf8'), 'diario.csv'), { ejercicio: 2026, reemplazar: true });
    expect(v.puedeConfirmar).toBe(false);
    expect(v.errores.join(' ')).toMatch(/03\/2026 está bloqueado o cerrado/);
  });

  it('anular una importación con asientos de un mes bloqueado: 400', async () => {
    await expect(anularDiarioImportado(EMPRESA, 2026)).rejects.toThrow(/bloqueado o cerrado/);
    expect(await prisma.journalEntry.count({ where: { companyId: EMPRESA, origen: 'IMPORTACION', estado: 'POSTED' } })).toBe(1);
  });
});

describe('POST /accounting/closures/generar-asiento', () => {
  it('ya no graba nada: 409 y remite a Cierre y traspaso de saldos', async () => {
    const app = express();
    app.use(express.json());
    app.use('/companies/:companyId/accounting/closures', (req, _res, next) => {
      req.user = { userId: 'u-admin', roles: ['admin'], rolesPorEmpresa: { [EMPRESA]: ['admin'] } } as never;
      req.companyId = EMPRESA;
      next();
    }, accountingClosureRoutes);
    app.use(errorMiddleware);
    const res = await request(app)
      .post(`/companies/${EMPRESA}/accounting/closures/generar-asiento`)
      .send({ fechaDesde: '2025-01-01', fechaHasta: '2025-12-31' });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Cierre y traspaso de saldos/);
    expect(res.body.details).toEqual({ enlace: '/dashboard/contabilidad/cierre-ejercicio?ejercicio=2025' });
    expect(await prisma.journalEntry.count({ where: { companyId: EMPRESA, origen: 'CIERRE_AUTOMATICO' } })).toBe(0);
  });
});
