import type { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { badRequest } from '../utils/http-errors';
import { listarResumenesNominas } from './nominas.service';
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
  filasRegimenGeneral303,
  OperacionIntracomunitaria,
  OperacionTercero,
  PeriodoFiscal,
} from '../domain/impuestos.model';
import {
  esPaisEspana,
  esTipoOperacion,
  fechaDevengoVenta,
  importeEnEuros,
  limpiarNif,
  paisDelCliente,
  paisLegacy,
  REGLA_OPERACION,
  tipoOperacionLegacy,
  type ContextoOperacion,
  type TipoOperacionVenta,
} from '../domain/tipo-operacion.model';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const UMBRAL_347 = 3005.06;
const eur = (n: number): string => `${n.toFixed(2)} €`;

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
function devengaIva(f: FacturaFiscal): boolean {
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
function clave349De(f: FacturaFiscal): OperacionIntracomunitaria['clave'] | null {
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

/**
 * Modelo 303: IVA devengado (ventas NACIONAL; sin tipo, las interiores de
 * siempre) vs deducible (compras), mas la informacion adicional de la pagina 3.
 * `cuotasACompensar` = cuotas negativas de periodos anteriores [78] (patron
 * Quipu "303 a compensar"): se restan del resultado para obtener el final [71].
 */
export function agregar303(
  facturas: FacturaFiscal[],
  periodo: PeriodoFiscal,
  cuotasACompensar = 0,
): DatosModelo303 {
  const delPeriodo = facturas.filter((f) => enRango(f.fecha, periodo.fechaInicio, periodo.fechaFin));

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
  if (exentasSinDeduccion !== 0) {
    advertencias.push(
      `Hay ventas exentas sin derecho a deducción (base ${eur(exentasSinDeduccion)}): no van en ninguna casilla del 303 trimestral (sí en el 390) y pueden obligarte a aplicar la prorrata del IVA soportado. Revísalo con tu asesor.`,
    );
  }
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
  // Casillas nuevas de la pagina 3 solo si hay importe (las facturas anteriores no las tienen).
  if (noSujetasLocalizacion !== 0) casillas['120_no_sujetas_localizacion'] = noSujetasLocalizacion;
  if (inversionSujetoPasivo !== 0) casillas['122_inversion_sujeto_pasivo'] = inversionSujetoPasivo;

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
  const delAno = facturas.filter((f) => f.fecha.startsWith(String(ejercicio)));
  const ventas = delAno.filter(devengaIva);
  // Mismo criterio que el 303: los gastos no deducibles no entran, o la suma de
  // los 303 del ano no cuadra con el 390.
  const compras = delAno.filter((f) => f.tipo === 'compra' && f.deducible !== false);

  const resumenDevengado = agruparPorTipoIva(ventas);
  const resumenDeducible = agruparPorTipoIva(compras);
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
export async function obtenerFacturasFiscales(companyId: string, desde: string, hasta: string): Promise<FacturaFiscal[]> {
  if (!dbFacturasListo()) return [];
  const out: FacturaFiscal[] = [];

  const [ventas, compras] = await Promise.all([
    prisma.incomeInvoice.findMany({
      // Solo facturas emitidas: un borrador no es una venta todavía. Por fecha de devengo.
      where: { companyId, estadoDocumento: 'FINAL', estado: { not: 'DRAFT' }, ...ventasQuePuedenDevengarseEntre(desde, hasta) },
      include: { customer: true, lineas: true },
    }),
    prisma.expenseInvoice.findMany({
      where: { companyId, estado: { not: 'DRAFT' }, fechaEmision: { gte: desde, lte: hasta } },
      include: { supplier: true, lineas: true },
    }),
  ]);

  for (const f of ventas) {
    // El IVA va en el periodo del devengo (art. 75 LIVA), aunque la factura se emita despues.
    const devengo = fechaDevengoVenta(f);
    if (!enRango(devengo, desde, hasta)) continue;
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
      fecha: devengo,
      operacion: tipo ? operacionDeTipo(tipo, ctx) : OPERACION_DE_TIPO[tipoOperacionLegacy(pais, nif) as keyof typeof OPERACION_DE_TIPO],
      // Solo las ventas con tipo llevan los campos nuevos: las anteriores salen igual que siempre.
      ...(tipo && {
        tipoOperacion: tipo,
        causaExencion: f.causaExencion,
        clave349: REGLA_OPERACION[tipo].clave349(ctx),
        residente: paisDelCliente(cliente) === 'ES',
        paisTercero: paisDelCliente(cliente),
      }),
      lineas: f.lineas.length
        ? f.lineas.map((l) => ({ tipoIva: l.tipoIva, base: euros(l.baseLine), cuota: euros(l.ivaImporte) }))
        : [{ tipoIva: 0, base: euros(f.baseTotal), cuota: 0 }],
    });
  }

  for (const f of compras) {
    out.push({
      idFactura: f.numeroCompleto,
      tipo: 'compra',
      cifnif: f.supplier?.nifCif ?? '',
      nombreTercero: f.supplier?.nombreFiscal ?? '',
      fecha: f.fechaEmision,
      operacion: clasificarOperacion(f.supplier?.pais, f.supplier?.nifCif),
      lineas: f.lineas.length
        ? f.lineas.map((l) => ({ tipoIva: l.tipoIva, base: round2(l.baseLine), cuota: round2(l.ivaImporte) }))
        : [{ tipoIva: 0, base: round2(f.baseTotal), cuota: 0 }],
    });
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
): Promise<DatosModelo303> {
  await exigirModelosAeat(companyId, periodo.fechaInicio, periodo.fechaFin);
  const facturas = await obtenerFacturasFiscales(companyId, periodo.fechaInicio, periodo.fechaFin);
  return agregar303(facturas, periodo, cuotasACompensar);
}

export async function calcularModelo390(companyId: string, ejercicio: number): Promise<DatosModelo390> {
  await exigirModelosAeat(companyId, `${ejercicio}-01-01`, `${ejercicio}-12-31`);
  const facturas = await obtenerFacturasFiscales(companyId, `${ejercicio}-01-01`, `${ejercicio}-12-31`);
  return agregar390(facturas, ejercicio);
}

export async function calcularModelo347(companyId: string, ejercicio: number, umbral?: number): Promise<DatosModelo347> {
  await exigirModelosAeat(companyId, `${ejercicio}-01-01`, `${ejercicio}-12-31`);
  const facturas = await obtenerFacturasFiscales(companyId, `${ejercicio}-01-01`, `${ejercicio}-12-31`);
  return agregar347(facturas, ejercicio, umbral);
}

export async function calcularModelo349(companyId: string, periodo: PeriodoFiscal): Promise<DatosModelo349> {
  await exigirModelosAeat(companyId, periodo.fechaInicio, periodo.fechaFin);
  const facturas = await obtenerFacturasFiscales(companyId, periodo.fechaInicio, periodo.fechaFin);
  return agregar349(facturas, periodo);
}

/**
 * Modelo 115 (retenciones por arrendamiento de inmuebles urbanos). TODO: sumar
 * las retenciones de los pagos/facturas de alquiler con retencion del periodo.
 * Sin un modulo de arrendamientos, devuelve ceros (el fichero se genera valido).
 */
export async function calcularModelo115(_companyId: string, periodo: PeriodoFiscal): Promise<DatosModelo115> {
  return {
    periodo,
    nPerceptores: 0,
    baseRetenciones: 0,
    retenciones: 0,
    resultadoAnteriores: 0,
    resultadoIngresar: 0,
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
 * Modelo 111 (retenciones IRPF):
 *  - Rendimientos del TRABAJO: resumenes de nominas del periodo.
 *  - Rendimientos de ACTIVIDADES ECONOMICAS (Alta 5): retenciones practicadas en
 *    facturas de PROVEEDORES profesionales (cabecera FS `totalirpf`, campo
 *    verificado en Core/Model/Base/BusinessDocument.php).
 * TODO: premios, imputaciones de rentas.
 */
export async function calcularModelo111(companyId: string, periodo: PeriodoFiscal): Promise<DatosModelo111> {
  const nominas = await listarResumenesNominas(companyId, periodo.ejercicio);
  const meses = mesesDePeriodo(periodo);
  const delPeriodo = nominas.filter((n) => meses.includes(n.mes));

  const percepcionesTrabajo = round2(delPeriodo.reduce((a, n) => a + n.totalBruto, 0));
  const retencionesTrabajo = round2(delPeriodo.reduce((a, n) => a + n.totalIRPF, 0));

  // Alta 5 — retenciones a profesionales (facturas de gasto con IRPF), desde Prisma.
  let retencionesActividades = 0;
  let percepcionesActividades = 0;
  let perceptoresActividades = 0;
  if (dbFacturasListo()) {
    const conIrpf = await prisma.expenseInvoice.findMany({
      where: {
        companyId,
        estado: { not: 'DRAFT' },
        fechaEmision: { gte: periodo.fechaInicio, lte: periodo.fechaFin },
        retencionTotal: { gt: 0 },
      },
      select: { supplierId: true, retencionTotal: true, baseTotal: true },
    });
    retencionesActividades = round2(conIrpf.reduce((a, f) => a + f.retencionTotal, 0));
    percepcionesActividades = round2(conIrpf.reduce((a, f) => a + f.baseTotal, 0));
    perceptoresActividades = new Set(conIrpf.map((f) => f.supplierId)).size;
  }

  const totalRetenciones = round2(retencionesTrabajo + retencionesActividades);

  return {
    periodo,
    nPerceptoresTrabajo: delPeriodo.length, // TODO: nº real de perceptores distintos
    percepcionesTrabajo,
    retencionesTrabajo,
    nPerceptoresActividades: perceptoresActividades,
    percepcionesActividades,
    retencionesActividades,
    totalRetenciones,
    resultadoIngresar: totalRetenciones, // [30] = retenciones - resultados anteriores (0)
  };
}
