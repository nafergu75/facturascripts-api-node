// Clientes MIGRADO a Prisma (modelo Customer): mockeamos prisma.customer para
// probar el slice sin BD real. La factoria FS ya no se usa en clientes.
jest.mock('../config/database', () => ({
  prisma: {
    customer: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'CLI1', nombreFiscal: 'Cliente Demo', nifCif: 'B1', email: null, telefono: null, activo: true },
      ]),
      count: jest.fn().mockResolvedValue(1),
      findFirst: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: 'CLI2', nombreFiscal: 'Nuevo Cliente', nifCif: 'B12345678', email: null, telefono: null, activo: true }),
      update: jest.fn(),
      delete: jest.fn(),
    },
  },
  connectDatabase: jest.fn(),
  disconnectDatabase: jest.fn(),
}));

import request from 'supertest';
import { app } from '../app';
import { authService } from '../services/auth.service';

const tokenEmpresa1 = authService.generateToken({
  userId: 'u1',
  email: 'u1@test.com',
  roles: ['admin'],
  companies: ['1'],
});

describe('Clientes (auth + multiempresa + Prisma)', () => {
  it('GET /companies/1/clientes sin token responde 401', async () => {
    const res = await request(app).get('/companies/1/clientes');
    expect(res.status).toBe(401);
  });

  it('GET /companies/2/clientes con token de empresa 1 responde 403', async () => {
    const res = await request(app)
      .get('/companies/2/clientes')
      .set('Authorization', `Bearer ${tokenEmpresa1}`);
    expect(res.status).toBe(403);
  });

  it('GET /companies/1/clientes con token valido devuelve la lista (Prisma)', async () => {
    const res = await request(app)
      .get('/companies/1/clientes')
      .set('Authorization', `Bearer ${tokenEmpresa1}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].id).toBe('CLI1');
    expect(res.body.data.items[0].nombreFiscal).toBe('Cliente Demo');
  });

  it('POST /companies/1/clientes crea un cliente (201)', async () => {
    const res = await request(app)
      .post('/companies/1/clientes')
      .set('Authorization', `Bearer ${tokenEmpresa1}`)
      .send({ nombre: 'Nuevo Cliente', cifnif: 'B12345678' });
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe('CLI2');
  });
});
