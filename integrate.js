const fs = require('fs');
const path = require('path');

const OPENAPI_PATH = path.join(__dirname, 'src', 'docs', 'openapi.json');

const CRITICAL_ENDPOINTS = {
  "/auth/login": {
    "post": {
      "tags": ["🔐 Autenticación"],
      "summary": "Autenticar usuario y obtener tokens JWT",
      "description": "Valida credenciales del usuario y retorna:\n\n- **Access Token**: JWT para usar en requests posteriores (corta duración)\n- **Refresh Token**: Para renovar access token cuando expire (7 días)\n- **Lista de empresas**: Empresas a las que el usuario tiene acceso\n- **Empresa seleccionada** (opcional): Si se especifica empresaCodigo\n\n### Flujo de dos pasos:\n\n1. **Sin empresaCodigo**: Devuelve lista de empresas. El frontend debe mostrar selector y hacer login nuevamente con empresaCodigo elegido.\n\n2. **Con empresaCodigo**: Valida acceso a esa empresa y devuelve empresa seleccionada.\n\n### Uso de tokens:\n\nEn requests posteriores, incluye el access token en el header:\n```\nAuthorization: Bearer eyJhbGc...\n```\n\nCuando el token expire (~15 min), usa refresh token para obtener uno nuevo:\n```\nPOST /auth/refresh\n{ \"refreshToken\": \"eyJhbGc...\" }\n```",
      "requestBody": {
        "required": true,
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "properties": {
                "email": {
                  "type": "string",
                  "format": "email",
                  "description": "Email del usuario"
                },
                "password": {
                  "type": "string",
                  "description": "Contraseña del usuario"
                },
                "empresaCodigo": {
                  "type": "string",
                  "description": "Código de empresa (opcional). Si se envía, valida acceso y retorna esa empresa como seleccionada.",
                  "example": "DEMO"
                }
              },
              "required": ["email", "password"]
            },
            "example": {
              "email": "contador@empresa.com",
              "password": "password123",
              "empresaCodigo": "DEMO"
            }
          }
        }
      },
      "responses": {
        "200": {
          "description": "Autenticación exitosa",
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "ok": {"type": "boolean"},
                  "data": {
                    "type": "object",
                    "properties": {
                      "token": {"type": "string"},
                      "refreshToken": {"type": "string"},
                      "user": {"type": "object"},
                      "empresas": {"type": "array"},
                      "empresaSeleccionada": {"type": ["string", "null"]}
                    }
                  }
                }
              }
            }
          }
        },
        "401": {
          "description": "Autenticación fallida"
        }
      }
    }
  },
  "/auth/refresh": {
    "post": {
      "tags": ["🔐 Autenticación"],
      "summary": "Renovar access token usando refresh token",
      "description": "Cuando el access token está próximo a expirar (~15 min), usa el refresh token para obtener uno nuevo.\n\n**Validez:**\n- Access Token: ~15 minutos\n- Refresh Token: 7 días\n\n**Seguridad:**\n- Si el refresh token se reutiliza dos veces (token robado + uso original), la segunda llamada FALLA\n- Los roles/empresas se recargan desde BD, por lo que revocaciones surten efecto inmediato",
      "requestBody": {
        "required": true,
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "properties": {
                "refreshToken": {
                  "type": "string",
                  "description": "Refresh token obtenido en /auth/login"
                }
              },
              "required": ["refreshToken"]
            },
            "example": {
              "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
            }
          }
        }
      },
      "responses": {
        "200": {
          "description": "Token renovado exitosamente"
        },
        "401": {
          "description": "Refresh token inválido, expirado o revocado"
        }
      }
    }
  },
  "/companies/{companyId}/income-reader/mobile-upload": {
    "post": {
      "tags": ["📸 Lector de Facturas"],
      "summary": "Subir factura desde móvil (foto)",
      "description": "Sube un archivo de factura (foto, PDF) desde una app móvil.\n\nSoporta 3 formas de envío:\n\n1. **Multipart (recomendado)**: Envía archivo como form-data\n2. **Binario crudo**: Envía binary data con header X-Filename\n3. **JSON + Base64**: Envía { nombreArchivo, mimeType, contenidoBase64 }\n\n**Proceso:**\n- Upload → Archivo guardado, estado UPLOADED\n- Backend procesa OCR en background con Claude Vision\n- Cliente hace polling: GET `/companies/{companyId}/income-reader/{id}`\n- Cuando estado = READY_FOR_VERIFICATION → Usuario revisa datos extraídos\n- Usuario verifica: POST `/companies/{companyId}/income-reader/{id}/verify`",
      "parameters": [
        {
          "name": "companyId",
          "in": "path",
          "required": true,
          "schema": {"type": "string"},
          "description": "ID de la empresa"
        }
      ],
      "requestBody": {
        "required": true,
        "content": {
          "multipart/form-data": {
            "schema": {
              "type": "object",
              "properties": {
                "file": {
                  "type": "string",
                  "format": "binary",
                  "description": "Archivo de factura (PDF, JPG, PNG). Máx 15MB"
                }
              },
              "required": ["file"]
            }
          }
        }
      },
      "security": [{"bearerAuth": []}],
      "responses": {
        "201": {"description": "Documento subido"},
        "400": {"description": "Error en archivo"},
        "401": {"description": "No autenticado"}
      }
    }
  },
  "/companies/{companyId}/accounting/contabilizar/{invoiceId}": {
    "post": {
      "tags": ["📊 Contabilidad"],
      "summary": "Contabilizar factura automáticamente",
      "description": "Crea un asiento contable a partir de una factura de cliente (INGRESO) o proveedor (GASTO).\n\n**Parámetros:**\n- `tipo` (OBLIGATORIO): INGRESO | GASTO\n- `mode` (opcional, default AUTO): AUTO | MANUAL\n\n**Flujo:**\n1. POST contabilizar → Crea asiento en PENDING_REVIEW (o DRAFT si mode=MANUAL)\n2. Usuario revisa: GET `/companies/{companyId}/accounting/journal-entries/{journalEntryId}`\n3. Si correcto: POST `.../approve` → POSTED",
      "parameters": [
        {
          "name": "companyId",
          "in": "path",
          "required": true,
          "schema": {"type": "string"}
        },
        {
          "name": "invoiceId",
          "in": "path",
          "required": true,
          "schema": {"type": "string"}
        },
        {
          "name": "tipo",
          "in": "query",
          "required": true,
          "schema": {"type": "string", "enum": ["INGRESO", "GASTO"]}
        },
        {
          "name": "mode",
          "in": "query",
          "required": false,
          "schema": {"type": "string", "enum": ["AUTO", "MANUAL"], "default": "AUTO"}
        }
      ],
      "security": [{"bearerAuth": []}],
      "responses": {
        "200": {"description": "Asiento creado"},
        "400": {"description": "Parámetros inválidos"},
        "401": {"description": "No autenticado"}
      }
    }
  },
  "/companies/{companyId}/impuestos/modelos/{modeloId}/pdf": {
    "get": {
      "tags": ["🏛️ Impuestos AEAT"],
      "summary": "Descargar PDF del modelo de impuestos",
      "description": "Descarga PDF del modelo de impuestos (Modelo 303, 347, etc.) en formato PDF/A.\n\n**Formato de modeloId:**\n`modelo-{tipo}-{año}-{período}`\n\n**Ejemplos:**\n- `modelo-303-2026-q1` → Modelo 303 Q1 2026\n- `modelo-347-2026-0a` → Modelo 347 anual 2026",
      "parameters": [
        {
          "name": "companyId",
          "in": "path",
          "required": true,
          "schema": {"type": "string"}
        },
        {
          "name": "modeloId",
          "in": "path",
          "required": true,
          "schema": {"type": "string"},
          "example": "modelo-303-2026-q1"
        }
      ],
      "security": [{"bearerAuth": []}],
      "responses": {
        "200": {
          "description": "PDF del modelo",
          "content": {"application/pdf": {"schema": {"type": "string", "format": "binary"}}}
        },
        "404": {"description": "Modelo no encontrado"},
        "401": {"description": "No autenticado"}
      }
    }
  }
};

try {
  console.log('📖 Leyendo openapi.json...');
  const spec = JSON.parse(fs.readFileSync(OPENAPI_PATH, 'utf-8'));
  const pathsCount = Object.keys(spec.paths).length;
  console.log(`✅ Cargado. Paths actuales: ${pathsCount}`);

  console.log('\n🔄 Integrando 5 endpoints críticos...');
  for (const [route, endpoint] of Object.entries(CRITICAL_ENDPOINTS)) {
    if (spec.paths[route]) {
      console.log(`  ♻️  REEMPLAZANDO: ${route}`);
    } else {
      console.log(`  ✨ CREANDO: ${route}`);
    }
    spec.paths[route] = endpoint;
  }

  console.log('\n🔍 Validando JSON...');
  JSON.stringify(spec);
  console.log('✅ JSON válido');

  console.log(`\n💾 Guardando en src/docs/openapi.json...`);
  fs.writeFileSync(OPENAPI_PATH, JSON.stringify(spec, null, 2) + '\n');
  console.log('✅ Guardado');

  console.log('\n' + '='.repeat(60));
  console.log('📋 RESUMEN DE CAMBIOS');
  console.log('='.repeat(60));
  console.log('  ♻️  POST /auth/login');
  console.log('  ♻️  POST /auth/refresh');
  console.log('  ✨ POST /companies/{companyId}/income-reader/mobile-upload');
  console.log('  ✨ POST /companies/{companyId}/accounting/contabilizar/{invoiceId}');
  console.log('  ♻️  GET /companies/{companyId}/impuestos/modelos/{modeloId}/pdf');

  console.log(`\n✅ OpenAPI integrada. Total paths: ${Object.keys(spec.paths).length}`);
  console.log('\n📝 Próximos pasos:');
  console.log('   npm run openapi:validate');
  console.log('   npx openapi-generator-cli generate -i src/docs/openapi.json -g typescript-axios -o generated/api-client');

  process.exit(0);
} catch (err) {
  console.error('❌ ERROR:', err.message);
  process.exit(1);
}
