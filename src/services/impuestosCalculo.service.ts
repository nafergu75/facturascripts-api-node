import { prisma } from '../config/database';
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
export function agregar303(
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
  const resultadoFinal = round2(resultado - Math.abs(cuotasACompensar));

  // Casillas OFICIALES del 303. Bloque devengado RG = 3 filas por tipo de IVA
  // en orden descendente (habitualmente 21/10/4):
  //   fila 1: [01] base, [02] tipo%, [03] cuota
  //   fila 2: [04] base, [05] tipo%, [06] cuota
  //   fila 3: [07] base, [08] tipo%, [09] cuota
  const casillas: Record<string, number> = {};
  const filas: Array<[string, string, string]> = [
    ['01', '02', '03'],
    ['04', '05', '06'],
    ['07', '08', '09'],
  ];
  [...ivaDevengado]
    .sort((a, b) => b.tipo - a.tipo)
    .slice(0, 3)
    .forEach((d, i) => {
      const [cBase, cTipo, cCuota] = filas[i];
      casillas[`${cBase}_base_devengada_${d.tipo}`] = d.base;
      casillas[`${cTipo}_tipo`] = d.tipo;
      casillas[`${cCuota}_cuota_devengada_${d.tipo}`] = d.cuota;
    });
  Object.assign(casillas, {
    '27_total_devengado': totalCuotaDevengada,
    '28_base_deducible': sumBase(ivaDeducible),
    '29_cuota_deducible': totalCuotaDeducible,
    '45_total_deducir': totalCuotaDeducible,
    '46_resultado_regimen_general': resultado,
    '78_cuotas_a_compensar': round2(Math.abs(cuotasACompensar)),
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
    cuotasACompensarAnteriores: round2(Math.abs(cuotasACompensar)),
    resultadoFinal,
    entregasIntracomunitarias,
    exportaciones,
    casillas,
  };
}

/** Modelo 390: resumen anual de IVA. */
export function agregar390(facturas: FacturaFiscal[], ejercicio: number): DatosModelo390 {
  const delAno = facturas.filter((f) => f.fecha.startsWith(String(ejercicio)));
  const ventas = delAno.filter((f) => f.tipo === 'venta' && f.operacion === 'interior');
  const compras = delAno.filter((f) => f.tipo === 'compra');

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
export function agregar347(
  facturas: FacturaFiscal[],
  ejercicio: number,
  umbral: number = UMBRAL_347,
): DatosModelo347 {
  const delAno = facturas.filter((f) => f.fecha.startsWith(String(ejercicio)));
  const acumulado = new Map<string, OperacionTercero>();

  for (const f of delAno) {
    const base = round2(f.lineas.reduce((a, l) => a + l.base, 0));
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
export function agregar349(facturas: FacturaFiscal[], periodo: PeriodoFiscal): DatosModelo349 {
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

// ---------------------------------------------------------------------------
// Wrappers async: obtienen las facturas de la BD propia (Prisma) y agregan.
// Migrado de FacturaScripts a Prisma en ADR-002 Paso 3 (camino de facturas),
// para que los modelos de IVA (303/390/347/349) funcionen sin FacturaScripts.
// ---------------------------------------------------------------------------

/** True si Prisma está disponible (no mockeado como {} en tests). */
function dbFacturasListo(): boolean {
  return typeof (prisma as { incomeInvoice?: { findMany?: unknown } })?.incomeInvoice?.findMany === 'function';
}

// --- Critica 3: clasificacion de la operacion (interior/intracom/exportacion) ---
// Paises UE (ISO-3166 alfa-3, como usa FS en codpais) excluyendo ESP.
const PAISES_UE = new Set([
  'DEU', 'FRA', 'ITA', 'PRT', 'BEL', 'NLD', 'LUX', 'IRL', 'AUT', 'FIN', 'SWE', 'DNK', 'GRC',
  'POL', 'CZE', 'SVK', 'SVN', 'HUN', 'ROU', 'BGR', 'HRV', 'EST', 'LVA', 'LTU', 'CYP', 'MLT',
]);
// Prefijos de NIF-IVA intracomunitario (VIES). 'EL' = Grecia, 'XI' = Irlanda del Norte.
const PREFIJOS_NIF_UE = new Set([
  'DE', 'FR', 'IT', 'PT', 'BE', 'NL', 'LU', 'IE', 'AT', 'FI', 'SE', 'DK', 'EL', 'PL', 'CZ',
  'SK', 'SI', 'HU', 'RO', 'BG', 'HR', 'EE', 'LV', 'LT', 'CY', 'MT', 'XI',
]);

/**
 * Clasifica la operacion por el pais del tercero (codpais de su ficha FS) y, si
 * no hay pais, por el prefijo del NIF-IVA (DE..., FR...). TODO: regimenes
 * especiales (ISP, OSS) cuando se modelen.
 */
export function clasificarOperacion(codpais?: string, cifnif?: string): 'interior' | 'intracomunitaria' | 'exportacion' {
  const pais = (codpais ?? '').trim().toUpperCase();
  if (pais === 'ESP' || pais === 'ES') return 'interior';
  if (pais) return PAISES_UE.has(pais) ? 'intracomunitaria' : 'exportacion';
  const pref = (cifnif ?? '').trim().slice(0, 2).toUpperCase();
  if (PREFIJOS_NIF_UE.has(pref)) return 'intracomunitaria';
  return 'interior';
}

/**
 * Facturas fiscales con IVA desglosado por tipo, leídas de la BD propia (Prisma).
 * Ventas = `IncomeInvoice`, compras = `ExpenseInvoice`; se excluyen los borradores
 * (estado DRAFT). El IVA por línea sale de `tipoIva`/`baseLine`/`ivaImporte`; si
 * una factura no tiene líneas, se usa el total de cabecera. La clasificación de
 * operación usa el país del tercero (cliente/proveedor) o el prefijo del NIF-IVA.
 */
export async function obtenerFacturasFiscales(companyId: string, desde: string, hasta: string): Promise<FacturaFiscal[]> {
  if (!dbFacturasListo()) return [];
  const out: FacturaFiscal[] = [];

  const [ventas, compras] = await Promise.all([
    prisma.incomeInvoice.findMany({
      where: { companyId, estado: { not: 'DRAFT' }, fechaEmision: { gte: desde, lte: hasta } },
      include: { customer: true, lineas: true },
    }),
    prisma.expenseInvoice.findMany({
      where: { companyId, estado: { not: 'DRAFT' }, fechaEmision: { gte: desde, lte: hasta } },
      include: { supplier: true, lineas: true },
    }),
  ]);

  for (const f of ventas) {
    out.push({
      idFactura: f.numeroCompleto,
      tipo: 'venta',
      cifnif: f.customer?.nifCif ?? '',
      nombreTercero: f.customer?.nombreFiscal ?? '',
      fecha: f.fechaEmision,
      operacion: clasificarOperacion(f.customer?.pais, f.customer?.nifCif),
      lineas: f.lineas.length
        ? f.lineas.map((l) => ({ tipoIva: l.tipoIva, base: round2(l.baseLine), cuota: round2(l.ivaImporte) }))
        : [{ tipoIva: 0, base: round2(f.baseTotal), cuota: 0 }],
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
  const facturas = await obtenerFacturasFiscales(companyId, periodo.fechaInicio, periodo.fechaFin);
  return agregar303(facturas, periodo, cuotasACompensar);
}

export async function calcularModelo390(companyId: string, ejercicio: number): Promise<DatosModelo390> {
  const facturas = await obtenerFacturasFiscales(companyId, `${ejercicio}-01-01`, `${ejercicio}-12-31`);
  return agregar390(facturas, ejercicio);
}

export async function calcularModelo347(companyId: string, ejercicio: number, umbral?: number): Promise<DatosModelo347> {
  const facturas = await obtenerFacturasFiscales(companyId, `${ejercicio}-01-01`, `${ejercicio}-12-31`);
  return agregar347(facturas, ejercicio, umbral);
}

export async function calcularModelo349(companyId: string, periodo: PeriodoFiscal): Promise<DatosModelo349> {
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
