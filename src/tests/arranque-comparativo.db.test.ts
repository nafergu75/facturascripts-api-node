/**
 * Comparativos de 2026 tras traer la contabilidad de la gestoria: la columna
 * N-1 sale de los saldos de la gestoria (regla unica fuenteEjercicioAnterior),
 * el libro de inventarios parte de la apertura importada, los informes de 2026
 * avisan de que son de solo lectura y los de 2027 de la apertura provisional,
 * los modelos de 2026 avisan de que los presenta la gestoria y el 303 del 1T
 * propone las cuotas a compensar escritas en la carga.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import { avisosDeInforme } from '../services/arranque/seguimiento.service';
import { generarLibroInventarios } from '../services/cuentasAnuales.service';
import { saldosDelEjercicio } from '../services/contabilidadDatos.service';
import { fuenteEjercicioAnterior } from '../services/fuenteEjercicioAnterior';
import { informeBalance, informePerdidasGanancias } from '../services/informesContables.service';
import { resolverPeriodo, type Periodo } from '../services/informesContables.calculo';
import { cuotasACompensar303 } from '../services/impuestosModulo.service';
import { calcularEstadosFinancieros } from '../services/impuestoSociedadesCalculo.service';
import { borrarComparativo, confirmarComparativo, guardarSaldosComparativo } from '../services/puestaEnMarcha/puestaEnMarcha.service';
import { avisoModelosGestoria } from '../middleware/avisoGestoria.middleware';
import { sendOk } from '../utils/response';
import { AJUSTES_A, ficherosEmpresaA, ficherosEmpresaB } from './fixtures/arranque/generar';
import { empresaDePrueba, traerCarga } from './fixtures/arranque/importar';

const SUFIJO = Date.now();
const A = `arr-cmp-a-${SUFIJO}`;
const B = `arr-cmp-b-${SUFIJO}`;
const anio = (e: number) => resolverPeriodo({ ejercicio: String(e) }) as Periodo;
const vacio = { balance: new Map<string, number>(), pyg: new Map<string, number>(), resultadoAnteriores: 0 };

beforeAll(async () => {
  await empresaDePrueba(A);
  await empresaDePrueba(B);
  await traerCarga(A, Object.values(ficherosEmpresaA()), AJUSTES_A);
  await traerCarga(B, Object.values(ficherosEmpresaB()), { resultadoDeclarado: 3000, datosFiscales: { resultado303T4: -250, cuotasIvaACompensar: 250 } });
}, 120_000);

describe('la columna N-1 de 2027', () => {
  it('regla única: con 2026 de la gestoría, sus saldos aunque esté el diario; sin llevanza externa, los asientos; si no, el comparativo', async () => {
    const conDiario = saldosDelEjercicio(
      [{ fecha: '2026-05-01', numero: 1, concepto: 'Venta', tipo: 'NORMAL', lineas: [{ subcuenta: '5720000001', debe: 1, haber: 0 }, { subcuenta: '7000000000', debe: 0, haber: 1 }] }],
      2026,
    );
    const a = await fuenteEjercicioAnterior(A, 2026, conDiario);
    expect(a).toMatchObject({ fuente: 'COMPARATIVO', llevanzaExterna: true });
    expect(a.saldos.balance.get('5720000001')).toBe(18630);

    const otra = `arr-cmp-c-${SUFIJO}`;
    await empresaDePrueba(otra);
    expect((await fuenteEjercicioAnterior(otra, 2026, conDiario)).fuente).toBe('ASIENTOS');
    expect((await fuenteEjercicioAnterior(otra, 2026, vacio)).fuente).toBe('NINGUNA');
    await guardarSaldosComparativo(otra, 2026, [{ codigo: '5720000001', nombre: '', saldo: 10 }], 'todo', 'Prueba');
    expect((await fuenteEjercicioAnterior(otra, 2026, vacio)).fuente).toBe('COMPARATIVO');
    expect((await fuenteEjercicioAnterior(otra, 2026, conDiario)).fuente).toBe('ASIENTOS');
  });

  it('balance de 2027: el año 2026 sale del comparativo de la gestoría (empresa B, sin diario)', async () => {
    const r = await informeBalance(B, anio(2027));
    expect(r.anterior.totalActivo).toBe(14500); // 5.000 de clientes y 9.500 de banco
    expect(r.anterior.totalPatrimonioNetoYPasivo).toBe(14500);
    expect(r.tabla.notas).toContain('La columna 2026 sale de los saldos que dio la gestoría (comparativo importado).');
    // El balance de 2027 parte de la apertura: el mismo total.
    expect(r.balance.totalActivo).toBe(14500);
  });

  it('PyG de 2027: el resultado de 2026 es el de la gestoría (empresa A, sin regularizar)', async () => {
    const r = await informePerdidasGanancias(A, anio(2027));
    expect(r.anterior.resultadoEjercicio).toBe(7200);
    expect(r.actual.resultadoEjercicio).toBe(0);
    const e = await calcularEstadosFinancieros(A, 2027);
    expect(e.anterior.pyg.resultadoEjercicio).toBe(7200);
  });

  it('el libro de inventarios de 2027 parte de la apertura importada', async () => {
    const l = await generarLibroInventarios(A, 2027);
    const apertura = new Map(l.balanceApertura.map((x) => [x.codigo, x.importe]));
    expect(apertura.get('5720000001')).toBe(18630);
    expect(apertura.get('2813000000')).toBe(-3000);
    expect(apertura.get('1290000000')).toBe(-7200);
  });
});

describe('avisos de los años de la gestoría y de la apertura provisional', () => {
  it('los informes de 2026 son de solo lectura y los de 2027 llevan la apertura provisional', async () => {
    expect(await avisosDeInforme(A, 2026)).toEqual({
      llevanzaExterna: true,
      aperturaProvisional: false,
      notas: ['2026 lo llevó tu gestoría. Estos datos son los que importaste y no se pueden cambiar.'],
    });
    const a27 = await avisosDeInforme(A, 2027);
    expect(a27).toMatchObject({ llevanzaExterna: false, aperturaProvisional: true });
    expect(a27.notas[0]).toMatch(/^Apertura provisional: los saldos del 1-1-2027/);
  });

  it('los modelos de 2026 avisan de que los presenta la gestoría; los de 2027, no', async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.companyId = A;
      next();
    });
    app.use(avisoModelosGestoria);
    app.get('/modelo', (_req, res) => sendOk(res, { casillas: {} }));
    const r26 = await request(app).get('/modelo?ejercicio=2026');
    expect(r26.body.data.avisoGestoria).toBe('Este modelo de 2026 lo presenta tu gestoría: lo que ves aquí sale solo de lo que hay en la app de 2026. No lo presentes desde aquí.');
    expect(r26.headers['x-aviso-gestoria']).toBeDefined();
    const r27 = await request(app).get('/modelo?ejercicio=2027');
    expect(r27.body.data.avisoGestoria).toBeUndefined();
  });

  it('el 303 del 1T de 2027 propone las cuotas a compensar escritas al traer la carga; el 2T, no', async () => {
    expect(await cuotasACompensar303(B, { ejercicio: 2027, periodo: '1T' })).toEqual({ importe: 250, origen: 'arranque', periodo: '4T de 2026' });
    expect(await cuotasACompensar303(B, { ejercicio: 2027, periodo: '2T' })).toMatchObject({ importe: 0, origen: 'sin-dato' });
    expect(await cuotasACompensar303(A, { ejercicio: 2027, periodo: '1T' })).toMatchObject({ importe: 0, origen: 'sin-dato' });
  });
});

describe('la puesta en marcha no cambia el comparativo que trajo la carga', () => {
  it('ni lo sustituye ni lo borra (409); el de otro año se borra con rastro', async () => {
    const e = await borrarComparativo(B, 2026, 'u-cmp').catch((x) => x);
    expect(e.statusCode).toBe(409);
    expect(e.message).toMatch(/^El comparativo de 2026 lo trajo «Traer la contabilidad de 2026»/);
    const sustituir = await confirmarComparativo(B, { cuentas: [{ codigo: '5720000001', nombre: '', saldo: 1 }] }, { ejercicio: 2026, parte: 'todo' }).catch((x) => x);
    expect(sustituir.statusCode).toBe(409);
    expect(await prisma.priorYearData.count({ where: { companyId: B, ejercicio: 2026 } })).toBe(1);

    await guardarSaldosComparativo(B, 2024, [{ codigo: '5720000001', nombre: '', saldo: 10 }], 'todo', 'Prueba');
    expect(await borrarComparativo(B, 2024, 'u-cmp')).toEqual({ borrado: true });
    expect(await prisma.auditLog.count({ where: { companyId: B, action: 'BORRAR_COMPARATIVO' } })).toBe(1);
  });
});
