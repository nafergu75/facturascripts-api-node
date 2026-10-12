/**
 * Deshacer una carga de «Traer la contabilidad de 2026»: primero se ve que se
 * revierte y despues se hace. Sin cobros ni amortizacion apuntada vuelve todo
 * atras (apertura, diario, facturas pendientes, inmovilizado, comparativo,
 * bancos, fichas, cuentas, longitud, marca del plan, asientos de 2026 de la
 * app y llevanza); con ellos, 409. Deshacer una version que sustituyo a otra
 * devuelve la anterior, y repetir crea la version siguiente.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { deshacerCarga } from '../services/arranque/deshacer.service';
import { subirYAnalizar } from '../services/arranque/cargas.service';
import { anularDotacionMes, calcularDotaciones } from '../services/arranque/inmovilizado.service';
import { longitudSubcuentasGuardada } from '../services/terceros/subcuentas';
import type { HttpError } from '../utils/http-errors';
import { AJUSTES_A, CARTERA_A, DIARIO_A, ficherosEmpresaA, NIF } from './fixtures/arranque/generar';
import { empresaDePrueba, TODOS, traerCarga, USUARIO_PRUEBA } from './fixtures/arranque/importar';

const SUFIJO = Date.now();
const todosA = () => Object.values(ficherosEmpresaA());

async function error(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error('No ha fallado');
}

describe('deshacer la única carga', () => {
  const E = `arr-desh-a-${SUFIJO}`;
  let cargaId = '';
  let alfa = '';
  let asiento2026 = '';
  beforeAll(async () => {
    await empresaDePrueba(E);
    // Antes de la carga: un cliente ya dado de alta (sin subcuenta) y un asiento de 2026 hecho en la app.
    alfa = (await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Cliente Alfa SL', nifCif: NIF.alfa } })).id;
    asiento2026 = (
      await prisma.journalEntry.create({
        data: {
          companyId: E,
          fecha: new Date('2026-05-05T00:00:00Z'),
          numeroAsiento: 'AJUSTE-00001',
          descripcion: 'Asiento hecho en la app',
          origen: 'AJUSTE_MANUAL',
          estado: 'POSTED',
          lineas: { create: [{ companyId: E, accountCode: '5720000001', accountName: 'Banco', debe: 10 }, { companyId: E, accountCode: '7000000000', accountName: 'Ventas', haber: 10 }] },
        },
      })
    ).id;
    cargaId = (await traerCarga(E, todosA(), AJUSTES_A)).r.carga.id;
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: asiento2026 } })).estado).toBe('SUSTITUIDO');
  }, 120_000);

  it('con amortización apuntada o cobros de 2027, no se puede: dice qué anular', async () => {
    await calcularDotaciones(E, '2027-01', USUARIO_PRUEBA);
    let plan = await deshacerCarga(E, 2027, cargaId, { simular: true }, USUARIO_PRUEBA);
    expect(plan.puede).toBe(false);
    expect(plan.bloqueos.join(' ')).toMatch(/2 bienes tienen amortización apuntada \(.*Torno CNC.*\)\. Anúlala antes en Contabilidad > Inmovilizado\./);
    const e = await error(deshacerCarga(E, 2027, cargaId, {}, USUARIO_PRUEBA));
    expect(e.statusCode).toBe(409);
    expect(e.details).toMatchObject({ codigo: 'NO_SE_PUEDE_DESHACER' });
    await anularDotacionMes(E, '2027-01', USUARIO_PRUEBA);

    const beta = await prisma.partidaPendiente.findFirstOrThrow({ where: { companyId: E, numeroDocumento: 'A-2026-002' } });
    const cobro = await prisma.invoicePayment.create({
      data: { companyId: E, invoiceType: 'PARTIDA', invoiceId: beta.id, fecha: '2027-01-20', importe: 100, cuentaTesoreria: '5720000001', estado: 'ACTIVO' },
    });
    plan = await deshacerCarga(E, 2027, cargaId, { simular: true }, USUARIO_PRUEBA);
    expect(plan.bloqueos).toEqual(['1 factura pendiente de 2026 ya tiene cobros o pagos de 2027 (A-2026-002). Anúlalos antes en Cobros y pagos.']);
    await prisma.invoicePayment.update({ where: { id: cobro.id }, data: { estado: 'ANULADO' } });
  });

  it('simular enseña lo que se revierte sin cambiar nada', async () => {
    const plan = await deshacerCarga(E, 2027, cargaId, { simular: true }, USUARIO_PRUEBA);
    expect(plan).toMatchObject({ puede: true, bloqueos: [], asientos2026: 1, vuelveVersion: null });
    expect(plan.acciones).toEqual(
      expect.arrayContaining([
        'Se borra el comparativo de 2026.',
        'Se borran 2 bienes de inmovilizado de la carga.',
        `Se anulan ${CARTERA_A.length} facturas pendientes de cobro o pago.`,
        'Se anula la apertura del 1-1-2027.',
        `Se anula el diario de 2026 importado (${DIARIO_A.length} asientos).`,
        '2026 vuelve a llevarse en la app.',
      ]),
    );
    // Alfa ya existía: no se ofrece borrarla. Las otras cinco fichas las creó la carga.
    expect(plan.fichasCreadas.map((f) => [f.nombre, f.borrable]).sort()).toEqual([
      ['Cliente Beta SA', true],
      ['Cliente Cero SL', true],
      ['Eléctrica Luz SL', true],
      ['Proveedor Dos SA', true],
      ['Proveedor Uno SL', true],
    ]);
    expect((await prisma.cargaArranque.findUniqueOrThrow({ where: { id: cargaId } })).estado).toBe('CONFIRMADA');
  });

  it('solo se borran las fichas que creó la carga', async () => {
    const e = await error(deshacerCarga(E, 2027, cargaId, { borrarFichas: [alfa] }, USUARIO_PRUEBA));
    expect(e.statusCode).toBe(400);
  });

  it('deshacer vuelve todo atrás', async () => {
    const creadas = (await deshacerCarga(E, 2027, cargaId, { simular: true }, USUARIO_PRUEBA)).fichasCreadas.map((f) => f.id);
    const r = await deshacerCarga(E, 2027, cargaId, { borrarFichas: creadas, devolverAsientos2026: true }, USUARIO_PRUEBA);
    expect(r.hecho).toBe('Carga 1 deshecha. 5 fichas borradas.');

    expect((await prisma.cargaArranque.findUniqueOrThrow({ where: { id: cargaId } })).estado).toBe('DESHECHA');
    expect(await prisma.journalEntry.count({ where: { companyId: E, estado: 'POSTED', origen: { in: ['APERTURA', 'APERTURA_AJUSTE'] } } })).toBe(0);
    expect(await prisma.journalEntry.count({ where: { companyId: E, estado: 'POSTED', origen: { startsWith: 'HISTORICO' } } })).toBe(0);
    expect(await prisma.partidaPendiente.count({ where: { companyId: E, estado: { not: 'ANULADA' } } })).toBe(0);
    expect(await prisma.activoFijo.count({ where: { companyId: E } })).toBe(0);
    expect(await prisma.priorYearData.count({ where: { companyId: E, ejercicio: 2026 } })).toBe(0);
    expect(await prisma.bankAccount.count({ where: { companyId: E } })).toBe(0);
    expect(await prisma.customer.findMany({ where: { companyId: E }, select: { id: true, subcuenta430: true } })).toEqual([{ id: alfa, subcuenta430: null }]);
    expect(await prisma.supplier.count({ where: { companyId: E } })).toBe(0);
    expect((await prisma.chartOfAccounts.findFirstOrThrow({ where: { companyId: E, codigo: '4300000002' } })).activo).toBe(false);
    expect(await longitudSubcuentasGuardada(E)).toBeNull();
    const reglas = (await prisma.reglasContables.findUnique({ where: { companyId: E } }))?.data as Record<string, unknown> | undefined;
    expect(reglas?.planAnterior).toBeUndefined();
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: asiento2026 } })).estado).toBe('POSTED');
    expect((await prisma.fiscalYear.findFirstOrThrow({ where: { companyId: E, label: '2026' } })).llevanza).toBe('APP');
    expect(await prisma.auditLog.count({ where: { companyId: E, action: 'ARRANQUE_DESHECHA' } })).toBe(1);
    // Ya deshecha: no se vuelve a deshacer.
    expect((await error(deshacerCarga(E, 2027, cargaId, {}, USUARIO_PRUEBA))).statusCode).toBe(409);
  });

  it('se puede volver a traer: la versión siguiente, sin chocar con lo que quedó ocupado', async () => {
    const { r } = await traerCarga(E, todosA(), AJUSTES_A);
    expect(r.carga.version).toBe(2);
    expect(await prisma.journalEntry.count({ where: { companyId: E, estado: 'POSTED', origen: 'APERTURA' } })).toBe(1);
    expect(await prisma.customer.count({ where: { companyId: E } })).toBe(3);
    expect((await prisma.chartOfAccounts.findFirstOrThrow({ where: { companyId: E, codigo: '4300000002' } })).activo).toBe(true);
  });
});

describe('deshacer una versión que sustituyó a otra', () => {
  const E = `arr-desh-b-${SUFIJO}`;
  let v1 = '';
  let v2 = '';
  beforeAll(async () => {
    await empresaDePrueba(E);
    v1 = (await traerCarga(E, todosA(), AJUSTES_A)).r.carga.id;
    v2 = (await traerCarga(E, todosA(), AJUSTES_A)).r.carga.id;
  }, 120_000);

  it('vuelve a estar vigente la anterior, con su apertura, su diario, sus facturas pendientes y sus bienes', async () => {
    const plan = await deshacerCarga(E, 2027, v2, { simular: true }, USUARIO_PRUEBA);
    expect(plan.vuelveVersion).toBe(1);
    expect(plan.fichasCreadas).toEqual([]);
    const r = await deshacerCarga(E, 2027, v2, {}, USUARIO_PRUEBA);
    expect(r.hecho).toBe('Carga 2 deshecha: vuelve a estar vigente la versión 1.');
    expect((await prisma.cargaArranque.findMany({ where: { companyId: E }, orderBy: { version: 'asc' } })).map((c) => c.estado)).toEqual(['CONFIRMADA', 'DESHECHA']);
    const aperturas = await prisma.journalEntry.findMany({ where: { companyId: E, estado: 'POSTED', origen: 'APERTURA' } });
    expect(aperturas.map((a) => a.numeroAsiento)).toEqual(['APERT-00001']);
    expect(await prisma.journalEntry.count({ where: { companyId: E, estado: 'POSTED', origen: { startsWith: 'HISTORICO' } } })).toBe(DIARIO_A.length);
    expect(await prisma.partidaPendiente.count({ where: { companyId: E, cargaId: v1, estado: 'PENDIENTE' } })).toBe(CARTERA_A.length);
    expect(await prisma.activoFijo.count({ where: { companyId: E, cargaId: v1, activo: true } })).toBe(2);
    expect(await prisma.priorYearData.count({ where: { companyId: E, ejercicio: 2026 } })).toBe(1);
    // Las fichas y la longitud siguen: las trajo la versión 1.
    expect(await prisma.customer.count({ where: { companyId: E, subcuenta430: { not: null } } })).toBe(3);
    expect(await longitudSubcuentasGuardada(E)).toBe(10);
    expect((await prisma.fiscalYear.findFirstOrThrow({ where: { companyId: E, label: '2026' } })).llevanza).toBe('EXTERNA');
  });

  it('un borrador no se deshace (se quitan sus ficheros)', async () => {
    const b = await subirYAnalizar(E, 2027, USUARIO_PRUEBA, [ficherosEmpresaA().plan], {}, TODOS);
    const e = await error(deshacerCarga(E, 2027, b.carga.id, {}, USUARIO_PRUEBA));
    expect(e.statusCode).toBe(409);
    expect(e.message).toMatch(/es un borrador/);
  });
});
