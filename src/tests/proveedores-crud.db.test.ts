/**
 * Proveedores sobre BD real: NIF validado con utils/nif.ts, pais ISO-2 (o el
 * del prefijo del NIF-IVA), todos los campos guardados al editar, 409 en NIF
 * repetido y al borrar con facturas, historial de cada cambio, y busqueda y
 * paginacion en el servidor.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import { exigirPlanAnteriorAntesDeAlta } from '../services/terceros/planAnteriorAlta';
import proveedoresRoutes from '../routes/proveedores.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { controlCif } from '../utils/nif';

const E = `prov-crud-${Date.now()}`;
const cif = (siete: string) => `B${siete}${controlCif(siete).cifra}`;

function app(rol = 'contable') {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { userId: 'u-prov', email: 'compras@test.local', roles: [rol], companies: [E], rolesPorEmpresa: { [E]: [rol] } } as never;
    req.companyId = E;
    next();
  });
  a.use('/proveedores', proveedoresRoutes);
  a.use(errorMiddleware);
  return a;
}

beforeAll(async () => {
  await prisma.company.create({ data: { id: E, name: 'Proveedores SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  // Empresa nueva sin plan de la gestoria: se confirma de antemano el aviso del primer cliente o proveedor.
  await exigirPlanAnteriorAntesDeAlta(E, true, 'test');
});

describe('alta', () => {
  it('España con un NIF mal escrito: 400 con el motivo', async () => {
    const r = await request(app()).post('/proveedores').send({ nombreFiscal: 'Mal SL', nifCif: 'B12345678', pais: 'ES' });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('El dígito de control del CIF B12345678 no es correcto: revísalo.');
    expect(r.body.details).toEqual({ campo: 'nifCif' });
  });

  it('un NIF valido escrito con guiones se guarda normalizado, con todos sus datos', async () => {
    const nif = cif('1234567');
    const r = await request(app())
      .post('/proveedores')
      .send({ nombreFiscal: 'Bien SL', nifCif: `${nif[0].toLowerCase()}-${nif.slice(1, 8)}-${nif[8]}`, direccion: 'Calle Mayor 1', cp: '46001', municipio: 'Valencia', provincia: 'Valencia' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ nombreFiscal: 'Bien SL', nifCif: nif, pais: 'ES', direccion: 'Calle Mayor 1', cp: '46001', municipio: 'Valencia', provincia: 'Valencia', activo: true });
    expect(await prisma.supplierAudit.count({ where: { supplierId: r.body.data.id, tipoAccion: 'create' } })).toBe(1);
  });

  it('un NIF-IVA de Francia sin pais: pais FR', async () => {
    const r = await request(app()).post('/proveedores').send({ nombreFiscal: 'Fournisseur SARL', nifCif: 'FR12345678901' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ pais: 'FR', nifCif: 'FR12345678901' });
  });

  it('sin nombre: 400 (antes 404)', async () => {
    const r = await request(app()).post('/proveedores').send({ nifCif: cif('7777777') });
    expect(r.status).toBe(400);
    expect(r.body.details).toEqual({ campo: 'nombreFiscal' });
  });

  it('un codigo postal de otra provincia: 400', async () => {
    const r = await request(app()).post('/proveedores').send({ nombreFiscal: 'CP SL', nifCif: cif('7777778'), cp: '28001', provincia: 'Valencia' });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/es de Madrid, no de Valencia/);
  });
});

describe('NIF repetido', () => {
  it('409 con el proveedor que ya lo tiene, en el alta y al modificar', async () => {
    const nif = cif('2345678');
    const primero = await request(app()).post('/proveedores').send({ nombreFiscal: 'Primero SL', nifCif: nif });
    expect(primero.status).toBe(201);
    const otro = await request(app()).post('/proveedores').send({ nombreFiscal: 'Segundo SL', nifCif: nif });
    expect(otro.status).toBe(409);
    expect(otro.body.message).toBe('Ya existe un proveedor con ese NIF: Primero SL.');
    expect(otro.body.details).toEqual({ campo: 'nifCif', proveedorId: primero.body.data.id });

    const tercero = await request(app()).post('/proveedores').send({ nombreFiscal: 'Tercero SL', nifCif: cif('2345679') });
    const put = await request(app()).put(`/proveedores/${tercero.body.data.id}`).send({ nifCif: nif });
    expect(put.status).toBe(409);
    expect(put.body.details.proveedorId).toBe(primero.body.data.id);
  });
});

describe('modificar', () => {
  it('PATCH guarda direccion, provincia, municipio, CP y pais; un email vacio lo borra; un historial por campo', async () => {
    const alta = await request(app()).post('/proveedores').send({ nombreFiscal: 'Cambios SL', nifCif: cif('3456789'), email: 'antes@cambios.es' });
    const id = alta.body.data.id;
    const r = await request(app())
      .patch(`/proveedores/${id}`)
      .send({ direccion: 'Avenida del Puerto 3', provincia: 'Valencia', municipio: 'Valencia', cp: '46023', email: '' });
    expect(r.status).toBe(200);
    const get = await request(app()).get(`/proveedores/${id}`);
    expect(get.body.data).toMatchObject({ direccion: 'Avenida del Puerto 3', provincia: 'Valencia', municipio: 'Valencia', cp: '46023', email: '', pais: 'ES' });
    expect((await prisma.supplier.findUniqueOrThrow({ where: { id } })).email).toBeNull();
    const cambios = await prisma.supplierAudit.findMany({ where: { supplierId: id, tipoAccion: 'update' } });
    expect(cambios.map((c) => c.campo).sort()).toEqual(['cp', 'direccion', 'email', 'municipio', 'provincia']);
    expect(cambios.find((c) => c.campo === 'email')).toMatchObject({ valorAnterior: '"antes@cambios.es"', valorNuevo: null });

    // Cambiar el pais a Portugal: su NIF ya no se valida como español.
    const pt = await request(app()).patch(`/proveedores/${id}`).send({ pais: 'PT', nifCif: 'PT123456789', cp: '1000-001', provincia: 'Lisboa' });
    expect(pt.status).toBe(200);
    expect(pt.body.data).toMatchObject({ pais: 'PT', nifCif: 'PT123456789' });
    // Y desactivarlo.
    expect((await request(app()).patch(`/proveedores/${id}`).send({ activo: false })).body.data.activo).toBe(false);
  });

  it('un usuario de ventas lee pero no modifica', async () => {
    const lista = await request(app('ventas')).get('/proveedores');
    expect(lista.status).toBe(200);
    expect((await request(app('ventas')).post('/proveedores').send({ nombreFiscal: 'X', nifCif: cif('9999990') })).status).toBe(403);
  });
});

describe('borrar', () => {
  it('con facturas: 409 con cuantas; sin facturas: 200 y queda en el historial', async () => {
    const con = await request(app()).post('/proveedores').send({ nombreFiscal: 'Con Facturas SL', nifCif: cif('4567890') });
    await prisma.expenseInvoice.create({
      data: { companyId: E, supplierId: con.body.data.id, serie: 'P', numero: 1, numeroCompleto: 'P-1', fechaEmision: '2026-01-01', fechaVencimiento: '2026-01-31', estado: 'PENDING' },
    });
    const r = await request(app()).delete(`/proveedores/${con.body.data.id}`);
    expect(r.status).toBe(409);
    expect(r.body.message).toBe('No se puede borrar: tiene 1 factura(s). Puedes desactivarlo para que no salga al registrar gastos.');
    expect(r.body.details).toEqual({ facturas: 1 });

    const sin = await request(app()).post('/proveedores').send({ nombreFiscal: 'Sin Facturas SL', nifCif: cif('5678901') });
    const ok = await request(app()).delete(`/proveedores/${sin.body.data.id}`);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ message: 'Proveedor eliminado' });
    expect(await prisma.supplier.count({ where: { id: sin.body.data.id } })).toBe(0);
    expect(await prisma.supplierAudit.count({ where: { supplierId: sin.body.data.id, tipoAccion: 'delete' } })).toBe(1);
  });
});

describe('busqueda y paginacion en el servidor', () => {
  it('encuentra uno creado despues de 120 proveedores, y por NIF', async () => {
    await prisma.supplier.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({ companyId: E, nombreFiscal: `Relleno ${String(i).padStart(3, '0')} SL`, nifCif: `X${String(i).padStart(7, '0')}Z` })),
    });
    const nif = cif('6789012');
    const ultimo = await request(app()).post('/proveedores').send({ nombreFiscal: 'Zapatería Última SL', nifCif: nif });
    const r = await request(app()).get('/proveedores?q=Zapater');
    expect(r.body.data.items.map((p: { id: string }) => p.id)).toEqual([ultimo.body.data.id]);
    const pagina = await request(app()).get('/proveedores?page=2&limit=50');
    expect(pagina.body.data).toMatchObject({ limit: 50, offset: 50, page: 2 });
    expect(pagina.body.data.items).toHaveLength(50);
    expect(pagina.body.data.total).toBeGreaterThan(120);

    const porNif = await request(app()).get(`/proveedores/por-nif/${nif.toLowerCase()}`);
    expect(porNif.status).toBe(200);
    expect(porNif.body.data.id).toBe(ultimo.body.data.id);
    const no = await request(app()).get(`/proveedores/por-nif/${cif('6789013')}`);
    expect(no.status).toBe(404);
    expect(no.body.message).toBe('No hay ningún proveedor con ese NIF.');
  });

  it('la pestaña Facturas lleva el numero del proveedor, el estado de pago y lo pendiente', async () => {
    const p = await prisma.supplier.findFirstOrThrow({ where: { companyId: E, nombreFiscal: 'Con Facturas SL' } });
    const r = await request(app()).get(`/proveedores/${p.id}/invoices`);
    expect(r.status).toBe(200);
    expect(r.body.data[0]).toMatchObject({ numeroCompleto: 'P-1', estadoTexto: 'Sin contabilizar', estadoPago: 'PENDIENTE', vencida: true, estadoPagoTexto: 'Vencida', importePendiente: 0 });
  });
});
