#!/usr/bin/env node
/**
 * Script: Detectar endpoints "muertos" (definidos pero nunca usados)
 *
 * Compara:
 * - endpoints.json (inventario de rutas definidas)
 * - logs/requests.jsonl (rutas realmente usadas)
 *
 * Genera un reporte de candidatos a "zombie endpoints"
 *
 * Uso: npm run script:find-dead-endpoints
 */

import fs from 'fs';
import path from 'path';

interface EndpointInfo {
  method: string;
  path: string;
  file: string;
  auth: boolean;
  scope: 'public' | 'protected' | 'scoped';
}

interface EndpointInventory {
  timestamp: string;
  totalEndpoints: number;
  endpoints: EndpointInfo[];
}

interface RequestLog {
  timestamp: string;
  method: string;
  path: string;
  statusCode?: number;
  duration?: number;
  userId?: string;
  companyId?: string;
}

/**
 * Normalizar ruta para comparación:
 * - /companies/123/clientes/456 → /companies/:companyId/clientes/:id
 * - /auth/login → /auth/login (sin cambios)
 */
function normalizeRoutePath(path: string): string {
  // Reemplazar UUIDs y números de IDs
  return path
    .replace(/\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '/:id') // UUID
    .replace(/\/\d+(?=\/|$)/g, '/:id') // Números
    .replace(/\/[a-zA-Z0-9]{20,}(?=\/|$)/g, '/:id'); // IDs largos (Mongo, etc.)
}

// Leer inventario de endpoints
const inventoryPath = path.join(process.cwd(), 'endpoints.json');
if (!fs.existsSync(inventoryPath)) {
  console.error(`❌ endpoints.json no encontrado. Ejecuta primero: npm run script:list-endpoints`);
  process.exit(1);
}

const inventory: EndpointInventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf-8'));
console.log(`📋 Inventario cargado: ${inventory.totalEndpoints} endpoints definidos`);

// Leer logs de peticiones
const logsPath = path.join(process.cwd(), 'logs', 'requests.jsonl');
const usedRoutes = new Set<string>();

if (fs.existsSync(logsPath)) {
  const lines = fs.readFileSync(logsPath, 'utf-8').split('\n').filter((l) => l.trim());
  console.log(`📊 Logs cargados: ${lines.length} peticiones`);

  lines.forEach((line) => {
    try {
      const log = JSON.parse(line) as RequestLog;
      const normalized = normalizeRoutePath(log.path);
      usedRoutes.add(`${log.method} ${normalized}`);
    } catch (e) {
      // Ignorar líneas inválidas
    }
  });

  console.log(`✅ Rutas únicas usadas: ${usedRoutes.size}\n`);
} else {
  console.warn(`⚠️  No se encontraron logs en ${logsPath}. Asegúrate de que requestLoggerMiddleware está activado.`);
  console.warn(`   Sin logs, no se puede hacer comparación. Continuando con análisis parcial...\n`);
}

// Agrupar endpoints por archivo para análisis
const byFile = new Map<string, EndpointInfo[]>();
inventory.endpoints.forEach((ep) => {
  if (!byFile.has(ep.file)) {
    byFile.set(ep.file, []);
  }
  byFile.get(ep.file)!.push(ep);
});

// Analizar cada endpoint
const deadEndpoints: EndpointInfo[] = [];
const aliveEndpoints: EndpointInfo[] = [];
const partiallyUsed: { endpoint: EndpointInfo; used: boolean }[] = [];

inventory.endpoints.forEach((endpoint) => {
  const normalized = normalizeRoutePath(endpoint.path);
  const key = `${endpoint.method} ${normalized}`;

  if (usedRoutes.has(key)) {
    aliveEndpoints.push(endpoint);
  } else {
    deadEndpoints.push(endpoint);
  }
});

// Generar reporte
const report = {
  timestamp: new Date().toISOString(),
  analysis: {
    totalDefined: inventory.totalEndpoints,
    totalUsed: usedRoutes.size,
    alive: aliveEndpoints.length,
    dead: deadEndpoints.length,
    percentageUsed: ((aliveEndpoints.length / inventory.totalEndpoints) * 100).toFixed(1),
  },
  deadEndpoints: deadEndpoints.sort((a, b) => a.path.localeCompare(b.path)),
  byFile: Object.fromEntries(
    Array.from(byFile.entries()).map(([file, endpoints]) => [
      file,
      {
        total: endpoints.length,
        dead: endpoints.filter((e) => deadEndpoints.includes(e)).length,
        alive: endpoints.filter((e) => aliveEndpoints.includes(e)).length,
      },
    ])
  ),
};

// Guardar reporte
const reportPath = path.join(process.cwd(), 'dead-endpoints-report.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

// Imprimir resumen en consola
console.log('═══════════════════════════════════════════════════════════════');
console.log('🔍 REPORTE DE ENDPOINTS MUERTOS');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`\n📊 Resumen:`);
console.log(`   Total definidos:  ${report.analysis.totalDefined}`);
console.log(`   Total usados:     ${report.analysis.totalUsed}`);
console.log(`   Vivos:            ${report.analysis.alive} (${report.analysis.percentageUsed}%)`);
console.log(`   Muertos:          ${report.analysis.dead}`);

if (deadEndpoints.length > 0) {
  console.log(`\n🚨 ${deadEndpoints.length} ENDPOINTS CANDIDATOS A ZOMBIE:\n`);

  // Agrupar por archivo
  const deadByFile = new Map<string, EndpointInfo[]>();
  deadEndpoints.forEach((ep) => {
    if (!deadByFile.has(ep.file)) {
      deadByFile.set(ep.file, []);
    }
    deadByFile.get(ep.file)!.push(ep);
  });

  Array.from(deadByFile.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([file, endpoints]) => {
      console.log(`   📄 ${file} (${endpoints.length} muertas)`);
      endpoints.forEach((ep) => {
        console.log(`      ${ep.method.padEnd(6)} ${ep.path}`);
      });
      console.log();
    });
} else {
  console.log('\n✅ Todos los endpoints están siendo usados!');
}

console.log(`\n💾 Reporte guardado: ${reportPath}`);
console.log('═══════════════════════════════════════════════════════════════');

// Exportar también en formato CSV para análisis
const csvPath = path.join(process.cwd(), 'dead-endpoints.csv');
const csvContent =
  'METHOD,PATH,FILE,SCOPE,AUTH\n' +
  deadEndpoints.map((ep) => `${ep.method},"${ep.path}",${ep.file},${ep.scope},${ep.auth}`).join('\n');
fs.writeFileSync(csvPath, csvContent);
console.log(`📊 CSV para análisis: ${csvPath}`);
