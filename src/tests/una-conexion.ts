/**
 * Ayuda de los tests: el cliente Prisma compartido con UNA sola conexion en el
 * pool, como en produccion (Vercel + TiDB con connection_limit=1).
 *
 * Con una conexion, la transaccion interactiva la tiene ocupada mientras dura:
 * una consulta con el cliente global (prisma) dentro de su callback se queda
 * esperando conexion hasta el pool_timeout (P2024) y la transaccion caduca
 * (P2028). Con el pool de varias conexiones de local, ese fallo no se ve.
 *
 * Uso, al principio del fichero de test:
 *   jest.mock('../config/database', () => require('./una-conexion').clienteDeUnaConexion());
 */

/** La URL de la base de datos con connection_limit=1 y un pool_timeout corto (para que falle pronto). */
export function urlDeUnaConexion(url: string, poolTimeoutSegundos = 5): string {
  const u = new URL(url);
  u.searchParams.set('connection_limit', '1');
  u.searchParams.set('pool_timeout', String(poolTimeoutSegundos));
  return u.toString();
}

/** El modulo config/database real, con el cliente creado sobre una sola conexion. */
export function clienteDeUnaConexion(): unknown {
  process.env.DATABASE_URL = urlDeUnaConexion(process.env.DATABASE_URL ?? '');
  return jest.requireActual('../config/database');
}
