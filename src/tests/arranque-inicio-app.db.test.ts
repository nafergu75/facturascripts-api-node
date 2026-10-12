/**
 * La carga que deja 2026 como «lo llevó la gestoría» fija tambien desde cuando
 * se llevan los impuestos con la app (AjustesFiscales.inicioEnApp) en el
 * 1-1-2027, si la empresa no habia indicado otra fecha. Sin eso, el diario de
 * 2026 importado haria que la app contara desde el 1-1-2026 y los 303 de 2026
 * saldrian pendientes. Al deshacer la carga vuelve el valor de antes. Una fecha
 * ya indicada no se toca.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll, afterEach } from '@jest/globals';
import { prisma } from '../config/database';
import { deshacerCarga } from '../services/arranque/deshacer.service';
import { listarModelosImpuesto } from '../services/impuestosModulo.service';
import { inicioLlevanzaApp } from '../utils/anios';
import { AJUSTES_A, ficherosEmpresaA } from './fixtures/arranque/generar';
import { empresaDePrueba, traerCarga, USUARIO_PRUEBA } from './fixtures/arranque/importar';
import { relojEn, relojReal } from './reloj-falso';

const SUFIJO = Date.now();
const SIN_FECHA = `arr-ini-a-${SUFIJO}`;
const CON_FECHA = `arr-ini-b-${SUFIJO}`;

const claves = (lista: Array<{ codigo: string; periodo: string }>) => lista.map((m) => `${m.codigo}:${m.periodo}`);

afterEach(relojReal);

describe('inicio en la app al traer la contabilidad de 2026', () => {
  let carga = '';
  let confirmacionSinFecha = '';
  let confirmacionConFecha = '';
  beforeAll(async () => {
    await empresaDePrueba(SIN_FECHA);
    const sin = await traerCarga(SIN_FECHA, Object.values(ficherosEmpresaA()), AJUSTES_A);
    carga = sin.r.carga.id;
    confirmacionSinFecha = sin.r.vista.confirmacion;
    await empresaDePrueba(CON_FECHA);
    await prisma.ajustesFiscales.create({ data: { companyId: CON_FECHA, inicioEnApp: '2026-07-01' } });
    confirmacionConFecha = (await traerCarga(CON_FECHA, Object.values(ficherosEmpresaA()), AJUSTES_A)).r.vista.confirmacion;
  }, 180_000);

  it('el resumen previo dice que fijará el inicio de los impuestos, solo si no estaba indicado', () => {
    const frase = 'Los impuestos se llevarán en la app desde el 1-1-2027: los modelos de 2026 los presentó la gestoría y no saldrán como pendientes.';
    expect(confirmacionSinFecha).toContain(frase);
    expect(confirmacionConFecha).not.toContain(frase);
  });

  it('sin fecha indicada, la carga la fija en el 1-1-2027 y los 303 de 2026 no salen pendientes', async () => {
    expect((await prisma.ajustesFiscales.findUniqueOrThrow({ where: { companyId: SIN_FECHA } })).inicioEnApp).toBe('2027-01-01');
    expect(await inicioLlevanzaApp(SIN_FECHA)).toBe('2027-01-01');
    relojEn('2027-02-15T10:00:00Z');
    expect(claves(await listarModelosImpuesto(SIN_FECHA, 2026)).filter((c) => c.startsWith('303:'))).toEqual([]);
    expect(claves(await listarModelosImpuesto(SIN_FECHA, 2027))).toEqual(expect.arrayContaining(['303:1T']));
  });

  it('con una fecha ya indicada, la carga no la cambia', async () => {
    expect((await prisma.ajustesFiscales.findUniqueOrThrow({ where: { companyId: CON_FECHA } })).inicioEnApp).toBe('2026-07-01');
    const c = await prisma.cargaArranque.findFirstOrThrow({ where: { companyId: CON_FECHA, estado: 'CONFIRMADA' } });
    expect((c.creado as Record<string, unknown>).inicioEnApp).toBeUndefined();
  });

  it('si luego se borra la fecha, la deducida sigue en el 1-1-2027: 2026 lo llevó la gestoría', async () => {
    await prisma.ajustesFiscales.update({ where: { companyId: CON_FECHA }, data: { inicioEnApp: null } });
    expect(await inicioLlevanzaApp(CON_FECHA)).toBe('2027-01-01');
    relojEn('2027-02-15T10:00:00Z');
    expect(claves(await listarModelosImpuesto(CON_FECHA, 2026)).filter((c) => c.startsWith('303:'))).toEqual([]);
  });

  it('deshacer la carga lo avisa y deja la fecha sin indicar, como estaba', async () => {
    const plan = await deshacerCarga(SIN_FECHA, 2027, carga, { simular: true }, USUARIO_PRUEBA);
    expect(plan.acciones).toContain('La fecha desde la que llevas los impuestos con la app vuelve a quedar sin indicar.');
    const creadas = plan.fichasCreadas.filter((f) => f.borrable).map((f) => f.id);
    await deshacerCarga(SIN_FECHA, 2027, carga, { borrarFichas: creadas }, USUARIO_PRUEBA);
    expect((await prisma.ajustesFiscales.findUniqueOrThrow({ where: { companyId: SIN_FECHA } })).inicioEnApp).toBeNull();
    expect((await prisma.fiscalYear.findFirstOrThrow({ where: { companyId: SIN_FECHA, label: '2026' } })).llevanza).toBe('APP');
  });
});
