import { obtenerMovimiento, marcarMovimientoConciliado, listarCuentasBancarias } from './bancos.service';
import { registrarCobroFactura, type ResumenCobros } from './cobrosPagos.service';
import { crearAsientoTesoreria } from './asientos.service';
import { EstadoCobro, EstadoCobroFactura } from '../domain/cobros.model';
import { badRequest } from '../utils/http-errors';
import { comprobarFechaAbierta } from './periodos.service';
import { exigirSubcuentaDeBanco } from './subcuentaBanco.service';
import { prisma } from '../config/database';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Estado de cobro (pendiente, parcial, cobrada, vencida) a partir del resumen de cobros. */
function estadoDeResumen(r: ResumenCobros): EstadoCobroFactura {
  const activos = r.cobros.filter((c) => c.estado === 'ACTIVO');
  const estadoCobro: EstadoCobro =
    r.estado === 'PAID' ? 'cobrada' : r.estado === 'OVERDUE' ? 'vencida' : r.importeCobrado > 0 ? 'parcial' : 'pendiente';
  return {
    estadoCobro,
    importeCobrado: r.importeCobrado,
    importePendiente: r.importePendiente,
    ...(activos.length ? { fechaUltimoCobro: activos[activos.length - 1].fecha } : {}),
  };
}

/**
 * Confirma la conciliacion de un movimiento bancario CON UNA FACTURA DE VENTA:
 * registra el cobro por la misma via que la pantalla de cobros
 * (cobrosPagos.registrarCobroFactura: InvoicePayment + asiento 572 contra la
 * subcuenta del cliente que uso la factura) con la cuenta bancaria y la fecha
 * del movimiento, y lo marca conciliado. Antes pasaba por el codigo heredado de
 * FacturaScripts (cuenta 430 inventada a partir del codigo de cliente).
 */
export async function conciliarMovimientoConFactura(
  companyId: string,
  movimientoId: string,
  facturaId: string,
): Promise<{ estado: EstadoCobroFactura; movimientoConciliado: boolean; cobroId: string }> {
  const mov = await obtenerMovimiento(companyId, movimientoId);
  if (mov.conciliado) throw badRequest('El movimiento ya esta conciliado.');
  if (mov.importe <= 0) {
    // Pagos a proveedores desde la conciliacion: aun no existen (se pagan desde la factura de gasto).
    throw badRequest('Solo se concilian abonos (cobros) con factura de venta por ahora.');
  }
  // El cobro se apunta con la fecha del movimiento: ni en un mes bloqueado ni en un ejercicio cerrado.
  await comprobarFechaAbierta(companyId, mov.fecha, 'conciliar el movimiento');
  const { cobro, resumen } = await registrarCobroFactura(companyId, 'INGRESO', facturaId, {
    fecha: mov.fecha,
    importe: round2(mov.importe),
    cuentaBancariaId: mov.cuentaBancariaId,
    nota: `Conciliado con el movimiento del banco: ${mov.concepto}`.slice(0, 200),
  });
  await marcarMovimientoConciliado(companyId, movimientoId, `factura:${facturaId}`);
  return { estado: estadoDeResumen(resumen), movimientoConciliado: true, cobroId: cobro.id };
}

/**
 * Concilia un movimiento SIN documento contra una CUENTA CONTABLE (la 555
 * "partidas pendientes de aplicacion" por defecto, o cualquier cuenta del plan,
 * ej. 526 dividendos): crea el asiento 57x <-> esa cuenta. La cuenta tiene que
 * existir y estar activa en el plan de la empresa; el banco va con el codigo
 * real de su subcuenta de tesoreria.
 */
export async function conciliarMovimientoConCuenta(
  companyId: string,
  movimientoId: string,
  subcuenta = '555',
  concepto?: string,
): Promise<{ asiento: unknown; movimientoConciliado: boolean }> {
  const mov = await obtenerMovimiento(companyId, movimientoId);
  if (mov.conciliado) throw badRequest('El movimiento ya esta conciliado.');
  await comprobarFechaAbierta(companyId, mov.fecha, 'conciliar el movimiento');

  const codigo = String(subcuenta ?? '').trim();
  if (/^\d{1,2}$/.test(codigo)) {
    throw badRequest(`La ${codigo} es un grupo o subgrupo del plan y no lleva apuntes: elige una cuenta de 3 o más dígitos.`, { campo: 'subcuenta' });
  }
  const enPlan = codigo ? await prisma.chartOfAccounts.findFirst({ where: { companyId, codigo }, select: { activo: true } }) : null;
  if (!enPlan) throw badRequest(`La cuenta ${codigo || '(vacía)'} no está en el plan contable de la empresa: elige una que exista.`, { campo: 'subcuenta' });
  if (!enPlan.activo) throw badRequest(`La cuenta ${codigo} está desactivada en el plan contable: elige otra o actívala antes.`, { campo: 'subcuenta' });

  const cuentas = await listarCuentasBancarias(companyId);
  const cuenta = cuentas.find((c) => c.id === mov.cuentaBancariaId);
  if (!cuenta?.subcuentaCodigo) throw badRequest('La cuenta bancaria del movimiento no tiene subcuenta de tesorería (572): ponla en Tesorería > Cuentas bancarias.');
  exigirSubcuentaDeBanco(cuenta, 'conciliar el movimiento');
  const subBanco = cuenta.subcuentaCodigo;

  const importe = round2(Math.abs(mov.importe));
  const desc = concepto ?? `Conciliacion ${mov.concepto}`.slice(0, 80);
  // Abono (entrada): banco al debe, contrapartida al haber. Cargo: al reves.
  const lineas =
    mov.importe >= 0
      ? [
          { subcuenta: subBanco, debe: importe, haber: 0, concepto: desc },
          { subcuenta: codigo, debe: 0, haber: importe, concepto: desc },
        ]
      : [
          { subcuenta: codigo, debe: importe, haber: 0, concepto: desc },
          { subcuenta: subBanco, debe: 0, haber: importe, concepto: desc },
        ];

  const { asiento } = await crearAsientoTesoreria(companyId, { fecha: mov.fecha, descripcion: desc, lineas });
  await marcarMovimientoConciliado(companyId, movimientoId, `subcuenta:${codigo}`);
  return { asiento, movimientoConciliado: true };
}
