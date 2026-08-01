// Mock de Prisma para reglas contables.
const findUnique = jest.fn();
const upsert = jest.fn();
jest.mock('../config/database', () => ({
  prisma: { reglasContables: { findUnique, upsert } },
  connectDatabase: jest.fn(),
  disconnectDatabase: jest.fn(),
}));

import request from 'supertest';
import { app } from '../app';
import { authService } from '../services/auth.service';

const token = authService.generateToken({ userId: 'u1', email: 'u1@test.com', roles: ['admin'], companies: ['1'] });
const auth = { Authorization: `Bearer ${token}` };

beforeEach(() => {
  findUnique.mockReset();
  upsert.mockReset();
});

describe('Reglas contables por empresa', () => {
  it('GET devuelve las reglas por defecto si no hay nada guardado', async () => {
    findUnique.mockResolvedValue(null);
    const res = await request(app).get('/companies/1/reglas-contables').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data.cuentaClientesPorDefecto).toBe('430000');
    expect(res.body.data.cuentasIvaRepercutidoPorTipo['21']).toBe('477000');
  });

  it('PUT fusiona y guarda (upsert) la configuracion de la empresa', async () => {
    findUnique.mockResolvedValue(null); // obtenerReglas interno -> defaults
    upsert.mockResolvedValue({});
    const res = await request(app)
      .put('/companies/1/reglas-contables')
      .set(auth)
      .send({ cuentaVentasPorDefecto: '705000' });
    expect(res.status).toBe(200);
    expect(res.body.data.cuentaVentasPorDefecto).toBe('705000');
    // se mantiene el resto por merge con defaults
    expect(res.body.data.cuentaClientesPorDefecto).toBe('430000');
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('GET aplica las reglas guardadas sobre las por defecto', async () => {
    findUnique.mockResolvedValue({ companyId: '1', data: { cuentaClientesPorDefecto: '430001' } });
    const res = await request(app).get('/companies/1/reglas-contables').set(auth);
    expect(res.body.data.cuentaClientesPorDefecto).toBe('430001'); // guardada
    expect(res.body.data.cuentaVentasPorDefecto).toBe('700000'); // default
  });

  it('401 sin token', async () => {
    const res = await request(app).get('/companies/1/reglas-contables');
    expect(res.status).toBe(401);
  });
});
