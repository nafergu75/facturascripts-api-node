import type { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { badRequest } from '../utils/http-errors';
import { avisoRetencionAnulada, codigoProvincia, retencionDeclaradaEn, retencionesActividades, retencionesTrabajo } from './nominas/fiscal';
import { normalizarNif } from '../utils/nif';
import { aCentimos, importeTexto } from '../utils/money';
import { obtenerAsientosEjercicio, calcularSaldosPorSubcuenta } from './contabilidadDatos.service';
import {
  DatosModelo111,
  DatosModelo115,
  DatosModelo303,
  DatosModelo347,
  DatosModelo349,
  DatosModelo390,
  DesgloseIva,
  FacturaFiscal,
  FILA_303_POR_TIPO,
  OperacionIntracomunitaria,
  resultadoPagina3_303,
  OperacionTercero,
  PeriodoFiscal,
} from '../domain/impuestos.model';
import { aparicionesConIva, aparicionesRetencionEntre, desgloseRetencionGasto, fechaContableGasto, whereGastosFiscales, whereGastosIva } from '../domain/factura-gasto.model';
import { avisoExcesoRetencion, retencionesPorPerceptor, topeCero } from '../domain/rectificativa-gasto.model';
import { diferenciaSustitucion } from '../domain/rectificativa-venta.model';
import { lineasImportesDe } from './rectificativasVenta.service';
import {
  esPaisEspana,
  esTipoOperacion,
  fechaDevengoVenta,
  importeEnEuros,
  limpiarNif,
  paisDelCliente,
  PAISES_UE,
  paisLegacy,
  REGLA_OPERACION,
  tipoOperacionLegacy,
  type ContextoOperacion,
  type TipoOperacionVenta,
} from '../domain/tipo-operacion.model';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const UMBRAL_347 = 3005.06;
const eur = importeTexto;

// ---------------------------------------------------------------------------
// Helpers de agregacion (logica pura, testeable)
// ---------------------------------------------------------------------------

function enRango(fecha: string, desde: string, hasta: string): boolean {
  return fecha >= desde && fecha <= hasta; // formato yyyy-mm-dd comparable lexicograficamente
}

/** Agrupa las lineas de un conjunto de facturas por tipo de IVA. */
export function agruparPorTipoIva(facturas: FacturaFiscal[]): DesgloseIva[] {
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

/**
 * Compras con solo las lineas que llevan IVA soportado. La parte exenta o no
 * sujeta de una compra (al 0 % y sin cuota: seguros, intereses, tasas...) no
 * es base de cuotas deducibles: no va en [28] del 303 ni en el deducible del
 * 390. (Mismo criterio que la rama de los modelos AEAT.)
 */
const conIvaSoportado = (facturas: FacturaFiscal[]): FacturaFiscal[] =>
  facturas.map((f) => ({ ...f, lineas: f.lineas.filter((l) => l.cuota !== 0 || l.tipoIva > 0) }));

/**
 * Tipo al que se autoliquida una linea de compra intracomunitaria: el de la
 * linea o, si viene sin tipo (el proveedor de la UE no cobra IVA), el 21 %.
 */
export function tipoAutoliquidado(l: { tipoIva: number }): number {
  return l.tipoIva > 0 ? l.tipoIva : 21;
}

/**
 * Cuota autoliquidada de una linea de compra intracomunitaria, en centimos: la
 * de la factura o, si viene sin cuota, la base al tipo de tipoAutoliquidado.
 * Es la UNICA regla: la usan el 303 ([10]/[11], [36]-[39] y [14]/[15]-[40]/[41]
 * de las rectificativas) y el 390, para que el resumen anual cuadre con la suma
 * de los cuatro 303. El redondeo es simetrico (un abono da lo mismo con signo).
 */
export function cuotaAutoliquidadaCentimos(l: { tipoIva: number; base: number; cuota: number }): number {
  const cuota = aCentimos(l.cuota);
  if (cuota !== 0) return cuota;
  const base = aCentimos(l.base);
  return Math.sign(base) * Math.round((Math.abs(base) * tipoAutoliquidado(l)) / 100);
}

/**
 * IVA que autoliquida la empresa en una adquisicion intracomunitaria, por tipo
 * (el de tipoAutoliquidado), para el asiento: la suma de cuotaAutoliquidadaCentimos
 * de las lineas, la misma cifra de [11] y [37] del 303. Solo las lineas sin
 * cuota en la factura: si el proveedor la cobro (facturas antiguas, hoy el alta
 * no lo admite), esa cuota ya va a la 472 y al proveedor y no se autoliquida.
 */
export function autoliquidacionPorTipo(lineas: Array<{ tipoIva: number; baseLine: number; ivaImporte: number }>): Array<{ tipoIva: number; base: number; cuota: number }> {
  const porTipo = new Map<number, { base: number; cuota: number }>();
  for (const l of lineas) {
    if (aCentimos(l.ivaImporte) !== 0 || aCentimos(l.baseLine) === 0) continue;
    const tipo = tipoAutoliquidado(l);
    const t = porTipo.get(tipo) ?? { base: 0, cuota: 0 };
    t.base += aCentimos(l.baseLine);
    t.cuota += cuotaAutoliquidadaCentimos({ tipoIva: l.tipoIva, base: l.baseLine, cuota: 0 });
    porTipo.set(tipo, t);
  }
  return [...porTipo]
    .filter(([, t]) => t.cuota !== 0)
    .map(([tipoIva, t]) => ({ tipoIva, base: t.base / 100, cuota: t.cuota / 100 }));
}

/** Aviso del 303 y del 390 cuando hay compras intracomunitarias sin IVA en la factura (base en centimos). */
export function avisoIntraSinCuota(baseCentimos: number): string {
  return `Hay compras a proveedores de otros países de la UE sin IVA en la factura (base ${eur(baseCentimos / 100)}): la app calcula su IVA al tipo de la línea o, si no lo tiene, al 21 %, lo autoliquida en las casillas [10]/[11] y, si es deducible, lo deduce en [36]/[37]. Si el tipo que corresponde es otro, ponlo en la factura.`;
}

const sumCuota = (d: DesgloseIva[]): number => round2(d.reduce((a, x) => a + x.cuota, 0));
const sumBase = (d: DesgloseIva[]): number => round2(d.reduce((a, x) => a + x.base, 0));
const baseDe = (fs: FacturaFiscal[]): number => round2(fs.reduce((a, f) => a + f.lineas.reduce((x, l) => x + l.base, 0), 0));

// ---------------------------------------------------------------------------
// Tipo de operacion de cada venta en los modelos
//
// Una venta CON tipo de operacion se trata segun la tabla del dominio
// (REGLA_OPERACION). Una venta SIN tipo (anterior a esta funcion) y las
// compras se tratan EXACTAMENTE como siempre, por su `operacion`: asi las
// cifras ya calculadas no cambian.
// ---------------------------------------------------------------------------

const ctxDe = (f: FacturaFiscal): ContextoOperacion => ({
  cliente: { pais: f.paisTercero ?? null, nifCif: f.cifnif },
  causaExencion: f.causaExencion ?? null,
});

const tipoDe = (f: FacturaFiscal): TipoOperacionVenta | null =>
  f.tipo === 'venta' && esTipoOperacion(f.tipoOperacion) ? f.tipoOperacion : null;

/** Venta que devenga IVA en el regimen general: NACIONAL (o, sin tipo, la interior de siempre). */
export function devengaIva(f: FacturaFiscal): boolean {
  if (f.tipo !== 'venta') return false;
  const tipo = tipoDe(f);
  return tipo ? tipo === 'NACIONAL' : f.operacion === 'interior';
}

/**
 * Casilla de informacion adicional del 303 (pagina 3) de una venta: [59]
 * entregas intracomunitarias de bienes y servicios, [60] exportaciones y
 * asimiladas, [120] no sujetas por reglas de localizacion, [122] inversion del
 * sujeto pasivo; null si no va en ninguna.
 */
export function casillaAdicional303(f: FacturaFiscal): '59' | '60' | '120' | '122' | null {
  if (f.tipo !== 'venta') return null;
  const tipo = tipoDe(f);
  if (!tipo) return f.operacion === 'intracomunitaria' ? '59' : f.operacion === 'exportacion' ? '60' : null;
  const c = REGLA_OPERACION[tipo].casilla303(ctxDe(f));
  return c === '59' || c === '60' || c === '120' || c === '122' ? c : null;
}

/** Exenta sin derecho a deduccion (E1/E6): sin casilla trimestral, va al 390 [105] y afecta a la prorrata. */
function exentaSinDeduccion(f: FacturaFiscal): boolean {
  return tipoDe(f) === 'EXENTA' && !['E3', 'E4'].includes(String(f.causaExencion ?? ''));
}

/** Clave del 349 de una factura: E/S en ventas (segun su tipo), A en compras intracomunitarias. */
export function clave349De(f: FacturaFiscal): OperacionIntracomunitaria['clave'] | null {
  if (f.tipo === 'compra') return f.operacion === 'intracomunitaria' ? 'A' : null;
  const tipo = tipoDe(f);
  if (!tipo) return f.operacion === 'intracomunitaria' ? 'E' : null;
  if (f.clave349 !== undefined) return f.clave349;
  return REGLA_OPERACION[tipo].clave349(ctxDe(f));
}

/** Tipos de venta que se declaran en el 347 (con cliente residente en Espana). */
const TIPOS_347: readonly TipoOperacionVenta[] = ['NACIONAL', 'EXENTA', 'ISP_NACIONAL'];

/** La factura entra en el 347: interior (sin tipo, como siempre) o venta con tipo declarable a un residente. */
function entraEn347(f: FacturaFiscal): boolean {
  const tipo = tipoDe(f);
  if (!tipo) return f.operacion === 'interior';
  return f.residente !== false && TIPOS_347.includes(tipo);
}

// ---------------------------------------------------------------------------
// Agregadores por modelo (reciben el array de facturas fiscales)
// ---------------------------------------------------------------------------

/** Filas fijas del regimen general del 303 (base, tipo, cuota): 4 %, 10 % y 21 %. */
const FILAS_DEVENGADO_303: ReadonlyArray<readonly [string, string, string]> = [
  ['01', '02', '03'],
  ['04', '05', '06'],
  ['07', '08', '09'],
];

/**
 * Pares base/cuota sin signo (Num) del 303 y la casilla con signo (N) donde va
 * su importe si sale negativo: el devengado a modificaciones [14]/[15] y el
 * deducible a rectificacion de deducciones [40]/[41].
 */
const PARES_SIN_SIGNO_303: ReadonlyArray<readonly [string, string, string, string]> = [
  ['01', '03', '14', '15'],
  ['04', '06', '14', '15'],
  ['07', '09', '14', '15'],
  ['10', '11', '14', '15'],
  ['12', '13', '14', '15'],
  ['28', '29', '40', '41'],
  ['30', '31', '40', '41'],
  ['32', '33', '40', '41'],
  ['34', '35', '40', '41'],
  ['36', '37', '40', '41'],
  ['38', '39', '40', '41'],
];

/** Casillas que suman en [27] y en [45] (formulas del diseno de la pagina 1). */
const SUMANDOS_27 = ['152', '167', '03', '155', '06', '09', '11', '13', '15', '158', '170', '18', '21', '24', '26'];
const SUMANDOS_45 = ['29', '31', '33', '35', '37', '39', '41', '42', '43', '44'];

/** Nombres de las casillas nuevas en el mapa de casillas de siempre (solo si tienen importe). */
const NOMBRES_CASILLAS_303: Readonly<Record<string, string>> = {
  '10': '10_base_adquisiciones_intracomunitarias',
  '11': '11_cuota_adquisiciones_intracomunitarias',
  '12': '12_base_inversion_sujeto_pasivo',
  '13': '13_cuota_inversion_sujeto_pasivo',
  '14': '14_base_modificaciones',
  '15': '15_cuota_modificaciones',
  '30': '30_base_bienes_inversion',
  '31': '31_cuota_bienes_inversion',
  '32': '32_base_importaciones',
  '33': '33_cuota_importaciones',
  '34': '34_base_importaciones_inversion',
  '35': '35_cuota_importaciones_inversion',
  '36': '36_base_adquisiciones_intracomunitarias',
  '37': '37_cuota_adquisiciones_intracomunitarias',
  '38': '38_base_adquisiciones_intracomunitarias_inversion',
  '39': '39_cuota_adquisiciones_intracomunitarias_inversion',
  '40': '40_base_rectificacion_deducciones',
  '41': '41_cuota_rectificacion_deducciones',
};

/** Opciones del calculo del 303. */
export interface OpcionesAgregar303 {
  /** La autoliquidacion pide la devolucion (tipo D): se aplica todo [110] en [78]. */
  devolucion?: boolean;
}

/**
 * Modelo 303 con las casillas OFICIALES del diseno 2026 (paginas 1 y 3).
 *
 * IVA devengado:
 *  - Ventas NACIONAL (sin tipo, las interiores de siempre): una fila fija por
 *    tipo ([01]-[03] 4 %, [04]-[06] 10 %, [07]-[09] 21 %).
 *  - Ventas rectificativas: modificacion de bases y cuotas [14]/[15], con signo.
 *  - Autodevengo de las compras intracomunitarias [10]/[11] (con la cuota de
 *    cuotaAutoliquidadaCentimos, la misma que usa el 390) y de las compras con
 *    inversion del sujeto pasivo [12]/[13], con la cuota de la factura.
 * IVA deducible (compras deducibles), por naturaleza: interiores corrientes
 * [28]/[29] o bienes de inversion [30]/[31] (lineas de cuentas 2xx),
 * importaciones [32]-[35] (proveedor de fuera de la UE con cuota),
 * intracomunitarias [36]-[39] y rectificacion de deducciones [40]/[41] (las
 * compras anuladas con contraasiento restan aqui, con signo).
 * Resultado: [46] = [27] - [45]; pagina 3: [64] = [46], [66] = [64] (100 %
 * Estado) y [78], [87], [69] y [71] segun resultadoPagina3_303.
 *
 * `cuotasACompensar` = cuotas pendientes de compensar de periodos anteriores
 * [110] (patron Quipu "303 a compensar"). `opciones.devolucion`: la
 * autoliquidacion pide la devolucion (tipo D), y entonces el saldo a devolver
 * incluye todo [110].
 */
export function agregar303(
  facturas: FacturaFiscal[],
  periodo: PeriodoFiscal,
  cuotasACompensar = 0,
  opciones: OpcionesAgregar303 = {},
): DatosModelo303 {
  // Las compras rectificativas ERROR_IVA que reducen cuentan en el periodo de su original (fechaIva).
  const delPeriodo = facturas.filter((f) => enRango(f.fechaIva ?? f.fecha, periodo.fechaInicio, periodo.fechaFin));

  const ventasDevengo = delPeriodo.filter(devengaIva);
  // Solo gastos DEDUCIBLES (deducible===false los excluye; por defecto deducible)
  const comprasDeducibles = delPeriodo.filter((f) => f.tipo === 'compra' && f.deducible !== false);
  // Informacion adicional pag.3: una casilla por tipo de operacion.
  const deCasilla = (c: '59' | '60' | '120' | '122') => baseDe(delPeriodo.filter((f) => casillaAdicional303(f) === c));
  const entregasIntracomunitarias = deCasilla('59');
  const exportaciones = deCasilla('60');
  const noSujetasLocalizacion = deCasilla('120');
  const inversionSujetoPasivo = deCasilla('122');
  const exentasSinDeduccion = baseDe(delPeriodo.filter(exentaSinDeduccion));

  const ivaDevengado = agruparPorTipoIva(ventasDevengo);
  const ivaDeducible = agruparPorTipoIva(conIvaSoportado(comprasDeducibles));

  // --- Casillas oficiales, en centimos ---
  const c: Record<string, number> = {};
  const suma = (casilla: string, euros: number) => {
    c[casilla] = (c[casilla] ?? 0) + Math.round(euros * 100);
  };
  const v = (casilla: string) => c[casilla] ?? 0;
  const advertencias: string[] = [];
  const sinFila = new Map<number, { base: number; cuota: number }>();
  let intraSinCuota = 0;

  for (const f of ventasDevengo) {
    const lineas = f.lineas;
    if (f.rectificativa) {
      for (const l of lineas) {
        suma('14', l.base);
        suma('15', l.cuota);
      }
      continue;
    }
    for (const l of lineas) {
      const fila = FILA_303_POR_TIPO[l.tipoIva];
      if (fila !== undefined) {
        suma(FILAS_DEVENGADO_303[fila][0], l.base);
        suma(FILAS_DEVENGADO_303[fila][2], l.cuota);
      } else if (l.tipoIva !== 0 && (l.base !== 0 || l.cuota !== 0)) {
        // Al 0 % (exentas o no sujetas) no hay cuota: no van en estas filas.
        const prev = sinFila.get(l.tipoIva) ?? { base: 0, cuota: 0 };
        sinFila.set(l.tipoIva, { base: round2(prev.base + l.base), cuota: round2(prev.cuota + l.cuota) });
      }
    }
  }

  for (const f of delPeriodo) {
    if (f.tipo !== 'compra') continue;
    const deducible = f.deducible !== false;
    for (const l of f.lineas) {
      const conCuota = l.cuota !== 0 || l.tipoIva > 0;
      // Intracomunitaria: la cuota autoliquidada (la de la factura o, sin ella, al tipo de la linea o al 21 %).
      const intra = f.operacion === 'intracomunitaria';
      const cuota = intra ? cuotaAutoliquidadaCentimos(l) / 100 : l.cuota;
      if (intra || f.isp) {
        // Autodevengo: la cuota la declara la empresa (como devengada y, si es deducible, como deducible).
        const [b, q] = f.rectificativa ? ['14', '15'] : intra ? ['10', '11'] : ['12', '13'];
        suma(b, l.base);
        suma(q, cuota);
        if (intra && aCentimos(l.cuota) === 0) intraSinCuota += aCentimos(l.base);
      }
      if (!deducible) continue;
      let par: [string, string] | null;
      if (f.rectificativa) par = ['40', '41'];
      else if (f.operacion === 'intracomunitaria') par = l.inversion ? ['38', '39'] : ['36', '37'];
      else if (f.isp) par = l.inversion ? ['30', '31'] : ['28', '29'];
      else if (f.operacion === 'exportacion') par = l.cuota !== 0 ? (l.inversion ? ['34', '35'] : ['32', '33']) : null;
      else par = conCuota ? (l.inversion ? ['30', '31'] : ['28', '29']) : null;
      if (!par) continue;
      suma(par[0], l.base);
      suma(par[1], cuota);
    }
  }

  // Ninguna casilla sin signo puede salir negativa: lo que queda en negativo
  // (descuentos o devoluciones que superan lo del periodo) es una modificacion.
  for (const [b, q, bN, qN] of PARES_SIN_SIGNO_303) {
    if (v(b) < 0 || v(q) < 0) {
      c[bN] = v(bN) + v(b);
      c[qN] = v(qN) + v(q);
      c[b] = 0;
      c[q] = 0;
    }
  }

  c['27'] = SUMANDOS_27.reduce((a, k) => a + v(k), 0);
  c['45'] = SUMANDOS_45.reduce((a, k) => a + v(k), 0);
  c['46'] = v('27') - v('45');
  // Pagina 3
  suma('59', entregasIntracomunitarias);
  suma('60', exportaciones);
  suma('120', noSujetasLocalizacion);
  suma('122', inversionSujetoPasivo);
  c['64'] = v('46'); // [46] + [58] (simplificado, 0) + [76] (0)
  c['65'] = 10000; // 100,00 % atribuible a la Administracion del Estado
  c['66'] = v('64');
  c['110'] = Math.round(Math.abs(cuotasACompensar) * 100);
  Object.assign(c, resultadoPagina3_303(c, opciones.devolucion === true));

  const casillasOficiales: Record<string, number> = {};
  for (const [k, centimos] of Object.entries(c)) casillasOficiales[k] = centimos / 100;
  const e = (k: string) => casillasOficiales[k] ?? 0;

  const totalCuotaDevengada = e('27');
  const totalCuotaDeducible = e('45');
  const resultado = e('46');
  const pendientesAnteriores = e('110');
  const cuotasAplicadas = e('78');
  const cuotasPendientesPosteriores = e('87');
  const resultadoFinal = e('71');

  for (const [tipo, d] of sinFila) {
    advertencias.push(
      `Hay ventas al ${tipo} % (base ${importeTexto(d.base)}, cuota ${importeTexto(d.cuota)}): ese tipo no tiene fila en el régimen general del 303. Revísalas antes de presentar.`,
    );
  }
  if (exentasSinDeduccion !== 0) {
    advertencias.push(
      `Hay ventas exentas sin derecho a deducción (base ${eur(exentasSinDeduccion)}): no van en ninguna casilla del 303 trimestral (sí en el 390) y pueden obligarte a aplicar la prorrata del IVA soportado. Revísalo con tu asesor.`,
    );
  }
  if (intraSinCuota !== 0) advertencias.push(avisoIntraSinCuota(intraSinCuota));

  // Mapa de casillas de siempre (pantalla de Impuestos, Carmen), con los
  // importes oficiales. Las casillas nuevas solo si tienen importe.
  const casillas: Record<string, number> = {};
  FILAS_DEVENGADO_303.forEach(([cBase, cTipo, cCuota], i) => {
    if (!v(cBase) && !v(cCuota)) return;
    const tipo = [4, 10, 21][i];
    casillas[`${cBase}_base_devengada_${tipo}`] = e(cBase);
    casillas[`${cTipo}_tipo`] = tipo;
    casillas[`${cCuota}_cuota_devengada_${tipo}`] = e(cCuota);
  });
  for (const [k, nombre] of Object.entries(NOMBRES_CASILLAS_303)) if (v(k) !== 0) casillas[nombre] = e(k);
  Object.assign(casillas, {
    '27_total_devengado': totalCuotaDevengada,
    '28_base_deducible': e('28'),
    '29_cuota_deducible': e('29'),
    '45_total_deducir': totalCuotaDeducible,
    '46_resultado_regimen_general': resultado,
    '110_cuotas_pendientes_anteriores': pendientesAnteriores,
    '78_cuotas_a_compensar': cuotasAplicadas,
    '87_pendientes_periodos_posteriores': cuotasPendientesPosteriores,
    '71_resultado': resultadoFinal,
  });
  // Casillas nuevas de la pagina 3 solo si hay importe (las facturas anteriores no las tienen).
  if (noSujetasLocalizacion !== 0) casillas['120_no_sujetas_localizacion'] = noSujetasLocalizacion;
  if (inversionSujetoPasivo !== 0) casillas['122_inversion_sujeto_pasivo'] = inversionSujetoPasivo;

  // Sin actividad: ninguna factura en el periodo (lo pendiente de compensar no cuenta).
  const sinActividad = delPeriodo.length === 0;

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
    ...(noSujetasLocalizacion !== 0 && { noSujetasLocalizacion }),
    ...(inversionSujetoPasivo !== 0 && { inversionSujetoPasivo }),
    ...(exentasSinDeduccion !== 0 && { exentasSinDeduccion }),
    casillas,
    casillasOficiales,
    sinActividad,
    ...(advertencias.length && { advertencias }),
  };
}

/**
 * Modelo 390: resumen anual de IVA. El devengado, el deducible, el resultado y
 * [99] se calculan como siempre (las ventas NACIONAL o, sin tipo, las
 * interiores). El volumen por grupos ([103], [104], [105], [110], [125]) sale de
 * las ventas con tipo de operacion; las anteriores sin tipo solo cuentan en
 * [99], para no cambiar cifras ya calculadas, y se avisa si hay alguna fuera.
 */
export function agregar390(facturas: FacturaFiscal[], ejercicio: number): DatosModelo390 {
  const delAno = facturas.filter((f) => (f.fechaIva ?? f.fecha).startsWith(String(ejercicio)));
  const ventas = delAno.filter(devengaIva);
  // Mismo criterio que el 303: los gastos no deducibles no entran, o la suma de
  // los 303 del ano no cuadra con el 390.
  const compras = delAno.filter((f) => f.tipo === 'compra' && f.deducible !== false);

  const resumenDevengado = agruparPorTipoIva(ventas);
  const resumenDeducible = agruparPorTipoIva(conIvaSoportado(compras));
  const totalCuotaDevengada = sumCuota(resumenDevengado);
  const totalCuotaDeducible = sumCuota(resumenDeducible);
  const volumenOperaciones = sumBase(resumenDevengado);

  const conTipo = delAno.filter((f) => tipoDe(f) !== null);
  const deCasilla = (c: '59' | '60' | '120' | '122') => baseDe(conTipo.filter((f) => casillaAdicional303(f) === c));
  const volumen = {
    regimenGeneral: volumenOperaciones,
    intracomunitarias: deCasilla('59'),
    exportacionesYExentasConDeduccion: deCasilla('60'),
    exentasSinDeduccion: baseDe(conTipo.filter(exentaSinDeduccion)),
    noSujetas: deCasilla('120'),
    isp: deCasilla('122'),
    total: 0,
  };
  volumen.total = round2(
    volumen.regimenGeneral +
      volumen.intracomunitarias +
      volumen.exportacionesYExentasConDeduccion +
      volumen.exentasSinDeduccion +
      volumen.noSujetas +
      volumen.isp,
  );

  const advertencias: string[] = [];
  const anteriores = (op: FacturaFiscal['operacion']) =>
    baseDe(delAno.filter((f) => f.tipo === 'venta' && tipoDe(f) === null && f.operacion === op));
  const intraAnteriores = anteriores('intracomunitaria');
  const exportAnteriores = anteriores('exportacion');
  if (intraAnteriores !== 0 || exportAnteriores !== 0) {
    advertencias.push(
      `Hay ventas anteriores sin tipo de operación clasificadas como intracomunitarias (${eur(intraAnteriores)}) o exportaciones (${eur(exportAnteriores)}): no se suman en las casillas [103] y [104] ni en el total [108]. Añádelas a mano si procede.`,
    );
  }
  if (volumen.exentasSinDeduccion !== 0) {
    advertencias.push(
      `Hay ventas exentas sin derecho a deducción (${eur(volumen.exentasSinDeduccion)}, casilla [105]): comprueba si te toca aplicar la prorrata.`,
    );
  }

  return {
    ejercicio,
    resumenDevengado,
    resumenDeducible,
    totalCuotaDevengada,
    totalCuotaDeducible,
    resultadoAnual: round2(totalCuotaDevengada - totalCuotaDeducible),
    volumenOperaciones,
    volumen,
    ...(advertencias.length && { advertencias }),
  };
}

/**
 * Modelo 347: operaciones con terceros por encima del umbral anual. Solo
 * operaciones interiores con residentes: las intracomunitarias van en el 349 y
 * las exportaciones, los servicios a extranjeros y los clientes no residentes
 * no se declaran. Importes en euros (columnas de cuenta), tambien si la
 * factura se emitio en otra moneda.
 */
export function agregar347(
  facturas: FacturaFiscal[],
  ejercicio: number,
  umbral: number = UMBRAL_347,
): DatosModelo347 {
  const delAno = facturas.filter((f) => f.fecha.startsWith(String(ejercicio)) && entraEn347(f));
  // Todo en centimos: los cuatro trimestres tienen que sumar el anual exacto.
  interface Acum {
    op: OperacionTercero;
    trim: [number, number, number, number];
    contado: number;
  }
  const acumulado = new Map<string, Acum>();
  const totalTercero = new Map<string, number>();
  const cent = aCentimos;

  for (const f of delAno) {
    // Las compras con retencion de IRPF no van al 347: ya estan en el 190 o en
    // el 180 (art. 33.2 del RD 1065/2007). Solo cuentan sus lineas sin retencion.
    const lineas = f.lineas.filter((l) => !l.conRetencion);
    if (!lineas.length) continue;
    // Compras con inversion del sujeto pasivo: registro aparte ('X' en la
    // posicion 282 del 347). El proveedor no repercute IVA (la cuota la
    // autoliquida la empresa), asi que va la base.
    const isp = f.tipo === 'compra' && f.isp === true;
    // El 347 se declara con IVA incluido (antes se sumaba solo la base).
    const importe = lineas.reduce((a, l) => a + cent(l.base) + (isp ? 0 : cent(l.cuota)), 0);
    const nif = limpiarNif(f.cifnif);
    const tipo: OperacionTercero['tipo'] = f.tipo === 'venta' ? 'cliente' : 'proveedor';
    // El arrendamiento de local de negocio va en un registro aparte con 'X' (art. 34.1 RD 1065/2007).
    const arrendamiento = f.tipo === 'compra' && f.tipoGasto === 'ALQUILER';
    const key = `${tipo}:${nif}:${arrendamiento ? 'X' : ''}:${isp ? 'I' : ''}`;
    const a =
      acumulado.get(key) ??
      ({
        op: {
          cifnif: nif,
          nombre: f.nombreTercero,
          tipo,
          baseAnual: 0,
          provincia: codigoProvincia(f.cpTercero, f.provinciaTercero),
          ...(arrendamiento && { arrendamiento: true }),
          ...(isp && { inversionSujetoPasivo: true }),
        },
        trim: [0, 0, 0, 0],
        contado: 0,
      } as Acum);
    const t = Math.min(3, Math.floor((Number(f.fecha.slice(5, 7)) - 1) / 3));
    a.trim[t] += importe;
    if (f.tipo === 'venta' && f.formaPago === 'CONTADO') a.contado += importe;
    acumulado.set(key, a);
    totalTercero.set(`${tipo}:${nif}`, (totalTercero.get(`${tipo}:${nif}`) ?? 0) + importe);
  }

  const advertencias: string[] = [];
  const operaciones: OperacionTercero[] = [];
  for (const a of acumulado.values()) {
    // El umbral se mira con todo lo del tercero en el ano, en valor absoluto (un
    // tercero con mas abonos que compras tambien se declara, con signo); si lo
    // supera, se declaran todos sus registros.
    if (Math.abs(totalTercero.get(`${a.op.tipo}:${a.op.cifnif}`) ?? 0) <= cent(umbral)) continue;
    const anual = a.trim.reduce((x, y) => x + y, 0);
    const op: OperacionTercero = { ...a.op, baseAnual: anual / 100, trimestres: a.trim.map((c) => c / 100) as OperacionTercero['trimestres'] };
    if (a.contado > cent(6000)) {
      op.metalico = a.contado / 100;
      advertencias.push(
        `${op.nombre} (${op.cifnif}): ${eur(op.metalico)} en facturas con forma de pago al contado. Si se cobraron en efectivo, van en "importe percibido en metálico"; si no, quítalo antes de presentar.`,
      );
    }
    if (!op.provincia) advertencias.push(`${op.nombre} (${op.cifnif}): falta la provincia de su domicilio fiscal (código postal en su ficha).`);
    operaciones.push(op);
  }
  operaciones.sort((x, y) => y.baseAnual - x.baseAnual);

  return { ejercicio, umbral, operaciones, ...(advertencias.length && { advertencias }) };
}

/**
 * Modelo 349: operaciones intracomunitarias del periodo, una por operador y
 * clave (E entregas de bienes, S prestaciones de servicios, A adquisiciones),
 * con el importe neto del periodo: las rectificativas del periodo restan. Un
 * operador que queda en negativo se avisa (las rectificaciones de periodos
 * anteriores no se modelan) y uno que queda a cero no se declara.
 */
export function agregar349(facturas: FacturaFiscal[], periodo: PeriodoFiscal): DatosModelo349 {
  const porOperador = new Map<string, OperacionIntracomunitaria>();
  for (const f of facturas) {
    if (!enRango(f.fecha, periodo.fechaInicio, periodo.fechaFin)) continue;
    const clave = clave349De(f);
    if (!clave) continue;
    const key = `${limpiarNif(f.cifnif)}|${clave}`;
    const prev = porOperador.get(key) ?? { cifnif: f.cifnif, nombre: f.nombreTercero, clave, base: 0 };
    prev.base = round2(prev.base + f.lineas.reduce((a, l) => a + l.base, 0));
    porOperador.set(key, prev);
  }

  const operaciones = [...porOperador.values()].filter((o) => o.base !== 0);
  const advertencias = operaciones
    .filter((o) => o.base < 0)
    .map(
      (o) =>
        `${o.nombre} (${o.cifnif}, clave ${o.clave}) queda en negativo en el periodo (${eur(o.base)}): una rectificación de un periodo anterior se declara como rectificación de ese periodo. Revísalo antes de presentar.`,
    );
  return {
    periodo,
    operaciones,
    totalBase: round2(operaciones.reduce((a, o) => a + o.base, 0)),
    ...(advertencias.length && { advertencias }),
  };
}

// ---------------------------------------------------------------------------
// Wrappers async: obtienen las facturas de la BD propia (Prisma) y agregan.
// Migrado de FacturaScripts a Prisma en ADR-002 Paso 3 (camino de facturas),
// para que los modelos de IVA (303/390/347/349) funcionen sin FacturaScripts.
// ---------------------------------------------------------------------------

/** True si Prisma está disponible (no mockeado como {} en tests). */
function dbFacturasListo(): boolean {
  return typeof (prisma as { incomeInvoice?: { findMany?: unknown } })?.incomeInvoice?.findMany === 'function';
}

/**
 * Clasifica una COMPRA por el pais del proveedor (codpais de su ficha) y, si no
 * hay pais, por el prefijo del NIF-IVA (DE..., FR...). Es EXACTAMENTE la
 * clasificacion de siempre, con la tabla en ISO-3 (la de FacturaScripts): un
 * pais guardado en ISO-2 distinto de ES ('DE') sale como exportacion y no va al
 * 349. Se mantiene a proposito: las compras (gastos) en divisa y su tipo de
 * operacion estan fuera de alcance, y entender ISO-2 aqui metia en el 349 de
 * periodos ya presentados compras que antes no salian (y siempre con clave A,
 * tambien las de servicios, que van con clave I).
 */
export function clasificarOperacion(codpais?: string, cifnif?: string): 'interior' | 'intracomunitaria' | 'exportacion' {
  const pais = (codpais ?? '').trim().toUpperCase();
  if (pais === 'ESP' || pais === 'ES') return 'interior';
  if (pais) return COMPRAS_UE_ISO3.has(pais) ? 'intracomunitaria' : 'exportacion';
  const pref = (cifnif ?? '').trim().slice(0, 2).toUpperCase();
  if (COMPRAS_PREFIJOS_UE.has(pref)) return 'intracomunitaria';
  return 'interior';
}

/**
 * Desde este dia las compras se clasifican como en el 349: por el pais ISO-2 de
 * la ficha del proveedor (las fichas nuevas lo guardan asi) o, sin pais, por el
 * prefijo de su NIF-IVA. Antes, la clasificacion de siempre (clasificarOperacion),
 * para no cambiar periodos ya presentados.
 */
export const INICIO_COMPRAS_ISO2 = '2027-01-01';

/** Operacion de una compra en su fecha contable: la misma para el 303, el 390, el 347 y el 349. */
export function clasificarCompra(fecha: string, codpais?: string | null, cifnif?: string | null): 'interior' | 'intracomunitaria' | 'exportacion' {
  if (fecha < INICIO_COMPRAS_ISO2) return clasificarOperacion(codpais ?? undefined, cifnif ?? undefined);
  const pais = paisDelCliente({ pais: codpais, nifCif: cifnif ?? '' });
  if (pais === 'ES') return 'interior';
  return PAISES_UE.has(pais) ? 'intracomunitaria' : 'exportacion';
}

// Las tablas de siempre de clasificarOperacion (copiadas tal cual): paises UE en
// ISO-3 sin ESP y prefijos de NIF-IVA ('EL' = Grecia, 'XI' = Irlanda del Norte).
const COMPRAS_UE_ISO3 = new Set([
  'DEU', 'FRA', 'ITA', 'PRT', 'BEL', 'NLD', 'LUX', 'IRL', 'AUT', 'FIN', 'SWE', 'DNK', 'GRC',
  'POL', 'CZE', 'SVK', 'SVN', 'HUN', 'ROU', 'BGR', 'HRV', 'EST', 'LVA', 'LTU', 'CYP', 'MLT',
]);
const COMPRAS_PREFIJOS_UE = new Set([
  'DE', 'FR', 'IT', 'PT', 'BE', 'NL', 'LU', 'IE', 'AT', 'FI', 'SE', 'DK', 'EL', 'PL', 'CZ',
  'SK', 'SI', 'HU', 'RO', 'BG', 'HR', 'EE', 'LV', 'LT', 'CY', 'MT', 'XI',
]);

/**
 * Ventas que PUEDEN devengarse entre `desde` y `hasta` (filtro amplio para la
 * BD): emitidas en el periodo o con fecha de operacion desde dos meses antes
 * (una entrega intracomunitaria se devenga, como tarde, el dia 15 del mes
 * siguiente a la operacion). Las que salen se filtran despues con
 * `fechaDevengoVenta`. Las facturas anteriores no tienen fecha de operacion:
 * quedan las emitidas en el periodo, como siempre.
 */
export function ventasQuePuedenDevengarseEntre(desde: string, hasta: string): Prisma.IncomeInvoiceWhereInput {
  const d = new Date(`${desde}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 2);
  return {
    OR: [{ fechaEmision: { gte: desde, lte: hasta } }, { fechaOperacion: { gte: d.toISOString().slice(0, 10), lte: hasta } }],
  };
}

const OPERACION_DE_TIPO: Readonly<Record<'NACIONAL' | 'INTRACOMUNITARIA' | 'EXPORTACION', FacturaFiscal['operacion']>> = {
  NACIONAL: 'interior',
  INTRACOMUNITARIA: 'intracomunitaria',
  EXPORTACION: 'exportacion',
};

/** `operacion` informativa de una venta con tipo (los agregadores usan el tipo). */
function operacionDeTipo(tipo: TipoOperacionVenta, ctx: ContextoOperacion): FacturaFiscal['operacion'] {
  if (tipo === 'INTRACOMUNITARIA') return 'intracomunitaria';
  if (tipo === 'EXPORTACION') return 'exportacion';
  if (tipo === 'SERVICIOS_EXTRANJERO') return REGLA_OPERACION[tipo].clave349(ctx) === 'S' ? 'intracomunitaria' : 'exportacion';
  return 'interior';
}

/**
 * Facturas fiscales con IVA desglosado por tipo, leídas de la BD propia (Prisma).
 * Ventas = `IncomeInvoice`, compras = `ExpenseInvoice`; se excluyen los borradores
 * (estado DRAFT). El IVA por línea sale de `tipoIva`/`baseLine`/`ivaImporte`; si
 * una factura no tiene líneas, se usa el total de cabecera.
 *
 * Importes SIEMPRE de las columnas de cuenta (euros en una empresa espanola),
 * tambien en las facturas emitidas en otra moneda. Las ventas de una empresa no
 * establecida en Espana (EMPRESA_EXTRANJERA) no entran en ningun modelo.
 * Las ventas con tipo de operacion llevan su tipo; las anteriores (sin tipo),
 * la clasificacion de siempre por pais o prefijo del NIF.
 */
/**
 * Original de la app de cada rectificativa por sustitucion (por sus enlaces o
 * por facturaOriginalId), con sus lineas. Importes de cuenta: los mismos que
 * lee el modelo.
 */
export async function originalesDeSustituciones(
  companyId: string,
  ventas: Array<{ id: string; esRectificativa: boolean; tipoRectificativa: string | null; facturaOriginalId: string | null }>,
) {
  const sust = ventas.filter((f) => f.esRectificativa && f.tipoRectificativa === 'S');
  const out = new Map<string, { lineas: Array<{ tipoIva: number; accountCode: string | null; baseLine: number; ivaImporte: number; retencionImporte: number }> }>();
  if (!sust.length) return out;
  // Con una BD simulada (tests sin MySQL) puede no estar la tabla de enlaces: queda facturaOriginalId.
  const tabla = (prisma as unknown as { incomeInvoiceRectificada?: { findMany?: unknown } }).incomeInvoiceRectificada;
  const enlaces =
    typeof tabla?.findMany === 'function'
      ? await prisma.incomeInvoiceRectificada.findMany({
          where: { companyId, rectificativaId: { in: sust.map((f) => f.id) }, originalId: { not: null } },
          select: { rectificativaId: true, originalId: true },
        })
      : [];
  const deCada = new Map(sust.map((f) => [f.id, enlaces.find((e) => e.rectificativaId === f.id)?.originalId ?? f.facturaOriginalId]));
  const ids = [...new Set([...deCada.values()].filter((x): x is string => !!x))];
  if (!ids.length) return out;
  const originales = await prisma.incomeInvoice.findMany({ where: { companyId, id: { in: ids } }, include: { lineas: true } });
  for (const [sId, oId] of deCada) {
    const o = originales.find((x) => x.id === oId);
    if (o) out.set(sId, o);
  }
  return out;
}

export async function obtenerFacturasFiscales(companyId: string, desde: string, hasta: string): Promise<FacturaFiscal[]> {
  if (!dbFacturasListo()) return [];
  const out: FacturaFiscal[] = [];

  const [ventas, compras] = await Promise.all([
    prisma.incomeInvoice.findMany({
      // Solo facturas emitidas: un borrador no es una venta todavía. Por fecha de devengo.
      where: { companyId, estadoDocumento: 'FINAL', estado: { not: 'DRAFT' }, ...ventasQuePuedenDevengarseEntre(desde, hasta) },
      include: { customer: true, lineas: true },
    }),
    // Compras: criterio unico de domain/factura-gasto.model (sin borradores del
    // lector ni anuladas; una anulada con contraasiento resta en su periodo).
    prisma.expenseInvoice.findMany({
      where: whereGastosIva(companyId, desde, hasta),
      include: { supplier: true, lineas: true },
    }),
  ]);

  // Rectificativas por sustitucion con la original en la app: cuenta la
  // diferencia con la original, por tipo de IVA (la S lleva la factura
  // corregida entera; antes se sumaba entera y el IVA contaba dos veces).
  const originalesDeS = await originalesDeSustituciones(companyId, ventas);

  for (const f of ventas) {
    // El IVA va en el periodo del devengo (art. 75 LIVA), aunque la factura se emita despues.
    const devengo = fechaDevengoVenta(f);
    // Una rectificativa con fecha de la operacion (la R4 que sube el IVA, que va al
    // 303 del periodo de la original): el 347 y el 349 la llevan al periodo en que
    // se rectifica, el de su emision (`fecha`); el 303 y el 390, a su devengo (`fechaIva`).
    const fecha = f.esRectificativa && f.fechaOperacion ? f.fechaEmision : devengo;
    if (!enRango(devengo, desde, hasta) && !enRango(fecha, desde, hasta)) continue;
    const tipo = esTipoOperacion(f.tipoOperacion) ? f.tipoOperacion : null;
    if (tipo && !REGLA_OPERACION[tipo].enModelos) continue; // empresa extranjera: sin modelos
    // Sin tipo (anteriores): el pais congelado en la factura, si se cambio la ficha despues.
    const pais = tipo ? f.customer?.pais : paisLegacy(f, { pais: f.customer?.pais });
    const nif = f.customer?.nifCif ?? '';
    const cliente = { pais, nifCif: nif, cp: f.customer?.cp };
    const ctx: ContextoOperacion = { cliente, causaExencion: f.causaExencion };
    const euros = (n: number) => round2(importeEnEuros(f, n));
    out.push({
      idFactura: f.numeroCompleto ?? f.id,
      tipo: 'venta',
      cifnif: nif,
      nombreTercero: f.customer?.nombreFiscal ?? '',
      fecha,
      ...(fecha !== devengo && { fechaIva: devengo }),
      operacion: tipo ? operacionDeTipo(tipo, ctx) : OPERACION_DE_TIPO[tipoOperacionLegacy(pais, nif) as keyof typeof OPERACION_DE_TIPO],
      // Datos del 347 (provincia y cobros al contado): solo si los hay.
      ...(f.customer?.cp && { cpTercero: f.customer.cp }),
      ...(f.customer?.provincia && { provinciaTercero: f.customer.provincia }),
      ...(f.formaPago === 'CONTADO' && { formaPago: 'CONTADO' }),
      // Solo las ventas con tipo llevan los campos nuevos: las anteriores salen igual que siempre.
      ...(tipo && {
        tipoOperacion: tipo,
        causaExencion: f.causaExencion,
        clave349: REGLA_OPERACION[tipo].clave349(ctx),
        residente: paisDelCliente(cliente) === 'ES',
        paisTercero: paisDelCliente(cliente),
      }),
      // Una rectificativa va en las casillas de modificaciones del 303 ([14]/[15]);
      // la del concurso del cliente (R2), en el 390 aparte ([31]/[32]).
      ...(f.esRectificativa && { rectificativa: true }),
      ...(f.esRectificativa && f.tipoFactura === 'R2' && { concurso: true }),
      lineas: originalesDeS.has(f.id)
        ? diferenciaSustitucion(lineasImportesDe(f), lineasImportesDe(originalesDeS.get(f.id)!)).porTipoIva.map((t) => ({ tipoIva: t.tipoIva, base: t.base, cuota: t.cuota }))
        : f.lineas.length
          ? f.lineas.map((l) => ({ tipoIva: l.tipoIva, base: euros(l.baseLine), cuota: euros(l.ivaImporte) }))
          : [{ tipoIva: 0, base: euros(f.baseTotal), cuota: 0 }],
    });
  }

  for (const f of compras) {
    // Una aparicion por periodo: la factura en su fecha contable y, si se anulo
    // con contraasiento, en negativo en la fecha de la anulacion. Una
    // rectificativa ERROR_IVA que reduce lleva ademas la fecha de su IVA
    // (fechaIva, el periodo de la original): sale si cualquiera de las dos cae en el rango.
    const enRangoAp = (x: string) => x >= desde && x <= hasta;
    for (const { fecha: contable, fechaIva, signo } of aparicionesConIva(f)) {
      // Una compra (no rectificativa) con fecha de IVA propia es una intracomunitaria cuyo IVA
      // se devengo en un periodo de la gestoria: todo (303, 390, 349 y 347) va a esa fecha.
      const fecha = !f.esRectificativa && signo > 0 && f.fechaImputacionIva ? fechaIva : contable;
      if (!enRangoAp(fecha) && !enRangoAp(fechaIva)) continue;
      out.push({
        idFactura: f.numeroFacturaProveedor ?? f.numeroCompleto,
        tipo: 'compra',
        cifnif: f.supplier?.nifCif ?? '',
        nombreTercero: f.supplier?.nombreFiscal ?? '',
        fecha,
        ...(fechaIva !== fecha && { fechaIva }),
        operacion: clasificarCompra(contable, f.supplier?.pais, f.supplier?.nifCif),
        // La anulacion (en negativo) y los abonos y rectificativas de proveedor
        // van en la rectificacion de deducciones ([40]/[41]); una ERROR_IVA que
        // reduce, no: netea en las casillas de su periodo (seccion 10.1).
        ...((signo < 0 || (f.esRectificativa && !f.fechaImputacionIva)) && { rectificativa: true }),
        ...(f.supplier?.cp && { cpTercero: f.supplier.cp }),
        ...(f.supplier?.provincia && { provinciaTercero: f.supplier.provincia }),
        ...(f.tipoGasto && f.tipoGasto !== 'COMPRA' && { tipoGasto: f.tipoGasto }),
        lineas: f.lineas.length
          ? f.lineas.map((l) => ({
              tipoIva: l.tipoIva,
              base: signo * round2(l.baseLine),
              cuota: signo * round2(l.ivaImporte),
              ...(Number(l.tipoRetencion) > 0 ? { conRetencion: true } : {}),
              // Bien de inversion: cuenta 2xx del PGC (casillas de bienes de inversion del 303).
              ...(String(l.accountCode ?? '').startsWith('2') ? { inversion: true } : {}),
            }))
          : [{ tipoIva: 0, base: signo * round2(f.baseTotal), cuota: 0, ...(aCentimos(Number(f.retencionTotal)) !== 0 ? { conRetencion: true } : {}) }],
      });
    }
  }

  return out;
}

/**
 * ¿La empresa esta establecida en Espana? Sin configuracion legal (o sin BD
 * en los tests), si. Lee solo el pais de LegalConfig.
 */
export async function esEmpresaEspanolaFiscal(companyId: string): Promise<boolean> {
  const legal = (prisma as { legalConfig?: { findUnique?: unknown } })?.legalConfig;
  if (typeof legal?.findUnique !== 'function') return true;
  const cfg = await prisma.legalConfig.findUnique({ where: { companyId }, select: { pais: true } }).catch(() => null);
  return esPaisEspana(cfg?.pais ?? 'ES');
}

export const MENSAJE_SIN_MODELOS = 'La empresa no está establecida en España: no presenta modelos de la AEAT.';

/**
 * Una empresa no establecida en Espana no presenta modelos de la AEAT (400).
 * Si antes lo estuvo, sigue pudiendo calcular los periodos con ventas
 * espanolas (las emitidas cuando era espanola).
 */
export async function exigirModelosAeat(companyId: string, desde: string, hasta: string): Promise<void> {
  if (await esEmpresaEspanolaFiscal(companyId)) return;
  const candidatas = dbFacturasListo()
    ? await prisma.incomeInvoice.findMany({
        where: {
          companyId,
          estadoDocumento: 'FINAL',
          AND: [ventasQuePuedenDevengarseEntre(desde, hasta), { OR: [{ tipoOperacion: null }, { tipoOperacion: { not: 'EMPRESA_EXTRANJERA' } }] }],
        },
        select: { tipoOperacion: true, fechaOperacion: true, fechaEmision: true },
      })
    : [];
  if (!candidatas.some((f) => enRango(fechaDevengoVenta(f), desde, hasta))) throw badRequest(MENSAJE_SIN_MODELOS);
}

/**
 * Hallazgo 1 (recomendado) — IVA devengado/soportado a partir de los SALDOS de
 * las subcuentas 477xxx (repercutido) y 472xxx (soportado) de los asientos, para
 * que el 303/390 cuadre con la contabilidad. Disponible para una iteracion
 * futura del calculo del 303/390. TODO: mapear saldo por subcuenta a casillas.
 */
export async function obtenerIvaDevengadoDesdeAsientos(companyId: string, ejercicio: number): Promise<number> {
  const saldos = calcularSaldosPorSubcuenta(await obtenerAsientosEjercicio(companyId, ejercicio));
  let total = 0;
  for (const s of saldos.values()) if (s.subcuenta.startsWith('477')) total = round2(total + (s.haber - s.debe));
  return total;
}

export async function obtenerIvaSoportadoDesdeAsientos(companyId: string, ejercicio: number): Promise<number> {
  const saldos = calcularSaldosPorSubcuenta(await obtenerAsientosEjercicio(companyId, ejercicio));
  let total = 0;
  for (const s of saldos.values()) if (s.subcuenta.startsWith('472')) total = round2(total + (s.debe - s.haber));
  return total;
}

export async function calcularModelo303(
  companyId: string,
  periodo: PeriodoFiscal,
  cuotasACompensar = 0,
  opciones: OpcionesAgregar303 = {},
): Promise<DatosModelo303> {
  await exigirModelosAeat(companyId, periodo.fechaInicio, periodo.fechaFin);
  const facturas = await obtenerFacturasFiscales(companyId, periodo.fechaInicio, periodo.fechaFin);
  return agregar303(facturas, periodo, cuotasACompensar, opciones);
}

export async function calcularModelo390(companyId: string, ejercicio: number): Promise<DatosModelo390> {
  await exigirModelosAeat(companyId, `${ejercicio}-01-01`, `${ejercicio}-12-31`);
  const facturas = await obtenerFacturasFiscales(companyId, `${ejercicio}-01-01`, `${ejercicio}-12-31`);
  return agregar390(facturas, ejercicio);
}

export async function calcularModelo347(companyId: string, ejercicio: number, umbral?: number): Promise<DatosModelo347> {
  await exigirModelosAeat(companyId, `${ejercicio}-01-01`, `${ejercicio}-12-31`);
  const [facturas, metalico] = await Promise.all([obtenerFacturasFiscales(companyId, `${ejercicio}-01-01`, `${ejercicio}-12-31`), avisosMetalicoPartidas(companyId, ejercicio)]);
  const d = agregar347(facturas, ejercicio, umbral);
  const advertencias = [...(d.advertencias ?? []), ...metalico];
  return { ...d, ...(advertencias.length && { advertencias }) };
}

/**
 * Cobros en efectivo (caja, 570) de facturas de años anteriores que trajo la
 * gestoria pendientes (partidas de «Traer la contabilidad de 2026»): si a un
 * cliente se le cobran en el año mas de 6.000 € asi, van en el 347 de ese año
 * como «importe percibido en metalico», con el ejercicio de la operacion. El
 * 347 de la app solo mira sus facturas: se avisa para escribirlo a mano.
 */
export async function avisosMetalicoPartidas(companyId: string, ejercicio: number): Promise<string[]> {
  if (!dbFacturasListo()) return [];
  const cobros = await prisma.invoicePayment.findMany({
    where: { companyId, invoiceType: 'PARTIDA', estado: 'ACTIVO', fecha: { gte: `${ejercicio}-01-01`, lte: `${ejercicio}-12-31` }, cuentaTesoreria: { startsWith: '570' } },
    select: { invoiceId: true, importe: true },
  });
  if (!cobros.length) return [];
  const partidas = await prisma.partidaPendiente.findMany({
    where: { companyId, tipo: 'COBRO', id: { in: [...new Set(cobros.map((c) => c.invoiceId))] } },
    select: { id: true, customerId: true, subcuenta: true, fechaDocumento: true },
  });
  const dePartida = new Map(partidas.map((p) => [p.id, p]));
  // Por cliente (o por subcuenta si la partida no tiene ficha) y año de la operacion.
  const suma = new Map<string, { customerId: string | null; subcuenta: string; anio: string; centimos: number }>();
  for (const c of cobros) {
    const p = dePartida.get(c.invoiceId);
    if (!p) continue;
    const anio = (p.fechaDocumento ?? '').slice(0, 4) || String(ejercicio - 1);
    const clave = `${p.customerId ?? p.subcuenta}|${anio}`;
    const a = suma.get(clave) ?? { customerId: p.customerId, subcuenta: p.subcuenta, anio, centimos: 0 };
    a.centimos += aCentimos(Number(c.importe));
    suma.set(clave, a);
  }
  const porCliente = new Map<string, number>();
  for (const a of suma.values()) porCliente.set(a.customerId ?? a.subcuenta, (porCliente.get(a.customerId ?? a.subcuenta) ?? 0) + a.centimos);
  const pasan = [...suma.values()].filter((a) => (porCliente.get(a.customerId ?? a.subcuenta) ?? 0) > aCentimos(6000));
  if (!pasan.length) return [];
  const clientes = await prisma.customer.findMany({
    where: { companyId, id: { in: pasan.map((a) => a.customerId).filter((x): x is string => !!x) } },
    select: { id: true, nombreFiscal: true, nifCif: true },
  });
  const ficha = new Map(clientes.map((c) => [c.id, c]));
  return pasan.map((a) => {
    const c = a.customerId ? ficha.get(a.customerId) : undefined;
    const quien = c ? `${c.nombreFiscal} (${c.nifCif})` : `La subcuenta ${a.subcuenta}`;
    return (
      `${quien}: ${eur(a.centimos / 100)} cobrados en efectivo en ${ejercicio} de facturas de ${a.anio} que trajo la gestoría pendientes. ` +
      `Van en este 347 como «importe percibido en metálico», con el ejercicio ${a.anio}: la app no los añade sola, escríbelos antes de presentar.`
    );
  });
}

export async function calcularModelo349(companyId: string, periodo: PeriodoFiscal): Promise<DatosModelo349> {
  await exigirModelosAeat(companyId, periodo.fechaInicio, periodo.fechaFin);
  const facturas = await obtenerFacturasFiscales(companyId, periodo.fechaInicio, periodo.fechaFin);
  return agregar349(facturas, periodo);
}

/**
 * Fecha contable de la factura que rectifica un abono (la primera de sus
 * enlaces): la de la original de la app o la que se escribio de una de fuera.
 */
export function fechaOriginalDe(f: { rectifica?: Array<{ fechaOriginal: string | null; periodoDesde: string | null; original: { fechaEmision: string; fechaRegistro: string | null } | null }> }): string | null {
  const e = f.rectifica?.[0];
  if (!e) return null;
  return e.original ? fechaContableGasto(e.original) : (e.fechaOriginal ?? e.periodoDesde);
}

/** Arrendador del 115: su NIF normalizado o, si no lo tiene, el proveedor. */
const claveArrendador = (f: { supplierId: string; supplier: { nifCif: string | null } }) => normalizarNif(f.supplier.nifCif) || `proveedor:${f.supplierId}`;

/** Inmueble arrendado de una factura de alquiler (lo que necesita registro180De). */
export type InmuebleDeAlquiler = { id: string; supplierId: string; activo: boolean };

/**
 * Registro del 180 al que va una factura de ALQUILER: arrendador, inmueble
 * (el de la factura si es de su arrendador o, si no, su unico inmueble
 * activo) y ejercicio de devengo (el de emision si es anterior). El 115 lo usa
 * para que la retencion de un abono solo reste de la de ese mismo registro.
 */
export function registro180De<I extends InmuebleDeAlquiler>(
  f: { supplierId: string; inmuebleArrendadoId?: string | null; fechaEmision: string },
  inmuebles: readonly I[],
  ejercicio: number,
): { clave: string; inmueble: I | null; devengo: number | null } {
  const activos = inmuebles.filter((i) => i.supplierId === f.supplierId && i.activo);
  // El inmueble guardado en la factura solo vale si es de su arrendador (una factura cambiada de proveedor no arrastra el del anterior).
  const inmueble = (f.inmuebleArrendadoId && inmuebles.find((i) => i.id === f.inmuebleArrendadoId && i.supplierId === f.supplierId)) || (activos.length === 1 ? activos[0] : null);
  const devengo = Number(f.fechaEmision.slice(0, 4)) < ejercicio ? Number(f.fechaEmision.slice(0, 4)) : null;
  return { clave: `${f.supplierId}|${inmueble?.id ?? '-'}|${devengo ?? ''}`, inmueble, devengo };
}

/**
 * Facturas de ALQUILER con retencion del año hasta `hasta`, una fila por
 * aparicion, con lo que cuenta de cada una en el 115 y el 180: la retencion de
 * un abono solo resta de la de su mismo registro del 180 en el año
 * (retencionesPorPerceptor) y la de una factura de un ejercicio anterior no
 * cuenta. Lo usan el 115 (las del periodo) y el 180 (las del año).
 */
export async function retencionesAlquilerDelAnio(companyId: string, ejercicio: number, hasta: string) {
  const desde = `${ejercicio}-01-01`;
  const facturas = await prisma.expenseInvoice.findMany({
    where: { AND: [whereGastosFiscales(companyId, desde, hasta), { tipoGasto: 'ALQUILER', retencionTotal: { not: 0 } }] },
    include: {
      lineas: true,
      supplier: { select: { id: true, nifCif: true, nombreFiscal: true, cp: true, provincia: true, pais: true } },
      rectifica: { include: { original: { select: { fechaEmision: true, fechaRegistro: true } } } },
    },
  });
  const inmuebles = await prisma.inmuebleArrendado.findMany({ where: { companyId } });
  // Una anulada no resta nunca (el 115 no admite negativos): solo cuenta, en su
  // periodo, si su 115 ya estaba presentado, y entonces con un aviso.
  const declaradaEn = await retencionDeclaradaEn(companyId, '115', facturas);
  const filas = [];
  for (const f of facturas) {
    const declarada = declaradaEn(f);
    for (const { fecha } of aparicionesRetencionEntre(f, desde, hasta, declarada !== null)) {
      const desglose = desgloseRetencionGasto(f);
      const base = desglose.reduce((a, d) => a + aCentimos(d.base), 0);
      const retencion = desglose.reduce((a, d) => a + aCentimos(d.cuota), 0);
      const fechaOriginal = fechaOriginalDe(f);
      const esAbono = retencion < 0;
      filas.push({
        f,
        fecha,
        declarada,
        base,
        retencion,
        desglose,
        fechaOriginal,
        registro: registro180De(f, inmuebles, ejercicio),
        deAnioAnterior: esAbono && !!fechaOriginal && fechaOriginal < `${fecha.slice(0, 4)}-01-01`,
      });
    }
  }
  const contadas = retencionesPorPerceptor(filas.map((x) => ({ clave: x.registro.clave, fecha: x.fecha, base: x.base, retencion: x.retencion, deAnioAnterior: x.deAnioAnterior })));
  return { filas: filas.map((x, i) => ({ ...x, contada: contadas[i] })), inmuebles };
}

/**
 * Modelo 115 (retenciones por arrendamiento de inmuebles urbanos): las
 * facturas de gasto de ALQUILER con retencion, con el criterio fiscal de las
 * facturas de gasto (sin borradores ni anuladas; una anulada con contraasiento
 * resta en el periodo de la anulacion). La base es la de las lineas con
 * retencion. [01] son los arrendadores distintos con facturas en el periodo.
 * Sin complementarias: [04] = 0 y [05] = [03].
 */
export async function calcularModelo115(companyId: string, periodo: PeriodoFiscal): Promise<DatosModelo115> {
  const vacio: DatosModelo115 = { periodo, nPerceptores: 0, baseRetenciones: 0, retenciones: 0, resultadoAnteriores: 0, resultadoIngresar: 0, perceptores: [] };
  if (!dbFacturasListo()) return vacio;
  const { filas } = await retencionesAlquilerDelAnio(companyId, periodo.ejercicio, periodo.fechaFin);
  const avisos: string[] = [];
  const porArrendador = new Map<string, { nif: string; nombre: string; base: number; retencion: number; facturas: number; conCargo: boolean }>();
  const abonos: Array<{ numero: string; retencion: number; fechaOriginal: string | null }> = [];
  let excesoPerceptor = 0;
  for (const { f, fecha, declarada, retencion, fechaOriginal, contada } of filas) {
    if (fecha < periodo.fechaInicio) continue;
    // [01] son arrendadores distintos por NIF: el mismo arrendador dado de alta dos veces cuenta una.
    if (declarada) avisos.push(avisoRetencionAnulada(f.numeroFacturaProveedor ?? f.numeroCompleto, f.supplier.nombreFiscal, '115', declarada, fechaContableGasto(f).slice(0, 4)));
    const a = porArrendador.get(claveArrendador(f)) ?? { nif: f.supplier.nifCif, nombre: f.supplier.nombreFiscal, base: 0, retencion: 0, facturas: 0, conCargo: false };
    a.base += contada.base;
    a.retencion += contada.retencion;
    a.facturas += 1;
    // [01]: quien solo tiene abonos en el periodo no cuenta como arrendador.
    if (retencion > 0) a.conCargo = true;
    else abonos.push({ numero: f.numeroFacturaProveedor ?? f.numeroCompleto, retencion, fechaOriginal });
    excesoPerceptor += contada.exceso;
    porArrendador.set(claveArrendador(f), a);
  }
  const lista = [...porArrendador.values()];
  // Solo de su mismo arrendador en el año (retencionesAlquilerDelAnio) y la
  // casilla como mucho hasta cero (decision P1): el exceso se avisa.
  const base = topeCero(lista.reduce((s, a) => s + a.base, 0));
  const ret = topeCero(lista.reduce((s, a) => s + a.retencion, 0));
  const exceso = excesoPerceptor + ret.exceso;
  if (exceso > 0) avisos.push(avisoExcesoRetencion({ modelo: '115', abonos, restado: abonos.reduce((s, x) => s - x.retencion, 0) - exceso, exceso }));
  const retenciones = ret.valor;
  return {
    periodo,
    nPerceptores: lista.filter((a) => a.conCargo).length,
    baseRetenciones: base.valor / 100,
    retenciones: retenciones / 100,
    resultadoAnteriores: 0,
    resultadoIngresar: retenciones / 100,
    ...(exceso > 0 ? { excesoAbonos: exceso / 100 } : {}),
    ...(ret.exceso > 0 ? { excesoTopeAbonos: ret.exceso / 100 } : {}),
    ...(base.exceso > 0 ? { excesoBaseAbonos: base.exceso / 100 } : {}),
    perceptores: lista
      .filter((a) => a.base !== 0 || a.retencion !== 0 || a.conCargo)
      .map((a) => ({ nif: a.nif, nombre: a.nombre, base: a.base / 100, retencion: a.retencion / 100, facturas: a.facturas }))
      .sort((x, y) => x.nombre.localeCompare(y.nombre, 'es')),
    ...(avisos.length ? { avisos } : {}),
  };
}

/** Meses (1..12) que abarca un periodo (1T->1,2,3; 01->1; 0A->1..12). */
export function mesesDePeriodo(periodo: PeriodoFiscal): number[] {
  const p = periodo.periodo.toUpperCase();
  if (p === '0A') return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const trim: Record<string, number[]> = { '1T': [1, 2, 3], '2T': [4, 5, 6], '3T': [7, 8, 9], '4T': [10, 11, 12] };
  if (trim[p]) return trim[p];
  const m = Number(p);
  return m >= 1 && m <= 12 ? [m] : [];
}

/**
 * Modelo 111 (retenciones IRPF). Fuente unica (services/nominas/fiscal.ts):
 *  - Rendimientos del TRABAJO [01]-[06]: las nominas por trabajador no anuladas
 *    cuya FECHA DE PAGO cae en el periodo (art. 78.1 RIRPF); [01] y [04] son
 *    perceptores distintos por NIF, no meses ni nominas.
 *  - ACTIVIDADES ECONOMICAS [07]-[09]: facturas de gasto confirmadas con retencion.
 * TODO: premios, imputaciones de rentas.
 */
export async function calcularModelo111(companyId: string, periodo: PeriodoFiscal): Promise<DatosModelo111> {
  const [trabajo, actividades] = await Promise.all([retencionesTrabajo(companyId, periodo), retencionesActividades(companyId, periodo)]);
  const t = trabajo.casillas;
  // [28] = [03] + [06] + [09] (y las demas claves, hoy a cero), en centimos.
  const c = (v: number) => Math.round(v * 100);
  const totalRetenciones = (c(t.retencionesDinerarias) + c(t.ingresosACuenta) + c(actividades.retenciones)) / 100;

  return {
    periodo,
    nPerceptoresTrabajo: t.perceptoresDinerarios,
    percepcionesTrabajo: t.percepcionesDinerarias,
    retencionesTrabajo: t.retencionesDinerarias,
    nPerceptoresEspecie: t.perceptoresEspecie,
    percepcionesEspecie: t.percepcionesEspecie,
    ingresosACuentaEspecie: t.ingresosACuenta,
    nPerceptoresActividades: actividades.perceptores,
    percepcionesActividades: actividades.percepciones,
    retencionesActividades: actividades.retenciones,
    actividadesPorTipo: actividades.porTipo,
    resumenAntiguo: trabajo.resumenAntiguo,
    borradores: trabajo.borradores,
    totalRetenciones,
    resultadoIngresar: totalRetenciones, // [30] = [28] - resultados anteriores [29] (0)
    avisos: [...trabajo.avisos, ...(actividades.avisos ?? [])],
    ...(actividades.excesoAbonos ? { excesoAbonos: actividades.excesoAbonos } : {}),
  };
}
