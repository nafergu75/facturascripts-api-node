import { app } from './app';
import { config } from './config/env';
import { logger } from './config/logger';
import { connectDatabase } from './config/database';

async function bootstrap(): Promise<void> {
  await connectDatabase();

  app.listen(config.port, () => {
    logger.info(`API escuchando en http://localhost:${config.port} (${config.nodeEnv})`);
    logger.info(`Swagger UI en http://localhost:${config.port}/docs`);
  });
}

bootstrap().catch((err) => {
  logger.error('Fallo al arrancar la aplicacion', err);
  process.exit(1);
});
