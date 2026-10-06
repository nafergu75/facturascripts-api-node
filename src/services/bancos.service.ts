import { CuentaBancariaEmpresa, MovimientoBancarioImportado } from '../domain/bancos.model';
import { badRequest } from '../utils/http-errors';
import { prisma } from '../config/database';

const aCuenta = (c: { id: string; companyId: string; iban: string; bancoNombre: string | null; subcuentaCodigo: string; activa: boolean }): CuentaBancariaEmpresa => ({
  id: c.id,
  companyId: c.companyId,
  iban: c.iban,
  bancoNombre: c.bancoNombre ?? undefined,
  subcuentaCodigo: c.subcuentaCodigo,
  activa: c.activa,
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
  origen: m.origen as 'norma43' | 'csv',
  conciliado: m.conciliado,
});

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
    },
  });
  return aCuenta(cuenta);
}

export async function listarCuentasBancarias(companyId: string): Promise<CuentaBancariaEmpresa[]> {
  const cuentas = await prisma.bankAccount.findMany({ where: { companyId } });
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

  const importados: MovimientoBancarioImportado[] = [];
  for (const mov of aCrear) {
    const creado = await prisma.bankMovement.create({
      data: {
        companyId,
        cuentaBancariaId,
        fecha: mov.fecha,
        importe: mov.importe,
        concepto: mov.concepto,
        referencia: mov.referencia,
        origen: 'csv',
        conciliado: false,
      },
    });
    importados.push(aMovimiento(creado));
  }
  return importados;
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
