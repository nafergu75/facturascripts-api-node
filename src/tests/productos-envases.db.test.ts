/**
 * Datos de envase del articulo (plantilla A), sobre BD real: unidades por
 * pack, kg de plastico no reciclado por unidad, si lleva IEEPNR y el texto
 * adicional de la factura. Un dato no valido da 400 con el nombre del campo.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import productosRoutes from '../routes/productos.routes';
import { errorMiddleware } from '../middleware/error.middleware';

const EMPRESA = `productos-envases-${Date.now()}`;

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
  await prisma.company.create({ data: { id: EMPRESA, name: 'Productos Envases SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
});

describe('productos con datos de envase', () => {
  let id: string;

  it('sin datos de envase: null, null, false y null', async () => {
    const res = await request(app).post(base).send({ referencia: 'SERV1', descripcion: 'Servicio', precio: 10 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ unidadesPorPack: null, kgPlasticoUnidad: null, llevaIeepnr: false, textoFactura: null });
  });

  it('POST, GET y PUT con los cuatro campos', async () => {
    const res = await request(app)
      .post(base)
      .send({
        referencia: 'NAR15',
        descripcion: 'NARANJA CINTRA 1.5L P P6 P X',
        precio: 0.145,
        unidadesPorPack: 6,
        kgPlasticoUnidad: 0.026888,
        llevaIeepnr: true,
        textoFactura: 'Cod. RPA Azúcar: 6B30250\r\nUnidad 1,5 L Refrescos SR   ',
      });
    expect(res.status).toBe(201);
    id = res.body.data.id;
    expect(res.body.data).toMatchObject({ unidadesPorPack: 6, kgPlasticoUnidad: 0.026888, llevaIeepnr: true, textoFactura: 'Cod. RPA Azúcar: 6B30250\nUnidad 1,5 L Refrescos SR' });

    const leido = await request(app).get(`${base}/${id}`);
    expect(leido.body.data).toMatchObject({ unidadesPorPack: 6, kgPlasticoUnidad: 0.026888, llevaIeepnr: true });
    const lista = await request(app).get(`${base}?q=NAR15`);
    expect(lista.body.data.items ?? lista.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ referencia: 'NAR15', kgPlasticoUnidad: 0.026888 })]));

    // Con coma decimal; vaciar con null o ''.
    const cambio = await request(app).put(`${base}/${id}`).send({ kgPlasticoUnidad: '0,5', unidadesPorPack: '24', textoFactura: '' });
    expect(cambio.status).toBe(200);
    expect(cambio.body.data).toMatchObject({ kgPlasticoUnidad: 0.5, unidadesPorPack: 24, textoFactura: null, llevaIeepnr: true });
    const vacio = await request(app).put(`${base}/${id}`).send({ kgPlasticoUnidad: null, unidadesPorPack: '', llevaIeepnr: false });
    expect(vacio.body.data).toMatchObject({ kgPlasticoUnidad: null, unidadesPorPack: null, llevaIeepnr: false });
  });

  it('cada dato no válido da 400 con su campo y no se guarda', async () => {
    const casos: Array<[object, string]> = [
      [{ unidadesPorPack: 0 }, 'unidadesPorPack'],
      [{ unidadesPorPack: 100001 }, 'unidadesPorPack'],
      [{ unidadesPorPack: 2.5 }, 'unidadesPorPack'],
      [{ unidadesPorPack: 'seis' }, 'unidadesPorPack'],
      [{ kgPlasticoUnidad: -0.1 }, 'kgPlasticoUnidad'],
      [{ kgPlasticoUnidad: 1000.5 }, 'kgPlasticoUnidad'],
      [{ kgPlasticoUnidad: 0.0000001 }, 'kgPlasticoUnidad'],
      [{ kgPlasticoUnidad: '1.000,5' }, 'kgPlasticoUnidad'],
      [{ llevaIeepnr: 'si' }, 'llevaIeepnr'],
      [{ textoFactura: 'x'.repeat(501) }, 'textoFactura'],
      [{ textoFactura: '1\n2\n3\n4\n5\n6\n7' }, 'textoFactura'],
      [{ textoFactura: 7 }, 'textoFactura'],
    ];
    for (const [body, campo] of casos) {
      const res = await request(app).put(`${base}/${id}`).send(body);
      expect([JSON.stringify(body), res.status, res.body.details]).toEqual([JSON.stringify(body), 400, { campo }]);
    }
    // Los límites sí valen.
    const ok = await request(app).put(`${base}/${id}`).send({ unidadesPorPack: 100000, kgPlasticoUnidad: 1000, textoFactura: '1\n2\n3\n4\n5\n6' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ unidadesPorPack: 100000, kgPlasticoUnidad: 1000, textoFactura: '1\n2\n3\n4\n5\n6' });
    const fila = await prisma.product.findUniqueOrThrow({ where: { id } });
    expect([fila.unidadesPorPack, Number(fila.kgPlasticoUnidad)]).toEqual([100000, 1000]);
  });
});
