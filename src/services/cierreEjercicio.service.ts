import { obtenerAsientosEjercicio, calcularSaldosPorSubcuenta } from './contabilidadDatos.service';
import { getFsClientForCompany } from './facturascripts-client';
import { crearAsientoConApuntes, ApunteAsiento } from './asientos.service';
import { listarPeriodos } from './periodos.service';
import { obtenerCierreConfig } from './cierreConfig.service';
import { calcularCuadreBancos } from './cuadreBancos.service';
import { badRequest, conflict } from '../utils/http-errors';

export interface ResultadoCierre {
  asientoRegularizacionId: string;
  asientoCierreId: string;
  asientoAperturaId: string;
  resultadoEjercicio: number;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const SUB_RESULTADO = '1290000000'; // 129 Resultado del ejercicio (PN)

/**
 * Ejecuta el cierre contable del ejercicio creando los 3 asientos en FS:
 *  1. REGULARIZACION: salda gastos (grupo 6) e ingresos (grupo 7) contra 129.
 *     resultado = ingresos - gastos.
 *  2. CIERRE: salda las cuentas de balance (grupos 1-5) + 129 -> asiento de cierre.
 *  3. APERTURA: reabre esos saldos en el ejercicio siguiente (si existe en FS).
 */
export async function ejecutarCierreEjercicio(companyId: string, ejercicio: number): Promise<ResultadoCierre> {
  // 1. Verificar que no quedan periodos abiertos
  const periodos = await listarPeriodos(companyId, ejercicio);
  const abiertos = periodos.filter((p) => p.estado === 'abierto');
  if (abiertos.length > 0) {
    throw badRequest(`No se puede cerrar: ${abiertos.length} periodos siguen abiertos. Bloquea/cierra todos los meses primero.`);
  }

  // 1b. Cuadre de bancos (bloqueante si la empresa lo exige y hay descuadre)
  const config = await obtenerCierreConfig(companyId);
  if (config.exigirCuadreBancos) {
    const cuadre = await calcularCuadreBancos(companyId, ejercicio, config.toleranciaCuadre);
    if (!cuadre.todasCuadran) {
      const descuadradas = cuadre.cuentas.filter((c) => !c.cuadra);
      throw conflict(
        `No se puede cerrar: ${descuadradas.length} cuenta(s) bancaria(s) no cuadran con la contabilidad.`,
        { cuentasDescuadradas: descuadradas, totalDiferencia: cuadre.totalDiferencia },
      );
    }
  }

  const fs = await getFsClientForCompany(companyId);
  const ej = await fs.listWithMeta('ejercicios', { 'filter[codejercicio]': ejercicio, limit: 1 });
  const idempresa = (ej.items[0] as Record<string, unknown> | undefined)?.idempresa ?? 1;

  const asientos = await obtenerAsientosEjercicio(companyId, ejercicio);
  const saldos = calcularSaldosPorSubcuenta(asientos);

  // 2. Regularizacion (grupos 6 y 7 -> 129)
  const apuntesReg: ApunteAsiento[] = [];
  let ingresos = 0;
  let gastos = 0;
  for (const s of saldos.values()) {
    if (s.subcuenta.startsWith('7')) {
      const saldoAcre = round2(s.haber - s.debe);
      if (saldoAcre !== 0) {
        ingresos = round2(ingresos + saldoAcre);
        apuntesReg.push({ subcuenta: s.subcuenta, debe: saldoAcre, haber: 0, concepto: 'Regularizacion' });
      }
    } else if (s.subcuenta.startsWith('6')) {
      const saldoDeu = round2(s.debe - s.haber);
      if (saldoDeu !== 0) {
        gastos = round2(gastos + saldoDeu);
        apuntesReg.push({ subcuenta: s.subcuenta, debe: 0, haber: saldoDeu, concepto: 'Regularizacion' });
      }
    }
  }
  const resultadoEjercicio = round2(ingresos - gastos);

  let asientoRegularizacionId = '(sin gastos/ingresos que regularizar)';
  if (apuntesReg.length > 0) {
    apuntesReg.push({
      subcuenta: SUB_RESULTADO,
      debe: resultadoEjercicio < 0 ? -resultadoEjercicio : 0,
      haber: resultadoEjercicio > 0 ? resultadoEjercicio : 0,
      concepto: 'Resultado del ejercicio',
    });
    const r = await crearAsientoConApuntes(companyId, {
      codejercicio: String(ejercicio),
      idempresa,
      fecha: `${ejercicio}-12-31`,
      concepto: `Regularizacion ejercicio ${ejercicio}`,
      apuntes: apuntesReg,
    });
    asientoRegularizacionId = String(r.asiento.idasiento);
  }

  // 3. Cierre (cuentas de balance no 6/7 + 129)
  const apuntesCierre: ApunteAsiento[] = [];
  for (const s of saldos.values()) {
    if (s.subcuenta.startsWith('6') || s.subcuenta.startsWith('7')) continue;
    if (s.saldoDeudor === 0) continue;
    apuntesCierre.push({
      subcuenta: s.subcuenta,
      debe: s.saldoDeudor < 0 ? -s.saldoDeudor : 0,
      haber: s.saldoDeudor > 0 ? s.saldoDeudor : 0,
      concepto: 'Cierre',
    });
  }
  if (resultadoEjercicio !== 0) {
    apuntesCierre.push({
      subcuenta: SUB_RESULTADO,
      debe: resultadoEjercicio > 0 ? resultadoEjercicio : 0,
      haber: resultadoEjercicio < 0 ? -resultadoEjercicio : 0,
      concepto: 'Cierre',
    });
  }

  let asientoCierreId = '(sin saldos que cerrar)';
  if (apuntesCierre.length > 0) {
    const c = await crearAsientoConApuntes(companyId, {
      codejercicio: String(ejercicio),
      idempresa,
      fecha: `${ejercicio}-12-31`,
      concepto: `Cierre ejercicio ${ejercicio}`,
      apuntes: apuntesCierre,
    });
    asientoCierreId = String(c.asiento.idasiento);
  }

  // 4. Apertura del ejercicio siguiente (inverso del cierre), si existe en FS
  let asientoAperturaId = `PENDIENTE (ejercicio ${ejercicio + 1} no existe en FacturaScripts)`;
  const ejSig = await fs.listWithMeta('ejercicios', { 'filter[codejercicio]': ejercicio + 1, limit: 1 });
  if (ejSig.items.length > 0 && apuntesCierre.length > 0) {
    const apuntesApertura: ApunteAsiento[] = apuntesCierre.map((a) => ({
      subcuenta: a.subcuenta,
      debe: a.haber,
      haber: a.debe,
      concepto: 'Apertura',
    }));
    const ap = await crearAsientoConApuntes(companyId, {
      codejercicio: String(ejercicio + 1),
      idempresa,
      fecha: `${ejercicio + 1}-01-01`,
      concepto: `Apertura ejercicio ${ejercicio + 1}`,
      apuntes: apuntesApertura,
    });
    asientoAperturaId = String(ap.asiento.idasiento);
  }

  return { asientoRegularizacionId, asientoCierreId, asientoAperturaId, resultadoEjercicio };
}
