/**
 * Borradores del 347, 390 y 200 con datos reales de la BD: la pantalla
 * (GET /impuestos/borradores/:modelo) y el fichero (.../fichero y el TXT del
 * módulo de impuestos) salen del mismo cálculo y con el diseño oficial.
 */
const fsClientMock = {
  listWithMeta: jest.fn().mockResolvedValue({ items: [], total: 0 }),
  getOne: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
};
jest.mock('../services/facturascripts-client', () => ({
  getFsClientForCompany: jest.fn().mockResolvedValue(fsClientMock),
}));

import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import impuestosModuloRoutes from '../routes/impuestosModulo.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { generarTxtModelo } from '../services/impuestosModulo.service';
import { DISENO_347 } from '../aeat/oficial/modelo347';
import { validarRegistro } from '../aeat/oficial/diseno';

const SUFIJO = Date.now();
const ES = `borr-aeat-es-${SUFIJO}`;
const SIN_NIF = `borr-aeat-sinnif-${SUFIJO}`;
const US = `borr-aeat-us-${SUFIJO}`;

const app = express();
app.use(express.json());
app.use('/companies/:companyId', (req, _res, next) => {
  req.user = { userId: 'u-admin', roles: ['admin'], rolesPorEmpresa: { [req.params.companyId]: ['admin'] } } as never;
  req.companyId = req.params.companyId;
  next();
});
app.use('/companies/:companyId/impuestos', impuestosModuloRoutes);
app.use(errorMiddleware);

const get = (url: string, empresa = ES) => request(app).get(`/companies/${empresa}/impuestos${url}`);
/** Descarga con el cuerpo en bruto (los ficheros van en ISO-8859-1). */
const descargar = (url: string, empresa = ES) =>
  get(url, empresa)
    .buffer(true)
    .parse((res, cb) => {
      const trozos: Buffer[] = [];
      res.on('data', (c: Buffer) => trozos.push(c));
      res.on('end', () => cb(null, Buffer.concat(trozos)));
    });
const latin1 = (r: request.Response) => (r.body as Buffer).toString('latin1');

let numero = 0;
async function venta(companyId: string, customerId: string, fecha: string, base: number, iva: number) {
  numero += 1;
  await prisma.incomeInvoice.create({
    data: {
      companyId,
      customerId,
      serie: 'A',
      numero,
      numeroCompleto: `A-${numero}`,
      fechaEmision: fecha,
      fechaVencimiento: fecha,
      tipoOperacion: 'NACIONAL',
      baseTotal: base,
      ivaTotal: iva,
      totalFactura: base + iva,
      lineas: { create: [{ descripcion: 'Venta', cantidad: 1, precioUnitario: base, baseLine: base, ivaImporte: iva, tipoIva: 21 }] },
    },
  });
}

beforeAll(async () => {
  for (const [id, nif, pais] of [
    [ES, 'B46000006', 'ES'],
    [SIN_NIF, '', 'ES'],
    [US, '', 'US'],
  ] as const) {
    await prisma.company.create({ data: { id, name: `Borradores ${id}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    await prisma.legalConfig.create({
      data: { companyId: id, denominacion: nif ? 'Borradores Turia, S.L.' : '', nif, pais, telefono: '961 23 45 67', cnae: '4646' },
    });
  }
  const cli = await prisma.customer.create({ data: { companyId: ES, nombreFiscal: 'Distribuciones Peña, S.L.', nifCif: 'B12345674', pais: 'ES', cp: '46001' } });
  await venta(ES, cli.id, '2025-02-10', 4000, 840);
  await venta(ES, cli.id, '2025-08-10', 1000, 210);
  const sin = await prisma.customer.create({ data: { companyId: SIN_NIF, nombreFiscal: 'Sin datos', nifCif: 'B87654323', pais: 'ES' } });
  await venta(SIN_NIF, sin.id, '2025-03-10', 5000, 1050);
});

describe('borrador del 347', () => {
  it('pantalla: declarante, resumen y declarados con provincia y trimestres', async () => {
    const r = await get('/borradores/347?ejercicio=2025');
    expect(r.status).toBe(200);
    const b = r.body.data ?? r.body;
    expect(b.errores).toEqual([]);
    expect(b.declarante).toMatchObject({ nif: 'B46000006', razonSocial: 'BORRADORES TURIA SL', telefono: '961234567' });
    expect(b.resumen).toMatchObject({ numeroDeclarados: 1, importeTotal: 6050 });
    expect(b.declarados[0]).toMatchObject({ nifFichero: 'B12345674', clave: 'B', provincia: '46', importeAnual: 6050, trimestres: [4840, 0, 1210, 0] });
    expect(b.fichero).toBeUndefined();
  });

  it('fichero: el mismo que el del módulo de impuestos y con el diseño oficial', async () => {
    const r = await descargar('/borradores/347/fichero?ejercicio=2025&contacto=Garcia%20Perez%20Ana');
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toContain('347_2025.txt');
    const lineas = latin1(r).split('\r\n').filter(Boolean);
    expect(lineas).toHaveLength(2);
    expect(validarRegistro({ hoja: '1', longitud: 500, campos: DISENO_347.registros['1'].campos }, lineas[0])).toEqual([]);
    expect(validarRegistro({ hoja: '2D', longitud: 500, campos: DISENO_347.registros['2D'].campos }, lineas[1])).toEqual([]);
    expect(lineas[0].slice(67, 107).trim()).toBe('GARCIA PEREZ ANA');
    expect(lineas[1].slice(35, 75).trim()).toBe('DISTRIBUCIONES PEÑA SL');

    // El TXT del módulo de impuestos ya no lee el JSON guardado: aunque la fila
    // la haya escrito otra pantalla con otra forma, sale el fichero oficial.
    const fila = await prisma.modeloImpuesto.create({
      data: { companyId: ES, codigo: '347', ejercicio: 2025, periodo: '0A', datos: { terceros: [], totalTerceros: 0 } },
    });
    const txt = await generarTxtModelo(ES, fila.id);
    expect(txt.nombre).toBe('347_2025.txt');
    expect(txt.contenido.split('\r\n')[1]).toBe(lineas[1]);
  });

  it('sin NIF de la empresa ni provincia del cliente: la pantalla avisa y el fichero no se genera', async () => {
    const b = (await get('/borradores/347?ejercicio=2025', SIN_NIF)).body;
    expect((b.data ?? b).errores.join(' ')).toMatch(/NIF de la empresa/);
    expect((b.data ?? b).errores.join(' ')).toMatch(/provincia/);
    const r = await get('/borradores/347/fichero?ejercicio=2025', SIN_NIF);
    expect(r.status).toBe(400);
  });
});

describe('borrador del 390', () => {
  it('pantalla y fichero con las mismas casillas', async () => {
    const b = (await get('/borradores/390?ejercicio=2025')).body;
    const d = b.data ?? b;
    expect(d.errores).toEqual([]);
    expect(d.casillas).toMatchObject({ '05': 5000, '06': 1050, '34': 1050, '47': 1050, '65': 1050, '99': 5000, '108': 5000 });
    expect(d.paginas.map((p: { codigo: string }) => p.codigo)).toEqual(['01000', '02000', '02B00', '03000', '04000', '06000']);
    // Cada casilla con su descripción del diseño oficial, en el orden de la página.
    const p2 = d.paginas.find((p: { codigo: string }) => p.codigo === '02000');
    expect(p2.detalle[0]).toEqual({ casilla: '05', descripcion: 'Base Imponible y cuota - Reg. ordin. - Tipo 21% - Base imponible', valor: 5000 });
    const f = await descargar('/borradores/390/fichero?ejercicio=2025');
    expect(f.status).toBe(200);
    const contenido = latin1(f);
    expect(contenido.startsWith('<T390020250A0000><AUX>')).toBe(true);
    expect(contenido.endsWith('</T390020250A0000>')).toBe(true);
    expect(contenido).toBe(`${contenido.slice(0, 328)}${d.paginas.map((p: { linea: string }) => p.linea).join('')}</T390020250A0000>`);
  });

  it('un último periodo que no es compensar ni devolver: 400', async () => {
    const r = await get('/borradores/390?ejercicio=2025&ultimoPeriodo=nada');
    expect(r.status).toBe(400);
  });
});

describe('borrador del 200', () => {
  it('genera las páginas de una pyme y lista las que quedan por completar', async () => {
    const b = (await get('/borradores/200?ejercicio=2025&bins=0&retenciones=0')).body;
    const d = b.data ?? b;
    expect(d.paginas.map((p: { codigo: string }) => p.codigo)).toEqual(['01000', '01B00', '03000', '04000', '05000', '06000', '07000', '08000', '12000', '14000', '14B00', 'DID00']);
    expect(d.paginasPendientes.length).toBeGreaterThan(50);
    expect(d.casillas['00558']).toBeDefined();
    const f = await descargar('/borradores/200/fichero?ejercicio=2025');
    expect(f.status).toBe(200);
    expect(latin1(f).startsWith('<T200020250A0000><AUX>')).toBe(true);
  });

  it('importes no válidos: 400', async () => {
    expect((await get('/borradores/200?ejercicio=2025&bins=-5')).status).toBe(400);
    expect((await get('/borradores/111?ejercicio=2025')).status).toBe(400);
    expect((await get('/borradores/347')).status).toBe(400);
  });
});

describe('empresa extranjera', () => {
  it('sin modelos de la AEAT', async () => {
    for (const m of ['347', '390', '200']) {
      const r = await get(`/borradores/${m}?ejercicio=2025`, US);
      expect([m, r.status]).toEqual([m, 400]);
    }
  });
});
