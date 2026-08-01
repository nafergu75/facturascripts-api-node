#!/usr/bin/env ts-node

/**
 * GENERADOR OPENAPI AUTOMÁTICO - Analiza código Express y genera OpenAPI spec
 *
 * Lee:
 * - Todos los routers en src/routes/
 * - Métodos HTTP y rutas
 * - JSDoc comments
 * - Parámetros de ruta
 * - Controllers para obtener más contexto
 *
 * Genera:
 * - src/docs/openapi.json (completo)
 * - Conserva documentación existente
 * - Llena huecos con schemas automáticos
 *
 * Uso: npx ts-node scripts/generate-openapi-from-code.ts
 * O: npm run openapi:generate
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

interface RouteInfo {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  fullPath: string;
  routeFile: string;
  jsDoc?: string;
  parameters: string[];
}

interface OpenAPIPath {
  [method: string]: {
    tags?: string[];
    summary?: string;
    description?: string;
    parameters?: any[];
    requestBody?: any;
    responses: Record<string, any>;
    security?: any[];
  };
}

// ============================================================================
// HELPERS
// ============================================================================

function extractJSDocAbove(content: string, lineNumber: number): string | undefined {
  const lines = content.split('\n');
  let jsDoc = '';
  let i = lineNumber - 2; // Línea anterior a la ruta

  // Buscar hacia arriba hasta encontrar el inicio del JSDoc
  while (i >= 0) {
    const line = lines[i].trim();

    // Si encontramos */ es el final del JSDoc
    if (line.endsWith('*/')) {
      jsDoc = line + '\n' + jsDoc;
      i--;
      // Seguir hacia arriba para capturar todo el JSDoc
      while (i >= 0) {
        const docLine = lines[i];
        jsDoc = docLine + '\n' + jsDoc;
        if (docLine.includes('/**')) {
          break;
        }
        i--;
      }
      return jsDoc;
    }

    // Si encontramos una línea vacía antes del JSDoc, parar
    if (line === '' && jsDoc === '') {
      return undefined;
    }

    // Si es una línea de comentario, agregarla
    if (line.startsWith('*') || line.startsWith('//')) {
      jsDoc = line + '\n' + jsDoc;
    }

    i--;
  }

  return jsDoc || undefined;
}

function parseJSDoc(jsDoc: string): { summary?: string; description?: string; queryParams?: Record<string, string>; responseExample?: string } {
  const result: any = {};
  const lines = jsDoc.split('\n');

  let summary = '';
  let description = '';
  const queryParams: Record<string, string> = {};
  let inQueryParams = false;
  let responseExample = '';
  let inResponse = false;

  for (const line of lines) {
    const trimmed = line.trim().replace(/^\*\s?/, '').replace(/\s?\*$/, '');

    // Primera línea no vacía = summary
    if (summary === '' && trimmed && !trimmed.startsWith('@')) {
      summary = trimmed;
      continue;
    }

    // Detectar secciones
    if (trimmed.startsWith('Query params:') || trimmed.startsWith('Query parameter')) {
      inQueryParams = true;
      inResponse = false;
      continue;
    }

    if (trimmed.startsWith('Response:') || trimmed.startsWith('Returns:')) {
      inResponse = true;
      inQueryParams = false;
      continue;
    }

    // Procesar líneas en cada sección
    if (inQueryParams) {
      if (trimmed.startsWith('-') || trimmed.startsWith('•')) {
        const match = trimmed.match(/-\s+(\w+):\s*(.*)/);
        if (match) {
          queryParams[match[1]] = match[2];
        }
      }
    }

    if (inResponse && trimmed.startsWith('{')) {
      responseExample += trimmed + '\n';
    }

    // Acumular descripción
    if (!summary || (trimmed && !trimmed.startsWith('Query') && !trimmed.startsWith('Response'))) {
      description += trimmed + '\n';
    }
  }

  if (summary) result.summary = summary;
  if (description.trim()) result.description = description.trim();
  if (Object.keys(queryParams).length > 0) result.queryParams = queryParams;
  if (responseExample) result.responseExample = responseExample;

  return result;
}

function extractRouteParameters(routePath: string): string[] {
  const matches = routePath.match(/:([a-zA-Z_]\w*)/g) || [];
  return matches.map(m => m.slice(1)); // Quitar el ':'
}

function normalizeOpenAPIPath(routePath: string): string {
  // Convertir /companies/:companyId a /companies/{companyId}
  return routePath.replace(/:([a-zA-Z_]\w*)/g, '{$1}');
}

function guessModuleTag(filePath: string): string {
  const filename = path.basename(filePath, '.routes.ts');

  const tagMap: Record<string, string> = {
    auth: '🔐 Autenticación',
    income: '📸 Ingresos',
    'income-reader': '📸 Lector de Facturas',
    accounting: '📊 Contabilidad',
    'accounting-engine': '📊 Contabilidad',
    'accounting-closure': '📊 Cierre Contable',
    impuestos: '🏛️ Impuestos',
    impuestoSociedades: '🏛️ Impuestos Sociedades',
    registro: '📋 Registro Mercantil',
    reports: '📈 Reportes',
    tax: '🏛️ Tax',
    chat: '🤖 Carmen',
    companies: '🏢 Empresas',
    users: '👤 Usuarios',
    admin: '🛠️ Admin',
    clientes: '👥 Clientes',
    proveedores: '👥 Proveedores',
    productos: '📦 Productos',
    bancos: '🏦 Bancos',
    extractos: '📊 Extractos',
    plantillas: '📋 Plantillas',
    'plan-contable': '📐 Plan Contable',
    'chart-of-accounts': '📐 Plan Contable'
  };

  for (const [key, tag] of Object.entries(tagMap)) {
    if (filename.includes(key)) return tag;
  }

  return `📌 ${filename}`;
}

// ============================================================================
// MAIN LOGIC
// ============================================================================

async function generateOpenAPI() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('🔄 GENERADOR OPENAPI - Analizando código...');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const routesDir = path.join(process.cwd(), 'src/routes');
  const openAPIPath = path.join(process.cwd(), 'src/docs/openapi.json');

  // Cargar OpenAPI existente si existe
  let existingSpec: any = {
    openapi: '3.0.3',
    info: {
      title: 'FacturaScripts BFF API - conta-api',
      version: '1.0.0',
      description: 'API Node multiempresa: facturación, contabilidad, impuestos, registro mercantil'
    },
    servers: [
      { url: 'http://localhost:3000', description: 'Desarrollo' },
      { url: 'https://api.ifeval.es', description: 'Producción' }
    ],
    paths: {},
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT'
        }
      }
    }
  };

  if (fs.existsSync(openAPIPath)) {
    try {
      existingSpec = JSON.parse(fs.readFileSync(openAPIPath, 'utf-8'));
      console.log('✅ OpenAPI existente cargado\n');
    } catch (e) {
      console.log('⚠️  OpenAPI existente corrupto, se recreará\n');
    }
  }

  // Leer todos los archivos de rutas
  const routeFiles = fs.readdirSync(routesDir).filter(f => f.endsWith('.routes.ts'));
  console.log(`📁 Encontrados ${routeFiles.length} archivos de rutas\n`);

  let totalEndpointsFound = 0;
  let totalEndpointsDocumented = 0;

  // Procesar cada archivo de rutas
  for (const routeFile of routeFiles) {
    const filePath = path.join(routesDir, routeFile);
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    console.log(`📄 Procesando: ${routeFile}`);

    // Regex para detectar rutas (soporta router.post, accountingEngineRoutes.post, etc)
    const routePattern = /(?:router|[a-zA-Z_][a-zA-Z0-9_]*Routes?)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;

    let match;
    const foundRoutes: RouteInfo[] = [];

    while ((match = routePattern.exec(content)) !== null) {
      const method = match[1] as any;
      const routePath = match[2];

      totalEndpointsFound++;

      foundRoutes.push({
        method,
        path: routePath,
        fullPath: normalizeOpenAPIPath(routePath),
        routeFile,
        parameters: extractRouteParameters(routePath)
      });
    }

    // Determinar basePath del router (leyendo src/routes/index.ts)
    const indexContent = fs.readFileSync(path.join(routesDir, 'index.ts'), 'utf-8');
    const basePathMatch = indexContent.match(new RegExp(`router\\.use\\(['\`"]([^'"\`]+)['\`"],\\s*${routeFile.replace('.routes.ts', '').replace(/-/g, '(?:[-_])?')}`));
    const basePath = basePathMatch ? basePathMatch[1] : '';

    console.log(`   ✅ ${foundRoutes.length} rutas encontradas${basePath ? ` (basePath: ${basePath})` : ''}`);

    // Procesar cada ruta encontrada
    for (const route of foundRoutes) {
      const fullPath = basePath ? `${basePath}${route.fullPath}` : route.fullPath;

      // Buscar documentación existente
      let existingEndpoint = existingSpec.paths[fullPath]?.[route.method];

      // Si no existe en OpenAPI existente, crear nuevo
      if (!existingEndpoint) {
        totalEndpointsDocumented++;

        const tag = guessModuleTag(routeFile);
        const newEndpoint: any = {
          tags: [tag],
          summary: `[AUTO] ${route.method.toUpperCase()} ${fullPath}`,
          responses: {
            '200': {
              description: 'Success',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      data: { type: 'object' }
                    }
                  }
                }
              }
            }
          }
        };

        // Agregar parámetros de ruta
        if (route.parameters.length > 0) {
          newEndpoint.parameters = route.parameters.map(param => ({
            name: param,
            in: 'path',
            required: true,
            schema: { type: 'string' }
          }));
        }

        // Agregar autenticación (todos excepto /auth y /plan-contable/base)
        if (!fullPath.startsWith('/auth') && !fullPath.startsWith('/plan-contable/base') && !fullPath.startsWith('/health')) {
          newEndpoint.security = [{ bearerAuth: [] }];
        }

        // Inicializar path si no existe
        if (!existingSpec.paths[fullPath]) {
          existingSpec.paths[fullPath] = {};
        }

        existingSpec.paths[fullPath][route.method] = newEndpoint;
      }
    }

    console.log('');
  }

  // ============================================================================
  // GUARDAR Y REPORTAR
  // ============================================================================

  fs.writeFileSync(openAPIPath, JSON.stringify(existingSpec, null, 2));

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('✅ GENERACIÓN COMPLETADA\n');

  console.log(`📊 ESTADÍSTICAS:`);
  console.log(`   Total endpoints encontrados en código: ${totalEndpointsFound}`);
  console.log(`   Nuevos endpoints documentados:        ${totalEndpointsDocumented}`);
  console.log(`   Total en OpenAPI:                     ${Object.keys(existingSpec.paths).reduce((acc, p) => acc + Object.keys(existingSpec.paths[p]).length, 0)}`);

  console.log(`\n📁 Archivo actualizado: ${openAPIPath}`);
  console.log('\n🔍 Próximas acciones:');
  console.log('   1. Revisar src/docs/openapi.json');
  console.log('   2. Completar summaries y descriptions para módulos críticos');
  console.log('   3. Validar: npx openapi-validator src/docs/openapi.json');
  console.log('   4. Generar cliente TS: npx openapi-generator-cli generate -i src/docs/openapi.json -g typescript-axios -o generated/api-client');

  console.log('\n═══════════════════════════════════════════════════════════════\n');
}

generateOpenAPI().catch(console.error);
