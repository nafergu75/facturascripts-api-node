/**
 * Datos de ceramica del articulo (plantilla B), sobre BD real: formato, m2 y
 * piezas por caja, unidad del precio por defecto y kg por esa unidad. Un dato
 * no valido da 400 con el nombre del campo.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import productosRoutes from '../routes/productos.routes';
import { errorMiddleware } from '../middleware/error.middleware';

const EMPRESA = `productos-ceramica-${Date.now()}`;

const app = express();
app.use(express.json());
app.use('/companies/:companyId', (req, _res, next) => {
  req.user = { userId: 'u-admin', roles: ['admin'], rolesPorEmpresa: { [req.params.companyId]: ['admin'] } } as never;
  req.companyId = req.params.companyId;
  next();
});
app.use('/companies/:companyId/productos', productosRoutes);
app.use(errorMiddleware);

const base = `/companies/${EMPRESA}/productos`;

beforeAll(async () => {
  await prisma.company.create({ data: { id: EMPRESA, name: 'Productos Ceramica SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
});

describe('productos con datos de ceramica', () => {
  let id: string;

  it('sin datos de ceramica: todo a null', async () => {
    const res = await request(app).post(base).send({ referencia: 'SERV1', descripcion: 'Servicio', precio: 10 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ formato: null, metros2PorCaja: null, piezasPorCaja: null, unidadPrecio: null, pesoKgPorUnidad: null });
  });

  it('POST, GET y PUT con los cinco campos (con coma decimal y la unidad en minusculas)', async () => {
    const res = await request(app).post(base).send({
      referencia: 'MOGAN',
      descripcion: 'MOGAN NATURAL',
      precio: 12.25,
      textoFactura: 'PORCELANICO RECTIFICADO',
      formato: ' 23,3x120 ',
      metros2PorCaja: '1,68',
      piezasPorCaja: 6,
      unidadPrecio: 'm2',
      pesoKgPorUnidad: 22.5,
    });
    expect(res.status).toBe(201);
    id = res.body.data.id;
    expect(res.body.data).toMatchObject({ formato: '23,3x120', metros2PorCaja: 1.68, piezasPorCaja: 6, unidadPrecio: 'M2', pesoKgPorUnidad: 22.5, textoFactura: 'PORCELANICO RECTIFICADO' });
    expect((await request(app).get(`${base}/${id}`)).body.data).toMatchObject({ formato: '23,3x120', metros2PorCaja: 1.68, unidadPrecio: 'M2' });
    const cambio = await request(app).put(`${base}/${id}`).send({ unidadPrecio: 'PIEZA', metros2PorCaja: null, formato: '' });
    expect(cambio.body.data).toMatchObject({ unidadPrecio: 'PIEZA', metros2PorCaja: null, formato: null, piezasPorCaja: 6, pesoKgPorUnidad: 22.5 });
  });

  it('valores no validos: 400 con su campo y nada guardado', async () => {
    const casos: Array<[Record<string, unknown>, string]> = [
      [{ formato: 'x'.repeat(41) }, 'formato'],
      [{ formato: 7 }, 'formato'],
      [{ metros2PorCaja: 0 }, 'metros2PorCaja'],
      [{ metros2PorCaja: '1,23456' }, 'metros2PorCaja'],
      [{ metros2PorCaja: 'mucho' }, 'metros2PorCaja'],
      [{ piezasPorCaja: 2.5 }, 'piezasPorCaja'],
      [{ piezasPorCaja: 0 }, 'piezasPorCaja'],
      [{ unidadPrecio: 'CAJA' }, 'unidadPrecio'],
      [{ pesoKgPorUnidad: -1 }, 'pesoKgPorUnidad'],
      [{ pesoKgPorUnidad: 1.23456 }, 'pesoKgPorUnidad'],
    ];
    for (const [cuerpo, campo] of casos) {
      const res = await request(app).put(`${base}/${id}`).send(cuerpo);
      expect([res.status, res.body.details?.campo]).toEqual([400, campo]);
    }
    expect((await request(app).get(`${base}/${id}`)).body.data).toMatchObject({ formato: null, piezasPorCaja: 6, unidadPrecio: 'PIEZA', pesoKgPorUnidad: 22.5 });
  });
});
