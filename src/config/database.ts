import { PrismaClient } from '@prisma/client';
import { logger } from './logger';

/** Cliente Prisma compartido (singleton) para la BD propia (MySQL). */
export const prisma = new PrismaClient();

export async function connectDatabase(): Promise<void> {
  await prisma.$connect();
  logger.info('database: Prisma conectado (MySQL).');
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
