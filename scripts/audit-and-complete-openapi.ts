/**
 * Script de Auditoría: Identifica endpoints faltantes en OpenAPI
 *
 * Compara:
 * - endpoints.json (172 endpoints definidos)
 * - openapi.json (actual - parcialmente documentado)
 * - openapi-complete.json (nueva versión más completa)
 *
 * Muestra qué endpoints están documentados y cuáles faltan.
 *
 * Uso: npx ts-node scripts/audit-and-complete-openapi.ts
 */

import fs from 'fs';
import path from 'path';

interface Endpoint {
  method: string;
  path: string;
  file: string;
  auth?: boolean;
  scope?: string;
}

interface OpenAPIPath {
  get?: any;
  post?: any;
  put?: any;
  patch?: any;
  delete?: any;
}

// Leer endpoints.json
const endpointsPath = path.join(process.cwd(), 'endpoints.json');
const endpointsData = JSON.parse(fs.readFileSync(endpointsPath, 'utf-8'));
const allEndpoints: Endpoint[] = endpointsData.endpoints || [];

// Leer openapi.json actual
const oldOpenAPIPath = path.join(process.cwd(), 'src/docs/openapi.json');
const oldOpenAPI = JSON.parse(fs.readFileSync(oldOpenAPIPath, 'utf-8'));

// Leer openapi-complete.json generado
const newOpenAPIPath = path.join(process.cwd(), 'src/docs/openapi-complete.json');
const newOpenAPI = JSON.parse(fs.readFileSync(newOpenAPIPath, 'utf-8'));

// Funciones helper
function normalizeOpenAPIPath(path: string): string {
  // Convertir /companies/:companyId a /companies/{companyId}
  return path.replace(/:([a-zA-Z_]+)/g, '{$1}');
}

function getDocumentedEndpoints(spec: any): Set<string> {
  const documented = new Set<string>();
  const paths = spec.paths || {};

  for (const [pathStr, pathObj] of Object.entries(paths)) {
    const path = pathObj as OpenAPIPath;
    if (path.get) documented.add(`GET ${pathStr}`);
    if (path.post) documented.add(`POST ${pathStr}`);
    if (path.put) documented.add(`PUT ${pathStr}`);
    if (path.patch) documented.add(`PATCH ${pathStr}`);
    if (path.delete) documented.add(`DELETE ${pathStr}`);
  }

  return documented;
}

function getEndpointFile(endpoint: Endpoint): string {
  return endpoint.file.split('/').pop() || endpoint.file;
}

// Analizar
const oldDocumented = getDocumentedEndpoints(oldOpenAPI);
const newDocumented = getDocumentedEndpoints(newOpenAPI);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('🔍 AUDITORÍA DE DOCUMENTACIÓN OPENAPI');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('📊 RESUMEN:');
console.log(`   Total endpoints definidos:    ${allEndpoints.length}`);
console.log(`   Documentados (OpenAPI viejo): ${oldDocumented.size}`);
console.log(`   Documentados (OpenAPI nuevo): ${newDocumented.size}`);
console.log(`   Coverage anterior:             ${((oldDocumented.size / allEndpoints.length) * 100).toFixed(1)}%`);
console.log(`   Coverage nuevo:                ${((newDocumented.size / allEndpoints.length) * 100).toFixed(1)}%`);

// Agrupar endpoints por estado
const documented: Endpoint[] = [];
const missing: Endpoint[] = [];
const byFile: Record<string, { total: number; documented: number; missing: string[] }> = {};

allEndpoints.forEach(ep => {
  const normalized = normalizeOpenAPIPath(ep.path);
  const key = `${ep.method} ${normalized}`;
  const isDocumented = newDocumented.has(key);

  const file = getEndpointFile(ep);
  if (!byFile[file]) {
    byFile[file] = { total: 0, documented: 0, missing: [] };
  }
  byFile[file].total += 1;

  if (isDocumented) {
    documented.push(ep);
    byFile[file].documented += 1;
  } else {
    missing.push(ep);
    byFile[file].missing.push(`${ep.method} ${ep.path}`);
  }
});

console.log(`\n✅ Documentados: ${documented.length}`);
console.log(`❌ Faltantes: ${missing.length}\n`);

// Endpoints faltantes por módulo
console.log('═══════════════════════════════════════════════════════════════');
console.log('📋 ENDPOINTS FALTANTES POR MÓDULO:\n');

const filesWithMissing = Object.entries(byFile)
  .filter(([_, data]) => data.missing.length > 0)
  .sort((a, b) => b[1].missing.length - a[1].missing.length);

filesWithMissing.forEach(([file, data]) => {
  const coverage = ((data.documented / data.total) * 100).toFixed(0);
  console.log(`📄 ${file} (${data.documented}/${data.total} - ${coverage}%)`);
  data.missing.forEach(ep => {
    console.log(`   ❌ ${ep}`);
  });
  console.log('');
});

// Acciones recomendadas
console.log('═══════════════════════════════════════════════════════════════');
console.log('🎯 ACCIONES RECOMENDADAS:\n');

console.log('1️⃣  Completar OpenAPI manualmente para estos módulos:');
filesWithMissing.slice(0, 5).forEach(([file]) => {
  console.log(`    - ${file}`);
});

console.log('\n2️⃣  Usar template para endpoints faltantes:');
console.log(`
"/companies/{companyId}/MODULE/ENDPOINT": {
  "METHODO": {
    "tags": ["🏷️ MODULO"],
    "summary": "Descripción breve",
    "parameters": [
      {
        "name": "companyId",
        "in": "path",
        "required": true,
        "schema": { "type": "string" }
      }
    ],
    "security": [{ "bearerAuth": [] }],
    "responses": {
      "200": { "description": "Success" }
    }
  }
}
`);

console.log('3️⃣  Validar OpenAPI generado:');
console.log(`    npx openapi-validator src/docs/openapi-complete.json\n`);

console.log('4️⃣  Generar cliente TS:');
console.log(`    npx openapi-generator-cli generate \\`);
console.log(`      -i src/docs/openapi-complete.json \\`);
console.log(`      -g typescript-axios \\`);
console.log(`      -o generated/api-client\n`);

// Top 10 módulos con más endpoints faltantes
console.log('═══════════════════════════════════════════════════════════════');
console.log('⚠️  TOP 10 MÓDULOS CON ENDPOINTS FALTANTES:\n');

filesWithMissing.slice(0, 10).forEach(([file, data], i) => {
  console.log(`${i + 1}. ${file.padEnd(40)} ${data.missing.length} faltantes`);
});

// Guardar reporte JSON
const report = {
  timestamp: new Date().toISOString(),
  summary: {
    total: allEndpoints.length,
    documented: documented.length,
    missing: missing.length,
    coverage: ((documented.length / allEndpoints.length) * 100).toFixed(1) + '%'
  },
  byModule: byFile,
  missingEndpoints: missing.map(ep => ({
    method: ep.method,
    path: ep.path,
    file: ep.file
  }))
};

const reportPath = path.join(process.cwd(), 'openapi-audit-report.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

console.log(`\n📊 Reporte guardado: ${reportPath}`);
console.log('\n═══════════════════════════════════════════════════════════════\n');
