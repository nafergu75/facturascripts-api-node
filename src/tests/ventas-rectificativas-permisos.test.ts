/**
 * Permisos y orden de las rutas nuevas de rectificativas de venta, sin BD:
 *  - GET /income-invoices/rectificativas/opciones, /originales y /:id/rectificar
 *    piden ventas:read o contabilidad:read (403 antes del controlador);
 *  - van antes de '/:id': «rectificativas» y «originales» no se toman por un id.
 * Los controladores se sustituyen por uno que dice qué manejador respondió.
 */
jest.mock('../config/database', () => ({ prisma: {} }));
const manejador = (nombre: string) => (_req: unknown, res: { json: (b: unknown) => void }) => res.json({ manejador: nombre });
const porNombre = () => new Proxy({}, { get: (_t, nombre) => manejador(String(nombre)) });
jest.mock('../controllers/income-invoices.controller', () => ({ incomeInvoicesController: porNombre() }));
jest.mock('../controllers/cobrosPagos.controller', () => ({ cobrosController: porNombre() }));

import { describe, it, expect } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { errorMiddleware } from '../middleware/error.middleware';
import incomeInvoicesRoutes from '../routes/income-invoices.routes';

const E = 'empresa-permisos-rect-venta';

function app(permisos: string[]) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { userId: 'u', email: 'u@test.local', roles: [], companies: [E], rolesPorEmpresa: { [E]: [] }, permisosPorEmpresa: { [E]: permisos } } as never;
    req.companyId = E;
    next();
  });
  a.use('/income-invoices', incomeInvoicesRoutes);
  a.use(errorMiddleware);
  return a;
}

const RUTAS: Array<[string, string]> = [
  ['/income-invoices/rectificativas/opciones', 'opcionesRectificativa'],
  ['/income-invoices/originales?q=A-12&customerId=c1', 'originales'],
  ['/income-invoices/f1/rectificar', 'paraRectificar'],
];

describe('rectificativas de venta: lecturas', () => {
  it.each(RUTAS)('GET %s sin ventas:read ni contabilidad:read: 403', async (ruta) => {
    const r = await request(app(['compras:read', 'compras:write', 'impuestos:read', 'impuestos:write'])).get(ruta);
    expect(r.status).toBe(403);
    expect(r.body.message).toBe('No tienes permiso para esto en esta empresa. Si lo necesitas, pídeselo al administrador.');
  });

  it.each(RUTAS)('GET %s con ventas:read llega a su manejador (no a /:id)', async (ruta, nombre) => {
    const r = await request(app(['ventas:read'])).get(ruta);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ manejador: nombre });
  });

  it.each(RUTAS)('GET %s con contabilidad:read también', async (ruta, nombre) => {
    const r = await request(app(['contabilidad:read'])).get(ruta);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ manejador: nombre });
  });

  it('una factura cualquiera sigue yendo a /:id', async () => {
    expect((await request(app(['ventas:read'])).get('/income-invoices/f1')).body).toEqual({ manejador: 'obtenerPorId' });
  });
});
