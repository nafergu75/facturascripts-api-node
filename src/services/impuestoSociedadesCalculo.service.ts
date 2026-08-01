import {
  AjusteExtracontable,
  BalanceSituacion,
  CuentaPerdidasGanancias,
  DatosModelo200,
  EstadoCambiosPatrimonioNeto,
} from '../domain/impuesto-sociedades.model';
import {
  AsientoSimple,
  calcularSaldosPorSubcuenta,
  obtenerAsientosEjercicio,
  saldoAcreedor,
  saldoDeudor,
  SaldoSubcuenta,
} from './contabilidadDatos.service';
import { getFsClientForCompany } from './facturascripts-client';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Construye balance, PyG y ECPN a partir de los saldos de subcuentas. */
export function calcularEstadosDesdeSaldos(saldos: Map<string, SaldoSubcuenta>): {
  balance: BalanceSituacion;
  pyg: CuentaPerdidasGanancias;
  ecpn: EstadoCambiosPatrimonioNeto;
} {
  // --- Cuenta de Perdidas y Ganancias (grupos 6 y 7) ---
  const importeNetoCifraNegocios = saldoAcreedor(saldos, ['70']);
  const otrosIngresosExplotacion = saldoAcreedor(saldos, ['74', '75']);
  const aprovisionamientos = saldoDeudor(saldos, ['60', '61']);
  const gastosPersonal = saldoDeudor(saldos, ['64']);
  const otrosGastosExplotacion = saldoDeudor(saldos, ['62', '63', '65']);
  const amortizaciones = saldoDeudor(saldos, ['68']);
  const resultadoExplotacion = round2(
    importeNetoCifraNegocios + otrosIngresosExplotacion - aprovisionamientos - gastosPersonal - otrosGastosExplotacion - amortizaciones,
  );
  const ingresosFinancieros = saldoAcreedor(saldos, ['76']);
  const gastosFinancieros = saldoDeudor(saldos, ['66']);
  const resultadoFinanciero = round2(ingresosFinancieros - gastosFinancieros);
  const resultadoAntesImpuestos = round2(resultadoExplotacion + resultadoFinanciero);
  const impuestoBeneficios = saldoDeudor(saldos, ['630', '6300', '6301']); // TODO: gasto por IS real
  const resultadoEjercicio = round2(resultadoAntesImpuestos - impuestoBeneficios);

  const pyg: CuentaPerdidasGanancias = {
    importeNetoCifraNegocios,
    otrosIngresosExplotacion,
    aprovisionamientos,
    gastosPersonal,
    otrosGastosExplotacion,
    amortizaciones,
    resultadoExplotacion,
    ingresosFinancieros,
    gastosFinancieros,
    resultadoFinanciero,
    resultadoAntesImpuestos,
    impuestoBeneficios,
    resultadoEjercicio,
  };

  // --- Balance de situacion (grandes bloques PGC) ---
  const inmovilizado = saldoDeudor(saldos, ['20', '21', '22', '23', '24', '25', '26', '27', '28', '29']);
  const existencias = saldoDeudor(saldos, ['30', '31', '32', '33', '34', '35', '36']);
  // 470-474 = HP deudora (activo); 475-477 = HP acreedora (pasivo, abajo)
  const deudores = saldoDeudor(saldos, ['43', '44', '470', '471', '472', '473', '474', '54']);
  const efectivo = saldoDeudor(saldos, ['57']);

  const capital = saldoAcreedor(saldos, ['10']);
  const reservas = saldoAcreedor(saldos, ['11', '12']);
  const pasivoNoCorrienteImporte = saldoAcreedor(saldos, ['15', '16', '17', '18']);
  const pasivoCorrienteImporte = saldoAcreedor(saldos, ['40', '41', '475', '476', '477', '52', '55']);

  const totalActivo = round2(inmovilizado + existencias + deudores + efectivo);
  const patrimonioNetoImporte = round2(capital + reservas + resultadoEjercicio);
  const totalPatrimonioNetoYPasivo = round2(patrimonioNetoImporte + pasivoNoCorrienteImporte + pasivoCorrienteImporte);

  const balance: BalanceSituacion = {
    activoNoCorriente: [{ descripcion: 'Inmovilizado (grupo 2)', importe: inmovilizado }],
    activoCorriente: [
      { descripcion: 'Existencias (grupo 3)', importe: existencias },
      { descripcion: 'Deudores comerciales (43/44/46/47/54)', importe: deudores },
      { descripcion: 'Efectivo y otros activos liquidos (57)', importe: efectivo },
    ],
    patrimonioNeto: [
      { descripcion: 'Capital (10)', importe: capital },
      { descripcion: 'Reservas (11/12)', importe: reservas },
      { descripcion: 'Resultado del ejercicio', importe: resultadoEjercicio },
    ],
    pasivoNoCorriente: [{ descripcion: 'Deudas a largo plazo (15/16/17/18)', importe: pasivoNoCorrienteImporte }],
    pasivoCorriente: [{ descripcion: 'Acreedores comerciales y otras deudas (40/41/46/47/52/55)', importe: pasivoCorrienteImporte }],
    totalActivo,
    totalPatrimonioNetoYPasivo,
  };

  const ecpn: EstadoCambiosPatrimonioNeto = {
    capital,
    reservas,
    resultadoEjercicio,
    otrasPartidas: 0,
    totalPatrimonioNeto: patrimonioNetoImporte,
  };

  return { balance, pyg, ecpn };
}

/**
 * Calcula los estados financieros del ejercicio leyendo los asientos de FS.
 * Reutilizado tanto por el Modelo 200 como por las Cuentas Anuales (RM) para
 * garantizar consistencia entre fiscal y mercantil.
 */
export async function calcularEstadosFinancieros(
  companyId: string,
  ejercicio: number,
): Promise<{ balance: BalanceSituacion; pyg: CuentaPerdidasGanancias; ecpn: EstadoCambiosPatrimonioNeto; asientos: AsientoSimple[] }> {
  const asientos = await obtenerAsientosEjercicio(companyId, ejercicio);
  const saldos = calcularSaldosPorSubcuenta(asientos);
  return { ...calcularEstadosDesdeSaldos(saldos), asientos };
}

/** Calcula los datos del Modelo 200 a partir de los estados financieros. */
export async function calcularModelo200(companyId: string, ejercicio: number): Promise<DatosModelo200> {
  const { balance, pyg } = await calcularEstadosFinancieros(companyId, ejercicio);

  const resultadoContableAntesImpuestos = pyg.resultadoAntesImpuestos;

  // TODO: ajustes extracontables reales (diferencias permanentes/temporales).
  const ajustesExtracontables: AjusteExtracontable[] = [];
  const ajusteNeto = ajustesExtracontables.reduce(
    (acc, a) => acc + (a.sentido === '+' ? a.importe : -a.importe),
    0,
  );

  const baseImponiblePrevia = round2(resultadoContableAntesImpuestos + ajusteNeto);
  const basesNegativasCompensables = 0; // TODO: parametrizable / arrastre BINs
  const baseImponibleFinal = round2(baseImponiblePrevia - basesNegativasCompensables);
  const tipoGravamen = 25; // TODO: 23% para microempresas, tipos especiales, etc.
  const cuotaIntegra = round2(Math.max(0, baseImponibleFinal) * (tipoGravamen / 100));
  const deduccionesBonificaciones = 0; // TODO
  const pagosFraccionadosRetenciones = 0; // TODO (modelos 202)
  const cuotaLiquida = round2(Math.max(0, cuotaIntegra - deduccionesBonificaciones));
  const cuotaADepositarODevolver = round2(cuotaLiquida - pagosFraccionadosRetenciones);

  let nif = '';
  let razonSocial = '';
  try {
    const fs = await getFsClientForCompany(companyId);
    const { items } = await fs.listWithMeta('empresas', { limit: 1 });
    const e = items[0] as Record<string, unknown> | undefined;
    nif = String(e?.cifnif ?? '');
    razonSocial = String(e?.nombre ?? '');
  } catch {
    // Si FS no responde, se deja vacio (no bloquea el resto del calculo).
  }

  // PENDIENTE BLOQUEADO: este calculo es una aproximacion simplificada del Modelo
  // 200. Los siguientes apartados NO estan implementados y se devuelven en 0/valor
  // por defecto a proposito — requieren datos historicos multi-ejercicio (BINs),
  // un catalogo de deducciones, y el seguimiento de los modelos 202 trimestrales
  // que hoy no existen en el sistema. No usar este resultado como cifra final de
  // presentacion sin revision manual de un asesor fiscal.
  const advertencias = [
    'Bases imponibles negativas de ejercicios anteriores no incluidas (requiere historico multi-ejercicio).',
    'Deducciones y bonificaciones no incluidas (requiere catalogo de deducciones).',
    'Pagos fraccionados/retenciones (modelo 202) no incluidos.',
    'Tipo de gravamen reducido para microempresas/entidades de nueva creacion no evaluado (se aplica 25% general).',
  ];

  return {
    nif,
    razonSocial,
    ejercicio,
    periodo: { ejercicio, fechaInicio: `${ejercicio}-01-01`, fechaFin: `${ejercicio}-12-31` },
    claveEntidad: '',
    balance,
    pyg,
    resultadoContableAntesImpuestos,
    ajustesExtracontables,
    baseImponiblePrevia,
    basesNegativasCompensables,
    baseImponibleFinal,
    tipoGravamen,
    cuotaIntegra,
    deduccionesBonificaciones,
    pagosFraccionadosRetenciones,
    cuotaLiquida,
    cuotaADepositarODevolver,
    advertencias,
  };
}
