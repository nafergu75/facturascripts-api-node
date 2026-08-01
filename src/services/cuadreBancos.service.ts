import { listarCuentasBancarias } from './bancos.service';
import { generarExtractoBancario } from './extractos.service';
import { obtenerAsientosEjercicio, calcularSaldosPorSubcuenta } from './contabilidadDatos.service';
import { obtenerCierreConfig } from './cierreConfig.service';
import { CuadreBancosEmpresa, DiferenciaCuentaBancaria } from '../domain/cuadreBancos.model';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Calcula el cuadre de bancos del ejercicio: para cada cuenta bancaria compara el
 * saldo contable de su subcuenta 57x (suma de saldos deudores cuyo codigo empieza
 * por subcuentaCodigo) con el saldo del extracto importado. Devuelve la diferencia
 * por cuenta y si todas cuadran dentro de la tolerancia configurada.
 */
export async function calcularCuadreBancos(
  companyId: string,
  ejercicio: number,
  toleranciaOverride?: number,
): Promise<CuadreBancosEmpresa> {
  const tolerancia = toleranciaOverride ?? (await obtenerCierreConfig(companyId)).toleranciaCuadre;

  const cuentas = await listarCuentasBancarias(companyId);
  const asientos = await obtenerAsientosEjercicio(companyId, ejercicio);
  const saldos = calcularSaldosPorSubcuenta(asientos);

  const resultado: DiferenciaCuentaBancaria[] = [];
  for (const cuenta of cuentas) {
    let saldoContable = 0;
    for (const s of saldos.values()) {
      if (s.subcuenta.startsWith(cuenta.subcuentaCodigo)) saldoContable = round2(saldoContable + s.saldoDeudor);
    }
    const extracto = await generarExtractoBancario(companyId, cuenta.id, {});
    const diferencia = round2(saldoContable - extracto.saldoFinal);
    resultado.push({
      cuentaBancariaId: cuenta.id,
      iban: cuenta.iban,
      subcuentaCodigo: cuenta.subcuentaCodigo,
      saldoContable,
      saldoExtracto: extracto.saldoFinal,
      diferencia,
      cuadra: Math.abs(diferencia) <= tolerancia,
    });
  }

  const totalDiferencia = round2(resultado.reduce((a, c) => a + Math.abs(c.diferencia), 0));
  return {
    ejercicio,
    tolerancia,
    cuentas: resultado,
    todasCuadran: resultado.every((c) => c.cuadra),
    totalDiferencia,
  };
}
