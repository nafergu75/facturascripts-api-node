/**
 * Archivo de documentos de cierre (/accounting/closures) sobre BD real.
 *
 * Antes GET '/:ejercicio' iba antes que GET '/prior-years', que nunca se
 * alcanzaba (buscaba el cierre del ejercicio "prior-years"), y PATCH
 * ':ejercicio/status' aceptaba cualquier texto como estado.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import closuresRoutes from '../routes/accounting-closure.routes';
import { errorMiddleware } from '../middleware/error.middleware';

const COMPANY_ID = `closures-test-${Date.now()}`;
const ruta = `/companies/${COMPANY_ID}/accounting/closures`;

const app = express();
app.use(express.json());
app.use('/companies/:companyId', (req, _res, next) => {
  req.user = { userId: 'u-contable', roles: ['contable'], rolesPorEmpresa: { [COMPANY_ID]: ['contable'] } } as never;
  req.companyId = req.params.companyId;
  next();
});
app.use('/companies/:companyId/accounting/closures', closuresRoutes);
app.use(errorMiddleware);

beforeAll(async () => {
  await prisma.company.create({ data: { id: COMPANY_ID, name: 'Archivo Cierres SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.accountingClosure.create({ data: { companyId: COMPANY_ID, ejercicio: 2024 } });
  await prisma.priorYearData.create({ data: { companyId: COMPANY_ID, ejercicio: 2023, estado: 'CONFIRMADO' } });
});

describe('orden de las rutas', () => {
  it('GET /prior-years ya se alcanza y lista los ejercicios anteriores', async () => {
    const res = await request(app).get(`${ruta}/prior-years`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('2023');
  });

  it('GET /prior-years/2023 y GET /2024 siguen funcionando', async () => {
    expect((await request(app).get(`${ruta}/prior-years/2023`)).status).toBe(200);
    const res = await request(app).get(`${ruta}/2024`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('2024');
  });

  it('un ejercicio que no es un año es un 400 claro', async () => {
    const res = await request(app).get(`${ruta}/dos-mil`);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/no es un ejercicio válido/);
  });
});

describe('PATCH /:ejercicio/status', () => {
  it('rechaza un estado que no es del documento de cierre', async () => {
    const res = await request(app).patch(`${ruta}/2024/status`).send({ estado: 'LO_QUE_SEA' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Estado no válido/);
    expect((await prisma.accountingClosure.findFirstOrThrow({ where: { companyId: COMPANY_ID, ejercicio: 2024 } })).estado).toBe('ABIERTO');
  });

  it('acepta los de su lista (en minusculas tambien)', async () => {
    const res = await request(app).patch(`${ruta}/2024/status`).send({ estado: 'en_cierre' });
    expect(res.status).toBe(200);
    expect((await prisma.accountingClosure.findFirstOrThrow({ where: { companyId: COMPANY_ID, ejercicio: 2024 } })).estado).toBe('EN_CIERRE');
  });
});
