/**
 * Cierre del ejercicio y traspaso de saldos al siguiente, todo en la BD propia
 * (ya no depende de FacturaScripts):
 *  1. REGULARIZACION (31/12): salda gastos (6) e ingresos (7) contra la 129.
 *  2. CIERRE (31/12): salda las cuentas de balance (1-5) y la 129.
 *  3. APERTURA (1/1 del siguiente): reabre esos saldos. Se crea siempre, y con
 *     ella el ejercicio siguiente si no existia.
 * El ejercicio queda CLOSED. No se puede cerrar dos veces: para rehacerlo hay
 * que deshacer el cierre, y solo se puede mientras el ejercicio siguiente no
 * tenga mas asientos que la apertura.
 */
import { prisma } from '../config/database';
import { obtenerAsientosHastaFinDe, saldosDelEjercicio, AsientoSimple } from './contabilidadDatos.service';
import { listarPeriodos, cambiarEstadoPeriodo } from './periodos.service';
import { obtenerCierreConfig } from './cierreConfig.service';
import { calcularCuadreBancos } from './cuadreBancos.service';
import { legalConfigService } from './legalConfig.service';
import { calcularPlazos, TipoLibro } from '../domain/registroMercantil.model';
import { badRequest, conflict } from '../utils/http-errors';
import { aCentimos } from '../utils/money';
import { anularAsientos, grabarAsientos, OPCIONES_TX, rangoEjercicio, type AsientoNuevo } from './puestaEnMarcha/asientosEnBloque';
import { analizarCuentas } from './puestaEnMarcha/planCuentas';
import { asegurarEjercicio, cuentaResultado } from './puestaEnMarcha/puestaEnMarcha.service';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface LineaCierre {
  cuenta: string;
  nombre: string;
  debe: number;
  haber: number;
}

export interface AsientoCierrePrevisto {
  tipo: 'REGULARIZACION' | 'CIERRE' | 'APERTURA';
  fecha: string;
  concepto: string;
  lineas: LineaCierre[];
  debe: number;
  haber: number;
}

export interface CalculoCierre {
  ingresos: number;
  gastos: number;
  resultado: number;
  /** Resultado de años anteriores que nunca se regularizo (va a 120/121). */
  resultadoAnteriores: number;
  cuentaResultado: string;
  regularizacion: LineaCierre[];
  cierre: LineaCierre[];
  apertura: LineaCierre[];
}

/** Lineas a partir de saldos deudores por cuenta (agrupadas, sin ceros, ordenadas). */
function lineasDesdeSaldos(saldos: Map<string, number>): LineaCierre[] {
  return [...saldos.entries()]
    .map(([cuenta, s]) => [cuenta, round2(s)] as const)
    .filter(([, s]) => aCentimos(s) !== 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cuenta, s]) => ({ cuenta, nombre: '', debe: s > 0 ? s : 0, haber: s < 0 ? round2(-s) : 0 }));
}

const sumar = (m: Map<string, number>, k: string, v: number) => m.set(k, round2((m.get(k) ?? 0) + v));

/**
 * Calculo puro de los tres asientos a partir de los asientos POSTED hasta el
 * fin del ejercicio (sin regularizaciones ni cierres anteriores del mismo).
 */
export function calcularAsientosCierre(asientos: AsientoSimple[], ejercicio: number): CalculoCierre {
  const { balance, pyg, resultadoAnteriores } = saldosDelEjercicio(asientos, ejercicio);
  const c129 = cuentaResultado([...balance.keys(), ...pyg.keys()]);
  const largo = c129.length;

  // 1. Regularizacion: cada 6/7 a cero contra la 129.
  const reg = new Map<string, number>();
  let ingresos = 0;
  let gastos = 0;
  for (const [cuenta, saldoDeudor] of pyg) {
    if (aCentimos(saldoDeudor) === 0) continue;
    if (cuenta.startsWith('7')) ingresos = round2(ingresos - saldoDeudor);
    else gastos = round2(gastos + saldoDeudor);
    sumar(reg, cuenta, -saldoDeudor);
  }
  const resultado = round2(ingresos - gastos);
  // Beneficio: la 129 queda acreedora (haber); perdida: deudora.
  if (reg.size) sumar(reg, c129, -resultado);

  // 2. Cierre: cada cuenta de balance a cero, mas la 129 con el resultado.
  const despues = new Map<string, number>();
  for (const [cuenta, s] of balance) sumar(despues, cuenta, s);
  if (aCentimos(resultado) !== 0) sumar(despues, c129, -resultado);
  if (aCentimos(resultadoAnteriores) !== 0) {
    // Gastos/ingresos de años anteriores que nunca se regularizaron: van a
    // remanente (120) o a resultados negativos de ejercicios anteriores (121).
    const cuenta = (resultadoAnteriores > 0 ? '120' : '121').padEnd(Math.max(3, largo), '0');
    sumar(despues, cuenta, -resultadoAnteriores);
  }
  const cierreSaldos = new Map<string, number>();
  for (const [cuenta, s] of despues) cierreSaldos.set(cuenta, -s);

  return {
    ingresos,
    gastos,
    resultado,
    resultadoAnteriores,
    cuentaResultado: c129,
    regularizacion: lineasDesdeSaldos(reg),
    cierre: lineasDesdeSaldos(cierreSaldos),
    apertura: lineasDesdeSaldos(despues),
  };
}

const totales = (l: LineaCierre[]) => ({
  debe: round2(l.reduce((s, x) => s + x.debe, 0)),
  haber: round2(l.reduce((s, x) => s + x.haber, 0)),
});

export interface VistaCierre {
  ejercicio: number;
  estado: 'ABIERTO' | 'CERRADO';
  ingresos: number;
  gastos: number;
  resultado: number;
  resultadoAnteriores: number;
  periodosAbiertos: number;
  bancos: { exigido: boolean; cuadra: boolean; descuadradas: number };
  asientos: AsientoCierrePrevisto[];
  cierreExistente: Array<{ id: string; numero: string; tipo: string; fecha: string }>;
  siguiente: { ejercicio: number; existe: boolean; apertura: { id: string; numero: string } | null; otrosAsientos: number; cerrado: boolean };
  avisos: string[];
  motivosBloqueo: string[];
  puedeCerrar: boolean;
  puedeDeshacer: boolean;
  motivoNoDeshacer: string | null;
}

async function asientosDeCierre(companyId: string, ejercicio: number) {
  return prisma.journalEntry.findMany({
    where: { companyId, estado: 'POSTED', origen: { in: ['REGULARIZACION', 'CIERRE'] }, fecha: rangoEjercicio(ejercicio) },
    select: { id: true, numeroAsiento: true, origen: true, fecha: true },
    orderBy: { numeroAsiento: 'asc' },
  });
}

async function estadoSiguiente(companyId: string, ejercicio: number) {
  const sig = ejercicio + 1;
  const [fy, apertura, otros] = await Promise.all([
    prisma.fiscalYear.findFirst({ where: { companyId, label: String(sig) } }),
    prisma.journalEntry.findFirst({
      where: { companyId, estado: 'POSTED', origen: 'APERTURA', fecha: rangoEjercicio(sig) },
      select: { id: true, numeroAsiento: true },
    }),
    prisma.journalEntry.count({ where: { companyId, estado: 'POSTED', origen: { not: 'APERTURA' }, fecha: rangoEjercicio(sig) } }),
  ]);
  return {
    ejercicio: sig,
    existe: !!fy,
    fechaInicio: fy?.fechaInicio && fy.fechaInicio.startsWith(String(sig)) ? fy.fechaInicio : `${sig}-01-01`,
    apertura: apertura ? { id: apertura.id, numero: apertura.numeroAsiento } : null,
    otrosAsientos: otros,
    cerrado: fy?.estado === 'CLOSED',
  };
}

export async function previsualizarCierre(companyId: string, ejercicio: number, opciones: { reemplazarApertura?: boolean } = {}): Promise<VistaCierre> {
  const [existentes, fy, periodos, config, siguiente] = await Promise.all([
    asientosDeCierre(companyId, ejercicio),
    prisma.fiscalYear.findFirst({ where: { companyId, label: String(ejercicio) } }),
    listarPeriodos(companyId, ejercicio),
    obtenerCierreConfig(companyId),
    estadoSiguiente(companyId, ejercicio),
  ]);
  const cerrado = existentes.length > 0 || fy?.estado === 'CLOSED';
  const avisos: string[] = [];
  const motivos: string[] = [];

  const periodosAbiertos = periodos.filter((p) => p.estado === 'abierto').length;
  const bancos = { exigido: config.exigirCuadreBancos, cuadra: true, descuadradas: 0 };
  if (config.exigirCuadreBancos && !cerrado) {
    const cuadre = await calcularCuadreBancos(companyId, ejercicio, config.toleranciaCuadre);
    bancos.cuadra = cuadre.todasCuadran;
    bancos.descuadradas = cuadre.cuentas.filter((c) => !c.cuadra).length;
    if (!cuadre.todasCuadran) motivos.push(`${bancos.descuadradas} cuenta(s) bancaria(s) no cuadran con la contabilidad (la empresa exige el cuadre para cerrar).`);
  }

  let calculo: CalculoCierre | null = null;
  const asientos: AsientoCierrePrevisto[] = [];
  if (cerrado) {
    motivos.push(`El ejercicio ${ejercicio} ya está cerrado.`);
  } else {
    calculo = calcularAsientosCierre(await obtenerAsientosHastaFinDe(companyId, ejercicio), ejercicio);
    const codigos = [...new Set([...calculo.regularizacion, ...calculo.cierre].map((l) => l.cuenta))];
    const { nombres } = await analizarCuentas(companyId, codigos.map((codigo) => ({ codigo, nombre: '' })));
    const nombrar = (l: LineaCierre[]) => l.map((x) => ({ ...x, nombre: nombres.get(x.cuenta) ?? '' }));
    const fin = `${ejercicio}-12-31`;
    if (calculo.regularizacion.length) {
      asientos.push({ tipo: 'REGULARIZACION', fecha: fin, concepto: `Regularización ejercicio ${ejercicio}`, lineas: nombrar(calculo.regularizacion), ...totales(calculo.regularizacion) });
    }
    if (calculo.cierre.length) {
      asientos.push({ tipo: 'CIERRE', fecha: fin, concepto: `Cierre ejercicio ${ejercicio}`, lineas: nombrar(calculo.cierre), ...totales(calculo.cierre) });
      asientos.push({ tipo: 'APERTURA', fecha: siguiente.fechaInicio, concepto: `Apertura ejercicio ${ejercicio + 1}`, lineas: nombrar(calculo.apertura), ...totales(calculo.apertura) });
    }
    if (asientos.length === 0) motivos.push(`El ejercicio ${ejercicio} no tiene saldos que cerrar.`);
    if (aCentimos(calculo.resultadoAnteriores) !== 0) {
      avisos.push(
        `Hay ${calculo.resultadoAnteriores.toFixed(2)} € de resultados de años anteriores que nunca se regularizaron: se traspasan a la cuenta ${calculo.resultadoAnteriores > 0 ? '120 (Remanente)' : '121 (Resultados negativos de ejercicios anteriores)'}.`,
      );
    }
    if (periodosAbiertos > 0) avisos.push(`${periodosAbiertos} mes(es) del ${ejercicio} siguen abiertos: al cerrar se bloquearán.`);
    if (siguiente.apertura) {
      const txt = `El ejercicio ${ejercicio + 1} ya tiene un asiento de apertura (${siguiente.apertura.numero}), seguramente importado.`;
      if (opciones.reemplazarApertura) avisos.push(`${txt} Se anulará y se sustituirá por el del cierre.`);
      else motivos.push(`${txt} Marca "Sustituir la apertura existente" o anúlala antes.`);
    }
    if (siguiente.cerrado) motivos.push(`El ejercicio ${ejercicio + 1} ya está cerrado.`);
  }

  let motivoNoDeshacer: string | null = null;
  if (!cerrado) motivoNoDeshacer = 'El ejercicio no está cerrado.';
  else if (existentes.length === 0) motivoNoDeshacer = 'El ejercicio se marcó como cerrado sin asientos de cierre en esta aplicación.';
  else if (siguiente.cerrado) motivoNoDeshacer = `El ejercicio ${ejercicio + 1} también está cerrado: deshaz antes su cierre.`;
  else if (siguiente.otrosAsientos > 0) {
    motivoNoDeshacer = `El ejercicio ${ejercicio + 1} ya tiene ${siguiente.otrosAsientos} asiento(s) además de la apertura. Para no descuadrarlo, el cierre ya no se puede deshacer automáticamente.`;
  }

  return {
    ejercicio,
    estado: cerrado ? 'CERRADO' : 'ABIERTO',
    ingresos: calculo?.ingresos ?? 0,
    gastos: calculo?.gastos ?? 0,
    resultado: calculo?.resultado ?? 0,
    resultadoAnteriores: calculo?.resultadoAnteriores ?? 0,
    periodosAbiertos,
    bancos,
    asientos,
    cierreExistente: existentes.map((e) => ({ id: e.id, numero: e.numeroAsiento, tipo: e.origen, fecha: e.fecha.toISOString().slice(0, 10) })),
    siguiente: { ejercicio: siguiente.ejercicio, existe: siguiente.existe, apertura: siguiente.apertura, otrosAsientos: siguiente.otrosAsientos, cerrado: siguiente.cerrado },
    avisos,
    motivosBloqueo: motivos,
    puedeCerrar: motivos.length === 0,
    puedeDeshacer: motivoNoDeshacer === null,
    motivoNoDeshacer,
  };
}

export interface ResultadoCierre {
  asientoRegularizacionId: string;
  asientoCierreId: string;
  asientoAperturaId: string;
  resultadoEjercicio: number;
  numeros: Record<string, string>;
}

/**
 * Ejecuta el cierre. Los meses que sigan abiertos se bloquean (antes se exigia
 * hacerlo a mano mes a mes). Rechaza un segundo cierre del mismo ejercicio.
 */
export async function ejecutarCierreEjercicio(
  companyId: string,
  ejercicio: number,
  opciones: { reemplazarApertura?: boolean } = {},
): Promise<ResultadoCierre> {
  const yaCerrado = await asientosDeCierre(companyId, ejercicio);
  if (yaCerrado.length) {
    throw conflict(
      `El ejercicio ${ejercicio} ya está cerrado (${yaCerrado.map((a) => a.numeroAsiento).join(', ')}). Si tienes que rehacerlo, usa "Deshacer cierre".`,
    );
  }
  const vista = await previsualizarCierre(companyId, ejercicio, opciones);
  if (!vista.puedeCerrar) {
    if (!vista.bancos.cuadra) throw conflict(vista.motivosBloqueo.join(' '), { bancos: vista.bancos });
    throw badRequest(vista.motivosBloqueo.join(' '));
  }

  for (const p of await listarPeriodos(companyId, ejercicio)) {
    if (p.estado === 'abierto') await cambiarEstadoPeriodo(companyId, ejercicio, p.mes, 'bloqueado');
  }

  const fin = `${ejercicio}-12-31`;
  const plazos = calcularPlazos(fin);
  const resultado = await prisma.$transaction(async (tx) => {
    // Otra peticion pudo cerrar mientras tanto.
    const otra = await tx.journalEntry.findFirst({
      where: { companyId, estado: 'POSTED', origen: { in: ['REGULARIZACION', 'CIERRE'] }, fecha: rangoEjercicio(ejercicio) },
      select: { id: true },
    });
    if (otra) throw conflict(`El ejercicio ${ejercicio} ya está cerrado.`);

    if (opciones.reemplazarApertura) {
      const aperturas = await tx.journalEntry.findMany({
        where: { companyId, estado: 'POSTED', origen: 'APERTURA', fecha: rangoEjercicio(ejercicio + 1) },
        select: { id: true },
      });
      await anularAsientos(tx, companyId, aperturas.map((a) => a.id));
    }

    const nuevos: AsientoNuevo[] = vista.asientos.map((a) => ({
      fecha: a.fecha,
      concepto: a.concepto,
      origen: a.tipo,
      lineas: a.lineas.map((l) => ({ ...l, referencia: `Cierre ${ejercicio}` })),
    }));
    const creados = await grabarAsientos(tx, companyId, nuevos);

    const fy = await asegurarEjercicio(tx, companyId, ejercicio);
    await tx.fiscalYear.update({
      where: { id: fy.id },
      data: {
        estado: 'CLOSED',
        closingDate: plazos.closingDate,
        legalizationDeadline: plazos.legalizationDeadline,
        accountsDepositDeadline: plazos.accountsDepositDeadline,
        asientosBloqueados: true,
      },
    });
    await asegurarEjercicio(tx, companyId, ejercicio + 1);
    return { creados, fyId: fy.id };
  }, OPCIONES_TX);

  await crearLibrosPendientes(companyId, resultado.fyId);

  const id = (tipo: string, vacio: string) => {
    const i = vista.asientos.findIndex((a) => a.tipo === tipo);
    return i >= 0 ? resultado.creados[i].id : vacio;
  };
  const numeros: Record<string, string> = {};
  vista.asientos.forEach((a, i) => (numeros[a.tipo] = resultado.creados[i].numero));
  return {
    asientoRegularizacionId: id('REGULARIZACION', '(sin gastos ni ingresos que regularizar)'),
    asientoCierreId: id('CIERRE', '(sin saldos que cerrar)'),
    asientoAperturaId: id('APERTURA', '(sin saldos que traspasar)'),
    resultadoEjercicio: vista.resultado,
    numeros,
  };
}

/** Borradores de los libros obligatorios del ejercicio cerrado (como fiscalYearsService.cerrar). */
async function crearLibrosPendientes(companyId: string, fiscalYearId: string): Promise<void> {
  try {
    const cfg = await legalConfigService.obtener(companyId);
    const obligatorios: TipoLibro[] = ['DIARIO', 'INVENTARIOS_CUENTAS_ANUALES', 'ACTAS'];
    if (cfg.obligaLibroSocios) obligatorios.push('SOCIOS');
    if (cfg.obligaLibroContratos) obligatorios.push('CONTRATOS');
    for (const type of obligatorios) {
      const ya = await prisma.legalBook.findFirst({ where: { fiscalYearId, type } });
      if (!ya) await prisma.legalBook.create({ data: { companyId, fiscalYearId, type, filePath: '', hash: '', status: 'PENDING' } });
    }
  } catch {
    // Los libros se pueden generar despues desde Registro Mercantil.
  }
}

/**
 * Deshace el cierre: anula regularizacion, cierre y la apertura del siguiente,
 * y reabre el ejercicio. Solo si el siguiente no tiene mas asientos que la apertura.
 */
export async function deshacerCierreEjercicio(companyId: string, ejercicio: number): Promise<{ anulados: number }> {
  const vista = await previsualizarCierre(companyId, ejercicio);
  if (!vista.puedeDeshacer) throw badRequest(vista.motivoNoDeshacer ?? 'No se puede deshacer el cierre.');

  return prisma.$transaction(async (tx) => {
    const sig = await tx.journalEntry.count({
      where: { companyId, estado: 'POSTED', origen: { not: 'APERTURA' }, fecha: rangoEjercicio(ejercicio + 1) },
    });
    if (sig > 0) throw conflict(`El ejercicio ${ejercicio + 1} ya tiene asientos: no se puede deshacer el cierre.`);
    const delCierre = await tx.journalEntry.findMany({
      where: { companyId, estado: 'POSTED', origen: { in: ['REGULARIZACION', 'CIERRE'] }, fecha: rangoEjercicio(ejercicio) },
      select: { id: true },
    });
    const aperturas = await tx.journalEntry.findMany({
      where: { companyId, estado: 'POSTED', origen: 'APERTURA', fecha: rangoEjercicio(ejercicio + 1) },
      select: { id: true },
    });
    const anulados = await anularAsientos(tx, companyId, [...delCierre, ...aperturas].map((a) => a.id));

    const fy = await tx.fiscalYear.findFirst({ where: { companyId, label: String(ejercicio) } });
    if (fy) {
      await tx.fiscalYear.update({
        where: { id: fy.id },
        data: { estado: 'OPEN', closingDate: null, legalizationDeadline: null, accountsDepositDeadline: null, asientosBloqueados: false },
      });
      await tx.legalBook.deleteMany({ where: { fiscalYearId: fy.id, status: 'PENDING', filePath: '' } });
    }
    return { anulados };
  }, OPCIONES_TX);
}
