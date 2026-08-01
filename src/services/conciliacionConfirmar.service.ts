import { obtenerMovimiento, marcarMovimientoConciliado, listarCuentasBancarias } from './bancos.service';
import { registrarCobro } from './cobros.service';
import { crearAsientoTesoreria } from './asientos.service';
import { EstadoCobroFactura } from '../domain/cobros.model';
import { badRequest } from '../utils/http-errors';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Confirma la conciliacion de un movimiento bancario CON UNA FACTURA (patron
 * Quipu "validar propuesta"): registra el cobro por la via unica (vencimiento +
 * asiento de tesoreria 572<->430) y marca el movimiento como conciliado, dejando
 * la factura Cobrada/Parcial segun el importe del movimiento.
 */
export async function conciliarMovimientoConFactura(
  companyId: string,
  movimientoId: string,
  facturaId: string,
): Promise<{ estado: EstadoCobroFactura; movimientoConciliado: boolean }> {
  const mov = await obtenerMovimiento(companyId, movimientoId);
  if (mov.conciliado) throw badRequest('El movimiento ya esta conciliado.');
  if (mov.importe <= 0) {
    // TODO: movimientos de cargo (pagos a proveedor): localizar vencimiento de
    // pago y liquidarlo. Por ahora solo abonos (cobros de cliente).
    throw badRequest('Solo se concilian abonos (cobros) con factura de venta por ahora.');
  }
  const estado = await registrarCobro(companyId, facturaId, round2(mov.importe), mov.fecha, 'TRANSFERENCIA');
  await marcarMovimientoConciliado(companyId, movimientoId, `factura:${facturaId}`);
  return { estado, movimientoConciliado: true };
}

/**
 * Concilia un movimiento SIN documento contra una CUENTA CONTABLE (patron Quipu
 * "cuenta 555 - partidas pendientes de aplicacion", o cualquier cuenta de
 * balance, ej. 526 dividendos): crea el asiento 57x <-> subcuenta indicada.
 */
export async function conciliarMovimientoConCuenta(
  companyId: string,
  movimientoId: string,
  subcuenta = '5550000000',
  concepto?: string,
): Promise<{ asiento: unknown; movimientoConciliado: boolean }> {
  const mov = await obtenerMovimiento(companyId, movimientoId);
  if (mov.conciliado) throw badRequest('El movimiento ya esta conciliado.');

  const cuentas = await listarCuentasBancarias(companyId);
  const cuenta = cuentas.find((c) => c.id === mov.cuentaBancariaId);
  const subBanco = (cuenta?.subcuentaCodigo ?? '572000').padEnd(10, '0');

  const importe = round2(Math.abs(mov.importe));
  const desc = concepto ?? `Conciliacion ${mov.concepto}`.slice(0, 80);
  // Abono (entrada): banco al debe, contrapartida al haber. Cargo: al reves.
  const lineas =
    mov.importe >= 0
      ? [
          { subcuenta: subBanco, debe: importe, haber: 0, concepto: desc },
          { subcuenta, debe: 0, haber: importe, concepto: desc },
        ]
      : [
          { subcuenta, debe: importe, haber: 0, concepto: desc },
          { subcuenta: subBanco, debe: 0, haber: importe, concepto: desc },
        ];

  const { asiento } = await crearAsientoTesoreria(companyId, { fecha: mov.fecha, descripcion: desc, lineas });
  await marcarMovimientoConciliado(companyId, movimientoId, `subcuenta:${subcuenta}`);
  return { asiento, movimientoConciliado: true };
}
