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

  const lineas = csvContent.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const aCrear: { fecha: string; importe: number; concepto: string; referencia?: string }[] = [];

  // Detectar separador: si tiene `;`, es EU (sep=`;`, decimal=`,`)
  // si no, asumir US (sep=`,`, decimal=`.`)
  const primeraLinea = lineas[0] || '';
  const usaSemicolon = primeraLinea.includes(';');
  const separador = usaSemicolon ? ';' : ',';

  for (const linea of lineas) {
    const cols = linea.split(separador).map((c) => c.trim());
    if (cols.length < 3) continue;
    if (cols[0].toLowerCase() === 'fecha') continue; // cabecera

    // Normalizar importe: (EU) "89,90" o (US) "89.90" -> number
    // Si usa `;` (EU), la coma es decimal. Si usa `,` (US), el punto es decimal.
    const importeStr = cols[1];
    let importe = 0;
    if (usaSemicolon) {
      // EU: coma es decimal
      importe = Number(importeStr.replace(',', '.'));
    } else {
      // US: punto es decimal (sin cambios)
      importe = Number(importeStr);
    }
    if (!Number.isFinite(importe)) continue;

    aCrear.push({
      fecha: normalizarFecha(cols[0]),
      importe,
      concepto: cols[2] ?? '',
      referencia: cols[3],
    });
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

function normalizarFecha(s: string): string {
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return s.slice(0, 10);
}

// TODO: importarMovimientosDesdeNorma43(companyId, cuentaBancariaId, contenido)
//   parsear registros tipo 11/22/23/33/88 del cuaderno 43 del Consejo Superior Bancario.
