#!/usr/bin/env node
/**
 * Script: Enumerar todos los endpoints de la API
 * Uso: npm run script:list-endpoints
 * Salida: endpoints.json en la raíz del proyecto
 */

import fs from 'fs';
import path from 'path';
import { Router } from 'express';

interface EndpointInfo {
  method: string;
  path: string;
  file: string;
  auth: boolean;
  scope: 'public' | 'protected' | 'scoped';
}

// Importar todos los routers
import authRoutes from '../src/routes/auth.routes';
import companiesRoutes from '../src/routes/companies.routes';
import usersRoutes from '../src/routes/users.routes';
import clientesRoutes from '../src/routes/clientes.routes';
import proveedoresRoutes from '../src/routes/proveedores.routes';
import comprasRoutes from '../src/routes/compras.routes';
import productosRoutes from '../src/routes/productos.routes';
import impuestosModuloRoutes from '../src/routes/impuestosModulo.routes';
import impuestoSociedadesRoutes from '../src/routes/impuestoSociedades.routes';
import reglasContablesRoutes from '../src/routes/reglasContables.routes';
import plantillasRoutes from '../src/routes/plantillasDocumento.routes';
import planContableRoutes from '../src/routes/planContable.routes';
import planContableBaseRoutes from '../src/routes/planContableBase.routes';
import conciliacionRoutes from '../src/routes/conciliacion.routes';
import periodosRoutes from '../src/routes/periodos.routes';
import complianceRoutes from '../src/routes/compliance.routes';
import sugerenciasRoutes from '../src/routes/sugerenciasContables.routes';
import bancosRoutes from '../src/routes/bancos.routes';
import seriesRoutes from '../src/routes/series.routes';
import extractosRoutes from '../src/routes/extractos.routes';
import cuadreBancosRoutes from '../src/routes/cuadreBancos.routes';
import nominasRoutes from '../src/routes/nominas.routes';
import adminRoutes from '../src/routes/admin.routes';
import incomeInvoicesRoutes from '../src/routes/income-invoices.routes';
import incomeReaderRoutes from '../src/routes/income-reader.routes';
import chartOfAccountsRoutes from '../src/routes/chart-of-accounts.routes';
import accountingClosureRoutes from '../src/routes/accounting-closure.routes';
import { accountingEngineRoutes } from '../src/routes/accounting-engine.routes';
import { reportsRoutes } from '../src/routes/reports.routes';
import { taxRoutes } from '../src/routes/tax.routes';
import chatAssistantRoutes from '../src/routes/chatAssistant.routes';
import legalConfigRoutes from '../src/routes/legalConfig.routes';
import fiscalYearsRoutes from '../src/routes/fiscalYears.routes';
import registroMercantilRoutes from '../src/routes/registroMercantil.routes';

// Mapeo de routers a archivos y scope
const routerMap: Array<{
  router: Router;
  file: string;
  basePath: string;
  scope: 'public' | 'protected' | 'scoped';
}> = [
  { router: authRoutes, file: 'auth.routes.ts', basePath: '/auth', scope: 'public' },
  { router: planContableBaseRoutes, file: 'planContableBase.routes.ts', basePath: '/plan-contable/base', scope: 'public' },
  { router: companiesRoutes, file: 'companies.routes.ts', basePath: '/companies', scope: 'protected' },
  { router: usersRoutes, file: 'users.routes.ts', basePath: '/users', scope: 'protected' },
  { router: adminRoutes, file: 'admin.routes.ts', basePath: '/admin', scope: 'protected' },
  { router: registroMercantilRoutes, file: 'registroMercantil.routes.ts', basePath: '', scope: 'protected' },
  // Scoped (bajo /companies/:companyId)
  { router: clientesRoutes, file: 'clientes.routes.ts', basePath: '/companies/:companyId/clientes', scope: 'scoped' },
  { router: proveedoresRoutes, file: 'proveedores.routes.ts', basePath: '/companies/:companyId/proveedores', scope: 'scoped' },
  { router: comprasRoutes, file: 'compras.routes.ts', basePath: '/companies/:companyId/compras', scope: 'scoped' },
  { router: productosRoutes, file: 'productos.routes.ts', basePath: '/companies/:companyId/productos', scope: 'scoped' },
  { router: impuestosModuloRoutes, file: 'impuestosModulo.routes.ts', basePath: '/companies/:companyId/impuestos', scope: 'scoped' },
  { router: impuestoSociedadesRoutes, file: 'impuestoSociedades.routes.ts', basePath: '/companies/:companyId/modelo-200', scope: 'scoped' },
  { router: reglasContablesRoutes, file: 'reglasContables.routes.ts', basePath: '/companies/:companyId/reglas-contables', scope: 'scoped' },
  { router: plantillasRoutes, file: 'plantillasDocumento.routes.ts', basePath: '/companies/:companyId/plantillas', scope: 'scoped' },
  { router: planContableRoutes, file: 'planContable.routes.ts', basePath: '/companies/:companyId/plan-contable', scope: 'scoped' },
  { router: conciliacionRoutes, file: 'conciliacion.routes.ts', basePath: '/companies/:companyId/conciliacion', scope: 'scoped' },
  { router: periodosRoutes, file: 'periodos.routes.ts', basePath: '/companies/:companyId/periodos', scope: 'scoped' },
  { router: complianceRoutes, file: 'compliance.routes.ts', basePath: '/companies/:companyId/compliance', scope: 'scoped' },
  { router: sugerenciasRoutes, file: 'sugerenciasContables.routes.ts', basePath: '/companies/:companyId/sugerencias', scope: 'scoped' },
  { router: bancosRoutes, file: 'bancos.routes.ts', basePath: '/companies/:companyId/bancos', scope: 'scoped' },
  { router: seriesRoutes, file: 'series.routes.ts', basePath: '/companies/:companyId/series', scope: 'scoped' },
  { router: extractosRoutes, file: 'extractos.routes.ts', basePath: '/companies/:companyId/extractos', scope: 'scoped' },
  { router: cuadreBancosRoutes, file: 'cuadreBancos.routes.ts', basePath: '/companies/:companyId/cuadre-bancos', scope: 'scoped' },
  { router: nominasRoutes, file: 'nominas.routes.ts', basePath: '/companies/:companyId/nominas', scope: 'scoped' },
  { router: incomeInvoicesRoutes, file: 'income-invoices.routes.ts', basePath: '/companies/:companyId/invoices', scope: 'scoped' },
  { router: incomeReaderRoutes, file: 'income-reader.routes.ts', basePath: '/companies/:companyId/income-reader', scope: 'scoped' },
  { router: chartOfAccountsRoutes, file: 'chart-of-accounts.routes.ts', basePath: '/companies/:companyId/accounting/chart-of-accounts', scope: 'scoped' },
  { router: accountingClosureRoutes, file: 'accounting-closure.routes.ts', basePath: '/companies/:companyId/accounting/closures', scope: 'scoped' },
  { router: accountingEngineRoutes, file: 'accounting-engine.routes.ts', basePath: '/companies/:companyId/accounting', scope: 'scoped' },
  { router: reportsRoutes, file: 'reports.routes.ts', basePath: '/companies/:companyId/reports', scope: 'scoped' },
  { router: taxRoutes, file: 'tax.routes.ts', basePath: '/companies/:companyId/tax', scope: 'scoped' },
  { router: chatAssistantRoutes, file: 'chatAssistant.routes.ts', basePath: '/companies/:companyId/chat-assistant', scope: 'scoped' },
  { router: legalConfigRoutes, file: 'legalConfig.routes.ts', basePath: '/companies/:companyId/legal-config', scope: 'scoped' },
  { router: fiscalYearsRoutes, file: 'fiscalYears.routes.ts', basePath: '/companies/:companyId/fiscal-years', scope: 'scoped' },
];

/**
 * Extrae las rutas de un router Express.
 * Inspecciona la pila de middleware y busca funciones de ruta.
 */
function extractRoutesFromRouter(router: Router, basePath: string): EndpointInfo[] {
  const endpoints: EndpointInfo[] = [];

  if (!router.stack) return endpoints;

  router.stack.forEach((layer: any) => {
    if (!layer.route) return; // Ignorar middlewares que no sean rutas

    const route = layer.route;
    const methods = Object.keys(route.methods);

    methods.forEach((method: string) => {
      const path = basePath + route.path;
      endpoints.push({
        method: method.toUpperCase(),
        path,
        file: '', // Se llena después
        auth: false, // Se detecta por scope
        scope: 'public',
      });
    });
  });

  return endpoints;
}

// Enumerar todos los endpoints
const allEndpoints: EndpointInfo[] = [];

routerMap.forEach(({ router, file, basePath, scope }) => {
  const endpoints = extractRoutesFromRouter(router, basePath);
  endpoints.forEach((ep) => {
    ep.file = file;
    ep.scope = scope;
    ep.auth = scope !== 'public';
  });
  allEndpoints.push(...endpoints);
});

// Agregar healthcheck (no está en los routers, está en app.ts)
allEndpoints.push({
  method: 'GET',
  path: '/health',
  file: 'app.ts',
  auth: false,
  scope: 'public',
});

// Ordenar por path + método
allEndpoints.sort((a, b) => {
  if (a.path !== b.path) return a.path.localeCompare(b.path);
  return a.method.localeCompare(b.method);
});

// Generar reporte
const report = {
  timestamp: new Date().toISOString(),
  totalEndpoints: allEndpoints.length,
  byScope: {
    public: allEndpoints.filter((e) => e.scope === 'public').length,
    protected: allEndpoints.filter((e) => e.scope === 'protected').length,
    scoped: allEndpoints.filter((e) => e.scope === 'scoped').length,
  },
  byAuth: {
    noAuth: allEndpoints.filter((e) => !e.auth).length,
    withAuth: allEndpoints.filter((e) => e.auth).length,
  },
  endpoints: allEndpoints,
};

// Guardar en JSON
const outputPath = path.join(process.cwd(), 'endpoints.json');
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

console.log(`✅ Inventario de endpoints generado: ${outputPath}`);
console.log(`📊 Total: ${report.totalEndpoints} endpoints`);
console.log(`   - Públicos: ${report.byScope.public}`);
console.log(`   - Protegidos: ${report.byScope.protected}`);
console.log(`   - Scopeados: ${report.byScope.scoped}`);
console.log(`   - Con auth: ${report.byAuth.withAuth}`);
console.log(`   - Sin auth: ${report.byAuth.noAuth}`);
