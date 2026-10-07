/**
 * Nominas sobre BD real: importar el Excel de la gestoria (3 trabajadores),
 * contabilizar (un asiento por trabajador con su subcuenta 465), reimportar
 * sin duplicar, anular (REVERSED o contraasiento con el periodo cerrado), alta
 * manual, trabajadores y resumen mensual del 111.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests). Los NIF
 * y NAF son inventados (numeros con su control calculado).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import * as XLSX from 'xlsx';
import { prisma } from '../config/database';
import { controlNaf, letraNif } from '../utils/nif';
import { leerNominas } from '../services/nominas/lector';
import {
  anularNominas,
  confirmarImportacion,
  contabilizarNominas,
  crearNomina,
  actualizarNomina,
  borrarNomina,
  listarResumenesNominas,
  previsualizarAsientos,
  previsualizarImportacion,
  resumenPeriodo,
} from '../services/nominas.service';
import { borrarEmpleado, crearEmpleado, darDeBajaEmpleado } from '../services/empleados.service';
import { cambiarEstadoPeriodo } from '../services/periodos.service';

const COMPANY_ID = `nominas-test-${Date.now()}`;
const nif = (n: number) => `${String(n).padStart(8, '0')}${letraNif(n)}`;
const naf = (prov: number, num: number) => `${String(prov).padStart(2, '0')}${String(num).padStart(8, '0')}${controlNaf(prov, num)}`;

const NIF_A = nif(20000001);
const NIF_B = nif(20000002);
const NIF_C = nif(20000003);

const CABECERA = [
  'Trabajador',
  'D.N.I.',
  'Nº Afiliación S.S.',
  'Total devengado',
  'Retribución en especie',
  'Aportación trabajador',
  'Retención IRPF',
  'Embargos',
  'Anticipos',
  'Líquido a percibir',
  'Coste S.S. empresa',
  'Coste total',
];
const filaA = (irpf = 300) => ['Persona Prueba Uno', NIF_A, naf(28, 12345678), 2000, 0, 127, irpf, 0, 0, 2000 - 127 - irpf, 600, 2600];
// Total devengado con la especie dentro: dinerario 1700.
const FILA_B = ['Persona Prueba Dos', NIF_B, naf(46, 1234567), 1800, 100, 114.3, 180, 150, 0, 1255.7, 540, 2340];
const FILA_C = ['Persona Prueba Tres', NIF_C, '', 1500, 0, 95.25, 120, 0, 200, 1084.75, 450, 1950];

/** Excel como el de una gestoria: titulo con el mes, cabecera, una fila por trabajador y total. */
function excel(filas: unknown[][]): Buffer {
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, XLSX.utils.aoa_to_sheet([['Resumen de nóminas enero 2026'], [], CABECERA, ...filas, ['TOTAL', '', '', 5300]]), 'Nóminas');
  return XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
const lectura = (filas: unknown[][]) => ({ lectura: leerNominas(excel(filas), 'nominas-enero-2026.xlsx') });

async function asiento(id: string | null) {
  return prisma.journalEntry.findUniqueOrThrow({ where: { id: id! }, include: { lineas: true } });
}
const porCuenta = (lineas: Array<{ accountCode: string; debe: number; haber: number }>) =>
  Object.fromEntries(lineas.map((l) => [l.accountCode, [Number(l.debe), Number(l.haber)]]));
const nominasDe = (companyId = COMPANY_ID) =>
  prisma.nomina.findMany({ where: { companyId }, include: { empleado: true }, orderBy: { empleado: { nif: 'asc' } } });

beforeAll(async () => {
  await prisma.company.create({ data: { id: COMPANY_ID, name: 'Nominas Test SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
});

describe('importar el Excel de la gestoria y contabilizar un asiento por trabajador', () => {
  it('vista previa: cuadre por trabajador, 3 trabajadores nuevos y nada guardado', async () => {
    const v = await previsualizarImportacion(COMPANY_ID, lectura([filaA(), FILA_B, FILA_C]));
    expect(v.resumen).toMatchObject({ filas: 3, validas: 3, conErrores: 0, empleadosNuevos: 3, empleadosExistentes: 0, sustituyen: 0 });
    expect(v.resumen.periodos).toEqual([{ ejercicio: 2026, mes: 1, nominas: 3, estadoPeriodo: 'abierto' }]);
    expect(v.resumen.totales).toMatchObject({ trabajadores: 3, brutoDinerario: 5200, liquido: 3913.45, ssEmpresa: 1590 });
    expect(v.puedeConfirmar).toBe(true);
    expect(v.filas.every((f) => f.accion === 'crear' && f.empleado.nuevo && f.cuadre.cuadra)).toBe(true);
    expect(await prisma.empleado.count({ where: { companyId: COMPANY_ID } })).toBe(0);
    expect(await prisma.nomina.count({ where: { companyId: COMPANY_ID } })).toBe(0);
  });

  it('confirmar: alta de los trabajadores por NIF y nominas en borrador', async () => {
    const r = await confirmarImportacion(COMPANY_ID, lectura([filaA(), FILA_B, FILA_C]));
    expect(r).toMatchObject({ nominasCreadas: 3, nominasSustituidas: 0, empleadosCreados: 3, periodos: [{ ejercicio: 2026, mes: 1 }] });
    const ns = await nominasDe();
    expect(ns.map((n) => n.empleado.nif)).toEqual([NIF_A, NIF_B, NIF_C]);
    expect(ns[0].empleado).toMatchObject({ nombre: 'Persona Prueba Uno', naf: naf(28, 12345678), activo: true, subcuenta465: null });
    expect(ns[2].empleado.naf).toBeNull();
    for (const n of ns) {
      expect(n).toMatchObject({ estado: 'BORRADOR', origen: 'importacion', loteImportacionId: r.loteImportacionId, fechaDevengo: '2026-01-31', fechaPago: '2026-01-31', tipo: 'ORDINARIA' });
    }
    expect(ns[1]).toMatchObject({ brutoDinerario: 1700, especieValoracion: 100, embargos: 150, liquido: 1255.7 });
  });

  it('la vista previa del asiento propone una subcuenta 465 nueva por trabajador y cuadra', async () => {
    const p = await previsualizarAsientos(COMPANY_ID, 2026, 1);
    expect(p.cuadran).toBe(true);
    expect(p.asientos).toHaveLength(3);
    expect(new Set(p.asientos.map((a) => a.lineas.find((l) => l.cuenta.startsWith('465') && l.cuenta !== '465999')?.cuenta)).size).toBe(3);
    expect(p.asientos.every((a) => a.subcuentaNueva && a.numero === null)).toBe(true);
  });

  let asientosEnero: string[] = [];

  it('contabilizar: 3 asientos NOM cuadrados, uno por trabajador, con su subcuenta 465 creada en el plan', async () => {
    const r = await contabilizarNominas(COMPANY_ID, 2026, 1);
    expect(r.contabilizadas).toBe(3);
    expect(r.subcuentasCreadas.sort()).toEqual(['465001', '465002', '465003']);
    expect(new Set(r.asientos.map((a) => a.numero)).size).toBe(3);
    for (const a of r.asientos) expect(a.numero).toMatch(/^NOM-\d{5}$/);
    asientosEnero = r.asientos.map((a) => a.asientoId);

    const ns = await nominasDe();
    for (const n of ns) {
      expect(n.estado).toBe('CONTABILIZADA');
      const a = await asiento(n.asientoId);
      expect(a).toMatchObject({ estado: 'POSTED', origen: 'NOMINA', invoiceId: n.id, invoiceType: 'NOMINA' });
      expect(a.fecha.toISOString().slice(0, 10)).toBe('2026-01-31');
      const debe = a.lineas.reduce((s, l) => s + Math.round(Number(l.debe) * 100), 0);
      const haber = a.lineas.reduce((s, l) => s + Math.round(Number(l.haber) * 100), 0);
      expect(debe).toBe(haber);
      // La subcuenta del trabajador, en el plan colgando de la 465. Ni el asiento ni
      // el plan llevan su nombre o su NIF: los ve quien tiene contabilidad:read.
      const sub = n.empleado.subcuenta465!;
      expect(sub).toMatch(/^46500[123]$/);
      expect(a.descripcion).toBe(`Nómina 01/2026 - trabajador ${sub}`);
      const cuenta = await prisma.chartOfAccounts.findFirstOrThrow({ where: { companyId: COMPANY_ID, codigo: sub } });
      expect(cuenta).toMatchObject({ nombre: `Remuneraciones pendientes - trabajador ${sub}`, parentCodigo: '465', esPersonalizadaEmpresa: true });
      for (const texto of [JSON.stringify(a), JSON.stringify(cuenta)]) {
        expect(texto).not.toContain(n.empleado.nombre);
        expect(texto).not.toContain(n.empleado.nif);
      }
    }
    const b = ns[1];
    expect(porCuenta((await asiento(b.asientoId)).lineas)).toEqual({
      '640000': [1700, 0],
      '642000': [540, 0],
      '476000': [0, 654.3],
      '475101': [0, 180],
      '465999': [0, 150],
      [b.empleado.subcuenta465!]: [0, 1255.7],
    });
    // Las subcuentas de nominas quedan en el plan de la empresa.
    const plan = await prisma.chartOfAccounts.findMany({ where: { companyId: COMPANY_ID, codigo: { in: ['640000', '642000', '476000', '475101', '465999', '460000'] } } });
    expect(plan.map((c) => c.codigo).sort()).toEqual(['460000', '465999', '475101', '476000', '640000', '642000']);

    const mes = await resumenPeriodo(COMPANY_ID, 2026, 1);
    expect(mes.estados).toMatchObject({ CONTABILIZADA: 3, BORRADOR: 0 });
    expect(mes.cuadran).toBe(true);
    expect(mes.nominas.every((n) => /^NOM-/.test(n.asientoNumero ?? ''))).toBe(true);
  });

  it('contabilizar otra vez: 409', async () => {
    await expect(contabilizarNominas(COMPANY_ID, 2026, 1)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('reimportar el mismo mes con las nominas contabilizadas se rechaza y no duplica nada', async () => {
    const v = await previsualizarImportacion(COMPANY_ID, lectura([filaA(), FILA_B, FILA_C]));
    expect(v.puedeConfirmar).toBe(false);
    expect(v.filas[0].errores.join(' ')).toMatch(/ya está contabilizada \(asiento NOM-\d{5}\)/);
    expect(v.resumen.empleadosExistentes).toBe(3);
    await expect(confirmarImportacion(COMPANY_ID, lectura([filaA(), FILA_B, FILA_C]))).rejects.toMatchObject({ statusCode: 400 });
    expect(await prisma.nomina.count({ where: { companyId: COMPANY_ID } })).toBe(3);
    expect(await prisma.empleado.count({ where: { companyId: COMPANY_ID } })).toBe(3);
    expect(await prisma.journalEntry.count({ where: { companyId: COMPANY_ID, origen: 'NOMINA' } })).toBe(3);
  });

  it('anular con el periodo abierto: asientos REVERSED y nominas otra vez en borrador', async () => {
    const r = await anularNominas(COMPANY_ID, 2026, 1);
    expect(r).toMatchObject({ anuladas: 3, estadoFinal: 'BORRADOR', contraasientos: [] });
    expect(r.asientosRevertidos).toHaveLength(3);
    for (const id of asientosEnero) expect((await asiento(id)).estado).toBe('REVERSED');
    for (const n of await nominasDe()) expect(n).toMatchObject({ estado: 'BORRADOR', asientoId: null });
    await expect(anularNominas(COMPANY_ID, 2026, 1)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('reimportar tras anular sustituye las de borrador sin duplicar y se recontabiliza con las mismas subcuentas', async () => {
    const r = await confirmarImportacion(COMPANY_ID, lectura([filaA(310), FILA_B, FILA_C]), { contabilizar: true });
    expect(r).toMatchObject({ nominasCreadas: 0, nominasSustituidas: 3, empleadosCreados: 0 });
    expect(r.contabilizacion?.[0]).toMatchObject({ contabilizadas: 3, subcuentasCreadas: [] });
    const ns = await nominasDe();
    expect(ns).toHaveLength(3);
    expect(ns[0]).toMatchObject({ irpf: 310, liquido: 1563, estado: 'CONTABILIZADA' });
    expect(await prisma.empleado.count({ where: { companyId: COMPANY_ID } })).toBe(3);
    const subcuentas = await prisma.chartOfAccounts.findMany({ where: { companyId: COMPANY_ID, codigo: { startsWith: '4650' } } });
    expect(subcuentas.map((c) => c.codigo).sort()).toEqual(['465001', '465002', '465003']);
    // Numeracion correlativa: los anulados conservan su numero.
    const numeros = (await prisma.journalEntry.findMany({ where: { companyId: COMPANY_ID, origen: 'NOMINA' }, select: { numeroAsiento: true } })).map((a) => a.numeroAsiento).sort();
    expect(numeros).toEqual(['NOM-00001', 'NOM-00002', 'NOM-00003', 'NOM-00004', 'NOM-00005', 'NOM-00006']);
  });

  it('periodo cerrado: no se contabiliza; anular hace contraasiento en un periodo abierto y la nomina queda anulada', async () => {
    const d = await crearEmpleado(COMPANY_ID, { nif: nif(20000004), nombre: 'Persona', apellidos: 'Prueba Cuatro', fechaAlta: '2026-01-15' });
    const manual = await crearNomina(COMPANY_ID, { empleadoId: d.id, ejercicio: 2026, mes: 1, brutoDinerario: 800, ssTrabajador: 50.8, irpf: 16, liquido: 733.2, ssEmpresa: 240 });
    const ns = await nominasDe();
    const a = ns.find((n) => n.empleado.nif === NIF_A)!;
    await cambiarEstadoPeriodo(COMPANY_ID, 2026, 1, 'cerrado');
    try {
      await expect(contabilizarNominas(COMPANY_ID, 2026, 1)).rejects.toThrow(/está cerrado/);
      await expect(anularNominas(COMPANY_ID, 2026, 1, { nominaIds: [a.id], fecha: '2026-01-31' })).rejects.toThrow(/está cerrado/);
      const r = await anularNominas(COMPANY_ID, 2026, 1, { nominaIds: [a.id], fecha: '2026-02-02', dejarAnuladas: true });
      expect(r).toMatchObject({ anuladas: 1, estadoFinal: 'ANULADA', asientosRevertidos: [] });
      expect(r.contraasientos).toHaveLength(1);
      const original = await asiento(a.asientoId);
      expect(original.estado).toBe('POSTED');
      const contra = await asiento(r.contraasientos[0].asientoId);
      expect(contra).toMatchObject({ estado: 'POSTED', origen: 'NOMINA', invoiceId: a.id, invoiceType: 'NOMINA' });
      expect(contra.fecha.toISOString().slice(0, 10)).toBe('2026-02-02');
      const o = porCuenta(original.lineas);
      expect(porCuenta(contra.lineas)).toEqual(Object.fromEntries(Object.entries(o).map(([k, [debe, haber]]) => [k, [haber, debe]])));
      expect(await prisma.nomina.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ estado: 'ANULADA', asientoAnulacionId: r.contraasientos[0].asientoId });
    } finally {
      await cambiarEstadoPeriodo(COMPANY_ID, 2026, 1, 'abierto');
    }
    // Con el periodo abierto otra vez, la manual se contabiliza sola.
    const r2 = await contabilizarNominas(COMPANY_ID, 2026, 1, [manual.id]);
    expect(r2).toMatchObject({ contabilizadas: 1, subcuentasCreadas: ['465004'] });
  });

  it('resumen mensual (modelo 111): calculado con las nominas, sin las anuladas', async () => {
    const r = await listarResumenesNominas(COMPANY_ID, 2026);
    const enero = r.find((x) => x.mes === 1)!;
    // A anulada: quedan B (1700), C (1500) y la manual (800).
    expect(enero).toMatchObject({ origen: 'nominas', perceptores: 3, totalBruto: 4000, totalIRPF: 316, totalLiquido: 3073.65 });
  });
});

describe('alta manual y trabajadores', () => {
  let empleadoId: string;

  it('NIF no valido: 400; NIF repetido: 409', async () => {
    await expect(crearEmpleado(COMPANY_ID, { nif: '12345678A', nombre: 'X' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(crearEmpleado(COMPANY_ID, { nif: NIF_A, nombre: 'Otro' })).rejects.toMatchObject({ statusCode: 409 });
    const e = await crearEmpleado(COMPANY_ID, { nif: nif(20000005), nombre: 'Persona', apellidos: 'Prueba Cinco', naf: naf(3, 22334455) });
    expect(e).toMatchObject({ nombreCompleto: 'Persona Prueba Cinco', naf: naf(3, 22334455), activo: true });
    empleadoId = e.id;
  });

  it('nomina que no cuadra: 400 con la diferencia; repetida: 409; contabilizada no se edita ni se borra', async () => {
    const base = { empleadoId, ejercicio: 2026, mes: 2, brutoDinerario: 1000, ssTrabajador: 63.5, irpf: 100, liquido: 836.5, ssEmpresa: 300 };
    await expect(crearNomina(COMPANY_ID, { ...base, liquido: 836.52 })).rejects.toMatchObject({ statusCode: 400, details: { diferencia: 0.02 } });
    await expect(crearNomina(COMPANY_ID, { ...base, irpf: '100' })).rejects.toMatchObject({ statusCode: 400 });
    const n = await crearNomina(COMPANY_ID, base);
    expect(n).toMatchObject({ estado: 'BORRADOR', fechaDevengo: '2026-02-28', cuadre: { cuadra: true } });
    await expect(crearNomina(COMPANY_ID, base)).rejects.toMatchObject({ statusCode: 409 });
    const extra = await crearNomina(COMPANY_ID, { ...base, tipo: 'EXTRA' });
    expect(extra.tipo).toBe('EXTRA');

    const editada = await actualizarNomina(COMPANY_ID, n.id, { irpf: 110, liquido: 826.5 });
    expect(editada).toMatchObject({ irpf: 110, liquido: 826.5 });
    await expect(actualizarNomina(COMPANY_ID, n.id, { irpf: 120 })).rejects.toMatchObject({ statusCode: 400 });

    const r = await contabilizarNominas(COMPANY_ID, 2026, 2);
    expect(r.contabilizadas).toBe(2);
    // Dos nominas del mismo trabajador: dos asientos con la misma subcuenta 465.
    expect(new Set(r.asientos.map((a) => a.subcuenta465)).size).toBe(1);
    await expect(actualizarNomina(COMPANY_ID, n.id, { irpf: 100, liquido: 836.5 })).rejects.toMatchObject({ statusCode: 409 });
    await expect(borrarNomina(COMPANY_ID, n.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('un trabajador con nominas no se borra (se da de baja); sin nominas, si', async () => {
    await expect(borrarEmpleado(COMPANY_ID, empleadoId)).rejects.toMatchObject({ statusCode: 409 });
    const baja = await darDeBajaEmpleado(COMPANY_ID, empleadoId, { fechaBaja: '2026-02-28' });
    expect(baja).toMatchObject({ activo: false, fechaBaja: '2026-02-28' });
    const libre = await crearEmpleado(COMPANY_ID, { nif: nif(20000006), nombre: 'Sin nominas' });
    await borrarEmpleado(COMPANY_ID, libre.id);
    expect(await prisma.empleado.findUnique({ where: { id: libre.id } })).toBeNull();
  });

  it('meses solo con el resumen antiguo: si esta repetido, cuenta una vez (el ultimo)', async () => {
    await prisma.nominaResumen.create({ data: { companyId: COMPANY_ID, ejercicio: 2026, mes: 5, totalBruto: 1000, totalIRPF: 100 } });
    await new Promise((r) => setTimeout(r, 1100));
    await prisma.nominaResumen.create({ data: { companyId: COMPANY_ID, ejercicio: 2026, mes: 5, totalBruto: 1200, totalIRPF: 120 } });
    const mayo = (await listarResumenesNominas(COMPANY_ID, 2026)).filter((x) => x.mes === 5);
    expect(mayo).toHaveLength(1);
    expect(mayo[0]).toMatchObject({ origen: 'resumen', totalBruto: 1200, totalIRPF: 120 });
  });
});

describe('longitud de los codigos de la empresa', () => {
  it('con un plan de 10 digitos, las subcuentas de nominas tambien tienen 10', async () => {
    const otra = `nominas-10-${Date.now()}`;
    await prisma.company.create({ data: { id: otra, name: 'Diez digitos SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    await prisma.journalEntry.create({
      data: {
        companyId: otra,
        fecha: new Date('2026-01-01T00:00:00.000Z'),
        numeroAsiento: 'APERT-00001',
        descripcion: 'Apertura',
        origen: 'APERTURA',
        estado: 'POSTED',
        lineas: {
          create: [
            { companyId: otra, accountCode: '5720000001', accountName: 'Banco', debe: 100, haber: 0 },
            { companyId: otra, accountCode: '1000000000', accountName: 'Capital', debe: 0, haber: 100 },
          ],
        },
      },
    });
    await confirmarImportacion(otra, lectura([filaA()]), { contabilizar: true });
    const [n] = await nominasDe(otra);
    expect(n.empleado.subcuenta465).toBe('4650000001');
    expect(Object.keys(porCuenta((await asiento(n.asientoId)).lineas)).sort()).toEqual(['4650000001', '4751000001', '4760000000', '6400000000', '6420000000']);
  });
});
