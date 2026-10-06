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
import { prisma } from '../config/database';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Genera las Cuentas Anuales (RM) completas, incluyendo el EFE. */
export async function generarCuentasAnuales(companyId: string, ejercicio: number): Promise<CuentasAnualesRM> {
  const { balance, pyg, ecpn, asientos, anterior, efectivoInicial, reservaLegal } = await calcularEstadosFinancieros(companyId, ejercicio);

  const resultado = pyg.resultadoEjercicio;
  const aplicacionResultado = proponerAplicacion(resultado, ecpn.capital, reservaLegal);

  const efe = calcularEFEDesdeAsientos(asientos, efectivoInicial);

  // Datos de la empresa: si no se pueden leer, el resto se genera igual.
  const [legal, empresa] = await Promise.all([
    Promise.resolve()
      .then(() => prisma.legalConfig.findUnique({ where: { companyId } }))
      .catch(() => null),
    Promise.resolve()
      .then(() => prisma.company.findUnique({ where: { id: companyId }, select: { name: true } }))
      .catch(() => null),
  ]);

  let denominacion = empresa?.name ?? '';
  let nif = '';
  try {
    const fs = await getFsClientForCompany(companyId);
    const { items } = await fs.listWithMeta('empresas', { limit: 1 });
    const e = items[0] as Record<string, unknown> | undefined;
    denominacion = String(e?.nombre || denominacion);
    nif = String(e?.cifnif ?? '');
  } catch {
    // Si FS no responde, se deja vacio (no bloquea la generacion del resto del informe).
  }

  return {
    sociedad: {
      denominacion,
      nif,
      // domicilio: PENDIENTE. No hay donde guardarlo todavia (falta un campo en
      // la configuracion legal de la empresa).
      domicilio: '',
      ejercicio,
      formaJuridica: FORMA_JURIDICA[legal?.tipoSociedad ?? ''] ?? legal?.tipoSociedad ?? '',
    },
    balance,
    pyg,
    ecpn,
    anterior,
    efe,
    aplicacionResultado,
    // notasMemoria: PENDIENTE BLOQUEADO. Requiere una memoria estructurada
    // (politicas contables, info adicional ICAC) que hoy no existe como dato de
    // entrada en el sistema; no hay nada que "leer" para rellenarla.
    notasMemoria: '',
  };
}

const FORMA_JURIDICA: Record<string, string> = {
  SA: 'Sociedad Anónima',
  SL: 'Sociedad de Responsabilidad Limitada',
  SLU: 'Sociedad de Responsabilidad Limitada Unipersonal',
  SCP: 'Sociedad Civil Particular',
};

/** Propuesta de aplicacion del resultado (ver AplicacionResultado). */
export function proponerAplicacion(resultado: number, capital: number, reservaLegalActual: number): AplicacionResultado {
  if (resultado <= 0) {
    return { resultadoEjercicio: resultado, aReservas: 0, aReservaLegal: 0, aReservasVoluntarias: 0, aDividendos: 0, aCompensacionPerdidas: round2(-resultado) };
  }
  const hastaVeintePorCiento = Math.max(0, round2(capital * 0.2 - reservaLegalActual));
  const aReservaLegal = round2(Math.min(resultado * 0.1, hastaVeintePorCiento));
  const aReservasVoluntarias = round2(resultado - aReservaLegal);
  return { resultadoEjercicio: resultado, aReservas: resultado, aReservaLegal, aReservasVoluntarias, aDividendos: 0, aCompensacionPerdidas: 0 };
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
  const { asientos, efectivoInicial } = await calcularEstadosFinancieros(companyId, ejercicio);
  return calcularEFEDesdeAsientos(asientos, efectivoInicial);
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
  return { categoria: 'explotacion', descripcion: 'Otros cobros/pagos de explotación' };
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
export function calcularEFEDesdeAsientos(asientos: AsientoSimple[], efectivoInicial = 0): EstadoFlujosEfectivo {
  const agregados: Record<Categoria, Map<string, number>> = {
    explotacion: new Map(),
    inversion: new Map(),
    financiacion: new Map(),
  };

  for (const a of asientos) {
    // Apertura, regularizacion y cierre no mueven dinero: solo trasladan saldos.
    if (a.tipo && a.tipo !== 'NORMAL') continue;
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
      : { categoria: 'explotacion' as Categoria, descripcion: 'Otros cobros/pagos de explotación' };

    const mapa = agregados[clasif.categoria];
    mapa.set(clasif.descripcion, round2((mapa.get(clasif.descripcion) ?? 0) + deltaEfectivo));
  }

  const construirSeccion = (titulo: string, categoria: Categoria): SeccionFlujoEfectivo => {
    const partidas: PartidaFlujoEfectivo[] = [...agregados[categoria].entries()].map(([descripcion, importe]) => ({ descripcion, importe }));
    const subtotal = round2(partidas.reduce((acc, p) => acc + p.importe, 0));
    return { titulo, partidas, subtotal };
  };

  const flujosExplotacion = construirSeccion('Flujos de efectivo de las actividades de explotación', 'explotacion');
  const flujosInversion = construirSeccion('Flujos de efectivo de las actividades de inversión', 'inversion');
  const flujosFinanciacion = construirSeccion('Flujos de efectivo de las actividades de financiación', 'financiacion');

  const variacionNetaEfectivo = round2(flujosExplotacion.subtotal + flujosInversion.subtotal + flujosFinanciacion.subtotal);

  // Efectivo inicial = saldo de tesoreria al cierre del año anterior (antes
  // siempre 0). Final = inicial + variacion neta.
  const efectivoFinal = round2(efectivoInicial + variacionNetaEfectivo);

  return {
    flujosExplotacion,
    flujosInversion,
    flujosFinanciacion,
    variacionNetaEfectivo,
    efectivoInicial,
    efectivoFinal,
  };
}
