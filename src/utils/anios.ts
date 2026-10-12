/**
 * Regla común de años (spec arranque-2027, apartado A).
 *
 *  - validarEjercicio: el ejercicio que llega en una petición, de 1990 al año
 *    actual (o al siguiente), siempre con la hora de España. Sustituye los
 *    rangos sueltos de cada controlador (unos aceptaban 20270, otros solo
 *    hasta 2100, otros cualquier número).
 *  - aniosEmpresa: los años de una empresa para los desplegables (GET /anios):
 *    el primero con datos, el actual, los años con datos y sus ejercicios.
 *  - aniosSeleccionables: la lista ya montada, de mayor a menor.
 *
 * `primero` es el menor entre el primer ejercicio, la primera factura emitida
 * o recibida, el primer asiento, el primer movimiento bancario y la primera
 * nómina. Sin nada, el año actual.
 */
import { prisma } from '../config/database';
import { badRequest } from './http-errors';
import { anioEspana, hoyEspana } from './fechas';
import { fiscalYearsService } from '../services/fiscalYears.service';
import { INICIO_LLEVANZA_APP, antesDelInicio, rangoPeriodo, regimenDe, regimenEn, type RegimenFiscal } from '../domain/calendarioFiscal';
import { ajustesFiscalesDeFila } from '../domain/ajustes.model';
import type { EstadoEfectivoEjercicio } from '../services/fiscalYears.service';

/** Primer año que se acepta en cualquier pantalla o petición. */
export const ANIO_MINIMO = 1990;

export type HastaEjercicio = 'actual' | 'actual+1';

export interface OpcionesEjercicio {
  /** Último año admitido: el actual o el siguiente (por defecto, el siguiente). */
  hasta?: HastaEjercicio;
  /** Nombre del campo para el 400 (details.campo). */
  campo?: string;
  /** Instante de referencia (tests con reloj falso). */
  ahora?: Date;
}

/**
 * Año de ejercicio válido (entero de 1990 al actual o al siguiente, hora de
 * España). 400 con un texto para la persona si falta o no vale.
 */
export function validarEjercicio(valor: unknown, opciones: OpcionesEjercicio = {}): number {
  const campo = opciones.campo ?? 'ejercicio';
  const actual = anioEspana(opciones.ahora);
  const maximo = opciones.hasta === 'actual' ? actual : actual + 1;
  const texto = valor === undefined || valor === null ? '' : String(valor).trim();
  const anio = Number(texto);
  if (!texto || !/^\d{4}$/.test(texto) || anio < ANIO_MINIMO || anio > maximo) {
    throw badRequest(`Indica el ejercicio con su año en cuatro cifras, entre ${ANIO_MINIMO} y ${maximo}.`, { campo });
  }
  return anio;
}

/** validarEjercicio para un valor opcional: sin valor, el año actual. */
export function ejercicioOActual(valor: unknown, opciones: OpcionesEjercicio = {}): number {
  if (valor === undefined || valor === null || String(valor).trim() === '') return anioEspana(opciones.ahora);
  return validarEjercicio(valor, opciones);
}

/** Lista de años de `desde` a `hasta` unida a `extra`, sin repetidos y de mayor a menor. */
export function rangoAnios(desde: number, hasta: number, extra: number[] = []): number[] {
  const set = new Set<number>(extra);
  for (let a = Math.min(desde, hasta); a <= hasta; a++) set.add(a);
  return [...set].sort((a, b) => b - a);
}

export interface EjercicioDeLaLista {
  anio: number;
  estado: EstadoEfectivoEjercicio;
}

export interface AniosEmpresa {
  /** Primer año con algo en la app (ejercicio, factura, asiento, banco o nómina); sin nada, el actual. */
  primero: number;
  /** Año en curso en España. */
  actual: number;
  /** Años con algún dato, de mayor a menor. */
  conDatos: number[];
  /** Ejercicios dados de alta, de mayor a menor, con su estado. */
  ejercicios: EjercicioDeLaLista[];
}

type FilaAnio = { anio: number | bigint | string | null };

const ANIO_RAZONABLE = (a: number) => Number.isInteger(a) && a >= ANIO_MINIMO && a <= 2999;

async function aniosDe(consulta: Promise<FilaAnio[]>): Promise<number[]> {
  const filas = await consulta;
  return filas.map((f) => Number(f.anio)).filter(ANIO_RAZONABLE);
}

/**
 * Años con datos de la empresa: facturas emitidas (fecha de emisión), facturas
 * recibidas (emisión y registro), asientos, movimientos bancarios y nóminas.
 * Solo lee años, nunca importes.
 */
async function aniosConDatos(companyId: string): Promise<number[]> {
  const listas = await Promise.all([
    aniosDe(prisma.$queryRaw<FilaAnio[]>`SELECT DISTINCT LEFT(fechaEmision, 4) AS anio FROM IncomeInvoice WHERE companyId = ${companyId}`),
    aniosDe(prisma.$queryRaw<FilaAnio[]>`SELECT DISTINCT LEFT(fechaEmision, 4) AS anio FROM ExpenseInvoice WHERE companyId = ${companyId}`),
    aniosDe(
      prisma.$queryRaw<FilaAnio[]>`SELECT DISTINCT LEFT(fechaRegistro, 4) AS anio FROM ExpenseInvoice WHERE companyId = ${companyId} AND fechaRegistro IS NOT NULL`,
    ),
    aniosDe(prisma.$queryRaw<FilaAnio[]>`SELECT DISTINCT YEAR(fecha) AS anio FROM JournalEntry WHERE companyId = ${companyId}`),
    aniosDe(prisma.$queryRaw<FilaAnio[]>`SELECT DISTINCT LEFT(fecha, 4) AS anio FROM BankMovement WHERE companyId = ${companyId}`),
    aniosDe(prisma.$queryRaw<FilaAnio[]>`SELECT DISTINCT ejercicio AS anio FROM Nomina WHERE companyId = ${companyId}`),
  ]);
  return [...new Set(listas.flat())];
}

const FECHA_RAZONABLE = (f: string | null | undefined): f is string =>
  !!f && /^\d{4}-\d{2}-\d{2}/.test(f) && ANIO_RAZONABLE(Number(f.slice(0, 4)));

/**
 * Primer día con algo de la empresa en la app (AAAA-MM-DD): el inicio del
 * primer ejercicio, la primera factura emitida o recibida (emisión o
 * registro), el primer asiento, el primer movimiento bancario o el primer mes
 * con nóminas. Las mismas fuentes que `primero` de aniosEmpresa, con el día.
 * null si la empresa no tiene nada.
 */
export async function primerDiaConDatos(companyId: string): Promise<string | null> {
  const where = { companyId };
  const [fy, emitida, recibida, asiento, banco, nomina] = await Promise.all([
    prisma.fiscalYear.aggregate({ where, _min: { fechaInicio: true } }),
    prisma.incomeInvoice.aggregate({ where, _min: { fechaEmision: true } }),
    prisma.expenseInvoice.aggregate({ where, _min: { fechaEmision: true, fechaRegistro: true } }),
    prisma.journalEntry.aggregate({ where, _min: { fecha: true } }),
    prisma.bankMovement.aggregate({ where, _min: { fecha: true } }),
    prisma.nomina.findFirst({ where, orderBy: [{ ejercicio: 'asc' }, { mes: 'asc' }], select: { ejercicio: true, mes: true } }),
  ]);
  const fechas = [
    fy._min.fechaInicio,
    emitida._min.fechaEmision,
    recibida._min.fechaEmision,
    recibida._min.fechaRegistro,
    asiento._min.fecha ? hoyEspana(asiento._min.fecha) : null,
    banco._min.fecha,
    nomina ? `${nomina.ejercicio}-${String(nomina.mes).padStart(2, '0')}-01` : null,
  ]
    .filter(FECHA_RAZONABLE)
    .map((f) => f.slice(0, 10));
  return fechas.length ? fechas.reduce((a, b) => (b < a ? b : a)) : null;
}

/**
 * Inicio en la app cuando la empresa no lo ha indicado: el primer dia con
 * algo suyo en la app (ejercicio, factura, asiento, banco o nomina) y, si no
 * tiene nada, el dia en que se dio de alta (hora de España). Si la empresa
 * tiene años llevados por la gestoria (llevanza EXTERNA), nunca antes del dia
 * siguiente al ultimo de ellos: asi la llevanza y el inicio dicen lo mismo.
 * null si la empresa no existe.
 */
export async function inicioDeducido(companyId: string): Promise<string | null> {
  const [primero, trasExterna] = await Promise.all([primerDiaConDatos(companyId), diaTrasLlevanzaExterna(companyId)]);
  let base = primero;
  if (!base) {
    const empresa = await prisma.company.findUnique({ where: { id: companyId }, select: { createdAt: true } });
    base = empresa ? hoyEspana(empresa.createdAt) : null;
  }
  // Un año que llevó la gestoría (llevanza EXTERNA) nunca cuenta como llevado
  // en la app, aunque su diario esté aquí como histórico: el inicio es, como
  // pronto, el día siguiente a su cierre.
  if (trasExterna && (!base || base < trasExterna)) return trasExterna;
  return base;
}

/**
 * Día siguiente al fin del último ejercicio que llevó la gestoría
 * (FiscalYear.llevanza = EXTERNA), o null si no hay ninguno.
 */
async function diaTrasLlevanzaExterna(companyId: string): Promise<string | null> {
  const ultimo = await prisma.fiscalYear.findFirst({
    where: { companyId, llevanza: 'EXTERNA' },
    orderBy: { fechaFin: 'desc' },
    select: { fechaFin: true },
  });
  if (!ultimo || !FECHA_RAZONABLE(ultimo.fechaFin)) return null;
  const d = new Date(`${ultimo.fechaFin.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Desde cuando lleva la empresa su contabilidad en la app: lo de antes se
 * llevaba fuera y sus 303 se presentaron fuera (un abono que reduce su IVA
 * obliga a rectificarlos). Es la fecha que indico en Configuracion > Impuestos
 * (AjustesFiscales.inicioEnApp) o, si no la indico, la que se deduce de sus
 * datos (inicioDeducido): la misma que usa el calendario de impuestos, para
 * que la pantalla del 303 y el aviso de un abono digan lo mismo de un periodo.
 * Una empresa que llevo 2026 fuera y tiene datos de ese año en la app lo
 * indica con su fecha de inicio (o marca esos 303 como presentados fuera de
 * la app). Sin la empresa o sin BD, el 1-1-2027 (INICIO_LLEVANZA_APP).
 */
export async function inicioLlevanzaApp(companyId: string): Promise<string> {
  try {
    const ajustes = await prisma.ajustesFiscales.findUnique({ where: { companyId }, select: { inicioEnApp: true } });
    if (ajustes?.inicioEnApp) return ajustes.inicioEnApp;
    return (await inicioDeducido(companyId)) ?? INICIO_LLEVANZA_APP;
  } catch {
    // Sin BD (tests en memoria): la fecha de siempre.
    return INICIO_LLEVANZA_APP;
  }
}

/**
 * Regimen fiscal de la empresa un dia (mensual o trimestral en el IVA...),
 * como el calendario: por fecha de efecto (AjustesFiscalesVigencia) o, si la
 * empresa guardo sus ajustes antes de existir esa tabla, los guardados desde el
 * 1 de enero del año en que los guardo. Sin nada, el de por defecto.
 */
export async function regimenFiscalEn(companyId: string, fecha: string): Promise<RegimenFiscal> {
  try {
    const vigencias = await prisma.ajustesFiscalesVigencia.findMany({ where: { companyId }, orderBy: { desde: 'asc' } });
    if (vigencias.length) return regimenEn(vigencias.map((v) => ({ desde: v.desde, ...regimenDe(v as unknown as RegimenFiscal) })), fecha);
    const fila = await prisma.ajustesFiscales.findUnique({ where: { companyId } });
    if (!fila) return regimenEn([], fecha);
    return regimenEn([{ desde: `${anioEspana(fila.updatedAt)}-01-01`, ...regimenDe(ajustesFiscalesDeFila(fila)) }], fecha);
  } catch {
    return regimenEn([], fecha);
  }
}

/**
 * Periodo del 303 de una fecha si la app no lo lleva: acaba antes del inicio
 * en la app (inicioLlevanzaApp), asi que su 303 se presento fuera. El mes si
 * en ese periodo la empresa declaraba cada mes; si no, el trimestre. null si
 * el periodo lo lleva la app (su 303 esta en el calendario).
 */
export async function periodo303FueraDeLaApp(companyId: string, fecha: string): Promise<{ ejercicio: number; periodo: string } | null> {
  const ejercicio = Number(fecha.slice(0, 4));
  const trimestre = `${Math.ceil(Number(fecha.slice(5, 7)) / 3)}T`;
  const inicioTrimestre = rangoPeriodo(ejercicio, trimestre)?.inicio ?? fecha;
  const mensual = (await regimenFiscalEn(companyId, inicioTrimestre)).periodicidadIva === 'MENSUAL';
  const periodo = mensual ? fecha.slice(5, 7) : trimestre;
  return antesDelInicio(ejercicio, periodo, await inicioLlevanzaApp(companyId)) ? { ejercicio, periodo } : null;
}

/** Años de la empresa para los desplegables (GET /companies/:companyId/anios). */
export async function aniosEmpresa(companyId: string, ahora: Date = new Date()): Promise<AniosEmpresa> {
  const actual = anioEspana(ahora);
  const [datos, fys] = await Promise.all([aniosConDatos(companyId), fiscalYearsService.estados(companyId)]);
  const ejercicios: EjercicioDeLaLista[] = fys
    .filter((fy) => /^\d{4}$/.test(fy.label))
    .map((fy) => ({ anio: Number(fy.label), estado: fy.estadoEfectivo }))
    .sort((a, b) => b.anio - a.anio);
  const conDatos = [...new Set([...datos, ...ejercicios.map((e) => e.anio)])].sort((a, b) => b - a);
  const primero = conDatos.length ? Math.min(...conDatos) : actual;
  return { primero, actual, conDatos, ejercicios };
}

/**
 * Años que se ofrecen en un desplegable: de `primero` al actual más `extra`
 * (1 en los filtros generales, 0 en los modelos de la AEAT), unidos a los años
 * con datos, de mayor a menor.
 */
export async function aniosSeleccionables(companyId: string, opciones: { extra?: number; ahora?: Date } = {}): Promise<number[]> {
  const a = await aniosEmpresa(companyId, opciones.ahora);
  return rangoAnios(Math.min(a.primero, a.actual), a.actual + (opciones.extra ?? 1), a.conDatos);
}
