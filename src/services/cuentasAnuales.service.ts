import {
  AplicacionResultado,
  CuentasAnualesRM,
  EstadoFlujosEfectivo,
  LibroDiarioRM,
  LibroInventarios,
  PartidaFlujoEfectivo,
  SeccionFlujoEfectivo,
} from '../domain/cuentas-anuales.model';
import { calcularEstadosFinancieros } from './impuestoSociedadesCalculo.service';
import {
  AsientoSimple,
  calcularSaldosPorSubcuenta,
  obtenerAsientosEjercicio,
  saldoDeudor,
} from './contabilidadDatos.service';
import { getFsClientForCompany } from './facturascripts-client';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Genera las Cuentas Anuales (RM) completas, incluyendo el EFE. */
export async function generarCuentasAnuales(companyId: string, ejercicio: number): Promise<CuentasAnualesRM> {
  const { balance, pyg, ecpn, asientos } = await calcularEstadosFinancieros(companyId, ejercicio);

  // Aplicacion del resultado: por defecto todo a reservas (TODO: dividendos, etc.)
  const resultado = pyg.resultadoEjercicio;
  const aplicacionResultado: AplicacionResultado = {
    resultadoEjercicio: resultado,
    aReservas: resultado >= 0 ? resultado : 0,
    aDividendos: 0,
    aCompensacionPerdidas: resultado < 0 ? Math.abs(resultado) : 0,
  };

  const efe = calcularEFEDesdeAsientos(asientos);

  let denominacion = '';
  let nif = '';
  try {
    const fs = await getFsClientForCompany(companyId);
    const { items } = await fs.listWithMeta('empresas', { limit: 1 });
    const e = items[0] as Record<string, unknown> | undefined;
    denominacion = String(e?.nombre ?? '');
    nif = String(e?.cifnif ?? '');
  } catch {
    // Si FS no responde, se deja vacio (no bloquea la generacion del resto del informe).
  }

  return {
    sociedad: {
      denominacion,
      nif,
      // domicilio/formaJuridica: PENDIENTE BLOQUEADO. FacturaScripts no expone un
      // campo estandar y no verificado para domicilio fiscal/forma juridica en el
      // recurso 'empresas'; rellenar requeriria adivinar el nombre de campo. Dejar
      // en blanco hasta confirmar el esquema real o anadir configuracion propia.
      domicilio: '',
      ejercicio,
      formaJuridica: '',
    },
    balance,
    pyg,
    ecpn,
    efe,
    aplicacionResultado,
    // notasMemoria: PENDIENTE BLOQUEADO. Requiere una memoria estructurada
    // (politicas contables, info adicional ICAC) que hoy no existe como dato de
    // entrada en el sistema; no hay nada que "leer" para rellenarla.
    notasMemoria: '',
  };
}

/** Libro Diario: todos los asientos del ejercicio ordenados por fecha y numero. */
export async function generarLibroDiario(companyId: string, ejercicio: number): Promise<LibroDiarioRM> {
  const asientos = await obtenerAsientosEjercicio(companyId, ejercicio);
  asientos.sort((a, b) => (a.fecha === b.fecha ? Number(a.numero) - Number(b.numero) : a.fecha.localeCompare(b.fecha)));

  let totalDebe = 0;
  let totalHaber = 0;
  for (const a of asientos) {
    for (const l of a.lineas) {
      totalDebe += l.debe;
      totalHaber += l.haber;
    }
  }

  return {
    ejercicio,
    asientos: asientos.map((a) => ({ numero: a.numero, fecha: a.fecha, concepto: a.concepto, lineas: a.lineas })),
    totalDebe: round2(totalDebe),
    totalHaber: round2(totalHaber),
  };
}

/** Libro de Inventarios: balance de apertura (cierre del ejercicio anterior) y de cierre por subcuenta. */
export async function generarLibroInventarios(companyId: string, ejercicio: number): Promise<LibroInventarios> {
  const asientos = await obtenerAsientosEjercicio(companyId, ejercicio);
  const saldos = calcularSaldosPorSubcuenta(asientos);

  const balanceCierre = [...saldos.values()]
    .filter((s) => s.saldoDeudor !== 0)
    .map((s) => ({ codigo: s.subcuenta, descripcion: `Subcuenta ${s.subcuenta}`, importe: s.saldoDeudor }));

  // Apertura = cierre del ejercicio anterior, calculado con la misma logica que el
  // cierre actual. Si el ejercicio anterior no tiene asientos (primer ano de
  // actividad, o aun no se ha cerrado), devuelve un array vacio correctamente.
  let balanceApertura: typeof balanceCierre = [];
  try {
    const asientosAnterior = await obtenerAsientosEjercicio(companyId, ejercicio - 1);
    const saldosAnterior = calcularSaldosPorSubcuenta(asientosAnterior);
    balanceApertura = [...saldosAnterior.values()]
      .filter((s) => s.saldoDeudor !== 0)
      .map((s) => ({ codigo: s.subcuenta, descripcion: `Subcuenta ${s.subcuenta}`, importe: s.saldoDeudor }));
  } catch {
    // Ejercicio anterior no disponible en FS (p.ej. no existe ese ejercicio): apertura vacia.
  }

  return {
    ejercicio,
    balanceApertura,
    balanceCierre,
  };
}

/** Punto de entrada publico del EFE (lee asientos y calcula). */
export async function generarEstadoFlujosEfectivo(companyId: string, ejercicio: number): Promise<EstadoFlujosEfectivo> {
  const asientos = await obtenerAsientosEjercicio(companyId, ejercicio);
  return calcularEFEDesdeAsientos(asientos);
}

// ---------------------------------------------------------------------------
// EFE: clasificacion de movimientos que afectan a tesoreria (57x).
// ---------------------------------------------------------------------------

type Categoria = 'explotacion' | 'inversion' | 'financiacion';

/** Clasifica la contrapartida (subcuenta no-57x) en una de las tres secciones. */
function categoriaContrapartida(subcuenta: string): { categoria: Categoria; descripcion: string } {
  const sg = subcuenta.substring(0, 2);
  if (subcuenta.startsWith('2')) return { categoria: 'inversion', descripcion: 'Inversiones/desinversiones en inmovilizado' };
  if (['17', '16', '15', '52'].includes(sg)) return { categoria: 'financiacion', descripcion: 'Cobros/pagos de deudas (prestamos)' };
  if (['10', '11', '55'].includes(sg)) return { categoria: 'financiacion', descripcion: 'Aportaciones de socios / dividendos' };
  if (['43', '44'].includes(sg)) return { categoria: 'explotacion', descripcion: 'Cobros de clientes' };
  if (['40', '41'].includes(sg)) return { categoria: 'explotacion', descripcion: 'Pagos a proveedores y acreedores' };
  if (['47'].includes(sg)) return { categoria: 'explotacion', descripcion: 'Cobros/pagos por impuestos' };
  // 60/62/64/63/65/70/75... y resto -> explotacion
  return { categoria: 'explotacion', descripcion: 'Otros cobros/pagos de explotacion' };
}

/**
 * Calcula el EFE por el metodo directo simplificado: por cada asiento que mueve
 * tesoreria (57x), el delta de efectivo (debe-haber de las 57x) se asigna a la
 * seccion segun la contrapartida dominante.
 *
 * TODO: separar intereses (66/76) del principal en financiacion; distinguir
 * impuesto de explotacion vs IS; manejar asientos multi-contrapartida con varias
 * categorias (aqui se usa la contrapartida de mayor importe).
 */
export function calcularEFEDesdeAsientos(asientos: AsientoSimple[]): EstadoFlujosEfectivo {
  const agregados: Record<Categoria, Map<string, number>> = {
    explotacion: new Map(),
    inversion: new Map(),
    financiacion: new Map(),
  };

  for (const a of asientos) {
    const lineas57 = a.lineas.filter((l) => l.subcuenta.startsWith('57'));
    if (lineas57.length === 0) continue;

    const deltaEfectivo = round2(lineas57.reduce((acc, l) => acc + (l.debe - l.haber), 0));
    if (deltaEfectivo === 0) continue;

    // contrapartida dominante (linea no-57x de mayor importe absoluto)
    const contrapartidas = a.lineas.filter((l) => !l.subcuenta.startsWith('57'));
    const dominante = contrapartidas.sort(
      (x, y) => Math.abs(y.debe - y.haber) - Math.abs(x.debe - x.haber),
    )[0];
    const clasif = dominante
      ? categoriaContrapartida(dominante.subcuenta)
      : { categoria: 'explotacion' as Categoria, descripcion: 'Otros cobros/pagos de explotacion' };

    const mapa = agregados[clasif.categoria];
    mapa.set(clasif.descripcion, round2((mapa.get(clasif.descripcion) ?? 0) + deltaEfectivo));
  }

  const construirSeccion = (titulo: string, categoria: Categoria): SeccionFlujoEfectivo => {
    const partidas: PartidaFlujoEfectivo[] = [...agregados[categoria].entries()].map(([descripcion, importe]) => ({ descripcion, importe }));
    const subtotal = round2(partidas.reduce((acc, p) => acc + p.importe, 0));
    return { titulo, partidas, subtotal };
  };

  const flujosExplotacion = construirSeccion('Flujos de efectivo de las actividades de explotacion', 'explotacion');
  const flujosInversion = construirSeccion('Flujos de efectivo de las actividades de inversion', 'inversion');
  const flujosFinanciacion = construirSeccion('Flujos de efectivo de las actividades de financiacion', 'financiacion');

  const variacionNetaEfectivo = round2(flujosExplotacion.subtotal + flujosInversion.subtotal + flujosFinanciacion.subtotal);

  // efectivoInicial: TODO (saldo de cierre del ejercicio anterior). Con solo los
  // asientos del ejercicio, el efectivoFinal = inicial + variacion neta.
  const saldos = calcularSaldosPorSubcuenta(asientos);
  const efectivoInicial = 0;
  const efectivoFinal = round2(efectivoInicial + saldoDeudor(saldos, ['57']));

  return {
    flujosExplotacion,
    flujosInversion,
    flujosFinanciacion,
    variacionNetaEfectivo,
    efectivoInicial,
    efectivoFinal,
  };
}
