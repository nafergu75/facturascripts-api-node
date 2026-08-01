jest.mock('../config/database', () => ({ prisma: {}, connectDatabase: jest.fn(), disconnectDatabase: jest.fn() }));

import request from 'supertest';
import { app } from '../app';
import { authService } from '../services/auth.service';
import { renderizarFacturaConPlantilla } from '../services/facturas.service';
import { PlantillaDocumento } from '../domain/plantillas-documento.model';

const token = authService.generateToken({ userId: 'u1', email: 'u1@test.com', roles: ['admin'], companies: ['1'] });
const auth = { Authorization: `Bearer ${token}` };

describe('Plantillas de documentos', () => {
  it('crea plantilla y la marca predeterminada; la lista por tipo', async () => {
    const crear = await request(app)
      .post('/companies/1/plantillas')
      .set(auth)
      .send({ tipoDocumento: 'FACTURA', nombre: 'Factura estandar', predeterminada: true, secciones: [] });
    expect(crear.status).toBe(201);
    expect(crear.body.data.id).toBeDefined();

    const lista = await request(app).get('/companies/1/plantillas?tipo=FACTURA').set(auth);
    expect(lista.status).toBe(200);
    expect(lista.body.data.length).toBeGreaterThanOrEqual(1);

    const pred = await request(app).get('/companies/1/plantillas/tipo/FACTURA/predeterminada').set(auth);
    expect(pred.status).toBe(200);
    expect(pred.body.data.nombre).toBe('Factura estandar');
  });

  it('rechaza tipoDocumento invalido (400)', async () => {
    const res = await request(app).post('/companies/1/plantillas').set(auth).send({ tipoDocumento: 'X', nombre: 'x', secciones: [] });
    expect(res.status).toBe(400);
  });

  it('renderizarFacturaConPlantilla mapea campos por origen/pathOrigen', () => {
    const plantilla: PlantillaDocumento = {
      id: 'p1', companyId: '1', tipoDocumento: 'FACTURA', nombre: 'T', predeterminada: true, creadoEn: '', actualizadoEn: '',
      secciones: [
        { nombre: 'encabezado', campos: [
          { id: 'c1', tipo: 'texto', origen: 'empresa', pathOrigen: 'empresa.nombre', etiqueta: 'Empresa', visible: true, orden: 1 },
          { id: 'c2', tipo: 'texto', origen: 'cliente', pathOrigen: 'cliente.nif', etiqueta: 'NIF cliente', visible: true, orden: 2 },
        ] },
        { nombre: 'cuerpo', campos: [
          { id: 'l1', tipo: 'texto', origen: 'linea', pathOrigen: 'linea.descripcion', etiqueta: 'Descripcion', visible: true, orden: 1 },
          { id: 'l2', tipo: 'importe', origen: 'linea', pathOrigen: 'linea.total', etiqueta: 'Total', visible: true, orden: 2 },
        ] },
        { nombre: 'observaciones', campos: [
          { id: 'o1', tipo: 'texto', origen: 'fijo', valorFijo: 'Gracias por su compra', etiqueta: 'Nota', visible: true, orden: 1 },
        ] },
      ],
    };
    const out = renderizarFacturaConPlantilla(
      { lineas: [{ descripcion: 'Servicio', total: 121 }] },
      { nombre: 'Mi Empresa SL' },
      { nif: 'B12345678' },
      plantilla,
    );
    expect(out.encabezado['Empresa']).toBe('Mi Empresa SL');
    expect(out.encabezado['NIF cliente']).toBe('B12345678');
    expect(out.cuerpo.columnas).toEqual(['Descripcion', 'Total']);
    expect(out.cuerpo.lineas[0]).toEqual({ Descripcion: 'Servicio', Total: 121 });
    expect(out.observaciones).toEqual(['Gracias por su compra']);
  });
});

describe('Plan contable PGC-PYME', () => {
  it('GET /plan-contable/base/grupos (publico) devuelve grupos 1-7', async () => {
    const res = await request(app).get('/plan-contable/base/grupos');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(7);
  });

  it('crea subcuenta de empresa validando cuenta base', async () => {
    const ok = await request(app)
      .post('/companies/1/plan-contable/subcuentas')
      .set(auth)
      .send({ codigo: '4300001', nombre: 'Cliente X', cuentaBaseCodigo: '430' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.codigo).toBe('4300001');

    const malo = await request(app)
      .post('/companies/1/plan-contable/subcuentas')
      .set(auth)
      .send({ codigo: '9990001', nombre: 'Inventada', cuentaBaseCodigo: '999' });
    expect(malo.status).toBe(400);
  });
});
