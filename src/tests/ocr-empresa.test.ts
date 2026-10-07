/**
 * Controladores de OCR sin BD: toda consulta lleva el companyId que fija
 * companyScope (req.companyId), nunca el de req.params; si falta, no se
 * consulta nada (antes, un companyId undefined hacia que Prisma devolviera las
 * sesiones de todas las empresas). Y los 500 no devuelven el mensaje interno.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockLlamadas: Array<{ metodo: string; args: { where?: Record<string, unknown> } }> = [];
let mockFallo: Error | null = null;

jest.mock('../config/database', () => {
  const metodo = (nombre: string, resultado: unknown) =>
    jest.fn(async (args: { where?: Record<string, unknown> }) => {
      mockLlamadas.push({ metodo: nombre, args });
      if (mockFallo) throw mockFallo;
      return resultado;
    });
  return {
    prisma: {
      oCRSession: {
        findMany: metodo('findMany', []),
        findFirst: metodo('findFirst', null),
        count: metodo('count', 0),
        aggregate: metodo('aggregate', { _avg: { processingTimeSeconds: null } }),
        update: metodo('update', {}),
      },
    },
  };
});

import ocrSessionsController from '../controllers/ocr-sessions.controller';
import ocrAnalyticsController from '../controllers/ocr-analytics.controller';

type Manejador = (req: never, res: never) => Promise<unknown>;

async function llamar(fn: Manejador, req: Record<string, unknown>) {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  await fn({ params: {}, query: {}, body: {}, ...req } as never, res as never);
  return res;
}

const manejadores: Array<[string, Manejador]> = [
  ['sesiones: listado', ocrSessionsController.getSessions.bind(ocrSessionsController)],
  ['sesiones: detalle', ocrSessionsController.getSession.bind(ocrSessionsController)],
  ['sesiones: estadisticas', ocrSessionsController.getStats.bind(ocrSessionsController)],
  ['sesiones: reintento', ocrSessionsController.retrySesion.bind(ocrSessionsController)],
  ['sesiones: enviar al lector', ocrSessionsController.sendToReader.bind(ocrSessionsController)],
  ['analytics: KPIs', ocrAnalyticsController.getKPIs.bind(ocrAnalyticsController)],
  ['analytics: evolucion', ocrAnalyticsController.getTimeline.bind(ocrAnalyticsController)],
  ['analytics: distribucion', ocrAnalyticsController.getDistribution.bind(ocrAnalyticsController)],
];

beforeEach(() => {
  mockLlamadas.length = 0;
  mockFallo = null;
});

describe('OCR: consultas siempre con la empresa validada', () => {
  it.each(manejadores)('%s: filtra por req.companyId, no por req.params', async (_n, fn) => {
    await llamar(fn, { companyId: 'empresa-A', params: { companyId: 'empresa-B', sessionId: 's1' } });
    expect(mockLlamadas.length).toBeGreaterThan(0);
    for (const l of mockLlamadas) expect(l.args.where?.companyId).toBe('empresa-A');
  });

  it.each(manejadores)('%s: sin req.companyId no consulta nada', async (_n, fn) => {
    const res = await llamar(fn, { params: { sessionId: 's1' } });
    expect(mockLlamadas).toEqual([]);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it.each(manejadores)('%s: un 500 no devuelve el mensaje interno', async (_n, fn) => {
    mockFallo = new Error('Invalid `prisma.oCRSession.findMany()` invocation in C:\\ruta\\interna: Can\'t reach database server');
    const res = await llamar(fn, { companyId: 'empresa-A', params: { sessionId: 's1' } });
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/prisma|ruta|interna|database server/i);
  });
});
