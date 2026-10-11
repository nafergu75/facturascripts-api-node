/**
 * Borrador del 349 sobre BD real, de las facturas al fichero oficial:
 *  - entregas (E) a Alemania y Francia y una rectificativa en el 2T de una
 *    venta del 1T, que va como registro de rectificacion del 1T;
 *  - compras desde 2027 por el pais ISO-2 o el prefijo del NIF-IVA: bienes de
 *    Italia (A), servicios de Portugal (I) y una compra nacional que no va;
 *  - una compra del 1T anulada con contraasiento en el 2T: rectificacion A;
 *  - base anterior del 349 presentado (o calculada, con aviso);
 *  - el fichero que se descarga cumple el diseno oficial y la pantalla
 *    enseña lo mismo que lleva.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import { incomeInvoicesService } from '../services/income-invoices.service';
import { expenseInvoicesService } from '../services/expense-invoices.service';
import { cambiarEstadoPeriodo } from '../services/periodos.service';
import borradoresAeatRoutes from '../routes/borradores-aeat.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { controlCif } from '../utils/nif';
import { DISENO_349 } from '../domain/aeat/disenos';
import { comprobarFicheroPorLineas, posiciones } from './dorado-dr';
import { calcularBorrador349 } from '../services/borradoresAeat/borrador349.service';

const SUFIJO = `${Date.now()}`;
const NIF = `B4699999${controlCif('4699999').cifra}`;

function app(companyId: string) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { userId: 'u-349', roles: ['contable'], companies: [companyId], rolesPorEmpresa: { [companyId]: ['contable'] } } as never;
    req.companyId = companyId;
    next();
  });
  a.use('/companies/:companyId/tax-models', borradoresAeatRoutes);
  a.use(errorMiddleware);
  return a;
}

const linea = (precio: number) => ({ descripcion: 'Mercancía', cantidad: 1, precioUnitario: precio, tipoIva: 0 });

async function venta(companyId: string, customerId: string, fecha: string, precio: number) {
  const b = await incomeInvoicesService.crearIngreso({
    companyId,
    customer: { id: customerId },
    fechaEmision: fecha,
    tipoOperacion: 'INTRACOMUNITARIA',
    lineas: [linea(precio)],
    borrador: true,
  });
  return incomeInvoicesService.finalizar(companyId, b.id, { fechaEmision: fecha });
}

async function compra(companyId: string, supplierId: string, fecha: string, numero: string, precio: number, tipoGasto = 'COMPRA') {
  return expenseInvoicesService.crearGasto(
    {
      companyId,
      proveedor: { id: supplierId },
      numeroFacturaProveedor: numero,
      fechaEmision: fecha,
      tipoGasto,
      lineas: [{ descripcion: 'Compra', cantidad: 1, precioUnitario: precio, tipoIva: 0 }],
    } as never,
    { contabilizar: 'POSTED' },
  );
}

describe('349 de 2027 desde las facturas', () => {
  const E = `aeat349-${SUFIJO}`;
  let ventaDe1T: string;

  beforeAll(async () => {
    await prisma.company.create({ data: { id: E, name: 'Exportadora Turia SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    await prisma.legalConfig.create({
      data: { companyId: E, denominacion: 'Exportadora Turia, S.L.', nif: NIF, telefono: '+34 963 12 34 56', personaContacto: 'García Muñoz Ana' },
    });
    const de = (await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Müller Handels GmbH', nifCif: 'DE123456789', pais: 'DE' } })).id;
    const fr = (await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Société Lyon SARL', nifCif: 'FR12345678901', pais: 'FR' } })).id;
    const it = (await prisma.supplier.create({ data: { companyId: E, nombreFiscal: 'Rossi SpA', nifCif: '12345678901', pais: 'IT' } })).id;
    const pt = (await prisma.supplier.create({ data: { companyId: E, nombreFiscal: 'Peñas Consultoria Lda', nifCif: 'PT123456789' } })).id;
    const es = (await prisma.supplier.create({ data: { companyId: E, nombreFiscal: 'Nacional SL', nifCif: `B4688888${controlCif('4688888').cifra}` } })).id;

    // 1T: dos entregas y una compra a Italia.
    ventaDe1T = (await venta(E, de, '2027-02-10', 10000)).id;
    await venta(E, fr, '2027-03-01', 2000);
    const compra1T = await compra(E, it, '2027-02-15', 'IT-1', 4000);
    await cambiarEstadoPeriodo(E, 2027, 2, 'cerrado');

    // 2T: entrega a Alemania, abono de 1.000 € de la venta del 1T, compras a Italia (A),
    // servicios de Portugal (I), compra nacional y la compra del 1T anulada con contraasiento.
    await venta(E, de, '2027-04-15', 5000);
    const r = await incomeInvoicesService.crearRectificativa(E, ventaDe1T, { motivo: 'Descuento por volumen', lineas: [linea(-1000)], borrador: true });
    await incomeInvoicesService.finalizar(E, r.id, { fechaEmision: '2027-05-05' });
    await compra(E, it, '2027-04-20', 'IT-2', 3000);
    await compra(E, pt, '2027-05-02', 'PT-1', 800, 'SERVICIO_PROFESIONAL');
    await compra(E, es, '2027-05-03', 'ES-1', 500);
    const anulada = await expenseInvoicesService.anularGasto(E, compra1T.id, { motivo: 'Devuelta', fecha: '2027-04-10' });
    expect(anulada.contraasiento).toBe(true);
  });

  it('1T: las dos entregas y la compra a Italia', async () => {
    const b = await calcularBorrador349(E, 2027, '1T');
    expect(b.errores).toEqual([]);
    expect(b.entrada.operadores.map((o) => [o.clave, o.nombre, o.base])).toEqual([
      ['A', 'Rossi SpA', 4000],
      ['E', 'Müller Handels GmbH', 10000],
      ['E', 'Société Lyon SARL', 2000],
    ]);
    expect(b.entrada.rectificaciones).toEqual([]);
  });

  it('2T sin el 1T presentado: rectificaciones con la base calculada y un aviso', async () => {
    const b = await calcularBorrador349(E, 2027, '2T');
    expect(b.errores).toEqual([]);
    expect(b.entrada.operadores.map((o) => [o.clave, o.nombre, o.base])).toEqual([
      ['A', 'Rossi SpA', 3000],
      ['E', 'Müller Handels GmbH', 5000],
      ['I', 'Peñas Consultoria Lda', 800],
    ]);
    expect(b.entrada.rectificaciones!.map((r) => [r.clave, r.nombre, r.ejercicio, r.periodo, r.baseAnterior, r.baseRectificada])).toEqual([
      ['A', 'Rossi SpA', 2027, '1T', 4000, 0],
      ['E', 'Müller Handels GmbH', 2027, '1T', 10000, 9000],
    ]);
    expect(b.avisos.filter((a) => /no consta como presentado/.test(a))).toHaveLength(2);
    // La pantalla lee lo que lleva el fichero.
    const t1 = Object.fromEntries(b.pantalla!.declarante.map((c) => [c.id, c.valor]));
    expect(t1).toMatchObject({ numeroOperadores: '000000003', importeOperaciones: 8800, numeroRectificaciones: '000000002', importeRectificaciones: 9000 });
  });

  it('con el 349 del 1T presentado, la base anterior es la declarada', async () => {
    await prisma.modeloImpuesto.create({
      data: {
        companyId: E,
        codigo: '349',
        ejercicio: 2027,
        periodo: '1T',
        estado: 'presentado',
        datos: { entrada: { operadores: [{ nifIva: 'DE123456789', nombre: 'Müller Handels GmbH', clave: 'E', base: 12000 }] } } as never,
      },
    });
    const b = await calcularBorrador349(E, 2027, '2T');
    const de = b.entrada.rectificaciones!.find((r) => r.clave === 'E')!;
    expect([de.baseAnterior, de.baseRectificada]).toEqual([12000, 11000]);
    // Rossi no estaba en lo presentado: base anterior 0 y la rectificacion queda en negativo.
    expect(b.errores).toEqual([expect.stringMatching(/Rossi SpA.*negativa/)]);
    await prisma.modeloImpuesto.deleteMany({ where: { companyId: E, codigo: '349', periodo: '1T' } });
  });

  it('GET /349/fichero: el fichero oficial del 2T, en ISO-8859-1', async () => {
    const r = await request(app(E)).get(`/companies/${E}/tax-models/349/fichero?ejercicio=2027&periodo=2T`).buffer(true).parse((res, cb) => {
      const trozos: Buffer[] = [];
      res.on('data', (c: Buffer) => trozos.push(c));
      res.on('end', () => cb(null, Buffer.concat(trozos)));
    });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/ISO-8859-1/);
    const fichero = (r.body as Buffer).toString('latin1');
    const lineas = comprobarFicheroPorLineas(DISENO_349, fichero, (l, i) => (i === 0 ? 'declarante' : posiciones(l, 134, 146).trim() ? 'operador' : 'rectificacion'));
    const [t1, ...t2] = lineas.map((l) => l.linea);
    expect(posiciones(t1, 1, 17)).toBe(`13492027${NIF}`);
    expect(posiciones(t1, 18, 57)).toBe('EXPORTADORA TURIA S L'.padEnd(40));
    expect(posiciones(t1, 59, 107)).toBe('963123456' + 'GARCIA MUÑOZ ANA'.padEnd(40));
    expect(posiciones(t1, 136, 185)).toBe('2T' + '000000003' + '000000000880000' + '000000002' + '000000000900000');
    expect(t2.map((l) => [posiciones(l, 76, 92), posiciones(l, 133, 133), posiciones(l, 134, 146)])).toEqual([
      ['IT' + '12345678901'.padEnd(15), 'A', '0000000300000'],
      ['DE' + '123456789'.padEnd(15), 'E', '0000000500000'],
      ['PT' + '123456789'.padEnd(15), 'I', '0000000080000'],
      ['IT' + '12345678901'.padEnd(15), 'A', ' '.repeat(13)],
      ['DE' + '123456789'.padEnd(15), 'E', ' '.repeat(13)],
    ]);
    expect(posiciones(t2[4], 147, 178)).toBe('20271T' + '0000000900000' + '0000001000000');
    expect(posiciones(t2[0], 93, 132)).toBe('ROSSI SPA'.padEnd(40));
    expect(posiciones(t2[2], 93, 132)).toBe('PEÑAS CONSULTORIA LDA'.padEnd(40));
  });

  it('PUT /349/opciones: sustitutiva con la declaración anterior', async () => {
    const r = await request(app(E)).put(`/companies/${E}/tax-models/349/opciones`).send({ ejercicio: 2027, periodo: '2T', tipoDeclaracion: 'S', declaracionAnterior: '3492027220001' });
    expect(r.status).toBe(200);
    const t1 = Object.fromEntries(r.body.data.pantalla.declarante.map((c: { id: string; valor: unknown }) => [c.id, c.valor]));
    expect(t1).toMatchObject({ sustitutiva: 'S', complementaria: '', declaracionAnterior: '3492027220001', numeroDeclaracion: '3492027220002' });
    const mal = await request(app(E)).put(`/companies/${E}/tax-models/349/opciones`).send({ ejercicio: 2027, periodo: '2T', declaracionAnterior: '1234' });
    expect(mal.status).toBe(400);
    await request(app(E)).put(`/companies/${E}/tax-models/349/opciones`).send({ ejercicio: 2027, periodo: '2T', tipoDeclaracion: null, declaracionAnterior: null });
  });

  it('PUT /349/compras/:id/clave: un servicio marcado como bien pasa a A', async () => {
    const pt = await prisma.expenseInvoice.findFirstOrThrow({ where: { companyId: E, numeroFacturaProveedor: 'PT-1' } });
    const r = await request(app(E)).put(`/companies/${E}/tax-models/349/compras/${pt.id}/clave`).send({ clave: 'A' });
    expect(r.status).toBe(200);
    const b = await calcularBorrador349(E, 2027, '2T');
    expect(b.entrada.operadores.find((o) => o.nombre === 'Peñas Consultoria Lda')?.clave).toBe('A');
    expect((await request(app(E)).put(`/companies/${E}/tax-models/349/compras/${pt.id}/clave`).send({ clave: 'X' })).status).toBe(400);
    await request(app(E)).put(`/companies/${E}/tax-models/349/compras/${pt.id}/clave`).send({ clave: null });
  });

  it('POST /349/presentado: guarda lo presentado, que se enseña después y es la base de las rectificaciones', async () => {
    const r = await request(app(E))
      .post(`/companies/${E}/tax-models/349/presentado`)
      .send({ ejercicio: 2027, periodo: '1T', justificante: { numero: '3492027210001', fecha: '2027-04-18' } });
    expect(r.status).toBe(200);
    expect(r.body.data.estado).toBe('presentado');
    expect(r.body.data.avisos[0]).toMatch(/^Presentado \(justificante 3492027210001, 2027-04-18\)/);
    // Rossi estaba en lo presentado: su anulacion deja la base rectificada a cero, sin error.
    const b = await calcularBorrador349(E, 2027, '2T');
    expect(b.errores).toEqual([]);
    expect(b.entrada.rectificaciones!.map((x) => [x.nombre, x.baseAnterior, x.baseRectificada])).toEqual([
      ['Rossi SpA', 4000, 0],
      ['Müller Handels GmbH', 10000, 9000],
    ]);
    expect(b.avisos.some((x) => /no consta como presentado/.test(x))).toBe(false);
    // Ya presentado: ni otra vez ni opciones.
    expect((await request(app(E)).post(`/companies/${E}/tax-models/349/presentado`).send({ ejercicio: 2027, periodo: '1T', justificante: { numero: '3492027210001', fecha: '2027-04-18' } })).status).toBe(400);
    expect((await request(app(E)).put(`/companies/${E}/tax-models/349/opciones`).send({ ejercicio: 2027, periodo: '1T', tipoDeclaracion: 'C' })).status).toBe(403);
    expect((await request(app(E)).post(`/companies/${E}/tax-models/349/presentado`).send({ ejercicio: 2027, periodo: '2T', justificante: { numero: '', fecha: '' } })).status).toBe(400);
  });

  it('sin NIF de la empresa no hay fichero: 400 con lo que falta', async () => {
    await prisma.legalConfig.update({ where: { companyId: E }, data: { nif: null } });
    const r = await request(app(E)).get(`/companies/${E}/tax-models/349/fichero?ejercicio=2027&periodo=2T`);
    expect(r.status).toBe(400);
    expect(r.body.error?.message ?? r.body.message ?? JSON.stringify(r.body)).toMatch(/NIF de la empresa/);
    await prisma.legalConfig.update({ where: { companyId: E }, data: { nif: NIF } });
  });
});
