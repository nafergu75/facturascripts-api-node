/**
 * Tiempo de las transacciones interactivas y reintento de conexion dentro de
 * ellas, sobre BD real.
 *
 * Regresion (13-10-2026): en produccion una venta leida se registro sin asiento
 * porque la transaccion de contabilizarla paso de los 5 s que da Prisma por
 * defecto («Transaction already closed ... 5017 ms passed»). El cliente
 * compartido da ahora 30 s; las extensiones (reintento e importes) no pueden
 * perder esa opcion, y las llamadas con opciones propias las conservan.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { crearClienteBD, OPCIONES_TRANSACCION, prisma } from '../config/database';
import { reintentoConexion } from '../config/reintentoConexion';

jest.mock('../config/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const dormir = (tx: { $queryRawUnsafe: (sql: string) => Promise<unknown> }, segundos: number) => tx.$queryRawUnsafe(`SELECT SLEEP(${segundos})`);
const expirada = /Transaction already closed|expired transaction|P2028/i;

const sinConexion = () => new Prisma.PrismaClientKnownRequestError('Server has closed the connection.', { code: 'P1017', clientVersion: Prisma.prismaVersion.client });

/** Cliente con el reintento por fuera y una extension que simula cortes de conexion en company.count. */
function clienteConCortes() {
  const estado = { cortes: 0, llamadas: 0 };
  const cliente = new PrismaClient().$extends(reintentoConexion).$extends({
    query: {
      company: {
        count({ args, query }) {
          estado.llamadas++;
          if (estado.cortes > 0) {
            estado.cortes--;
            throw sinConexion();
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

describe('tiempo de las transacciones', () => {
  it('el cliente compartido da 30 s y 10 s de espera (no los 5 s y 2 s de Prisma)', () => {
    expect(OPCIONES_TRANSACCION).toEqual({ maxWait: 10_000, timeout: 30_000 });
  });

  it('las extensiones conservan el tiempo de la transaccion: con 300 ms, una de 600 ms caduca', async () => {
    const corto = crearClienteBD({ maxWait: 5_000, timeout: 300 });
    otros.push(corto);
    await expect(
      corto.$transaction(async (tx) => {
        await dormir(tx, 0.6);
        return tx.company.count();
      }),
    ).rejects.toThrow(expirada);
  });

  it('una transaccion de mas de 5 s termina bien con el cliente compartido', async () => {
    const n = await prisma.$transaction(async (tx) => {
      await dormir(tx, 5.5);
      return tx.company.count();
    });
    expect(typeof n).toBe('number');
  }, 60_000);

  it('una llamada con su propio tiempo lo conserva', async () => {
    await expect(
      prisma.$transaction(
        async (tx) => {
          await dormir(tx, 0.6);
          return tx.company.count();
        },
        { timeout: 300 },
      ),
    ).rejects.toThrow(expirada);
  });
});

describe('reintento de conexion y transacciones', () => {
  it('fuera de una transaccion, una consulta sin conexion se repite', async () => {
    const { cliente, estado } = clienteConCortes();
    otros.push(cliente);
    estado.cortes = 1;
    await expect(cliente.company.count()).resolves.toEqual(expect.any(Number));
    expect(estado.llamadas).toBe(2);
  });

  it('dentro de una transaccion no se repite: falla la transaccion entera', async () => {
    const { cliente, estado } = clienteConCortes();
    otros.push(cliente);
    estado.cortes = 1;
    await expect(cliente.$transaction(async (tx) => tx.company.count())).rejects.toMatchObject({ code: 'P1017' });
    expect(estado.llamadas).toBe(1);
  });
});
