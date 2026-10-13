/**
 * Fallos tecnicos de la base de datos frente a errores para el usuario.
 *
 * Regresion (13-10-2026): el lector de ventas enseno al usuario «No se ha
 * podido crear su asiento: Error contabilizando factura: Invalid
 * `prisma.journalEntry.create()` invocation: Transaction API error: Transaction
 * already closed...». Los fallos tecnicos se dicen ahora en castellano y su
 * detalle va al log; los errores de negocio siguen con su texto.
 */
import { Prisma } from '@prisma/client';
import { badRequest, HttpError } from '../utils/http-errors';
import {
  causaFalloBD,
  CODIGO_FALLO_BD,
  detalleFalloBD,
  errorFalloBD,
  esFalloTecnicoBD,
  motivoSinAsiento,
  TEXTO_BD_ERROR,
  TEXTO_BD_LENTA,
} from '../utils/errores-bd';

jest.mock('../config/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { logger } = require('../config/logger') as { logger: { error: jest.Mock } };

const version = Prisma.prismaVersion.client;
const TEXTO_PRISMA =
  'Invalid `prisma.journalEntry.create()` invocation:\n\nTransaction API error: Transaction already closed: A query cannot be executed on an expired transaction. ' +
  'The timeout for this transaction was 5000 ms, however 5017 ms passed since the start of the transaction. Consider increasing the interactive transaction timeout or doing less work in the transaction.';
const caducada = () => new Prisma.PrismaClientKnownRequestError(TEXTO_PRISMA, { code: 'P2028', clientVersion: version });
const QUE_HACER = 'El asiento no se ha creado: vuelve a pulsar «Contabilizar» dentro de un momento.';

describe('que es un fallo tecnico de la base de datos', () => {
  it('la transaccion caducada (P2028), sin conexion o al iniciar: «ha tardado demasiado»', () => {
    expect(causaFalloBD(caducada())).toBe(TEXTO_BD_LENTA);
    expect(causaFalloBD(new Prisma.PrismaClientKnownRequestError("Can't reach database server", { code: 'P1001', clientVersion: version }))).toBe(TEXTO_BD_LENTA);
    expect(causaFalloBD(new Prisma.PrismaClientInitializationError('Timed out', version))).toBe(TEXTO_BD_LENTA);
    expect(causaFalloBD(new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection from the connection pool.', { code: 'P2024', clientVersion: version }))).toBe(TEXTO_BD_LENTA);
    // El texto de Prisma en un Error cualquiera (p. ej. reenvuelto) tambien cuenta.
    expect(causaFalloBD(new Error(TEXTO_PRISMA))).toBe(TEXTO_BD_LENTA);
  });

  it('cualquier otro error de Prisma: «ha dado un error inesperado»', () => {
    expect(causaFalloBD(new Prisma.PrismaClientUnknownRequestError('Error en el motor', { clientVersion: version }))).toBe(TEXTO_BD_ERROR);
    expect(causaFalloBD(new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: version }))).toBe(TEXTO_BD_ERROR);
  });

  it('los errores para el usuario no lo son: se quedan con su texto', () => {
    const negocio = badRequest('La cuenta 600 no es de ventas: elige una del grupo 70.');
    expect(esFalloTecnicoBD(negocio)).toBe(false);
    expect(causaFalloBD(negocio)).toBeNull();
    expect(motivoSinAsiento(negocio)).toBe('La cuenta 600 no es de ventas: elige una del grupo 70.');
    expect(esFalloTecnicoBD(new Error('Tipo de cambio no válido: 0'))).toBe(false);
    expect(motivoSinAsiento(new Error('Tipo de cambio no válido: 0'))).toBe('Tipo de cambio no válido: 0');
    expect(errorFalloBD(negocio, QUE_HACER, 'contabilizar')).toBeNull();
  });
});

describe('lo que se dice a la persona', () => {
  it('«Contabilizar»: un 503 con la causa y que hacer, sin el texto de Prisma, y el detalle al log', () => {
    logger.error.mockClear();
    const e = errorFalloBD(caducada(), QUE_HACER, 'contabilizar la factura de venta f1');
    expect(e).toBeInstanceOf(HttpError);
    expect(e!.statusCode).toBe(503);
    expect(e!.message).toBe(`${TEXTO_BD_LENTA} ${QUE_HACER}`);
    expect(e!.message).not.toMatch(/prisma|transaction|invocation/i);
    expect(e!.details).toEqual({ codigo: CODIGO_FALLO_BD, causa: TEXTO_BD_LENTA });
    expect(JSON.stringify(e!.details)).not.toMatch(/prisma/i);
    expect(logger.error).toHaveBeenCalledWith('Fallo de la base de datos al contabilizar la factura de venta f1', { codigo: 'P2028', detalle: TEXTO_PRISMA });
    // El detalle tecnico sigue a mano para el log y la auditoria.
    expect(detalleFalloBD(e)).toBe(TEXTO_PRISMA);
  });

  it('asiento automatico que no se crea: la causa y que la factura si esta registrada', () => {
    expect(motivoSinAsiento(caducada())).toBe('La base de datos ha tardado demasiado en responder. La factura sí está registrada.');
    // Tambien si ya llega traducido por «Contabilizar» (el enganche lo llama por dentro).
    expect(motivoSinAsiento(errorFalloBD(caducada(), QUE_HACER, 'x'))).toBe('La base de datos ha tardado demasiado en responder. La factura sí está registrada.');
  });
});
