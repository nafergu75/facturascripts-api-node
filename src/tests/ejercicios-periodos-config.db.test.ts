/**
 * Configuración > Ejercicios y periodos, sobre BD real.
 *
 *  - GET /fiscal-years: estado único (ABIERTO, CERRADO, CERRADO_SIN_ASIENTOS).
 *  - POST /fiscal-years/:fyId/reabrir: solo admin de empresa y solo los
 *    cerrados sin asientos (los cerraba el botón de Registro Mercantil).
 *  - PUT /periodos/:mes/estado: solo bloquear o desbloquear; un mes cerrado o
 *    un ejercicio cerrado no se desbloquea; con el 303/111 presentado, pide
 *    confirmación.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import fiscalYearsRoutes from '../routes/fiscalYears.routes';
import periodosRoutes from '../routes/periodos.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { estadoEfectivoEjercicio } from '../services/fiscalYears.service';

const SUFIJO = Date.now();
const EMPRESA = `ejer-conf-${SUFIJO}`;
const OTRA = `ejer-conf-otra-${SUFIJO}`;

let rol = 'admin';
const app = express();
app.use(express.json());
app.use('/companies/:companyId', (req, _res, next) => {
  req.user = { userId: `u-${rol}`, roles: [rol], rolesPorEmpresa: { [req.params.companyId]: [rol] } } as never;
  req.companyId = req.params.companyId;
  next();
});
app.use('/companies/:companyId/fiscal-years', fiscalYearsRoutes);
app.use('/companies/:companyId/periodos', periodosRoutes);
app.use(errorMiddleware);

const base = `/companies/${EMPRESA}`;
const ids: Record<string, string> = {};

async function asientoCierre(fecha: string, numero: string) {
  await prisma.journalEntry.create({
    data: { companyId: EMPRESA, fecha: new Date(`${fecha}T00:00:00Z`), numeroAsiento: numero, descripcion: 'Cierre', origen: 'CIERRE', estado: 'POSTED' },
  });
}

beforeAll(async () => {
  for (const id of [EMPRESA, OTRA]) {
    await prisma.company.create({ data: { id, name: id, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  }
  const fy = (label: string, estado: string, companyId = EMPRESA) =>
    prisma.fiscalYear
      .create({ data: { companyId, label, fechaInicio: `${label}-01-01`, fechaFin: `${label}-12-31`, estado, closingDate: estado === 'CLOSED' ? `${label}-12-31` : null } })
      .then((f) => f.id);
  ids.abierto = await fy('2020', 'OPEN');
  ids.sinAsientos = await fy('2021', 'CLOSED');
  ids.cerrado = await fy('2022', 'CLOSED');
  ids.abiertoConAsientos = await fy('2019', 'OPEN');
  ids.otra = await fy('2021', 'CLOSED', OTRA);
  await asientoCierre('2022-12-31', `CIE-2022-${SUFIJO}`);
  await asientoCierre('2019-12-31', `CIE-2019-${SUFIJO}`);
  // Libros del ejercicio cerrado sin asientos: uno pendiente sin fichero y otro ya generado.
  await prisma.legalBook.create({ data: { companyId: EMPRESA, fiscalYearId: ids.sinAsientos, type: 'DIARIO', filePath: '', hash: '', status: 'PENDING' } });
  await prisma.legalBook.create({ data: { companyId: EMPRESA, fiscalYearId: ids.sinAsientos, type: 'ACTAS', filePath: 'x.pdf', hash: 'h', status: 'GENERATED' } });
});

describe('GET /fiscal-years: estado único', () => {
  it('ABIERTO, CERRADO y CERRADO_SIN_ASIENTOS', async () => {
    rol = 'solo_lectura';
    const res = await request(app).get(`${base}/fiscal-years`);
    rol = 'admin';
    expect(res.status).toBe(200);
    const por = Object.fromEntries(res.body.data.map((f: { label: string; estadoEfectivo: string; tieneAsientosCierre: boolean }) => [f.label, [f.estadoEfectivo, f.tieneAsientosCierre]]));
    expect(por).toEqual({
      '2022': ['CERRADO', true],
      '2021': ['CERRADO_SIN_ASIENTOS', false],
      '2020': ['ABIERTO', false],
      '2019': ['CERRADO', true], // abierto pero con asientos de cierre: cuenta como cerrado
    });
  });

  it('estadoEfectivoEjercicio (puro)', () => {
    expect(estadoEfectivoEjercicio('OPEN', false)).toBe('ABIERTO');
    expect(estadoEfectivoEjercicio('CLOSED', false)).toBe('CERRADO_SIN_ASIENTOS');
    expect(estadoEfectivoEjercicio('CLOSED', true)).toBe('CERRADO');
  });
});

describe('POST /fiscal-years/:fyId/reabrir', () => {
  const reabrir = (fyId: string) => request(app).post(`${base}/fiscal-years/${fyId}/reabrir`);

  it('el contable no puede (solo el administrador de la empresa)', async () => {
    rol = 'contable';
    expect((await reabrir(ids.sinAsientos)).status).toBe(403);
    rol = 'admin';
  });

  it('con asientos de cierre: 409 y remite a Cierre y traspaso de saldos', async () => {
    const res = await reabrir(ids.cerrado);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Cierre y traspaso de saldos/);
    expect(res.body.details.enlace).toBe('/dashboard/contabilidad/cierre-ejercicio?ejercicio=2022');
  });

  it('uno abierto: 409; uno de otra empresa: 404', async () => {
    expect((await reabrir(ids.abierto)).status).toBe(409);
    expect((await reabrir(ids.otra)).status).toBe(404);
  });

  it('el cerrado sin asientos se reabre: plazos fuera, libros pendientes fuera, el generado se queda', async () => {
    const res = await reabrir(ids.sinAsientos);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ estado: 'OPEN', estadoEfectivo: 'ABIERTO', closingDate: null, asientosBloqueados: false, librosPendientesBorrados: 1 });
    const libros = await prisma.legalBook.findMany({ where: { fiscalYearId: ids.sinAsientos } });
    expect(libros.map((l) => l.status)).toEqual(['GENERATED']);
    expect(await prisma.auditLog.count({ where: { companyId: EMPRESA, action: 'REOPEN_FISCAL_YEAR_SIN_ASIENTOS', resourceId: ids.sinAsientos } })).toBe(1);
    // Una segunda vez ya está abierto.
    expect((await reabrir(ids.sinAsientos)).status).toBe(409);
  });
});

describe('periodos', () => {
  const cambiar = (mes: number, ejercicio: number, body: object) => request(app).put(`${base}/periodos/${mes}/estado?ejercicio=${ejercicio}`).send(body);

  it('dos lecturas a la vez de un año nuevo no dan 500', async () => {
    const [a, b] = await Promise.all([request(app).get(`${base}/periodos?ejercicio=2024`), request(app).get(`${base}/periodos?ejercicio=2024`)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.data).toHaveLength(12);
    expect(a.body.data[0]).toMatchObject({ mes: 1, estado: 'abierto', modelosPresentados: [] });
  });

  it('a mano solo se bloquea o se desbloquea (cerrado: 400)', async () => {
    const res = await cambiar(3, 2024, { estado: 'cerrado' });
    expect([res.status, res.body.details]).toEqual([400, { campo: 'estado' }]);
    expect((await cambiar(3, 2024, { estado: 'bloqueado' })).body.data.estado).toBe('bloqueado');
    expect((await cambiar(3, 2024, { estado: 'abierto' })).body.data.estado).toBe('abierto');
  });

  it('el contable bloquea; el de solo lectura no', async () => {
    rol = 'solo_lectura';
    expect((await cambiar(4, 2024, { estado: 'bloqueado' })).status).toBe(403);
    rol = 'contable';
    expect((await cambiar(4, 2024, { estado: 'bloqueado' })).status).toBe(200);
    rol = 'admin';
  });

  it('un mes de un ejercicio cerrado no se desbloquea (409); bloquear sí se puede', async () => {
    expect((await cambiar(6, 2022, { estado: 'bloqueado' })).status).toBe(200);
    const res = await cambiar(6, 2022, { estado: 'abierto' });
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ motivo: 'ejercicio_cerrado' });
  });

  it('un mes cerrado por el cierre no se toca a mano (409)', async () => {
    await prisma.periodo.update({ where: { companyId_ejercicio_mes: { companyId: EMPRESA, ejercicio: 2024, mes: 12 } }, data: { estado: 'cerrado' } });
    const res = await cambiar(12, 2024, { estado: 'bloqueado' });
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ motivo: 'periodo_cerrado' });
  });

  it('con el 303 del trimestre presentado: pide confirmación y luego avisa', async () => {
    await prisma.modeloImpuesto.create({ data: { companyId: EMPRESA, codigo: '303', ejercicio: 2024, periodo: '2T', estado: 'presentado' } });
    await cambiar(5, 2024, { estado: 'bloqueado' });
    const lista = await request(app).get(`${base}/periodos?ejercicio=2024`);
    expect(lista.body.data.find((p: { mes: number }) => p.mes === 5).modelosPresentados).toEqual(['303 2T']);

    const sin = await cambiar(5, 2024, { estado: 'abierto' });
    expect(sin.status).toBe(409);
    expect(sin.body.details).toEqual({ aviso: 'modelo_presentado', modelosPresentados: ['303 2T'] });
    expect((await prisma.periodo.findUnique({ where: { companyId_ejercicio_mes: { companyId: EMPRESA, ejercicio: 2024, mes: 5 } } }))!.estado).toBe('bloqueado');

    const con = await cambiar(5, 2024, { estado: 'abierto', confirmar: true });
    expect(con.status).toBe(200);
    expect(con.body.data).toMatchObject({ estado: 'abierto', aviso: 'modelo_presentado', modelosPresentados: ['303 2T'] });
  });
});
