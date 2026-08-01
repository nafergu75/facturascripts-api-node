import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware';
import { companyScope } from '../middleware/companyScope.middleware';

import authRoutes from './auth.routes';
import companiesRoutes from './companies.routes';
import usersRoutes from './users.routes';
import clientesRoutes from './clientes.routes';
import proveedoresRoutes from './proveedores.routes';
import comprasRoutes from './compras.routes';
import productosRoutes from './productos.routes';
import impuestosModuloRoutes from './impuestosModulo.routes';
import impuestoSociedadesRoutes from './impuestoSociedades.routes';
import reglasContablesRoutes from './reglasContables.routes';
import plantillasRoutes from './plantillasDocumento.routes';
import planContableRoutes from './planContable.routes';
import planContableBaseRoutes from './planContableBase.routes';
import conciliacionRoutes from './conciliacion.routes';
import periodosRoutes from './periodos.routes';
import complianceRoutes from './compliance.routes';
import sugerenciasRoutes from './sugerenciasContables.routes';
import bancosRoutes from './bancos.routes';
import seriesRoutes from './series.routes';
import extractosRoutes from './extractos.routes';
import cuadreBancosRoutes from './cuadreBancos.routes';
import nominasRoutes from './nominas.routes';
import adminRoutes from './admin.routes';
import incomeInvoicesRoutes from './income-invoices.routes';
import incomeReaderRoutes from './income-reader.routes';
import invoiceExtractorRoutes from './invoice-extractor.routes';
import gastosExtractorRoutes from './gastos-extractor.routes';
import chartOfAccountsRoutes from './chart-of-accounts.routes';
import accountingClosureRoutes from './accounting-closure.routes';
import { accountingEngineRoutes } from './accounting-engine.routes';
import { reportsRoutes } from './reports.routes';
import { taxRoutes } from './tax.routes';
import chatAssistantRoutes from './chatAssistant.routes';
import legalConfigRoutes from './legalConfig.routes';
import fiscalYearsRoutes from './fiscalYears.routes';
import registroMercantilRoutes from './registroMercantil.routes';
import movementsRoutes from './movements.routes';
import archivoRoutes from './archivo.routes';
import importRoutes from './import.routes';
import ocrRoutes from './ocr.routes';
import ocrSessionsRoutes from './ocr-sessions.routes';
import ocrAnalyticsRoutes from './ocr-analytics.routes';

const router = Router();

// --- Publico ---
router.use('/auth', authRoutes);
router.use('/plan-contable/base', planContableBaseRoutes); // plan base PGC-PYME (lectura)

// --- A partir de aqui, todo requiere JWT valido ---
router.use(authMiddleware);

// Gestion de empresas y usuarios (no acotada a una empresa concreta)
router.use('/companies', companiesRoutes);
router.use('/users', usersRoutes);

// Administracion de plataforma (superadmin), no acotada a empresa
router.use('/admin', adminRoutes);

// Registro Mercantil: rutas de nivel superior (/fiscal-years/:fyId/..., /books/...,
// /legalization-packages/..., /annual-accounts/...). El acceso se valida contra la
// empresa del recurso (assertAccesoEmpresa), no via companyScope.
router.use(registroMercantilRoutes);

// Recursos acotados a una empresa: /companies/:companyId/<recurso>
// companyScope valida que el usuario tiene acceso a esa empresa.
const scoped = Router({ mergeParams: true });
scoped.use(companyScope);
scoped.use('/clientes', clientesRoutes);
scoped.use('/proveedores', proveedoresRoutes);
scoped.use('/compras', comprasRoutes);
scoped.use('/productos', productosRoutes);
scoped.use('/impuestos', impuestosModuloRoutes);
scoped.use('/modelo-200', impuestoSociedadesRoutes);
scoped.use('/reglas-contables', reglasContablesRoutes);
scoped.use('/plantillas', plantillasRoutes);
scoped.use('/plan-contable', planContableRoutes);
scoped.use('/conciliacion', conciliacionRoutes);
scoped.use('/periodos', periodosRoutes);
scoped.use('/compliance', complianceRoutes);
scoped.use('/sugerencias', sugerenciasRoutes);
scoped.use('/bancos', bancosRoutes);
scoped.use('/series', seriesRoutes);
scoped.use('/extractos', extractosRoutes);
scoped.use('/cuadre-bancos', cuadreBancosRoutes);
scoped.use('/nominas', nominasRoutes);
scoped.use('/income-invoices', incomeInvoicesRoutes);
scoped.use('/income-reader', incomeReaderRoutes);
scoped.use('/invoice-extractor', invoiceExtractorRoutes);
scoped.use('/gastos-extractor', gastosExtractorRoutes);
scoped.use('/accounting/chart-of-accounts', chartOfAccountsRoutes);
scoped.use('/accounting/closures', accountingClosureRoutes);
scoped.use('/accounting', accountingEngineRoutes);
scoped.use('/reports', reportsRoutes);
scoped.use('/tax', taxRoutes);
scoped.use('/chat-assistant', chatAssistantRoutes);
scoped.use('/legal-config', legalConfigRoutes);
scoped.use('/fiscal-years', fiscalYearsRoutes);
scoped.use('/movements', movementsRoutes);
scoped.use('/archivo', archivoRoutes);
scoped.use('', importRoutes);
scoped.use('', ocrRoutes);
scoped.use('', ocrSessionsRoutes);
scoped.use('', ocrAnalyticsRoutes);

router.use('/companies/:companyId', scoped);

export default router;
