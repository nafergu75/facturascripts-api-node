/**
 * Servidor tradicional para Vercel (sin serverless).
 *
 * Este archivo actúa como punto de entrada para Vercel en producción.
 * - En local: npm run dev usa src/index.ts
 * - En Vercel: usa este server.ts (sin puerto fijo, Vercel lo inyecta en PORT env var)
 * - Vercel ejecuta: npm run build && npm start
 * - npm start = node dist/server.js
 */

import { app } from './src/app';
import { config } from './src/config/env';
import { logger } from './src/config/logger';
import { connectDatabase } from './src/config/database';

async function bootstrap(): Promise<void> {
  try {
    // Conectar a DB
    await connectDatabase();

    // Puerto: Vercel inyecta process.env.PORT, fallback a config.port (3000 local)
    const port = process.env.PORT || config.port;

    app.listen(port, () => {
      logger.info(`API escuchando en puerto ${port} (${config.nodeEnv})`);
      if (config.nodeEnv === 'development') {
        logger.info(`Swagger UI en http://localhost:${port}/docs`);
      }
    });
  } catch (err) {
    logger.error('Fallo al arrancar el servidor', err);
    process.exit(1);
  }
}

bootstrap();
