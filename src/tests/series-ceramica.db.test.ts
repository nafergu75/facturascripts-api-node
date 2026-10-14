/**
 * La serie B se crea al marcar «Vendo cerámica y materiales de construcción»
 * (Configuración > Facturación), sobre BD real.
 *
 *  - Empresa española nueva que marca la casilla antes de nada: se crean A
 *    (predeterminada), R, P y C, y la B detrás: de facturas, activa, no
 *    predeterminada, sin plantilla elegida (usa sola la B) y con su numeración.
 *  - Idempotente: guardar otra vez no crea otra; dos guardados a la vez, una B.
 *  - Desmarcar no borra ni desactiva la B: pasa a la estándar y dice por qué.
 *  - Una B desactivada no se activa: el PUT trae el aviso para activarla.
 *  - El código B de otro tipo no se toca: aviso.
 *  - Empresa que ya tenía la casilla marcada (antes de esto): el GET de los
 *    ajustes dice «pendiente» sin crear nada; la B llega al abrir las series.
 *  - Empresa extranjera: nunca.
 *  - motivoPlantilla de cada serie (A con o sin IEEPNR, B con o sin cerámica, C).
 *  - Una factura de la A con la casilla del IEEPNR marcada y otra de la C no
 *    cambian por tener la B: su plantilla y su numeración siguen igual.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import ajustesFacturacionRoutes from '../routes/ajustesFacturacion.routes';
import seriesRoutes from '../routes/series.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { asegurarPlanContableEmpresa } from '../services/chart-of-accounts.service';
import { incomeInvoicesService } from '../services/income-invoices.service';

const SUFIJO = Date.now();
const NUEVA = `ser-cer-nueva-${SUFIJO}`;
const DESACT = `ser-cer-desact-${SUFIJO}`;
const OTRO_TIPO = `ser-cer-otrotipo-${SUFIJO}`;
const ANTES = `ser-cer-antes-${SUFIJO}`;
const US = `ser-cer-us-${SUFIJO}`;
const CARRERA = `ser-cer-carrera-${SUFIJO}`;
const FACTURAS = `ser-cer-facturas-${SUFIJO}`;

const app = express();
app.use(express.json());
app.use('/companies/:companyId', (req, _res, next) => {
  req.user = { userId: 'u-admin', roles: ['admin'], rolesPorEmpresa: { [req.params.companyId]: ['admin'] } } as never;
  req.companyId = req.params.companyId;
  next();
});
app.use('/companies/:companyId/ajustes-facturacion', ajustesFacturacionRoutes);
app.use('/companies/:companyId/series', seriesRoutes);
app.use(errorMiddleware);

type SerieResp = {
  id: string;
  codigo: string;
  descripcion: string;
  tipoDocumento: string;
  activa: boolean;
  porDefecto: boolean;
  plantilla: string;
  plantillaElegida: string | null;
  motivoPlantilla: string;
  numeroSiguiente: number;
};
const guardar = (empresa: string, body: object) => request(app).put(`/companies/${empresa}/ajustes-facturacion`).send(body);
const leerAjustes = (empresa: string) => request(app).get(`/companies/${empresa}/ajustes-facturacion`);
const listar = async (empresa: string): Promise<SerieResp[]> => (await request(app).get(`/companies/${empresa}/series`)).body.data;
const filasB = (empresa: string) => prisma.invoiceSeries.findMany({ where: { companyId: empresa, codigo: 'B' } });

beforeAll(async () => {
  for (const id of [NUEVA, DESACT, OTRO_TIPO, ANTES, US, CARRERA, FACTURAS]) {
    await prisma.company.create({ data: { id, name: `Serie ceramica ${id}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  }
  await prisma.legalConfig.create({ data: { companyId: US, denominacion: 'Tiles Inc', nif: '12-3456789', pais: 'US', monedaCuenta: 'USD' } });
});

describe('marcar «Vendo cerámica» crea la serie B', () => {
  it('empresa nueva que lo marca antes de nada: A (predeterminada), R, P y C, y la B detrás, con su plantilla y su numeración', async () => {
    const res = await guardar(NUEVA, { vendeCeramica: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ vendeCeramica: true, serieCeramica: { codigo: 'B', estado: 'creada', aviso: null } });
    const series = await listar(NUEVA);
    expect(series.map((s) => s.codigo).sort()).toEqual(['A', 'B', 'C', 'P', 'R']);
    expect(series.find((s) => s.codigo === 'A')).toMatchObject({ tipoDocumento: 'FACTURA', porDefecto: true, activa: true });
    expect(series.find((s) => s.codigo === 'B')).toMatchObject({
      tipoDocumento: 'FACTURA',
      descripcion: 'Cerámica y materiales de construcción',
      activa: true,
      porDefecto: false,
      plantilla: 'B',
      plantillaElegida: null,
      motivoPlantilla: 'ceramica',
      numeroSiguiente: 1,
    });
    // Solo una predeterminada de facturas: la A.
    expect(series.filter((s) => s.tipoDocumento === 'FACTURA' && s.porDefecto).map((s) => s.codigo)).toEqual(['A']);
  });

  it('idempotente: guardar otra vez (con la casilla ya marcada) no crea otra y dice «activa»; el GET dice lo mismo', async () => {
    const res = await guardar(NUEVA, { textoPie: 'Gracias por su compra' });
    expect(res.body.data.serieCeramica).toEqual({ codigo: 'B', estado: 'activa', aviso: null });
    expect(await filasB(NUEVA)).toHaveLength(1);
    expect((await leerAjustes(NUEVA)).body.data.serieCeramica).toEqual({ codigo: 'B', estado: 'activa', aviso: null });
  });

  it('desmarcar no borra ni desactiva la B: pasa a la estándar y dice que es por la casilla', async () => {
    const res = await guardar(NUEVA, { vendeCeramica: false });
    expect(res.body.data).toMatchObject({ vendeCeramica: false, serieCeramica: null });
    const b = (await listar(NUEVA)).find((s) => s.codigo === 'B');
    expect(b).toMatchObject({ activa: true, plantilla: 'default', plantillaElegida: null, motivoPlantilla: 'sinCeramica' });
    expect(await filasB(NUEVA)).toHaveLength(1);
    // Y al volver a marcarla, vuelve a la B, sin crear otra.
    expect((await guardar(NUEVA, { vendeCeramica: true })).body.data.serieCeramica.estado).toBe('activa');
    expect((await listar(NUEVA)).find((s) => s.codigo === 'B')).toMatchObject({ plantilla: 'B', motivoPlantilla: 'ceramica' });
  });

  it('la B desactivada no se activa sola: el PUT avisa de que hay que activarla en Configuración > Series', async () => {
    await listar(DESACT);
    await prisma.invoiceSeries.create({ data: { companyId: DESACT, codigo: 'B', descripcion: 'Segunda línea', tipoDocumento: 'FACTURA', activa: false } });
    const res = await guardar(DESACT, { vendeCeramica: true });
    expect(res.status).toBe(200);
    expect(res.body.data.serieCeramica).toMatchObject({ codigo: 'B', estado: 'desactivada' });
    expect(res.body.data.serieCeramica.aviso).toMatch(/actívala en Configuración > Series/);
    expect(await filasB(DESACT)).toEqual([expect.objectContaining({ activa: false, descripcion: 'Segunda línea' })]);
  });

  it('el código B de otro tipo no se toca: aviso para crear otra serie de facturas con la plantilla B', async () => {
    await prisma.invoiceSeries.create({ data: { companyId: OTRO_TIPO, codigo: 'B', descripcion: 'Proformas B', tipoDocumento: 'PROFORMA', activa: true, porDefecto: true } });
    const res = await guardar(OTRO_TIPO, { vendeCeramica: true });
    expect(res.body.data.serieCeramica).toMatchObject({ codigo: 'B', estado: 'otroTipo' });
    expect(res.body.data.serieCeramica.aviso).toMatch(/proformas/);
    expect(await filasB(OTRO_TIPO)).toEqual([expect.objectContaining({ tipoDocumento: 'PROFORMA' })]);
    // La A se creó igual y es la predeterminada de facturas.
    expect((await listar(OTRO_TIPO)).find((s) => s.codigo === 'A')).toMatchObject({ tipoDocumento: 'FACTURA', porDefecto: true });
  });

  it('empresa que ya tenía la casilla marcada: el GET dice «pendiente» sin crear nada; la B llega al abrir las series', async () => {
    await listar(ANTES);
    await prisma.ajustesFacturacion.create({ data: { companyId: ANTES, vendeCeramica: true, updatedBy: 'u-antes' } });
    expect((await leerAjustes(ANTES)).body.data.serieCeramica).toEqual({ codigo: 'B', estado: 'pendiente', aviso: null });
    expect(await filasB(ANTES)).toHaveLength(0);
    const b = (await listar(ANTES)).find((s) => s.codigo === 'B');
    expect(b).toMatchObject({ tipoDocumento: 'FACTURA', activa: true, porDefecto: false, plantilla: 'B' });
    expect((await leerAjustes(ANTES)).body.data.serieCeramica.estado).toBe('activa');
  });

  it('empresa extranjera: la casilla no se guarda y la B no se crea', async () => {
    const res = await guardar(US, { vendeCeramica: true });
    expect(res.body.data).toMatchObject({ vendeCeramica: false, serieCeramica: null });
    await listar(US);
    expect(await filasB(US)).toHaveLength(0);
  });

  it('dos guardados a la vez (y las series abiertas a la vez): una sola B y una sola A', async () => {
    // La fila de ajustes ya existe: la carrera es solo la de las series.
    await guardar(CARRERA, { textoPie: 'Pie' });
    const [r1, r2] = await Promise.all([guardar(CARRERA, { vendeCeramica: true }), guardar(CARRERA, { vendeCeramica: true }), listar(CARRERA)]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(await filasB(CARRERA)).toHaveLength(1);
    expect(await prisma.invoiceSeries.count({ where: { companyId: CARRERA, codigo: 'A' } })).toBe(1);
  });
});

describe('motivo de la plantilla y facturas de la A y de la C', () => {
  let cliente = '';
  const linea = { descripcion: 'Servicio', cantidad: 1, precioUnitario: 100, tipoIva: 21 };

  beforeAll(async () => {
    await prisma.legalConfig.create({ data: { companyId: FACTURAS, denominacion: 'Serie Ceramica Facturas SL', nif: 'B11000000' } });
    await asegurarPlanContableEmpresa(FACTURAS);
    cliente = (await prisma.customer.create({ data: { companyId: FACTURAS, nombreFiscal: 'Cliente Series SL', nifCif: 'B12000000' } })).id;
  });

  it('sin casillas: la A y la B (si existe) en la estándar por la casilla; la C, la C por su código; R y P, la estándar', async () => {
    const series = await listar(FACTURAS);
    const motivo = Object.fromEntries(series.map((s) => [s.codigo, [s.plantilla, s.motivoPlantilla]]));
    expect(motivo).toEqual({ A: ['default', 'sinIeepnr'], C: ['C', 'serieC'], P: ['default', 'estandar'], R: ['default', 'estandar'] });
  });

  it('con el IEEPNR y la cerámica marcados, una factura de la A sigue con la A y otra de la C con la C, cada una con su numeración', async () => {
    await guardar(FACTURAS, { ieepnrRepercute: true, vendeCeramica: true });
    const motivo = Object.fromEntries((await listar(FACTURAS)).map((s) => [s.codigo, [s.plantilla, s.motivoPlantilla]]));
    expect(motivo).toMatchObject({ A: ['A', 'ieepnr'], B: ['B', 'ceramica'], C: ['C', 'serieC'] });
    const a = await incomeInvoicesService.crearIngreso({ companyId: FACTURAS, customer: { id: cliente }, serie: 'A', fechaEmision: '2026-10-01', lineas: [linea] });
    const c = await incomeInvoicesService.crearIngreso({ companyId: FACTURAS, customer: { id: cliente }, serie: 'C', fechaEmision: '2026-10-01', lineas: [linea] });
    expect([a.numeroCompleto, a.plantillaId]).toEqual(['A-1', 'A']);
    expect([c.numeroCompleto, c.plantillaId]).toEqual(['C-1', 'C']);
    // La B empieza en 1: no comparte numeración con la A ni con la C.
    expect((await listar(FACTURAS)).find((s) => s.codigo === 'B')).toMatchObject({ numeroSiguiente: 1 });
  });

  it('elegida a mano: «elegida», aunque la casilla diga otra cosa', async () => {
    const b = (await listar(FACTURAS)).find((s) => s.codigo === 'B')!;
    const res = await request(app).put(`/companies/${FACTURAS}/series/${b.id}`).send({ plantilla: 'default' });
    expect(res.body.data).toMatchObject({ plantilla: 'default', plantillaElegida: 'default', motivoPlantilla: 'elegida' });
    // Con otra plantilla elegida, el guardado de los ajustes lo avisa (no la cambia).
    const aviso = await guardar(FACTURAS, { vendeCeramica: true });
    expect(aviso.body.data.serieCeramica).toMatchObject({ estado: 'otraPlantilla' });
    expect(aviso.body.data.serieCeramica.aviso).toMatch(/«Automática» o la «Plantilla B \(cerámica\)»/);
    await request(app).put(`/companies/${FACTURAS}/series/${b.id}`).send({ plantilla: null });
  });
});
