/**
 * Rendimiento de «Traer la contabilidad de 2026»: un plan de 5.000 subcuentas
 * (2.500 clientes y proveedores con NIF) y un diario de 20.000 apuntes. El
 * analisis y cada llamada de la importacion tienen que caber en 30 segundos
 * (el limite que se ha puesto para las funciones de Vercel).
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { aplicarFase, confirmarCarga } from '../services/arranque/aplicar.service';
import { subirYAnalizar } from '../services/arranque/cargas.service';
import { cifDe, filasDiario, libro, sumasYSaldos, type AsientoPrueba, type CuentaPrueba } from './fixtures/arranque/generar';

const SUFIJO = Date.now();
const E = `arr-grande-${SUFIJO}`;
const LIMITE_MS = 30_000;

function datosGrandes() {
  const plan: CuentaPrueba[] = [
    { codigo: '1000000000', nombre: 'Capital social' },
    { codigo: '4770000000', nombre: 'HP IVA repercutido' },
    { codigo: '5720000001', nombre: 'Banco' },
    { codigo: '7000000000', nombre: 'Ventas' },
  ];
  for (let i = 1; i <= 1500; i++) plan.push({ codigo: `430${String(i).padStart(7, '0')}`, nombre: `Cliente ${i} SL`, nif: cifDe(String(5000000 + i)) });
  for (let i = 1; i <= 1000; i++) plan.push({ codigo: `400${String(i).padStart(7, '0')}`, nombre: `Proveedor ${i} SL`, nif: cifDe(String(6000000 + i)) });
  for (let i = 1; plan.length < 5000; i++) plan.push({ codigo: `629${String(i).padStart(7, '0')}`, nombre: `Gasto ${i}` });
  const diario: AsientoPrueba[] = [{ numero: 1, fecha: '2026-01-01', concepto: 'Apertura', lineas: [['5720000001', 100000, 0], ['1000000000', 0, 100000]] }];
  for (let i = 0; i < 4000; i++) {
    const cliente = `430${String((i % 1500) + 1).padStart(7, '0')}`;
    const gasto = `629${String((i % 2400) + 1).padStart(7, '0')}`;
    const mes = String((i % 12) + 1).padStart(2, '0');
    diario.push({
      numero: i + 2,
      fecha: `2026-${mes}-15`,
      concepto: `Fra. ${i}`,
      lineas: [
        [cliente, 121, 0],
        [gasto, 10, 0],
        ['7000000000', 0, 100],
        ['4770000000', 0, 21],
        ['5720000001', 0, 10],
      ],
    });
  }
  const saldos = sumasYSaldos(diario, plan);
  return {
    ficheros: [
      { nombre: 'plan.xlsx', contenido: libro([['Plan', [['Cuenta', 'Descripción', 'NIF'], ...plan.map((c) => [c.codigo, c.nombre, c.nif ?? ''])]]]) },
      { nombre: 'sys.xlsx', contenido: libro([['SyS', [['Sumas y saldos a 31/12/2026'], ['Cuenta', 'Descripción', 'Saldo deudor', 'Saldo acreedor'], ...saldos.map((s) => [s.codigo, s.nombre, s.saldo > 0 ? s.saldo : 0, s.saldo < 0 ? -s.saldo : 0])]]]) },
      { nombre: 'diario.xlsx', contenido: libro([['Diario', filasDiario(diario, plan)]]) },
    ],
    apuntes: diario.reduce((s, a) => s + a.lineas.length, 0),
    asientos: diario.length,
  };
}

describe('carga grande', () => {
  beforeAll(async () => {
    await prisma.company.create({ data: { id: E, name: 'Grande', fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
    await prisma.legalConfig.create({ data: { companyId: E, denominacion: 'Grande', nif: 'B10000000' } });
  });

  it('5.000 subcuentas y 20.000 apuntes: análisis y cada fase en menos de 30 s', async () => {
    const d = datosGrandes();
    expect(d.apuntes).toBeGreaterThanOrEqual(20000);
    let t = Date.now();
    const r = await subirYAnalizar(E, 2027, 'u-grande', d.ficheros, { resultadoDeclarado: 360000 }, { cliente: true, proveedor: true });
    const analisis = Date.now() - t;
    expect(r.vista.historico).toMatchObject({ asientos: d.asientos, cuadraConSumasYSaldos: true });
    expect(r.vista.terceros.resumen.crear).toBe(2500);
    expect(r.vista.comprobaciones.puntos.filter((p) => p.nivel === 'ERROR')).toEqual([]);
    t = Date.now();
    await confirmarCarga(E, 2027, r.carga.id, r.vista.huella, 'u-grande');
    const tiempos: Array<[string, number]> = [['analisis', analisis], ['confirmar', Date.now() - t]];
    for (let i = 0; i < 80; i++) {
      t = Date.now();
      const f = await aplicarFase(E, 2027, r.carga.id, 'u-grande');
      tiempos.push([f.fase, Date.now() - t]);
      if (f.terminada) break;
    }
    console.log(`[medida] ${tiempos.map(([f, ms]) => `${f} ${ms} ms`).join(', ')}`);
    for (const [, ms] of tiempos) expect(ms).toBeLessThan(LIMITE_MS);
    expect(await prisma.customer.count({ where: { companyId: E } })).toBe(1500);
    expect(await prisma.journalEntry.count({ where: { companyId: E, estado: 'POSTED', origen: { startsWith: 'HISTORICO' } } })).toBe(d.asientos);
    expect((await prisma.cargaArranque.findUniqueOrThrow({ where: { id: r.carga.id }, select: { estado: true } })).estado).toBe('CONFIRMADA');
  }, 900_000);
});
