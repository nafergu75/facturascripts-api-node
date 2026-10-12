/**
 * 347 de 2027 y cobros en efectivo de facturas de 2026 que trajo la gestoria
 * pendientes: si a un cliente se le cobran en caja mas de 6.000 € en el año,
 * el 347 avisa para escribir el «importe percibido en metalico» con el
 * ejercicio de la operacion (la app no lo añade sola).
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { prisma } from '../config/database';
import { liquidarPartida } from '../services/arranque/partidas.service';
import { calcularModelo347 } from '../services/impuestosCalculo.service';
import { AJUSTES_A, ficherosEmpresaA, NIF } from './fixtures/arranque/generar';
import { empresaDePrueba, traerCarga, USUARIO_PRUEBA } from './fixtures/arranque/importar';

const E = `arr-347-caja-${Date.now()}`;
const partida = (doc: string) => prisma.partidaPendiente.findFirstOrThrow({ where: { companyId: E, numeroDocumento: doc } });

beforeAll(async () => {
  await empresaDePrueba(E);
  await traerCarga(E, Object.values(ficherosEmpresaA()), AJUSTES_A);
  jest.useFakeTimers({
    now: new Date('2027-02-10T10:00:00Z'),
    doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
  });
}, 120_000);

afterAll(() => {
  jest.useRealTimers();
});

describe('347 con cobros en efectivo de facturas de 2026 pendientes', () => {
  it('hasta 6.000 € en caja por cliente, nada que avisar', async () => {
    await liquidarPartida(E, (await partida('A-2026-001')).id, { fecha: '2027-01-25', importe: 1000, caja: true }, USUARIO_PRUEBA);
    expect((await calcularModelo347(E, 2027)).advertencias ?? []).toEqual([]);
  });

  it('más de 6.000 € en caja a un cliente: aviso con el importe y el ejercicio de la operación', async () => {
    await liquidarPartida(E, (await partida('A-2026-002')).id, { fecha: '2027-01-26', caja: true }, USUARIO_PRUEBA);
    const avisos = (await calcularModelo347(E, 2027)).advertencias ?? [];
    expect(avisos).toEqual([
      `Cliente Beta SA (${NIF.beta}): 6.050,00 € cobrados en efectivo en 2027 de facturas de 2026 que trajo la gestoría pendientes. Van en este 347 como «importe percibido en metálico», con el ejercicio 2026: la app no los añade sola, escríbelos antes de presentar.`,
    ]);
  });
});
