/**
 * Las subcuentas del plan por empresa (/plan-contable/subcuentas) solo se ven
 * con contabilidad:read, como el plan de /accounting/chart-of-accounts. El
 * plan base (sin datos de la empresa) sigue siendo publico.
 */
import { describe, it, expect } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import planContableRoutes from '../routes/planContable.routes';
import planContableBaseRoutes from '../routes/planContableBase.routes';
import { errorMiddleware } from '../middleware/error.middleware';

const E = 'empresa-plan-lectura';

function app(permisos: string[]) {
  const a = express();
  a.use(express.json());
  a.use('/plan-contable/base', planContableBaseRoutes);
  a.use((req, _res, next) => {
    req.user = { userId: 'u', email: 'u@test.local', roles: ['x'], companies: [E], rolesPorEmpresa: { [E]: ['x'] }, permisosPorEmpresa: { [E]: permisos } } as never;
    req.companyId = E;
    next();
  });
  a.use('/plan-contable', planContableRoutes);
  a.use(errorMiddleware);
  return a;
}

describe('lectura del plan contable', () => {
  it('sin contabilidad:read, 403 en las subcuentas de la empresa', async () => {
    expect((await request(app(['ventas:read', 'ventas:write', 'compras:read'])).get('/plan-contable/subcuentas')).status).toBe(403);
  });

  it('con contabilidad:read (o el administrador), 200', async () => {
    expect((await request(app(['contabilidad:read'])).get('/plan-contable/subcuentas')).status).toBe(200);
    expect((await request(app(['*'])).get('/plan-contable/subcuentas')).status).toBe(200);
  });

  it('el plan base sigue siendo publico', async () => {
    expect((await request(app([])).get('/plan-contable/base/grupos')).status).toBe(200);
  });
});
