import { Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import swaggerDocument from './openapi.json';

/** Monta Swagger UI en la ruta indicada (por defecto /docs). */
export function setupSwagger(app: Express, path = '/docs'): void {
  app.use(path, swaggerUi.serve, swaggerUi.setup(swaggerDocument));
}
