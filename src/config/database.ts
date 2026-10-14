import { PrismaClient } from '@prisma/client';
import { logger } from './logger';
import { importesComoNumero } from './decimales';
import { reintentoConexion } from './reintentoConexion';
import { inmutabilidadVerifactu } from './inmutabilidadVerifactu';

/**
 * Tiempo de las transacciones interactivas (prisma.$transaction(async (tx) => ...)).
 *
 * Prisma da 5 s a cada transaccion y 2 s para conseguir conexion. En produccion
 * (Vercel en fra1 + TiDB Serverless en Frankfurt) cada consulta es un viaje de
 * red y TiDB puede tardar en despertar: el 13-10-2026 una venta leida se quedo
 * sin asiento porque su transaccion paso de 5 s. Con 30 s y 10 s de espera hay
 * margen de sobra y seguimos muy por debajo de lo que puede durar la funcion
 * en Vercel (300 s con Fluid compute; aquella peticion tardo 10 s y no se corto).
 * Las llamadas que pasan sus propias opciones (compras, nominas, la carga de
 * 2026...) las conservan: Prisma solo usa estas para lo que no se indica.
 */
export const OPCIONES_TRANSACCION = { maxWait: 10_000, timeout: 30_000 } as const;

/**
 * Cliente Prisma con las extensiones de la app: reintento de conexion, importes
 * como number e inmutabilidad de VERI*FACTU (registros y facturas registradas).
 */
export function crearClienteBD(transactionOptions: { maxWait: number; timeout: number } = OPCIONES_TRANSACCION) {
  return new PrismaClient({ transactionOptions }).$extends(reintentoConexion).$extends(importesComoNumero).$extends(inmutabilidadVerifactu);
}

/**
 * Cliente Prisma compartido (singleton) para la BD propia (MySQL). Los importes
 * se guardan como Decimal y se leen como number (ver config/decimales.ts), y
 * las consultas que fallan por no poder conectar se reintentan (ver
 * config/reintentoConexion.ts).
 */
export const prisma = crearClienteBD();

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
