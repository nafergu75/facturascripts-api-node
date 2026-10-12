/**
 * Libro diario de 2026 como historico de solo lectura (A2): asientos del año
 * con su origen historico, asientos que no cuadran y comparacion con el sumas
 * y saldos de la gestoria al mismo corte, subcuenta a subcuenta.
 *
 * Funciones puras.
 */
import { aCentimos } from '../../utils/money';
import { agruparAsientos, type ApunteLeido, type AsientoAgrupado, type CuentaSaldo } from '../puestaEnMarcha/lectorContable';
import type { TipoSumasSaldos } from './saldos';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Origen con el que se graba cada asiento del historico. */
export type OrigenHistorico = 'HISTORICO' | 'HISTORICO_APERTURA' | 'HISTORICO_REGULARIZACION' | 'HISTORICO_CIERRE';

export const ORIGENES_HISTORICO: readonly OrigenHistorico[] = ['HISTORICO', 'HISTORICO_APERTURA', 'HISTORICO_REGULARIZACION', 'HISTORICO_CIERRE'];

export function origenHistorico(a: Pick<AsientoAgrupado, 'especial'>): OrigenHistorico {
  return a.especial ? (`HISTORICO_${a.especial}` as OrigenHistorico) : 'HISTORICO';
}

export interface DiferenciaSubcuenta {
  codigo: string;
  diario: number;
  sumasSaldos: number;
  diferencia: number;
}

export interface AnalisisDiario {
  ejercicio: number;
  asientos: AsientoAgrupado[];
  agrupacion: 'asiento' | 'fecha' | 'mes';
  resumen: { asientos: number; apuntes: number; debe: number; haber: number; desde: string; hasta: string };
  especiales: { apertura: number; regularizacion: number; cierre: number };
  /** Apuntes de otros años, que no se importan. */
  deOtrosAnios: number;
  descuadrados: Array<{ clave: string; fecha: string; debe: number; haber: number; diferencia: number }>;
  /** Lineas de los grupos 8 y 9: se guardan tal cual, sin crear sus cuentas. */
  lineasGrupos89: number;
  /** null si no hay sumas y saldos con que comparar. */
  comparacion: { cuadra: boolean; diferencias: DiferenciaSubcuenta[] } | null;
  /** El diario acaba antes de la fecha de corte del sumas y saldos. */
  acabaAntesDelCorte: boolean;
}

/**
 * Agrupa el diario del ejercicio y lo compara con el sumas y saldos. Para
 * comparar se quita el asiento de cierre (el sumas y saldos viene sin el) y,
 * si el sumas y saldos esta sin regularizar, tambien la regularizacion.
 */
export function analizarDiario(
  apuntes: ApunteLeido[],
  ejercicio: number,
  sumasSaldos: { cuentas: CuentaSaldo[]; tipo: TipoSumasSaldos; fechaCorte: string | null } | null,
): AnalisisDiario {
  const delAnio = apuntes.filter((a) => a.fecha.startsWith(`${ejercicio}-`));
  const { asientos, agrupacion } = agruparAsientos(delAnio, 'auto');
  const descuadrados = asientos.filter((a) => !a.cuadra).map((a) => ({ clave: a.clave, fecha: a.fecha, debe: a.debe, haber: a.haber, diferencia: round2(a.debe - a.haber) }));
  const especiales = {
    apertura: asientos.filter((a) => a.especial === 'APERTURA').length,
    regularizacion: asientos.filter((a) => a.especial === 'REGULARIZACION').length,
    cierre: asientos.filter((a) => a.especial === 'CIERRE').length,
  };
  const lineasGrupos89 = delAnio.filter((a) => /^[89]/.test(a.cuenta)).length;

  let comparacion: AnalisisDiario['comparacion'] = null;
  let acabaAntesDelCorte = false;
  const hasta = asientos.reduce((m, a) => (a.fecha > m ? a.fecha : m), '');
  if (sumasSaldos && sumasSaldos.tipo !== 'CON_CIERRE') {
    const corte = sumasSaldos.fechaCorte ?? `${ejercicio}-12-31`;
    acabaAntesDelCorte = !!hasta && hasta < corte && corte.startsWith(`${ejercicio}-`) && corte.slice(0, 7) > hasta.slice(0, 7);
    const saldos = new Map<string, number>();
    for (const a of asientos) {
      if (a.fecha > corte || a.especial === 'CIERRE') continue;
      if (a.especial === 'REGULARIZACION' && sumasSaldos.tipo === 'SIN_REGULARIZAR') continue;
      for (const l of a.lineas) {
        if (/^[89]/.test(l.cuenta)) continue;
        saldos.set(l.cuenta, round2((saldos.get(l.cuenta) ?? 0) + l.debe - l.haber));
      }
    }
    const deSys = new Map(sumasSaldos.cuentas.map((c) => [c.codigo, c.saldo]));
    const diferencias: DiferenciaSubcuenta[] = [];
    for (const codigo of new Set([...saldos.keys(), ...deSys.keys()])) {
      if (/^[89]/.test(codigo)) continue;
      const d = saldos.get(codigo) ?? 0;
      const s = deSys.get(codigo) ?? 0;
      if (aCentimos(d) !== aCentimos(s)) diferencias.push({ codigo, diario: d, sumasSaldos: s, diferencia: round2(d - s) });
    }
    diferencias.sort((a, b) => a.codigo.localeCompare(b.codigo));
    comparacion = { cuadra: diferencias.length === 0, diferencias };
  }

  return {
    ejercicio,
    asientos,
    agrupacion,
    resumen: {
      asientos: asientos.length,
      apuntes: delAnio.length,
      debe: round2(asientos.reduce((s, a) => s + a.debe, 0)),
      haber: round2(asientos.reduce((s, a) => s + a.haber, 0)),
      desde: asientos[0]?.fecha ?? '',
      hasta,
    },
    especiales,
    deOtrosAnios: apuntes.length - delAnio.length,
    descuadrados,
    lineasGrupos89,
    comparacion,
    acabaAntesDelCorte,
  };
}

/**
 * Saldos a 31-12 sacados del diario cuando no hay sumas y saldos: sin la
 * regularizacion ni el cierre (los grupos 6 y 7 van a la 129 en la apertura).
 */
export function saldosDesdeDiario(asientos: AsientoAgrupado[]): CuentaSaldo[] {
  const saldos = new Map<string, { nombre: string; saldo: number }>();
  for (const a of asientos) {
    if (a.especial === 'REGULARIZACION' || a.especial === 'CIERRE') continue;
    for (const l of a.lineas) {
      if (/^[89]/.test(l.cuenta)) continue;
      const s = saldos.get(l.cuenta) ?? { nombre: l.nombre, saldo: 0 };
      s.saldo = round2(s.saldo + l.debe - l.haber);
      if (!s.nombre && l.nombre) s.nombre = l.nombre;
      saldos.set(l.cuenta, s);
    }
  }
  return [...saldos.entries()].map(([codigo, s]) => ({ codigo, nombre: s.nombre, saldo: s.saldo })).sort((a, b) => a.codigo.localeCompare(b.codigo));
}
