/**
 * Rectificativas y abonos de venta: reglas puras (sin BD) que comparten el
 * alta, el lector, el asiento, los modelos y la pantalla (GET
 * /income-invoices/rectificativas/opciones da esta misma tabla).
 *
 * Una rectificativa de venta es una IncomeInvoice con `esRectificativa`, en la
 * serie de rectificativas, con su motivo (`causaRectificacion`) y enlazada a lo
 * que rectifica (IncomeInvoiceRectificada): facturas de la app, facturas de
 * fuera (numero y fecha) o un periodo (rappel), art. 15.4 RD 1619/2012.
 *
 *  - Por diferencias (I): las lineas son la rectificacion, con signo.
 *  - Por sustitucion (S): las lineas son la factura corregida entera (lo que
 *    sale en el PDF); el asiento, el libro de expedidas y los modelos toman la
 *    diferencia con la original (diferenciaSustitucion).
 *
 * El tipo de VERI*FACTU sale del motivo (lista L2 de la Orden HAC/1177/2024):
 * R1 por el art. 80 Uno, Dos y Seis LIVA o por error fundado de derecho, R2
 * concurso, R3 credito incobrable, R4 el resto y R5 la de un ticket.
 */
import { aCentimos } from '../utils/money';

export const MOTIVOS_VENTA = ['DEVOLUCION', 'DESCUENTO', 'RAPPEL', 'CAMBIO_PRECIO', 'ERROR_DERECHO', 'ERROR', 'OTROS', 'CONCURSO', 'IMPAGO'] as const;
export type MotivoVenta = (typeof MOTIVOS_VENTA)[number];
export const esMotivoVenta = (v: unknown): v is MotivoVenta => typeof v === 'string' && (MOTIVOS_VENTA as readonly string[]).includes(v);

export type TipoRectificativaVenta = 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
export type FormaRectificacion = 'I' | 'S';

export interface InfoMotivoVenta {
  /** Texto para la pantalla y el PDF. */
  texto: string;
  /** Una linea de ayuda para elegirlo. */
  ayuda: string;
  tipoFactura: 'R1' | 'R2' | 'R3' | 'R4';
  articulo: string | null;
  /** Tiene que bajar la base y el total (una devolucion o un descuento restan). */
  soloResta: boolean;
  /** Admite un periodo en vez de facturas concretas (art. 15.4: descuentos por volumen). */
  admitePeriodo: boolean;
  /** Solo por diferencias. */
  soloDiferencias: boolean;
  /** Causa del art. 80 LIVA: su plazo cuenta desde la circunstancia, no desde el devengo. */
  art80: boolean;
  /** Aviso que no bloquea, para la pantalla. */
  aviso: string | null;
  /** false: todavia no se puede usar; sale desactivado con su aviso. */
  disponible: boolean;
}

const NO_DISPONIBLE_IMPAGO_CONCURSO =
  'Todavía no se puede hacer desde la app. En un impago o un concurso solo se rectifica el IVA, la deuda del cliente sigue y hay que comunicarlo a Hacienda con el modelo 952. Consúltalo con tu asesoría.';

export const MOTIVO_INFO: Record<MotivoVenta, InfoMotivoVenta> = {
  DEVOLUCION: {
    texto: 'Devolución de mercancías o envases',
    ayuda: 'El cliente te devuelve la mercancía o los envases.',
    tipoFactura: 'R1',
    articulo: 'art. 80.Dos LIVA',
    soloResta: true,
    admitePeriodo: false,
    soloDiferencias: false,
    art80: true,
    aviso: null,
    disponible: true,
  },
  DESCUENTO: {
    texto: 'Descuento o bonificación posterior',
    ayuda: 'Le haces un descuento o una bonificación después de facturar.',
    tipoFactura: 'R1',
    articulo: 'art. 80.Uno.2.º LIVA',
    soloResta: true,
    admitePeriodo: true,
    soloDiferencias: false,
    art80: true,
    aviso: null,
    disponible: true,
  },
  RAPPEL: {
    texto: 'Rappel por volumen',
    ayuda: 'Descuento por lo que te ha comprado en un periodo. Basta con indicar el periodo.',
    tipoFactura: 'R1',
    articulo: 'art. 80.Uno.2.º LIVA',
    soloResta: true,
    admitePeriodo: true,
    soloDiferencias: false,
    art80: true,
    aviso: null,
    disponible: true,
  },
  CAMBIO_PRECIO: {
    texto: 'La operación queda sin efecto o cambia el precio pactado',
    ayuda: 'La venta se anula del todo o en parte, o cambia el precio que acordasteis.',
    tipoFactura: 'R1',
    articulo: 'art. 80.Dos LIVA',
    soloResta: false,
    admitePeriodo: false,
    soloDiferencias: false,
    art80: true,
    aviso: null,
    disponible: true,
  },
  ERROR_DERECHO: {
    texto: 'Error al interpretar la norma (error fundado de derecho)',
    ayuda: 'Aplicaste mal la ley: por ejemplo, cobraste IVA a una operación que estaba exenta.',
    tipoFactura: 'R1',
    articulo: 'art. 89 LIVA',
    soloResta: false,
    admitePeriodo: false,
    soloDiferencias: false,
    art80: false,
    aviso: null,
    disponible: true,
  },
  ERROR: {
    texto: 'Error en datos o importes',
    ayuda: 'Algún dato o importe de la factura estaba mal: precio, cantidad, NIF, dirección...',
    tipoFactura: 'R4',
    articulo: 'art. 89 LIVA',
    soloResta: false,
    admitePeriodo: false,
    soloDiferencias: false,
    art80: false,
    aviso: null,
    disponible: true,
  },
  OTROS: {
    texto: 'Otra causa',
    ayuda: 'Cualquier otra causa. Explícala en la factura.',
    tipoFactura: 'R4',
    articulo: null,
    soloResta: false,
    admitePeriodo: false,
    soloDiferencias: false,
    art80: false,
    aviso: null,
    disponible: true,
  },
  CONCURSO: {
    texto: 'Concurso del cliente',
    ayuda: 'El cliente está en concurso de acreedores.',
    tipoFactura: 'R2',
    articulo: 'art. 80.Tres LIVA',
    soloResta: true,
    admitePeriodo: false,
    soloDiferencias: true,
    art80: true,
    aviso: NO_DISPONIBLE_IMPAGO_CONCURSO,
    disponible: false,
  },
  IMPAGO: {
    texto: 'Impago (crédito incobrable)',
    ayuda: 'El cliente no te paga y la deuda ya se puede dar por incobrable.',
    tipoFactura: 'R3',
    articulo: 'art. 80.Cuatro LIVA',
    soloResta: true,
    admitePeriodo: false,
    soloDiferencias: true,
    art80: true,
    aviso: NO_DISPONIBLE_IMPAGO_CONCURSO,
    disponible: false,
  },
};

/** Tipo de la rectificativa: el que sale del motivo o, si es la de un ticket, R5. */
export function tipoFacturaDe(motivo: MotivoVenta, ticket: boolean): TipoRectificativaVenta {
  return ticket ? 'R5' : MOTIVO_INFO[motivo].tipoFactura;
}

const sinTildes = (t: string) =>
  t
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** Motivo que se propone a partir del texto leido en la factura (lector). null: hay que elegirlo. */
export function motivoDeTexto(texto: string | null | undefined): MotivoVenta | null {
  const t = sinTildes(texto ?? '');
  if (!t.trim()) return null;
  if (/devoluci|devuelt/.test(t)) return 'DEVOLUCION';
  if (/rappel/.test(t)) return 'RAPPEL';
  if (/pronto pago|descuento|bonificaci/.test(t)) return 'DESCUENTO';
  if (/concurso/.test(t)) return 'CONCURSO';
  if (/impag|incobrable/.test(t)) return 'IMPAGO';
  if (/error|errata|equivoc|incorrect/.test(t)) return 'ERROR';
  return null;
}

/** Linea ya calculada de una factura (importes en la moneda de cuenta). */
export interface LineaImportes {
  tipoIva: number;
  /** Cuenta de ingresos; null = la generica (700). */
  cuenta: string | null;
  baseLine: number;
  ivaImporte: number;
  retencionImporte: number;
}

export interface DiferenciaSustitucion {
  porTipoIva: Array<{ tipoIva: number; base: number; cuota: number }>;
  porCuenta: Array<{ cuenta: string; base: number }>;
  base: number;
  cuota: number;
  retencion: number;
  total: number;
}

const CUENTA_GENERICA = '700';
const euros = (c: number) => (c === 0 ? 0 : c / 100);

/**
 * Rectificativa por sustitucion: lo que cuenta es la factura corregida menos
 * la original, por tipo de IVA (libro de expedidas y modelos) y por cuenta de
 * ingresos (asiento). Se resta linea a linea al centimo, sin recalcular el IVA
 * de la diferencia: el IVA por lineas no es lineal (dos lineas de 0,07 € al 21 %
 * dan 0,01 + 0,01; una de 0,14 €, 0,03).
 */
export function diferenciaSustitucion(corregida: LineaImportes[], original: LineaImportes[]): DiferenciaSustitucion {
  const porTipo = new Map<number, { base: number; cuota: number }>();
  const porCuenta = new Map<string, number>();
  let retencion = 0;
  const sumar = (lineas: LineaImportes[], signo: 1 | -1) => {
    for (const l of lineas) {
      const t = porTipo.get(l.tipoIva) ?? { base: 0, cuota: 0 };
      t.base += signo * aCentimos(l.baseLine);
      t.cuota += signo * aCentimos(l.ivaImporte);
      porTipo.set(l.tipoIva, t);
      const cuenta = l.cuenta || CUENTA_GENERICA;
      porCuenta.set(cuenta, (porCuenta.get(cuenta) ?? 0) + signo * aCentimos(l.baseLine));
      retencion += signo * aCentimos(l.retencionImporte);
    }
  };
  sumar(corregida, 1);
  sumar(original, -1);
  const tipos = [...porTipo.entries()].filter(([, v]) => v.base !== 0 || v.cuota !== 0).sort((a, b) => b[0] - a[0]);
  const base = tipos.reduce((a, [, v]) => a + v.base, 0);
  const cuota = tipos.reduce((a, [, v]) => a + v.cuota, 0);
  return {
    porTipoIva: tipos.map(([tipoIva, v]) => ({ tipoIva, base: euros(v.base), cuota: euros(v.cuota) })),
    porCuenta: [...porCuenta.entries()].filter(([, c]) => c !== 0).map(([cuenta, c]) => ({ cuenta, base: euros(c) })),
    base: euros(base),
    cuota: euros(cuota),
    retencion: euros(retencion),
    total: euros(base + cuota - retencion),
  };
}

export interface ImportesParte {
  base: number;
  cuota: number;
  retencion: number;
}

/** true si las partes suman al centimo la base, la cuota y la retencion de la rectificativa. */
export function repartoCuadra(partes: ImportesParte[], total: ImportesParte): boolean {
  const suma = (k: keyof ImportesParte) => partes.reduce((a, p) => a + aCentimos(p[k]), 0);
  return suma('base') === aCentimos(total.base) && suma('cuota') === aCentimos(total.cuota) && suma('retencion') === aCentimos(total.retencion);
}

/**
 * Cuenta que se propone por tipo de IVA en una rectificativa (lector): la de la
 * linea de mayor base (en valor absoluto) de ese tipo entre las lineas de todas
 * las originales, en el orden en que llegan; sin cuenta, la 700.
 */
export function cuentaPorTipoIva(lineas: Array<{ tipoIva: number; cuenta: string | null; baseLine: number }>): Record<string, string> {
  const mejor = new Map<number, { cuenta: string; base: number }>();
  for (const l of lineas) {
    const base = Math.abs(aCentimos(l.baseLine));
    const actual = mejor.get(l.tipoIva);
    if (!actual || base > actual.base) mejor.set(l.tipoIva, { cuenta: l.cuenta || CUENTA_GENERICA, base });
  }
  return Object.fromEntries([...mejor.entries()].map(([t, v]) => [String(t), v.cuenta]));
}

/**
 * Art. 89.Tres.1.º LIVA: no se sube la cuota repercutida a quien no actua como
 * empresario o profesional (cliente sin NIF o ticket), salvo por las causas del
 * art. 80 o por una subida legal del tipo. true si esta rectificativa lo haria.
 */
export function subeCuotaAConsumidorFinal(r: { motivo: MotivoVenta; cuota: number; clienteConNif: boolean; ticket: boolean }): boolean {
  if (aCentimos(r.cuota) <= 0) return false;
  if (r.clienteConNif && !r.ticket) return false;
  return !MOTIVO_INFO[r.motivo].art80;
}

const masAnios = (fecha: string, anios: number): string => {
  const [a, m, d] = fecha.split('-').map(Number);
  // 29-02 + 4 años que no es bisiesto: el 28-02.
  const ultimo = new Date(Date.UTC(a + anios, m, 0)).getUTCDate();
  return `${a + anios}-${String(m).padStart(2, '0')}-${String(Math.min(d, ultimo)).padStart(2, '0')}`;
};

/** Ultimo dia para rectificar por error (art. 89.Uno LIVA y art. 15.3 RD 1619/2012): cuatro años desde el devengo. */
export const limitePlazo = (devengo: string): string => masAnios(devengo, 4);

/**
 * Una R4 (error en datos o importes, u otra causa) que sube la cuota se declara
 * en el periodo de la original (art. 89.Cinco LIVA: no es una causa del art.
 * 80 ni un error fundado de derecho). El resto, en el periodo de la rectificativa.
 */
export function exigeImputarAlPeriodoOriginal(r: { motivo: MotivoVenta | null; ticket: boolean; cuota: number }): boolean {
  if (!r.motivo || r.ticket) return false;
  return MOTIVO_INFO[r.motivo].tipoFactura === 'R4' && aCentimos(r.cuota) > 0;
}

const ddmmaaaa = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}`;

/**
 * Texto del libro de expedidas y de la descripcion del asiento:
 * «Rectificativa (R1, por diferencias) de A-12 de 03/02/2027. Causa: devolución de mercancías o envases.»
 */
export function textoRectificaVenta(r: {
  tipoFactura: string;
  forma: FormaRectificacion;
  originales: Array<{ numero: string | null; fecha: string | null }>;
  periodo?: { desde: string; hasta: string } | null;
  motivo: MotivoVenta | null;
}): string {
  const que = r.periodo
    ? `las ventas del ${ddmmaaaa(r.periodo.desde)} al ${ddmmaaaa(r.periodo.hasta)}`
    : r.originales.map((o) => `${o.numero ?? 'sin número'}${o.fecha ? ` de ${ddmmaaaa(o.fecha)}` : ''}`).join(', ') || 'una factura anterior';
  const forma = r.forma === 'S' ? 'por sustitución' : 'por diferencias';
  const causa = r.motivo ? MOTIVO_INFO[r.motivo].texto : null;
  return `Rectificativa (${r.tipoFactura}, ${forma}) de ${que}.${causa ? ` Causa: ${causa.charAt(0).toLowerCase()}${causa.slice(1)}.` : ''}`;
}
