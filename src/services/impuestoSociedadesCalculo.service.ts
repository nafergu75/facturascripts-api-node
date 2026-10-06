import {
  AjusteExtracontable,
  BalanceSituacion,
  ComponenteECPN,
  CuentaPerdidasGanancias,
  DatosModelo200,
  EstadoCambiosPatrimonioNeto,
} from '../domain/impuesto-sociedades.model';
import { AsientoSimple, obtenerAsientosHastaFinDe, saldosDelEjercicio, SaldosEjercicio } from './contabilidadDatos.service';
import {
  BalanceModelo,
  calcularBalanceModelo,
  calcularPyGModelo,
  PyGModelo,
} from '../domain/modelos-cuentas-anuales';
import { getFsClientForCompany } from './facturascripts-client';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Balance, PyG y ECPN segun los modelos del PGC de PYMES.
 *
 * La PyG sale de las cuentas 6/7 del ejercicio y el balance de los saldos
 * ACUMULADOS de las cuentas 1-5 al cierre (ver saldosDelEjercicio). Antes se
 * usaban solo los asientos del año, con bloques genericos: el balance olvidaba
 * los saldos de años anteriores, el 630 contaba dos veces (como tributo y como
 * impuesto) y las cuentas sin bloque (13, 14, 465, 67...) lo descuadraban.
 */
export function calcularEstadosDesdeSaldos(
  saldos: SaldosEjercicio,
  anterior?: SaldosEjercicio,
): {
  balance: BalanceSituacion;
  pyg: CuentaPerdidasGanancias;
  ecpn: EstadoCambiosPatrimonioNeto;
} {
  const pygModelo = calcularPyGModelo(saldos.pyg);
  const balanceModelo = calcularBalanceModelo(saldos.balance, pygModelo.resultadoEjercicio, saldos.resultadoAnteriores);
  const pyg = pygDesdeModelo(pygModelo);
  const balance = balanceDesdeModelo(balanceModelo);

  let pnInicial = new Map<string, number>();
  let resultadoAnterior = 0;
  if (anterior) {
    const pygAnt = calcularPyGModelo(anterior.pyg);
    resultadoAnterior = pygAnt.resultadoEjercicio;
    const balAnt = calcularBalanceModelo(anterior.balance, resultadoAnterior, anterior.resultadoAnteriores);
    pnInicial = new Map(balAnt.partidas.filter((p) => p.masa === 'PN').map((p) => [p.codigo, p.importe]));
  }
  const ecpn = ecpnDesdeBalances(balanceModelo, pnInicial, pygModelo.resultadoEjercicio);

  return { balance, pyg, ecpn };
}

const PARTIDAS_SOCIOS = new Set(['A1.I', 'A1.II', 'A1.IV', 'A1.VI', 'A1.VIII']);

/**
 * ECPN (estado total de cambios): por cada componente del PN, saldo inicial, el
 * resultado del ejercicio, ingresos y gastos imputados directamente al PN
 * (subvenciones), operaciones con socios (capital, prima, acciones propias,
 * aportaciones, dividendo a cuenta) y el resto (sobre todo la aplicacion del
 * resultado anterior). Cada fila cuadra: inicial + movimientos = final.
 */
function ecpnDesdeBalances(
  balance: BalanceModelo,
  inicial: Map<string, number>,
  resultadoEjercicio: number,
): EstadoCambiosPatrimonioNeto {
  const componentes: ComponenteECPN[] = balance.partidas
    .filter((p) => p.masa === 'PN')
    .map((p) => {
      const saldoInicial = inicial.get(p.codigo) ?? 0;
      const variacion = round2(p.importe - saldoInicial);
      const resultado = p.codigo === 'A1.VII' ? resultadoEjercicio : 0;
      const igReconocidos = p.codigo === 'A2' ? variacion : 0;
      const socios = PARTIDAS_SOCIOS.has(p.codigo) ? variacion : 0;
      return {
        codigo: p.codigo,
        descripcion: p.descripcion,
        saldoInicial,
        resultadoEjercicio: resultado,
        ingresosGastosReconocidos: igReconocidos,
        operacionesSocios: socios,
        otrasVariaciones: round2(variacion - resultado - igReconocidos - socios),
        saldoFinal: p.importe,
      };
    });

  const imp = (codigo: string) => componentes.find((c) => c.codigo === codigo)?.saldoFinal ?? 0;
  const capital = imp('A1.I');
  const reservas = imp('A1.III');
  return {
    capital,
    reservas,
    resultadoEjercicio,
    otrasPartidas: round2(balance.totales.PN - capital - reservas - resultadoEjercicio),
    totalPatrimonioNeto: balance.totales.PN,
    componentes,
  };
}

function pygDesdeModelo(m: PyGModelo): CuentaPerdidasGanancias {
  const p = (codigo: string) => m.partidas.find((x) => x.codigo === codigo)?.importe ?? 0;
  // Campos agregados de siempre (los usa el Modelo 200), coherentes con las
  // partidas: gastos en positivo, como antes.
  return {
    importeNetoCifraNegocios: p('1'),
    otrosIngresosExplotacion: round2(p('2') + p('3') + p('5') + p('9') + p('10') + p('11') + p('12')),
    aprovisionamientos: -p('4'),
    gastosPersonal: -p('6'),
    otrosGastosExplotacion: -p('7'),
    amortizaciones: -p('8'),
    resultadoExplotacion: m.resultadoExplotacion,
    ingresosFinancieros: p('13'),
    gastosFinancieros: round2(p('13') - m.resultadoFinanciero),
    resultadoFinanciero: m.resultadoFinanciero,
    resultadoAntesImpuestos: m.resultadoAntesImpuestos,
    impuestoBeneficios: -p('18'),
    resultadoEjercicio: m.resultadoEjercicio,
    partidas: m.partidas,
  };
}

function balanceDesdeModelo(m: BalanceModelo): BalanceSituacion {
  const de = (masa: string) =>
    m.partidas.filter((p) => p.masa === masa).map((p) => ({ codigo: p.codigo, descripcion: p.descripcion, importe: p.importe }));
  return {
    activoNoCorriente: de('ANC'),
    activoCorriente: de('AC'),
    patrimonioNeto: de('PN'),
    pasivoNoCorriente: de('PNC'),
    pasivoCorriente: de('PC'),
    totalActivo: m.totalActivo,
    totalPatrimonioNetoYPasivo: m.totalPatrimonioNetoYPasivo,
    descuadre: m.descuadre,
  };
}

export interface EstadosFinancieros {
  balance: BalanceSituacion;
  pyg: CuentaPerdidasGanancias;
  ecpn: EstadoCambiosPatrimonioNeto;
  /** Asientos del ejercicio, sin apertura, regularizacion ni cierre (para el EFE). */
  asientos: AsientoSimple[];
  /** Mismos estados del ejercicio anterior (columna N-1 de los modelos). */
  anterior: { balance: BalanceSituacion; pyg: CuentaPerdidasGanancias };
  /** Saldo de tesoreria (57) al cierre del ejercicio anterior. */
  efectivoInicial: number;
  /** Saldo acreedor de la reserva legal (112) al cierre. */
  reservaLegal: number;
  /** Saldos por cuenta del ejercicio y del anterior (para la memoria). */
  saldos: SaldosEjercicio;
  saldosAnterior: SaldosEjercicio;
}

/**
 * Calcula los estados financieros del ejercicio (y los del anterior, para la
 * columna comparativa) con los asientos hasta su cierre. Reutilizado por el
 * Modelo 200 y por las Cuentas Anuales (RM): las cifras fiscales y las
 * mercantiles salen del mismo calculo.
 */
export async function calcularEstadosFinancieros(companyId: string, ejercicio: number): Promise<EstadosFinancieros> {
  const todos = await obtenerAsientosHastaFinDe(companyId, ejercicio);
  const saldos = saldosDelEjercicio(todos, ejercicio);
  const saldosAnt = saldosDelEjercicio(todos, ejercicio - 1);
  const saldosAnt2 = saldosDelEjercicio(todos, ejercicio - 2);

  const actual = calcularEstadosDesdeSaldos(saldos, saldosAnt);
  const anterior = calcularEstadosDesdeSaldos(saldosAnt, saldosAnt2);

  let efectivoInicial = 0;
  for (const [cuenta, saldo] of saldosAnt.balance) if (cuenta.startsWith('57')) efectivoInicial += saldo;

  let reservaLegal = 0;
  for (const [cuenta, saldo] of saldos.balance) if (cuenta.startsWith('112')) reservaLegal -= saldo;

  const anio = String(ejercicio);
  return {
    saldos,
    saldosAnterior: saldosAnt,
    reservaLegal: round2(reservaLegal),
    ...actual,
    asientos: todos.filter((a) => a.fecha.startsWith(anio) && (a.tipo ?? 'NORMAL') === 'NORMAL'),
    anterior: { balance: anterior.balance, pyg: anterior.pyg },
    efectivoInicial: round2(efectivoInicial),
  };
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
