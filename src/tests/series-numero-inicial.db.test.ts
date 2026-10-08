/**
 * Series de numeración en Configuración, sobre BD real: número inicial (para
 * seguir la numeración de otro programa), próximo número y documentos.
 *
 *  - numeroInicial=46 en una serie sin documentos: la primera factura es la 46.
 *  - Con documentos numerados, el número inicial ya no se cambia (409).
 *  - GET /series trae numeroSiguiente y documentos.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import seriesRoutes from '../routes/series.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { incomeInvoicesService } from '../services/income-invoices.service';

const COMPANY_ID = `series-inicial-${Date.now()}`;
let customerId: string;

const app = express();
app.use(express.json());
app.use('/companies/:companyId', (req, _res, next) => {
  req.user = { userId: 'u-ventas', roles: ['ventas'], rolesPorEmpresa: { [COMPANY_ID]: ['ventas'] } } as never;
  req.companyId = req.params.companyId;
  next();
});
app.use('/companies/:companyId/series', seriesRoutes);
app.use(errorMiddleware);

const ruta = `/companies/${COMPANY_ID}/series`;
const listar = async () => (await request(app).get(ruta)).body.data as Array<{ id: string; codigo: string; numeroSiguiente: number; documentos: number; descripcion: string }>;
const deCodigo = async (codigo: string) => (await listar()).find((s) => s.codigo === codigo)!;
const linea = { descripcion: 'Servicio', cantidad: 1, precioUnitario: 100, tipoIva: 21 };
const emitir = (serie: string, fechaEmision = '2026-02-02') =>
  incomeInvoicesService.crearIngreso({ companyId: COMPANY_ID, customer: { id: customerId }, serie, fechaEmision, lineas: [linea] });

beforeAll(async () => {
  await prisma.company.create({ data: { id: COMPANY_ID, name: 'Series Inicial SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: COMPANY_ID, denominacion: 'Series Inicial SL', nif: 'B11000000' } });
  customerId = (await prisma.customer.create({ data: { companyId: COMPANY_ID, nombreFiscal: 'Cliente Inicial SL', nifCif: 'B12000000' } })).id;
});

describe('GET /series', () => {
  it('cada serie con su próximo número y sus documentos', async () => {
    const a = await deCodigo('A');
    expect(a).toMatchObject({ numeroSiguiente: 1, documentos: 0 });
  });
});

describe('número inicial', () => {
  it('al crear: numeroInicial=46 hace que la primera factura sea la B-46', async () => {
    const res = await request(app).post(ruta).send({ codigo: 'B', descripcion: 'Serie B', tipoDocumento: 'FACTURA', numeroInicial: 46 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ codigo: 'B', ultimoNumero: 45 });
    expect((await deCodigo('B')).numeroSiguiente).toBe(46);
    const f = await emitir('B');
    expect(f.numeroCompleto).toBe('B-46');
    expect(await deCodigo('B')).toMatchObject({ numeroSiguiente: 47, documentos: 1 });
  });

  it('al editar una serie sin documentos: la siguiente factura lleva ese número', async () => {
    const a = await deCodigo('A');
    const res = await request(app).put(`${ruta}/${a.id}`).send({ numeroInicial: 46, descripcion: 'Serie general (sigue la del programa anterior)' });
    expect(res.status).toBe(200);
    expect(res.body.data.descripcion).toBe('Serie general (sigue la del programa anterior)');
    expect((await emitir('A')).numeroCompleto).toBe('A-46');
  });

  it('con documentos numerados ya no se cambia (409, campo numeroInicial)', async () => {
    const a = await deCodigo('A');
    const res = await request(app).put(`${ruta}/${a.id}`).send({ numeroInicial: 100 });
    expect([res.status, res.body.details]).toEqual([409, { campo: 'numeroInicial' }]);
    expect((await deCodigo('A')).numeroSiguiente).toBe(47);
  });

  it('un borrador no cuenta: la serie sigue sin documentos numerados', async () => {
    await request(app).post(ruta).send({ codigo: 'C', descripcion: 'Serie C', tipoDocumento: 'FACTURA' });
    await incomeInvoicesService.crearIngreso({ companyId: COMPANY_ID, customer: { id: customerId }, serie: 'C', lineas: [linea], borrador: true });
    const c = await deCodigo('C');
    expect(c.documentos).toBe(0);
    expect((await request(app).put(`${ruta}/${c.id}`).send({ numeroInicial: 10 })).status).toBe(200);
  });

  it('tiene que ser un entero desde 1', async () => {
    const a = await deCodigo('C');
    for (const numeroInicial of [0, -3, 1.5, 'abc', 1_000_000_000]) {
      const res = await request(app).put(`${ruta}/${a.id}`).send({ numeroInicial });
      expect([res.status, res.body.details]).toEqual([400, { campo: 'numeroInicial' }]);
    }
    const alta = await request(app).post(ruta).send({ codigo: 'D', tipoDocumento: 'FACTURA', numeroInicial: 0 });
    expect([alta.status, alta.body.details]).toEqual([400, { campo: 'numeroInicial' }]);
    expect(await prisma.invoiceSeries.count({ where: { companyId: COMPANY_ID, codigo: 'D' } })).toBe(0);
  });
});
