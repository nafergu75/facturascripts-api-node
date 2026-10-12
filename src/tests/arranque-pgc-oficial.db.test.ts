/**
 * Traer la contabilidad de 2026 con un plan que solo trae subcuentas (como el
 * SUBCTA.DBF de ContaPlus o el listado de subcuentas de a3) de cuentas del PGC
 * que la app no tiene de serie: 211, 281, 130, 746, 260, 710, 350. Se crean con
 * su cuenta de 3 digitos y su subgrupo oficiales y la carga se puede confirmar.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { subirYAnalizar } from '../services/arranque/cargas.service';
import { PGC_OFICIAL } from '../domain/pgc-oficial';
import { PGC_BASE } from '../domain/pgc-model';
import { dbf, filasSumasYSaldos, libro } from './fixtures/arranque/generar';
import { empresaDePrueba, traerCarga, TODOS, USUARIO_PRUEBA } from './fixtures/arranque/importar';

const SUFIJO = Date.now();

const SUBCUENTAS: Array<[string, string, number]> = [
  ['1000000000', 'Capital social', -80000],
  ['1300000000', 'Subvención nave Generalitat', -20000],
  ['2110000000', 'Nave industrial', 100000],
  ['2600000000', 'Fianza local', 1500],
  ['2811000000', 'A.A. construcciones', -10000],
  ['3500000000', 'Productos terminados', 500],
  ['5720000001', 'Banco', 8500],
  ['6810000000', 'Amortización inmovilizado material', 2000],
  ['7100000000', 'Variación de existencias de productos en curso', -500],
  ['7460000000', 'Subvenciones de capital traspasadas', -2000],
];

const sys = (filas: Array<[string, string, number]>) =>
  libro([['SyS', filasSumasYSaldos(filas.map(([codigo, nombre, saldo]) => ({ codigo, nombre, debe: Math.max(saldo, 0), haber: Math.max(-saldo, 0), saldo })), 'Sumas y saldos')]]);

const subcta = () => ({ nombre: 'SUBCTA.DBF', contenido: dbf([['COD', 'TITULO', 'NIF'], ...SUBCUENTAS.map(([c, n]) => [c, n, ''])]) });

describe('cuadro oficial del PGC', () => {
  it('trae todas las cuentas del plan base de la app (de 2 y 3 digitos) y las que faltaban', () => {
    for (const n of PGC_BASE) if (n.code.length === 2 || n.code.length === 3) expect(PGC_OFICIAL.has(n.code)).toBe(true);
    for (const c of ['13', '130', '211', '26', '260', '281', '282', '71', '710', '746', '48', '480']) expect(PGC_OFICIAL.has(c)).toBe(true);
    expect(PGC_OFICIAL.has('139')).toBe(false);
  });
});

describe('plan con solo subcuentas de cuentas que la app no trae de serie', () => {
  const E = `arr-pgc-${SUFIJO}`;
  beforeAll(async () => {
    await empresaDePrueba(E);
  });

  it('el analisis no deja ninguna sin madre y se puede confirmar', async () => {
    const r = await subirYAnalizar(E, 2027, USUARIO_PRUEBA, [subcta(), { nombre: 'sys.xlsx', contenido: sys(SUBCUENTAS) }], undefined, TODOS);
    const claves = r.vista.comprobaciones.puntos.map((p) => p.clave);
    expect(claves).not.toContain('plan:sin-madre');
    expect(r.vista.puedeConfirmar).toBe(true);
    expect(r.vista.plan.omitidas).toEqual([]);
    // Se crean las cuentas de 3 digitos y los subgrupos que faltaban.
    const nuevas = new Set(r.vista.plan.nuevasMuestra.map((c) => c.codigo));
    for (const c of ['13', '130', '211', '26', '260', '281', '746', '71', '710']) expect(nuevas.has(c)).toBe(true);
  });

  it('al importar quedan con su madre, su nombre oficial y su naturaleza', async () => {
    const borrador = await prisma.cargaArranque.findFirst({ where: { companyId: E, estado: 'BORRADOR' } });
    if (borrador) await prisma.cargaArranque.delete({ where: { id: borrador.id } });
    await traerCarga(E, [subcta(), { nombre: 'sys.xlsx', contenido: sys(SUBCUENTAS) }]);
    const cuentas = await prisma.chartOfAccounts.findMany({ where: { companyId: E } });
    const de = new Map(cuentas.map((c) => [c.codigo, c]));
    for (const [codigo] of SUBCUENTAS) {
      const c = de.get(codigo);
      expect(c).toBeDefined();
      expect(c!.parentCodigo).toBe(codigo.slice(0, 3));
    }
    expect(de.get('130')).toMatchObject({ nombre: 'Subvenciones oficiales de capital', naturaleza: 'PATRIMONIO_NETO', parentCodigo: '13', esBasePGC: true });
    expect(de.get('13')).toMatchObject({ parentCodigo: '1', nivel: 2 });
    expect(de.get('281')).toMatchObject({ nombre: 'Amortización acumulada del inmovilizado material', parentCodigo: '28' });
    expect(de.get('746')).toMatchObject({ naturaleza: 'INGRESO', tipoUso: 'PYG' });
    expect(de.get('260')).toMatchObject({ parentCodigo: '26' });
    // La apertura lleva las subcuentas de balance (y no las de 6 y 7).
    const apertura = await prisma.journalEntryLine.findMany({ where: { companyId: E, entry: { origen: 'APERTURA', estado: 'POSTED' } } });
    const codigos = new Set(apertura.map((l) => l.accountCode));
    for (const c of ['1300000000', '2110000000', '2600000000', '2811000000', '3500000000']) expect(codigos.has(c)).toBe(true);
  });

  it('una cuenta que no es del PGC (139) sigue sin encajar', async () => {
    const E2 = `${E}-b`;
    await empresaDePrueba(E2);
    const conRara: Array<[string, string, number]> = SUBCUENTAS.map(([c, n, s]) => (c === '1300000000' ? ['1390000000', 'Cuenta rara', s] : [c, n, s]));
    const r = await subirYAnalizar(
      E2,
      2027,
      USUARIO_PRUEBA,
      [{ nombre: 'SUBCTA.DBF', contenido: dbf([['COD', 'TITULO', 'NIF'], ...conRara.map(([c, n]) => [c, n, ''])]) }, { nombre: 'sys.xlsx', contenido: sys(conRara) }],
      undefined,
      TODOS,
    );
    expect(r.vista.comprobaciones.puntos.map((p) => p.clave)).toContain('plan:sin-madre');
    expect(r.vista.plan.omitidas.map((o) => o.codigo)).toContain('1390000000');
  });
});
