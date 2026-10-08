/**
 * Un unico criterio para reconocer el cierre de un ejercicio (domain/asientosCierre),
 * sobre BD real. Los cierres de antes del 06-10-2026 se grabaron con origen
 * AJUSTE_MANUAL («Regularizacion ejercicio X», «Cierre ejercicio X» y
 * «Apertura ejercicio X+1») y el antiguo generar-asiento con CIERRE_AUTOMATICO:
 * cuentan como cierre en el estado del ejercicio, en el bloqueo de fechas, en
 * la vista del cierre y al deshacerlo. Y un ejercicio cerrado sin asientos
 * (boton de Registro Mercantil) remite a Configuracion, no a Cierre y traspaso.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { fiscalYearsService } from '../services/fiscalYears.service';
import { comprobarFechaAbierta, ejercicioCerrado } from '../services/periodos.service';
import { deshacerCierreEjercicio, previsualizarCierre } from '../services/cierreEjercicio.service';

const SUFIJO = Date.now();
const EMPRESA = `cierre-criterio-${SUFIJO}`;

async function asiento(fecha: string, origen: string, descripcion: string) {
  const a = await prisma.journalEntry.create({
    data: { companyId: EMPRESA, fecha: new Date(`${fecha}T00:00:00Z`), numeroAsiento: `CC-${SUFIJO}-${fecha}-${origen}-${descripcion.length}`, descripcion, origen, estado: 'POSTED' },
  });
  return a.id;
}
const fy = (label: string, estado: string) =>
  prisma.fiscalYear.create({ data: { companyId: EMPRESA, label, fechaInicio: `${label}-01-01`, fechaFin: `${label}-12-31`, estado } });

const ids: Record<string, string> = {};

beforeAll(async () => {
  await prisma.company.create({ data: { id: EMPRESA, name: 'Cierre Criterio SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.companyCierreConfig.create({ data: { companyId: EMPRESA, exigirCuadreBancos: false, toleranciaCuadre: 0.01 } });
  await asiento('2022-05-10', 'FACTURA_INGRESO', 'Factura 2022');
  // 2022: cerrado con la regularizacion del antiguo generar-asiento.
  await fy('2022', 'OPEN');
  await asiento('2022-12-31', 'CIERRE_AUTOMATICO', 'CIERRE CONTABLE - Período 2022-01-01 a 2022-12-31');
  // 2024: cierre antiguo (AJUSTE_MANUAL) y despues marcado CLOSED con el boton de Registro Mercantil.
  await fy('2024', 'CLOSED');
  await asiento('2024-03-01', 'FACTURA_INGRESO', 'Factura 2024');
  ids.reg = await asiento('2024-12-31', 'AJUSTE_MANUAL', 'Regularizacion ejercicio 2024');
  ids.cie = await asiento('2024-12-31', 'AJUSTE_MANUAL', 'Cierre ejercicio 2024');
  ids.ape = await asiento('2025-01-01', 'AJUSTE_MANUAL', 'Apertura ejercicio 2025');
  // 2026: cerrado sin asientos de cierre (boton de Registro Mercantil); 2025 abierto.
  await fy('2025', 'OPEN');
  await fy('2026', 'CLOSED');
});

describe('cierres antiguos y CIERRE_AUTOMATICO cuentan como cierre', () => {
  it('estado del ejercicio: CERRADO, no «cerrado sin asientos»', async () => {
    const lista = await fiscalYearsService.listar(EMPRESA);
    const estado = Object.fromEntries(lista.map((f) => [f.label, f.estadoEfectivo]));
    expect(estado).toEqual({ '2022': 'CERRADO', '2024': 'CERRADO', '2025': 'ABIERTO', '2026': 'CERRADO_SIN_ASIENTOS' });
    expect(await ejercicioCerrado(EMPRESA, 2022)).toBe(true);
  });

  it('no se apunta nada en esos años', async () => {
    await expect(comprobarFechaAbierta(EMPRESA, '2022-06-01')).rejects.toThrow(/cerrado/);
    await expect(comprobarFechaAbierta(EMPRESA, '2024-06-01', 'emitir la factura')).rejects.toThrow(/Cierre y traspaso de saldos/);
  });

  it('el cierre no se repite (no duplicaria la apertura) y se puede deshacer, apertura antigua incluida', async () => {
    const v = await previsualizarCierre(EMPRESA, 2024);
    expect(v.estado).toBe('CERRADO');
    expect(v.puedeCerrar).toBe(false);
    expect(v.cierreExistente.map((a) => a.id).sort()).toEqual([ids.reg, ids.cie].sort());
    expect(v.puedeDeshacer).toBe(true);

    const d = await deshacerCierreEjercicio(EMPRESA, 2024);
    expect(d.anulados).toBe(3);
    const anulados = await prisma.journalEntry.findMany({ where: { id: { in: [ids.reg, ids.cie, ids.ape] } }, select: { estado: true } });
    expect(anulados.map((a) => a.estado)).toEqual(['REVERSED', 'REVERSED', 'REVERSED']);
    expect((await prisma.fiscalYear.findFirstOrThrow({ where: { companyId: EMPRESA, label: '2024' } })).estado).toBe('OPEN');
  });
});

describe('cerrado sin asientos: se remite a Configuración', () => {
  it('la vista del cierre explica que no hay nada que deshacer y enlaza a Ejercicios y periodos', async () => {
    const v = await previsualizarCierre(EMPRESA, 2026);
    expect(v.puedeDeshacer).toBe(false);
    expect(v.motivoNoDeshacer).toMatch(/no hay nada que deshacer/);
    expect(v.motivoNoDeshacer).toMatch(/Configuración > Ejercicios y periodos/);
    expect(v.enlaceNoDeshacer).toBe('/dashboard/configuracion/ejercicios');
  });

  it('cerrar el anterior avisa de que hay que reabrir el siguiente', async () => {
    const v = await previsualizarCierre(EMPRESA, 2025);
    expect(v.motivosBloqueo.join(' ')).toMatch(/2026 está marcado como cerrado sin hacer la regularización/);
  });

  it('una fecha de ese año: el mensaje y el enlace llevan a Configuración', async () => {
    const err = await comprobarFechaAbierta(EMPRESA, '2026-02-10', 'emitir la factura').catch((e) => e);
    expect(err.message).toMatch(/Configuración > Ejercicios y periodos/);
    expect(err.details).toMatchObject({ campo: 'fechaEmision', motivo: 'ejercicio_cerrado', enlace: '/dashboard/configuracion/ejercicios' });
  });
});
