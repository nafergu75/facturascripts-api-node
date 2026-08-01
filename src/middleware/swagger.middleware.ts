/**
 * Middleware para servir Swagger UI
 * Documentación interactiva en /api-docs
 */

import express from 'express';
import swaggerUi from 'swagger-ui-express';

const router = express.Router();

// Definición OpenAPI simplificada para proveedores
const swaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'Conta API - Módulo de Proveedores',
    version: '1.0.0',
    description: 'API para gestión de proveedores, contactos, cuentas bancarias e historial de cambios',
  },
  servers: [
    { url: 'http://localhost:3000', description: 'Local Development' },
  ],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
  },
  security: [{ BearerAuth: [] }],
  paths: {
    '/api/companies/{companyId}/suppliers/{supplierId}': {
      get: {
        summary: 'Get supplier details',
        tags: ['Suppliers'],
        parameters: [
          { name: 'companyId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'supplierId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Supplier details' },
          '404': { description: 'Supplier not found' },
        },
      },
    },
    '/api/companies/{companyId}/suppliers/{supplierId}/contacts': {
      get: {
        summary: 'List contacts',
        tags: ['Contacts'],
        parameters: [
          { name: 'companyId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'supplierId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'List of contacts' } },
      },
      post: {
        summary: 'Create contact',
        tags: ['Contacts'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  nombre: { type: 'string', example: 'Juan' },
                  email: { type: 'string', format: 'email', example: 'juan@example.com' },
                  rol: { type: 'string', example: 'Gerente' },
                  esPrincipal: { type: 'boolean', example: false },
                },
                required: ['nombre'],
              },
            },
          },
        },
        responses: { '201': { description: 'Contact created' } },
      },
    },
    '/api/companies/{companyId}/suppliers/{supplierId}/bank-accounts': {
      get: {
        summary: 'List bank accounts',
        tags: ['Bank Accounts'],
        responses: { '200': { description: 'List of accounts' } },
      },
      post: {
        summary: 'Create bank account (IBAN validated with mod-97)',
        tags: ['Bank Accounts'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  iban: { type: 'string', example: 'ES9121123456789012345678990', description: 'IBAN with valid checksum' },
                  alias: { type: 'string', example: 'Cuenta principal' },
                  formaPagoPorDefecto: { type: 'string', example: 'transferencia' },
                  esPrincipal: { type: 'boolean', example: true },
                },
                required: ['iban', 'alias'],
              },
            },
          },
        },
        responses: {
          '201': { description: 'Account created' },
          '400': { description: 'Invalid IBAN or validation error' },
        },
      },
    },
    '/api/companies/{companyId}/suppliers/{supplierId}/invoices': {
      get: {
        summary: 'List invoices',
        tags: ['Invoices'],
        parameters: [
          { name: 'estado', in: 'query', schema: { type: 'string', enum: ['DRAFT', 'CONFIRMED', 'PAID'] } },
        ],
        responses: { '200': { description: 'List of invoices' } },
      },
    },
    '/api/companies/{companyId}/suppliers/{supplierId}/export': {
      get: {
        summary: 'Export supplier data',
        tags: ['Export'],
        parameters: [
          { name: 'formato', in: 'query', required: true, schema: { type: 'string', enum: ['csv', 'json'] } },
          { name: 'fechaDesde', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'fechaHasta', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'incluirFacturas', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: {
          '200': { description: 'Exported data (CSV or JSON)' },
        },
      },
    },
    '/api/companies/{companyId}/suppliers/{supplierId}/audit-trail': {
      get: {
        summary: 'Get audit trail (all changes)',
        tags: ['Audit'],
        parameters: [
          { name: 'tipoAccion', in: 'query', schema: { type: 'string', enum: ['create', 'update', 'delete'] } },
        ],
        responses: {
          '200': { description: 'List of audit entries with user, action, date' },
        },
      },
    },
  },
};

/**
 * Setup Swagger UI
 * GET /api-docs → Swagger UI
 * GET /api-docs/swagger.json → OpenAPI definition
 */
export function setupSwagger(app: express.Application): void {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDefinition, {
    swaggerOptions: {
      url: '/api-docs/swagger.json',
    },
    customCss: '.topbar { display: none }',
    customSiteTitle: 'Conta API - Swagger UI',
  }));

  app.get('/api-docs/swagger.json', (req, res) => {
    res.json(swaggerDefinition);
  });
}
