// Modelos de balance y cuenta de perdidas y ganancias del PGC de PYMES
// (RD 1515/2007, tercera parte), con la correspondencia cuenta -> partida.
//
// Cada cuenta va a la partida de su prefijo MAS LARGO: la 630 (impuesto sobre
// beneficios) cae en la partida 18 aunque la 63 (tributos) vaya a la 7, y la
// 4751 en "otros acreedores" aunque la 47 tenga cuentas de activo. Los prefijos
// de un digito son el ultimo recurso, para que ningun saldo se quede fuera y el
// balance siempre cuadre.

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export type Masa = 'ANC' | 'AC' | 'PN' | 'PNC' | 'PC';

export interface PartidaModelo {
  codigo: string;
  descripcion: string;
  masa: Masa;
}

/** Partidas del balance PYMES, en el orden del modelo. */
export const PARTIDAS_BALANCE: PartidaModelo[] = [
  { codigo: 'A.I', masa: 'ANC', descripcion: 'Inmovilizado intangible' },
  { codigo: 'A.II', masa: 'ANC', descripcion: 'Inmovilizado material' },
  { codigo: 'A.III', masa: 'ANC', descripcion: 'Inversiones inmobiliarias' },
  { codigo: 'A.IV', masa: 'ANC', descripcion: 'Inversiones en empresas del grupo y asociadas a largo plazo' },
  { codigo: 'A.V', masa: 'ANC', descripcion: 'Inversiones financieras a largo plazo' },
  { codigo: 'A.VI', masa: 'ANC', descripcion: 'Activos por impuesto diferido' },
  { codigo: 'B.I', masa: 'AC', descripcion: 'Activos no corrientes mantenidos para la venta' },
  { codigo: 'B.II', masa: 'AC', descripcion: 'Existencias' },
  { codigo: 'B.III.1', masa: 'AC', descripcion: 'Clientes por ventas y prestaciones de servicios' },
  { codigo: 'B.III.2', masa: 'AC', descripcion: 'Accionistas (socios) por desembolsos exigidos' },
  { codigo: 'B.III.3', masa: 'AC', descripcion: 'Otros deudores' },
  { codigo: 'B.IV', masa: 'AC', descripcion: 'Inversiones en empresas del grupo y asociadas a corto plazo' },
  { codigo: 'B.V', masa: 'AC', descripcion: 'Inversiones financieras a corto plazo' },
  { codigo: 'B.VI', masa: 'AC', descripcion: 'Periodificaciones a corto plazo' },
  { codigo: 'B.VII', masa: 'AC', descripcion: 'Efectivo y otros activos líquidos equivalentes' },
  { codigo: 'A1.I', masa: 'PN', descripcion: 'Capital' },
  { codigo: 'A1.II', masa: 'PN', descripcion: 'Prima de emisión' },
  { codigo: 'A1.III', masa: 'PN', descripcion: 'Reservas' },
  { codigo: 'A1.IV', masa: 'PN', descripcion: '(Acciones y participaciones en patrimonio propias)' },
  { codigo: 'A1.V', masa: 'PN', descripcion: 'Resultados de ejercicios anteriores' },
  { codigo: 'A1.VI', masa: 'PN', descripcion: 'Otras aportaciones de socios' },
  { codigo: 'A1.VII', masa: 'PN', descripcion: 'Resultado del ejercicio' },
  { codigo: 'A1.VIII', masa: 'PN', descripcion: '(Dividendo a cuenta)' },
  { codigo: 'A2', masa: 'PN', descripcion: 'Subvenciones, donaciones y legados recibidos' },
  { codigo: 'C.I', masa: 'PNC', descripcion: 'Provisiones a largo plazo' },
  { codigo: 'C.II', masa: 'PNC', descripcion: 'Deudas a largo plazo' },
  { codigo: 'C.III', masa: 'PNC', descripcion: 'Deudas con empresas del grupo y asociadas a largo plazo' },
  { codigo: 'C.IV', masa: 'PNC', descripcion: 'Pasivos por impuesto diferido' },
  { codigo: 'C.V', masa: 'PNC', descripcion: 'Periodificaciones a largo plazo' },
  { codigo: 'D.I', masa: 'PC', descripcion: 'Provisiones a corto plazo' },
  { codigo: 'D.II', masa: 'PC', descripcion: 'Deudas a corto plazo' },
  { codigo: 'D.III', masa: 'PC', descripcion: 'Deudas con empresas del grupo y asociadas a corto plazo' },
  { codigo: 'D.IV.1', masa: 'PC', descripcion: 'Proveedores' },
  { codigo: 'D.IV.2', masa: 'PC', descripcion: 'Otros acreedores' },
  { codigo: 'D.V', masa: 'PC', descripcion: 'Periodificaciones a corto plazo' },
];

/**
 * Regla de balance: prefijos -> partida. `siNegativo` es la partida a la que va
 * el saldo cuando tiene el signo contrario al natural de su partida (un banco en
 * descubierto es deuda, no efectivo; un proveedor con saldo deudor es un deudor).
 */
interface ReglaBalance {
  prefijos: string[];
  partida: string;
  siNegativo?: string;
}

const REGLAS_BALANCE: ReglaBalance[] = [
  // Activo no corriente
  { prefijos: ['20', '280', '290'], partida: 'A.I' },
  { prefijos: ['21', '23', '281', '291'], partida: 'A.II' },
  { prefijos: ['22', '282', '292'], partida: 'A.III' },
  { prefijos: ['2403', '2404', '2413', '2414', '2423', '2424', '2493', '2494', '293'], partida: 'A.IV' },
  { prefijos: ['24', '25', '26', '29', '2'], partida: 'A.V' },
  { prefijos: ['474'], partida: 'A.VI' },
  // Activo corriente
  { prefijos: ['58', '599'], partida: 'B.I' },
  { prefijos: ['3', '407'], partida: 'B.II' },
  { prefijos: ['43', '490', '493'], partida: 'B.III.1', siNegativo: 'D.IV.2' },
  { prefijos: ['5580'], partida: 'B.III.2' },
  { prefijos: ['44', '460', '470', '471', '472', '473', '544'], partida: 'B.III.3', siNegativo: 'D.IV.2' },
  {
    prefijos: ['5303', '5304', '5313', '5314', '5323', '5324', '5333', '5334', '5343', '5344', '5353', '5354', '5393', '5394', '5523', '5524', '593'],
    partida: 'B.IV',
  },
  { prefijos: ['53', '54', '565', '566', '5590', '5593', '59'], partida: 'B.V' },
  { prefijos: ['480', '567'], partida: 'B.VI' },
  { prefijos: ['57'], partida: 'B.VII', siNegativo: 'D.II' },
  // Patrimonio neto
  { prefijos: ['10'], partida: 'A1.I' },
  { prefijos: ['110'], partida: 'A1.II' },
  { prefijos: ['11'], partida: 'A1.III' },
  { prefijos: ['108', '109'], partida: 'A1.IV' },
  { prefijos: ['118'], partida: 'A1.VI' },
  { prefijos: ['12'], partida: 'A1.V' }, // 120, 121 y la 129 de ejercicios anteriores
  { prefijos: ['557'], partida: 'A1.VIII' },
  { prefijos: ['13'], partida: 'A2' },
  // Pasivo no corriente
  { prefijos: ['14'], partida: 'C.I' },
  { prefijos: ['1603', '1604', '1613', '1614', '1623', '1624', '1633', '1634'], partida: 'C.III' },
  { prefijos: ['479'], partida: 'C.IV' },
  { prefijos: ['181'], partida: 'C.V' },
  { prefijos: ['15', '16', '17', '18', '1'], partida: 'C.II' },
  // Pasivo corriente
  { prefijos: ['499', '529'], partida: 'D.I' },
  { prefijos: ['5103', '5104', '5113', '5114', '5123', '5124', '5133', '5134', '5143', '5144', '5563', '5564'], partida: 'D.III' },
  { prefijos: ['19', '50', '51', '52', '55', '56', '5'], partida: 'D.II', siNegativo: 'B.V' },
  { prefijos: ['40'], partida: 'D.IV.1', siNegativo: 'B.III.3' },
  { prefijos: ['41', '438', '465', '466', '475', '476', '477', '4'], partida: 'D.IV.2', siNegativo: 'B.III.3' },
  { prefijos: ['485', '568'], partida: 'D.V' },
];

export interface LineaModelo {
  codigo: string;
  descripcion: string;
}

/** Partidas de la cuenta de perdidas y ganancias PYMES. */
export const PARTIDAS_PYG: LineaModelo[] = [
  { codigo: '1', descripcion: 'Importe neto de la cifra de negocios' },
  { codigo: '2', descripcion: 'Variación de existencias de productos terminados y en curso de fabricación' },
  { codigo: '3', descripcion: 'Trabajos realizados por la empresa para su activo' },
  { codigo: '4', descripcion: 'Aprovisionamientos' },
  { codigo: '5', descripcion: 'Otros ingresos de explotación' },
  { codigo: '6', descripcion: 'Gastos de personal' },
  { codigo: '7', descripcion: 'Otros gastos de explotación' },
  { codigo: '8', descripcion: 'Amortización del inmovilizado' },
  { codigo: '9', descripcion: 'Imputación de subvenciones de inmovilizado no financiero y otras' },
  { codigo: '10', descripcion: 'Excesos de provisiones' },
  { codigo: '11', descripcion: 'Deterioro y resultado por enajenaciones del inmovilizado' },
  { codigo: '12', descripcion: 'Otros resultados' },
  { codigo: '13', descripcion: 'Ingresos financieros' },
  { codigo: '14', descripcion: 'Gastos financieros' },
  { codigo: '15', descripcion: 'Variación de valor razonable en instrumentos financieros' },
  { codigo: '16', descripcion: 'Diferencias de cambio' },
  { codigo: '17', descripcion: 'Deterioro y resultado por enajenaciones de instrumentos financieros' },
  { codigo: '18', descripcion: 'Impuestos sobre beneficios' },
];

const PARTIDAS_EXPLOTACION = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
const PARTIDAS_FINANCIERAS = ['13', '14', '15', '16', '17'];

const REGLAS_PYG: Array<{ prefijos: string[]; partida: string }> = [
  { prefijos: ['70'], partida: '1' },
  { prefijos: ['71', '6930', '7930'], partida: '2' },
  { prefijos: ['73'], partida: '3' },
  { prefijos: ['60', '61', '6931', '6932', '6933', '7931', '7932', '7933'], partida: '4' },
  { prefijos: ['74', '75', '7'], partida: '5' },
  { prefijos: ['64'], partida: '6' },
  { prefijos: ['62', '63', '65', '69', '794', '7954', '6'], partida: '7' },
  { prefijos: ['68'], partida: '8' },
  { prefijos: ['746'], partida: '9' },
  { prefijos: ['79', '7951', '7952', '7955', '7956'], partida: '10' },
  { prefijos: ['670', '671', '672', '690', '691', '692', '770', '771', '772', '790', '791', '792'], partida: '11' },
  { prefijos: ['67', '77'], partida: '12' },
  { prefijos: ['76'], partida: '13' },
  { prefijos: ['66'], partida: '14' },
  { prefijos: ['663', '763'], partida: '15' },
  { prefijos: ['668', '768'], partida: '16' },
  { prefijos: ['666', '667', '673', '675', '696', '697', '698', '699', '766', '773', '775', '796', '797', '798', '799'], partida: '17' },
  { prefijos: ['630', '633', '638'], partida: '18' },
];

function reglaMasLarga<R extends { prefijos: string[] }>(reglas: R[], cuenta: string): R | undefined {
  let mejor: R | undefined;
  let largo = 0;
  for (const r of reglas) {
    for (const p of r.prefijos) {
      if (cuenta.startsWith(p) && p.length > largo) {
        mejor = r;
        largo = p.length;
      }
    }
  }
  return mejor;
}

/** Partida de PyG de una cuenta de los grupos 6 y 7. */
export function partidaPyG(cuenta: string): string {
  return reglaMasLarga(REGLAS_PYG, cuenta)?.partida ?? (cuenta.startsWith('7') ? '5' : '7');
}

const MASA_DE = new Map(PARTIDAS_BALANCE.map((p) => [p.codigo, p.masa]));
const esActivo = (partida: string): boolean => {
  const m = MASA_DE.get(partida);
  return m === 'ANC' || m === 'AC';
};

/**
 * Partida de balance de una cuenta de los grupos 1-5 segun su saldo deudor
 * (debe - haber), con el importe en el signo natural de esa partida (positivo
 * en activo si es deudor; positivo en PN y pasivo si es acreedor).
 */
export function partidaBalance(cuenta: string, saldoDeudor: number): { partida: string; importe: number } {
  const regla = reglaMasLarga(REGLAS_BALANCE, cuenta);
  const partida = regla?.partida ?? 'D.IV.2';
  const importe = esActivo(partida) ? saldoDeudor : -saldoDeudor;
  if (importe < 0 && regla?.siNegativo) {
    const alt = regla.siNegativo;
    return { partida: alt, importe: esActivo(alt) ? saldoDeudor : -saldoDeudor };
  }
  return { partida, importe };
}

export interface ImportePartida {
  codigo: string;
  descripcion: string;
  importe: number;
}

export interface PyGModelo {
  partidas: ImportePartida[];
  resultadoExplotacion: number;
  resultadoFinanciero: number;
  resultadoAntesImpuestos: number;
  resultadoEjercicio: number;
}

/**
 * PyG a partir de los saldos de las cuentas 6 y 7 del ejercicio. Cada partida va
 * con su signo: ingresos en positivo y gastos en negativo, como en el modelo.
 */
export function calcularPyGModelo(saldosDeudores: Map<string, number>): PyGModelo {
  const suma = new Map<string, number>();
  for (const [cuenta, saldo] of saldosDeudores) {
    if (!cuenta.startsWith('6') && !cuenta.startsWith('7')) continue;
    const p = partidaPyG(cuenta);
    suma.set(p, round2((suma.get(p) ?? 0) - saldo)); // haber - debe
  }
  const partidas = PARTIDAS_PYG.map((l) => ({ ...l, importe: suma.get(l.codigo) ?? 0 }));
  const total = (codigos: string[]) => round2(codigos.reduce((acc, c) => acc + (suma.get(c) ?? 0), 0));
  const resultadoExplotacion = total(PARTIDAS_EXPLOTACION);
  const resultadoFinanciero = total(PARTIDAS_FINANCIERAS);
  const resultadoAntesImpuestos = round2(resultadoExplotacion + resultadoFinanciero);
  return {
    partidas,
    resultadoExplotacion,
    resultadoFinanciero,
    resultadoAntesImpuestos,
    resultadoEjercicio: round2(resultadoAntesImpuestos + (suma.get('18') ?? 0)),
  };
}

export interface BalanceModelo {
  partidas: Array<ImportePartida & { masa: Masa }>;
  totales: Record<Masa, number>;
  totalActivo: number;
  totalPatrimonioNetoYPasivo: number;
  /** Activo - (PN + pasivo). Tiene que ser 0. */
  descuadre: number;
}

/**
 * Balance a partir de los saldos de las cuentas de balance (grupos 1-5) y de los
 * resultados: el del ejercicio va a A1.VII y el de ejercicios anteriores aun no
 * llevado a reservas (cuentas 6/7 de otros años sin regularizar) a A1.V.
 */
export function calcularBalanceModelo(
  saldosDeudores: Map<string, number>,
  resultadoEjercicio: number,
  resultadoAnteriores: number,
): BalanceModelo {
  const suma = new Map<string, number>();
  const sumar = (p: string, n: number) => suma.set(p, round2((suma.get(p) ?? 0) + n));
  for (const [cuenta, saldo] of saldosDeudores) {
    if (cuenta.startsWith('6') || cuenta.startsWith('7') || saldo === 0) continue;
    const { partida, importe } = partidaBalance(cuenta, saldo);
    sumar(partida, importe);
  }
  sumar('A1.VII', resultadoEjercicio);
  sumar('A1.V', resultadoAnteriores);

  const partidas = PARTIDAS_BALANCE.map((p) => ({ ...p, importe: suma.get(p.codigo) ?? 0 }));
  const totales = { ANC: 0, AC: 0, PN: 0, PNC: 0, PC: 0 } as Record<Masa, number>;
  for (const p of partidas) totales[p.masa] = round2(totales[p.masa] + p.importe);
  const totalActivo = round2(totales.ANC + totales.AC);
  const totalPatrimonioNetoYPasivo = round2(totales.PN + totales.PNC + totales.PC);
  return { partidas, totales, totalActivo, totalPatrimonioNetoYPasivo, descuadre: round2(totalActivo - totalPatrimonioNetoYPasivo) };
}
