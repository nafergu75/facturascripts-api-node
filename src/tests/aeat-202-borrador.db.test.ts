/**
 * Borrador del 202 sobre BD real (modalidad A, art. 40.2 LIS) en los tres
 * periodos de 2027:
 *  - 1P: la base es la cuota del 200 de 2025, presentado fuera de la app:
 *    se indica a mano;
 *  - 2P y 3P: la cuota liquida del 200 de 2026 presentado en la app;
 *  - tipo de gravamen y marcas segun la cifra de negocios de 2026 (reducida
 *    dimension: 22 % en 2027);
 *  - complementaria con domiciliacion; sin base, declaracion negativa;
 *  - con mas de 6 millones de cifra de negocios, modalidad B: sin fichero;
 *  - el calendario crea los tres 202 con sus plazos y el TXT del modulo de
 *    Impuestos es el mismo fichero.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import borradoresAeatRoutes from '../routes/borradores-aeat.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { controlCif } from '../utils/nif';
import { DISENO_202 } from '../domain/aeat/disenos';
import { comprobarFicheroPorTrozos, posiciones } from './dorado-dr';
import { calcularBorrador202, ficheroModelo202 } from '../services/borradoresAeat/borrador202.service';
import { autorrellenarModelo, generarTxtModelo, listarModelosImpuesto } from '../services/impuestosModulo.service';

const SUFIJO = `${Date.now()}`;
const NIF = `B4655555${controlCif('4655555').cifra}`;
const P01 = 328;
const P02 = 328 + 700;

function app(companyId: string) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { userId: 'u-202', roles: ['contable'], companies: [companyId], rolesPorEmpresa: { [companyId]: ['contable'] } } as never;
    req.companyId = companyId;
    next();
  });
  a.use('/companies/:companyId/tax-models', borradoresAeatRoutes);
  a.use(errorMiddleware);
  return a;
}

let n = 0;
async function empresa(incn2026: number): Promise<string> {
  const id = `aeat202-${SUFIJO}-${++n}`;
  await prisma.company.create({ data: { id, name: 'Biotec Turia SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: id, denominacion: 'Biotec Turia, S.L.', nif: NIF, cnae: '72.11', telefono: '963000222', tipoSociedad: 'SL' } });
  await prisma.priorYearData.create({ data: { companyId: id, ejercicio: 2026, estado: 'CONFIRMADO', ingresos: incn2026 } });
  return id;
}

describe('202 de 2027, modalidad A', () => {
  let E: string;

  beforeAll(async () => {
    E = await empresa(2_500_000);
    await prisma.modeloImpuesto.create({
      data: { companyId: E, codigo: '200', ejercicio: 2026, periodo: '0A', estado: 'presentado', datos: { cuotaLiquida: 12345.67, pyg: { importeNetoCifraNegocios: 2500000 } } as never },
    });
    await prisma.bankAccount.create({ data: { companyId: E, iban: 'ES9121000418450200051332', subcuentaCodigo: '572000' } });
  });

  it('1P sin el 200 de 2025: aviso, todo a cero y declaración negativa', async () => {
    const b = await calcularBorrador202(E, 2027, '1P');
    expect(b.base).toEqual({ origen: 'ninguno', ejercicio200: 2025, importe: 0 });
    expect(b.avisos.join(' ')).toMatch(/No hay un 200 de 2025/);
    expect(b.entrada).toMatchObject({ tipoDeclaracion: 'N', casillas: { '01': 0, '02': 0, '03': 0 } });
    expect(b.errores).toEqual([]);
  });

  it('1P con la base a mano: 18 % de 10.000', async () => {
    const r = await request(app(E)).put(`/companies/${E}/tax-models/202/opciones`).send({ ejercicio: 2027, periodo: '1P', baseManual: 10000 });
    expect(r.status).toBe(200);
    expect(r.body.data.base).toEqual({ origen: 'manual', ejercicio200: 2025, importe: 10000 });
    const c = Object.fromEntries(r.body.data.pantalla.pagina01.map((x: { id: string; valor: unknown }) => [x.id, x.valor]));
    expect(c).toMatchObject({ tipoDeclaracion: 'I', modalidad: 'A', c01: 10000, c02: 0, c03: 1800, marcaErd: 'X', tipoGravamen: '22', cnae: '7211', periodo: '1P' });
  });

  it.each([
    ['2P', '00000000001234567', '00000000000222222'],
    ['3P', '00000000001234567', '00000000000222222'],
  ])('%s: la cuota líquida del 200 de 2026 presentado en la app', async (periodo, c01, c03) => {
    const b = await calcularBorrador202(E, 2027, periodo);
    expect(b.base).toEqual({ origen: 'modelo200', ejercicio200: 2026, importe: 12345.67 });
    expect(b.errores).toEqual([]);
    const { contenido, nombre } = await ficheroModelo202(E, 2027, periodo);
    expect(nombre).toBe(`202_2027_${periodo}.txt`);
    const trozos = comprobarFicheroPorTrozos(DISENO_202, contenido, ['cabecera', 'pagina01', 'pagina02', 'cierre']);
    expect(posiciones(contenido, 1, 22)).toBe(`<T20202027${periodo}0000><AUX>`);
    expect(posiciones(contenido, P01 + 1, P01 + 22)).toBe(`<T20201000> I${NIF}`);
    expect(posiciones(contenido, P01 + 104, P01 + 121)).toBe(`2027${periodo}010120277211`);
    expect(posiciones(contenido, P01 + 149, P01 + 165)).toBe(c01);
    expect(posiciones(contenido, P01 + 183, P01 + 199)).toBe(c03);
    expect(posiciones(contenido, 1929, 1946)).toBe(`</T20202027${periodo}0000>`);
    expect(trozos.pagina01.campos).toMatchObject({ modalidad: 'A', c03: 2222.22 });
  });

  it('3P complementaria con domiciliación: [02], U, justificante e IBAN', async () => {
    const r = await request(app(E))
      .put(`/companies/${E}/tax-models/202/opciones`)
      .send({ ejercicio: 2027, periodo: '3P', complementaria: true, resultadoAnterior: 1000, justificanteAnterior: '2020000000001', domiciliar: true });
    expect(r.status).toBe(200);
    const { contenido } = await ficheroModelo202(E, 2027, '3P');
    expect(posiciones(contenido, P01 + 13, P01 + 13)).toBe('U');
    expect(posiciones(contenido, P01 + 166, P01 + 199)).toBe('00000000000100000' + '00000000000122222');
    expect(posiciones(contenido, P02 + 712, P02 + 759)).toBe('X2020000000001' + 'ES9121000418450200051332'.padEnd(34));
    await request(app(E)).put(`/companies/${E}/tax-models/202/opciones`).send({ ejercicio: 2027, periodo: '3P', complementaria: false, resultadoAnterior: null, justificanteAnterior: null, domiciliar: false });
  });

  it('opciones no válidas: 400', async () => {
    const put = (body: object) => request(app(E)).put(`/companies/${E}/tax-models/202/opciones`).send({ ejercicio: 2027, periodo: '2P', ...body });
    expect((await put({ baseManual: -5 })).status).toBe(400);
    expect((await put({ modalidad: 'C' })).status).toBe(400);
    expect((await put({ justificanteAnterior: '123' })).status).toBe(400);
    expect((await request(app(E)).put(`/companies/${E}/tax-models/202/opciones`).send({ ejercicio: 2027, periodo: '4P' })).status).toBe(400);
  });

  it('el calendario de 2027 tiene los tres 202 con sus plazos, y el TXT del módulo es el mismo fichero', async () => {
    const lista = await listarModelosImpuesto(E, 2027, 'activos');
    const de202 = lista.filter((m) => m.codigo === '202').map((m) => [m.periodo, m.fechaVencimiento, m.periodoEtiqueta]);
    expect(de202).toEqual([
      ['1P', '2027-04-20', '2027-1P'],
      ['2P', '2027-10-20', '2027-2P'],
      ['3P', '2027-12-20', '2027-3P'],
    ]);
    expect(lista.find((m) => m.codigo === '180')?.fechaVencimiento).toBe('2028-01-31');
    const fila = await prisma.modeloImpuesto.findFirstOrThrow({ where: { companyId: E, codigo: '202', ejercicio: 2027, periodo: '2P' } });
    const detalle = await autorrellenarModelo(E, fila.id);
    expect(detalle.casillas).toMatchObject({ '01': 12345.67, '03': 2222.22 });
    const txt = await generarTxtModelo(E, fila.id);
    expect(txt.contenido).toBe((await ficheroModelo202(E, 2027, '2P')).contenido);
    // El autorrelleno conserva las opciones de la declaracion.
    const p1 = await prisma.modeloImpuesto.findFirstOrThrow({ where: { companyId: E, codigo: '202', ejercicio: 2027, periodo: '1P' } });
    await autorrellenarModelo(E, p1.id);
    expect((await calcularBorrador202(E, 2027, '1P')).base.origen).toBe('manual');
  });
});

describe('202 con más de 6 millones de cifra de negocios', () => {
  it('modalidad B obligatoria: la app no la calcula y no da fichero', async () => {
    const E = await empresa(7_000_000);
    const b = await calcularBorrador202(E, 2027, '2P');
    expect(b.errores[0]).toMatch(/pasa de 6 millones.*modalidad B/);
    expect(b.entrada.marcas).toMatchObject({ marcaIncnMas6M: true, marcaErd: true });
    await expect(ficheroModelo202(E, 2027, '2P')).rejects.toThrow(/modalidad B/);
  });
});
