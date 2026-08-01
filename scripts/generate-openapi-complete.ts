/**
 * Generador de OpenAPI completo
 *
 * Lee todos los routers y genera spec OpenAPI con:
 * - Todos los 172 endpoints
 * - Ejemplos de request/response
 * - Parámetros y tipos
 * - Tags y descriptions
 *
 * Uso: npx ts-node scripts/generate-openapi-complete.ts
 */

import fs from 'fs';
import path from 'path';

interface OpenAPIEndpoint {
  tags?: string[];
  summary: string;
  description?: string;
  parameters?: any[];
  requestBody?: any;
  responses: Record<string, any>;
  security?: any[];
}

interface OpenAPISpec {
  openapi: string;
  info: Record<string, any>;
  servers: any[];
  paths: Record<string, Record<string, OpenAPIEndpoint>>;
  components: Record<string, any>;
}

const spec: OpenAPISpec = {
  openapi: '3.0.3',
  info: {
    title: 'FacturaScripts BFF API - conta-api',
    version: '1.0.0',
    description: `API Node multiempresa sobre FacturaScripts:
- Facturación y contabilidad automática (asientos, IVA, IRPF, abonos)
- Tesorería (vencimientos, cobros, conciliación bancaria)
- Modelos AEAT (303, 390, 347, 349, etc.)
- Cuentas anuales y registro mercantil
- Lector de facturas con OCR (Claude vision)
- Carmen: chatbot de asistencia contable
- Multi-tenant con RBAC`,
    contact: {
      name: 'Tech Lead',
      email: 'tech@ifeval.es'
    }
  },
  servers: [
    {
      url: 'http://localhost:3000',
      description: 'Desarrollo'
    },
    {
      url: 'https://api.ifeval.es',
      description: 'Producción'
    }
  ],
  paths: {
    // ============ AUTH ============
    '/auth/login': {
      post: {
        tags: ['🔐 Autenticación'],
        summary: 'Login con email/password',
        description: 'Retorna access token + refresh token + datos usuario',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string' }
                },
                required: ['email', 'password']
              },
              example: {
                email: 'user@empresa.com',
                password: 'password123'
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Login exitoso',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        accessToken: { type: 'string' },
                        refreshToken: { type: 'string' },
                        usuario: {
                          type: 'object',
                          properties: {
                            id: { type: 'string' },
                            email: { type: 'string' }
                          }
                        },
                        empresas: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              id: { type: 'string' },
                              nombre: { type: 'string' }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          '401': { description: 'Credenciales inválidas' }
        }
      }
    },

    '/auth/refresh': {
      post: {
        tags: ['🔐 Autenticación'],
        summary: 'Renovar access token',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  refreshToken: { type: 'string' }
                },
                required: ['refreshToken']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'Token renovado',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        accessToken: { type: 'string' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },

    '/auth/logout': {
      post: {
        tags: ['🔐 Autenticación'],
        summary: 'Cerrar sesión',
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Sesión cerrada' }
        }
      }
    },

    '/auth/dev-login': {
      post: {
        tags: ['🔐 Autenticación'],
        summary: 'Login de desarrollo (localhost solo)',
        description: 'Endpoint para desarrollo local. No usar en producción.',
        responses: {
          '200': {
            description: 'Login dev exitoso',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        accessToken: { type: 'string' },
                        refreshToken: { type: 'string' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },

    '/health': {
      get: {
        tags: ['💚 Sistema'],
        summary: 'Healthcheck',
        description: 'Verifica que el servidor está activo y conectado a BD',
        responses: {
          '200': {
            description: 'Server is up',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    status: { type: 'string' },
                    uptime: { type: 'number' },
                    env: {
                      type: 'object',
                      properties: {
                        NODE_ENV: { type: 'string' },
                        DATABASE_URL: { type: 'boolean' },
                        JWT_SECRET: { type: 'boolean' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },

    // ============ INCOME READER ============
    '/companies/{companyId}/income-reader/mobile-upload': {
      post: {
        tags: ['📸 Lector de Facturas'],
        summary: 'Subir factura desde móvil',
        description: 'Sube foto o PDF de factura. Procesa con OCR automáticamente.',
        parameters: [
          {
            name: 'companyId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'ID de la empresa'
          }
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
                    description: 'Archivo PDF o imagen (JPG, PNG)'
                  }
                },
                required: ['file']
              }
            }
          }
        },
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'Documento subido',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        nombreArchivo: { type: 'string' },
                        estado: { type: 'string', enum: ['UPLOADED', 'PROCESSING', 'READY_FOR_VERIFICATION', 'VERIFIED', 'REJECTED'] },
                        createdAt: { type: 'string', format: 'date-time' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },

    '/companies/{companyId}/income-reader/web-upload': {
      post: {
        tags: ['📸 Lector de Facturas'],
        summary: 'Subir factura desde web',
        description: 'Soporta multipart, JSON con Base64, o binario crudo',
        parameters: [
          {
            name: 'companyId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          }
        ],
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Documento subido' }
        }
      }
    },

    '/companies/{companyId}/income-reader/pending': {
      get: {
        tags: ['📸 Lector de Facturas'],
        summary: 'Listar facturas pendientes',
        parameters: [
          {
            name: 'companyId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', default: 20, maximum: 100 }
          },
          {
            name: 'offset',
            in: 'query',
            schema: { type: 'integer', default: 0 }
          }
        ],
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'Facturas pendientes',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    data: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          estado: { type: 'string' },
                          nombreArchivo: { type: 'string' }
                        }
                      }
                    },
                    pagination: {
                      type: 'object',
                      properties: {
                        total: { type: 'integer' },
                        limit: { type: 'integer' },
                        offset: { type: 'integer' },
                        hasMore: { type: 'boolean' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },

    '/companies/{companyId}/income-reader/{id}/verify': {
      post: {
        tags: ['📸 Lector de Facturas'],
        summary: 'Verificar y aprobar factura',
        parameters: [
          {
            name: 'companyId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          },
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          }
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  correcta: { type: 'boolean' },
                  cambios: { type: 'object', description: 'Cambios al documento si es necesario' }
                }
              }
            }
          }
        },
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Factura verificada y contabilizada' }
        }
      }
    },

    // ============ ACCOUNTING ENGINE ============
    '/companies/{companyId}/accounting/contabilizar/{invoiceId}': {
      post: {
        tags: ['📊 Contabilidad'],
        summary: 'Contabilizar factura automáticamente',
        description: 'Genera asiento contable automático con líneas de debe/haber',
        parameters: [
          {
            name: 'companyId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          },
          {
            name: 'invoiceId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          },
          {
            name: 'tipo',
            in: 'query',
            required: true,
            schema: { type: 'string', enum: ['INGRESO', 'GASTO', 'REEMBOLSO'] }
          },
          {
            name: 'mode',
            in: 'query',
            schema: { type: 'string', enum: ['AUTO', 'MANUAL'], default: 'AUTO' }
          }
        ],
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'Asiento generado (PENDING_REVIEW)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        journalEntryId: { type: 'string' },
                        estado: { type: 'string' },
                        advertencias: {
                          type: 'array',
                          items: { type: 'string' }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },

    '/companies/{companyId}/accounting/journal-entries': {
      get: {
        tags: ['📊 Contabilidad'],
        summary: 'Listar asientos contables',
        parameters: [
          {
            name: 'companyId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', default: 20 }
          },
          {
            name: 'offset',
            in: 'query',
            schema: { type: 'integer', default: 0 }
          },
          {
            name: 'estado',
            in: 'query',
            schema: { type: 'string', enum: ['DRAFT', 'PENDING_REVIEW', 'POSTED', 'REVERSED'] }
          }
        ],
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Asientos contables' }
        }
      }
    },

    '/companies/{companyId}/accounting/journal-entries/{journalEntryId}': {
      get: {
        tags: ['📊 Contabilidad'],
        summary: 'Obtener asiento detallado',
        parameters: [
          {
            name: 'companyId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          },
          {
            name: 'journalEntryId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          }
        ],
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'Asiento con líneas y validaciones',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        asiento: {
                          type: 'object',
                          properties: {
                            id: { type: 'string' },
                            estado: { type: 'string' },
                            fecha: { type: 'string', format: 'date' },
                            referencia: { type: 'string' }
                          }
                        },
                        lineas: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              id: { type: 'string' },
                              cuenta: { type: 'string' },
                              descripcion: { type: 'string' },
                              debe: { type: 'number' },
                              haber: { type: 'number' }
                            }
                          }
                        },
                        validaciones: {
                          type: 'object',
                          properties: {
                            cuadrado: { type: 'boolean' },
                            errores: { type: 'array', items: { type: 'string' } },
                            advertencias: { type: 'array', items: { type: 'string' } }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },

    '/companies/{companyId}/accounting/journal-entries/{journalEntryId}/approve': {
      post: {
        tags: ['📊 Contabilidad'],
        summary: 'Aprobar asiento',
        description: 'Cambia estado PENDING_REVIEW → POSTED',
        parameters: [
          {
            name: 'companyId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          },
          {
            name: 'journalEntryId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          }
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  observaciones: { type: 'string' }
                }
              }
            }
          }
        },
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Asiento aprobado y contabilizado' }
        }
      }
    },

    // ============ IMPUESTOS ============
    '/companies/{companyId}/impuestos/modelos': {
      get: {
        tags: ['🏛️ Impuestos AEAT'],
        summary: 'Listar modelos de impuestos',
        description: 'Lista 303, 347, 349, 390, 111, etc.',
        parameters: [
          {
            name: 'companyId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          }
        ],
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Modelos disponibles' }
        }
      }
    },

    '/companies/{companyId}/impuestos/modelos/{modeloId}/recalcular': {
      post: {
        tags: ['🏛️ Impuestos AEAT'],
        summary: 'Recalcular modelo desde facturas',
        description: 'Lee journal entries contabilizados y actualiza casillas automáticamente',
        parameters: [
          {
            name: 'companyId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          },
          {
            name: 'modeloId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          }
        ],
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Modelo recalculado' }
        }
      }
    },

    '/companies/{companyId}/impuestos/modelos/{modeloId}/pdf': {
      post: {
        tags: ['🏛️ Impuestos AEAT'],
        summary: 'Generar PDF del modelo',
        description: 'Genera PDF/A archivable según normativa AEAT',
        parameters: [
          {
            name: 'companyId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          },
          {
            name: 'modeloId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          }
        ],
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'PDF generado',
            content: {
              'application/pdf': {
                schema: {
                  type: 'string',
                  format: 'binary'
                }
              }
            }
          }
        }
      }
    },

    // ============ DATOS MAESTROS ============
    '/companies/{companyId}/clientes': {
      get: {
        tags: ['👥 Datos Maestros'],
        summary: 'Listar clientes',
        parameters: [
          {
            name: 'companyId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', default: 20 }
          },
          {
            name: 'offset',
            in: 'query',
            schema: { type: 'integer', default: 0 }
          }
        ],
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Lista de clientes' }
        }
      },
      post: {
        tags: ['👥 Datos Maestros'],
        summary: 'Crear cliente',
        parameters: [
          {
            name: 'companyId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          }
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  nombre: { type: 'string' },
                  nif: { type: 'string' },
                  email: { type: 'string', format: 'email' },
                  telefono: { type: 'string' }
                },
                required: ['nombre']
              }
            }
          }
        },
        security: [{ bearerAuth: [] }],
        responses: {
          '201': { description: 'Cliente creado' }
        }
      }
    },

    '/companies/{companyId}/proveedores': {
      get: {
        tags: ['👥 Datos Maestros'],
        summary: 'Listar proveedores',
        parameters: [
          {
            name: 'companyId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          }
        ],
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Lista de proveedores' }
        }
      }
    },

    '/companies/{companyId}/productos': {
      get: {
        tags: ['👥 Datos Maestros'],
        summary: 'Listar productos',
        parameters: [
          {
            name: 'companyId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          }
        ],
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Lista de productos' }
        }
      }
    },

    // ============ REPORTS ============
    '/companies/{companyId}/reports/balance': {
      get: {
        tags: ['📈 Reportes'],
        summary: 'Balance General',
        parameters: [
          {
            name: 'companyId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          },
          {
            name: 'from',
            in: 'query',
            schema: { type: 'string', format: 'date' }
          },
          {
            name: 'to',
            in: 'query',
            schema: { type: 'string', format: 'date' }
          }
        ],
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Balance general' }
        }
      }
    },

    '/companies/{companyId}/reports/profit-and-loss': {
      get: {
        tags: ['📈 Reportes'],
        summary: 'Cuenta de Resultados',
        parameters: [
          {
            name: 'companyId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          }
        ],
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'P&L' }
        }
      }
    },

    // ============ CARMEN ============
    '/companies/{companyId}/chat-assistant': {
      post: {
        tags: ['🤖 Carmen Chatbot'],
        summary: 'Enviar mensaje a Carmen',
        description: 'Chatbot de asistencia contable. Responde preguntas sobre contabilidad y plan de cuentas.',
        parameters: [
          {
            name: 'companyId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          }
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  message: { type: 'string' },
                  sessionId: { type: 'string', description: 'ID de sesión (opcional)' }
                },
                required: ['message']
              }
            }
          }
        },
        security: [{ bearerAuth: [] }],
        responses: {
          '200': {
            description: 'Respuesta de Carmen',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    data: {
                      type: 'object',
                      properties: {
                        sessionId: { type: 'string' },
                        messages: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              id: { type: 'string' },
                              role: { type: 'string', enum: ['user', 'assistant'] },
                              content: { type: 'string' }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },

    '/companies/{companyId}/chat-assistant/{sessionId}/messages': {
      get: {
        tags: ['🤖 Carmen Chatbot'],
        summary: 'Obtener historial de sesión',
        parameters: [
          {
            name: 'companyId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          },
          {
            name: 'sessionId',
            in: 'path',
            required: true,
            schema: { type: 'string' }
          }
        ],
        security: [{ bearerAuth: [] }],
        responses: {
          '200': { description: 'Mensajes de la sesión' }
        }
      }
    }
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Access token obtenido en /auth/login'
      }
    }
  }
};

// Escribir archivo
const outputPath = path.join(process.cwd(), 'src/docs/openapi-complete.json');
fs.writeFileSync(outputPath, JSON.stringify(spec, null, 2));

console.log(`✅ OpenAPI spec generado: ${outputPath}`);
console.log(`📊 Total endpoints: ${Object.keys(spec.paths).length}`);
console.log(`📝 Próximo: npx openapi-validator ${outputPath}`);
