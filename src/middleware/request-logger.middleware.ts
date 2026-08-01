/**
 * Middleware: Loguea todas las peticiones (método, ruta, timestamp)
 *
 * Uso: Agregar en app.ts antes de las rutas:
 *   app.use(requestLoggerMiddleware);
 *
 * Salida: archivo logs/requests.jsonl (una línea JSON por petición)
 * Formato:
 *   {"timestamp":"2026-06-30T10:15:30.123Z","method":"POST","path":"/auth/login","statusCode":200,"duration":45}
 */

import { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';

interface RequestLog {
  timestamp: string;
  method: string;
  path: string;
  statusCode?: number;
  duration?: number;
  userId?: string;
  companyId?: string;
}

// Crear directorio de logs si no existe
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const requestLogFile = path.join(logsDir, 'requests.jsonl');

/**
 * Middleware que loguea cada petición en formato JSONL
 * Se agrega al principio de la configuración de Express (antes de cualquier ruta)
 */
export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();

  // Crear una función de logging reutilizable
  const logRequest = () => {
    const duration = Date.now() - startTime;
    const log: RequestLog = {
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration,
    };

    // Agregar userId y companyId si están disponibles
    if ((req as any).user?.userId) {
      log.userId = (req as any).user.userId;
    }
    if ((req as any).params?.companyId) {
      log.companyId = (req as any).params.companyId;
    }

    // Escribir en JSONL
    fs.appendFileSync(requestLogFile, JSON.stringify(log) + '\n');
  };

  // Interceptar res.send
  const originalSend = res.send;
  res.send = function (data: any) {
    logRequest();
    return originalSend.call(this, data);
  };

  // Interceptar res.json (usado frecuentemente)
  const originalJson = res.json;
  res.json = function (data: any) {
    logRequest();
    return originalJson.call(this, data);
  };

  // Interceptar res.end
  const originalEnd = res.end;
  res.end = function (data?: any, encoding?: any) {
    logRequest();
    return originalEnd.call(this, data, encoding);
  };

  next();
}

/**
 * Analizar el archivo de logs y extraer rutas únicas utilizadas
 * Útil para comparar con el inventario de endpoints
 */
export function analyzeRequestLogs(): Map<string, { method: string; count: number; lastSeen: string }> {
  const routeUsage = new Map<string, { method: string; count: number; lastSeen: string }>();

  if (!fs.existsSync(requestLogFile)) {
    console.warn(`No logs found at ${requestLogFile}`);
    return routeUsage;
  }

  const lines = fs.readFileSync(requestLogFile, 'utf-8').split('\n').filter((l) => l.trim());

  lines.forEach((line) => {
    try {
      const log = JSON.parse(line) as RequestLog;
      const key = `${log.method} ${log.path}`;

      if (routeUsage.has(key)) {
        const existing = routeUsage.get(key)!;
        existing.count += 1;
        existing.lastSeen = log.timestamp;
      } else {
        routeUsage.set(key, {
          method: log.method,
          count: 1,
          lastSeen: log.timestamp,
        });
      }
    } catch (e) {
      // Ignorar líneas que no sean JSON válido
    }
  });

  return routeUsage;
}
