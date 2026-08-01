/**
 * Swagger Configuration
 * Documentación OpenAPI para la API de Conta
 */

export const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Conta API - FacturaScripts BFF',
      version: '1.0.0',
      description: 'Backend for Frontend (BFF) sobre FacturaScripts - Módulos: Proveedores, Contabilidad, Clientes',
    },
    servers: [
      { url: 'http://localhost:3000', description: 'Development' },
      { url: 'https://api.conta-production.com', description: 'Production' },
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'JWT Bearer Token'
        }
      }
    },
    security: [{ BearerAuth: [] }],
  },
  apis: ['./src/routes/**/*.ts', './src/docs/supplier-endpoints.ts'],
};

export default swaggerOptions;
