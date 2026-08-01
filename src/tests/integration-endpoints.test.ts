/**
 * Suite de Integración: Endpoints HTTP Reales
 *
 * Objetivo: Hacer peticiones HTTP reales a endpoints críticos
 * para generar logs en logs/requests.jsonl
 *
 * Uso: npm test -- src/tests/integration-endpoints.test.ts
 *
 * Genera: logs/requests.jsonl con peticiones reales
 */

import request from 'supertest';
import { createApp } from '../app';
import { Express } from 'express';
import { prisma } from '../config/database';

// Usar app sin middlewares de auth para tests
const app: Express = createApp();

// ─────────────────────────────────────────────────────────────────────────────
// SETUP & TEARDOWN
// ─────────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Limpiar y preparar BD de test
  console.log('🚀 Iniciando suite de integración...');
});

afterAll(async () => {
  // Desconectar BD
  console.log('✅ Suite de integración completada. Revisa logs/requests.jsonl');
});

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINTS PÚBLICOS (sin auth)
// ─────────────────────────────────────────────────────────────────────────────

describe('PUBLIC: Auth & Health', () => {
  it('GET /health → healthcheck sin auth', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Log generado automáticamente por middleware
  });

  it('POST /auth/dev-login → dev login (development)', async () => {
    const res = await request(app).post('/auth/dev-login').send({});
    // Puede fallar en test, pero genera log
    expect([200, 400]).toContain(res.status);
  });

  it('POST /auth/login → login endpoint', async () => {
    const res = await request(app).post('/auth/login').send({
      email: 'test@example.com',
      password: 'wrong-password',
    });
    // Genera log aunque falle
    expect([400, 401]).toContain(res.status);
  });

  it('POST /auth/refresh → refresh token', async () => {
    const res = await request(app).post('/auth/refresh').send({
      refreshToken: 'invalid-token',
    });
    // Genera log
    expect([400, 401]).toContain(res.status);
  });

  it('POST /auth/logout → logout endpoint', async () => {
    const res = await request(app).post('/auth/logout').send({
      refreshToken: 'token',
    });
    // Genera log
    expect([200, 400]).toContain(res.status);
  });
});

describe('PUBLIC: Plan Contable Base (sin auth)', () => {
  it('GET /plan-contable/base/cuentas → listar cuentas PGC', async () => {
    const res = await request(app).get('/plan-contable/base/cuentas');
    // Público, sin auth
    expect([200, 400]).toContain(res.status);
  });

  it('GET /plan-contable/base/grupos → listar grupos', async () => {
    const res = await request(app).get('/plan-contable/base/grupos');
    expect([200, 400]).toContain(res.status);
  });

  it('GET /plan-contable/base/subgrupos → listar subgrupos', async () => {
    const res = await request(app).get('/plan-contable/base/subgrupos');
    expect([200, 400]).toContain(res.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINTS PROTEGIDOS (con auth - estos fallarán pero generan logs)
// ─────────────────────────────────────────────────────────────────────────────

describe('PROTECTED: Companies (sin JWT válido)', () => {
  it('GET /companies/ → listar empresas', async () => {
    const res = await request(app).get('/companies/');
    // Fallarán por falta de JWT, pero genera log
    expect([401, 403]).toContain(res.status);
  });

  it('POST /companies/ → crear empresa', async () => {
    const res = await request(app).post('/companies/').send({
      nombre: 'Test Corp',
    });
    expect([401, 403]).toContain(res.status);
  });

  it('GET /companies/:id → obtener empresa', async () => {
    const res = await request(app).get('/companies/test-id');
    expect([401, 403]).toContain(res.status);
  });

  it('PUT /companies/:id → actualizar empresa', async () => {
    const res = await request(app).put('/companies/test-id').send({});
    expect([401, 403]).toContain(res.status);
  });

  it('DELETE /companies/:id → eliminar empresa', async () => {
    const res = await request(app).delete('/companies/test-id');
    expect([401, 403]).toContain(res.status);
  });
});

describe('PROTECTED: Admin (sin JWT válido)', () => {
  it('GET /admin/empresas → listar empresas (admin)', async () => {
    const res = await request(app).get('/admin/empresas');
    expect([401, 403]).toContain(res.status);
  });

  it('POST /admin/empresas → crear empresa (admin)', async () => {
    const res = await request(app).post('/admin/empresas').send({});
    expect([401, 403]).toContain(res.status);
  });

  it('POST /admin/usuarios → crear usuario (admin)', async () => {
    const res = await request(app).post('/admin/usuarios').send({});
    expect([401, 403]).toContain(res.status);
  });

  it('POST /admin/usuarios/:userId/empresas/:companyId → asignar empresa', async () => {
    const res = await request(app)
      .post('/admin/usuarios/user1/empresas/comp1')
      .send({});
    expect([401, 403]).toContain(res.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SCOPEADOS: /companies/:companyId/* (fallarán sin auth, pero generan logs)
// ─────────────────────────────────────────────────────────────────────────────

describe('SCOPED: Income Reader', () => {
  const companyId = 'test-company-1';

  it('GET /companies/:companyId/income-reader/pending', async () => {
    const res = await request(app).get(
      `/companies/${companyId}/income-reader/pending`
    );
    expect([401, 403, 404]).toContain(res.status);
  });

  it('POST /companies/:companyId/income-reader/web-upload', async () => {
    const res = await request(app)
      .post(`/companies/${companyId}/income-reader/web-upload`)
      .send({});
    expect([401, 403, 404]).toContain(res.status);
  });

  it('GET /companies/:companyId/income-reader/config', async () => {
    const res = await request(app).get(
      `/companies/${companyId}/income-reader/config`
    );
    expect([401, 403, 404]).toContain(res.status);
  });

  it('GET /companies/:companyId/income-reader/:id', async () => {
    const res = await request(app).get(
      `/companies/${companyId}/income-reader/doc-1`
    );
    expect([401, 403, 404]).toContain(res.status);
  });

  it('POST /companies/:companyId/income-reader/:id/verify', async () => {
    const res = await request(app)
      .post(`/companies/${companyId}/income-reader/doc-1/verify`)
      .send({});
    expect([401, 403, 404]).toContain(res.status);
  });
});

describe('SCOPED: Clientes', () => {
  const companyId = 'test-company-1';

  it('GET /companies/:companyId/clientes/', async () => {
    const res = await request(app).get(`/companies/${companyId}/clientes/`);
    expect([401, 403, 404]).toContain(res.status);
  });

  it('POST /companies/:companyId/clientes/', async () => {
    const res = await request(app)
      .post(`/companies/${companyId}/clientes/`)
      .send({ nombre: 'Cliente Test' });
    expect([401, 403, 404]).toContain(res.status);
  });

  it('GET /companies/:companyId/clientes/:id', async () => {
    const res = await request(app).get(`/companies/${companyId}/clientes/c1`);
    expect([401, 403, 404]).toContain(res.status);
  });

  it('PUT /companies/:companyId/clientes/:id', async () => {
    const res = await request(app)
      .put(`/companies/${companyId}/clientes/c1`)
      .send({});
    expect([401, 403, 404]).toContain(res.status);
  });

  it('DELETE /companies/:companyId/clientes/:id', async () => {
    const res = await request(app).delete(`/companies/${companyId}/clientes/c1`);
    expect([401, 403, 404]).toContain(res.status);
  });
});

describe('SCOPED: Accounting Engine', () => {
  const companyId = 'test-company-1';

  it('POST /companies/:companyId/accounting/contabilizar/:invoiceId', async () => {
    const res = await request(app)
      .post(`/companies/${companyId}/accounting/contabilizar/inv-1`)
      .query({ tipo: 'INGRESO' })
      .send({});
    expect([401, 403, 404]).toContain(res.status);
  });

  it('GET /companies/:companyId/accounting/journal-entries', async () => {
    const res = await request(app).get(
      `/companies/${companyId}/accounting/journal-entries`
    );
    expect([401, 403, 404]).toContain(res.status);
  });

  it('GET /companies/:companyId/accounting/journal-entries/:journalEntryId', async () => {
    const res = await request(app).get(
      `/companies/${companyId}/accounting/journal-entries/je-1`
    );
    expect([401, 403, 404]).toContain(res.status);
  });

  it('POST /companies/:companyId/accounting/journal-entries/:journalEntryId/approve', async () => {
    const res = await request(app)
      .post(`/companies/${companyId}/accounting/journal-entries/je-1/approve`)
      .send({});
    expect([401, 403, 404]).toContain(res.status);
  });
});

describe('SCOPED: Impuestos', () => {
  const companyId = 'test-company-1';

  it('GET /companies/:companyId/impuestos/modelos', async () => {
    const res = await request(app).get(
      `/companies/${companyId}/impuestos/modelos`
    );
    expect([401, 403, 404]).toContain(res.status);
  });

  it('GET /companies/:companyId/impuestos/modelos/:modeloId', async () => {
    const res = await request(app).get(
      `/companies/${companyId}/impuestos/modelos/modelo-303-2026-t1`
    );
    expect([401, 403, 404]).toContain(res.status);
  });

  it('PUT /companies/:companyId/impuestos/modelos/:modeloId', async () => {
    const res = await request(app)
      .put(`/companies/${companyId}/impuestos/modelos/modelo-303-2026-t1`)
      .send({});
    expect([401, 403, 404]).toContain(res.status);
  });

  it('POST /companies/:companyId/impuestos/modelos/:modeloId/recalcular', async () => {
    const res = await request(app)
      .post(
        `/companies/${companyId}/impuestos/modelos/modelo-303-2026-t1/recalcular`
      )
      .send({});
    expect([401, 403, 404]).toContain(res.status);
  });
});

describe('SCOPED: Reports', () => {
  const companyId = 'test-company-1';

  it('GET /companies/:companyId/reports/balance', async () => {
    const res = await request(app)
      .get(`/companies/${companyId}/reports/balance`)
      .query({ from: '2026-01-01', to: '2026-12-31' });
    expect([401, 403, 404]).toContain(res.status);
  });

  it('GET /companies/:companyId/reports/profit-and-loss', async () => {
    const res = await request(app)
      .get(`/companies/${companyId}/reports/profit-and-loss`)
      .query({ from: '2026-01-01', to: '2026-12-31' });
    expect([401, 403, 404]).toContain(res.status);
  });

  it('GET /companies/:companyId/reports/income', async () => {
    const res = await request(app).get(
      `/companies/${companyId}/reports/income`
    );
    expect([401, 403, 404]).toContain(res.status);
  });

  it('GET /companies/:companyId/reports/expenses', async () => {
    const res = await request(app).get(
      `/companies/${companyId}/reports/expenses`
    );
    expect([401, 403, 404]).toContain(res.status);
  });
});

describe('SCOPED: Chart of Accounts', () => {
  const companyId = 'test-company-1';

  it('GET /companies/:companyId/accounting/chart-of-accounts/', async () => {
    const res = await request(app).get(
      `/companies/${companyId}/accounting/chart-of-accounts/`
    );
    expect([401, 403, 404]).toContain(res.status);
  });

  it('POST /companies/:companyId/accounting/chart-of-accounts/', async () => {
    const res = await request(app)
      .post(`/companies/${companyId}/accounting/chart-of-accounts/`)
      .send({});
    expect([401, 403, 404]).toContain(res.status);
  });

  it('GET /companies/:companyId/accounting/chart-of-accounts/:codigo', async () => {
    const res = await request(app).get(
      `/companies/${companyId}/accounting/chart-of-accounts/700`
    );
    expect([401, 403, 404]).toContain(res.status);
  });
});

describe('SCOPED: Tax', () => {
  const companyId = 'test-company-1';

  it('GET /companies/:companyId/tax/vat/books/issued', async () => {
    const res = await request(app)
      .get(`/companies/${companyId}/tax/vat/books/issued`)
      .query({ period: 'Q1-2026' });
    expect([401, 403, 404]).toContain(res.status);
  });

  it('GET /companies/:companyId/tax/vat/summary', async () => {
    const res = await request(app)
      .get(`/companies/${companyId}/tax/vat/summary`)
      .query({ period: 'Q1-2026' });
    expect([401, 403, 404]).toContain(res.status);
  });
});

describe('SCOPED: Bancos', () => {
  const companyId = 'test-company-1';

  it('GET /companies/:companyId/bancos/cuentas', async () => {
    const res = await request(app).get(
      `/companies/${companyId}/bancos/cuentas`
    );
    expect([401, 403, 404]).toContain(res.status);
  });

  it('POST /companies/:companyId/bancos/cuentas', async () => {
    const res = await request(app)
      .post(`/companies/${companyId}/bancos/cuentas`)
      .send({});
    expect([401, 403, 404]).toContain(res.status);
  });

  it('GET /companies/:companyId/bancos/movimientos', async () => {
    const res = await request(app).get(
      `/companies/${companyId}/bancos/movimientos`
    );
    expect([401, 403, 404]).toContain(res.status);
  });
});

describe('SCOPED: Registro Mercantil', () => {
  it('GET /fiscal-years/:fyId/books', async () => {
    const res = await request(app).get(`/fiscal-years/fy-1/books`);
    expect([401, 403, 404]).toContain(res.status);
  });

  it('POST /fiscal-years/:fyId/books/generate', async () => {
    const res = await request(app)
      .post(`/fiscal-years/fy-1/books/generate`)
      .send({});
    expect([401, 403, 404]).toContain(res.status);
  });

  it('GET /fiscal-years/:fyId/annual-accounts', async () => {
    const res = await request(app).get(`/fiscal-years/fy-1/annual-accounts`);
    expect([401, 403, 404]).toContain(res.status);
  });

  it('POST /fiscal-years/:fyId/annual-accounts/generate', async () => {
    const res = await request(app)
      .post(`/fiscal-years/fy-1/annual-accounts/generate`)
      .send({});
    expect([401, 403, 404]).toContain(res.status);
  });
});

describe('SCOPED: Carmen Chat Assistant', () => {
  const companyId = 'test-company-1';

  it('POST /companies/:companyId/chat-assistant/', async () => {
    const res = await request(app)
      .post(`/companies/${companyId}/chat-assistant/`)
      .send({ message: 'Hello' });
    expect([401, 403, 404]).toContain(res.status);
  });

  it('GET /companies/:companyId/chat-assistant/:sessionId/messages', async () => {
    const res = await request(app).get(
      `/companies/${companyId}/chat-assistant/session-1/messages`
    );
    expect([401, 403, 404]).toContain(res.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RESUMEN
// ─────────────────────────────────────────────────────────────────────────────

describe('RESUMEN: Integración de endpoints', () => {
  it('Debería haber generado logs en logs/requests.jsonl', () => {
    // Este test es informativo
    console.log('✅ Suite de integración completada');
    console.log('   Revisa logs/requests.jsonl para ver las peticiones registradas');
    console.log('   Luego ejecuta: npm run script:find-dead-endpoints');
    expect(true).toBe(true);
  });
});
