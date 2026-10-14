/**
 * Rutas del motor contable (/companies/:companyId/accounting) cuando falla la
 * base de datos: ver un asiento, la lista de asientos y ajustar una linea de un
 * borrador.
 *
 * Antes, un error de Prisma acababa en un 400 con su texto tecnico
 * («Error ajustando línea: Invalid `prisma.journalEntryLine.update()`...»): el
 * controlador lo envolvia en badRequest y la ruta convertia en 400 todo lo que
 * no fuera HttpError. Ahora la persona lee el 503 claro, como al contabilizar
 * o aprobar, y el detalle tecnico va solo al log.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll, afterEach, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { accountingEngineRoutes } from '../routes/accounting-engine.routes';
import { errorMiddleware } from '../middleware/error.middleware';

jest.mock('../services/auditoria.service', () => ({ registrarAuditoria: jest.fn() }));

const COMPANY_ID = `motor-fallo-bd-${Date.now()}`;
let asientoId: string;
let lineaId: string;

/** El error de Prisma de un pool agotado (sin conexion libre a tiempo). */
const poolAgotado = () =>
  new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection from the connection pool.', {
    code: 'P2024',
    clientVersion: Prisma.prismaVersion.client,
  });

/** El motor contable montado como en routes/index.ts, con la sesion ya verificada. */
function appMotor() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = {
      userId: 'u-motor',
      email: 'contable@test.local',
      roles: ['contable'],
      companies: [COMPANY_ID],
      rolesPorEmpresa: { [COMPANY_ID]: ['contable'] },
      sesionVerificada: true,
    } as never;
    next();
  });
  a.use('/companies/:companyId/accounting', accountingEngineRoutes);
  a.use(errorMiddleware);
  return a;
}

beforeAll(async () => {
  await prisma.company.create({ data: { id: COMPANY_ID, name: 'Motor Fallo BD SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  const asiento = await prisma.journalEntry.create({
    data: {
      companyId: COMPANY_ID,
      fecha: new Date('2026-10-01T00:00:00.000Z'),
      numeroAsiento: 'AJUSTE-1',
      descripcion: 'Borrador de prueba',
      origen: 'AJUSTE_MANUAL',
      estado: 'DRAFT',
      lineas: {
        create: [
          { companyId: COMPANY_ID, accountCode: '629', accountName: 'Otros servicios', debe: 100, haber: 0 },
          { companyId: COMPANY_ID, accountCode: '57200001', accountName: 'Banco', debe: 0, haber: 100 },
        ],
      },
    },
    include: { lineas: true },
  });
  asientoId = asiento.id;
  lineaId = asiento.lineas.find((l) => l.accountCode === '629')!.id;
}, 60_000);

afterEach(() => {
  jest.restoreAllMocks();
});

const URL_BASE = () => `/companies/${COMPANY_ID}/accounting/journal-entries`;

describe('rutas del motor contable si falla la base de datos', () => {
  it('ajustar una linea: 503 con el texto claro (no un 400 con el de Prisma) y la linea sin cambiar', async () => {
    jest.spyOn(prisma.journalEntryLine, 'update').mockRejectedValueOnce(poolAgotado() as never);
    const r = await request(appMotor()).patch(`${URL_BASE()}/${asientoId}/lines/${lineaId}`).send({ debe: 100 });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('La base de datos ha tardado demasiado en responder. La línea no se ha cambiado: vuelve a intentarlo dentro de un momento.');
    expect(r.body.details).toMatchObject({ codigo: 'FALLO_BD', codigoBD: 'P2024' });
    expect(JSON.stringify(r.body)).not.toMatch(/prisma|Timed out/i);
  });

  it('ver un asiento: 503 con el texto claro', async () => {
    jest.spyOn(prisma.journalEntry, 'findFirst').mockRejectedValueOnce(poolAgotado() as never);
    const r = await request(appMotor()).get(`${URL_BASE()}/${asientoId}`);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('La base de datos ha tardado demasiado en responder. No se ha podido cargar el asiento: vuelve a intentarlo dentro de un momento.');
    expect(r.body.details).toMatchObject({ codigo: 'FALLO_BD' });
  });

  it('la lista de asientos: 503 con el texto claro (antes el fallo ni pasaba por el catch del controlador)', async () => {
    jest.spyOn(prisma.journalEntry, 'findMany').mockRejectedValueOnce(poolAgotado() as never);
    const r = await request(appMotor()).get(URL_BASE());
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('La base de datos ha tardado demasiado en responder. No se han podido cargar los asientos: vuelve a intentarlo dentro de un momento.');
    expect(r.body.details).toMatchObject({ codigo: 'FALLO_BD' });
  });

  it('con la base de datos bien, todo responde como siempre', async () => {
    const lista = await request(appMotor()).get(URL_BASE());
    expect(lista.status).toBe(200);
    expect(lista.body.map((a: { id: string }) => a.id)).toContain(asientoId);
    const detalle = await request(appMotor()).get(`${URL_BASE()}/${asientoId}`);
    expect(detalle.status).toBe(200);
    expect(detalle.body.validaciones.cuadrado).toBe(true);
    const ajuste = await request(appMotor()).patch(`${URL_BASE()}/${asientoId}/lines/${lineaId}`).send({ debe: 100 });
    expect(ajuste.status).toBe(200);
    // Un error de negocio sigue con su codigo y su texto (aqui, el asiento se descuadraria).
    const descuadre = await request(appMotor()).patch(`${URL_BASE()}/${asientoId}/lines/${lineaId}`).send({ debe: 90 });
    expect(descuadre.status).toBe(400);
    expect(descuadre.body.error).toMatch(/desequilibra el asiento/);
  });
});
