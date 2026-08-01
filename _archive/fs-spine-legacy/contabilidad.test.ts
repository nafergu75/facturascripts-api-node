import request from 'supertest';
import { app } from '../app';

describe('Contabilidad (wiring)', () => {
  it('GET /companies/1/contabilidad sin token responde 401', async () => {
    const res = await request(app).get('/companies/1/contabilidad');
    expect(res.status).toBe(401);
  });
});
