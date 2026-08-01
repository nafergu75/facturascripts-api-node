import express, { Express } from 'express';
import cors from 'cors';
import routes from './routes';
import docsRouter from './routes/docs';
import { config } from './config/env';
import { logger } from './config/logger';
import { setupSwagger } from './docs/swagger';
import { errorMiddleware, notFoundHandler } from './middleware/error.middleware';
import { rateLimit } from './middleware/rate-limit.middleware';
import { securityHeaders } from './middleware/security-headers.middleware';
import { requestLoggerMiddleware } from './middleware/request-logger.middleware';

/** Crea y configura la instancia de Express. */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by'); // no revelar el motor (Express)
  app.set('trust proxy', 1); // detras de un reverse-proxy: req.ip real para rate limiting

  app.use(securityHeaders); // cabeceras de seguridad (helmet-equivalente)

  // CORS restrictivo: solo los origenes configurados (config.corsOrigins).
  // Las peticiones sin Origin (curl, server-to-server, healthchecks) se permiten.
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
        // Denegar sin lanzar: el navegador bloquea (no recibe Allow-Origin) y
        // evitamos un 500 ruidoso en cada peticion de origen no permitido.
        logger.warn(`CORS bloqueado para origen no permitido: ${origin}`);
        return cb(null, false);
      },
      credentials: true,
    }),
  );

  app.use(rateLimit({ ventanaMs: 60_000, max: 300 })); // OWASP API4: limita consumo
  // 20mb: el lector de facturas envia archivos (hasta 15MB) como JSON en base64
  // (~33% mas grande que el binario original).
  app.use(express.json({ limit: '20mb' }));
  app.use(express.urlencoded({ extended: true, limit: '20mb' }));

  // Logger de requests para detección de endpoints muertos
  // Guarda en logs/requests.jsonl: timestamp, method, path, statusCode, duration
  if (config.nodeEnv === 'development' || config.nodeEnv === 'production') {
    app.use(requestLoggerMiddleware);
  }

  // Healthcheck global. Reporta PRESENCIA de variables de entorno (nunca el
  // valor) para verificar tras desplegar en Vercel que la config se lee bien.
  app.get('/health', (_req, res) => {
    res.status(200).json({
      ok: true,
      status: 'up',
      uptime: process.uptime(),
      env: {
        NODE_ENV: process.env.NODE_ENV ?? null,
        DATABASE_URL: !!process.env.DATABASE_URL,
        JWT_SECRET: !!process.env.JWT_SECRET,
        ENCRYPTION_KEY: !!process.env.ENCRYPTION_KEY,
        ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
      },
    });
  });

  // Documentacion (Swagger UI)
  try {
    setupSwagger(app, '/docs');
  } catch (err) {
    console.warn('Swagger setup failed (non-critical):', (err as Error).message);
  }

  // Documentación interactiva (OpenAPI spec y módulos)
  app.use('/api', docsRouter);

  // Rutas de la API
  app.use('/', routes);

  // 404 y manejador de errores (siempre al final)
  app.use(notFoundHandler);
  app.use(errorMiddleware);

  return app;
}

export const app = createApp();
export default app;
