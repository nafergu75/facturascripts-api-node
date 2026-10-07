/**
 * Alta de ejercicios (POST /companies/:id/fiscal-years) sobre BD real.
 *
 * Antes se aceptaba cualquier label y cualquier fecha, pero comprobarFechaAbierta
 * y el cierre buscan el ejercicio por su año (label = "2026"): un "Ejercicio
 * 2026" se quedaba sin proteger. Y dos altas a la vez daban un 500 (P2002).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import fiscalYearsRoutes from '../routes/fiscalYears.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { anioDelEjercicio } from '../services/fiscalYears.service';

const COMPANY_ID = `ejercicios-test-${Date.now()}`;

const app = express();
app.use(express.json());
app.use('/companies/:companyId', (req, _res, next) => {
  req.user = { userId: 'u-contable', roles: ['contable'], rolesPorEmpresa: { [COMPANY_ID]: ['contable'] } } as never;
  req.companyId = req.params.companyId;
  next();
});
app.use('/companies/:companyId/fiscal-years', fiscalYearsRoutes);
app.use(errorMiddleware);

const crear = (body: object) => request(app).post(`/companies/${COMPANY_ID}/fiscal-years`).send(body);

beforeAll(async () => {
  await prisma.company.create({ data: { id: COMPANY_ID, name: 'Ejercicios Test SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  // Un ejercicio antiguo con otro nombre (de antes de esta validacion).
  await prisma.fiscalYear.create({ data: { companyId: COMPANY_ID, label: 'Ejercicio 2020', fechaInicio: '2020-01-01', fechaFin: '2020-12-31' } });
});

describe('crear ejercicio', () => {
  it('con {anio}: año natural, abierto, label = año', async () => {
    const res = await crear({ anio: 2024 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ label: '2024', fechaInicio: '2024-01-01', fechaFin: '2024-12-31', estado: 'OPEN' });
  });

  it('con el cuerpo antiguo {label, fechaInicio, fechaFin} de Registro Mercantil', async () => {
    const res = await crear({ label: '2023', fechaInicio: '2023-01-01', fechaFin: '2023-12-31' });
    expect(res.status).toBe(201);
    expect(res.body.data.label).toBe('2023');
  });

  it('un duplicado da 409 "Ya existe el ejercicio"', async () => {
    const res = await crear({ anio: 2024 });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Ya existe el ejercicio 2024.');
  });

  it('dos altas a la vez del mismo año: una 201 y otra 409 (nunca 500)', async () => {
    const [a, b] = await Promise.all([crear({ anio: 2025 }), crear({ anio: 2025 })]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await prisma.fiscalYear.count({ where: { companyId: COMPANY_ID, label: '2025' } })).toBe(1);
  });

  it('un label que no es un año se rechaza (400, campo label)', async () => {
    const res = await crear({ label: 'Ejercicio 2026', fechaInicio: '2026-01-01', fechaFin: '2026-12-31' });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual({ campo: 'label' });
  });

  it('fechas que no son el año natural se rechazan', async () => {
    const res = await crear({ label: '2022', fechaInicio: '2022-07-01', fechaFin: '2023-06-30' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/del 1 de enero al 31 de diciembre/);
    expect((await crear({ label: '2022', fechaInicio: '2022-02-30', fechaFin: '2022-12-31' })).status).toBe(400);
    expect((await crear({ label: '2022', fechaInicio: '2022-12-31', fechaFin: '2022-01-01' })).status).toBe(400);
    expect(await prisma.fiscalYear.count({ where: { companyId: COMPANY_ID, label: '2022' } })).toBe(0);
  });

  it('se solapa con un ejercicio antiguo de otro nombre: 409', async () => {
    const res = await crear({ anio: 2020 });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/se solapa con el ejercicio "Ejercicio 2020"/);
  });

  it('sin año o fuera de rango: 400', async () => {
    expect((await crear({})).status).toBe(400);
    expect((await crear({ anio: 1989 })).status).toBe(400);
    expect((await crear({ anio: 'dos mil' })).status).toBe(400);
  });
});

describe('anioDelEjercicio (validacion pura)', () => {
  it('admite del 1990 al año siguiente al actual', () => {
    expect(anioDelEjercicio({ anio: 1990 }, 2026)).toBe(1990);
    expect(anioDelEjercicio({ anio: '2027' }, 2026)).toBe(2027);
    expect(() => anioDelEjercicio({ anio: 2028 }, 2026)).toThrow(/entre 1990 y 2027/);
  });

  it('anio y label tienen que coincidir', () => {
    expect(() => anioDelEjercicio({ anio: 2026, label: '2025' }, 2026)).toThrow(/tiene que ser su año/);
  });
});
