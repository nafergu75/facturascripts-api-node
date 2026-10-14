// Jest aisla los modulos de cada fichero de test: cada uno que usa la BD carga
// su propio cliente Prisma, con su pool de conexiones, y nadie lo cerraba. Con
// todas las ramas integradas (mas de 140 ficheros) las conexiones abiertas
// llegaban al limite de MySQL (151) a mitad de la suite y los siguientes
// ficheros fallaban con "Too many connections". Al acabar cada fichero se
// cierra el cliente que haya cargado; si lo sustituyo un jest.mock, no se toca.
import { afterAll } from '@jest/globals';

afterAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const bd = require('../config/database') as { prisma?: { $disconnect?: () => Promise<void> } };
  if (typeof bd.prisma?.$disconnect === 'function') await bd.prisma.$disconnect();
  // Consultas con el cliente global dentro de una transaccion (config/guardaTransaccion):
  // fallan en el acto, pero el codigo puede tragarse el error (un try/catch que
  // decide otra cosa). Aqui se ensenan siempre: en produccion se cuelgan.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const guarda = require('../config/guardaTransaccion') as { infraccionesTransaccion?: () => readonly string[] };
  const vistas = guarda.infraccionesTransaccion?.() ?? [];
  if (vistas.length) {
    throw new Error(
      `${vistas.length} consulta(s) con el cliente global (prisma) dentro de una transacción. Usa el cliente de la transacción (tx):\n\n${vistas.join('\n\n')}`,
    );
  }
});
