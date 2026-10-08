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
});
