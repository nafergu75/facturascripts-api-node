/**
 * Guarda de las transacciones (config/guardaTransaccion) y reintento de
 * conexion dentro de ellas, sobre BD real.
 *
 * Regresion (14-10-2026): «Registrar cobro» respondio 500 a los 30 s. Dentro de
 * la transaccion del cobro se consultaba con el cliente global (prisma) en vez
 * de con el de la transaccion (tx). En produccion el pool tiene una sola
 * conexion y la tenia la transaccion: la consulta espero conexion hasta el
 * pool_timeout (P2024), se reintento dos veces como si no hubiera conexion y la
 * transaccion caduco (P2028).
 *
 * Ahora el cliente compartido marca el callback de cada transaccion: en los
 * tests, una consulta global dentro falla en el acto (y jest.cerrar-bd la
 * ensena aunque el codigo se trague el error); fuera de los tests se avisa en
 * el log. Y dentro del callback, el pool agotado (P2024) no se reintenta.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../config/database';
import { reintentoConexion } from '../config/reintentoConexion';
import {
  ClienteGlobalEnTransaccion,
  dentroDeTransaccion,
  enCallbackDeTransaccion,
  infraccionesTransaccion,
  olvidarInfracciones,
} from '../config/guardaTransaccion';
import { logger } from '../config/logger';

jest.mock('../config/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const version = Prisma.prismaVersion.client;
const poolAgotado = () =>
  new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection from the connection pool.', { code: 'P2024', clientVersion: version });
const sinConexion = () => new Prisma.PrismaClientKnownRequestError('Server has closed the connection.', { code: 'P1017', clientVersion: version });

/** Cliente con el reintento por fuera y una extension que hace fallar company.count las veces que se diga. */
function clienteConFallos(fallo: () => Error) {
  const estado = { fallos: 0, llamadas: 0 };
  const cliente = new PrismaClient().$extends(reintentoConexion).$extends({
    query: {
      company: {
        count({ args, query }) {
          estado.llamadas++;
          if (estado.fallos > 0) {
            estado.fallos--;
            throw fallo();
          }
          return query(args);
        },
      },
    },
  });
  return { cliente, estado };
}

const otros: Array<{ $disconnect: () => Promise<void> }> = [];
afterAll(async () => {
  for (const c of otros) await c.$disconnect();
});

describe('guarda: cliente global dentro de una transaccion', () => {
  afterEach(() => olvidarInfracciones());

  it('con tx dentro del callback, y con el global fuera, todo va bien', async () => {
    expect(dentroDeTransaccion()).toBe(false);
    const n = await prisma.$transaction(async (tx) => {
      expect(dentroDeTransaccion()).toBe(true);
      await tx.$queryRaw`SELECT 1`;
      return tx.company.count();
    });
    expect(typeof n).toBe('number');
    await expect(prisma.company.count()).resolves.toEqual(expect.any(Number));
    // La transaccion en lote no tiene callback: sus consultas van dentro de ella.
    await expect(prisma.$transaction([prisma.company.count()])).resolves.toHaveLength(1);
    expect(infraccionesTransaccion()).toHaveLength(0);
  });

  it('en los tests, una consulta con el global dentro del callback falla en el acto y dice donde esta', async () => {
    const t0 = Date.now();
    const error = await prisma
      .$transaction(async () => {
        await prisma.fiscalYear.findFirst({ where: { companyId: 'nadie' } });
      })
      .catch((e: unknown) => e);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(error).toBeInstanceOf(ClienteGlobalEnTransaccion);
    expect((error as Error).message).toMatch(/FiscalYear\.findFirst \(src\/tests\/guarda-transaccion\.db\.test\.ts:\d+\).*usa el cliente de la transacción \(tx\)/);
    expect(infraccionesTransaccion()).toHaveLength(1);
  });

  it('tambien las consultas en crudo y las transacciones dentro de otra', async () => {
    await expect(prisma.$transaction(async () => prisma.$queryRaw`SELECT 1`)).rejects.toBeInstanceOf(ClienteGlobalEnTransaccion);
    await expect(prisma.$transaction(async () => prisma.$transaction(async (tx) => tx.company.count()))).rejects.toBeInstanceOf(ClienteGlobalEnTransaccion);
    expect(infraccionesTransaccion()).toHaveLength(2);
  });

  it('queda anotada aunque el codigo se trague el error (jest.cerrar-bd la ensena al final)', async () => {
    await prisma.$transaction(async (tx) => {
      try {
        await prisma.periodo.findFirst({ where: { companyId: 'nadie' } });
      } catch {
        // como hacia anularEnTx con comprobarFechaAbierta: el error no sale
      }
      return tx.company.count();
    });
    expect(infraccionesTransaccion()).toHaveLength(1);
  });

  it('fuera de los tests (o con BD_GUARDA_TRANSACCION=aviso) solo avisa en el log y deja seguir la consulta', async () => {
    process.env.BD_GUARDA_TRANSACCION = 'aviso';
    try {
      // Con varias conexiones en el pool, la consulta responde. Con una sola (el
      // CI, como produccion) espera hasta el pool_timeout y falla con P2024, una
      // sola vez: dentro del callback no se reintenta.
      const t0 = Date.now();
      const r = await prisma.$transaction(async () => prisma.company.count()).catch((e: unknown) => e);
      if (typeof r !== 'number') {
        expect(r).toMatchObject({ code: 'P2024' });
        const poolTimeout = Number(new URL(process.env.DATABASE_URL ?? '').searchParams.get('pool_timeout') ?? 10);
        expect(Date.now() - t0).toBeLessThan(poolTimeout * 1000 + 2_500);
      }
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Company.count'), expect.objectContaining({ consulta: 'Company.count' }));
      expect(infraccionesTransaccion()).toHaveLength(0);
    } finally {
      delete process.env.BD_GUARDA_TRANSACCION;
    }
  });
});

describe('reintento de conexion dentro del callback de una transaccion', () => {
  beforeAll(() => {
    // Aqui se prueba el reintento, no la guarda: solo aviso.
    process.env.BD_GUARDA_TRANSACCION = 'aviso';
  });
  afterAll(() => {
    delete process.env.BD_GUARDA_TRANSACCION;
  });

  it('el pool agotado (P2024) no se repite dentro del callback: la conexion la tiene la propia transaccion', async () => {
    const { cliente, estado } = clienteConFallos(poolAgotado);
    otros.push(cliente);
    estado.fallos = 1;
    await expect(enCallbackDeTransaccion(async () => await cliente.company.count())).rejects.toMatchObject({ code: 'P2024' });
    expect(estado.llamadas).toBe(1);
  });

  it('un corte de conexion dentro del callback si se repite (la consulta no llego a ejecutarse)', async () => {
    const { cliente, estado } = clienteConFallos(sinConexion);
    otros.push(cliente);
    estado.fallos = 1;
    await expect(enCallbackDeTransaccion(async () => await cliente.company.count())).resolves.toEqual(expect.any(Number));
    expect(estado.llamadas).toBe(2);
  });

  it('fuera de una transaccion, el pool agotado se sigue repitiendo', async () => {
    const { cliente, estado } = clienteConFallos(poolAgotado);
    otros.push(cliente);
    estado.fallos = 1;
    await expect(cliente.company.count()).resolves.toEqual(expect.any(Number));
    expect(estado.llamadas).toBe(2);
  });
});
