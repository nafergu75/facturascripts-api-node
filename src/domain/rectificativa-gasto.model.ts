/**
 * Abonos y facturas rectificativas de proveedor: reglas puras (sin BD) que
 * comparten el alta, el lector, los modelos y la pantalla.
 *
 * Una rectificativa de gasto es una ExpenseInvoice con `esRectificativa` y los
 * importes de la rectificacion con su signo (en negativo si baja, en positivo
 * si sube), tambien en las de sustitucion. Enlaza con la factura o facturas que
 * rectifica, o con un periodo en los rappels (art. 15.4 RD 1619/2012).
 */
import { aCentimos } from '../utils/money';
import { fechaContableGasto } from './factura-gasto.model';

export const CAUSAS_RECTIFICACION = ['DEVOLUCION', 'DESCUENTO', 'RAPPEL', 'PRONTO_PAGO', 'ANULACION_PRECIO', 'ERROR_IVA', 'ERROR_DERECHO'] as const;
export type Causa = (typeof CAUSAS_RECTIFICACION)[number];
export const esCausa = (v: unknown): v is Causa => typeof v === 'string' && (CAUSAS_RECTIFICACION as readonly string[]).includes(v);

export const TIPOS_RECTIFICATIVA = ['I', 'S'] as const;
export type TipoRectificativa = (typeof TIPOS_RECTIFICATIVA)[number];

export const CAUSA_INFO: Record<
  Causa,
  {
    /** Texto para la pantalla. */
    texto: string;
    articulo: string;
    /** Modifica la base (art. 80 LIVA o error de derecho): todas salvo ERROR_IVA. */
    modificaBase: boolean;
    /** Cuenta que se propone si la linea original es del subgrupo 60. */
    cuentaCompra: '606' | '608' | '609' | null;
    /** Admite un periodo en vez de facturas (descuentos por volumen). */
    admitePeriodo: boolean;
    /** Solo puede bajar el total (un descuento o una devolucion resta). */
    soloBaja: boolean;
  }
> = {
  DEVOLUCION: { texto: 'Devolución de mercancías o envases', articulo: 'art. 80.Dos LIVA', modificaBase: true, cuentaCompra: '608', admitePeriodo: false, soloBaja: true },
  DESCUENTO: { texto: 'Descuento o bonificación después de la factura', articulo: 'art. 80.Uno.2.º LIVA', modificaBase: true, cuentaCompra: '608', admitePeriodo: true, soloBaja: true },
  RAPPEL: { texto: 'Rappel por volumen de compras', articulo: 'art. 80.Uno.2.º LIVA', modificaBase: true, cuentaCompra: '609', admitePeriodo: true, soloBaja: true },
  PRONTO_PAGO: { texto: 'Descuento por pronto pago', articulo: 'art. 80.Uno.2.º LIVA', modificaBase: true, cuentaCompra: '606', admitePeriodo: false, soloBaja: true },
  ANULACION_PRECIO: { texto: 'Operación anulada en todo o en parte, o precio rebajado', articulo: 'art. 80.Dos LIVA', modificaBase: true, cuentaCompra: '608', admitePeriodo: false, soloBaja: true },
  ERROR_IVA: { texto: 'El proveedor se equivocó en el IVA (tipo o cuota)', articulo: 'arts. 89 y 114 LIVA', modificaBase: false, cuentaCompra: null, admitePeriodo: false, soloBaja: false },
  ERROR_DERECHO: { texto: 'Error fundado de derecho', articulo: 'arts. 89 y 114 LIVA', modificaBase: true, cuentaCompra: null, admitePeriodo: false, soloBaja: false },
};

/** Causas que llegan y no se admiten como abono (art. 80.Tres y Cuatro LIVA). */
export const CAUSAS_NO_ADMITIDAS = ['IMPAGO', 'CONCURSO'] as const;
export const TEXTO_IMPAGO_CONCURSO =
  'Las rectificativas por impago o concurso no se registran como un abono: la deuda con el proveedor sigue y solo cambia el IVA. Consúltalo con tu asesor y regístralo con un asiento manual.';

/**
 * Cuenta que se propone para una linea del abono. 606, 608 y 609 solo corrigen
 * compras del subgrupo 60: en una linea de inmovilizado (2xx) o de servicios
 * (62x) se propone la cuenta de la original, porque la devolucion de un bien de
 * inversion abona la cuenta del activo. Un DESCUENTO con periodo (por volumen)
 * va a la 609, como un rappel. Sin propuesta para la causa: la de la original.
 */
export function cuentaPropuesta(causa: Causa, cuentaOriginal: string | null, conPeriodo: boolean): string | null {
  if (!cuentaOriginal || !cuentaOriginal.startsWith('60')) return cuentaOriginal;
  if (causa === 'DESCUENTO' && conPeriodo) return '609';
  return CAUSA_INFO[causa].cuentaCompra ?? cuentaOriginal;
}

/** 'ABONO' si el total con IVA baja, 'CARGO' si sube, 'MIXTA' si base y cuota van en sentidos distintos. */
export function sentido(base: number, cuota: number): 'ABONO' | 'CARGO' | 'MIXTA' {
  const b = Math.sign(aCentimos(base));
  const c = Math.sign(aCentimos(cuota));
  if (b !== 0 && c !== 0 && b !== c) return 'MIXTA';
  return b + c < 0 ? 'ABONO' : 'CARGO';
}

/**
 * Donde cuenta el IVA de una rectificativa en el 303 y el 390 (seccion 10.1):
 *  - Por art. 80 o error de derecho, y cualquier aumento: en el periodo de la
 *    fecha contable (recepcion), en [40]/[41] con su signo.
 *  - ERROR_IVA que reduce la deduccion: en el periodo de la original (su fecha
 *    contable, o la de expedicion si es de fuera), neteando en [28]/[29]; si
 *    ese 303 esta presentado, hay que rectificarlo.
 * La cuota manda: una mixta que baja la cuota se trata como una que reduce.
 * `requiereRectificar303`: reduce lo deducido, asi que, si el 303 de su
 * periodo ya esta presentado, hay que presentar una autoliquidacion
 * rectificativa (no basta con cambiar la fecha).
 */
export function imputacionIva(r: { causa: Causa; cuota: number; fechaContable: string; fechaOriginalContable: string | null }): {
  fecha: string;
  casillasRectificacion: boolean;
  requiereRectificar303: boolean;
} {
  const reduce = aCentimos(r.cuota) < 0;
  if (r.causa === 'ERROR_IVA' && reduce) {
    return { fecha: r.fechaOriginalContable ?? r.fechaContable, casillasRectificacion: false, requiereRectificar303: true };
  }
  return { fecha: r.fechaContable, casillasRectificacion: true, requiereRectificar303: reduce };
}

const masAnios = (fecha: string, anios: number): string => {
  const [a, m, d] = fecha.split('-').map(Number);
  // 29-02 + 1 año: el 28-02 (no el 1-03).
  const ultimo = new Date(Date.UTC(a + anios, m, 0)).getUTCDate();
  return `${a + anios}-${String(m).padStart(2, '0')}-${String(Math.min(d, ultimo)).padStart(2, '0')}`;
};

/**
 * Ultimo dia para deducir un incremento de IVA (art. 114.Dos.1.º LIVA):
 *  - causa del art. 80 (modificaBase): cuatro años desde la circunstancia que
 *    modifica la base (por defecto, la fecha de la rectificativa);
 *  - resto (ERROR_IVA): el menor entre cuatro años desde el devengo de la
 *    original y un año desde la expedicion de la rectificativa.
 */
export function limiteIncremento(r: { causa: Causa; fechaDevengoOriginal: string | null; fechaEmision: string; fechaCircunstancia?: string | null }): string | null {
  if (CAUSA_INFO[r.causa].modificaBase) return masAnios(r.fechaCircunstancia || r.fechaEmision, 4);
  const unAnio = masAnios(r.fechaEmision, 1);
  if (!r.fechaDevengoOriginal) return unAnio;
  const cuatro = masAnios(r.fechaDevengoOriginal, 4);
  return cuatro < unAnio ? cuatro : unAnio;
}

/**
 * Redondeo de las facturas de gasto: el de siempre del alta (Math.round(v * 100) / 100),
 * no redondear2 de utils/money. Con redondear2, 1 × 1,005 € daria 1,01 en el
 * abono y 1,00 en la original, y el abono espejo no la dejaria a cero.
 */
export const r2Gasto = (v: number): number => Math.round(v * 100) / 100;

const sinCeroNegativo = (n: number): number => (n === 0 ? 0 : n);

/** Signo × r2Gasto(|x|): el espejo exacto de la original. */
export const conSigno = (signo: 1 | -1, euros: number): number => sinCeroNegativo(signo * r2Gasto(Math.abs(euros)));

/**
 * Redondeo de las facturas de gasto con signo: sobre el valor absoluto y con
 * el signo despues (-10,125 da -10,13, como 10,125 da 10,13). En positivo es
 * exactamente r2Gasto: las facturas de siempre no cambian.
 */
export const r2GastoConSigno = (v: number): number => conSigno(v < 0 ? -1 : 1, v);

/** Fecha que cuenta para el 303 y el 390 (y para saber si su 303 esta presentado). */
export const fechaIvaGasto = (f: { fechaImputacionIva?: string | null; fechaEmision: string; fechaRegistro?: string | null }): string =>
  f.fechaImputacionIva || fechaContableGasto(f);

/**
 * Reparte una rectificacion entre varias originales en proporcion a `pesos`
 * (lo pendiente de cada una o, si no queda nada, su base). Por importe: las
 * filas suman exactamente el total en centimos (resto mayor). Sin pesos
 * utiles (todos cero), a partes iguales.
 */
export function repartir(total: number, pesos: number[]): number[] {
  if (!pesos.length) return [];
  const t = aCentimos(total);
  const ps = pesos.map((p) => Math.abs(aCentimos(p)));
  const suma = ps.reduce((a, p) => a + p, 0);
  const w = suma > 0 ? ps : ps.map(() => 1);
  const sw = suma > 0 ? suma : ps.length;
  const exactos = w.map((p) => (Math.abs(t) * p) / sw);
  const base = exactos.map(Math.floor);
  let resto = Math.abs(t) - base.reduce((a, b) => a + b, 0);
  const orden = exactos.map((e, i) => ({ i, f: e - Math.floor(e) })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (const { i } of orden) {
    if (resto <= 0) break;
    base[i] += 1;
    resto -= 1;
  }
  const signo = t < 0 ? -1 : 1;
  return base.map((c) => sinCeroNegativo((signo * c) / 100));
}

/** Texto de la rectificativa para el libro de IVA y la ficha: «Rectificativa (por diferencias) de F-118 de 30/11/2026. Causa: devolución.» */
export function textoRectifica(r: {
  tipo: TipoRectificativa;
  causa: Causa;
  originales: Array<{ numero: string | null; fecha: string | null }>;
  periodo?: { desde: string; hasta: string } | null;
}): string {
  const ddmm = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}`;
  const que = r.periodo
    ? `las compras del ${ddmm(r.periodo.desde)} al ${ddmm(r.periodo.hasta)}`
    : r.originales.map((o) => `${o.numero ?? 'sin número'}${o.fecha ? ` de ${ddmm(o.fecha)}` : ''}`).join(', ');
  const tipo = r.tipo === 'S' ? 'por sustitución' : 'por diferencias';
  const causa = CAUSA_INFO[r.causa].texto;
  return `Rectificativa (${tipo}) de ${que}. Causa: ${causa.charAt(0).toLowerCase()}${causa.slice(1)}.`;
}
