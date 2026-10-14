/**
 * Textos exactos de los registros de VERI*FACTU (spec verifactu, 3.4 y 3.6).
 *
 * El mismo texto va a la huella, a las columnas del registro, al XML (fase F2)
 * y al QR: SHA-256 no da lo mismo con «123.1» que con «123.10», asi que cada
 * dato se escribe en un unico sitio y siempre igual. Funciones puras.
 *
 *  - Importes: dos decimales siempre, punto decimal, sin separador de miles y
 *    «-» en negativos (nunca «-0.00»). Patron ImporteSgn12.2Type del XSD:
 *    (\+|-)?\d{1,12}(\.\d{0,2})?
 *  - Tipos impositivos: patron Tipo2.2Type, \d{1,3}(\.\d{0,2})?
 *  - Fechas: dd-mm-aaaa.
 *  - FechaHoraHusoGenRegistro: AAAA-MM-DDThh:mm:ss+01:00 (o +02:00), con la
 *    hora de Madrid, y nunca por detras de la del registro anterior.
 */
import { aCentimos } from '../../utils/money';
import { formatearHusoMadrid } from '../../utils/fechas';

/** Euros -> centimos enteros (el redondeo de siempre: utils/money). */
export const centimos = (euros: number): number => aCentimos(euros);

/** Tope del XSD: 12 cifras enteras (ImporteSgn12.2Type). */
const MAX_CENTIMOS = 999_999_999_999_99;

/** true si un importe en centimos cabe en el XSD (12 cifras enteras). */
export function cabeEnImporte(c: number): boolean {
  return Number.isSafeInteger(c) && Math.abs(c) <= MAX_CENTIMOS;
}

/**
 * Importe en centimos enteros -> texto de la AEAT: «1234567.80», «-123.40»,
 * «0.00». Lanza si no es un entero o si pasa de 12 cifras enteras.
 */
export function formatearImporte(c: number): string {
  if (!Number.isSafeInteger(c)) throw new Error(`Importe en céntimos no entero: ${c}`);
  if (!cabeEnImporte(c)) throw new Error(`Importe fuera del rango de la AEAT (12 cifras enteras): ${c / 100}`);
  if (c === 0) return '0.00'; // tambien -0
  const abs = Math.abs(c);
  const entero = Math.floor(abs / 100);
  const dec = String(abs % 100).padStart(2, '0');
  return `${c < 0 ? '-' : ''}${entero}.${dec}`;
}

/** Tipo impositivo (21, 10, 4, 0, 5.5...) -> «21.00». Patron Tipo2.2Type, sin signo. */
export function formatearTipo(tipo: number): string {
  if (!Number.isFinite(tipo) || tipo < 0) throw new Error(`Tipo impositivo no valido: ${tipo}`);
  const c = aCentimos(tipo);
  if (c > 999_99) throw new Error(`Tipo impositivo no valido: ${tipo}`);
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
}

const FECHA_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** true si es una fecha AAAA-MM-DD que existe. */
export function esFechaIso(fecha: string): boolean {
  const m = FECHA_ISO.exec(String(fecha ?? ''));
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** «2027-01-04» -> «04-01-2027». Lanza si la fecha no existe. */
export function fechaAeat(fecha: string): string {
  if (!esFechaIso(fecha)) throw new Error(`Fecha no valida: ${fecha}`);
  const [a, m, d] = fecha.split('-');
  return `${d}-${m}-${a}`;
}

const HUSO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

/** Texto de FechaHoraHusoGenRegistro -> instante. Lanza si no tiene ese formato. */
export function instanteDeHuso(texto: string): Date {
  if (!HUSO_RE.test(String(texto ?? ''))) throw new Error(`FechaHoraHusoGenRegistro no valida: ${texto}`);
  const d = new Date(texto);
  if (Number.isNaN(d.getTime())) throw new Error(`FechaHoraHusoGenRegistro no valida: ${texto}`);
  return d;
}

/**
 * FechaHoraHusoGenRegistro del registro nuevo: la hora de Madrid de `ahora`
 * o, si el registro anterior de la cadena es posterior (reloj atrasado, dos
 * registros en el mismo segundo), la del anterior: la cadena nunca va hacia
 * atras. El margen de un minuto del art. 7.i de la Orden HAC/1177/2024 no se
 * aplica a VERI*FACTU (art. 3), pero asi no hay aviso posible.
 */
export function fechaHoraHusoGenRegistro(ahora: Date, anterior: string | null | undefined): string {
  if (anterior) {
    const previo = instanteDeHuso(anterior);
    if (previo.getTime() >= ahora.getTime()) return formatearHusoMadrid(previo);
  }
  return formatearHusoMadrid(ahora);
}
