import { listarCuentasBancarias, listarMovimientos } from './bancos.service';
import { obtenerAsientosEjercicio, calcularSaldosPorSubcuenta } from './contabilidadDatos.service';
import { ExtractoBancario, LineaExtracto, RevisionExtractoContable } from '../domain/extractos.model';
import { notFound } from '../utils/http-errors';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

interface RangoFechas {
  desde?: string;
  hasta?: string;
  saldoInicial?: number;
}

async function obtenerCuenta(companyId: string, cuentaBancariaId: string) {
  const cuentas = await listarCuentasBancarias(companyId);
  const cuenta = cuentas.find((c) => c.id === cuentaBancariaId);
  if (!cuenta) throw notFound('Cuenta bancaria no encontrada.');
  return cuenta;
}

/**
 * Genera el extracto bancario de una cuenta: ordena los movimientos importados
 * por fecha, calcula cargos/abonos y el saldo acumulado partiendo de saldoInicial.
 */
export async function generarExtractoBancario(
  companyId: string,
  cuentaBancariaId: string,
  rango: RangoFechas = {},
): Promise<ExtractoBancario> {
  const cuenta = await obtenerCuenta(companyId, cuentaBancariaId);
  const movs = (await listarMovimientos(companyId, cuentaBancariaId))
    .filter((m) => (!rango.desde || m.fecha >= rango.desde) && (!rango.hasta || m.fecha <= rango.hasta))
    .sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));

  const saldoInicial = round2(rango.saldoInicial ?? 0);
  let saldo = saldoInicial;
  let totalCargos = 0;
  let totalAbonos = 0;

  const lineas: LineaExtracto[] = movs.map((m) => {
    const importe = round2(m.importe);
    saldo = round2(saldo + importe);
    if (importe < 0) totalCargos = round2(totalCargos + -importe);
    else totalAbonos = round2(totalAbonos + importe);
    return {
      fecha: m.fecha,
      concepto: m.concepto,
      referencia: m.referencia,
      cargo: importe < 0 ? round2(-importe) : 0,
      abono: importe > 0 ? importe : 0,
      importe,
      saldoAcumulado: saldo,
      conciliado: m.conciliado,
    };
  });

  return {
    cuentaBancariaId,
    iban: cuenta.iban,
    subcuentaCodigo: cuenta.subcuentaCodigo,
    desde: rango.desde,
    hasta: rango.hasta,
    saldoInicial,
    saldoFinal: saldo,
    totalCargos,
    totalAbonos,
    numMovimientos: lineas.length,
    lineas,
  };
}

/** Exporta el extracto a CSV (separador ';', cabecera incluida). */
export function exportarExtractoCSV(extracto: ExtractoBancario): string {
  const esc = (v: string) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const cab = 'fecha;concepto;referencia;cargo;abono;saldo';
  const filas = extracto.lineas.map((l) =>
    [l.fecha, esc(l.concepto), esc(l.referencia ?? ''), l.cargo.toFixed(2), l.abono.toFixed(2), l.saldoAcumulado.toFixed(2)].join(';'),
  );
  return [cab, ...filas].join('\r\n') + '\r\n';
}

/**
 * Revisa los gastos/ingresos del extracto frente a la contabilidad: compara el
 * saldo del extracto con el saldo contable de la subcuenta 57x asociada y cuenta
 * los movimientos sin conciliar (posibles apuntes pendientes de contabilizar).
 */
export async function revisarExtractoContraContabilidad(
  companyId: string,
  cuentaBancariaId: string,
  ejercicio: number,
  rango: RangoFechas = {},
): Promise<RevisionExtractoContable> {
  const extracto = await generarExtractoBancario(companyId, cuentaBancariaId, rango);

  const asientos = await obtenerAsientosEjercicio(companyId, ejercicio);
  const saldos = calcularSaldosPorSubcuenta(asientos);
  // saldoDeudor de la(s) subcuenta(s) que empiezan por el codigo de la cuenta (572xxx)
  let saldoContable = 0;
  for (const s of saldos.values()) {
    if (s.subcuenta.startsWith(extracto.subcuentaCodigo)) saldoContable = round2(saldoContable + s.saldoDeudor);
  }

  const sinConciliar = extracto.lineas.filter((l) => !l.conciliado);
  const ingresosSinConciliar = round2(sinConciliar.reduce((a, l) => a + l.abono, 0));
  const gastosSinConciliar = round2(sinConciliar.reduce((a, l) => a + l.cargo, 0));
  const diferencia = round2(extracto.saldoFinal - saldoContable);

  return {
    cuentaBancariaId,
    subcuentaCodigo: extracto.subcuentaCodigo,
    saldoExtracto: extracto.saldoFinal,
    saldoContable,
    diferencia,
    cuadra: Math.abs(diferencia) < 0.01,
    ingresosSinConciliar,
    gastosSinConciliar,
    movimientosSinConciliar: sinConciliar.length,
  };
}
