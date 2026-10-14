/**
 * Apuntes contables (las lineas de los asientos) para Contabilidad >
 * Movimientos: listado paginado con filtros y totales, y la misma consulta en
 * PDF y Excel con el exportador comun de los informes.
 *
 * El filtro, el recuento, las sumas y la pagina se hacen en la base con SQL:
 * nunca se trae todo a memoria. Solo la pagina pedida (o la descarga) se
 * completa despues con el nombre de cada cuenta, el documento de origen y el
 * cliente o proveedor.
 *
 * Que asientos salen: los aprobados (POSTED) y los borradores (DRAFT y
 * PENDING_REVIEW), estos marcados. Los anulados (REVERSED) y los retirados al
 * traer la contabilidad de la gestoria (SUSTITUIDO) no salen, igual que en el
 * mayor y el diario. La regularizacion y el cierre del ejercicio (tambien los
 * del diario de la gestoria) no salen salvo que se pidan (incluirCierre), como
 * en el diario: dejan las cuentas a cero el 31-12 y, con ellos, la diferencia
 * de una cuenta o de un cliente ya no seria su saldo.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { badRequest } from '../utils/http-errors';
import { validarEjercicio } from '../utils/anios';
import { tipoAsiento, type TipoAsiento } from './contabilidadDatos.service';
import { fechaES, num, textoPeriodo, type FilaInforme, type TablaInforme } from './informesContables.documentos';
import { datosEmpresa, terceroParaMayor, type TerceroDelMayor } from './informesContables.service';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

// ---------------------------------------------------------------------------
// Filtro
// ---------------------------------------------------------------------------

export type EstadoApuntes = 'todos' | 'aprobados' | 'borradores';

/** Estados de asiento de cada opcion. Los borradores son DRAFT y PENDING_REVIEW. */
const ESTADOS: Record<EstadoApuntes, string[]> = {
  todos: ['POSTED', 'DRAFT', 'PENDING_REVIEW'],
  aprobados: ['POSTED'],
  borradores: ['DRAFT', 'PENDING_REVIEW'],
};

export interface PeriodoApuntes {
  desde: string; // AAAA-MM-DD
  hasta: string; // AAAA-MM-DD
  /** «1.er trimestre de 2026», «marzo de 2026» o «Ejercicio 2026»; null con fechas sueltas. */
  nombre: string | null;
}

export interface FiltroApuntes {
  periodo: PeriodoApuntes;
  /** Cuenta o prefijo: 43 trae todas las 43…; 4300001, solo esa subcuenta. */
  cuenta?: string;
  /** Cliente o proveedor: los apuntes de su cuenta (ver condicionTercero). */
  tercero?: TerceroDelMayor;
  /** Texto en el concepto del asiento, su numero o la referencia del apunte. */
  texto?: string;
  estado: EstadoApuntes;
  /** Importe del apunte (Debe o Haber, sin signo). */
  importeMin?: number;
  importeMax?: number;
  /** Con la regularizacion y el cierre del ejercicio (por defecto no salen, como en el diario). */
  incluirCierre: boolean;
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const ultimoDia = (anio: number, mes: number) => new Date(Date.UTC(anio, mes, 0)).getUTCDate();
const dos = (n: number) => String(n).padStart(2, '0');

/** AAAA-MM-DD y una fecha que existe (el 30-02 no). */
function fechaValida(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= ultimoDia(y, m);
}

const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/**
 * Periodo de la consulta: el año (ejercicio) con un trimestre (1-4) o un mes
 * (1-12), si se piden; y las fechas desde y hasta, que mandan sobre el limite
 * que dan. Sin año, con las fechas solas (si falta una, el principio o el
 * final del año de la otra).
 */
export function periodoApuntes(q: Record<string, unknown>): PeriodoApuntes {
  const desdeQ = texto(q.desde);
  const hastaQ = texto(q.hasta);
  if (desdeQ && !fechaValida(desdeQ)) throw badRequest('La fecha «desde» no es válida. Usa el formato AAAA-MM-DD.', { campo: 'desde' });
  if (hastaQ && !fechaValida(hastaQ)) throw badRequest('La fecha «hasta» no es válida. Usa el formato AAAA-MM-DD.', { campo: 'hasta' });

  let base: PeriodoApuntes | null = null;
  if (texto(q.ejercicio)) {
    const anio = validarEjercicio(texto(q.ejercicio));
    const t = texto(q.trimestre);
    const m = texto(q.mes);
    if (t && m) throw badRequest('Elige un trimestre o un mes, no los dos.', { campo: 'trimestre' });
    if (t) {
      if (!/^[1-4]$/.test(t)) throw badRequest('El trimestre va del 1 al 4.', { campo: 'trimestre' });
      const n = Number(t);
      base = {
        desde: `${anio}-${dos((n - 1) * 3 + 1)}-01`,
        hasta: `${anio}-${dos(n * 3)}-${ultimoDia(anio, n * 3)}`,
        nombre: `${n}.${n === 1 || n === 3 ? 'er' : 'º'} trimestre de ${anio}`,
      };
    } else if (m) {
      if (!/^(0?[1-9]|1[0-2])$/.test(m)) throw badRequest('El mes va del 1 al 12.', { campo: 'mes' });
      const n = Number(m);
      base = { desde: `${anio}-${dos(n)}-01`, hasta: `${anio}-${dos(n)}-${ultimoDia(anio, n)}`, nombre: `${MESES[n - 1]} de ${anio}` };
    } else {
      base = { desde: `${anio}-01-01`, hasta: `${anio}-12-31`, nombre: `Ejercicio ${anio}` };
    }
  }
  if (!base && !desdeQ && !hastaQ) throw badRequest('Indica el año o las fechas desde y hasta.', { campo: 'ejercicio' });
  const desde = desdeQ || base?.desde || `${hastaQ.slice(0, 4)}-01-01`;
  const hasta = hastaQ || base?.hasta || `${desdeQ.slice(0, 4)}-12-31`;
  if (desde > hasta) throw badRequest('La fecha «desde» es posterior a la fecha «hasta».', { campo: 'desde' });
  return { desde, hasta, nombre: desdeQ || hastaQ ? null : (base?.nombre ?? null) };
}

/** Importe escrito como 1250,50, 1.250,50 o 1250.50 (sin signo). */
function importeDeConsulta(v: unknown, campo: 'importeMin' | 'importeMax'): number | undefined {
  let s = texto(v).replace(/[\s€]/g, '');
  if (!s) return undefined;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const cual = campo === 'importeMin' ? 'mínimo' : 'máximo';
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw badRequest(`El importe ${cual} no es válido. Escríbelo sin signo y con dos decimales como mucho, por ejemplo 1250,50.`, { campo });
  return Number(s);
}

function estadoDeConsulta(v: unknown): EstadoApuntes {
  const s = texto(v).toLowerCase();
  if (!s) return 'todos';
  if (s === 'todos' || s === 'aprobados' || s === 'borradores') return s;
  throw badRequest('El estado tiene que ser todos, aprobados o borradores.', { campo: 'estado' });
}

/** cliente | proveedor (tambien clientes | proveedores). */
function tipoFicha(v: unknown): 'cliente' | 'proveedor' {
  const s = texto(v);
  if (s === 'cliente' || s === 'clientes') return 'cliente';
  if (s === 'proveedor' || s === 'proveedores') return 'proveedor';
  throw badRequest('Indica si es un cliente o un proveedor (tipoTercero=cliente o proveedor).', { campo: 'tipoTercero' });
}

/** 1, true o si (como el incluirCierre del diario). */
const si = (v: unknown) => ['1', 'true', 'si', 'sí'].includes(texto(v).toLowerCase());

/** Filtro de la consulta (?ejercicio=&trimestre=&mes=&desde=&hasta=&cuenta=&tercero=&tipoTercero=&texto=&estado=&importeMin=&importeMax=&incluirCierre=1). */
export async function filtroApuntesDeConsulta(companyId: string, q: Record<string, unknown>): Promise<FiltroApuntes> {
  const periodo = periodoApuntes(q);
  const cuenta = texto(q.cuenta).replace(/\D/g, '') || undefined;
  if (texto(q.cuenta) && !cuenta) throw badRequest('La cuenta se escribe con números, por ejemplo 43 o 572.', { campo: 'cuenta' });
  const terceroId = texto(q.tercero);
  // 404 si el cliente o proveedor no es de esta empresa.
  const tercero = terceroId ? await terceroParaMayor(companyId, tipoFicha(q.tipoTercero), terceroId) : undefined;
  const t = texto(q.texto ?? q.q).slice(0, 100) || undefined;
  const importeMin = importeDeConsulta(q.importeMin, 'importeMin');
  const importeMax = importeDeConsulta(q.importeMax, 'importeMax');
  if (importeMin !== undefined && importeMax !== undefined && importeMin > importeMax) {
    throw badRequest('El importe mínimo es mayor que el máximo.', { campo: 'importeMin' });
  }
  return { periodo, cuenta, tercero, texto: t, estado: estadoDeConsulta(q.estado), importeMin, importeMax, incluirCierre: si(q.incluirCierre) };
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const inicioDia = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const diaSiguiente = (iso: string) => {
  const d = inicioDia(iso);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
};
/** % y _ se buscan como texto, no como comodines. */
const escaparLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Apuntes de un cliente o proveedor: los de sus subcuentas y, de antes de las
 * subcuentas, los de la cuenta general (43 en clientes; 40 y 41 en
 * proveedores) de un asiento enlazado a una factura suya o a una partida
 * pendiente suya de la carga. Una subcuenta propia de otra ficha nunca cuenta
 * como general. Es el mismo criterio que el mayor de clientes y proveedores
 * (crearResolvedorTercero, puntos 1 y 2).
 */
function condicionTercero(companyId: string, t: TerceroDelMayor): Prisma.Sql {
  const cliente = t.tipo === 'cliente';
  const prefijos = (cliente ? ['43'] : ['40', '41']).map((p) => Prisma.sql`l.accountCode LIKE ${`${p}%`}`);
  const documentos = cliente
    ? Prisma.sql`(e.invoiceType = 'INGRESO' AND e.invoiceId IN (SELECT i.id FROM IncomeInvoice i WHERE i.companyId = ${companyId} AND i.customerId = ${t.id}))
        OR (e.invoiceType = 'PARTIDA' AND e.invoiceId IN (SELECT p.id FROM PartidaPendiente p WHERE p.companyId = ${companyId} AND p.customerId = ${t.id}))`
    : Prisma.sql`(e.invoiceType = 'GASTO' AND e.invoiceId IN (SELECT g.id FROM ExpenseInvoice g WHERE g.companyId = ${companyId} AND g.supplierId = ${t.id}))
        OR (e.invoiceType = 'PARTIDA' AND e.invoiceId IN (SELECT p.id FROM PartidaPendiente p WHERE p.companyId = ${companyId} AND p.supplierId = ${t.id}))`;
  const deOtraFicha = Prisma.sql`l.accountCode NOT IN (
      SELECT c.subcuenta430 FROM Customer c WHERE c.companyId = ${companyId} AND c.subcuenta430 IS NOT NULL
      UNION SELECT s.subcuenta400 FROM Supplier s WHERE s.companyId = ${companyId} AND s.subcuenta400 IS NOT NULL
      UNION SELECT s.subcuenta410 FROM Supplier s WHERE s.companyId = ${companyId} AND s.subcuenta410 IS NOT NULL)`;
  const general = Prisma.sql`((${Prisma.join(prefijos, ' OR ')}) AND (${documentos}) AND ${deOtraFicha})`;
  if (!t.subcuentas.length) return general;
  return Prisma.sql`(l.accountCode IN (${Prisma.join(t.subcuentas)}) OR ${general})`;
}

/**
 * Tipo del asiento en SQL, igual que tipoAsiento(): por su origen o, en los
 * creados antes de guardarlo (el cierre iba como AJUSTE_MANUAL), por el
 * principio de su concepto. En TiDB las comparaciones distinguen mayusculas
 * (utf8mb4_bin): de ahi UPPER y LOWER.
 */
const ORIGEN = Prisma.sql`UPPER(COALESCE(e.origen, ''))`;
const CONCEPTO = Prisma.sql`LOWER(TRIM(e.descripcion))`;
const TIPO_SQL = Prisma.sql`(CASE
  WHEN ${ORIGEN} LIKE 'HISTORICO%' THEN (CASE ${ORIGEN}
    WHEN 'HISTORICO_APERTURA' THEN 'APERTURA' WHEN 'HISTORICO_REGULARIZACION' THEN 'REGULARIZACION' WHEN 'HISTORICO_CIERRE' THEN 'CIERRE' ELSE 'NORMAL' END)
  WHEN ${ORIGEN} IN ('APERTURA', 'APERTURA_AJUSTE') OR ${CONCEPTO} LIKE 'apertura ejercicio%' THEN 'APERTURA'
  WHEN ${ORIGEN} = 'REGULARIZACION' OR ${CONCEPTO} LIKE 'regularizacion ejercicio%' OR ${CONCEPTO} LIKE 'regularización ejercicio%' THEN 'REGULARIZACION'
  WHEN ${ORIGEN} IN ('CIERRE', 'CIERRE_AUTOMATICO') OR ${CONCEPTO} LIKE 'cierre ejercicio%' OR ${CONCEPTO} LIKE 'cierre contable%' THEN 'CIERRE'
  ELSE 'NORMAL' END)`;
/** Apunte de la regularizacion o del cierre del ejercicio. */
const ES_CIERRE = Prisma.sql`(${TIPO_SQL} IN ('REGULARIZACION', 'CIERRE'))`;

/**
 * Condiciones del filtro. Con `todosLosTipos` no quita la regularizacion ni el
 * cierre aunque no se pidan (los totales los cuentan aparte).
 */
function condiciones(companyId: string, f: FiltroApuntes, opts: { todosLosTipos?: boolean } = {}): Prisma.Sql {
  const partes: Prisma.Sql[] = [
    Prisma.sql`e.companyId = ${companyId}`,
    Prisma.sql`l.companyId = ${companyId}`,
    Prisma.sql`e.fecha >= ${inicioDia(f.periodo.desde)}`,
    Prisma.sql`e.fecha < ${diaSiguiente(f.periodo.hasta)}`,
    Prisma.sql`e.estado IN (${Prisma.join(ESTADOS[f.estado])})`,
  ];
  if (!f.incluirCierre && !opts.todosLosTipos) partes.push(Prisma.sql`NOT ${ES_CIERRE}`);
  if (f.cuenta) partes.push(Prisma.sql`l.accountCode LIKE ${`${f.cuenta}%`}`);
  if (f.tercero) partes.push(condicionTercero(companyId, f.tercero));
  if (f.texto) {
    // LOWER en los dos lados: en TiDB la comparacion distingue mayusculas (utf8mb4_bin).
    const patron = `%${escaparLike(f.texto.toLowerCase())}%`;
    partes.push(Prisma.sql`(LOWER(e.descripcion) LIKE ${patron} OR LOWER(e.numeroAsiento) LIKE ${patron} OR LOWER(COALESCE(l.referencia, '')) LIKE ${patron})`);
  }
  if (f.importeMin !== undefined) partes.push(Prisma.sql`GREATEST(ABS(l.debe), ABS(l.haber)) >= ${f.importeMin}`);
  if (f.importeMax !== undefined) partes.push(Prisma.sql`GREATEST(ABS(l.debe), ABS(l.haber)) <= ${f.importeMax}`);
  return Prisma.join(partes, ' AND ');
}

/**
 * Orden del diario: fecha; en el mismo dia, la apertura primero, despues los
 * asientos normales, los cobros y pagos, la regularizacion y por ultimo el
 * cierre (el turno de ordenarAsientos); despues el numero de asiento; y dentro
 * del asiento, como el diario, de mas Debe a menos y en el orden en que se
 * grabaron.
 *
 * Los textos se ordenan por sus primeros caracteres (CAST AS CHAR(n)): con la
 * columna entera (VARCHAR(191) utf8mb4) cada clave de ordenacion ocupa varios
 * KB y, con 300.000 apuntes, una pagina del final tardaba 16-30 s en MariaDB;
 * asi, unos 2 s. Los ids (cuid) caben enteros. El numero se ordena como texto
 * (el diario lo compara por sus cifras: FAC-9 antes que FAC-10).
 */
const ORDEN = Prisma.sql`ORDER BY e.fecha ASC,
  CASE ${TIPO_SQL} WHEN 'APERTURA' THEN 0 WHEN 'REGULARIZACION' THEN 3 WHEN 'CIERRE' THEN 4
    ELSE (CASE WHEN e.origen IN ('TESORERIA', 'NOMINA_PAGO') THEN 2 ELSE 1 END) END ASC,
  CAST(e.numeroAsiento AS CHAR(40)) ASC, CAST(e.id AS CHAR(32)) ASC,
  l.debe DESC, l.createdAt ASC, CAST(l.id AS CHAR(32)) ASC`;

interface FilaSql {
  id: string;
  cuenta: string;
  nombreApunte: string;
  debe: unknown;
  haber: unknown;
  referencia: string | null;
  asientoId: string;
  fecha: Date;
  numeroAsiento: string;
  descripcion: string;
  estado: string;
  origen: string | null;
  invoiceId: string | null;
  invoiceType: string | null;
}

const aNumero = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  const n = Number(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
};

async function filasSql(companyId: string, f: FiltroApuntes, limite: number, saltar: number): Promise<FilaSql[]> {
  return prisma.$queryRaw<FilaSql[]>`
    SELECT l.id, l.accountCode AS cuenta, l.accountName AS nombreApunte, l.debe, l.haber, l.referencia,
           e.id AS asientoId, e.fecha, e.numeroAsiento, e.descripcion, e.estado, e.origen, e.invoiceId, e.invoiceType
    FROM JournalEntryLine l
    JOIN JournalEntry e ON e.id = l.entryId
    WHERE ${condiciones(companyId, f)}
    ${ORDEN}
    LIMIT ${limite} OFFSET ${saltar}`;
}

export interface TotalesApuntes {
  /** Apuntes que cumplen el filtro. */
  apuntes: number;
  debe: number;
  haber: number;
  /** Debe − Haber: positivo, saldo deudor; negativo, acreedor. */
  diferencia: number;
  /** De ellos, apuntes de asientos en borrador. */
  enBorrador: number;
  /**
   * Apuntes de la regularizacion y el cierre que cumplen el resto del filtro:
   * los que salen si se piden y, si no, los que se han quitado (la pantalla
   * avisa de que existen).
   */
  deCierre: number;
}

async function totalesSql(companyId: string, f: FiltroApuntes): Promise<TotalesApuntes> {
  // Una sola pasada: los que salen y, aparte, los de la regularizacion y el cierre.
  const sale = f.incluirCierre ? Prisma.sql`1 = 1` : Prisma.sql`NOT ${ES_CIERRE}`;
  const [r] = await prisma.$queryRaw<Array<{ n: unknown; debe: unknown; haber: unknown; borradores: unknown; deCierre: unknown }>>`
    SELECT COALESCE(SUM(CASE WHEN ${sale} THEN 1 ELSE 0 END), 0) AS n,
           COALESCE(SUM(CASE WHEN ${sale} THEN l.debe ELSE 0 END), 0) AS debe,
           COALESCE(SUM(CASE WHEN ${sale} THEN l.haber ELSE 0 END), 0) AS haber,
           COALESCE(SUM(CASE WHEN ${sale} AND e.estado <> 'POSTED' THEN 1 ELSE 0 END), 0) AS borradores,
           COALESCE(SUM(CASE WHEN ${ES_CIERRE} THEN 1 ELSE 0 END), 0) AS deCierre
    FROM JournalEntryLine l
    JOIN JournalEntry e ON e.id = l.entryId
    WHERE ${condiciones(companyId, f, { todosLosTipos: true })}`;
  const debe = round2(aNumero(r?.debe));
  const haber = round2(aNumero(r?.haber));
  return {
    apuntes: aNumero(r?.n),
    debe,
    haber,
    diferencia: round2(debe - haber),
    enBorrador: aNumero(r?.borradores),
    deCierre: aNumero(r?.deCierre),
  };
}

// ---------------------------------------------------------------------------
// Cada apunte con su cuenta, su documento y su tercero
// ---------------------------------------------------------------------------

export type TipoDocumentoApunte =
  | 'FACTURA_VENTA'
  | 'COBRO'
  | 'FACTURA_COMPRA'
  | 'PAGO'
  | 'NOMINA'
  | 'PAGO_NOMINAS'
  | 'SEGUROS_SOCIALES'
  | 'PARTIDA_GESTORIA'
  | 'RETENCIONES'
  | 'AMORTIZACION'
  | 'APERTURA'
  | 'REGULARIZACION'
  | 'CIERRE'
  | 'IMPORTACION'
  | 'GESTORIA'
  | 'MANUAL';

export interface DocumentoApunte {
  tipo: TipoDocumentoApunte;
  /** «Factura NZ004_26», «Cobro de la factura NZ004_26», «Nómina»... */
  texto: string;
  /** Pantalla del documento; null si no tiene. */
  enlace: string | null;
}

export interface TerceroApunte {
  tipo: 'cliente' | 'proveedor';
  id: string;
  nombre: string;
}

export interface Apunte {
  /** Id de la linea del asiento. */
  id: string;
  fecha: string; // AAAA-MM-DD
  asientoId: string;
  asiento: string;
  /** APROBADO (POSTED) o BORRADOR (DRAFT o PENDING_REVIEW). */
  estado: 'APROBADO' | 'BORRADOR';
  /** NORMAL, APERTURA, REGULARIZACION o CIERRE (estos dos solo salen con incluirCierre, y se marcan). */
  tipoAsiento: TipoAsiento;
  /** Enlace al asiento en el Motor contable. */
  enlaceAsiento: string;
  cuenta: string;
  /** El del cliente o proveedor si es su subcuenta; si no, el del plan de la empresa o el del apunte. */
  nombreCuenta: string;
  concepto: string;
  referencia: string | null;
  debe: number;
  haber: number;
  documento: DocumentoApunte | null;
  tercero: TerceroApunte | null;
}

/** «2026-03» -> «marzo de 2026». */
function mesDeClave(clave: string | null): string {
  const m = /^(\d{4})-(\d{2})/.exec(clave ?? '');
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return '';
  return ` de ${MESES[Number(m[2]) - 1]} de ${m[1]}`;
}

async function completar(companyId: string, filas: FilaSql[]): Promise<Apunte[]> {
  if (!filas.length) return [];
  const cuentas = [...new Set(filas.map((f) => f.cuenta))];
  // Cada cuenta y sus prefijos: si la subcuenta no esta en el plan, vale el nombre de su cuenta padre.
  const conPadres = [...new Set(cuentas.flatMap((c) => Array.from({ length: c.length }, (_, i) => c.slice(0, i + 1))))];
  const ids = (tipo: string) => [...new Set(filas.filter((f) => f.invoiceType === tipo && f.invoiceId).map((f) => f.invoiceId as string))];

  const [plan, clientesSub, proveedoresSub, ventas, gastos, partidas] = await Promise.all([
    prisma.chartOfAccounts.findMany({
      where: { OR: [{ companyId }, { companyId: null }], codigo: { in: conPadres } },
      select: { codigo: true, nombre: true, companyId: true },
    }),
    prisma.customer.findMany({ where: { companyId, subcuenta430: { in: cuentas } }, select: { id: true, nombreFiscal: true, subcuenta430: true } }),
    prisma.supplier.findMany({
      where: { companyId, OR: [{ subcuenta400: { in: cuentas } }, { subcuenta410: { in: cuentas } }] },
      select: { id: true, nombreFiscal: true, subcuenta400: true, subcuenta410: true },
    }),
    prisma.incomeInvoice.findMany({ where: { companyId, id: { in: ids('INGRESO') } }, select: { id: true, numeroCompleto: true, customerId: true } }),
    prisma.expenseInvoice.findMany({ where: { companyId, id: { in: ids('GASTO') } }, select: { id: true, numeroCompleto: true, numeroFacturaProveedor: true, supplierId: true } }),
    prisma.partidaPendiente.findMany({ where: { companyId, id: { in: ids('PARTIDA') } }, select: { id: true, numeroDocumento: true, customerId: true, supplierId: true } }),
  ]);

  // Nombres de los clientes y proveedores de los documentos.
  const idsClientes = [...new Set([...ventas.map((v) => v.customerId), ...partidas.map((p) => p.customerId)].filter((x): x is string => !!x))];
  const idsProveedores = [...new Set([...gastos.map((g) => g.supplierId), ...partidas.map((p) => p.supplierId)].filter((x): x is string => !!x))];
  const [clientes, proveedores] = await Promise.all([
    idsClientes.length ? prisma.customer.findMany({ where: { companyId, id: { in: idsClientes } }, select: { id: true, nombreFiscal: true } }) : [],
    idsProveedores.length ? prisma.supplier.findMany({ where: { companyId, id: { in: idsProveedores } }, select: { id: true, nombreFiscal: true } }) : [],
  ]);
  const nombreCliente = new Map(clientes.map((c) => [c.id, c.nombreFiscal]));
  const nombreProveedor = new Map(proveedores.map((p) => [p.id, p.nombreFiscal]));

  const nombrePlan = new Map<string, string>();
  for (const c of plan) if (!c.companyId) nombrePlan.set(c.codigo, c.nombre);
  for (const c of plan) if (c.companyId) nombrePlan.set(c.codigo, c.nombre);
  const fichaDeSubcuenta = new Map<string, TerceroApunte>();
  for (const c of clientesSub) if (c.subcuenta430) fichaDeSubcuenta.set(c.subcuenta430, { tipo: 'cliente', id: c.id, nombre: c.nombreFiscal });
  for (const p of proveedoresSub) {
    for (const s of [p.subcuenta400, p.subcuenta410]) if (s) fichaDeSubcuenta.set(s, { tipo: 'proveedor', id: p.id, nombre: p.nombreFiscal });
  }
  const venta = new Map(ventas.map((v) => [v.id, v]));
  const gasto = new Map(gastos.map((g) => [g.id, g]));
  const partida = new Map(partidas.map((p) => [p.id, p]));

  const nombreCuenta = (f: FilaSql): string => {
    const ficha = fichaDeSubcuenta.get(f.cuenta);
    if (ficha) return ficha.nombre;
    const exacto = nombrePlan.get(f.cuenta);
    if (exacto) return exacto;
    if (f.nombreApunte?.trim()) return f.nombreApunte.trim();
    for (let n = f.cuenta.length - 1; n >= 1; n--) {
      const padre = nombrePlan.get(f.cuenta.slice(0, n));
      if (padre) return padre;
    }
    return '';
  };

  const terceroDeDocumento = (f: FilaSql): TerceroApunte | null => {
    const id = f.invoiceId ?? '';
    if (f.invoiceType === 'INGRESO') {
      const v = venta.get(id);
      return v ? { tipo: 'cliente', id: v.customerId, nombre: nombreCliente.get(v.customerId) ?? '' } : null;
    }
    if (f.invoiceType === 'GASTO') {
      const g = gasto.get(id);
      return g ? { tipo: 'proveedor', id: g.supplierId, nombre: nombreProveedor.get(g.supplierId) ?? '' } : null;
    }
    if (f.invoiceType === 'PARTIDA') {
      const p = partida.get(id);
      if (p?.customerId) return { tipo: 'cliente', id: p.customerId, nombre: nombreCliente.get(p.customerId) ?? '' };
      if (p?.supplierId) return { tipo: 'proveedor', id: p.supplierId, nombre: nombreProveedor.get(p.supplierId) ?? '' };
    }
    return null;
  };

  const documento = (f: FilaSql): DocumentoApunte | null => {
    const id = f.invoiceId ?? '';
    const cobroOPago = f.origen === 'TESORERIA';
    if (f.invoiceType === 'INGRESO') {
      const v = venta.get(id);
      const numero = v?.numeroCompleto ? ` ${v.numeroCompleto}` : '';
      return cobroOPago
        ? { tipo: 'COBRO', texto: `Cobro de la factura${numero}`, enlace: v ? `/dashboard/facturas/${v.id}` : null }
        : { tipo: 'FACTURA_VENTA', texto: `Factura${numero}`, enlace: v ? `/dashboard/facturas/${v.id}` : null };
    }
    if (f.invoiceType === 'GASTO') {
      const g = gasto.get(id);
      const n = g ? g.numeroFacturaProveedor || g.numeroCompleto : '';
      const numero = n ? ` ${n}` : '';
      return cobroOPago
        ? { tipo: 'PAGO', texto: `Pago de la factura${numero}`, enlace: g ? `/dashboard/compras/${g.id}` : null }
        : { tipo: 'FACTURA_COMPRA', texto: `Factura${numero}`, enlace: g ? `/dashboard/compras/${g.id}` : null };
    }
    if (f.invoiceType === 'PARTIDA') {
      const p = partida.get(id);
      return { tipo: 'PARTIDA_GESTORIA', texto: `Factura de la gestoría${p ? ` ${p.numeroDocumento}` : ''}`, enlace: '/dashboard/contabilidad/arranque' };
    }
    if (f.invoiceType === 'NOMINA') return { tipo: 'NOMINA', texto: 'Nómina', enlace: '/dashboard/nominas' };
    if (f.invoiceType === 'NOMINA_PAGO') return { tipo: 'PAGO_NOMINAS', texto: `Pago de las nóminas${mesDeClave(f.invoiceId)}`, enlace: '/dashboard/nominas' };
    if (f.invoiceType === 'SEG_SOCIAL') return { tipo: 'SEGUROS_SOCIALES', texto: `Seguros sociales${mesDeClave(f.invoiceId)}`, enlace: '/dashboard/nominas' };
    if (f.invoiceType === 'TRASPASO_4709' || f.invoiceType === 'TRASPASO_4709_ANULADO') {
      const modelo = (f.invoiceId ?? '').startsWith('115') ? '115' : '111';
      return { tipo: 'RETENCIONES', texto: `Modelo ${modelo}`, enlace: `/dashboard/fiscal/modelo-${modelo}` };
    }
    // Pago del 111 desde Nominas (invoiceId «2026-1T»): se paga y se anula alli.
    if (f.invoiceType === 'MODELO_111' || f.invoiceType === 'MODELO_111_ANULADO') {
      const [ejercicio, periodo] = (f.invoiceId ?? '').split('-');
      const cual = ejercicio && periodo ? ` ${periodo}/${ejercicio}` : '';
      const anulado = f.invoiceType === 'MODELO_111_ANULADO' ? ' (anulado)' : '';
      return { tipo: 'RETENCIONES', texto: `Pago del modelo 111${cual}${anulado}`, enlace: '/dashboard/nominas' };
    }
    const origen = (f.origen ?? '').toUpperCase();
    const tipo = tipoAsiento(f.origen, f.descripcion);
    // Diario de un año llevado por la gestoria: su origen es la carga, no el cierre de la app.
    if (origen.startsWith('HISTORICO')) {
      const nombre = { APERTURA: 'Apertura', REGULARIZACION: 'Regularización', CIERRE: 'Cierre', NORMAL: '' }[tipo];
      return { tipo: tipo === 'NORMAL' ? 'GESTORIA' : tipo, texto: nombre ? `${nombre} (diario de la gestoría)` : 'Diario de la gestoría', enlace: null };
    }
    if (origen === 'AMORTIZACION') return { tipo: 'AMORTIZACION', texto: 'Amortización', enlace: '/dashboard/contabilidad/inmovilizado' };
    if (origen === 'IMPORTACION') return { tipo: 'IMPORTACION', texto: 'Importación', enlace: '/dashboard/contabilidad/puesta-en-marcha' };
    if (tipo === 'APERTURA') return { tipo: 'APERTURA', texto: 'Apertura del ejercicio', enlace: null };
    if (tipo === 'REGULARIZACION') return { tipo: 'REGULARIZACION', texto: 'Regularización', enlace: '/dashboard/contabilidad/cierre-ejercicio' };
    if (tipo === 'CIERRE') return { tipo: 'CIERRE', texto: 'Cierre del ejercicio', enlace: '/dashboard/contabilidad/cierre-ejercicio' };
    if (origen === 'AJUSTE_MANUAL' || origen === 'MANUAL') return { tipo: 'MANUAL', texto: 'Asiento manual', enlace: null };
    return null;
  };

  return filas.map((f) => ({
    id: f.id,
    fecha: f.fecha.toISOString().slice(0, 10),
    asientoId: f.asientoId,
    asiento: f.numeroAsiento,
    estado: f.estado === 'POSTED' ? 'APROBADO' : 'BORRADOR',
    tipoAsiento: tipoAsiento(f.origen, f.descripcion),
    enlaceAsiento: `/dashboard/motor-contable/${f.asientoId}`,
    cuenta: f.cuenta,
    nombreCuenta: nombreCuenta(f),
    concepto: f.descripcion,
    referencia: f.referencia,
    debe: round2(aNumero(f.debe)),
    haber: round2(aNumero(f.haber)),
    documento: documento(f),
    // El de la subcuenta manda: un apunte en la subcuenta de otro es de ese otro.
    tercero: fichaDeSubcuenta.get(f.cuenta) ?? terceroDeDocumento(f),
  }));
}

// ---------------------------------------------------------------------------
// Listado paginado
// ---------------------------------------------------------------------------

export const POR_PAGINA = 50;
export const MAX_POR_PAGINA = 200;

export interface OpcionesPagina {
  pagina?: number;
  porPagina?: number;
}

export function paginaDeConsulta(q: Record<string, unknown>): Required<OpcionesPagina> {
  const p = texto(q.pagina);
  const pp = texto(q.porPagina);
  if (p && (!/^\d+$/.test(p) || Number(p) < 1)) throw badRequest('La página tiene que ser un número a partir de 1.', { campo: 'pagina' });
  if (pp && (!/^\d+$/.test(pp) || Number(pp) < 1 || Number(pp) > MAX_POR_PAGINA)) {
    throw badRequest(`Se pueden ver entre 1 y ${MAX_POR_PAGINA} apuntes por página.`, { campo: 'porPagina' });
  }
  return { pagina: p ? Number(p) : 1, porPagina: pp ? Number(pp) : POR_PAGINA };
}

export async function listarApuntes(companyId: string, f: FiltroApuntes, opciones: OpcionesPagina = {}) {
  const porPagina = Math.min(Math.max(1, opciones.porPagina ?? POR_PAGINA), MAX_POR_PAGINA);
  const pagina = Math.max(1, opciones.pagina ?? 1);
  const [totales, filas, movimientosAntiguos] = await Promise.all([
    totalesSql(companyId, f),
    filasSql(companyId, f, porPagina, (pagina - 1) * porPagina),
    // Si la empresa tiene movimientos anotados a mano (tabla Movement), la pantalla enseña el enlace a «Movimientos antiguos».
    prisma.movement.count({ where: { companyId } }),
  ]);
  return {
    periodo: f.periodo,
    filtro: {
      cuenta: f.cuenta ?? null,
      tercero: f.tercero ?? null,
      texto: f.texto ?? null,
      estado: f.estado,
      importeMin: f.importeMin ?? null,
      importeMax: f.importeMax ?? null,
      incluirCierre: f.incluirCierre,
    },
    pagina,
    porPagina,
    paginas: Math.max(1, Math.ceil(totales.apuntes / porPagina)),
    totales,
    apuntes: await completar(companyId, filas),
    movimientosAntiguos,
  };
}

// ---------------------------------------------------------------------------
// Descarga en PDF y Excel
// ---------------------------------------------------------------------------

/**
 * Apuntes que caben en una descarga; con mas, se pide acotar el filtro. El PDF
 * tiene un tope menor: el exportador comun tarda unos 3,5 ms por fila fuera de
 * Jest (1.000 filas en 3,8 s y 5.000 en 17,6 s, medido el 14-10-2026), y en
 * Vercel, con una CPU mas lenta, mas. Con 2.000, unos 7 s en local. El Excel,
 * 20.000 en menos de medio segundo.
 */
export const MAX_DESCARGA = { pdf: 2000, xlsx: 20000 } as const;
export type FormatoDescarga = keyof typeof MAX_DESCARGA;

/** 12345 -> «12.345» (Intl en es-ES no agrupa los de 4 cifras en todas las versiones de Node). */
const miles = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** El motivo cuando hay demasiados apuntes para descargar. */
function demasiados(apuntes: number, formato: FormatoDescarga) {
  const max = MAX_DESCARGA[formato];
  const otro = formato === 'pdf' ? `, o descarga el Excel, que admite hasta ${miles(MAX_DESCARGA.xlsx)}` : '';
  return badRequest(
    `Hay ${miles(apuntes)} apuntes con este filtro y ${formato === 'pdf' ? 'el PDF' : 'el Excel'} admite ${miles(max)} como mucho. Acota el periodo (un trimestre o un mes) o añade un filtro${otro}.`,
    { codigo: 'DEMASIADOS_APUNTES', apuntes, maximo: max },
  );
}

const NOMBRE_ESTADO: Record<EstadoApuntes, string> = { todos: '', aprobados: 'solo asientos aprobados', borradores: 'solo asientos en borrador' };

/** Lo que se ha filtrado, para el subtitulo del informe: «cuenta 572 · cliente Bar Pepe SL · texto «luz»». */
export function textoFiltro(f: FiltroApuntes, simbolo = '€'): string[] {
  const partes: string[] = [];
  if (f.cuenta) partes.push(`cuenta ${f.cuenta}`);
  if (f.tercero) {
    partes.push(`${f.tercero.tipo === 'cliente' ? 'cliente' : 'proveedor'} ${f.tercero.nombre}${f.tercero.nif ? ` (${f.tercero.nif})` : ''}`);
  }
  if (f.texto) partes.push(`texto «${f.texto}»`);
  if (f.importeMin !== undefined && f.importeMax !== undefined) partes.push(`importe de ${num(f.importeMin)} a ${num(f.importeMax)}\u00a0${simbolo}`);
  else if (f.importeMin !== undefined) partes.push(`importe desde ${num(f.importeMin)}\u00a0${simbolo}`);
  else if (f.importeMax !== undefined) partes.push(`importe hasta ${num(f.importeMax)}\u00a0${simbolo}`);
  if (NOMBRE_ESTADO[f.estado]) partes.push(NOMBRE_ESTADO[f.estado]);
  if (f.incluirCierre) partes.push('con la regularización y el cierre');
  return partes;
}

/** Que asientos salen, segun el estado pedido (para las notas del informe). */
const QUE_ASIENTOS: Record<EstadoApuntes, string> = {
  todos: 'Apuntes de los asientos aprobados y de los que están en borrador',
  aprobados: 'Apuntes de los asientos aprobados',
  borradores: 'Apuntes de los asientos que están en borrador',
};

/** «Regularización: …» o «Cierre: …» delante del concepto, como en el diario (si el concepto no lo dice ya). */
const NOMBRE_TIPO: Partial<Record<TipoAsiento, string>> = { REGULARIZACION: 'Regularización', CIERRE: 'Cierre' };
function conceptoConTipo(a: Apunte): string {
  const nombre = NOMBRE_TIPO[a.tipoAsiento];
  if (!nombre || a.concepto.toLowerCase().startsWith(nombre.toLowerCase().slice(0, 6))) return a.concepto;
  return `${nombre}: ${a.concepto}`;
}

async function simboloCuenta(companyId: string): Promise<string> {
  const cfg = await prisma.legalConfig.findUnique({ where: { companyId }, select: { monedaCuenta: true } }).catch(() => null);
  const moneda = cfg?.monedaCuenta || 'EUR';
  return moneda === 'EUR' ? '€' : moneda;
}

/** Todos los apuntes del filtro como TablaInforme (Fecha, Asiento, Cuenta, Nombre de la cuenta, Concepto, Debe y Haber, y el total). */
export async function informeApuntes(companyId: string, f: FiltroApuntes, formato: FormatoDescarga = 'xlsx') {
  const totales = await totalesSql(companyId, f);
  if (totales.apuntes > MAX_DESCARGA[formato]) throw demasiados(totales.apuntes, formato);
  const apuntes = await completar(companyId, totales.apuntes ? await filasSql(companyId, f, MAX_DESCARGA[formato], 0) : []);
  const simbolo = await simboloCuenta(companyId);

  const filas: FilaInforme[] = apuntes.map((a) => ({
    celdas: [a.fecha, a.estado === 'BORRADOR' ? `${a.asiento} (borrador)` : a.asiento, a.cuenta, a.nombreCuenta, conceptoConTipo(a), a.debe, a.haber],
  }));
  filas.push({
    celdas: [null, null, null, null, `Total (${miles(apuntes.length)} ${apuntes.length === 1 ? 'apunte' : 'apuntes'})`, totales.debe, totales.haber],
    estilo: 'total',
  });

  const p = f.periodo;
  // «Ejercicio 2026», «1.er trimestre de 2026 (del 01/01/2026 al 31/03/2026)» o «Del 05/03/2026 al 20/03/2026».
  const cuando = !p.nombre || p.nombre.startsWith('Ejercicio')
    ? (p.nombre ?? textoPeriodo(p.desde, p.hasta))
    : `${p.nombre.charAt(0).toUpperCase()}${p.nombre.slice(1)} (del ${fechaES(p.desde)} al ${fechaES(p.hasta)})`;
  const filtro = textoFiltro(f, simbolo);
  const d = totales.diferencia;
  const notas = [
    `Diferencia (Debe − Haber): ${num(Math.abs(d))}\u00a0${simbolo}${d > 0 ? ' de saldo deudor' : d < 0 ? ' de saldo acreedor' : ''}.`,
    `${QUE_ASIENTOS[f.estado]}, por fecha de asiento. Los asientos anulados no salen.`,
    f.incluirCierre
      ? `Incluye la regularización y el cierre del ejercicio${totales.deCierre ? ` (${miles(totales.deCierre)} ${totales.deCierre === 1 ? 'apunte' : 'apuntes'})` : ''}, con su nombre delante del concepto: dejan las cuentas a cero, así que la diferencia ya no es el saldo.`
      : `Sin los asientos de regularización ni de cierre del ejercicio${totales.deCierre ? ` (${miles(totales.deCierre)} ${totales.deCierre === 1 ? 'apunte' : 'apuntes'} con este filtro)` : ''}, como en el libro diario.`,
    ...(totales.enBorrador
      ? [`${totales.enBorrador === 1 ? 'Un apunte es' : `${totales.enBorrador} apuntes son`} de asientos en borrador, marcados con «(borrador)»: todavía no cuentan en el mayor ni en los informes hasta aprobarlos en el Motor contable.`]
      : []),
    ...(f.tercero ? [`De ${f.tercero.nombre} salen los apuntes de su cuenta${f.tercero.subcuentas.length ? ` (${f.tercero.subcuentas.join(' y ')})` : ''}: sus facturas y lo cobrado o pagado. Las líneas de ventas, compras o IVA de sus facturas no salen.`] : []),
    ...(!apuntes.length ? ['No hay apuntes con este filtro.'] : []),
  ];

  const tabla: TablaInforme = {
    titulo: 'Apuntes contables',
    periodo: [cuando, ...filtro].join(' · '),
    empresa: await datosEmpresa(companyId),
    apaisado: true,
    columnas: [
      { titulo: 'Fecha', tipo: 'fecha', ancho: 1.6 },
      { titulo: 'Asiento', tipo: 'codigo', ancho: 2.4 },
      { titulo: 'Cuenta', tipo: 'codigo', ancho: 1.8 },
      { titulo: 'Nombre de la cuenta', tipo: 'texto', ancho: 4 },
      { titulo: 'Concepto', tipo: 'texto', ancho: 6 },
      { titulo: 'Debe', tipo: 'importe', ancho: 2 },
      { titulo: 'Haber', tipo: 'importe', ancho: 2 },
    ],
    filas,
    notas,
    fichero: `apuntes_${p.desde}_${p.hasta}`,
  };
  return { periodo: p, totales, apuntes: apuntes.length, tabla };
}
