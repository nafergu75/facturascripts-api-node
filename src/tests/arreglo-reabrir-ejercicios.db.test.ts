/**
 * Arreglo prisma/arreglos/2026-10-07-reabrir-ejercicios-cerrados-sin-asientos.sql
 * sobre BD real: reabre los ejercicios que cerro el boton de Registro Mercantil
 * (CLOSED sin asientos de cierre en su año) y no toca los que cerro de verdad
 * Cierre y traspaso de saldos, los cierres antiguos (AJUSTE_MANUAL por su
 * concepto, CIERRE_AUTOMATICO), los anteriores a un cierre posterior ni los
 * años sin asientos. Bloquea sus meses. Es de un solo uso: la segunda pasada
 * no cambia nada y no reabre lo que se cierre despues.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { prisma } from '../config/database';

const COMPANY_ID = `arreglo-reabrir-${Date.now()}`;
const VACIA = `${COMPANY_ID}-vacia`;
const MARCA = 'arreglo-reabrir-ejercicios-hecho';
const FICHERO = join(__dirname, '../../prisma/arreglos/2026-10-07-reabrir-ejercicios-cerrados-sin-asientos.sql');

/** Las sentencias del fichero, sin comentarios (como las manda prisma db execute). */
function sentencias(): string[] {
  const sinComentarios = readFileSync(FICHERO, 'utf8')
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
  return sinComentarios
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}
async function aplicarArreglo(): Promise<void> {
  for (const s of sentencias()) await prisma.$executeRawUnsafe(s);
}

const cerrado = (label: string, fechaInicio = `${label}-01-01`, fechaFin = `${label}-12-31`, companyId = COMPANY_ID) =>
  prisma.fiscalYear.create({
    data: {
      companyId,
      label,
      fechaInicio,
      fechaFin,
      estado: 'CLOSED',
      closingDate: fechaFin,
      legalizationDeadline: '2099-04-30',
      accountsDepositDeadline: '2099-07-31',
      asientosBloqueados: true,
    },
  });
const asiento = (fecha: string, origen: string, estado = 'POSTED', descripcion = origen) =>
  prisma.journalEntry.create({
    data: { companyId: COMPANY_ID, fecha: new Date(`${fecha}T00:00:00Z`), numeroAsiento: `AR-${origen}-${fecha}-${estado}-${descripcion.length}`, descripcion, origen, estado },
  });
const fy = (label: string) => prisma.fiscalYear.findFirstOrThrow({ where: { companyId: COMPANY_ID, label } });

let ids: Record<string, string> = {};

beforeAll(async () => {
  // La marca de "ya aplicado" es global: en la BD de pruebas se quita para probarlo de nuevo.
  await prisma.auditLog.deleteMany({ where: { id: MARCA } });
  for (const id of [COMPANY_ID, VACIA]) {
    await prisma.company.create({ data: { id, name: id, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  }
  // 2016: cierre antiguo (AJUSTE_MANUAL, se reconoce por el concepto) y despues marcado CLOSED.
  const y2016 = await cerrado('2016');
  await asiento('2016-12-31', 'AJUSTE_MANUAL', 'POSTED', 'Regularización ejercicio 2016');
  // 2017: cerrado con el antiguo generar-asiento (CIERRE_AUTOMATICO).
  const y2017 = await cerrado('2017');
  await asiento('2017-12-31', 'CIERRE_AUTOMATICO', 'POSTED', 'CIERRE CONTABLE - Período 2017-01-01 a 2017-12-31');
  // Un nombre que no es un año, anterior a cierres de verdad: no se reabre.
  const raro = await cerrado('Ejercicio 2019', '2019-01-01', '2019-12-31');
  // 2020: cerrado de verdad (regularizacion y cierre del 31/12).
  const y2020 = await cerrado('2020');
  await asiento('2020-12-31', 'REGULARIZACION');
  await asiento('2020-12-31', 'CIERRE');
  // 2021: cerrado de verdad, sin gastos ni ingresos (solo asiento de cierre).
  const y2021 = await cerrado('2021');
  await asiento('2021-12-31', 'CIERRE');
  // 2022: cerrado desde Registro Mercantil, con un asiento normal y libros pendientes (uno ya generado).
  const y2022 = await cerrado('2022');
  await asiento('2022-03-01', 'FACTURA_INGRESO');
  await prisma.legalBook.createMany({
    data: [
      { companyId: COMPANY_ID, fiscalYearId: y2022.id, type: 'DIARIO', filePath: '', hash: '', status: 'PENDING' },
      { companyId: COMPANY_ID, fiscalYearId: y2022.id, type: 'ACTAS', filePath: 'libros/actas.pdf', hash: 'abc', status: 'GENERATED' },
    ],
  });
  // Meses de 2022 que ya existian: uno abierto (pasa a bloqueado) y uno cerrado (se queda).
  await prisma.periodo.createMany({
    data: [
      { companyId: COMPANY_ID, ejercicio: 2022, mes: 5, estado: 'cerrado' },
      { companyId: COMPANY_ID, ejercicio: 2022, mes: 6, estado: 'abierto' },
    ],
  });
  await asiento('2023-01-01', 'APERTURA');
  // 2023: cerrado desde Registro Mercantil; su cierre se deshizo (asiento anulado) o era un borrador.
  const y2023 = await cerrado('2023');
  await asiento('2023-12-31', 'CIERRE', 'REVERSED');
  await asiento('2023-12-31', 'REGULARIZACION', 'DRAFT');
  // 2024 abierto: no se toca.
  const y2024 = await prisma.fiscalYear.create({ data: { companyId: COMPANY_ID, label: '2024', fechaInicio: '2024-01-01', fechaFin: '2024-12-31' } });
  // Otra empresa sin ningun asiento: su año cerrado para sacar los libros se queda cerrado.
  const vacia = await cerrado('2015', '2015-01-01', '2015-12-31', VACIA);
  ids = { y2016: y2016.id, y2017: y2017.id, raro: raro.id, y2020: y2020.id, y2021: y2021.id, y2022: y2022.id, y2023: y2023.id, y2024: y2024.id, vacia: vacia.id };
});

describe('arreglo: reabrir los ejercicios cerrados sin asientos', () => {
  it('reabre solo los cerrados sin asientos de cierre, sin un cierre posterior y con asientos', async () => {
    await aplicarArreglo();

    for (const label of ['2016', '2017', '2020', '2021']) {
      expect(await fy(label)).toMatchObject({ estado: 'CLOSED', asientosBloqueados: true, closingDate: `${label}-12-31` });
    }
    // Anterior a un cierre de verdad (2020): se queda cerrado.
    expect((await fy('Ejercicio 2019')).estado).toBe('CLOSED');
    for (const label of ['2022', '2023']) {
      expect(await fy(label)).toMatchObject({
        estado: 'OPEN',
        asientosBloqueados: false,
        closingDate: null,
        legalizationDeadline: null,
        accountsDepositDeadline: null,
      });
    }
    expect((await fy('2024')).estado).toBe('OPEN');
    expect((await prisma.fiscalYear.findUniqueOrThrow({ where: { id: ids.vacia } })).estado).toBe('CLOSED');
  });

  it('quita los libros pendientes sin fichero y deja los generados', async () => {
    const libros = await prisma.legalBook.findMany({ where: { fiscalYearId: ids.y2022 }, select: { type: true, status: true } });
    expect(libros).toEqual([{ type: 'ACTAS', status: 'GENERATED' }]);
  });

  it('bloquea los 12 meses de los reabiertos (los cerrados se quedan cerrados)', async () => {
    const meses = await prisma.periodo.findMany({ where: { companyId: COMPANY_ID, ejercicio: 2022 }, orderBy: { mes: 'asc' } });
    expect(meses.map((m) => m.estado)).toEqual(Array.from({ length: 12 }, (_, i) => (i + 1 === 5 ? 'cerrado' : 'bloqueado')));
    expect(await prisma.periodo.count({ where: { companyId: COMPANY_ID, ejercicio: 2023, estado: 'bloqueado' } })).toBe(12);
    expect(await prisma.periodo.count({ where: { companyId: COMPANY_ID, ejercicio: 2024 } })).toBe(0);
  });

  it('deja una linea de auditoria por ejercicio reabierto y la marca de aplicado', async () => {
    const lineas = await prisma.auditLog.findMany({ where: { companyId: COMPANY_ID, action: 'REOPEN_FISCAL_YEAR_SIN_ASIENTOS' } });
    expect(lineas.map((l) => l.resourceId).sort()).toEqual([ids.y2022, ids.y2023].sort());
    expect(lineas.find((l) => l.resourceId === ids.y2022)?.meta).toMatchObject({ label: '2022', closingDate: '2022-12-31' });
    expect(await prisma.auditLog.count({ where: { id: MARCA } })).toBe(1);
  });

  it('una segunda pasada no cambia nada, ni reabre lo que se cierre despues', async () => {
    // Despues del arreglo, otro ejercicio queda cerrado sin asientos de cierre.
    await prisma.fiscalYear.update({ where: { id: ids.y2024 }, data: { estado: 'CLOSED' } });
    await asiento('2024-02-01', 'FACTURA_INGRESO');
    const antes = await prisma.fiscalYear.findMany({ where: { companyId: COMPANY_ID }, orderBy: { label: 'asc' } });
    await aplicarArreglo();
    const despues = await prisma.fiscalYear.findMany({ where: { companyId: COMPANY_ID }, orderBy: { label: 'asc' } });
    expect(despues.map((f) => [f.label, f.estado, f.updatedAt.getTime()])).toEqual(antes.map((f) => [f.label, f.estado, f.updatedAt.getTime()]));
    expect((await fy('2024')).estado).toBe('CLOSED');
    expect(await prisma.auditLog.count({ where: { companyId: COMPANY_ID, action: 'REOPEN_FISCAL_YEAR_SIN_ASIENTOS' } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { id: MARCA } })).toBe(1);
  });
});
