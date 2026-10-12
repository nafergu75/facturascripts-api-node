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
import { anioEspana } from './fechas';
import { fiscalYearsService } from '../services/fiscalYears.service';
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
    throw badRequest(`Indica el ejercicio con su año en cuatro cifras, entre ${ANIO_MINIMO} y ${maximo}.`, { campo, minimo: ANIO_MINIMO, maximo });
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
