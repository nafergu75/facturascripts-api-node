/**
 * Middleware: Loguea todas las peticiones (método, ruta, timestamp)
 *
 * Uso: Agregar en app.ts antes de las rutas:
 *   app.use(requestLoggerMiddleware);
 *
 * Salida: en local, archivo logs/requests.jsonl (una línea JSON por petición).
 * En Vercel el disco es de solo lectura: la línea va a stdout (logs de Vercel).
 * Formato:
 *   {"timestamp":"2026-06-30T10:15:30.123Z","method":"POST","path":"/auth/login","statusCode":200,"duration":45}
 */

import { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { enServerless } from '../utils/paths';

interface RequestLog {
  timestamp: string;
  method: string;
  path: string;
  statusCode?: number;
  duration?: number;
  userId?: string;
  companyId?: string;
}

// La carpeta se crea al escribir la primera linea, no al cargar el modulo: en
// Vercel un mkdir en la carga tumbaba la funcion antes de atender nada (EROFS).
const logsDir = path.join(process.cwd(), 'logs');
const requestLogFile = path.join(logsDir, 'requests.jsonl');

function escribirLinea(linea: string): void {
  if (enServerless()) {
    // eslint-disable-next-line no-console
    console.log(linea);
    return;
  }
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(requestLogFile, linea + '\n');
  } catch {
    // Un fallo del log nunca debe romper la peticion.
  }
}

/**
 * Middleware que loguea cada petición en formato JSONL
 * Se agrega al principio de la configuración de Express (antes de cualquier ruta)
 */
export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();
  // res.json llama a res.send, y este a res.end: sin esta marca, cada peticion
  // se registraba dos o tres veces.
  let registrado = false;

  // Crear una función de logging reutilizable
  const logRequest = () => {
    if (registrado) return;
    registrado = true;
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

    escribirLinea(JSON.stringify(log));
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
