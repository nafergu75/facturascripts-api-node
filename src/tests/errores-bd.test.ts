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
  QUE_HACER_REGISTRAR,
  TEXTO_AVISAR_SOPORTE,
  TEXTO_BD_ERROR,
  TEXTO_BD_LENTA,
  TEXTO_BD_OCUPADA,
} from '../utils/errores-bd';

jest.mock('../config/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { logger } = require('../config/logger') as { logger: { error: jest.Mock } };

const version = Prisma.prismaVersion.client;
const TEXTO_PRISMA =
  'Invalid `prisma.journalEntry.create()` invocation:\n\nTransaction API error: Transaction already closed: A query cannot be executed on an expired transaction. ' +
  'The timeout for this transaction was 5000 ms, however 5017 ms passed since the start of the transaction. Consider increasing the interactive transaction timeout or doing less work in the transaction.';
const caducada = () => new Prisma.PrismaClientKnownRequestError(TEXTO_PRISMA, { code: 'P2028', clientVersion: version });
const QUE_HACER = { resultado: 'El asiento no se ha creado', repetir: 'vuelve a pulsar «Contabilizar» dentro de un momento' };

describe('que es un fallo tecnico de la base de datos', () => {
  it('la transaccion caducada (P2028), sin conexion o al iniciar: «ha tardado demasiado»', () => {
    expect(causaFalloBD(caducada())).toBe(TEXTO_BD_LENTA);
    expect(causaFalloBD(new Prisma.PrismaClientKnownRequestError("Can't reach database server", { code: 'P1001', clientVersion: version }))).toBe(TEXTO_BD_LENTA);
    expect(causaFalloBD(new Prisma.PrismaClientInitializationError('Timed out', version))).toBe(TEXTO_BD_LENTA);
    expect(causaFalloBD(new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection from the connection pool.', { code: 'P2024', clientVersion: version }))).toBe(TEXTO_BD_LENTA);
    // El texto de Prisma en un Error cualquiera (p. ej. reenvuelto) tambien cuenta.
    expect(causaFalloBD(new Error(TEXTO_PRISMA))).toBe(TEXTO_BD_LENTA);
  });

  it('un choque con otra operacion a la vez (P2034): «estaba ocupada»', () => {
    expect(causaFalloBD(new Prisma.PrismaClientKnownRequestError('Transaction failed due to a write conflict or a deadlock', { code: 'P2034', clientVersion: version }))).toBe(TEXTO_BD_OCUPADA);
  });

  it('cualquier otro error de Prisma: «ha dado un error inesperado»', () => {
    expect(causaFalloBD(new Prisma.PrismaClientUnknownRequestError('Error en el motor', { clientVersion: version }))).toBe(TEXTO_BD_ERROR);
    expect(causaFalloBD(new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: version }))).toBe(TEXTO_BD_ERROR);
    expect(causaFalloBD(new Prisma.PrismaClientValidationError('Argument `fecha` is missing.', { clientVersion: version }))).toBe(TEXTO_BD_ERROR);
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
    expect(e!.message).toBe('La base de datos ha tardado demasiado en responder. El asiento no se ha creado: vuelve a pulsar «Contabilizar» dentro de un momento.');
    expect(e!.message).not.toMatch(/prisma|transaction|invocation/i);
    // El codigo de Prisma, como pista para soporte; su texto, no.
    expect(e!.details).toEqual({ codigo: CODIGO_FALLO_BD, causa: TEXTO_BD_LENTA, codigoBD: 'P2028' });
    expect(JSON.stringify(e!.details)).not.toMatch(/prisma/i);
    expect(logger.error).toHaveBeenCalledWith('Fallo de la base de datos al contabilizar la factura de venta f1', { codigo: 'P2028', detalle: TEXTO_PRISMA });
    // El detalle tecnico sigue a mano para el log y la auditoria.
    expect(detalleFalloBD(e)).toBe(TEXTO_PRISMA);
  });

  it('un choque con otra operacion a la vez tambien es pasajero: 503 y que lo repita', () => {
    const e = errorFalloBD(new Prisma.PrismaClientKnownRequestError('deadlock', { code: 'P2034', clientVersion: version }), QUE_HACER_REGISTRAR, 'registrar');
    expect(e!.statusCode).toBe(503);
    expect(e!.message).toBe(`${TEXTO_BD_OCUPADA} La factura no se ha registrado: vuelve a intentarlo dentro de un momento.`);
  });

  it('un error que se repetiria igual (P2002, dato demasiado largo, consulta mal hecha): 500 y sin «vuelve a pulsar», que avise a soporte', () => {
    const errores = [
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the constraint: `JournalEntry_companyId_numeroAsiento`', { code: 'P2002', clientVersion: version }),
      new Prisma.PrismaClientKnownRequestError("The provided value for the column is too long for the column's type.", { code: 'P2000', clientVersion: version }),
      new Prisma.PrismaClientValidationError('Invalid `tx.journalEntry.create()` invocation: Argument `fecha` is missing.', { clientVersion: version }),
    ];
    for (const original of errores) {
      const e = errorFalloBD(original, QUE_HACER, 'contabilizar la factura de venta f1');
      expect(e!.statusCode).toBe(500);
      expect(e!.message).toBe(`${TEXTO_BD_ERROR} El asiento no se ha creado. ${TEXTO_AVISAR_SOPORTE}`);
      expect(e!.message).not.toMatch(/vuelve a pulsar|dentro de un momento|prisma|constraint|invocation/i);
      expect(e!.details).toMatchObject({ codigo: CODIGO_FALLO_BD, causa: TEXTO_BD_ERROR });
      // El detalle tecnico sigue para el log y la auditoria.
      expect(detalleFalloBD(e)).toBe(original.message);
    }
    expect(errorFalloBD(errores[0], QUE_HACER, 'x')!.details).toMatchObject({ codigoBD: 'P2002' });
    // El motivo de un asiento automatico que no se crea no pide repetir: solo la causa.
    expect(motivoSinAsiento(errores[0])).toBe(`${TEXTO_BD_ERROR} La factura sí está registrada.`);
  });

  it('sin nada que repetir, solo el resultado (pasajero o no)', () => {
    const yaGrabada = { resultado: 'La factura sí está registrada' };
    expect(errorFalloBD(caducada(), yaGrabada, 'x')!.message).toBe(`${TEXTO_BD_LENTA} La factura sí está registrada.`);
    expect(errorFalloBD(new Prisma.PrismaClientUnknownRequestError('x', { clientVersion: version }), yaGrabada, 'x')!.message).toBe(`${TEXTO_BD_ERROR} La factura sí está registrada.`);
  });

  it('asiento automatico que no se crea: la causa y que la factura si esta registrada', () => {
    expect(motivoSinAsiento(caducada())).toBe('La base de datos ha tardado demasiado en responder. La factura sí está registrada.');
    // Tambien si ya llega traducido por «Contabilizar» (el enganche lo llama por dentro).
    expect(motivoSinAsiento(errorFalloBD(caducada(), QUE_HACER, 'x'))).toBe('La base de datos ha tardado demasiado en responder. La factura sí está registrada.');
  });
});
