/**
 * Documentación e información de la API
 * Retorna especificaciones OpenAPI y resúmenes de módulos
 */

import { Router, Request, Response } from 'express';

const router = Router();

/**
 * GET /api/docs
 * Retorna especificación completa de la API en formato OpenAPI 3.0
 */
router.get('/docs', (req: Request, res: Response) => {
  const spec = {
    openapi: '3.0.0',
    info: {
      title: 'conta-api',
      description: 'Lector OCR + Gestor de Documentos Contables. Backend-for-Frontend especializado en procesamiento de documentos fiscales.',
      version: '1.0.0',
      contact: {
        name: 'Development Team',
        url: 'https://github.com/...',
      },
    },
    servers: [
      {
        url: 'https://conta-api.vercel.app',
        description: 'Production (Vercel)',
      },
      {
        url: 'http://localhost:3000',
        description: 'Local development',
      },
    ],
    tags: [
      {
        name: 'Auth',
        description: 'Autenticación y autorización',
      },
      {
        name: 'Income Reader',
        description: 'Procesamiento de documentos de ingreso (facturas, tickets, recibos)',
      },
      {
        name: 'Registro Mercantil',
        description: 'Gestión de documentos legales con versionado automático',
      },
      {
        name: 'Health',
        description: 'Estado y monitoreo de la API',
      },
    ],
    paths: {
      '/auth/login': {
        post: {
          summary: 'Iniciar sesión',
          tags: ['Auth'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    email: {
                      type: 'string',
                      format: 'email',
                      example: 'user@example.com',
                    },
                    password: {
                      type: 'string',
                      example: 'password123',
                    },
                  },
                  required: ['email', 'password'],
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Login exitoso',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      token: {
                        type: 'string',
                        description: 'JWT access token',
                      },
                      refreshToken: {
                        type: 'string',
                        description: 'Token para renovar acceso',
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/companies/{companyId}/income-reader': {
        post: {
          summary: 'Subir documento de ingreso para OCR',
          tags: ['Income Reader'],
          parameters: [
            {
              name: 'companyId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'ID de la empresa',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  properties: {
                    file: {
                      type: 'string',
                      format: 'binary',
                      description: 'Archivo PDF o imagen del documento',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Documento subido y procesamiento iniciado',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      status: {
                        type: 'string',
                        enum: ['UPLOADED'],
                        description: 'Estado inicial del documento',
                      },
                      createdAt: { type: 'string', format: 'date-time' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/companies/{companyId}/income-reader/{id}': {
        get: {
          summary: 'Obtener detalles del documento procesado',
          tags: ['Income Reader'],
          parameters: [
            {
              name: 'companyId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'ID del documento',
            },
          ],
          responses: {
            '200': {
              description: 'Detalles del documento',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      status: {
                        type: 'string',
                        enum: ['UPLOADED', 'PROCESSING', 'READY_FOR_VERIFICATION', 'ERROR', 'REJECTED'],
                      },
                      amount: { type: 'number', description: 'Monto extraído por OCR' },
                      supplierName: { type: 'string', description: 'Nombre del proveedor' },
                      errorMensaje: { type: 'string', nullable: true, description: 'Mensaje de error si OCR falló' },
                      expiresAt: { type: 'string', format: 'date-time', nullable: true },
                      esVigente: { type: 'boolean', description: 'Si el documento no ha expirado' },
                      diasParaCaducidad: { type: 'integer', nullable: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/companies/{companyId}/income-reader/{id}/verify': {
        post: {
          summary: 'Verificar documento y crear factura',
          tags: ['Income Reader'],
          parameters: [
            {
              name: 'companyId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'Factura creada exitosamente',
            },
          },
        },
      },
      '/companies/{companyId}/income-reader/{id}/reintent-ocr': {
        post: {
          summary: 'Reintentar procesamiento OCR',
          tags: ['Income Reader'],
          description: 'Solo disponible si el documento está en estado ERROR',
          parameters: [
            {
              name: 'companyId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'OCR reintentado',
            },
            '400': {
              description: 'Documento no en estado ERROR',
            },
          },
        },
      },
      '/companies/{companyId}/legalizations': {
        post: {
          summary: 'Subir nuevo expediente de legalización',
          tags: ['Registro Mercantil'],
          parameters: [
            {
              name: 'companyId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  properties: {
                    file: { type: 'string', format: 'binary' },
                    fiscalYearId: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Expediente subido (nueva versión)',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      version: { type: 'integer' },
                      isLatestVersion: { type: 'boolean' },
                      expiresAt: { type: 'string', format: 'date-time' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/companies/{companyId}/legalizations/{fiscalYearId}': {
        get: {
          summary: 'Obtener expediente vigente',
          tags: ['Registro Mercantil'],
          parameters: [
            {
              name: 'companyId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
            {
              name: 'fiscalYearId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'Expediente vigente',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      version: { type: 'integer' },
                      isLatestVersion: { type: 'boolean' },
                      esVigente: { type: 'boolean' },
                      diasParaCaducidad: { type: 'integer', nullable: true },
                    },
                  },
                },
              },
            },
            '400': {
              description: 'Expediente expirado',
            },
          },
        },
      },
      '/health': {
        get: {
          summary: 'Estado de la API',
          tags: ['Health'],
          responses: {
            '200': {
              description: 'API operacional',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', enum: ['ok'] },
                      timestamp: { type: 'string', format: 'date-time' },
                      version: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
  };

  res.json(spec);
});

/**
 * GET /api/docs/modules
 * Resumen de módulos principales
 */
router.get('/docs/modules', (req: Request, res: Response) => {
  res.json({
    modules: [
      {
        name: 'Income Reader',
        description: 'Procesamiento automático de documentos de ingreso (facturas, tickets, recibos)',
        features: [
          'Lectura automática con Claude Vision OCR',
          'Máquina de estados (UPLOADED → PROCESSING → READY_FOR_VERIFICATION | ERROR)',
          'Reintento manual desde estado ERROR',
          'Control de caducidad de documentos (expiresAt)',
          'Validación de coherencia estado-errorMensaje',
          'Almacenamiento seguro en S3',
        ],
        endpoints: [
          'POST /companies/:companyId/income-reader',
          'GET /companies/:companyId/income-reader/:id',
          'POST /companies/:companyId/income-reader/:id/verify',
          'POST /companies/:companyId/income-reader/:id/reintent-ocr',
        ],
        status: 'Production',
        tests: 'Income Reader OCR States + Expiration (17 tests)',
      },
      {
        name: 'Registro Mercantil',
        description: 'Gestión de documentos legales con versionado automático y caducidad',
        features: [
          'Versionado automático (v1, v2, v3...)',
          'Obsolescencia automática de versiones (isLatestVersion)',
          'Control de caducidad (4 años default, configurable)',
          'Historial auditable de versiones',
          'Dos entidades: LegalizationPackage + AnnualAccounts',
          'Validación de coherencia version+isLatestVersion+expiresAt',
        ],
        endpoints: [
          'POST /companies/:companyId/legalizations',
          'GET /companies/:companyId/legalizations/:fiscalYearId',
          'GET /companies/:companyId/legalizations/:fiscalYearId/history',
        ],
        status: 'Production',
        tests: 'Registro Mercantil Versioning (19 tests)',
      },
      {
        name: 'Authentication',
        description: 'JWT tokens con refresh automático y multi-tenant support',
        features: [
          'Login con email/password',
          'Refresh tokens con rotación',
          'Multi-tenant (companyId scoped)',
          'Dev login para testing',
          'Token expiration validation',
        ],
        endpoints: ['POST /auth/login', 'POST /auth/refresh', 'POST /auth/dev-login'],
        status: 'Production',
      },
      {
        name: 'AEAT',
        description: 'Modelos fiscales españoles (111, 115, 200, 303, 347, 349, 390)',
        features: [
          'Generación de ficheros AEAT validados',
          'Validación de esquemas',
          'Encriptación de datos sensibles',
          'Cumplimiento normativo',
        ],
        endpoints: [
          'POST /aeat/modelo111/generate',
          'POST /aeat/modelo347/generate',
          'POST /aeat/modelo349/generate',
          'POST /aeat/modelo390/generate',
        ],
        status: 'Production',
      },
    ],
  });
});

/**
 * GET /api/docs/states
 * Información sobre máquinas de estado
 */
router.get('/docs/states', (req: Request, res: Response) => {
  res.json({
    states: {
      incomeReader: {
        name: 'Income Reader State Machine',
        description: 'Estados y transiciones válidas para documentos de ingreso',
        states: [
          {
            name: 'UPLOADED',
            description: 'Documento cargado, esperando procesamiento',
            errorMensaje: null,
            transitions: ['PROCESSING'],
          },
          {
            name: 'PROCESSING',
            description: 'OCR en progreso',
            errorMensaje: null,
            transitions: ['READY_FOR_VERIFICATION', 'ERROR'],
          },
          {
            name: 'READY_FOR_VERIFICATION',
            description: 'OCR completado, datos extraídos',
            errorMensaje: null,
            transitions: ['Verified', 'REJECTED'],
          },
          {
            name: 'ERROR',
            description: 'Fallo en OCR',
            errorMensaje: 'string',
            transitions: ['PROCESSING (reintento)'],
          },
          {
            name: 'REJECTED',
            description: 'Rechazado manualmente',
            rejectionReason: 'string',
            transitions: [],
          },
        ],
        rules: [
          'Si status=ERROR → errorMensaje DEBE existir',
          'Si status≠ERROR → errorMensaje NO debe existir',
          'Si expiresAt < ahora → documento no válido (rechazado automáticamente)',
          'Reintento solo permitido desde ERROR',
        ],
      },
      registroMercantil: {
        name: 'Registro Mercantil Versioning',
        description: 'Ciclo de versiones con obsolescencia automática',
        cycle: 'v1 (vigente) → v2 (v1 obsoleta) → v3 (v2 obsoleta)',
        fields: [
          {
            name: 'version',
            type: 'INT',
            description: 'Número secuencial de versión (1, 2, 3...)',
          },
          {
            name: 'isLatestVersion',
            type: 'BOOL',
            description: 'true = versión vigente; false = obsoleta',
          },
          {
            name: 'expiresAt',
            type: 'DATETIME',
            description: 'Fecha de caducidad (NULL = indefinido)',
          },
        ],
        rules: [
          'Solo una versión puede tener isLatestVersion=true por fiscalYear',
          'Nueva subida marca automáticamente isLatestVersion=false en anteriores',
          'Si expiresAt < ahora → inválido (incluso si isLatestVersion=true)',
          'version >= 1 siempre',
        ],
      },
      expiration: {
        name: 'Document Expiration',
        description: 'Reglas de caducidad aplicadas a ambos módulos',
        logic: 'esVigente(doc) = (expiresAt == NULL) OR (expiresAt > NOW())',
        behavior: [
          'Documento sin expiresAt → vigente indefinidamente',
          'Documento con expiresAt futuro → vigente',
          'Documento con expiresAt pasado → NO vigente (rechazado)',
          'Validación ocurre en: procesamiento, verificación, consulta',
        ],
      },
    },
  });
});

/**
 * GET /api/docs/validation
 * Información sobre validaciones y coherencia
 */
router.get('/docs/validation', (req: Request, res: Response) => {
  res.json({
    validations: {
      incomeReaderCoherence: {
        name: 'Income Reader State Coherence',
        rules: [
          {
            rule: 'status=ERROR → errorMensaje EXISTS',
            impact: 'Fuerza que ocurra error claro',
            check: 'validarCoherenciaIncomeReader()',
          },
          {
            rule: 'status≠ERROR → errorMensaje NOT EXISTS',
            impact: 'Previene confusión de estados',
            check: 'validarCoherenciaIncomeReader()',
          },
          {
            rule: 'status=REJECTED → rejectionReason EXISTS',
            impact: 'Traza de auditoría clara',
            check: 'validarCoherenciaIncomeReader()',
          },
          {
            rule: 'expiresAt < NOW() → REJECTED',
            impact: 'Previene uso de documentos vencidos',
            check: '!esVigente(doc)',
          },
        ],
      },
      registroMercantilCoherence: {
        name: 'Registro Mercantil State Coherence',
        rules: [
          {
            rule: 'version >= 1',
            impact: 'Previene versiones inválidas',
            check: 'validarCoherenciaRegistroMercantil()',
          },
          {
            rule: '(companyId, fiscalYearId) → max 1 isLatestVersion=true',
            impact: 'Previene ambigüedad de versión vigente',
            check: 'DB constraint + service logic',
          },
          {
            rule: 'expiresAt < NOW() → INVALID (incluso si isLatestVersion)',
            impact: 'Expiración prevalece sobre state',
            check: '!esVigente(doc)',
          },
        ],
      },
      centralizedHelpers: {
        name: 'Centralized Validation Helpers',
        description: 'Helpers en src/helpers/documento.ts usados por ambos módulos',
        functions: [
          'esVigente(doc) — Valida vigencia unificada',
          'diasParaCaducidad(doc) — Calcula días hasta expiración',
          'validarCoherenciaIncomeReader(doc) — Income Reader validation',
          'validarCoherenciaRegistroMercantil(doc) — Registro Mercantil validation',
          'mensajeDocumentoExpirado(doc) — Error message estándar',
        ],
      },
    },
  });
});

export default router;
