/**
 * Cartera pendiente de cobro y pago a 31-12-2026: cada partida va a la
 * subcuenta de su cliente o proveedor y la suma de las partidas de cada
 * subcuenta tiene que dar su saldo en la apertura.
 *
 * Si no cuadra, o una subcuenta de cliente o proveedor tiene saldo y ninguna
 * partida, se crea una partida «Saldo sin detalle a 31-12-2026» por la
 * diferencia, para poder cobrar o pagar contra ella, y queda como «Faltan
 * datos» hasta que llegue el detalle (decision D3 del usuario).
 *
 * Funciones puras.
 */
import { aCentimos } from '../../utils/money';
import { esSubcuentaDeTercero } from '../terceros/numeracion';
import type { PartidaLeida } from './extractores';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export const DOCUMENTO_SIN_DETALLE = 'Saldo sin detalle a 31-12-2026';

export type TipoPartida = 'COBRO' | 'PAGO';

/** Partida ya resuelta a su subcuenta. */
export interface PartidaResuelta {
  tipo: TipoPartida;
  subcuenta: string;
  nombre: string;
  documento: string;
  fecha?: string;
  vencimiento?: string;
  importeOriginal?: number;
  /** A 31-12; negativo = anticipo o abono pendiente de aplicar. */
  pendiente: number;
  moneda: string;
  sinDetalle: boolean;
  fila?: number;
}

export interface CuadreSubcuenta {
  subcuenta: string;
  tipo: TipoPartida;
  /** Saldo en la apertura en positivo para lo que se cobra (43) o se paga (40/41). */
  saldoApertura: number;
  sumaPartidas: number;
  diferencia: number;
  partidas: number;
}

export interface ResultadoCartera {
  partidas: PartidaResuelta[];
  cuadre: CuadreSubcuenta[];
  /** Partidas «Saldo sin detalle» que se crean por las diferencias. */
  sinDetalle: PartidaResuelta[];
  /** Partidas cuyo cliente o proveedor no se encuentra. */
  sinTercero: Array<{ fila: number; documento: string; nombre?: string; nif?: string; subcuenta?: string }>;
  /** Mismo documento repetido en la misma subcuenta: se suman. */
  repetidas: number;
}

export const tipoDeSubcuenta = (subcuenta: string): TipoPartida | null => (subcuenta.startsWith('43') ? 'COBRO' : /^4[01]/.test(subcuenta) ? 'PAGO' : null);

/**
 * Resuelve cada partida a su subcuenta (con `resolver`, que mira el NIF o el
 * nombre cuando la fila no trae la subcuenta) y cuadra contra los saldos de la
 * apertura (deudor positivo).
 */
export function cuadrarCartera(
  leidas: PartidaLeida[],
  saldosApertura: Map<string, number>,
  resolver: (p: PartidaLeida) => string | null,
  nombres: Map<string, string> = new Map(),
): ResultadoCartera {
  const sinTercero: ResultadoCartera['sinTercero'] = [];
  const porClave = new Map<string, PartidaResuelta>();
  let repetidas = 0;
  for (const p of leidas) {
    const subcuenta = p.subcuenta && tipoDeSubcuenta(p.subcuenta) ? p.subcuenta : resolver(p);
    const tipo = subcuenta ? tipoDeSubcuenta(subcuenta) : null;
    if (!subcuenta || !tipo) {
      sinTercero.push({ fila: p.fila, documento: p.documento, ...(p.nombre ? { nombre: p.nombre } : {}), ...(p.nif ? { nif: p.nif } : {}), ...(p.subcuenta ? { subcuenta: p.subcuenta } : {}) });
      continue;
    }
    const clave = `${tipo}|${subcuenta}|${p.documento}`;
    const previa = porClave.get(clave);
    if (previa) {
      repetidas++;
      previa.pendiente = round2(previa.pendiente + p.pendiente);
      continue;
    }
    porClave.set(clave, {
      tipo,
      subcuenta,
      nombre: p.nombre || nombres.get(subcuenta) || '',
      documento: p.documento,
      ...(p.fecha ? { fecha: p.fecha } : {}),
      ...(p.vencimiento ? { vencimiento: p.vencimiento } : {}),
      ...(p.importeOriginal !== undefined ? { importeOriginal: p.importeOriginal } : {}),
      pendiente: p.pendiente,
      moneda: p.moneda,
      sinDetalle: false,
      fila: p.fila,
    });
  }
  const partidas = [...porClave.values()];

  // Cuadre por subcuenta: las que tienen partidas y las de terceros con saldo.
  const subcuentas = new Set<string>([...partidas.map((p) => p.subcuenta)]);
  for (const [c, s] of saldosApertura) if (aCentimos(s) !== 0 && esSubcuentaDeTercero(c)) subcuentas.add(c);
  const cuadre: CuadreSubcuenta[] = [];
  const sinDetalle: PartidaResuelta[] = [];
  for (const subcuenta of [...subcuentas].sort()) {
    const tipo = tipoDeSubcuenta(subcuenta)!;
    const saldo = saldosApertura.get(subcuenta) ?? 0;
    const saldoApertura = round2(tipo === 'COBRO' ? saldo : -saldo);
    const deLaSubcuenta = partidas.filter((p) => p.subcuenta === subcuenta);
    const sumaPartidas = round2(deLaSubcuenta.reduce((s, p) => s + p.pendiente, 0));
    const diferencia = round2(saldoApertura - sumaPartidas);
    cuadre.push({ subcuenta, tipo, saldoApertura, sumaPartidas, diferencia, partidas: deLaSubcuenta.length });
    if (aCentimos(diferencia) !== 0) {
      sinDetalle.push({ tipo, subcuenta, nombre: nombres.get(subcuenta) ?? deLaSubcuenta[0]?.nombre ?? '', documento: DOCUMENTO_SIN_DETALLE, pendiente: diferencia, moneda: 'EUR', sinDetalle: true });
    }
  }
  return { partidas, cuadre, sinDetalle, sinTercero, repetidas };
}
