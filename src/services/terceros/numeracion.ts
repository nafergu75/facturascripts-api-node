/**
 * Numeracion de las subcuentas propias de clientes (430), proveedores (400) y
 * acreedores (410). Funciones puras: sin BD.
 *
 * Codigo = prefijo de 3 digitos + correlativo rellenado con ceros hasta la
 * longitud de la empresa (8 por defecto: 43000012). El correlativo 0 queda
 * reservado (43000000 = la generica rellenada) y nunca se reutiliza un numero:
 * el siguiente es el mayor ocupado + 1. Un proveedor usa el MISMO numero en la
 * 400 y en la 410, asi que para proveedores un numero esta ocupado si lo esta
 * en cualquiera de las dos.
 */
import { badRequest } from '../../utils/http-errors';

export const LONGITUD_SUBCUENTAS_DEFECTO = 8;
export const LONGITUD_SUBCUENTAS_MIN = 7;
export const LONGITUD_SUBCUENTAS_MAX = 10;

export type PrefijoTercero = '430' | '400' | '410';
export const PREFIJOS_CLIENTE: PrefijoTercero[] = ['430'];
export const PREFIJOS_PROVEEDOR: PrefijoTercero[] = ['400', '410'];

/** Longitud admitida para las subcuentas de terceros (7 a 10 digitos). */
export function esLongitudSubcuentasValida(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= LONGITUD_SUBCUENTAS_MIN && n <= LONGITUD_SUBCUENTAS_MAX;
}

/** La longitud si es valida (7-10); si no, la de por defecto (8). */
export function longitudSubcuentasValida(n: unknown): number {
  return esLongitudSubcuentasValida(n) ? n : LONGITUD_SUBCUENTAS_DEFECTO;
}

/** 430 + 12 con 8 digitos -> 43000012. Si el numero no cabe en la longitud, 400. */
export function codigoSubcuenta(prefijo: string, numero: number, longitud: number): string {
  const ancho = longitud - prefijo.length;
  const texto = String(numero);
  if (!Number.isInteger(numero) || numero < 0 || texto.length > ancho) {
    throw badRequest(`El número ${numero} no cabe en una subcuenta de ${longitud} dígitos.`);
  }
  return `${prefijo}${texto.padStart(ancho, '0')}`;
}

/** 43000012 -> 12. null si lo que sigue al prefijo no son digitos. */
export function numeroDeSubcuenta(codigo: string): number | null {
  const resto = codigo.slice(3);
  return /^\d+$/.test(resto) ? Number(resto) : null;
}

/** 430, 4300, 43000000...: la cuenta generica (todo ceros tras el prefijo). */
export function esSubcuentaGenerica(codigo: string): boolean {
  return /^(430|400|410)0*$/.test(codigo);
}

/**
 * Cuentas del PGC de 4 digitos bajo 400, 410 y 430 que NO son de un tercero
 * concreto: moneda extranjera (4004, 4104, 4304) y facturas pendientes de
 * recibir o de formalizar (4009, 4109, 4309). Sus subcuentas (40090000...) se
 * traen como cuentas normales: no se enlazan a fichas, no cuentan para la
 * numeracion de clientes y proveedores y nunca se asigna un numero que caiga
 * dentro de ellas.
 */
export const PREFIJOS_NO_TERCERO = ['4004', '4009', '4104', '4109', '4304', '4309'];

const enPrefijoNoTercero = (codigo: string) => PREFIJOS_NO_TERCERO.some((p) => codigo.startsWith(p));

/**
 * Subcuenta de tercero: 430/400/410 seguida de digitos con algun correlativo
 * distinto de 0, fuera de las cuentas 4004/4009/4104/4109/4304/4309.
 */
export function esSubcuentaDeTercero(codigo: string): boolean {
  return /^(430|400|410)\d+$/.test(codigo) && !esSubcuentaGenerica(codigo) && !enPrefijoNoTercero(codigo);
}

/**
 * Siguiente correlativo libre para esos prefijos (clientes ['430'];
 * proveedores ['400','410']), saltando el 0. Solo cuentan para el maximo las
 * subcuentas de tercero de la longitud de la empresa: las de otra longitud
 * (importadas de 10 digitos, por ejemplo) no se pisan porque tienen otro
 * codigo, y las de 4009, 4309... (facturas pendientes, moneda extranjera) no
 * son de terceros. Tampoco se asigna un numero que caiga en esas cuentas
 * (con 8 digitos, del 40000 al 49999 y del 90000 al 99999). Sin hueco, 400.
 */
export function siguienteNumeroTercero(ocupadas: Iterable<string>, prefijos: string[], longitud: number): number {
  const usadas = new Set(ocupadas);
  let max = 0;
  for (const c of usadas) {
    if (c.length !== longitud || !prefijos.some((p) => c.startsWith(p)) || !esSubcuentaDeTercero(c)) continue;
    const n = numeroDeSubcuenta(c);
    if (n !== null && n > max) max = n;
  }
  const tope = 10 ** (longitud - 3);
  for (let n = max + 1; n < tope; n++) {
    const codigos = prefijos.map((p) => codigoSubcuenta(p, n, longitud));
    if (codigos.some(enPrefijoNoTercero)) continue;
    if (codigos.every((c) => !usadas.has(c))) return n;
  }
  throw badRequest(
    `No quedan subcuentas libres de ${longitud} dígitos para dar de alta más ${prefijos.includes('430') ? 'clientes' : 'proveedores'}. Habla con tu asesor.`,
  );
}

/**
 * Longitud que ya usan las subcuentas de tercero (la mas habitual entre las
 * de 7 a 10 digitos), o null si no hay ninguna. Sirve a las empresas que traen
 * su plan de otro programa y aun no tienen la longitud guardada en sus reglas.
 */
export function longitudEnUso(codigos: Iterable<string>): number | null {
  const cuenta = new Map<number, number>();
  for (const c of codigos) {
    if (!esSubcuentaDeTercero(c) || !esLongitudSubcuentasValida(c.length)) continue;
    cuenta.set(c.length, (cuenta.get(c.length) ?? 0) + 1);
  }
  let mejor: number | null = null;
  for (const [l, n] of cuenta) if (mejor === null || n > cuenta.get(mejor)! || (n === cuenta.get(mejor) && l > mejor)) mejor = l;
  return mejor;
}
