/**
 * Copia CONGELADA de los agregadores de los modelos de IVA tal como estaban
 * antes de los tipos de operacion y las divisas (impuestosCalculo.service.ts,
 * commit 74ba2f0). Sirve para comprobar que las facturas anteriores (sin tipo
 * de operacion) dan exactamente las mismas cifras. No tocar.
 */
import {
  DatosModelo303,
  DatosModelo347,
  DatosModelo349,
  DatosModelo390,
  DesgloseIva,
  FacturaFiscal,
  filasRegimenGeneral303,
  OperacionTercero,
  PeriodoFiscal,
} from '../domain/impuestos.model';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const UMBRAL_347 = 3005.06;

// ---------------------------------------------------------------------------
// Helpers de agregacion (logica pura, testeable)
// ---------------------------------------------------------------------------

function enRango(fecha: string, desde: string, hasta: string): boolean {
  return fecha >= desde && fecha <= hasta; // formato yyyy-mm-dd comparable lexicograficamente
}

/** Agrupa las lineas de un conjunto de facturas por tipo de IVA. */
function agruparPorTipoIva(facturas: FacturaFiscal[]): DesgloseIva[] {
  const mapa = new Map<number, DesgloseIva>();
  for (const f of facturas) {
    for (const l of f.lineas) {
      const prev = mapa.get(l.tipoIva) ?? { tipo: l.tipoIva, base: 0, cuota: 0 };
      prev.base = round2(prev.base + l.base);
      prev.cuota = round2(prev.cuota + l.cuota);
      mapa.set(l.tipoIva, prev);
    }
  }
  return [...mapa.values()].sort((a, b) => b.tipo - a.tipo);
}

const sumCuota = (d: DesgloseIva[]): number => round2(d.reduce((a, x) => a + x.cuota, 0));
const sumBase = (d: DesgloseIva[]): number => round2(d.reduce((a, x) => a + x.base, 0));

// ---------------------------------------------------------------------------
// Agregadores por modelo (reciben el array de facturas fiscales)
// ---------------------------------------------------------------------------

/**
 * Modelo 303: IVA devengado (ventas interiores) vs deducible (compras).
 * `cuotasACompensar` = cuotas negativas de periodos anteriores [78] (patron
 * Quipu "303 a compensar"): se restan del resultado para obtener el final [71].
 */
export function agregar303Anterior(
  facturas: FacturaFiscal[],
  periodo: PeriodoFiscal,
  cuotasACompensar = 0,
): DatosModelo303 {
  const delPeriodo = facturas.filter((f) => enRango(f.fecha, periodo.fechaInicio, periodo.fechaFin));

  const ventasInteriores = delPeriodo.filter((f) => f.tipo === 'venta' && f.operacion === 'interior');
  // Solo gastos DEDUCIBLES (deducible===false los excluye; por defecto deducible)
  const comprasDeducibles = delPeriodo.filter((f) => f.tipo === 'compra' && f.deducible !== false);
  const baseDe = (fs: FacturaFiscal[]): number => round2(fs.reduce((a, f) => a + f.lineas.reduce((x, l) => x + l.base, 0), 0));
  // Informacion adicional pag.3 (Critica 3 hace posible este desglose)
  const entregasIntracomunitarias = baseDe(delPeriodo.filter((f) => f.tipo === 'venta' && f.operacion === 'intracomunitaria'));
  const exportaciones = baseDe(delPeriodo.filter((f) => f.tipo === 'venta' && f.operacion === 'exportacion'));

  const ivaDevengado = agruparPorTipoIva(ventasInteriores);
  const ivaDeducible = agruparPorTipoIva(comprasDeducibles);

  const totalCuotaDevengada = sumCuota(ivaDevengado);
  const totalCuotaDeducible = sumCuota(ivaDeducible);
  const resultado = round2(totalCuotaDevengada - totalCuotaDeducible);
  // Las cuotas a compensar [110] solo se aplican [78] hasta dejar el resultado en
  // cero: con resultado negativo no se aplica nada y todo pasa a [87].
  const pendientesAnteriores = round2(Math.abs(cuotasACompensar));
  const cuotasAplicadas = round2(Math.min(pendientesAnteriores, Math.max(resultado, 0)));
  const cuotasPendientesPosteriores = round2(pendientesAnteriores - cuotasAplicadas);
  const resultadoFinal = round2(resultado - cuotasAplicadas);

  // Casillas OFICIALES del 303. Bloque devengado del regimen general, una fila
  // FIJA por tipo (ver FILA_303_POR_TIPO): [01]-[03] 4 %, [04]-[06] 10 %,
  // [07]-[09] 21 %.
  const casillas: Record<string, number> = {};
  const filas: Array<[string, string, string]> = [
    ['01', '02', '03'],
    ['04', '05', '06'],
    ['07', '08', '09'],
  ];
  const { filas: porFila, sinFila } = filasRegimenGeneral303(ivaDevengado);
  porFila.forEach((d, i) => {
    if (!d) return;
    const [cBase, cTipo, cCuota] = filas[i];
    casillas[`${cBase}_base_devengada_${d.tipo}`] = d.base;
    casillas[`${cTipo}_tipo`] = d.tipo;
    casillas[`${cCuota}_cuota_devengada_${d.tipo}`] = d.cuota;
  });
  const advertencias = sinFila.map(
    (d) =>
      `Hay ventas al ${d.tipo} % (base ${d.base.toFixed(2)} €, cuota ${d.cuota.toFixed(2)} €): ese tipo no tiene fila en el régimen general del 303. Revísalas antes de presentar.`,
  );
  Object.assign(casillas, {
    '27_total_devengado': totalCuotaDevengada,
    '28_base_deducible': sumBase(ivaDeducible),
    '29_cuota_deducible': totalCuotaDeducible,
    '45_total_deducir': totalCuotaDeducible,
    '46_resultado_regimen_general': resultado,
    '110_cuotas_pendientes_anteriores': pendientesAnteriores,
    '78_cuotas_a_compensar': cuotasAplicadas,
    '87_pendientes_periodos_posteriores': cuotasPendientesPosteriores,
    '71_resultado': resultadoFinal,
  });

  return {
    periodo,
    ivaDevengado,
    totalBaseDevengada: sumBase(ivaDevengado),
    totalCuotaDevengada,
    ivaDeducible,
    totalBaseDeducible: sumBase(ivaDeducible),
    totalCuotaDeducible,
    resultado,
    cuotasACompensarAnteriores: pendientesAnteriores,
    cuotasAplicadas,
    cuotasPendientesPosteriores,
    resultadoFinal,
    entregasIntracomunitarias,
    exportaciones,
    casillas,
    ...(advertencias.length && { advertencias }),
  };
}

/** Modelo 390: resumen anual de IVA. */
export function agregar390Anterior(facturas: FacturaFiscal[], ejercicio: number): DatosModelo390 {
  const delAno = facturas.filter((f) => f.fecha.startsWith(String(ejercicio)));
  const ventas = delAno.filter((f) => f.tipo === 'venta' && f.operacion === 'interior');
  // Mismo criterio que el 303: los gastos no deducibles no entran, o la suma de
  // los 303 del ano no cuadra con el 390.
  const compras = delAno.filter((f) => f.tipo === 'compra' && f.deducible !== false);

  const resumenDevengado = agruparPorTipoIva(ventas);
  const resumenDeducible = agruparPorTipoIva(compras);
  const totalCuotaDevengada = sumCuota(resumenDevengado);
  const totalCuotaDeducible = sumCuota(resumenDeducible);

  return {
    ejercicio,
    resumenDevengado,
    resumenDeducible,
    totalCuotaDevengada,
    totalCuotaDeducible,
    resultadoAnual: round2(totalCuotaDevengada - totalCuotaDeducible),
    volumenOperaciones: sumBase(resumenDevengado),
  };
}

/** Modelo 347: operaciones con terceros por encima del umbral anual. */
export function agregar347Anterior(
  facturas: FacturaFiscal[],
  ejercicio: number,
  umbral: number = UMBRAL_347,
): DatosModelo347 {
  // Solo operaciones interiores: las intracomunitarias van en el 349 y las
  // exportaciones no se declaran en el 347.
  const delAno = facturas.filter((f) => f.fecha.startsWith(String(ejercicio)) && f.operacion === 'interior');
  const acumulado = new Map<string, OperacionTercero>();

  for (const f of delAno) {
    // El 347 se declara con IVA incluido (antes se sumaba solo la base).
    const base = round2(f.lineas.reduce((a, l) => a + l.base + l.cuota, 0));
    const key = `${f.tipo}:${f.cifnif}`;
    const prev =
      acumulado.get(key) ??
      ({ cifnif: f.cifnif, nombre: f.nombreTercero, tipo: f.tipo === 'venta' ? 'cliente' : 'proveedor', baseAnual: 0 } as OperacionTercero);
    prev.baseAnual = round2(prev.baseAnual + base);
    acumulado.set(key, prev);
  }

  const operaciones = [...acumulado.values()]
    .filter((o) => o.baseAnual > umbral)
    .sort((a, b) => b.baseAnual - a.baseAnual);

  return { ejercicio, umbral, operaciones };
}

/** Modelo 349: operaciones intracomunitarias del periodo. */
export function agregar349Anterior(facturas: FacturaFiscal[], periodo: PeriodoFiscal): DatosModelo349 {
  const intra = facturas.filter(
    (f) => f.operacion === 'intracomunitaria' && enRango(f.fecha, periodo.fechaInicio, periodo.fechaFin),
  );

  const operaciones = intra.map((f) => ({
    cifnif: f.cifnif,
    nombre: f.nombreTercero,
    clave: (f.tipo === 'venta' ? 'E' : 'A') as 'E' | 'A',
    base: round2(f.lineas.reduce((a, l) => a + l.base, 0)),
  }));

  return { periodo, operaciones, totalBase: round2(operaciones.reduce((a, o) => a + o.base, 0)) };
}
