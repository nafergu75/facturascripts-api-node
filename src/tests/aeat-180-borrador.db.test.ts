/**
 * Borrador del 180 sobre BD real, de las facturas de alquiler al fichero
 * oficial:
 *  - dos arrendadores: una persona fisica con un local (se asigna solo) y una
 *    sociedad con dos locales (hay que elegir el de cada factura);
 *  - una factura de diciembre de 2026 registrada en enero de 2027: registro
 *    aparte con el ejercicio de devengo;
 *  - el cuadre con los cuatro 115 del año (calculados o guardados) y el
 *    bloqueo del fichero si no cuadra;
 *  - alta de inmuebles con su referencia catastral y direccion.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import { expenseInvoicesService } from '../services/expense-invoices.service';
import borradoresAeatRoutes from '../routes/borradores-aeat.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { controlCif, letraDni } from '../utils/nif';
import { DISENO_180 } from '../domain/aeat/disenos';
import { comprobarFicheroPorLineas, posiciones } from './dorado-dr';
import { calcularBorrador180 } from '../services/borradoresAeat/borrador180.service';
import { calcularModelo115 } from '../services/impuestosCalculo.service';
import { periodoFiscal } from '../services/nominas/fiscal';

const SUFIJO = `${Date.now()}`;
const NIF = `B4677777${controlCif('4677777').cifra}`;
const DNI = `20202020${letraDni('20202020')}`;
const CIF = `B2866666${controlCif('2866666').cifra}`;

function app(companyId: string) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { userId: 'u-180', roles: ['contable'], companies: [companyId], rolesPorEmpresa: { [companyId]: ['contable'] } } as never;
    req.companyId = companyId;
    next();
  });
  a.use('/companies/:companyId/tax-models', borradoresAeatRoutes);
  a.use(errorMiddleware);
  return a;
}

async function alquiler(companyId: string, supplierId: string, fecha: string, numero: string, precio: number, fechaRegistro?: string) {
  return expenseInvoicesService.crearGasto(
    {
      companyId,
      proveedor: { id: supplierId },
      numeroFacturaProveedor: numero,
      fechaEmision: fecha,
      ...(fechaRegistro ? { fechaRegistro } : {}),
      tipoGasto: 'ALQUILER',
      lineas: [{ descripcion: 'Alquiler del local', cantidad: 1, precioUnitario: precio, tipoIva: 21, tipoRetencion: 19 }],
    } as never,
    { contabilizar: 'POSTED' },
  );
}

const localValencia = {
  referenciaCatastral: '9872023VH5797S0001WX',
  tipoVia: 'CL',
  nombreVia: 'Colón',
  numeroCasa: '12',
  planta: 'BJ',
  municipio: 'València',
  codigoMunicipio: '46250',
  codigoPostal: '46004',
};

describe('180 de 2027 desde las facturas de alquiler', () => {
  const E = `aeat180-${SUFIJO}`;
  let persona: string;
  let sociedad: string;
  let madridCentro: string;

  beforeAll(async () => {
    await prisma.company.create({ data: { id: E, name: 'Inquilina SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    await prisma.legalConfig.create({ data: { companyId: E, denominacion: 'Inquilina, S.L.', nif: NIF, telefono: '963000111', personaContacto: 'Pérez Gil Luis' } });
    persona = (await prisma.supplier.create({ data: { companyId: E, nombreFiscal: 'Martínez Peña José', nifCif: DNI, cp: '46002', provincia: 'Valencia' } })).id;
    sociedad = (await prisma.supplier.create({ data: { companyId: E, nombreFiscal: 'Inmuebles Ñora SL', nifCif: CIF, provincia: 'Madrid' } })).id;

    // Alta de inmuebles por la API.
    const r1 = await request(app(E)).post(`/companies/${E}/tax-models/180/inmuebles`).send({ supplierId: persona, ...localValencia });
    expect(r1.status).toBe(201);
    expect(r1.body.data).toMatchObject({ situacion: 1, codigoProvincia: '46', tipoNumeracion: 'NUM', municipio: 'VALENCIA' });
    const r2 = await request(app(E))
      .post(`/companies/${E}/tax-models/180/inmuebles`)
      .send({ supplierId: sociedad, referenciaCatastral: '0847106VK4704F0001LK', tipoVia: 'AV', nombreVia: 'Gran Vía', tipoNumeracion: 'S/N', municipio: 'Madrid', codigoMunicipio: '28079', codigoPostal: '28013' });
    madridCentro = r2.body.data.id;
    const r3 = await request(app(E))
      .post(`/companies/${E}/tax-models/180/inmuebles`)
      .send({ supplierId: sociedad, situacion: 4, tipoVia: 'CL', nombreVia: 'Alcalá', numeroCasa: '200', municipio: 'Madrid', codigoMunicipio: '28079', codigoPostal: '28028' });
    expect(r3.body.data).toMatchObject({ situacion: 4, referenciaCatastral: null });

    // Persona fisica: 1.000 € al mes (un local, se asigna solo).
    for (let m = 1; m <= 12; m++) await alquiler(E, persona, `2027-${String(m).padStart(2, '0')}-01`, `MP-${m}`, 1000);
    // Sociedad: trimestral, Gran Vía; diciembre de 2026 registrada en enero.
    for (const m of ['01', '04', '07', '10']) await alquiler(E, sociedad, `2027-${m}-05`, `IN-${m}`, 1500);
    await alquiler(E, sociedad, '2026-12-28', 'IN-2026-12', 500, '2027-01-10');
  });

  it('sin elegir el local de la sociedad: error claro y sin fichero', async () => {
    const b = await calcularBorrador180(E, 2027);
    expect(b.sinInmueble).toHaveLength(5);
    expect(b.errores[0]).toMatch(/Inmuebles Ñora SL.*tiene 2: elígelo en la factura/);
    const r = await request(app(E)).get(`/companies/${E}/tax-models/180/fichero?ejercicio=2027`);
    expect(r.status).toBe(400);
  });

  it('con el local elegido: un registro por arrendador, inmueble y devengo, y cuadra con los 115', async () => {
    const facturas = await prisma.expenseInvoice.findMany({ where: { companyId: E, supplierId: sociedad } });
    for (const f of facturas) {
      const r = await request(app(E)).put(`/companies/${E}/tax-models/180/facturas/${f.id}/inmueble`).send({ inmuebleArrendadoId: madridCentro });
      expect(r.status).toBe(200);
    }
    const b = await calcularBorrador180(E, 2027);
    expect(b.errores).toEqual([]);
    expect(b.entrada.perceptores.map((p) => [p.nombre, p.provincia, p.base, p.porcentaje, p.retenciones, p.ejercicioDevengo ?? null])).toEqual([
      ['Inmuebles Ñora SL', '28', 6000, 19, 1140, null],
      ['Inmuebles Ñora SL', '28', 500, 19, 95, 2026],
      ['Martínez Peña José', '46', 12000, 19, 2280, null],
    ]);
    expect(b.cuadre).toMatchObject({ coincide: true, base180: 18500, retenciones180: 3515, base115: 18500, retenciones115: 3515, faltan: [] });
    // Los cuatro 115 son los del modulo de siempre.
    const suma = { base: 0, ret: 0 };
    for (const t of ['1T', '2T', '3T', '4T']) {
      const m = await calcularModelo115(E, periodoFiscal(2027, t));
      suma.base += m.baseRetenciones;
      suma.ret += m.retenciones;
    }
    expect(suma).toEqual({ base: 18500, ret: 3515 });
  });

  it('GET /180/fichero: el fichero oficial, y la pantalla enseña lo que lleva', async () => {
    const r = await request(app(E)).get(`/companies/${E}/tax-models/180/fichero?ejercicio=2027`).buffer(true).parse((res, cb) => {
      const trozos: Buffer[] = [];
      res.on('data', (c: Buffer) => trozos.push(c));
      res.on('end', () => cb(null, Buffer.concat(trozos)));
    });
    expect(r.status).toBe(200);
    const fichero = (r.body as Buffer).toString('latin1');
    const lineas = comprobarFicheroPorLineas(DISENO_180, fichero, (_l, i) => (i === 0 ? 'declarante' : 'perceptor'));
    const [t1, ...t2] = lineas.map((l) => l.linea);
    expect(posiciones(t1, 1, 58)).toBe(`11802027${NIF}${'INQUILINA S L'.padEnd(40)}T`);
    expect(posiciones(t1, 59, 107)).toBe('963000111' + 'PEREZ GIL LUIS'.padEnd(40));
    expect(posiciones(t1, 136, 175)).toBe('000000003' + ' ' + '000000001850000' + '000000000351500');
    expect(t2.map((l) => [posiciones(l, 18, 26), posiciones(l, 76, 78), posiciones(l, 80, 113), posiciones(l, 114, 134)])).toEqual([
      [CIF, '281', '0000000600000' + '1900' + '0000000114000' + '0000', '10847106VK4704F0001LK'],
      [CIF, '281', '0000000050000' + '1900' + '0000000009500' + '2026', '10847106VK4704F0001LK'],
      [DNI, '461', '0000001200000' + '1900' + '0000000228000' + '0000', '19872023VH5797S0001WX'],
    ]);
    expect(posiciones(t2[0], 135, 192)).toBe('AV   ' + 'GRAN VIA'.padEnd(50) + 'S/N');
    expect(posiciones(t2[0], 286, 327)).toBe('MADRID'.padEnd(30) + '28079' + '28' + '28013');

    const b = (await request(app(E)).get(`/companies/${E}/tax-models/180?ejercicio=2027`)).body.data;
    expect(b.pantalla.perceptores.map((p: Record<string, unknown>) => [p.nifPerceptor, p.base, p.retenciones])).toEqual([
      [CIF, 6000, 1140],
      [CIF, 500, 95],
      [DNI, 12000, 2280],
    ]);
  });

  it('un 115 guardado que no cuadra bloquea el fichero', async () => {
    await prisma.modeloImpuesto.create({
      data: { companyId: E, codigo: '115', ejercicio: 2027, periodo: '1T', estado: 'presentado', casillas: { '02_base': 4000, '03_retenciones': 760 } as never },
    });
    const b = await calcularBorrador180(E, 2027);
    // El 1T calculado es 5.000 / 950: guardado como 4.000 / 760, faltan 1.000 / 190.
    expect(b.cuadre).toMatchObject({ coincide: false, base115: 17500, diferenciaBase: 1000, diferenciaRetenciones: 190 });
    expect(b.cuadre.periodos[0]).toMatchObject({ periodo: '1T', fuente: 'guardado', estado: 'presentado' });
    expect(b.errores).toEqual([expect.stringMatching(/no cuadra con los 115/)]);
    expect((await request(app(E)).get(`/companies/${E}/tax-models/180/fichero?ejercicio=2027`)).status).toBe(400);
    await prisma.modeloImpuesto.deleteMany({ where: { companyId: E, codigo: '115' } });
  });

  it('inmuebles: validación y cambios', async () => {
    const mal = await request(app(E)).post(`/companies/${E}/tax-models/180/inmuebles`).send({ supplierId: persona, situacion: 1, tipoVia: 'CL', nombreVia: 'X', municipio: 'Valencia', codigoMunicipio: '28079', codigoPostal: '46001' });
    expect(mal.status).toBe(400);
    expect(JSON.stringify(mal.body)).toMatch(/referencia catastral/);
    expect(JSON.stringify(mal.body)).toMatch(/no es de la provincia 46/);
    const ajeno = await request(app(E)).post(`/companies/${E}/tax-models/180/inmuebles`).send({ supplierId: 'otro', ...localValencia });
    expect(ajeno.status).toBe(400);
    const lista = await request(app(E)).get(`/companies/${E}/tax-models/180/inmuebles?supplierId=${sociedad}`);
    expect(lista.body.data).toHaveLength(2);
    const cambio = await request(app(E)).put(`/companies/${E}/tax-models/180/inmuebles/${madridCentro}`).send({ puerta: '3B' });
    expect(cambio.body.data).toMatchObject({ puerta: '3B', referenciaCatastral: '0847106VK4704F0001LK' });
  });
});
