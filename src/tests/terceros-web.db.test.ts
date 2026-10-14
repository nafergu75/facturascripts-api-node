/**
 * Web de proveedores y clientes sobre BD real (peticion del usuario del
 * 14-10-2026: «En el alta de los proveedores falta una casilla para la web»).
 *
 *  - Se acepta y se devuelve en el alta, la modificacion, la ficha, el
 *    listado y la busqueda por NIF, tambien en el alta desde los lectores
 *    (AvisoTerceroNuevo usa los mismos POST /proveedores y /clientes).
 *  - Se guarda sin espacios y con https:// si no lo lleva. Un texto que no es
 *    una web da 400 con el campo `web` y no guarda nada. Vacia = sin web.
 *  - El cambio de web de un proveedor queda en su historial; sale en su
 *    exportacion; y la carga de la gestoria la pone en las fichas nuevas.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import { exigirPlanAnteriorAntesDeAlta } from '../services/terceros/planAnteriorAlta';
import { asegurarPlanContableEmpresa } from '../services/chart-of-accounts.service';
import { confirmarPlan } from '../services/puestaEnMarcha/planAnterior';
import proveedoresRoutes from '../routes/proveedores.routes';
import clientesRoutes from '../routes/clientes.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { controlCif } from '../utils/nif';

const BASE = `web-terceros-${Date.now()}`;
const cif = (siete: string) => `B${siete}${controlCif(siete).cifra}`;

function app(companyId: string) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { userId: 'u-web', email: 'web@test.local', roles: ['admin'], companies: [companyId], rolesPorEmpresa: { [companyId]: ['admin'] } } as never;
    req.companyId = companyId;
    next();
  });
  a.use('/proveedores', proveedoresRoutes);
  a.use('/clientes', clientesRoutes);
  a.use(errorMiddleware);
  return a;
}

let n = 0;
async function empresa(): Promise<string> {
  const id = `${BASE}-${++n}`;
  await prisma.company.create({ data: { id, name: `Web ${n}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: id, denominacion: `Web ${n} SL`, nif: 'B10000000' } });
  // Sin el plan de la gestoria: se confirma de antemano el aviso del primer cliente o proveedor.
  await exigirPlanAnteriorAntesDeAlta(id, true, 'test');
  return id;
}

const NO_VALIDA = 'La web no es válida. Escríbela como www.empresa.com o https://empresa.com.';

describe('proveedores', () => {
  let E: string;
  beforeAll(async () => {
    E = await empresa();
  });

  it('alta con la web sin https:// y con espacios: se guarda limpia y sale en la ficha, el listado y la búsqueda por NIF', async () => {
    const nif = cif('5101010');
    const r = await request(app(E)).post('/proveedores').send({ nombreFiscal: 'Web Proveedor SL', nifCif: nif, web: '  www.webproveedor.es ' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ nifCif: nif, web: 'https://www.webproveedor.es' });
    expect((await prisma.supplier.findUniqueOrThrow({ where: { id: r.body.data.id } })).web).toBe('https://www.webproveedor.es');

    const ficha = await request(app(E)).get(`/proveedores/${r.body.data.id}`);
    expect(ficha.body.data.web).toBe('https://www.webproveedor.es');
    const lista = await request(app(E)).get('/proveedores').query({ q: 'Web Proveedor' });
    expect(lista.body.data.items).toEqual([expect.objectContaining({ id: r.body.data.id, web: 'https://www.webproveedor.es' })]);
    const porNif = await request(app(E)).get(`/proveedores/por-nif/${nif}`);
    expect(porNif.body.data.web).toBe('https://www.webproveedor.es');
  });

  it('alta sin web: la ficha la devuelve vacía', async () => {
    const r = await request(app(E)).post('/proveedores').send({ nombreFiscal: 'Sin Web SL', nifCif: cif('5101011') });
    expect(r.status).toBe(201);
    expect(r.body.data.web).toBe('');
    expect((await prisma.supplier.findUniqueOrThrow({ where: { id: r.body.data.id } })).web).toBeNull();
  });

  it('alta con un texto que no es una web: 400 con el campo y no se da de alta', async () => {
    const nif = cif('5101012');
    const r = await request(app(E)).post('/proveedores').send({ nombreFiscal: 'Web Mala SL', nifCif: nif, web: 'mi empresa' });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('Falta la terminación de la web (.com, .es...). Escríbela completa, por ejemplo www.empresa.com.');
    expect(r.body.details).toEqual({ campo: 'web' });
    expect(await prisma.supplier.count({ where: { companyId: E, nifCif: nif } })).toBe(0);
  });

  it('modificar: se cambia (con su historial), un texto malo da 400 sin tocarla y vacía se borra', async () => {
    const alta = await request(app(E)).post('/proveedores').send({ nombreFiscal: 'Cambia Web SL', nifCif: cif('5101013'), web: 'cambiaweb.es' });
    const id = alta.body.data.id as string;

    const cambio = await request(app(E)).patch(`/proveedores/${id}`).send({ web: 'HTTP://Tienda.CambiaWeb.es/ofertas' });
    expect(cambio.status).toBe(200);
    expect(cambio.body.data.web).toBe('http://Tienda.CambiaWeb.es/ofertas');
    const historial = await prisma.supplierAudit.findFirstOrThrow({ where: { supplierId: id, tipoAccion: 'update', campo: 'web' } });
    expect(historial).toMatchObject({ valorAnterior: JSON.stringify('https://cambiaweb.es'), valorNuevo: JSON.stringify('http://Tienda.CambiaWeb.es/ofertas') });

    const mala = await request(app(E)).patch(`/proveedores/${id}`).send({ web: 'facturas@cambiaweb.es', telefono: '960000000' });
    expect(mala.status).toBe(400);
    expect(mala.body.message).toMatch(/^Eso parece un correo electrónico: va en el campo del email/);
    expect(mala.body.details).toEqual({ campo: 'web' });
    expect(await prisma.supplier.findUniqueOrThrow({ where: { id } })).toMatchObject({ web: 'http://Tienda.CambiaWeb.es/ofertas', telefono: null });

    // Guardar la ficha sin tocar la web no la reescribe ni deja historial.
    const igual = await request(app(E)).patch(`/proveedores/${id}`).send({ web: 'http://Tienda.CambiaWeb.es/ofertas' });
    expect(igual.status).toBe(200);
    expect(await prisma.supplierAudit.count({ where: { supplierId: id, campo: 'web' } })).toBe(1);

    const borrar = await request(app(E)).patch(`/proveedores/${id}`).send({ web: '  ' });
    expect(borrar.status).toBe(200);
    expect(borrar.body.data.web).toBe('');
    expect((await prisma.supplier.findUniqueOrThrow({ where: { id } })).web).toBeNull();
  });

  it('una web larga (hasta 255) se cambia sin error y su historial guarda el valor recortado con «…»', async () => {
    const alta = await request(app(E)).post('/proveedores').send({ nombreFiscal: 'Web Larga SL', nifCif: cif('5101016'), web: 'weblarga.es' });
    const id = alta.body.data.id as string;
    // 255 con el https:// delante: no cabe tal cual en el historial (VARCHAR(191)).
    const larga = `https://weblarga.es/${'catalogo-'.repeat(27)}`.slice(0, 255);
    expect(larga).toHaveLength(255);

    const cambio = await request(app(E)).patch(`/proveedores/${id}`).send({ web: larga, telefono: '960000002' });
    expect(cambio.status).toBe(200);
    expect(cambio.body.data.web).toBe(larga);
    expect((await prisma.supplier.findUniqueOrThrow({ where: { id } })).web).toBe(larga);

    // Los dos cambios quedan en el historial; el de la web, recortado y en JSON válido.
    const web = await prisma.supplierAudit.findFirstOrThrow({ where: { supplierId: id, tipoAccion: 'update', campo: 'web' } });
    expect(web.valorAnterior).toBe(JSON.stringify('https://weblarga.es'));
    expect(web.valorNuevo!.length).toBeLessThanOrEqual(191);
    const recortado = JSON.parse(web.valorNuevo!) as string;
    expect(recortado.endsWith('…')).toBe(true);
    expect(larga.startsWith(recortado.slice(0, -1))).toBe(true);
    expect(await prisma.supplierAudit.count({ where: { supplierId: id, tipoAccion: 'update', campo: 'telefono' } })).toBe(1);

    // Y al revés: de la larga a otra, el valor anterior también se recorta.
    const vuelta = await request(app(E)).patch(`/proveedores/${id}`).send({ web: 'weblarga.es' });
    expect(vuelta.status).toBe(200);
    const ultimo = await prisma.supplierAudit.findFirstOrThrow({ where: { supplierId: id, campo: 'web' }, orderBy: { createdAt: 'desc' } });
    expect(JSON.parse(ultimo.valorAnterior!)).toMatch(/^https:\/\/weblarga\.es\/catalogo-.*…$/);
    expect(ultimo.valorNuevo).toBe(JSON.stringify('https://weblarga.es'));
  });

  it('la exportación del proveedor (CSV y JSON) lleva la web', async () => {
    const alta = await request(app(E)).post('/proveedores').send({ nombreFiscal: 'Exporta Web SL', nifCif: cif('5101014'), web: 'www.exportaweb.es' });
    const csv = await request(app(E)).get(`/proveedores/${alta.body.data.id}/export`).query({ formato: 'csv' });
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Web: https://www.exportaweb.es');
    const sinWeb = await request(app(E)).post('/proveedores').send({ nombreFiscal: 'Exporta Sin Web SL', nifCif: cif('5101015') });
    expect((await request(app(E)).get(`/proveedores/${sinWeb.body.data.id}/export`).query({ formato: 'csv' })).text).toContain('Web: -');
    const json = await request(app(E)).get(`/proveedores/${alta.body.data.id}/export`).query({ formato: 'json' });
    expect(JSON.parse(json.text).supplier.web).toBe('https://www.exportaweb.es');
  });
});

describe('clientes', () => {
  let E: string;
  beforeAll(async () => {
    E = await empresa();
  });

  it('alta con la web: se guarda con https:// y sale en la ficha y en el listado', async () => {
    const r = await request(app(E)).post('/clientes').send({ nombreFiscal: 'Web Cliente SL', nifCif: cif('5202020'), web: 'webcliente.com/es ' });
    expect(r.status).toBe(201);
    expect(r.body.data.web).toBe('https://webcliente.com/es');
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: r.body.data.id } })).web).toBe('https://webcliente.com/es');
    const ficha = await request(app(E)).get(`/clientes/${r.body.data.id}`);
    expect(ficha.body.data.web).toBe('https://webcliente.com/es');
    const lista = await request(app(E)).get('/clientes');
    expect(lista.body.data.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: r.body.data.id, web: 'https://webcliente.com/es' })]));
  });

  it('alta con una web que no lo es: 400 con el campo, antes de mirar el NIF, y no se da de alta', async () => {
    const nif = cif('5202021');
    const r = await request(app(E)).post('/clientes').send({ nombreFiscal: 'Mala Web SL', nifCif: nif, web: 'javascript:alert(1)' });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('La web tiene que empezar por http:// o https://, o escríbela sin nada delante: www.empresa.com.');
    expect(r.body.details).toEqual({ campo: 'web' });
    expect(await prisma.customer.count({ where: { companyId: E, nifCif: nif } })).toBe(0);
  });

  it('modificar: se cambia, una mala da 400 sin tocar nada y vacía se borra; sin web, no se toca', async () => {
    const alta = await request(app(E)).post('/clientes').send({ nombreFiscal: 'Cambia Cliente SL', nifCif: cif('5202022') });
    const id = alta.body.data.id as string;
    expect(alta.body.data.web).toBe('');

    const cambio = await request(app(E)).put(`/clientes/${id}`).send({ web: 'www.cambiacliente.es' });
    expect(cambio.status).toBe(200);
    expect(cambio.body.data.web).toBe('https://www.cambiacliente.es');

    const mala = await request(app(E)).put(`/clientes/${id}`).send({ web: '192.168.1.1', telefono: '960000000' });
    expect(mala.status).toBe(400);
    expect(mala.body.message).toBe(NO_VALIDA);
    expect(mala.body.details).toEqual({ campo: 'web' });
    expect(await prisma.customer.findUniqueOrThrow({ where: { id } })).toMatchObject({ web: 'https://www.cambiacliente.es', telefono: null });

    const otraCosa = await request(app(E)).put(`/clientes/${id}`).send({ telefono: '960000001' });
    expect(otraCosa.body.data).toMatchObject({ telefono: '960000001', web: 'https://www.cambiacliente.es' });

    const borrar = await request(app(E)).put(`/clientes/${id}`).send({ web: '' });
    expect(borrar.status).toBe(200);
    expect(borrar.body.data.web).toBe('');
    expect((await prisma.customer.findUniqueOrThrow({ where: { id } })).web).toBeNull();
  });
});

describe('email de clientes y proveedores (lo que manda la ficha al guardar)', () => {
  let E: string;
  beforeAll(async () => {
    E = await empresa();
  });

  it('cliente: guardar la ficha con el email vacío lo deja sin email (null, no «»), y con espacios se limpia', async () => {
    const alta = await request(app(E)).post('/clientes').send({ nombreFiscal: 'Email Vacio SL', nifCif: cif('5606060'), email: '  ', telefono: '' });
    expect(alta.status).toBe(201);
    const id = alta.body.data.id as string;
    expect(await prisma.customer.findUniqueOrThrow({ where: { id } })).toMatchObject({ email: null, telefono: null });

    // La ficha manda todo, también el email y el teléfono vacíos, aunque solo cambie la moneda.
    const guardar = await request(app(E)).put(`/clientes/${id}`).send({ pais: 'ES', email: '', telefono: '', web: '', monedaPreferida: 'USD' });
    expect(guardar.status).toBe(200);
    expect(await prisma.customer.findUniqueOrThrow({ where: { id } })).toMatchObject({ email: null, telefono: null, web: null, monedaPreferida: 'USD' });

    const conEmail = await request(app(E)).put(`/clientes/${id}`).send({ email: '  pagos@emailvacio.es ' });
    expect(conEmail.body.data.email).toBe('pagos@emailvacio.es');
  });

  it('cliente: un email mal escrito o que no cabe da 400 con el campo y no guarda nada', async () => {
    const nif = cif('5606061');
    const mala = await request(app(E)).post('/clientes').send({ nombreFiscal: 'Email Malo SL', nifCif: nif, email: 'pagos.emailmalo.es' });
    expect(mala.status).toBe(400);
    expect(mala.body.message).toBe('El email no es válido. Escríbelo como nombre@empresa.com.');
    expect(mala.body.details).toEqual({ campo: 'email' });
    expect(await prisma.customer.count({ where: { companyId: E, nifCif: nif } })).toBe(0);

    const alta = await request(app(E)).post('/clientes').send({ nombreFiscal: 'Email Largo SL', nifCif: nif, email: 'pagos@emaillargo.es' });
    const largo = `${'a'.repeat(180)}@emaillargo.es`;
    const r = await request(app(E)).put(`/clientes/${alta.body.data.id}`).send({ email: largo, telefono: '960000003' });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('El email es demasiado largo (191 caracteres como mucho).');
    expect(r.body.details).toEqual({ campo: 'email' });
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: alta.body.data.id } })).toMatchObject({ email: 'pagos@emaillargo.es', telefono: null });
  });

  it('proveedor: un email que no cabe da 400 con el campo (antes, 500)', async () => {
    const r = await request(app(E)).post('/proveedores').send({ nombreFiscal: 'Email Largo Prov SL', nifCif: cif('5606062'), email: `${'b'.repeat(180)}@emaillargo.es` });
    expect(r.status).toBe(400);
    expect(r.body.details).toEqual({ campo: 'email' });
  });
});

describe('alta desde los lectores (AvisoTerceroNuevo)', () => {
  // Lo que manda la ventana «Dar de alta»: lo leido corregido, mas el correo, el telefono y la web que se escriban.
  const ficha = (nif: string) => ({
    nombreFiscal: 'Suministros Turia SL',
    nifCif: nif,
    pais: 'ES',
    direccion: 'Calle de Colón 12, 3º',
    cp: '46004',
    municipio: 'València',
    provincia: 'Valencia',
    email: 'facturas@turia.example',
    telefono: '+34 961 234 567',
    web: 'www.turia.example',
  });

  it('el proveedor y el cliente se dan de alta con su web', async () => {
    const E = await empresa();
    const p = await request(app(E)).post('/proveedores').send(ficha(cif('5303030')));
    expect(p.status).toBe(201);
    expect(p.body.data).toMatchObject({ ...ficha(cif('5303030')), web: 'https://www.turia.example', subcuenta400: expect.stringMatching(/^400\d+$/) });
    const c = await request(app(E)).post('/clientes').send(ficha(cif('5303031')));
    expect(c.status).toBe(201);
    expect(c.body.data).toMatchObject({ ...ficha(cif('5303031')), web: 'https://www.turia.example', subcuenta430: expect.stringMatching(/^430\d+$/) });
  });

  it('una web mala da 400 con el campo (la ventana lo enseña junto a la casilla)', async () => {
    const E = await empresa();
    for (const ruta of ['/proveedores', '/clientes']) {
      const r = await request(app(E)).post(ruta).send({ ...ficha(cif('5303032')), web: 'turia' });
      expect(r.status).toBe(400);
      expect(r.body.details).toEqual({ campo: 'web' });
    }
    expect(await prisma.supplier.count({ where: { companyId: E } })).toBe(0);
    expect(await prisma.customer.count({ where: { companyId: E } })).toBe(0);
  });
});

describe('Traer la contabilidad de 2026', () => {
  it('las fichas nuevas que salen del plan y del listado llevan la web', async () => {
    const E = `${BASE}-plan`;
    await prisma.company.create({ data: { id: E, name: 'Web plan', fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
    await prisma.legalConfig.create({ data: { companyId: E, denominacion: 'Web plan SL', nif: 'B10000000' } });
    await asegurarPlanContableEmpresa(E);
    const nifC = cif('5404040');
    const nifP = cif('5404041');
    await confirmarPlan(E, {
      cuentas: [
        { codigo: '4300001', nombre: 'Cliente Con Web SL', nif: nifC, ficha: { web: 'https://www.clienteconweb.es' } },
        { codigo: '4000001', nombre: 'Proveedor Con Web SL' },
      ],
      terceros: [{ subcuenta: '4000001', nif: nifP, nombre: 'Proveedor Con Web SL', ficha: { email: 'p@conweb.es', web: 'https://proveedorconweb.es' } }],
    });
    expect(await prisma.customer.findFirstOrThrow({ where: { companyId: E, nifCif: nifC } })).toMatchObject({ web: 'https://www.clienteconweb.es' });
    expect(await prisma.supplier.findFirstOrThrow({ where: { companyId: E, nifCif: nifP } })).toMatchObject({ email: 'p@conweb.es', web: 'https://proveedorconweb.es' });
  });
});
