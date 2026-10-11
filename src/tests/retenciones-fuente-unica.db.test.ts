/**
 * 111 y 115: la pantalla (tax-models) y el fichero (TXT del modulo Impuestos)
 * salen de la misma funcion (declaracionRetenciones), tambien con filas
 * antiguas o presentadas. Sin presentar, la descarga recalcula como la
 * pantalla (antes bajaba las cifras del ultimo recalculo); presentado, las dos
 * dan lo guardado. Y los periodos mensuales (01 a 12).
 *
 * Necesita MySQL. Los NIF son inventados (con su control).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import { expenseInvoicesService } from '../services/expense-invoices.service';
import { generarTxtModelo } from '../services/impuestosModulo.service';
import { taxModelsService } from '../services/tax-models.service';
import taxModelsRoutes from '../routes/tax-models.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { letraNif } from '../utils/nif';

const E = `ret-fuente-${Date.now()}`;
const dni = (n: number) => `${n}${letraNif(n)}`;
let arrendador: string;
let asesora: string;

const alquiler = (fecha: string, numero: string) =>
  expenseInvoicesService.crearGasto(
    {
      companyId: E,
      proveedor: { id: arrendador },
      numeroFacturaProveedor: numero,
      fechaEmision: fecha,
      tipoGasto: 'ALQUILER',
      lineas: [{ descripcion: 'Alquiler del local', cantidad: 1, precioUnitario: 1000, tipoIva: 21, tipoRetencion: 19 }],
    } as never,
    { contabilizar: 'POSTED' },
  );
const honorarios = (fecha: string, numero: string) =>
  expenseInvoicesService.crearGasto(
    {
      companyId: E,
      proveedor: { id: asesora },
      numeroFacturaProveedor: numero,
      fechaEmision: fecha,
      tipoGasto: 'SERVICIO_PROFESIONAL',
      lineas: [{ descripcion: 'Asesoría', cantidad: 1, precioUnitario: 500, tipoIva: 21, tipoRetencion: 15 }],
    } as never,
    { contabilizar: 'POSTED' },
  );

/** Casilla de la pagina del fichero (cabecera de 328 + pagina) por su posicion y longitud. */
const casilla = (txt: string, pos: number, lon = 17) => Number(txt.slice(328 + pos - 1, 328 + pos - 1 + lon)) / 100;

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { userId: 'u-ret', roles: ['contable'], companies: [E], rolesPorEmpresa: { [E]: ['contable'] } } as never;
    req.companyId = E;
    next();
  });
  a.use('/companies/:companyId/tax-models', taxModelsRoutes);
  a.use(errorMiddleware);
  return a;
}

beforeAll(async () => {
  await prisma.company.create({ data: { id: E, name: 'Fuente Unica SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: E, denominacion: 'Fuente Unica SL', nif: 'B10000008' } });
  arrendador = (await prisma.supplier.create({ data: { companyId: E, nombreFiscal: 'Locales Prueba', nifCif: dni(20000001), cp: '46001' } })).id;
  asesora = (await prisma.supplier.create({ data: { companyId: E, nombreFiscal: 'Asesora Prueba', nifCif: dni(20000002), cp: '46001' } })).id;
});

describe('115: pantalla y fichero, la misma fuente', () => {
  let id: string;

  it('sin presentar: la descarga recalcula como la pantalla (no baja cifras viejas)', async () => {
    await alquiler('2026-02-01', 'A-02');
    const pantalla = await taxModelsService.generarModelo115(E, 2026, 1);
    id = pantalla.id;
    expect(pantalla).toMatchObject({ retencion: 190, periodo: '1T', trimestre: 1 });
    // Otra factura despues de abrir la pantalla: el fichero ya la lleva.
    await alquiler('2026-03-01', 'A-03');
    const txt = (await generarTxtModelo(E, id)).contenido;
    expect(casilla(txt, 141)).toBe(380); // [03]
    const otraVez = await taxModelsService.generarModelo115(E, 2026, 1);
    expect(otraVez.formulario.total.length + otraVez.formulario.bloques.length).toBeGreaterThan(0);
    expect(otraVez.casillas['03']).toBe(casilla(txt, 141));
    expect(otraVez.casillas['05']).toBe(casilla(txt, 175));
  });

  it('presentado: pantalla y fichero dan lo guardado aunque el calculo de hoy sea otro', async () => {
    await taxModelsService.marcarPresentado(E, '115', 2026, '1T', { numero: '1150000000001', fecha: '2026-04-15' }, 'u-ret');
    // Lo que se presento no es lo que sale hoy (p. ej., se corrigio una factura despues).
    const fila = await prisma.modeloImpuesto.findUniqueOrThrow({ where: { id } });
    await prisma.modeloImpuesto.update({ where: { id }, data: { casillas: { ...(fila.casillas as object), '02_base': 1600, '03_retenciones': 304, '05_resultado': 304 } } });
    const pantalla = await taxModelsService.generarModelo115(E, 2026, 1);
    const txt = (await generarTxtModelo(E, id)).contenido;
    expect(pantalla.casillas['03']).toBe(304);
    expect(casilla(txt, 141)).toBe(304);
    expect(casilla(txt, 175)).toBe(304);
    expect(pantalla.avisos).toContainEqual(expect.stringMatching(/^Modelo presentado/));
  });

  it('fila antigua presentada (sin las casillas de ahora): las dos salen de sus datos guardados', async () => {
    await alquiler('2026-05-01', 'A-05');
    const fila = await prisma.modeloImpuesto.create({
      data: {
        companyId: E,
        codigo: '115',
        ejercicio: 2026,
        periodo: '2T',
        estado: 'presentado',
        casillas: { retenciones: 95 },
        datos: { nPerceptores: 1, baseRetenciones: 500, retenciones: 95, resultadoAnteriores: 0, resultadoIngresar: 95 },
      },
    });
    const pantalla = await taxModelsService.generarModelo115(E, 2026, 2);
    const txt = (await generarTxtModelo(E, fila.id)).contenido;
    expect(pantalla.casillas).toMatchObject({ '01': 1, '02': 500, '03': 95, '05': 95 });
    expect([casilla(txt, 124), casilla(txt, 141), casilla(txt, 175)]).toEqual([500, 95, 95]);
  });
});

describe('111: pantalla y fichero, y periodos mensuales', () => {
  it('sin presentar, la descarga recalcula; un mes (05) va con su periodo en el fichero', async () => {
    await honorarios('2026-05-10', 'H-05');
    const mayo = await taxModelsService.generarModelo111(E, 2026, '05');
    expect(mayo).toMatchObject({ periodo: '05', trimestre: null, totalRetenido: 75 });
    expect(mayo.formulario.identificacion.periodo).toBe('05');
    await honorarios('2026-05-20', 'H-05B');
    const txt = (await generarTxtModelo(E, mayo.id)).contenido;
    expect(txt.slice(328 + 106, 328 + 108)).toBe('05'); // periodo, posicion 107
    expect(casilla(txt, 487)).toBe(150); // [28]
    expect((await taxModelsService.generarModelo111(E, 2026, '5')).casillas['28']).toBe(150);
  });

  it('GET /tax-models/111 y /115 con ?periodo=MM; un periodo que no existe es un 400', async () => {
    const r = await request(app()).get(`/companies/${E}/tax-models/111?ejercicio=2026&periodo=05`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ periodo: '05', trimestre: null });
    const t = await request(app()).get(`/companies/${E}/tax-models/115?ejercicio=2026&periodo=2T`);
    expect(t.status).toBe(200);
    expect(t.body.data).toMatchObject({ periodo: '2T', trimestre: 2 });
    const viejo = await request(app()).get(`/companies/${E}/tax-models/111?ejercicio=2026&trimestre=2`);
    expect(viejo.body.data).toMatchObject({ periodo: '2T' });
    const mal = await request(app()).get(`/companies/${E}/tax-models/111?ejercicio=2026&periodo=13`);
    expect(mal.status).toBe(400);
  });

  it('marcar presentado un mes', async () => {
    const r = await request(app()).post(`/companies/${E}/tax-models/111/presentado`).send({ ejercicio: 2026, periodo: '05', justificante: { numero: '1110000000005', fecha: '2026-06-15' } });
    expect(r.status).toBe(200);
    const fila = await prisma.modeloImpuesto.findUniqueOrThrow({ where: { companyId_codigo_ejercicio_periodo: { companyId: E, codigo: '111', ejercicio: 2026, periodo: '05' } } });
    expect(fila.estado).toBe('presentado');
  });
});
