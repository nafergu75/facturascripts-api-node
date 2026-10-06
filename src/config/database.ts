import { PrismaClient } from '@prisma/client';
import { logger } from './logger';
import { importesComoNumero } from './decimales';
import { reintentoConexion } from './reintentoConexion';

/**
 * Cliente Prisma compartido (singleton) para la BD propia (MySQL). Los importes
 * se guardan como Decimal y se leen como number (ver config/decimales.ts), y
 * las consultas que fallan por no poder conectar se reintentan (ver
 * config/reintentoConexion.ts).
 */
export const prisma = new PrismaClient().$extends(reintentoConexion).$extends(importesComoNumero);

/** Tipo del cliente compartido (extendido) y del cliente de una transaccion suya. */
export type ClienteBD = typeof prisma;
export type TransaccionBD = Parameters<Parameters<ClienteBD['$transaction']>[0]>[0];

export async function connectDatabase(): Promise<void> {
  await prisma.$connect();
  logger.info('database: Prisma conectado (MySQL).');
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
