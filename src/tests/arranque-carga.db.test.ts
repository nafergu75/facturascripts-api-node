/**
 * Traer la contabilidad de 2026 con UNA confirmacion: analisis que no escribe,
 * huella, confirmacion y fases (ejercicios, plan y subcuentas, clientes y
 * proveedores, diario historico, apertura del 1-1-2027, cartera,
 * inmovilizado, comparativo), con las dos empresas sinteticas y los formatos
 * de los programas de las gestorias. Tambien: repetir la carga, D1, D2,
 * errores que bloquean y dos confirmaciones a la vez.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { analizarCarga } from '../services/arranque/analisis.service';
import { aplicarFase, confirmarCarga, type ResultadoFase } from '../services/arranque/aplicar.service';
import { avisoArranque } from '../services/arranque/aviso.service';
import { reanalizar, subirYAnalizar, type RespuestaCarga } from '../services/arranque/cargas.service';
import { prepararDatos } from '../services/arranque/datos';
import { obtenerAsientosEjercicio, saldosDelEjercicio } from '../services/contabilidadDatos.service';
import { comprobarFechaAbierta } from '../services/periodos.service';
import { informeMayorTerceros } from '../services/informesContables.service';
import { longitudSubcuentasGuardada } from '../services/terceros/subcuentas';
import type { HttpError } from '../utils/http-errors';
import {
  a3SumasSaldos,
  AJUSTES_A,
  CARTERA_A,
  datosEmpresaCompletos,
  contaplusDiario,
  contaplusSubcuentas,
  diarioQueNoCuadraConSaldos,
  DIARIO_A,
  ficherosEmpresaA,
  ficherosEmpresaB,
  NIF,
  sumasSaldosConCierre,
  type FicheroPrueba,
} from './fixtures/arranque/generar';

const SUFIJO = Date.now();
const TODOS = { cliente: true, proveedor: true };
const USUARIO = 'usuario-arranque';

async function empresa(id: string) {
  await prisma.company.create({ data: { id, name: `Arranque ${id}`, fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: datosEmpresaCompletos(id) });
}

const ficheros = (fs: FicheroPrueba[]) => fs.map((f) => ({ nombre: f.nombre, contenido: f.contenido }));
const todosA = () => Object.values(ficherosEmpresaA());

async function error(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error('No ha fallado');
}

async function aplicarTodo(companyId: string, cargaId: string): Promise<ResultadoFase[]> {
  const pasos: ResultadoFase[] = [];
  for (let i = 0; i < 50; i++) {
    const r = await aplicarFase(companyId, 2027, cargaId, USUARIO);
    pasos.push(r);
    if (r.terminada) return pasos;
  }
  throw new Error('No termina');
}

async function contar(companyId: string) {
  const [cuentas, clientes, proveedores, ejercicios, periodos, asientos, partidas, reglas] = await Promise.all([
    prisma.chartOfAccounts.count({ where: { companyId } }),
    prisma.customer.count({ where: { companyId } }),
    prisma.supplier.count({ where: { companyId } }),
    prisma.fiscalYear.count({ where: { companyId } }),
    prisma.periodo.count({ where: { companyId } }),
    prisma.journalEntry.count({ where: { companyId } }),
    prisma.partidaPendiente.count({ where: { companyId } }),
    prisma.reglasContables.count({ where: { companyId } }),
  ]);
  return { cuentas, clientes, proveedores, ejercicios, periodos, asientos, partidas, reglas };
}

describe('empresa A: todo junto, sin regularizar, con diario', () => {
  const E = `arr-a-${SUFIJO}`;
  let r: RespuestaCarga;
  beforeAll(async () => {
    await empresa(E);
  });

  it('el análisis reconoce cada fichero, no escribe nada contable y da «Todo correcto»', async () => {
    const antes = await contar(E);
    r = await subirYAnalizar(E, 2027, USUARIO, ficheros(todosA()), AJUSTES_A, TODOS);
    expect(await contar(E)).toEqual(antes);
    expect(r.carga).toMatchObject({ version: 1, estado: 'BORRADOR', tipo: 'PROVISIONAL' });
    expect(r.vista.hojas.map((h) => h.tipo).sort()).toEqual(['CARTERA', 'DIARIO', 'INMOVILIZADO', 'PLAN', 'SUMAS_Y_SALDOS', 'TERCEROS_CLIENTES', 'TERCEROS_PROVEEDORES']);
    expect(r.vista.comprobaciones.puntos.filter((p) => p.nivel !== 'INFO')).toEqual([]);
    expect(r.vista.comprobaciones.nivel).toBe('CORRECTO');
    expect(r.vista.terceros.resumen).toMatchObject({ crear: 6, pendientes: 0 });
    expect(r.vista.plan.longitud).toMatchObject({ delPlan: 10, seFija: true });
    expect(r.vista.historico).toMatchObject({ asientos: DIARIO_A.length, cuadraConSumasYSaldos: true, seImporta: true });
    expect(r.vista.apertura).toMatchObject({ fecha: '2027-01-01', origen: 'SUMAS_Y_SALDOS', tipoSumasSaldos: 'SIN_REGULARIZAR', resultado: 7200, debe: 43730, haber: 43730 });
    expect(r.vista.cartera).toMatchObject({ partidas: CARTERA_A.length, sinDetalle: 0, cobros: 12100, pagos: 5445 });
    expect(r.vista.inmovilizado).toMatchObject({ activos: 2, seImporta: true });
    expect(r.vista.llevanzaExterna).toBe(true);
    expect(r.vista.confirmacion).toMatch(
      /^Se crearán \d+ cuentas, 6 clientes y proveedores, 11 asientos de 2026, la apertura del 1-1-2027, 5 facturas pendientes y 2 bienes de inmovilizado\. 2026 quedará como «lo llevó la gestoría»: se podrá consultar, pero no apuntar nada con fecha de 2026\. Los impuestos se llevarán en la app desde el 1-1-2027: los modelos de 2026 los presentó la gestoría y no saldrán como pendientes\. Podrás deshacerlo/,
    );
    expect(r.vista.puedeConfirmar).toBe(true);
    // El mismo análisis da la misma huella.
    const otra = await reanalizar(E, 2027, r.carga.id, USUARIO, undefined, TODOS);
    expect(otra.vista.huella).toBe(r.vista.huella);
    // Subir otra vez el mismo fichero: avisa y no lo duplica.
    const repetido = await subirYAnalizar(E, 2027, USUARIO, ficheros([ficherosEmpresaA().plan]), undefined, TODOS);
    expect(repetido.avisos).toEqual(['«plan_cuentas_2026.xlsx» ya está en la carga.']);
    expect(repetido.carga.ficheros).toHaveLength(7);
  });

  it('confirmar con otra huella da 409; con la buena, pasa a importarse', async () => {
    const e = await error(confirmarCarga(E, 2027, r.carga.id, 'otra', USUARIO));
    expect(e.statusCode).toBe(409);
    expect(e.details).toMatchObject({ codigo: 'HUELLA_CAMBIADA' });
    const c = await confirmarCarga(E, 2027, r.carga.id, r.vista.huella, USUARIO);
    expect(c.fases.map((f) => f.fase)).toEqual(['EJERCICIOS', 'PLAN_Y_TERCEROS', 'HISTORICO', 'APERTURA', 'CARTERA', 'INMOVILIZADO', 'BANCOS', 'COMPARATIVO', 'FINAL']);
    expect((await error(confirmarCarga(E, 2027, r.carga.id, r.vista.huella, USUARIO))).statusCode).toBe(409);
  });

  it('las fases importan todo en orden', async () => {
    const pasos = await aplicarTodo(E, r.carga.id);
    expect(pasos.map((p) => p.fase)).toEqual(['EJERCICIOS', 'PLAN_Y_TERCEROS', 'HISTORICO', 'APERTURA', 'CARTERA', 'INMOVILIZADO', 'BANCOS', 'COMPARATIVO', 'FINAL']);
    expect(pasos.at(-1)?.hecho).toBe('La contabilidad de 2026 está completa y cuadra. Ya puedes seguir con 2027.');

    // Ejercicios: 2026 llevado fuera y de solo lectura.
    expect((await prisma.fiscalYear.findFirst({ where: { companyId: E, label: '2026' } }))?.llevanza).toBe('EXTERNA');
    expect(await prisma.fiscalYear.count({ where: { companyId: E, label: '2027' } })).toBe(1);
    await expect(comprobarFechaAbierta(E, '2026-11-30')).rejects.toMatchObject({ statusCode: 409 });

    // Plan: todas las subcuentas, también las de saldo cero, con su nombre; longitud 10.
    expect(await prisma.chartOfAccounts.findFirst({ where: { companyId: E, codigo: '4300000003' }, select: { nombre: true } })).toEqual({ nombre: 'Cliente Cero SL' });
    expect(await prisma.chartOfAccounts.findFirst({ where: { companyId: E, codigo: '2130000000' }, select: { nombre: true, notas: true } })).toEqual({ nombre: 'Maquinaria taller', notas: `Arranque 2027, carga ${r.carga.id}` });
    expect(await longitudSubcuentasGuardada(E)).toBe(10);
    // Las cuentas de 3 dígitos del PGC que la app no trae de serie (213 Maquinaria) cuelgan de su subgrupo.
    expect(await prisma.chartOfAccounts.findFirst({ where: { companyId: E, codigo: '213' }, select: { nombre: true, parentCodigo: true } })).toEqual({ nombre: 'Maquinaria', parentCodigo: '21' });

    // Clientes y proveedores con su subcuenta y sus datos.
    const alfa = await prisma.customer.findFirst({ where: { companyId: E, nifCif: NIF.alfa } });
    expect(alfa).toMatchObject({ nombreFiscal: 'Cliente Alfa SL', subcuenta430: '4300000001', direccion: 'Calle Mayor 1', cp: '46001', email: 'alfa@ejemplo.es' });
    const luz = await prisma.supplier.findFirst({ where: { companyId: E, nifCif: NIF.luz } });
    expect(luz).toMatchObject({ subcuenta410: '4100000001', direccion: 'Calle Ñandú 9', municipio: 'Burjassot' });
    expect(await prisma.customer.count({ where: { companyId: E } })).toBe(3);
    expect(await prisma.supplier.count({ where: { companyId: E } })).toBe(3);

    // Diario de 2026 como histórico.
    const hist = await prisma.journalEntry.findMany({ where: { companyId: E, estado: 'POSTED', origen: { startsWith: 'HISTORICO' } }, orderBy: { numeroAsiento: 'asc' }, include: { lineas: true } });
    expect(hist).toHaveLength(DIARIO_A.length);
    expect(hist[0]).toMatchObject({ numeroAsiento: 'HIST-00001', origen: 'HISTORICO_APERTURA' });
    expect(hist[1].lineas[0].referencia).toBe('As. 2 · Fra. A-2026-001 Cliente Alfa');

    // Apertura del 1-1-2027 con una línea por subcuenta y el resultado en la 129.
    const ap = await prisma.journalEntry.findMany({ where: { companyId: E, estado: 'POSTED', origen: 'APERTURA' }, include: { lineas: true } });
    expect(ap).toHaveLength(1);
    expect(ap[0].fecha.toISOString().slice(0, 10)).toBe('2027-01-01');
    expect(ap[0].lineas.find((l) => l.accountCode === '1290000000')).toMatchObject({ haber: 7200, accountName: 'Resultado del ejercicio' });
    expect(ap[0].lineas.find((l) => l.accountCode === '4300000001')).toMatchObject({ debe: 6050, accountName: 'Cliente Alfa SL' });

    // Los informes de 2027 parten de la apertura: 2026 no se suma.
    const s2027 = saldosDelEjercicio(await obtenerAsientosEjercicio(E, 2027), 2027);
    expect(s2027.balance.get('4300000001')).toBe(6050);
    expect(s2027.balance.get('5720000001')).toBe(18630);

    // El mayor de clientes de 2027 parte de la apertura importada.
    const mayor = await informeMayorTerceros(E, 'clientes', { desde: '2027-01-01', hasta: '2027-12-31', ejercicio: 2027 });
    expect(mayor.terceros.find((t) => t.nombre === 'Cliente Alfa SL')?.saldoFinal).toBe(6050);

    // Cartera: una partida por factura, con su ficha.
    const partidas = await prisma.partidaPendiente.findMany({ where: { companyId: E, cargaId: r.carga.id }, orderBy: { numeroDocumento: 'asc' } });
    expect(partidas).toHaveLength(CARTERA_A.length);
    expect(partidas.find((p) => p.numeroDocumento === 'A-2026-001')).toMatchObject({ tipo: 'COBRO', subcuenta: '4300000001', customerId: alfa!.id, importePendiente: 6050, importeOriginal: 12100, fechaVencimiento: '2026-03-15', sinDetalle: false, estado: 'PENDIENTE' });
    expect(partidas.find((p) => p.numeroDocumento === 'L-0330')).toMatchObject({ tipo: 'PAGO', supplierId: luz!.id, importePendiente: 605 });

    // Inmovilizado y comparativo.
    const activos = await prisma.activoFijo.findMany({ where: { companyId: E }, orderBy: { descripcion: 'asc' } });
    expect(activos.map((x) => [x.descripcion, x.subcuentaBien, x.subcuentaAmortAcum, x.subcuentaDotacion, x.coste, x.amortAcumuladaInicial, x.coeficiente, x.fechaInicioAmortizacion])).toEqual([
      ['Mesas y sillas', '2160000000', '2816000000', '6810000000', 3000, 300, 10, '2027-01-01'],
      ['Torno CNC', '2130000000', '2813000000', '6810000000', 10000, 3000, 10, '2027-01-01'],
    ]);
    expect((await prisma.priorYearData.findFirst({ where: { companyId: E, ejercicio: 2026 }, select: { beneficio: true } }))?.beneficio).toBe(7200);

    // La carga queda confirmada, con su rastro.
    const c = await prisma.cargaArranque.findUniqueOrThrow({ where: { id: r.carga.id } });
    expect(c.estado).toBe('CONFIRMADA');
    expect(c.confirmadaEn).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { companyId: E, action: 'ARRANQUE_CONFIRMADA' } })).toBe(1);
    expect(((await prisma.reglasContables.findUnique({ where: { companyId: E } }))?.data as { planAnterior?: { cargaId: string } }).planAnterior?.cargaId).toBe(r.carga.id);
    // Ya importada: no se vuelve a aplicar.
    expect((await error(aplicarFase(E, 2027, r.carga.id, USUARIO))).statusCode).toBe(409);
  });

  it('repetir la carga (versión 2) sustituye la apertura, el histórico y las partidas sin duplicar nada', async () => {
    const v2 = await subirYAnalizar(E, 2027, USUARIO, ficheros(todosA()), AJUSTES_A, TODOS);
    expect(v2.carga.version).toBe(2);
    expect(v2.avisos).toHaveLength(7);
    expect(v2.avisos[0]).toMatch(/mismo fichero que ya trajiste en la versión 1/);
    expect(v2.vista.terceros.resumen).toMatchObject({ yaEnlazadas: 6, crear: 0 });
    expect(v2.vista.plan.nuevas).toBe(0);
    expect(v2.vista.apertura?.sustituye).toEqual(['APERT-00001']);
    expect(v2.vista.sustituyeVersion).toBe(1);
    await confirmarCarga(E, 2027, v2.carga.id, v2.vista.huella, USUARIO);
    await aplicarTodo(E, v2.carga.id);
    expect(await prisma.journalEntry.count({ where: { companyId: E, estado: 'POSTED', origen: 'APERTURA' } })).toBe(1);
    expect(await prisma.journalEntry.count({ where: { companyId: E, estado: 'POSTED', origen: { startsWith: 'HISTORICO' } } })).toBe(DIARIO_A.length);
    expect(await prisma.partidaPendiente.count({ where: { companyId: E, estado: 'PENDIENTE' } })).toBe(CARTERA_A.length);
    expect(await prisma.activoFijo.count({ where: { companyId: E, activo: true } })).toBe(2);
    expect(await prisma.customer.count({ where: { companyId: E } })).toBe(3);
    expect((await prisma.cargaArranque.findMany({ where: { companyId: E }, orderBy: { version: 'asc' } })).map((c) => c.estado)).toEqual(['SUSTITUIDA', 'CONFIRMADA']);
  });
});

describe('empresa B: 8 dígitos, regularizado, PyG aparte, sin diario', () => {
  const E = `arr-b-${SUFIJO}`;
  beforeAll(() => empresa(E));

  it('faltan datos (diario), pero se puede traer; el resultado lo da la PyG; la apertura lleva el resultado de la 129', async () => {
    const b = ficherosEmpresaB();
    const r = await subirYAnalizar(E, 2027, USUARIO, ficheros(Object.values(b)), undefined, TODOS);
    expect(r.vista.comprobaciones.nivel).toBe('FALTAN_DATOS');
    expect(r.vista.comprobaciones.puntos.filter((p) => p.nivel === 'FALTA').map((p) => p.clave)).toEqual(['falta:DIARIO', 'bancos:extracto', 'bancos:cuenta', 'iva:303-4t']);
    expect(r.vista.apertura).toMatchObject({ tipoSumasSaldos: 'REGULARIZADO', resultado: 3000 });
    expect(r.vista.plan.longitud.delPlan).toBe(8);
    await confirmarCarga(E, 2027, r.carga.id, r.vista.huella, USUARIO);
    const pasos = await aplicarTodo(E, r.carga.id);
    expect(pasos.find((p) => p.fase === 'HISTORICO')?.fases.find((f) => f.fase === 'HISTORICO')?.estado).toBe('OMITIDA');
    expect(pasos.at(-1)?.hecho).toMatch(/Quedan datos por completar/);
    const ap = await prisma.journalEntry.findFirstOrThrow({ where: { companyId: E, estado: 'POSTED', origen: 'APERTURA' }, include: { lineas: true } });
    expect(ap.lineas.find((l) => l.accountCode === '12900000')).toMatchObject({ haber: 3000 });
    expect(await longitudSubcuentasGuardada(E)).toBe(8);
    expect((await prisma.fiscalYear.findFirst({ where: { companyId: E, label: '2026' } }))?.llevanza).toBe('EXTERNA');
    expect(await prisma.customer.findFirst({ where: { companyId: E, nifCif: NIF.gamma }, select: { subcuenta430: true } })).toEqual({ subcuenta430: '43000001' });
    // El panel avisa de lo que falta.
    expect(await avisoArranque(E)).toMatchObject({
      nivel: 'FALTAN_DATOS',
      total: 4,
      puntos: [
        expect.stringMatching(/^Falta el libro diario/),
        expect.stringMatching(/^Escribe el saldo del extracto/),
        expect.stringMatching(/cuenta de bancos no está enlazada/),
        expect.stringMatching(/^Escribe el resultado del 303 del 4T/),
      ],
    });
  });
});

describe('D1: carga de diciembre solo con el plan y los listados', () => {
  const E = `arr-d1-${SUFIJO}`;
  beforeAll(() => empresa(E));

  it('crea plan y fichas, pero 2026 sigue en la app y no hay apertura', async () => {
    const a = ficherosEmpresaA();
    const r = await subirYAnalizar(E, 2027, USUARIO, ficheros([a.plan, a.clientes, a.proveedores]), undefined, TODOS);
    expect(r.vista.llevanzaExterna).toBe(false);
    expect(r.vista.apertura).toBeNull();
    expect(r.vista.comprobaciones.nivel).toBe('FALTAN_DATOS');
    await confirmarCarga(E, 2027, r.carga.id, r.vista.huella, USUARIO);
    await aplicarTodo(E, r.carga.id);
    expect((await prisma.fiscalYear.findFirst({ where: { companyId: E, label: '2026' } }))?.llevanza).toBe('APP');
    await expect(comprobarFechaAbierta(E, '2026-12-15')).resolves.toBeUndefined();
    expect(await prisma.journalEntry.count({ where: { companyId: E } })).toBe(0);
    expect(await prisma.customer.count({ where: { companyId: E } })).toBe(3);
  });
});

describe('D2 y errores', () => {
  it('un diario que no cuadra con el sumas y saldos se deja fuera; el resto se importa', async () => {
    const E = `arr-d2-${SUFIJO}`;
    await empresa(E);
    const a = ficherosEmpresaA();
    const r = await subirYAnalizar(E, 2027, USUARIO, ficheros([a.plan, a.sumasSaldos, diarioQueNoCuadraConSaldos(), a.cartera]), { resultadoDeclarado: 7200 }, TODOS);
    expect(r.vista.comprobaciones.nivel).toBe('FALTAN_DATOS');
    expect(r.vista.comprobaciones.excluidos).toEqual(['DIARIO']);
    expect(r.vista.historico).toMatchObject({ seImporta: false, cuadraConSumasYSaldos: false });
    // Lo escrito a mano vuelve en el resumen, para corregirlo en pantalla.
    expect(r.vista.resultadoDeclarado).toBe(7200);
    await confirmarCarga(E, 2027, r.carga.id, r.vista.huella, USUARIO);
    await aplicarTodo(E, r.carga.id);
    expect(await prisma.journalEntry.count({ where: { companyId: E, origen: { startsWith: 'HISTORICO' } } })).toBe(0);
    expect(await prisma.journalEntry.count({ where: { companyId: E, estado: 'POSTED', origen: 'APERTURA' } })).toBe(1);
  });

  it('un sumas y saldos con el cierre bloquea la carga', async () => {
    const E = `arr-err-${SUFIJO}`;
    await empresa(E);
    const a = ficherosEmpresaA();
    const r = await subirYAnalizar(E, 2027, USUARIO, ficheros([a.plan, sumasSaldosConCierre()]), undefined, TODOS);
    expect(r.vista.comprobaciones.nivel).toBe('ERRORES');
    expect(r.vista.puedeConfirmar).toBe(false);
    expect(r.vista.comprobaciones.mensaje).toMatch(/^Todavía no se puede traer la contabilidad: El sumas y saldos tiene todas las cuentas a cero/);
    const e = await error(confirmarCarga(E, 2027, r.carga.id, r.vista.huella, USUARIO));
    expect(e.statusCode).toBe(409);
    expect(e.details).toMatchObject({ codigo: 'CARGA_CON_ERRORES' });
  });

  it('una hoja dudosa se arregla eligiendo su tipo; una ilegible se puede quitar de la carga', async () => {
    const E = `arr-dudosa-${SUFIJO}`;
    await empresa(E);
    const libroListado = { nombre: 'listado.csv', contenido: Buffer.from(`NIF;Nombre\n${NIF.alfa};Cliente Alfa SL\n`, 'utf8') };
    const pdf = { nombre: 'balance.pdf', contenido: Buffer.from('%PDF-1.4\n%%EOF', 'latin1') };
    const r = await subirYAnalizar(E, 2027, USUARIO, [libroListado, pdf], undefined, TODOS);
    expect(r.vista.comprobaciones.nivel).toBe('ERRORES');
    const dudosa = r.vista.hojas.find((h) => h.fichero === 'listado.csv')!;
    expect(dudosa).toMatchObject({ dudosa: true, tipo: 'DESCONOCIDO' });
    expect(dudosa.candidatos.map((c) => c.tipo).sort()).toEqual(['TERCEROS_CLIENTES', 'TERCEROS_PROVEEDORES']);
    const ilegible = r.vista.hojas.find((h) => h.fichero === 'balance.pdf')!;
    expect(ilegible.error?.mensaje).toMatch(/PDF no se pueden leer/);
    const r2 = await reanalizar(E, 2027, r.carga.id, USUARIO, { hojas: { [dudosa.id]: { tipo: 'TERCEROS_CLIENTES' }, [ilegible.id]: { excluida: true } } }, TODOS);
    expect(r2.vista.hojas.find((h) => h.id === dudosa.id)).toMatchObject({ tipo: 'TERCEROS_CLIENTES', elegidoAMano: true, dudosa: false });
    expect(r2.vista.comprobaciones.puntos.filter((p) => p.nivel === 'ERROR')).toEqual([]);
  });

  it('dos confirmaciones a la vez: solo una pasa', async () => {
    const E = `arr-doble-${SUFIJO}`;
    await empresa(E);
    const a = ficherosEmpresaA();
    const r = await subirYAnalizar(E, 2027, USUARIO, ficheros([a.plan, a.clientes, a.proveedores]), undefined, TODOS);
    const resultados = await Promise.allSettled([confirmarCarga(E, 2027, r.carga.id, r.vista.huella, USUARIO), confirmarCarga(E, 2027, r.carga.id, r.vista.huella, USUARIO)]);
    expect(resultados.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((resultados.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason.statusCode).toBe(409);
    // Una carga a medias se ve en el panel.
    expect(await avisoArranque(E)).toMatchObject({ nivel: 'A_MEDIAS' });
  });
});

describe('formatos de los programas de las gestorías', () => {
  it('ContaPlus (SUBCTA.DBF y DIARIO.DBF) con el sumas y saldos de a3 por niveles: se reconocen y cuadran', async () => {
    const E = `arr-cp-${SUFIJO}`;
    await empresa(E);
    const r = await subirYAnalizar(E, 2027, USUARIO, ficheros([contaplusSubcuentas(), contaplusDiario(), a3SumasSaldos()]), { resultadoDeclarado: 7200 }, TODOS);
    expect(r.vista.hojas.map((h) => [h.fichero, h.tipo, h.programa])).toEqual([
      ['SUBCTA.DBF', 'PLAN', 'contaplus'],
      ['DIARIO.DBF', 'DIARIO', 'contaplus'],
      ['SumasSaldos_a3.xlsx', 'SUMAS_Y_SALDOS', 'a3'],
    ]);
    expect(r.vista.historico).toMatchObject({ asientos: DIARIO_A.length, cuadraConSumasYSaldos: true });
    expect(r.vista.apertura).toMatchObject({ resultado: 7200 });
    // El plan de ContaPlus trae el NIF de todos: los listados no hacen falta; falta la cartera.
    expect(r.vista.comprobaciones.puntos.filter((p) => p.nivel === 'FALTA').map((p) => p.clave)).toEqual(['falta:CARTERA', 'cartera:cuadre', 'bancos:extracto', 'bancos:cuenta', 'iva:303-4t']);
    expect(r.vista.cartera?.sinDetalle).toBe(5);
  });

  it('el análisis sin guardar da lo mismo que el guardado (determinista)', async () => {
    const E = `arr-det-${SUFIJO}`;
    await empresa(E);
    const fs = todosA().map((f, i) => ({ nombre: f.nombre, sha256: `${i}`.padStart(64, '0'), contenido: f.contenido }));
    const a1 = await analizarCarga(E, 2027, prepararDatos(fs, {}), {}, TODOS);
    const a2 = await analizarCarga(E, 2027, prepararDatos(fs, {}), {}, TODOS);
    expect(a1.huella).toBe(a2.huella);
    expect(a1.comprobaciones.nivel).toBe('FALTAN_DATOS');
  });
});

describe('la puesta en marcha no toca lo que trajo la carga', () => {
  it('ni la apertura de 2027 ni el diario de 2026', async () => {
    const E = `arr-pem-${SUFIJO}`;
    await empresa(E);
    const a = ficherosEmpresaA();
    const r = await subirYAnalizar(E, 2027, USUARIO, ficheros([a.plan, a.sumasSaldos, a.clientes, a.proveedores]), { resultadoDeclarado: 7200 }, TODOS);
    await confirmarCarga(E, 2027, r.carga.id, r.vista.huella, USUARIO);
    await aplicarTodo(E, r.carga.id);
    const pem = await import('../services/puestaEnMarcha/puestaEnMarcha.service');
    const e1 = await error(pem.anularApertura(E, 2027));
    expect(e1.statusCode).toBe(409);
    expect(e1.message).toMatch(/Traer la contabilidad de 2026/);
    const cuentas = [
      { codigo: '5720000001', nombre: 'Banco', saldo: 10 },
      { codigo: '1000000000', nombre: 'Capital', saldo: -10 },
    ];
    expect((await pem.previsualizarApertura(E, { cuentas }, { ejercicio: 2027 })).errores[0]).toMatch(/Traer la contabilidad de 2026/);
    await expect(pem.confirmarApertura(E, { cuentas }, { ejercicio: 2027, reemplazar: true })).rejects.toMatchObject({ statusCode: 409 });
    const lectura = {
      formato: 'xlsx',
      filaCabecera: 1,
      columnas: [],
      mapeo: {},
      separadorDecimal: ',' as const,
      mayorPorCuenta: false,
      apuntes: [
        { fila: 2, fecha: '2026-05-01', asiento: '1', cuenta: '5720000001', nombre: '', concepto: 'x', debe: 5, haber: 0 },
        { fila: 3, fecha: '2026-05-01', asiento: '1', cuenta: '1000000000', nombre: '', concepto: 'x', debe: 0, haber: 5 },
      ],
      filasDescartadas: [],
      avisos: [],
    };
    expect((await pem.previsualizarDiario(E, lectura, {})).errores.join(' ')).toMatch(/2026 lo lleva tu gestoría/);
    await expect(pem.confirmarDiario(E, lectura, {})).rejects.toMatchObject({ statusCode: 409 });
  });
});
