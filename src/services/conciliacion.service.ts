import { AsientoCandidato, MovimientoBanco, SugerenciaConciliacion } from '../domain/conciliacion.model';
import { AsientoSimple, obtenerAsientosEjercicio } from './contabilidadDatos.service';

interface MovimientoCaja {
  asientoId: string;
  fecha: string;
  importe: number; // debe - haber sobre 57x (positivo = entrada de efectivo)
  concepto: string;
}

/** Extrae los movimientos de tesoreria (lineas 57x) de los asientos. */
export function extraerMovimientosCaja(asientos: AsientoSimple[]): MovimientoCaja[] {
  const out: MovimientoCaja[] = [];
  for (const a of asientos) {
    const delta = a.lineas
      .filter((l) => l.subcuenta.startsWith('57'))
      .reduce((acc, l) => acc + (l.debe - l.haber), 0);
    if (delta !== 0) {
      out.push({ asientoId: String(a.idasiento ?? a.numero), fecha: a.fecha, importe: Math.round(delta * 100) / 100, concepto: a.concepto });
    }
  }
  return out;
}

function diasEntre(a: string, b: string): number {
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  if (Number.isNaN(da) || Number.isNaN(db)) return 9999;
  return Math.abs(Math.round((da - db) / 86400000));
}

function similitudTexto(a: string, b: string): number {
  const tok = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter((t) => t.length > 2));
  const sa = tok(a);
  const sb = tok(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let comunes = 0;
  for (const t of sa) if (sb.has(t)) comunes++;
  return comunes / Math.max(sa.size, sb.size);
}

/** Puntua la coincidencia entre un movimiento bancario y uno de caja (0..1). */
export function puntuar(mov: MovimientoBanco, caja: MovimientoCaja): number {
  // importe (50%): coincidencia exacta o dentro de tolerancia de 1 euro
  const difImporte = Math.abs(Math.abs(mov.importe) - Math.abs(caja.importe));
  const scoreImporte = difImporte < 0.01 ? 1 : difImporte <= 1 ? 0.6 : 0;

  // fecha (30%): mismo dia = 1, decae hasta 0 a los 10 dias
  const dias = diasEntre(mov.fecha, caja.fecha);
  const scoreFecha = dias === 0 ? 1 : Math.max(0, 1 - dias / 10);

  // texto (20%): solapamiento de tokens del concepto
  const scoreTexto = similitudTexto(mov.concepto, caja.concepto);

  return Math.round((scoreImporte * 0.5 + scoreFecha * 0.3 + scoreTexto * 0.2) * 100) / 100;
}

/** Genera sugerencias de conciliacion (top 3 candidatos por movimiento). */
export function proponer(movimientos: MovimientoBanco[], caja: MovimientoCaja[]): SugerenciaConciliacion[] {
  return movimientos.map((mov) => {
    const candidatos: AsientoCandidato[] = caja
      .map((c) => ({ asientoId: c.asientoId, fecha: c.fecha, importe: c.importe, concepto: c.concepto, score: puntuar(mov, c) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    return { movimientoBanco: mov, asientosCandidatos: candidatos };
  });
}

/**
 * Propone conciliaciones entre movimientos bancarios externos y los movimientos
 * de tesoreria de los asientos del ejercicio.
 * TODO: confirmar conciliacion (enlazar MovimientoBanco con asiento/partida y
 * marcar punteada=true en FacturaScripts).
 */
export async function proponerConciliaciones(
  companyId: string,
  ejercicio: number,
  movimientosBanco: MovimientoBanco[],
): Promise<SugerenciaConciliacion[]> {
  const asientos = await obtenerAsientosEjercicio(companyId, ejercicio);
  const caja = extraerMovimientosCaja(asientos);
  return proponer(movimientosBanco, caja);
}
