import { randomUUID } from 'crypto';
import { prisma } from '../config/database';
import { Prisma } from '@prisma/client';
import { AuditLog } from '../domain/auditoria.model';
import { logger } from '../config/logger';

/**
 * Auditoria PERSISTIDA en Prisma (tabla AuditLog). Fallback en memoria si la BD
 * no esta disponible. La escritura NUNCA debe romper la operacion auditada: los
 * errores de auditoria se registran en el logger y se continua.
 */
const memoria: AuditLog[] = [];
const dbOk = (): boolean => typeof (prisma as { auditLog?: { create?: unknown } }).auditLog?.create === 'function';

export async function registrarAuditoria(log: Omit<AuditLog, 'id' | 'timestamp'>): Promise<void> {
  const entry: AuditLog = { ...log, id: randomUUID(), timestamp: new Date().toISOString() };
  logger.info(`AUDIT ${entry.action} ${entry.resourceType}${entry.resourceId ? '#' + entry.resourceId : ''} by ${entry.userId}`);
  try {
    if (dbOk()) {
      await prisma.auditLog.create({
        data: {
          userId: entry.userId,
          companyId: entry.companyId ?? null,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId ?? null,
          meta: (entry.meta ?? entry.after ?? entry.before ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
      return;
    }
  } catch (err) {
    logger.warn(`AUDIT no persistido (${err instanceof Error ? err.message : 'error'}); usando memoria.`);
  }
  memoria.push(entry);
}

export async function listarAuditoria(companyId?: string): Promise<AuditLog[]> {
  if (dbOk()) {
    try {
      const rows = await prisma.auditLog.findMany({
        where: companyId ? { companyId } : {},
        orderBy: { timestamp: 'desc' },
        take: 500,
      });
      return rows.map((r) => ({
        id: r.id,
        timestamp: r.timestamp.toISOString(),
        userId: r.userId,
        companyId: r.companyId ?? undefined,
        action: r.action,
        resourceType: r.resourceType,
        resourceId: r.resourceId ?? undefined,
        meta: (r.meta as Record<string, unknown> | null) ?? undefined,
      }));
    } catch {
      /* fallback abajo */
    }
  }
  return companyId ? memoria.filter((l) => l.companyId === companyId) : [...memoria];
}
