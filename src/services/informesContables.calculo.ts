/**
 * Calculos de los informes contables (sin BD): sumas y saldos, libro mayor,
 * libro diario y mayor de clientes y proveedores.
 *
 * Todos trabajan sobre los asientos POSTED ya leidos (AsientoInforme) y un
 * periodo [desde, hasta] dentro de un mismo ejercicio. Reglas comunes:
 *
 *  - Los asientos de REGULARIZACION y CIERRE no cuentan (dejan las cuentas a
 *    cero al 31-12; con ellos un ejercicio cerrado sale vacio).
 *  - Si hay asiento de APERTURA, se parte de el: ya trae los saldos anteriores,
 *    y lo de antes no se vuelve a sumar. Si no hay, se acumula desde el primer
 *    asiento.
 *  - Las cuentas de gastos e ingresos (grupos 6 a 9) empiezan de cero cada
 *    ejercicio. Lo que quede de años anteriores sin regularizar se lleva a la
 *    129 (resultado pendiente), para que la suma de saldos iniciales siga a cero.
 */
import { tipoAsiento, type TipoAsiento } from './contabilidadDatos.service';
import { validarEjercicio } from '../utils/anios';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface LineaInforme {
  cuenta: string;
  nombre: string;
  debe: number;
  haber: number;
  referencia: string | null;
}

export interface AsientoInforme {
  id: string;
  fecha: string; // yyyy-mm-dd
  numero: string;
  concepto: string;
  tipo: TipoAsiento;
  invoiceId: string | null;
  invoiceType: string | null;
  /** Origen del asiento (FACTURA_INGRESO, TESORERIA...): solo cuenta para el orden dentro del dia. */
  origen?: string | null;
  lineas: LineaInforme[];
}

/** Asiento tal y como sale de Prisma (JournalEntry + lineas). */
export interface AsientoPrisma {
  id: string;
  fecha: Date;
  numeroAsiento: string;
  descripcion: string;
  origen: string | null;
  invoiceId: string | null;
  invoiceType: string | null;
  lineas: Array<{ accountCode: string; accountName: string; debe: unknown; haber: unknown; referencia: string | null }>;
}

export function aAsientoInforme(a: AsientoPrisma): AsientoInforme {
  return {
    id: a.id,
    fecha: a.fecha.toISOString().slice(0, 10),
    numero: a.numeroAsiento,
    concepto: a.descripcion,
    tipo: tipoAsiento(a.origen, a.descripcion),
    invoiceId: a.invoiceId,
    invoiceType: a.invoiceType,
    origen: a.origen,
    lineas: a.lineas.map((l) => ({
      cuenta: l.accountCode,
      nombre: l.accountName,
      debe: Number(l.debe ?? 0),
      haber: Number(l.haber ?? 0),
      referencia: l.referencia,
    })),
  };
}

/** Cobros y pagos: en el mismo dia van detras del resto de asientos. */
const ORIGENES_COBRO_PAGO = new Set(['TESORERIA', 'NOMINA_PAGO']);
/** Turno en el dia: la apertura, los demas asientos, los cobros y pagos, la regularizacion y el cierre. */
const turnoEnElDia = (a: { origen?: string | null; tipo?: TipoAsiento }) =>
  a.tipo === 'APERTURA' ? 0 : a.tipo === 'REGULARIZACION' ? 3 : a.tipo === 'CIERRE' ? 4 : ORIGENES_COBRO_PAGO.has(a.origen ?? '') ? 2 : 1;

/**
 * Orden del diario y del mayor: fecha; en el mismo dia, los cobros y pagos
 * detras de los demas asientos, y despues el numero de asiento. Asi, una venta
 * cobrada el mismo dia sale antes que su cobro (por el numero, «COBRO-00012»
 * iria antes que «FAC-ING-A-10» y el saldo acumulado pasaria por un negativo).
 * La apertura va la primera de su dia, y la regularizacion antes que el cierre
 * (por el numero, «CIERRE-…» iria antes que «REGUL-…»).
 */
export function ordenarAsientos<T extends { fecha: string; numero: string; origen?: string | null; tipo?: TipoAsiento }>(asientos: T[]): T[] {
  return [...asientos].sort((a, b) =>
    a.fecha !== b.fecha
      ? a.fecha.localeCompare(b.fecha)
      : turnoEnElDia(a) - turnoEnElDia(b) || a.numero.localeCompare(b.numero, 'es', { numeric: true }),
  );
}

// ---------------------------------------------------------------------------
// Periodo
// ---------------------------------------------------------------------------

export interface Periodo {
  desde: string; // yyyy-mm-dd
  hasta: string; // yyyy-mm-dd
  ejercicio: number;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Periodo de un informe a partir de `ejercicio` (año natural completo) o de
 * `desde`/`hasta`, que tienen que caer en el mismo ejercicio. Devuelve un
 * mensaje de error en vez de lanzar, para que la ruta decida.
 */
export function resolverPeriodo(q: { ejercicio?: unknown; desde?: unknown; hasta?: unknown }): Periodo | string {
  const desde = typeof q.desde === 'string' && q.desde ? q.desde : undefined;
  const hasta = typeof q.hasta === 'string' && q.hasta ? q.hasta : undefined;
  if (desde || hasta) {
    if ((desde && !ISO.test(desde)) || (hasta && !ISO.test(hasta))) return 'Las fechas van en formato AAAA-MM-DD.';
    const anio = Number((desde ?? hasta)!.slice(0, 4));
    const d = desde ?? `${anio}-01-01`;
    const h = hasta ?? `${anio}-12-31`;
    if (d > h) return 'La fecha inicial es posterior a la final.';
    if (d.slice(0, 4) !== h.slice(0, 4)) return 'El periodo tiene que estar dentro de un mismo ejercicio.';
    return { desde: d, hasta: h, ejercicio: anio };
  }
  let ejercicio: number;
  try {
    ejercicio = validarEjercicio(q.ejercicio);
  } catch (e) {
    return `${(e as Error).message} O indica un periodo desde/hasta.`;
  }
  return { desde: `${ejercicio}-01-01`, hasta: `${ejercicio}-12-31`, ejercicio };
}

const esCuentaDeResultados = (cuenta: string): boolean => /^[6-9]/.test(cuenta);

/** Cuenta a la que va el resultado de años anteriores que nadie regularizo. */
export const CUENTA_RESULTADO_PENDIENTE = '129';

export interface MovimientosPeriodo {
  /** Saldo deudor (debe - haber) de cada cuenta al empezar el periodo. */
  saldosIniciales: Map<string, number>;
  /** Asientos del periodo (sin regularizacion ni cierre), en orden. */
  asientos: AsientoInforme[];
}

/**
 * Separa los asientos en saldo inicial y movimientos del periodo (ver reglas
 * en la cabecera del fichero). `incluirCierre` deja dentro la regularizacion y
 * el cierre (solo para el libro diario, si se pide completo).
 */
export function movimientosDelPeriodo(
  todos: AsientoInforme[],
  periodo: Periodo,
  opts: { incluirCierre?: boolean } = {},
): MovimientosPeriodo {
  const inicioEjercicio = `${periodo.ejercicio}-01-01`;
  const sinCierre = todos.filter((a) => a.fecha <= periodo.hasta && a.tipo !== 'REGULARIZACION' && a.tipo !== 'CIERRE');
  const apertura = sinCierre.filter((a) => a.tipo === 'APERTURA').reduce((m, a) => (a.fecha > m ? a.fecha : m), '');

  const saldosIniciales = new Map<string, number>();
  const sumar = (cuenta: string, n: number) => saldosIniciales.set(cuenta, round2((saldosIniciales.get(cuenta) ?? 0) + n));
  for (const a of sinCierre) {
    if (a.fecha >= periodo.desde) continue;
    if (apertura && a.fecha < apertura) continue;
    for (const l of a.lineas) {
      const deudor = l.debe - l.haber;
      if (esCuentaDeResultados(l.cuenta) && a.fecha < inicioEjercicio) sumar(CUENTA_RESULTADO_PENDIENTE, deudor);
      else sumar(l.cuenta, deudor);
    }
  }

  const fuente = opts.incluirCierre ? todos.filter((a) => a.fecha <= periodo.hasta) : sinCierre;
  const asientos = ordenarAsientos(fuente.filter((a) => a.fecha >= periodo.desde && a.fecha <= periodo.hasta));
  return { saldosIniciales, asientos };
}

// ---------------------------------------------------------------------------
// Nombres de cuentas
// ---------------------------------------------------------------------------

/**
 * Nombre de una cuenta: el del plan contable (el de la empresa manda sobre el
 * base); si la subcuenta no esta en el plan, el de su cuenta padre mas larga;
 * si tampoco, el nombre con el que se grabo el apunte.
 */
export function crearNombrador(plan: Map<string, string>, nombresApuntes: Map<string, string> = new Map()) {
  return (cuenta: string): string => {
    const exacto = plan.get(cuenta);
    if (exacto) return exacto;
    for (let n = cuenta.length - 1; n >= 1; n--) {
      const padre = plan.get(cuenta.slice(0, n));
      if (padre) return padre;
    }
    return nombresApuntes.get(cuenta) ?? '';
  };
}

// ---------------------------------------------------------------------------
// Balance de sumas y saldos
// ---------------------------------------------------------------------------

export type NivelSumas = 'subcuenta' | 3 | 4;

export interface FilaSumasSaldos {
  cuenta: string;
  nombre: string;
  saldoInicial: number;
  debe: number;
  haber: number;
  saldoDeudor: number;
  saldoAcreedor: number;
}

export interface SumasYSaldos {
  filas: FilaSumasSaldos[];
  /**
   * Por subcuenta: total de cada cuenta de 3 digitos (430, 400, 410...) que
   * tiene subcuentas, en el orden de las filas. Vacio en los niveles 3 y 4.
   */
  subtotales: FilaSumasSaldos[];
  totales: Omit<FilaSumasSaldos, 'cuenta' | 'nombre'>;
  /** Debe y haber del periodo iguales, y saldos deudores = acreedores. */
  cuadra: boolean;
}

export interface OpcionesSumas {
  /** Solo las cuentas de ese prefijo o rango (430-430 = solo clientes). */
  filtro?: FiltroCuentas;
  /**
   * Por subcuenta, cuentas del plan sin movimientos en el periodo (salen a
   * cero). Sin ellas, solo salen las que tienen saldo o movimientos.
   */
  cuentasSinMovimiento?: string[];
}

const sumarFilas = (filas: FilaSumasSaldos[]) =>
  filas.reduce(
    (t, f) => ({
      saldoInicial: round2(t.saldoInicial + f.saldoInicial),
      debe: round2(t.debe + f.debe),
      haber: round2(t.haber + f.haber),
      saldoDeudor: round2(t.saldoDeudor + f.saldoDeudor),
      saldoAcreedor: round2(t.saldoAcreedor + f.saldoAcreedor),
    }),
    { saldoInicial: 0, debe: 0, haber: 0, saldoDeudor: 0, saldoAcreedor: 0 },
  );

/**
 * Subtotal por cuenta de 3 digitos de las filas (por subcuenta): uno por cada
 * grupo que tiene alguna subcuenta (un grupo que es solo la propia cuenta de 3
 * digitos no lo necesita). Las sumas son las de sus filas: el saldo deudor y el
 * acreedor no se compensan entre subcuentas (un cliente con saldo acreedor
 * sigue sumando en la columna acreedora).
 */
export function subtotalesPorCuenta(filas: FilaSumasSaldos[], nombre: (cuenta: string) => string): FilaSumasSaldos[] {
  const grupos = new Map<string, FilaSumasSaldos[]>();
  for (const f of filas) {
    const g = f.cuenta.slice(0, 3);
    if (!grupos.has(g)) grupos.set(g, []);
    grupos.get(g)!.push(f);
  }
  const out: FilaSumasSaldos[] = [];
  for (const [g, fs] of grupos) {
    if (fs.length === 1 && fs[0].cuenta === g) continue;
    out.push({ cuenta: g, nombre: nombre(g), ...sumarFilas(fs) });
  }
  return out;
}

export function calcularSumasYSaldos(
  mov: MovimientosPeriodo,
  nivel: NivelSumas,
  nombre: (cuenta: string) => string,
  opciones: OpcionesSumas = {},
): SumasYSaldos {
  const entra = (cuenta: string) => !opciones.filtro || cuentaEnFiltro(cuenta, opciones.filtro);
  const clave = (cuenta: string) => (nivel === 'subcuenta' ? cuenta : cuenta.slice(0, nivel));
  const mapa = new Map<string, { inicial: number; debe: number; haber: number }>();
  const fila = (c: string) => {
    let f = mapa.get(c);
    if (!f) mapa.set(c, (f = { inicial: 0, debe: 0, haber: 0 }));
    return f;
  };
  for (const [cuenta, saldo] of mov.saldosIniciales) if (entra(cuenta)) fila(clave(cuenta)).inicial += saldo;
  for (const a of mov.asientos) {
    for (const l of a.lineas) {
      if (!entra(l.cuenta)) continue;
      const f = fila(clave(l.cuenta));
      f.debe += l.debe;
      f.haber += l.haber;
    }
  }

  const filas: FilaSumasSaldos[] = [...mapa.entries()]
    .map(([cuenta, f]) => {
      const final = round2(f.inicial + f.debe - f.haber);
      return {
        cuenta,
        nombre: nombre(cuenta),
        saldoInicial: round2(f.inicial),
        debe: round2(f.debe),
        haber: round2(f.haber),
        saldoDeudor: final > 0 ? final : 0,
        saldoAcreedor: final < 0 ? -final : 0,
      };
    })
    .filter((f) => f.saldoInicial || f.debe || f.haber);
  if (nivel === 'subcuenta') {
    const ya = new Set(filas.map((f) => f.cuenta));
    for (const c of opciones.cuentasSinMovimiento ?? []) {
      if (ya.has(c) || !entra(c)) continue;
      ya.add(c);
      filas.push({ cuenta: c, nombre: nombre(c), saldoInicial: 0, debe: 0, haber: 0, saldoDeudor: 0, saldoAcreedor: 0 });
    }
  }
  filas.sort((a, b) => a.cuenta.localeCompare(b.cuenta));

  const totales = sumarFilas(filas);
  const cuadra = Math.abs(totales.debe - totales.haber) < 0.005 && Math.abs(totales.saldoDeudor - totales.saldoAcreedor) < 0.005;
  return { filas, subtotales: nivel === 'subcuenta' ? subtotalesPorCuenta(filas, nombre) : [], totales, cuadra };
}

// ---------------------------------------------------------------------------
// Libro mayor
// ---------------------------------------------------------------------------

/** Que cuentas entran: un prefijo ('572' = todas las 572...) o un rango. */
export interface FiltroCuentas {
  cuenta?: string;
  desde?: string;
  hasta?: string;
  /** Solo estas cuentas exactas (las subcuentas de un cliente o proveedor). */
  lista?: string[];
}

export function cuentaEnFiltro(cuenta: string, f: FiltroCuentas): boolean {
  if (f.lista) return f.lista.includes(cuenta);
  if (f.cuenta) return cuenta.startsWith(f.cuenta);
  if (f.desde && cuenta.slice(0, f.desde.length) < f.desde) return false;
  if (f.hasta && cuenta.slice(0, f.hasta.length) > f.hasta) return false;
  return true;
}

export interface MovimientoMayor {
  fecha: string;
  asiento: string;
  asientoId: string;
  concepto: string;
  referencia: string | null;
  debe: number;
  haber: number;
  saldo: number;
}

export interface CuentaMayor {
  cuenta: string;
  nombre: string;
  saldoInicial: number;
  movimientos: MovimientoMayor[];
  totalDebe: number;
  totalHaber: number;
  saldoFinal: number;
}

export function calcularMayor(mov: MovimientosPeriodo, filtro: FiltroCuentas, nombre: (cuenta: string) => string): CuentaMayor[] {
  const cuentas = new Map<string, CuentaMayor>();
  const cuentaMayor = (c: string) => {
    let m = cuentas.get(c);
    if (!m) cuentas.set(c, (m = { cuenta: c, nombre: nombre(c), saldoInicial: 0, movimientos: [], totalDebe: 0, totalHaber: 0, saldoFinal: 0 }));
    return m;
  };
  for (const [c, saldo] of mov.saldosIniciales) {
    if (saldo && cuentaEnFiltro(c, filtro)) cuentaMayor(c).saldoInicial = saldo;
  }
  for (const a of mov.asientos) {
    for (const l of a.lineas) {
      if (!cuentaEnFiltro(l.cuenta, filtro)) continue;
      cuentaMayor(l.cuenta).movimientos.push({
        fecha: a.fecha,
        asiento: a.numero,
        asientoId: a.id,
        concepto: a.concepto,
        referencia: l.referencia,
        debe: round2(l.debe),
        haber: round2(l.haber),
        saldo: 0,
      });
    }
  }
  const lista = [...cuentas.values()].sort((a, b) => a.cuenta.localeCompare(b.cuenta));
  for (const c of lista) {
    let saldo = c.saldoInicial;
    for (const m of c.movimientos) {
      saldo = round2(saldo + m.debe - m.haber);
      m.saldo = saldo;
      c.totalDebe = round2(c.totalDebe + m.debe);
      c.totalHaber = round2(c.totalHaber + m.haber);
    }
    c.saldoFinal = saldo;
  }
  return lista;
}

// ---------------------------------------------------------------------------
// Libro diario
// ---------------------------------------------------------------------------

export interface AsientoDiario {
  id: string;
  fecha: string;
  numero: string;
  concepto: string;
  tipo: TipoAsiento;
  lineas: Array<{ cuenta: string; nombre: string; debe: number; haber: number; referencia: string | null }>;
  debe: number;
  haber: number;
}

export function calcularDiario(asientos: AsientoInforme[], nombre: (cuenta: string) => string) {
  let totalDebe = 0;
  let totalHaber = 0;
  const lista: AsientoDiario[] = ordenarAsientos(asientos).map((a) => {
    const debe = round2(a.lineas.reduce((s, l) => s + l.debe, 0));
    const haber = round2(a.lineas.reduce((s, l) => s + l.haber, 0));
    totalDebe += debe;
    totalHaber += haber;
    return {
      id: a.id,
      fecha: a.fecha,
      numero: a.numero,
      concepto: a.concepto,
      tipo: a.tipo,
      lineas: a.lineas.map((l) => ({ cuenta: l.cuenta, nombre: nombre(l.cuenta), debe: round2(l.debe), haber: round2(l.haber), referencia: l.referencia })),
      debe,
      haber,
    };
  });
  return { asientos: lista, totalDebe: round2(totalDebe), totalHaber: round2(totalHaber) };
}

// ---------------------------------------------------------------------------
// Mayor de clientes y proveedores
// ---------------------------------------------------------------------------

export type TipoTercero = 'clientes' | 'proveedores';

/** Cuentas de terceros: clientes 43x; proveedores 40x y acreedores 41x. */
export const PREFIJOS_TERCERO: Record<TipoTercero, string[]> = {
  clientes: ['43'],
  proveedores: ['40', '41'],
};

export const esCuentaDeTercero = (tipo: TipoTercero, cuenta: string): boolean =>
  PREFIJOS_TERCERO[tipo].some((p) => cuenta.startsWith(p));

export const SIN_IDENTIFICAR = 'sin-identificar';

/** Factura que ayuda a identificar al tercero de un apunte. */
export interface FacturaTercero {
  id: string;
  numero: string | null;
  terceroId: string;
}

export interface FichaTercero {
  id: string;
  nombre: string;
  nif: string | null;
  /** Subcuentas propias de la ficha (430N; 400N y 410N). */
  subcuentas?: string[];
}

/**
 * Datos para identificar terceros: facturas del tipo (ventas para clientes,
 * compras para proveedores) y fichas de clientes/proveedores.
 */
export interface ContextoTerceros {
  tipo: TipoTercero;
  facturas: FacturaTercero[];
  fichas: FichaTercero[];
}

export interface ResolvedorTercero {
  /** Clave del tercero de un apunte: id de la ficha, 'subcuenta:<codigo>' o SIN_IDENTIFICAR. */
  clave(asiento: AsientoInforme, linea: LineaInforme): string;
  /** Factura enlazada al apunte (numero), si se sabe. */
  factura(asiento: AsientoInforme, linea: LineaInforme): string | null;
  nombre(clave: string, nombreCuenta: (c: string) => string): { nombre: string; nif: string | null };
}

/**
 * Criterio para saber de que cliente o proveedor es un apunte de 43x/40x/41x:
 *
 *  1. La subcuenta es la propia de una ficha (430N, 400N, 410N): esa ficha.
 *     Asi el saldo por tercero cuadra con el Libro mayor de su subcuenta,
 *     aunque el asiento este enlazado a una factura de otro (mal imputado).
 *  Para los apuntes en la generica (430, 400, 410, de antes de las subcuentas):
 *  2. El asiento esta enlazado a una factura (JournalEntry.invoiceId, con
 *     invoiceType INGRESO para clientes y GASTO para proveedores): su tercero.
 *  3. La referencia del apunte es el numero o el id de una factura del tipo.
 *  4. El concepto del asiento menciona la factura ("Cobro factura X").
 *  5. La subcuenta es de un tercero sin ficha (mas de 3 digitos y no todo
 *     ceros, p. ej. importada de otro programa): se agrupa por subcuenta.
 *  6. Si no, "Sin identificar" (p. ej. un cobro de tesoreria sin factura).
 */
export function crearResolvedorTercero(ctx: ContextoTerceros): ResolvedorTercero {
  const tipoFactura = ctx.tipo === 'clientes' ? 'INGRESO' : 'GASTO';
  const porId = new Map(ctx.facturas.map((f) => [f.id, f]));
  const porNumero = new Map(ctx.facturas.filter((f) => f.numero).map((f) => [f.numero!.toUpperCase(), f]));
  const fichas = new Map(ctx.fichas.map((f) => [f.id, f]));
  const porSubcuenta = new Map<string, string>();
  for (const f of ctx.fichas) for (const c of f.subcuentas ?? []) porSubcuenta.set(c, f.id);

  const buscarFactura = (a: AsientoInforme, l: LineaInforme): FacturaTercero | undefined => {
    if (a.invoiceId && (!a.invoiceType || a.invoiceType === tipoFactura)) {
      const f = porId.get(a.invoiceId);
      if (f) return f;
    }
    if (l.referencia) {
      const ref = l.referencia.replace(/^REV-/, '').trim();
      const f = porId.get(ref) ?? porNumero.get(ref.toUpperCase());
      if (f) return f;
    }
    // "Cobro factura X", "Factura nº X", "Factura #X"
    const m = /factura\s+(?:n[º°.]\s*)?#?(\S+)/i.exec(a.concepto ?? '');
    if (m) {
      const ref = m[1].replace(/[.,;:)]+$/, '');
      return porId.get(ref) ?? porNumero.get(ref.toUpperCase());
    }
    return undefined;
  };

  return {
    clave(a, l) {
      const propia = porSubcuenta.get(l.cuenta);
      if (propia) return propia;
      const f = buscarFactura(a, l);
      if (f) return f.terceroId;
      if (l.cuenta.length > 3 && /[1-9]/.test(l.cuenta.slice(3))) return `subcuenta:${l.cuenta}`;
      return SIN_IDENTIFICAR;
    },
    factura(a, l) {
      const f = buscarFactura(a, l);
      if (f?.numero) return f.numero;
      // Una referencia que es un id interno (cuid) no le dice nada al usuario.
      return l.referencia && !/^c[a-z0-9]{20,}$/.test(l.referencia) ? l.referencia : null;
    },
    nombre(clave, nombreCuenta) {
      if (clave === SIN_IDENTIFICAR) return { nombre: 'Sin identificar', nif: null };
      if (clave.startsWith('subcuenta:')) {
        const cuenta = clave.slice('subcuenta:'.length);
        const n = nombreCuenta(cuenta);
        return { nombre: `Subcuenta ${cuenta}${n ? ` · ${n}` : ''}`, nif: null };
      }
      const f = fichas.get(clave);
      return { nombre: f?.nombre ?? 'Tercero eliminado', nif: f?.nif ?? null };
    },
  };
}

/**
 * Para los terceros no sirve partir de la apertura: el asiento de apertura
 * lleva la 430/400 en una sola linea y se perderia el detalle por cliente. Se
 * acumula toda la historia sin apertura, regularizacion ni cierre. Solo se
 * respeta una apertura que no tiene nada antes (la que trae los saldos de una
 * empresa que empieza a llevar la contabilidad aqui).
 *
 * `inicio`: si el año anterior lo llevo la gestoria (Traer la contabilidad de
 * 2026), su apertura ya trae el saldo de cada subcuenta de cliente y
 * proveedor: se parte de ella y lo anterior (el diario historico) no se suma.
 */
export function asientosParaTerceros(todos: AsientoInforme[], hasta: string, inicio?: string | null): AsientoInforme[] {
  if (inicio) return todos.filter((a) => a.fecha >= inicio && a.fecha <= hasta && a.tipo !== 'REGULARIZACION' && a.tipo !== 'CIERRE');
  const validos = todos.filter((a) => a.fecha <= hasta && a.tipo !== 'REGULARIZACION' && a.tipo !== 'CIERRE');
  const primeraNormal = validos.filter((a) => a.tipo !== 'APERTURA').reduce((m, a) => (!m || a.fecha < m ? a.fecha : m), '');
  return validos.filter((a) => a.tipo !== 'APERTURA' || !primeraNormal || a.fecha <= primeraNormal);
}

export interface MovimientoTercero {
  fecha: string;
  asiento: string;
  asientoId: string;
  concepto: string;
  cuenta: string;
  factura: string | null;
  debe: number;
  haber: number;
  saldo: number;
}

export interface SaldoTercero {
  id: string;
  nombre: string;
  nif: string | null;
  cuentas: string[];
  saldoInicial: number;
  debe: number;
  haber: number;
  saldoFinal: number;
  movimientos: MovimientoTercero[];
}

/**
 * Saldos por tercero en el periodo. El saldo va con el signo natural del tipo:
 * en clientes, lo que nos deben (debe - haber); en proveedores, lo que les
 * debemos (haber - debe). Un saldo negativo es un anticipo o un cobro/pago de mas.
 */
export function calcularMayorTerceros(
  todos: AsientoInforme[],
  periodo: Periodo,
  ctx: ContextoTerceros,
  nombreCuenta: (c: string) => string,
  inicio?: string | null,
): SaldoTercero[] {
  const resolvedor = crearResolvedorTercero(ctx);
  const signo = ctx.tipo === 'clientes' ? 1 : -1;
  const mapa = new Map<string, SaldoTercero & { _cuentas: Set<string> }>();
  const tercero = (clave: string) => {
    let t = mapa.get(clave);
    if (!t) {
      const { nombre, nif } = resolvedor.nombre(clave, nombreCuenta);
      t = { id: clave, nombre, nif, cuentas: [], saldoInicial: 0, debe: 0, haber: 0, saldoFinal: 0, movimientos: [], _cuentas: new Set() };
      mapa.set(clave, t);
    }
    return t;
  };

  for (const a of ordenarAsientos(asientosParaTerceros(todos, periodo.hasta, inicio))) {
    for (const l of a.lineas) {
      if (!esCuentaDeTercero(ctx.tipo, l.cuenta)) continue;
      const t = tercero(resolvedor.clave(a, l));
      t._cuentas.add(l.cuenta);
      if (a.fecha < periodo.desde) {
        t.saldoInicial = round2(t.saldoInicial + signo * (l.debe - l.haber));
        continue;
      }
      t.debe = round2(t.debe + l.debe);
      t.haber = round2(t.haber + l.haber);
      t.movimientos.push({
        fecha: a.fecha,
        asiento: a.numero,
        asientoId: a.id,
        concepto: a.concepto,
        cuenta: l.cuenta,
        factura: resolvedor.factura(a, l),
        debe: round2(l.debe),
        haber: round2(l.haber),
        saldo: 0,
      });
    }
  }

  const lista = [...mapa.values()].map(({ _cuentas, ...t }) => {
    let saldo = t.saldoInicial;
    for (const m of t.movimientos) {
      saldo = round2(saldo + signo * (m.debe - m.haber));
      m.saldo = saldo;
    }
    return { ...t, cuentas: [..._cuentas].sort(), saldoFinal: saldo };
  });
  // Primero los que tienen ficha, por nombre; al final subcuentas sueltas y sin identificar.
  const peso = (t: SaldoTercero) => (t.id === SIN_IDENTIFICAR ? 2 : t.id.startsWith('subcuenta:') ? 1 : 0);
  return lista
    .filter((t) => t.saldoInicial || t.debe || t.haber)
    .sort((a, b) => peso(a) - peso(b) || a.nombre.localeCompare(b.nombre, 'es'));
}
