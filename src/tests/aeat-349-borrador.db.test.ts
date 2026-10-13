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
import { describe, it, expect, beforeAll, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import { incomeInvoicesService } from '../services/income-invoices.service';
import { expenseInvoicesService } from '../services/expense-invoices.service';
import { cambiarEstadoPeriodo } from '../services/periodos.service';
import borradoresAeatRoutes from '../routes/borradores-aeat.routes';
import declaracionesAeatRoutes from '../routes/declaraciones-aeat.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { controlCif } from '../utils/nif';
import { DISENO_349 } from '../domain/aeat/disenos';
import { comprobarFicheroPorLineas, posiciones } from './dorado-dr';
import { calcularBorrador349 } from '../services/borradoresAeat/borrador349.service';
import { guardarOpciones } from '../services/borradoresAeat/comun';

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
  a.use('/companies/:companyId/tax-models', declaracionesAeatRoutes);
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
    // Las facturas de 2027 no se pueden emitir antes de su fecha (Verifactu, P3):
    // solo mientras se crean, el dia de hoy es el 15-6-2027. Solo se finge la
    // fecha; los temporizadores siguen reales para que Prisma funcione.
    jest.useFakeTimers({
      now: new Date('2027-06-15T10:00:00Z'),
      doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
    });
    try {
      await crearDatos();
    } finally {
      jest.useRealTimers();
    }
  });

  async function crearDatos() {
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
  }

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
    // Sin número todavía: el GET no lo pone (B5), lo pone la operación de escritura.
    const sinNumero = await request(app(E)).get(`/companies/${E}/tax-models/349/fichero?ejercicio=2027&periodo=2T`);
    expect(sinNumero.status).toBe(409);
    const n = await request(app(E)).post(`/companies/${E}/tax-models/349/declaraciones/numero`).send({ ejercicio: 2027, periodo: '2T' });
    expect(n.status).toBe(200);
    expect(n.body.data.enCurso).toMatchObject({ tipo: 'N', numero: '3492027000001' });
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
    expect(posiciones(t1, 18, 57)).toBe('EXPORTADORA TURIA SL'.padEnd(40));
    expect(posiciones(t1, 59, 107)).toBe('963123456' + 'GARCIA MUÑOZ ANA'.padEnd(40));
    expect(posiciones(t1, 108, 120)).toBe('3492027000001');
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

  it('PUT /349/opciones ya no pone la sustitutiva: va por el historial de declaraciones', async () => {
    const r = await request(app(E)).put(`/companies/${E}/tax-models/349/opciones`).send({ ejercicio: 2027, periodo: '2T', tipoDeclaracion: 'S', declaracionAnterior: '3492027220001' });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/historial de declaraciones/);
    const ok = await request(app(E)).put(`/companies/${E}/tax-models/349/opciones`).send({ ejercicio: 2027, periodo: '2T', cambioPeriodicidad: false });
    expect(ok.status).toBe(200);
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

  it('cambio de periodicidad: la X solo en 02, 05, 08 y 11, y la de mayo recoge también abril', async () => {
    const op = (b: Awaited<ReturnType<typeof calcularBorrador349>>) => b.entrada.operadores.map((o) => [o.clave, o.nombre, o.base]);
    expect(op(await calcularBorrador349(E, 2027, '05'))).toEqual([['I', 'Peñas Consultoria Lda', 800]]);
    await request(app(E)).put(`/companies/${E}/tax-models/349/opciones`).send({ ejercicio: 2027, periodo: '05', cambioPeriodicidad: true });
    const mayo = await calcularBorrador349(E, 2027, '05');
    expect(op(mayo)).toEqual([
      ['A', 'Rossi SpA', 3000],
      ['E', 'Müller Handels GmbH', 5000],
      ['I', 'Peñas Consultoria Lda', 800],
    ]);
    expect(mayo.entrada.cambioPeriodicidad).toBe(true);
    expect(mayo.avisos).toContainEqual(expect.stringMatching(/recoge también las operaciones del mes anterior/));
    await request(app(E)).put(`/companies/${E}/tax-models/349/opciones`).send({ ejercicio: 2027, periodo: '05', cambioPeriodicidad: false });
    // En junio no cabe: error que dice en qué meses va.
    await request(app(E)).put(`/companies/${E}/tax-models/349/opciones`).send({ ejercicio: 2027, periodo: '06', cambioPeriodicidad: true });
    const junio = await calcularBorrador349(E, 2027, '06');
    expect(junio.errores).toContainEqual(expect.stringMatching(/solo se marca en la declaración mensual de febrero, mayo, agosto o noviembre/));
    await request(app(E)).put(`/companies/${E}/tax-models/349/opciones`).send({ ejercicio: 2027, periodo: '06', cambioPeriodicidad: false });
  });

  it('sin ningún operador ni rectificación es un error (no un aviso)', async () => {
    const b = await calcularBorrador349(E, 2027, '3T');
    expect(b.errores).toContainEqual(expect.stringMatching(/no lleva ningún operador ni ninguna rectificación/));
    const r = await request(app(E)).get(`/companies/${E}/tax-models/349/fichero?ejercicio=2027&periodo=3T`);
    expect(r.status).toBe(400);
  });

  it('POST /349/presentado: guarda lo presentado, que se enseña después y es la base de las rectificaciones', async () => {
    const r = await request(app(E))
      .post(`/companies/${E}/tax-models/349/presentado`)
      .send({ ejercicio: 2027, periodo: '1T', justificante: { numero: '3492027210001', fecha: '2027-04-18' } });
    expect(r.status).toBe(200);
    expect(r.body.data.estado).toBe('presentada');
    expect(r.body.data.declaraciones[0]).toMatchObject({ secuencia: 1, tipo: 'N', estado: 'presentada', justificante: '3492027210001', numero: '3492027000002' });
    const b1 = await calcularBorrador349(E, 2027, '1T');
    expect(b1.avisos[0]).toMatch(/^Presentado \(justificante 3492027210001, 18\/04\/2027\)/);
    // Rossi estaba en lo presentado: su anulacion deja la base rectificada a cero, sin error.
    const b = await calcularBorrador349(E, 2027, '2T');
    expect(b.errores).toEqual([]);
    expect(b.entrada.rectificaciones!.map((x) => [x.nombre, x.baseAnterior, x.baseRectificada])).toEqual([
      ['Rossi SpA', 4000, 0],
      ['Müller Handels GmbH', 10000, 9000],
    ]);
    expect(b.avisos.some((x) => /no consta como presentado/.test(x))).toBe(false);
    // Ya presentado: ni otra vez ni opciones.
    expect((await request(app(E)).post(`/companies/${E}/tax-models/349/presentado`).send({ ejercicio: 2027, periodo: '1T', justificante: { numero: '3492027210001', fecha: '2027-04-18' } })).status).toBe(409);
    expect((await request(app(E)).put(`/companies/${E}/tax-models/349/opciones`).send({ ejercicio: 2027, periodo: '1T', cambioPeriodicidad: true })).status).toBe(403);
    expect((await request(app(E)).post(`/companies/${E}/tax-models/349/presentado`).send({ ejercicio: 2027, periodo: '2T', justificante: { numero: '', fecha: '' } })).status).toBe(400);
  });

  it('complementaria del 1T: sin operadores nuevos no lleva nada; la sustitutiva los lleva todos y cita la anterior', async () => {
    const c = await request(app(E)).post(`/companies/${E}/tax-models/349/declaraciones/rectificacion`).send({ ejercicio: 2027, periodo: '1T', tipo: 'C' });
    expect(c.status).toBe(201);
    expect(c.body.data.enCurso).toMatchObject({ tipo: 'C', justificanteAnterior: '3492027000002', registros: [] });
    const b = await calcularBorrador349(E, 2027, '1T');
    expect(b.errores).toContainEqual(expect.stringMatching(/complementaria no lleva ningún registro/));
    // Se eligen los operadores a mano.
    const sel = await request(app(E)).put(`/companies/${E}/tax-models/349/declaraciones/rectificacion/registros`).send({ ejercicio: 2027, periodo: '1T', registros: ['FR12345678901|E'] });
    expect(sel.status).toBe(200);
    expect(sel.body.data.registros.find((r: { clave: string }) => r.clave === 'FR12345678901|E')).toMatchObject({ presentado: true, incluido: true });
    expect((await calcularBorrador349(E, 2027, '1T')).entrada.operadores.map((o) => o.nombre)).toEqual(['Société Lyon SARL']);
    await request(app(E)).delete(`/companies/${E}/tax-models/349/declaraciones/rectificacion?ejercicio=2027&periodo=1T`);
    const s = await request(app(E)).post(`/companies/${E}/tax-models/349/declaraciones/rectificacion`).send({ ejercicio: 2027, periodo: '1T', tipo: 'S' });
    expect(s.body.data.enCurso).toMatchObject({ tipo: 'S', numero: '3492027000004' });
    const sus = await calcularBorrador349(E, 2027, '1T');
    expect(sus.entrada.operadores).toHaveLength(3);
    expect(sus.entrada.declarante).toMatchObject({ tipoDeclaracion: 'S', declaracionAnterior: '3492027000002', numeroDeclaracion: '3492027000004' });
    await request(app(E)).delete(`/companies/${E}/tax-models/349/declaraciones/rectificacion?ejercicio=2027&periodo=1T`);
  });

  it('sin NIF de la empresa no hay fichero: 400 con lo que falta', async () => {
    await prisma.legalConfig.update({ where: { companyId: E }, data: { nif: null } });
    const r = await request(app(E)).get(`/companies/${E}/tax-models/349/fichero?ejercicio=2027&periodo=2T`);
    expect(r.status).toBe(400);
    expect(r.body.error?.message ?? r.body.message ?? JSON.stringify(r.body)).toMatch(/NIF de la empresa/);
    await prisma.legalConfig.update({ where: { companyId: E }, data: { nif: NIF } });
  });
});

describe('349 con abonos de venta de varias facturas y de una de fuera de la app', () => {
  const E = `aeat349v-${SUFIJO}`;
  let de = '';

  /** Abono intracomunitario (sin IVA) con el bloque de la rectificativa. */
  async function abono(fecha: string, lineas: Array<ReturnType<typeof linea>>, originales: Array<Record<string, unknown>>) {
    const b = await incomeInvoicesService.crearIngreso({
      companyId: E,
      customer: { id: de },
      fechaEmision: fecha,
      borrador: true,
      lineas,
      rectificativa: { forma: 'I', motivo: 'DESCUENTO', explicacion: 'Descuento pactado', originales },
    } as unknown as Parameters<typeof incomeInvoicesService.crearIngreso>[0]);
    return incomeInvoicesService.finalizar(E, b.id, { fechaEmision: fecha });
  }

  beforeAll(async () => {
    jest.useFakeTimers({
      now: new Date('2027-09-15T10:00:00Z'),
      doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
    });
    try {
      await prisma.company.create({ data: { id: E, name: 'Exportadora Ventas SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
      await prisma.legalConfig.create({ data: { companyId: E, denominacion: 'Exportadora Ventas, S.L.', nif: NIF, telefono: '963 12 34 56', personaContacto: 'García Muñoz Ana' } });
      de = (await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Müller Handels GmbH', nifCif: 'DE123456789', pais: 'DE' } })).id;
      const v1 = await venta(E, de, '2027-02-10', 10000);
      const v2 = await venta(E, de, '2027-04-15', 5000);
      // 3T: un abono de las dos (1.000 de la del 1T y 500 de la del 2T) y otro de una factura de 2026 de fuera.
      await abono('2027-08-05', [linea(-1000), linea(-500)], [
        { id: v1.id, base: -1000, cuota: 0, retencion: 0 },
        { id: v2.id, base: -500, cuota: 0, retencion: 0 },
      ]);
      await abono('2027-08-06', [linea(-200)], [{ numero: 'A-2026-9', fecha: '2026-11-20' }]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('cada original en su periodo: rectificaciones del 1T y del 2T con su parte; la de fuera pide la base declarada', async () => {
    const b = await calcularBorrador349(E, 2027, '3T');
    expect(b.entrada.operadores).toEqual([]);
    expect(b.entrada.rectificaciones!.map((r) => [r.clave, r.ejercicio, r.periodo, r.baseAnterior, r.baseRectificada])).toEqual([
      ['E', 2027, '1T', 10000, 9000],
      ['E', 2027, '2T', 5000, 4500],
    ]);
    expect(b.basesPedidas).toEqual([expect.objectContaining({ ejercicio: 2026, periodo: '4T', base: null, claveOperacion: 'E' })]);
    expect(b.errores).toContainEqual('Indica la base que declaraste para Müller Handels GmbH (clave E) en el 349 del 4T de 2026: sin ella no se puede rectificar.');
  });

  it('con la base declarada de 2026, también la rectifica', async () => {
    const pedida = (await calcularBorrador349(E, 2027, '3T')).basesPedidas[0];
    await guardarOpciones(E, '349', 2027, '3T', { [`base:${pedida.clave}`]: 3000 });
    const b = await calcularBorrador349(E, 2027, '3T');
    expect(b.errores.filter((e) => e.startsWith('Indica la base'))).toEqual([]);
    expect(b.entrada.rectificaciones).toContainEqual(expect.objectContaining({ ejercicio: 2026, periodo: '4T', baseAnterior: 3000, baseRectificada: 2800 }));
  });
});
