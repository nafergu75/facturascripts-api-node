/**
 * Middleware de errores ante un fallo de la base de datos que nadie ha traducido.
 *
 * Regresion (14-10-2026): «Registrar cobro» respondio un 500 con «Error interno
 * del servidor» cuando la transaccion caduco. Ahora cualquier fallo tecnico de
 * la base de datos llega a la persona con la causa en castellano y que hacer:
 * un 503 si es pasajero (tiempo, conexion), un 500 si no. El texto tecnico va
 * solo al log.
 */
import express from 'express';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { errorMiddleware } from '../middleware/error.middleware';
import { badRequest } from '../utils/http-errors';
import { CODIGO_FALLO_BD } from '../utils/errores-bd';

jest.mock('../config/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const version = Prisma.prismaVersion.client;
const conCodigo = (codigo: string, mensaje: string) => new Prisma.PrismaClientKnownRequestError(mensaje, { code: codigo, clientVersion: version });

function appQueFalla(err: unknown) {
  const app = express();
  app.post('/companies/1/income-invoices/f1/cobros', (_req, _res, next) => next(err));
  app.use(errorMiddleware);
  return app;
}
const pedir = (err: unknown) => request(appQueFalla(err)).post('/companies/1/income-invoices/f1/cobros?x=1');

const TEXTO_TIEMPO =
  'La base de datos ha tardado demasiado en responder. No se ha podido terminar la operación: comprueba si se ha guardado y, si no, vuelve a intentarlo dentro de un momento.';

describe('errores de la base de datos en el middleware', () => {
  it('transaccion caducada (P2028): 503 con el texto claro, sin el detalle tecnico', async () => {
    const r = await pedir(conCodigo('P2028', 'Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 30000 ms'));
    expect(r.status).toBe(503);
    expect(r.body.message).toBe(TEXTO_TIEMPO);
    expect(r.body.details).toMatchObject({ codigo: CODIGO_FALLO_BD, codigoBD: 'P2028' });
    expect(JSON.stringify(r.body)).not.toMatch(/Transaction already closed|Error interno del servidor/);
  });

  it('pool agotado (P2024) y sin conexion: tambien 503', async () => {
    const r1 = await pedir(conCodigo('P2024', 'Timed out fetching a new connection from the connection pool.'));
    expect(r1.status).toBe(503);
    expect(r1.body.message).toBe(TEXTO_TIEMPO);
    const r2 = await pedir(new Prisma.PrismaClientInitializationError("Can't reach database server at `x:4000`", version));
    expect(r2.status).toBe(503);
  });

  it('un error de la base de datos que no es pasajero: 500 con su causa y avisar a soporte', async () => {
    const r = await pedir(conCodigo('P2002', 'Unique constraint failed on the constraint: `JournalEntry_companyId_numeroAsiento_key`'));
    expect(r.status).toBe(500);
    expect(r.body.message).toBe(
      'La base de datos ha dado un error inesperado. No se ha podido terminar la operación. Si vuelve a pasar, avisa a soporte.',
    );
    expect(JSON.stringify(r.body)).not.toMatch(/Unique constraint|JournalEntry/);
  });

  it('un error que no es de la base de datos sigue con el 500 generico, sin detalles internos', async () => {
    const r = await pedir(new Error('fallo en /ruta/interna.ts'));
    expect(r.status).toBe(500);
    expect(r.body.message).toBe('Error interno del servidor');
  });

  it('un error con texto para la persona sale tal cual', async () => {
    const r = await pedir(badRequest('La fecha no es válida (AAAA-MM-DD).'));
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('La fecha no es válida (AAAA-MM-DD).');
  });
});
