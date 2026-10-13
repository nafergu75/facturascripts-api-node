import { CuentaBancariaEmpresa, MovimientoBancarioImportado } from '../domain/bancos.model';
import { badRequest } from '../utils/http-errors';
import { prisma } from '../config/database';
import { logger } from '../config/logger';
import { leerExtracto } from './extractoBancario.service';
import { aplicarReglas } from './tesoreriaCategorias.service';
import { monedaDeCuenta } from './perfilEmpresa.service';

const aCuenta = (c: {
  id: string;
  companyId: string;
  iban: string;
  bancoNombre: string | null;
  subcuentaCodigo: string;
  activa: boolean;
  moneda?: string | null;
}): CuentaBancariaEmpresa => ({
  id: c.id,
  companyId: c.companyId,
  iban: c.iban,
  bancoNombre: c.bancoNombre ?? undefined,
  subcuentaCodigo: c.subcuentaCodigo,
  activa: c.activa,
  moneda: c.moneda ?? 'EUR',
});

const aMovimiento = (m: {
  id: string;
  companyId: string;
  cuentaBancariaId: string;
  fecha: string;
  importe: number;
  concepto: string;
  referencia: string | null;
  origen: string;
  conciliado: boolean;
}): MovimientoBancarioImportado => ({
  id: m.id,
  companyId: m.companyId,
  cuentaBancariaId: m.cuentaBancariaId,
  fecha: m.fecha,
  importe: m.importe,
  concepto: m.concepto,
  referencia: m.referencia ?? undefined,
  origen: m.origen as 'norma43' | 'csv' | 'excel',
  conciliado: m.conciliado,
});

/**
 * Graba una cuenta tal cual, sin comprobar el IBAN ni la subcuenta. Solo la usan
 * las pruebas para preparar datos: la API da de alta las cuentas con
 * treasury.service (crearCuentaBancaria), tambien desde POST /bancos/cuentas.
 */
export async function crearCuentaBancaria(
  companyId: string,
  data: Omit<CuentaBancariaEmpresa, 'id' | 'companyId'>,
): Promise<CuentaBancariaEmpresa> {
  const cuenta = await prisma.bankAccount.create({
    data: {
      companyId,
      iban: data.iban,
      bancoNombre: data.bancoNombre,
      subcuentaCodigo: data.subcuentaCodigo,
      activa: data.activa,
      // En la moneda de la contabilidad de la empresa.
      moneda: await monedaDeCuenta(companyId),
    },
  });
  return aCuenta(cuenta);
}

export async function listarCuentasBancarias(companyId: string): Promise<CuentaBancariaEmpresa[]> {
  // De la mas antigua a la mas nueva: la primera es la que toma un cobro sin cuenta indicada.
  const cuentas = await prisma.bankAccount.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' } });
  return cuentas.map(aCuenta);
}

/**
 * Importa movimientos desde un CSV simple. Formato esperado (cabecera opcional):
 *   fecha;importe;concepto;referencia
 * Separador ';' o ','. Fecha yyyy-mm-dd o dd/mm/yyyy.
 */
export async function importarMovimientosDesdeCSV(
  companyId: string,
  cuentaBancariaId: string,
  csvContent: string,
): Promise<MovimientoBancarioImportado[]> {
  const cuenta = await prisma.bankAccount.findUnique({ where: { id: cuentaBancariaId } });
  if (!cuenta || cuenta.companyId !== companyId) throw badRequest('Cuenta bancaria no encontrada.');

  const lineas = csvContent.split(/\r?\n/);
  const aCrear: { fecha: string; importe: number; concepto: string; referencia?: string }[] = [];
  const errores: string[] = [];

  // Detectar separador: si la primera linea con contenido tiene `;`, es EU
  // (sep=`;`, decimal=`,`, miles=`.`); si no, sep=`,` y decimal=`.`.
  const primeraLinea = lineas.find((l) => l.trim().length > 0) ?? '';
  const usaSemicolon = primeraLinea.includes(';');
  const separador = usaSemicolon ? ';' : ',';

  lineas.forEach((linea, i) => {
    if (linea.trim().length === 0) return;
    const numLinea = i + 1;
    const cols = linea.split(separador).map((c) => c.trim());
    if (cols[0].toLowerCase() === 'fecha') return; // cabecera
    if (cols.length < 3) {
      errores.push(`linea ${numLinea}: faltan columnas (fecha, importe, concepto)`);
      return;
    }

    const fecha = normalizarFecha(cols[0]);
    const importe = parsearImporte(cols[1], usaSemicolon);
    if (!fecha) errores.push(`linea ${numLinea}: fecha no valida "${cols[0]}"`);
    if (!Number.isFinite(importe)) errores.push(`linea ${numLinea}: importe no valido "${cols[1]}"`);
    if (!fecha || !Number.isFinite(importe)) return;

    aCrear.push({ fecha, importe, concepto: cols[2] ?? '', referencia: cols[3] });
  });

  // Todo o nada: un extracto con lineas ilegibles no se importa a medias.
  if (errores.length > 0) {
    throw badRequest(`El extracto tiene lineas que no se pueden leer; no se ha importado nada. ${errores.join('; ')}`);
  }

  return (await guardarMovimientos(companyId, cuentaBancariaId, aCrear, 'csv')).importados;
}

const clave = (m: { fecha: string; importe: number; concepto: string }) =>
  `${m.fecha}|${Number(m.importe).toFixed(2)}|${m.concepto.trim().toLowerCase().replace(/\s+/g, ' ')}`;

/**
 * Separa los movimientos que ya estan en la cuenta (mismo dia, importe y
 * concepto). Dos extractos que se solapan son lo normal: antes se duplicaban.
 * Cuenta repeticiones: si un dia hay dos pagos iguales y ya habia uno, entra
 * el otro.
 */
export async function separarRepetidos<T extends { fecha: string; importe: number; concepto: string }>(
  cuentaBancariaId: string,
  movimientos: T[],
): Promise<{ nuevos: T[]; repetidos: T[] }> {
  if (movimientos.length === 0) return { nuevos: [], repetidos: [] };
  const fechas = movimientos.map((m) => m.fecha).sort();
  const existentes = await prisma.bankMovement.findMany({
    where: { cuentaBancariaId, fecha: { gte: fechas[0], lte: fechas[fechas.length - 1] } },
    select: { fecha: true, importe: true, concepto: true },
  });
  const disponibles = new Map<string, number>();
  for (const e of existentes) {
    const k = clave({ fecha: e.fecha, importe: Number(e.importe), concepto: e.concepto });
    disponibles.set(k, (disponibles.get(k) ?? 0) + 1);
  }
  const nuevos: T[] = [];
  const repetidos: T[] = [];
  for (const m of movimientos) {
    const k = clave(m);
    const n = disponibles.get(k) ?? 0;
    if (n > 0) {
      disponibles.set(k, n - 1);
      repetidos.push(m);
    } else nuevos.push(m);
  }
  return { nuevos, repetidos };
}

/**
 * Movimientos con fecha hasta la del saldo inicial de la cuenta (el saldo del
 * extracto a 31-12 que trajo la contabilidad de la gestoria): ya estan dentro
 * de ese saldo, asi que no se guardan. Sin fecha del saldo inicial, ninguno.
 */
export async function separarAnterioresAlSaldoInicial<T extends { fecha: string }>(
  cuentaBancariaId: string,
  movimientos: T[],
): Promise<{ posteriores: T[]; anteriores: T[]; fechaSaldoInicial: string | null }> {
  const c = await prisma.bankAccount.findUnique({ where: { id: cuentaBancariaId }, select: { fechaSaldoInicial: true } });
  const corte = c?.fechaSaldoInicial ?? null;
  if (!corte) return { posteriores: movimientos, anteriores: [], fechaSaldoInicial: null };
  return { posteriores: movimientos.filter((m) => m.fecha > corte), anteriores: movimientos.filter((m) => m.fecha <= corte), fechaSaldoInicial: corte };
}

/** Texto del aviso de los movimientos que no se guardan por ser anteriores al saldo inicial. */
export const textoAnterioresAlSaldoInicial = (n: number, fecha: string) =>
  `${n === 1 ? 'Un movimiento es' : `${n} movimientos son`} de antes del ${fecha.slice(8, 10)}-${fecha.slice(5, 7)}-${fecha.slice(0, 4)}: ya están dentro del saldo inicial de la cuenta, así que no se guardan.`;

/** Guarda los movimientos nuevos de un extracto (los repetidos y los anteriores al saldo inicial se omiten). */
export async function guardarMovimientos(
  companyId: string,
  cuentaBancariaId: string,
  movimientos: Array<{ fecha: string; importe: number; concepto: string; referencia?: string }>,
  origen: 'csv' | 'excel' | 'norma43',
): Promise<{ importados: MovimientoBancarioImportado[]; repetidos: number; categorizados: number; anteriores: number }> {
  const { posteriores, anteriores } = await separarAnterioresAlSaldoInicial(cuentaBancariaId, movimientos);
  const { nuevos, repetidos } = await separarRepetidos(cuentaBancariaId, posteriores);
  const importados: MovimientoBancarioImportado[] = [];
  for (const mov of nuevos) {
    const creado = await prisma.bankMovement.create({
      data: {
        companyId,
        cuentaBancariaId,
        fecha: mov.fecha,
        importe: mov.importe,
        concepto: mov.concepto,
        referencia: mov.referencia,
        origen,
        conciliado: false,
      },
    });
    importados.push(aMovimiento(creado));
  }
  // Las reglas guardadas al categorizar ("agua" -> Suministros) se aplican solas.
  // Si fallan, los movimientos ya estan guardados: se quedan sin categoria.
  let categorizados = 0;
  try {
    categorizados = await aplicarReglas(companyId, importados);
  } catch (e) {
    logger.warn(`tesoreria: no se pudieron aplicar las reglas de categorias (${(e as Error).message}).`);
  }
  return { importados, repetidos: repetidos.length, categorizados, anteriores: anteriores.length };
}

/**
 * Extracto en Excel o CSV (ver extractoBancario.service). Con vistaPrevia no
 * guarda nada: devuelve lo leido y cuantos movimientos son nuevos.
 */
export async function importarExtractoArchivo(
  companyId: string,
  cuentaBancariaId: string,
  contenido: Buffer,
  nombreArchivo: string,
  opciones: { vistaPrevia?: boolean } = {},
) {
  const cuenta = await prisma.bankAccount.findUnique({ where: { id: cuentaBancariaId } });
  if (!cuenta || cuenta.companyId !== companyId) throw badRequest('Cuenta bancaria no encontrada.');
  const extracto = leerExtracto(contenido, nombreArchivo);
  const origen = extracto.formato === 'csv' ? 'csv' : 'excel';
  const fechas = extracto.filas.map((f) => f.fecha).sort();
  const resumen = {
    formato: extracto.formato,
    columnas: extracto.columnas,
    avisos: extracto.avisos,
    total: extracto.filas.length,
    desde: fechas[0],
    hasta: fechas[fechas.length - 1],
    entradas: Number(extracto.filas.filter((f) => f.importe > 0).reduce((t, f) => t + f.importe, 0).toFixed(2)),
    salidas: Number(extracto.filas.filter((f) => f.importe < 0).reduce((t, f) => t + f.importe, 0).toFixed(2)),
  };
  const { posteriores, anteriores, fechaSaldoInicial } = await separarAnterioresAlSaldoInicial(cuentaBancariaId, extracto.filas);
  if (anteriores.length && fechaSaldoInicial) resumen.avisos = [...resumen.avisos, textoAnterioresAlSaldoInicial(anteriores.length, fechaSaldoInicial)];
  if (opciones.vistaPrevia) {
    const { nuevos, repetidos } = await separarRepetidos(cuentaBancariaId, posteriores);
    return { ...resumen, nuevos: nuevos.length, repetidos: repetidos.length, anteriores: anteriores.length, muestra: extracto.filas.slice(0, 15) };
  }
  const r = await guardarMovimientos(companyId, cuentaBancariaId, posteriores, origen);
  return { ...resumen, importados: r.importados.length, repetidos: r.repetidos, anteriores: anteriores.length, categorizados: r.categorizados };
}

export async function listarMovimientos(companyId: string, cuentaBancariaId?: string): Promise<MovimientoBancarioImportado[]> {
  const movimientos = await prisma.bankMovement.findMany({
    where: { companyId, ...(cuentaBancariaId && { cuentaBancariaId }) },
    orderBy: { fecha: 'asc' },
  });
  return movimientos.map(aMovimiento);
}

export async function obtenerMovimiento(companyId: string, movimientoId: string): Promise<MovimientoBancarioImportado> {
  const m = await prisma.bankMovement.findUnique({ where: { id: movimientoId } });
  if (!m || m.companyId !== companyId) throw badRequest('Movimiento bancario no encontrado.');
  return aMovimiento(m);
}

/** Marca un movimiento como conciliado (referenciando factura o subcuenta destino). */
export async function marcarMovimientoConciliado(
  companyId: string,
  movimientoId: string,
  referencia: string,
): Promise<MovimientoBancarioImportado> {
  await obtenerMovimiento(companyId, movimientoId); // valida existencia + pertenencia
  const actualizado = await prisma.bankMovement.update({
    where: { id: movimientoId },
    data: { conciliado: true, referencia },
  });
  return aMovimiento(actualizado);
}

/**
 * Importe de un extracto. Con formato europeo admite miles con punto y decimal
 * con coma ("1.234,56"); si no, decimal con punto ("1234.56"). Devuelve NaN si
 * el texto no es un importe.
 */
export function parsearImporte(texto: string, formatoEuropeo: boolean): number {
  const t = texto.replace(/[\s€]/g, '');
  // "-90.00" en un CSV europeo: un punto seguido de 1 o 2 cifras no puede ser de
  // miles (esos llevan siempre 3), asi que es el separador decimal.
  if (formatoEuropeo && /^-?\d+\.\d{1,2}$/.test(t)) return Number(t);
  const patron = formatoEuropeo ? /^-?\d{1,3}(\.\d{3})*(,\d+)?$|^-?\d+(,\d+)?$/ : /^-?\d+(\.\d+)?$/;
  if (!patron.test(t)) return NaN;
  return Number(formatoEuropeo ? t.replace(/\./g, '').replace(',', '.') : t);
}

/** dd/mm/aaaa o aaaa-mm-dd -> aaaa-mm-dd; cadena vacia si no es una fecha real. */
function normalizarFecha(s: string): string {
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  const iso = dmy ? `${dmy[3]}-${dmy[2]}-${dmy[1]}` : s.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : '';
}

// TODO: importarMovimientosDesdeNorma43(companyId, cuentaBancariaId, contenido)
//   parsear registros tipo 11/22/23/33/88 del cuaderno 43 del Consejo Superior Bancario.
