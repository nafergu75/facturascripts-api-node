/**
 * Permisos de las rutas de abonos de proveedor (B11 de la especificación de
 * abonos), sin BD: el 403 llega antes que el controlador.
 *  - Alta, corrección y anulación: compras:write.
 *  - Devoluciones y compensaciones: compras:write o contabilidad:write.
 *  - Lecturas (originales, prellenado, compensaciones): compras:read o contabilidad:read.
 *  - Aprobar el borrador de un abono (con o sin confirmaRectificar303): contabilidad:write.
 *  - Traspaso a la 4709 del 111/115: impuestos:write o contabilidad:write.
 * Y con el permiso, la petición pasa del middleware (no es un 403).
 */
jest.mock('../config/database', () => ({ prisma: {} }));
// El motor contable trae su authMiddleware (lee el token): aqui el usuario lo pone la app de prueba.
jest.mock('../middleware/auth.middleware', () => ({ authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next() }));

import { describe, it, expect } from '@jest/globals';
import express, { type Router } from 'express';
import request from 'supertest';
import { errorMiddleware } from '../middleware/error.middleware';
import expenseInvoicesRoutes from '../routes/expense-invoices.routes';
import { accountingEngineRoutes } from '../routes/accounting-engine.routes';
import borradoresAeatRoutes from '../routes/borradores-aeat.routes';

const E = 'empresa-permisos-abonos';

function app(permisos: string[], ruta: string, router: Router) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { userId: 'u', email: 'u@test.local', roles: [], companies: [E], rolesPorEmpresa: { [E]: [] }, permisosPorEmpresa: { [E]: permisos } } as never;
    req.companyId = E;
    next();
  });
  a.use(ruta, router);
  a.use(errorMiddleware);
  return a;
}
const compras = (permisos: string[]) => app(permisos, '/expense-invoices', expenseInvoicesRoutes);

describe('abonos de proveedor: 403 sin el permiso', () => {
  it.each([
    ['POST', '/expense-invoices'],
    ['PUT', '/expense-invoices/f1'],
    ['POST', '/expense-invoices/f1/anular'],
  ])('%s %s pide compras:write (contabilidad:write no basta)', async (metodo, ruta) => {
    const a = compras(['compras:read', 'contabilidad:read', 'contabilidad:write']);
    const r = metodo === 'PUT' ? await request(a).put(ruta).send({}) : await request(a).post(ruta).send({});
    expect(r.status).toBe(403);
    expect(r.body.message).toBe('No tienes permiso para esto en esta empresa. Si lo necesitas, pídeselo al administrador.');
  });

  it.each([['/expense-invoices/f1/pagos'], ['/expense-invoices/f1/compensaciones'], ['/expense-invoices/f1/compensaciones/c1/anular']])(
    'POST %s pide compras:write o contabilidad:write',
    async (ruta) => {
      expect((await request(compras(['compras:read', 'contabilidad:read'])).post(ruta).send({})).status).toBe(403);
    },
  );

  it.each([['/expense-invoices/originales?supplierId=s1'], ['/expense-invoices/f1/rectificar'], ['/expense-invoices/f1/compensaciones']])(
    'GET %s pide compras:read o contabilidad:read',
    async (ruta) => {
      const r = await request(compras(['ventas:read', 'ventas:write', 'impuestos:read'])).get(ruta);
      expect(r.status).toBe(403);
    },
  );

  it('aprobar el borrador de un abono, también confirmando el 303, pide contabilidad:write', async () => {
    const a = app(['compras:write', 'compras:read'], '/companies/:companyId/accounting', accountingEngineRoutes);
    const r = await request(a).post(`/companies/${E}/accounting/journal-entries/j1/approve`).send({ confirmaRectificar303: true });
    expect(r.status).toBe(403);
  });

  it.each([['/tax-models/111/traspaso-4709'], ['/tax-models/115/traspaso-4709/anular']])('POST %s pide impuestos:write o contabilidad:write', async (ruta) => {
    const a = app(['impuestos:read', 'contabilidad:read', 'compras:write'], '/tax-models', borradoresAeatRoutes);
    expect((await request(a).post(ruta).send({ ejercicio: 2027, periodo: '2T' })).status).toBe(403);
  });
});

describe('con el permiso, el middleware deja pasar', () => {
  // Sin BD, el controlador falla después (500 o 400), pero no es un 403.
  it('compensaciones con contabilidad:write y lecturas con contabilidad:read', async () => {
    const escribir = await request(compras(['contabilidad:write'])).post('/expense-invoices/f1/compensaciones').send({});
    expect(escribir.status).not.toBe(403);
    const leer = await request(compras(['contabilidad:read'])).get('/expense-invoices/originales?supplierId=s1');
    expect(leer.status).not.toBe(403);
  });
});
