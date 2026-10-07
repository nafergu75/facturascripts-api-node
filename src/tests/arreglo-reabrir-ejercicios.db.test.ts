/**
 * Arreglo prisma/arreglos/2026-10-07-reabrir-ejercicios-cerrados-sin-asientos.sql
 * sobre BD real: reabre los ejercicios que cerro el boton de Registro Mercantil
 * (CLOSED sin asientos de regularizacion ni cierre en su año) y no toca los que
 * cerro de verdad Cierre y traspaso de saldos. Se ejecuta dos veces: la segunda
 * no cambia nada.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { prisma } from '../config/database';

const COMPANY_ID = `arreglo-reabrir-${Date.now()}`;
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

const cerrado = (label: string, fechaInicio = `${label}-01-01`, fechaFin = `${label}-12-31`) =>
  prisma.fiscalYear.create({
    data: {
      companyId: COMPANY_ID,
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
const asiento = (fecha: string, origen: string, estado = 'POSTED') =>
  prisma.journalEntry.create({
    data: { companyId: COMPANY_ID, fecha: new Date(`${fecha}T00:00:00Z`), numeroAsiento: `AR-${origen}-${fecha}-${estado}`, descripcion: origen, origen, estado },
  });
const fy = (label: string) => prisma.fiscalYear.findFirstOrThrow({ where: { companyId: COMPANY_ID, label } });

let ids: Record<string, string> = {};

beforeAll(async () => {
  await prisma.company.create({ data: { id: COMPANY_ID, name: 'Arreglo Ejercicios SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  // 2020: cerrado de verdad (regularizacion y cierre del 31/12).
  const y2020 = await cerrado('2020');
  await asiento('2020-12-31', 'REGULARIZACION');
  await asiento('2020-12-31', 'CIERRE');
  // 2021: cerrado de verdad, sin gastos ni ingresos (solo asiento de cierre).
  const y2021 = await cerrado('2021');
  await asiento('2021-12-31', 'CIERRE');
  // 2022: cerrado desde Registro Mercantil, con libros pendientes (uno ya generado).
  const y2022 = await cerrado('2022');
  await prisma.legalBook.createMany({
    data: [
      { companyId: COMPANY_ID, fiscalYearId: y2022.id, type: 'DIARIO', filePath: '', hash: '', status: 'PENDING' },
      { companyId: COMPANY_ID, fiscalYearId: y2022.id, type: 'ACTAS', filePath: 'libros/actas.pdf', hash: 'abc', status: 'GENERATED' },
    ],
  });
  // Un asiento de cierre del año SIGUIENTE no cuenta como cierre de 2022.
  await asiento('2023-01-01', 'APERTURA');
  // 2023: cerrado desde Registro Mercantil; su cierre se deshizo (asiento anulado) o era un borrador.
  const y2023 = await cerrado('2023');
  await asiento('2023-12-31', 'CIERRE', 'REVERSED');
  await asiento('2023-12-31', 'REGULARIZACION', 'DRAFT');
  // Un nombre que no es un año: solo pudo cerrarlo el boton de Registro Mercantil.
  const raro = await cerrado('Ejercicio 2019', '2019-01-01', '2019-12-31');
  // 2024 abierto: no se toca.
  const y2024 = await prisma.fiscalYear.create({ data: { companyId: COMPANY_ID, label: '2024', fechaInicio: '2024-01-01', fechaFin: '2024-12-31' } });
  ids = { y2020: y2020.id, y2021: y2021.id, y2022: y2022.id, y2023: y2023.id, raro: raro.id, y2024: y2024.id };
});

describe('arreglo: reabrir los ejercicios cerrados sin asientos', () => {
  it('reabre solo los cerrados sin regularizacion ni cierre en su año', async () => {
    await aplicarArreglo();

    for (const label of ['2020', '2021']) {
      expect(await fy(label)).toMatchObject({ estado: 'CLOSED', asientosBloqueados: true, closingDate: `${label}-12-31` });
    }
    for (const label of ['2022', '2023', 'Ejercicio 2019']) {
      expect(await fy(label)).toMatchObject({
        estado: 'OPEN',
        asientosBloqueados: false,
        closingDate: null,
        legalizationDeadline: null,
        accountsDepositDeadline: null,
      });
    }
    expect((await fy('2024')).estado).toBe('OPEN');
  });

  it('quita los libros pendientes sin fichero y deja los generados', async () => {
    const libros = await prisma.legalBook.findMany({ where: { fiscalYearId: ids.y2022 }, select: { type: true, status: true } });
    expect(libros).toEqual([{ type: 'ACTAS', status: 'GENERATED' }]);
  });

  it('deja una linea de auditoria por ejercicio reabierto', async () => {
    const lineas = await prisma.auditLog.findMany({ where: { companyId: COMPANY_ID, action: 'REOPEN_FISCAL_YEAR_SIN_ASIENTOS' } });
    expect(lineas.map((l) => l.resourceId).sort()).toEqual([ids.y2022, ids.y2023, ids.raro].sort());
    expect(lineas.find((l) => l.resourceId === ids.y2022)?.meta).toMatchObject({ label: '2022', closingDate: '2022-12-31' });
  });

  it('una segunda pasada no cambia nada', async () => {
    const antes = await prisma.fiscalYear.findMany({ where: { companyId: COMPANY_ID }, orderBy: { label: 'asc' } });
    await aplicarArreglo();
    const despues = await prisma.fiscalYear.findMany({ where: { companyId: COMPANY_ID }, orderBy: { label: 'asc' } });
    expect(despues.map((f) => [f.label, f.estado, f.updatedAt.getTime()])).toEqual(antes.map((f) => [f.label, f.estado, f.updatedAt.getTime()]));
    expect(await prisma.auditLog.count({ where: { companyId: COMPANY_ID, action: 'REOPEN_FISCAL_YEAR_SIN_ASIENTOS' } })).toBe(3);
  });
});
