/**
 * Analisis de una carga de «Traer la contabilidad de 2026»: con los datos de
 * los ficheros (datos.ts) y lo que ya hay en la app, calcula TODO lo que haria
 * la importacion, fase a fase, y las comprobaciones de A4. No escribe nada:
 * ni cuentas, ni fichas, ni ejercicios, ni periodos (solo lee).
 *
 * El resumen lleva una huella (SHA-256): si al confirmar el analisis ya no da
 * lo mismo (alguien dio de alta un cliente entre medias, cambio el plan...),
 * la confirmacion se rechaza y hay que revisar el resumen de nuevo.
 */
import { createHash } from 'crypto';
import { prisma } from '../../config/database';
import { FILTRO_ASIENTOS_APERTURA } from '../../domain/asientosCierre';
import { aCentimos, importeTexto } from '../../utils/money';
import { normalizarNif } from '../../utils/nif';
import { rangoEjercicio } from '../puestaEnMarcha/asientosEnBloque';
import type { CuentaSaldo } from '../puestaEnMarcha/lectorContable';
import { analizarPlanSinEscribir, nombreComparable, type CuentaDelPlan, type PermisosAlta, type TerceroDelListado, type VistaPlan } from '../puestaEnMarcha/planAnterior';
import { esSubcuentaDeTercero } from '../terceros/numeracion';
import { cuadrarCartera, type ResultadoCartera } from './cartera';
import { comprobarCarga, juntarComprobaciones, type BancoComprobar, type FicheroExcluido, type ResultadoComprobaciones } from './comprobaciones';
import { miles, type AjustesCarga, type DatosCarga, type HojaAnalizada, type TipoCarga } from './datos';
import { cuentasDePygOficial, type ActivoLeido, type PartidaLeida } from './extractores';
import { analizarDiario, saldosDesdeDiario, type AnalisisDiario } from './historico';
import { analizarSaldos, saldosDeLineas, type AnalisisSaldos, type LineaApertura } from './saldos';
import { puntosVivos } from './vivas.service';
import { analizarRepeticion, type AnalisisRepeticion } from './definitiva';

/** Ejercicio de destino de la carga (por ahora solo 2027) y el que se trae. */
export const EJERCICIO_ARRANQUE = 2027;
export const ANIO_ORIGEN = EJERCICIO_ARRANQUE - 1;
export const FECHA_APERTURA = `${EJERCICIO_ARRANQUE}-01-01`;
export const CONCEPTO_APERTURA_ARRANQUE = `Apertura ejercicio ${EJERCICIO_ARRANQUE} (contabilidad de ${ANIO_ORIGEN} de la gestoría)`;

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const varios = (n: number, uno: string, muchos: string) => `${miles(n)} ${n === 1 ? uno : muchos}`;

/** Activo de la carga ya con sus cuentas (las que traia o las que le tocan por su cuenta del bien). */
export interface ActivoResuelto extends ActivoLeido {
  cuentaBien: string;
  cuentaAmortAcum: string;
  cuentaDotacion: string;
}

/** Todo lo que haria la importacion, calculado sin escribir. */
export interface AnalisisCarga {
  ejercicio: number;
  tipoCarga: TipoCarga;
  ajustes: AjustesCarga;
  datos: DatosCarga;
  /** Saldos a 31-12 de los que sale la apertura (del sumas y saldos o, sin el, del diario). */
  saldos: { analisis: AnalisisSaldos; origen: 'SUMAS_Y_SALDOS' | 'DIARIO' } | null;
  diario: AnalisisDiario | null;
  /**
   * Gastos e ingresos de 2026 para el comparativo cuando el sumas y saldos viene
   * regularizado y no hay diario que importar: las partidas de la PyG oficial.
   */
  pygComparativo: Array<{ codigo: string; nombre: string; saldo: number }> | null;
  excluidos: FicheroExcluido[];
  /** Cuentas que se crean o se renombran (plan ∪ sumas y saldos ∪ diario ∪ cartera ∪ inmovilizado). */
  cuentas: CuentaDelPlan[];
  /** Cuentas que no estan en el plan y salen de otro fichero (se crean con el nombre de ese fichero). */
  fueraDelPlan: string[];
  listado: TerceroDelListado[];
  plan: VistaPlan;
  apertura: { fecha: string; lineas: Array<LineaApertura & { nombre: string }>; sustituye: Array<{ id: string; numero: string }>; eneroNoAbierto: boolean } | null;
  cartera: (ResultadoCartera & { facturas: Map<string, { incomeInvoiceId?: string; expenseInvoiceId?: string }> }) | null;
  inmovilizado: { activos: ActivoResuelto[]; diferencias: Array<{ codigo: string; fichas: number; saldo: number; diferencia: number }>; sinCuenta: number } | null;
  /** D1: la carga trae sumas y saldos o diario de 2026, asi que 2026 pasa a llevado fuera. */
  marcaLlevanzaExterna: boolean;
  /**
   * La carga fijara AjustesFiscales.inicioEnApp en el 1 de enero del ejercicio:
   * 2026 pasa a llevado fuera y la empresa no habia indicado su fecha de inicio.
   */
  fijaInicioEnApp: boolean;
  retirados: Record<string, number>;
  cargaVigente: { id: string; version: number } | null;
  /** Bancos (572) de la apertura con el saldo del extracto escrito a mano y su cuenta de Tesoreria. */
  bancos: BancoComprobar[] | null;
  /** Frente a la carga vigente: modo de la apertura, diferencias y lo que se mantiene. */
  repeticion: AnalisisRepeticion;
  comprobaciones: ResultadoComprobaciones;
  erroresEstado: string[];
  huella: string;
}

/**
 * Bienes que no se amortizan: terrenos (210, 220), inmovilizado en curso y
 * anticipos (23x, 209) y los que vienen con coeficiente 0.
 */
export function noSeAmortiza(cuentaBien: string, coeficiente?: number): boolean {
  return /^(210|220|23|209)/.test(cuentaBien) || coeficiente === 0;
}

/**
 * Cuenta de amortizacion acumulada y de dotacion que le tocan a un bien por su
 * cuenta (213x -> 2813x y 681x; 206 -> 2806 y 680). Las inversiones
 * inmobiliarias (22x) van a la 282, que el PGC no subdivide.
 */
export function cuentasDeAmortizacion(cuentaBien: string): { amortAcum: string; dotacion: string } {
  const largo = Math.max(cuentaBien.length, 4);
  const grupo = cuentaBien.slice(1, 2); // 0 intangible, 1 material, 2 inversiones inmobiliarias
  const sub = grupo === '2' ? '' : cuentaBien.slice(2, 3);
  return { amortAcum: `28${grupo}${sub}`.padEnd(largo, '0'), dotacion: `68${grupo}`.padEnd(largo, '0') };
}

/** Datos de la empresa que hacen falta para analizar (solo lectura). */
async function contexto(companyId: string, ejercicio: number) {
  const [clientes, proveedores, aperturas, eneroPeriodo, vigente, aplicando, fy2027] = await Promise.all([
    prisma.customer.findMany({ where: { companyId }, select: { id: true, nifCif: true, nombreFiscal: true, subcuenta430: true } }),
    prisma.supplier.findMany({ where: { companyId }, select: { id: true, nifCif: true, nombreFiscal: true, subcuenta400: true, subcuenta410: true } }),
    prisma.journalEntry.findMany({ where: { companyId, estado: 'POSTED', ...FILTRO_ASIENTOS_APERTURA, fecha: rangoEjercicio(ejercicio) }, select: { id: true, numeroAsiento: true } }),
    prisma.periodo.findFirst({ where: { companyId, ejercicio, mes: 1 }, select: { estado: true } }),
    prisma.cargaArranque.findFirst({ where: { companyId, ejercicio, estado: 'CONFIRMADA' }, select: { id: true, version: true } }),
    prisma.cargaArranque.findFirst({ where: { companyId, ejercicio, estado: 'APLICANDO' }, select: { id: true, version: true } }),
    prisma.fiscalYear.findFirst({ where: { companyId, label: String(ejercicio) }, select: { estado: true } }),
  ]);
  return { clientes, proveedores, aperturas, eneroPeriodo, vigente, aplicando, fy2027 };
}

/**
 * Analiza la carga. `permisos`: si quien la hace puede dar de alta clientes y
 * proveedores (si no, sus subcuentas quedan pendientes de enlazar).
 */
export async function analizarCarga(
  companyId: string,
  ejercicio: number,
  datos: DatosCarga,
  ajustes: AjustesCarga,
  permisos: PermisosAlta,
  opciones: { cargaId?: string } = {},
): Promise<AnalisisCarga> {
  const tipoCarga: TipoCarga = ajustes.tipoCarga === 'DEFINITIVA' ? 'DEFINITIVA' : 'PROVISIONAL';
  const anioOrigen = ejercicio - 1;
  const ctx = await contexto(companyId, ejercicio);
  const erroresEstado: string[] = [];
  if (ctx.aplicando && ctx.aplicando.id !== opciones.cargaId) {
    erroresEstado.push(`La versión ${ctx.aplicando.version} se está importando todavía: termínala o deshazla antes de traer otra.`);
  }
  if (ctx.fy2027?.estado === 'CLOSED') erroresEstado.push(`El ejercicio ${ejercicio} está cerrado: no se le puede poner la apertura.`);

  // 1. Nombres del plan (para los avisos y las lineas).
  const nombres = new Map<string, string>();
  for (const c of datos.sumasSaldos?.cuentas ?? []) if (c.nombre) nombres.set(c.codigo, c.nombre);
  for (const c of datos.plan ?? []) if (c.nombre) nombres.set(c.codigo, c.nombre);

  // 2. Sumas y saldos y diario.
  const sys = datos.sumasSaldos ? analizarSaldos(datos.sumasSaldos.cuentas, nombres) : null;
  const diario = datos.diario
    ? analizarDiario(datos.diario.lectura.apuntes, anioOrigen, sys && datos.sumasSaldos ? { cuentas: datos.sumasSaldos.cuentas, tipo: sys.tipo, fechaCorte: datos.sumasSaldos.fechaCorte } : null)
    : null;
  // D2: con sumas y saldos, un diario que no cuadra se deja fuera y la carga sigue.
  const diarioMalo = !!diario && (diario.resumen.asientos === 0 || diario.descuadrados.length > 0 || (diario.comparacion !== null && !diario.comparacion.cuadra));
  const diarioFuera = diarioMalo && !!sys;
  const usarDiario = !!diario && !diarioFuera;
  let saldos: AnalisisCarga['saldos'] = null;
  if (sys) saldos = { analisis: sys, origen: 'SUMAS_Y_SALDOS' };
  else if (diario && !diarioMalo) saldos = { analisis: analizarSaldos(saldosDesdeDiario(diario.asientos), nombres), origen: 'DIARIO' };
  const saldosApertura = saldos && saldos.analisis.tipo !== 'CON_CIERRE' ? saldosDeLineas(saldos.analisis.lineas) : new Map<string, number>();
  // Regularizado y sin diario: los gastos e ingresos del comparativo salen de la PyG oficial
  // (si trae sus partidas y suman lo mismo que la 129).
  const sinGastosNiIngresos = !!sys && sys.tipo === 'REGULARIZADO' && !usarDiario;
  const pygOficial = sinGastosNiIngresos ? cuentasDePygOficial(datos.pyg) : null;
  const pygComparativo = pygOficial && sys && aCentimos(sys.saldo129) === aCentimos(datos.pyg!.resultado ?? NaN) ? pygOficial : null;

  // 3. Inmovilizado: cuentas de cada bien y cuadre con 2xx/28x (D2).
  let inmovilizado: AnalisisCarga['inmovilizado'] = null;
  if (datos.inmovilizado) {
    const activos: ActivoResuelto[] = [];
    let sinCuenta = 0;
    for (const a of datos.inmovilizado) {
      if (!a.cuentaBien) {
        sinCuenta++;
        continue;
      }
      // Terrenos, inmovilizado en curso o coeficiente 0: sin cuentas de amortizacion (no existen en el PGC).
      if (noSeAmortiza(a.cuentaBien, a.coeficiente) && !a.cuentaAmortAcum) {
        activos.push({ ...a, cuentaBien: a.cuentaBien, coeficiente: 0, cuentaAmortAcum: '', cuentaDotacion: '' });
        continue;
      }
      const d = cuentasDeAmortizacion(a.cuentaBien);
      // Sin la cuenta en el fichero: si la que le toca no tiene saldo y la gestoria usa una sola 28x
      // de ese tipo (2811000000 para todo el material, 2820000000...), la de la gestoria.
      let amortAcum = a.cuentaAmortAcum ?? d.amortAcum;
      if (!a.cuentaAmortAcum && saldos && !saldosApertura.has(amortAcum)) {
        const conSaldo = [...saldosApertura.keys()].filter((c) => c.startsWith(amortAcum.slice(0, 3)));
        if (conSaldo.length === 1) amortAcum = conSaldo[0];
      }
      activos.push({ ...a, cuentaBien: a.cuentaBien, cuentaAmortAcum: amortAcum, cuentaDotacion: a.cuentaDotacion ?? d.dotacion });
    }
    const suma = (clave: (a: ActivoResuelto) => string, valor: (a: ActivoResuelto) => number) => {
      const m = new Map<string, number>();
      for (const a of activos) m.set(clave(a), round2((m.get(clave(a)) ?? 0) + valor(a)));
      return m;
    };
    const diferencias: Array<{ codigo: string; fichas: number; saldo: number; diferencia: number }> = [];
    if (saldos) {
      for (const [codigo, fichas] of suma((a) => a.cuentaBien, (a) => a.coste)) {
        const saldo = saldosApertura.get(codigo) ?? 0;
        if (aCentimos(fichas) !== aCentimos(saldo)) diferencias.push({ codigo, fichas, saldo, diferencia: round2(fichas - saldo) });
      }
      for (const [codigo, fichas] of suma((a) => a.cuentaAmortAcum, (a) => a.amortAcumulada)) {
        if (!codigo) continue;
        const saldo = -(saldosApertura.get(codigo) ?? 0);
        if (aCentimos(fichas) !== aCentimos(saldo)) diferencias.push({ codigo, fichas, saldo: round2(saldo), diferencia: round2(fichas - saldo) });
      }
    }
    inmovilizado = { activos, diferencias, sinCuenta };
  }
  const inmovilizadoFuera = !!inmovilizado && (inmovilizado.diferencias.length > 0 || inmovilizado.activos.length === 0);

  // 4. Todas las cuentas: las del plan y las que salgan en los demas ficheros (A3, P.6).
  const cuentas = new Map<string, CuentaDelPlan>();
  for (const c of datos.plan ?? []) cuentas.set(c.codigo, { codigo: c.codigo, nombre: c.nombre, ...(c.nif ? { nif: c.nif } : {}), ...(c.ficha ? { ficha: c.ficha } : {}) });
  const fueraDelPlan: string[] = [];
  const anadir = (codigo: string, nombre: string) => {
    if (/^[89]/.test(codigo) || cuentas.has(codigo)) return;
    cuentas.set(codigo, { codigo, nombre });
    if (datos.plan) fueraDelPlan.push(codigo);
  };
  for (const c of datos.sumasSaldos?.cuentas ?? []) anadir(c.codigo, c.nombre);
  if (usarDiario && diario) for (const a of diario.asientos) for (const l of a.lineas) anadir(l.cuenta, l.nombre);
  for (const p of datos.cartera ?? []) if (p.subcuenta) anadir(p.subcuenta, p.nombre ?? '');
  if (inmovilizado && !inmovilizadoFuera) {
    for (const a of inmovilizado.activos) {
      anadir(a.cuentaBien, a.descripcion);
      if (a.cuentaAmortAcum) anadir(a.cuentaAmortAcum, '');
      if (a.cuentaDotacion) anadir(a.cuentaDotacion, '');
    }
  }
  if (saldos && saldos.analisis.lineas.some((l) => l.cuenta === saldos!.analisis.cuenta129)) anadir(saldos.analisis.cuenta129, 'Resultado del ejercicio');
  // Subcuentas del 13 que reciben el saldo de los grupos 8 y 9 (pueden no estar en ningun fichero).
  for (const t of saldos?.analisis.grupos89.traspasos ?? []) anadir(t.a, '');
  const listaCuentas = [...cuentas.values()].sort((a, b) => a.codigo.localeCompare(b.codigo));

  // 5. Plan y fichas: el mismo analisis que el traslado del plan, sin escribir.
  const listado: TerceroDelListado[] = datos.terceros.map((t) => ({
    ...(t.subcuenta ? { subcuenta: t.subcuenta } : {}),
    ...(t.nif ? { nif: t.nif } : {}),
    ...(t.nombre ? { nombre: t.nombre } : {}),
    ...(t.ficha ? { ficha: t.ficha } : {}),
  }));
  const plan = listaCuentas.length
    ? await analizarPlanSinEscribir(companyId, listaCuentas, listado, permisos, { nombresGestoria: true, longitudFija: datos.plan ? datos.longitud : null })
    : ({
        lectura: null,
        cuentasLeidas: 0,
        cuentasNuevas: [],
        cuentasExistentes: 0,
        omitidas: [],
        longitud: { delPlan: null, actual: 0, seFija: false, motivo: null },
        terceros: [],
        resumen: { enlazar: 0, crear: 0, pendientes: 0, yaEnlazadas: 0, noSeEnlazan: 0 },
        errores: [],
        avisos: [],
        puedeConfirmar: false,
      } satisfies VistaPlan);

  // 6. Comprobaciones del plan: cuentas fuera del PGC con saldo y longitudes.
  const conMovimiento = new Set<string>([...saldosApertura.entries()].filter(([, s]) => aCentimos(s) !== 0).map(([c]) => c));
  for (const c of datos.sumasSaldos?.cuentas ?? []) if (aCentimos(c.saldo) !== 0) conMovimiento.add(c.codigo);
  if (usarDiario && diario) for (const a of diario.asientos) for (const l of a.lineas) conMovimiento.add(l.cuenta);
  const sinMadreConSaldo = plan.omitidas.filter((o) => !/^[89]/.test(o.codigo) && conMovimiento.has(o.codigo)).map((o) => `${o.codigo} ${nombres.get(o.codigo) ?? ''}: ${o.motivo}`.trim());
  const delPlan = plan.longitud.delPlan;
  const longitudesIncoherentes: string[] = [];
  /** De que fichero viene cada subcuenta con otra longitud, para decirlo en el error. */
  const ficherosConOtraLongitud: Array<{ fichero: string; subcuentas: number; longitud: number }> = [];
  if (delPlan && datos.plan) {
    const ficheroDe = (idHoja: string | undefined, tipo: string) =>
      datos.hojas.find((h) => (idHoja ? h.id === idHoja : h.tipo === tipo && !h.excluida))?.fichero ?? 'otro fichero';
    const otros = new Map<string, Set<string>>();
    const apuntar = (fichero: string, codigo: string) => {
      if (!esSubcuentaDeTercero(codigo) || codigo.length === delPlan) return;
      if (!otros.has(fichero)) otros.set(fichero, new Set());
      otros.get(fichero)!.add(codigo);
    };
    for (const c of datos.sumasSaldos?.cuentas ?? []) apuntar(ficheroDe(datos.sumasSaldos!.hoja, 'SUMAS_Y_SALDOS'), c.codigo);
    for (const p of datos.cartera ?? []) if (p.subcuenta) apuntar(ficheroDe(undefined, 'CARTERA'), p.subcuenta);
    if (usarDiario && diario) for (const a of diario.asientos) for (const l of a.lineas) apuntar(ficheroDe(datos.diario?.hoja, 'DIARIO'), l.cuenta);
    const todas = new Set<string>();
    for (const [fichero, codigos] of otros) {
      for (const c of codigos) todas.add(c);
      const veces = new Map<number, number>();
      for (const c of codigos) veces.set(c.length, (veces.get(c.length) ?? 0) + 1);
      const longitud = [...veces.entries()].sort((x, y) => y[1] - x[1])[0][0];
      ficherosConOtraLongitud.push({ fichero, subcuentas: codigos.size, longitud });
    }
    longitudesIncoherentes.push(...[...todas].sort());
  }
  const accionDe = new Map(plan.terceros.map((t) => [t.codigo, t]));
  const tercerosConSaldoSinFicha = [...saldosApertura.entries()]
    .filter(([c, s]) => aCentimos(s) !== 0 && esSubcuentaDeTercero(c))
    .filter(([c]) => {
      const t = accionDe.get(c);
      return !t || t.accion === 'pendiente' || t.accion === 'no-se-enlaza';
    })
    .map(([c]) => ({ codigo: c, nombre: nombres.get(c) ?? '', ...(accionDe.get(c)?.motivo ? { motivo: accionDe.get(c)!.motivo } : {}) }));
  const nifEnListado = new Set(datos.terceros.filter((t) => t.subcuenta && t.nif).map((t) => t.subcuenta!));
  const tercerosSinNifEnPlan = (datos.plan ?? []).filter((c) => esSubcuentaDeTercero(c.codigo) && !c.nif && !nifEnListado.has(c.codigo)).length;

  // 7. Cartera: cada partida a su subcuenta (por subcuenta, NIF o nombre) y cuadre (D3).
  let cartera: AnalisisCarga['cartera'] = null;
  if (saldos || datos.cartera) {
    const porNif = new Map<string, { cliente?: string; proveedor?: string }>();
    const apuntar = (nif: string | undefined | null, codigo: string | null | undefined) => {
      const n = normalizarNif(nif);
      if (!n || !codigo) return;
      const e = porNif.get(n) ?? {};
      if (codigo.startsWith('430')) e.cliente ??= codigo;
      else if (/^4[01]0/.test(codigo)) e.proveedor ??= codigo;
      porNif.set(n, e);
    };
    for (const c of ctx.clientes) apuntar(c.nifCif, c.subcuenta430);
    for (const p of ctx.proveedores) {
      apuntar(p.nifCif, p.subcuenta400);
      apuntar(p.nifCif, p.subcuenta410);
    }
    for (const t of plan.terceros) apuntar(t.nif, t.codigo);
    for (const c of datos.plan ?? []) apuntar(c.nif, c.codigo);
    for (const t of datos.terceros) apuntar(t.nif, t.subcuenta);
    const porNombre = new Map<string, string[]>();
    for (const c of listaCuentas) {
      if (!esSubcuentaDeTercero(c.codigo)) continue;
      const k = nombreComparable(c.nombre);
      if (k) porNombre.set(k, [...(porNombre.get(k) ?? []), c.codigo]);
    }
    const resolver = (p: PartidaLeida): string | null => {
      const quiere = (c: string) => (p.tipoTercero === 'cliente' ? c.startsWith('430') : p.tipoTercero === 'proveedor' ? /^4[01]0/.test(c) : true);
      if (p.nif) {
        const e = porNif.get(normalizarNif(p.nif));
        if (e) {
          const opciones = [e.cliente, e.proveedor].filter((c): c is string => !!c && quiere(c));
          if (opciones.length === 1) return opciones[0];
        }
      }
      if (p.nombre) {
        const c = (porNombre.get(nombreComparable(p.nombre)) ?? []).filter(quiere);
        if (c.length === 1) return c[0];
      }
      return null;
    };
    const r = cuadrarCartera(datos.cartera ?? [], saldosApertura, resolver, nombres);
    // Facturas de 2026 emitidas o registradas en la app con el mismo numero: la partida se enlaza a ellas.
    const docsCobro = [...new Set(r.partidas.filter((p) => p.tipo === 'COBRO').map((p) => p.documento))];
    const docsPago = [...new Set(r.partidas.filter((p) => p.tipo === 'PAGO').map((p) => p.documento))];
    const [ventas, compras] = await Promise.all([
      docsCobro.length
        ? prisma.incomeInvoice.findMany({ where: { companyId, numeroCompleto: { in: docsCobro }, fechaEmision: { startsWith: String(anioOrigen) } }, select: { id: true, numeroCompleto: true, customerId: true } })
        : [],
      docsPago.length
        ? prisma.expenseInvoice.findMany({ where: { companyId, numeroFacturaProveedor: { in: docsPago }, fechaEmision: { startsWith: String(anioOrigen) } }, select: { id: true, numeroFacturaProveedor: true, supplierId: true } })
        : [],
    ]);
    const facturas = new Map<string, { incomeInvoiceId?: string; expenseInvoiceId?: string }>();
    for (const v of ventas) if (v.numeroCompleto) facturas.set(`COBRO|${v.numeroCompleto}`, { incomeInvoiceId: v.id });
    for (const c of compras) if (c.numeroFacturaProveedor) facturas.set(`PAGO|${c.numeroFacturaProveedor}`, { expenseInvoiceId: c.id });
    cartera = { ...r, facturas };
  }

  // 8. Apertura del 1-1: lineas con su nombre; la que ya hubiera se sustituye.
  let apertura: AnalisisCarga['apertura'] = null;
  if (saldos && saldos.analisis.tipo !== 'CON_CIERRE') {
    const nombrePlan = new Map(listaCuentas.map((c) => [c.codigo, c.nombre]));
    apertura = {
      fecha: `${ejercicio}-01-01`,
      lineas: saldos.analisis.lineas.map((l) => ({ ...l, nombre: nombrePlan.get(l.cuenta) || nombres.get(l.cuenta) || '' })),
      sustituye: ctx.aperturas.map((a) => ({ id: a.id, numero: a.numeroAsiento })),
      eneroNoAbierto: !!ctx.eneroPeriodo && ctx.eneroPeriodo.estado !== 'abierto',
    };
  }

  // 9. D1: 2026 pasa a llevado fuera si la carga trae sumas y saldos o diario. Asientos de 2026 de la app que se retiran.
  const marcaLlevanzaExterna = !!datos.sumasSaldos || usarDiario;
  const retirados: Record<string, number> = {};
  const fijaInicioEnApp =
    marcaLlevanzaExterna && !(await prisma.ajustesFiscales.findUnique({ where: { companyId }, select: { inicioEnApp: true } }))?.inicioEnApp;
  if (marcaLlevanzaExterna) {
    const grupos = await prisma.journalEntry.groupBy({
      by: ['origen'],
      where: { companyId, estado: 'POSTED', fecha: rangoEjercicio(anioOrigen), NOT: { origen: { startsWith: 'HISTORICO' } } },
      _count: { _all: true },
    });
    for (const g of grupos) retirados[g.origen] = g._count._all;
  }
  // Repetir la carga (otra provisional o la definitiva): que cambia y como se aplica.
  const repeticion = await analizarRepeticion({
    companyId,
    ejercicio,
    vigente: ctx.vigente,
    apertura: apertura?.lineas ?? null,
    hayAperturaPrevia: ctx.aperturas.length > 0,
    eneroNoAbierto: apertura?.eneroNoAbierto ?? false,
    motivoAjuste: ajustes.motivoAjuste ?? null,
    partidas: datos.cartera && cartera ? [...cartera.partidas, ...cartera.sinDetalle] : null,
    activos: inmovilizado && !inmovilizadoFuera ? inmovilizado.activos : null,
  });
  erroresEstado.push(...repeticion.errores);

  // Cuentas de Tesoreria elegidas a mano para cada 572: tienen que ser de la empresa y de esa subcuenta.
  const elegidas = Object.entries(ajustes.bancos ?? {}).filter(([, b]) => b.bankAccountId);
  if (elegidas.length) {
    const cuentas = await prisma.bankAccount.findMany({ where: { companyId, id: { in: elegidas.map(([, b]) => b.bankAccountId!) } }, select: { id: true, subcuentaCodigo: true } });
    for (const [codigo, b] of elegidas) {
      const c = cuentas.find((x) => x.id === b.bankAccountId);
      if (!c) erroresEstado.push(`La cuenta bancaria elegida para la ${codigo} no existe en esta empresa: elige otra o escribe su IBAN.`);
      else if (c.subcuentaCodigo !== codigo) erroresEstado.push(`La cuenta bancaria elegida para la ${codigo} va a la subcuenta ${c.subcuentaCodigo}: elige la que corresponde o escribe su IBAN para darla de alta.`);
    }
  }

  const comprobaciones = comprobarCarga({
    ejercicioOrigen: anioOrigen,
    tipoCarga,
    presentes: datos.presentes,
    hojasConError: datos.hojasConError,
    repetidos: datos.choques,
    sumasSaldos: sys && datos.sumasSaldos ? { analisis: sys, fechaCorte: datos.sumasSaldos.fechaCorte } : null,
    saldosDesdeDiario: !sys && !!diario,
    apertura: saldos?.analisis ?? null,
    comparativoSinPyg: sinGastosNiIngresos && !pygComparativo,
    pyg: datos.pyg,
    resultadoDeclarado: ajustes.resultadoDeclarado ?? null,
    diario,
    tercerosSinNifEnPlan,
    sinMadreConSaldo,
    longitudesIncoherentes,
    ficherosConOtraLongitud,
    longitud: { delPlan, motivo: delPlan ? plan.longitud.motivo : null },
    tercerosConSaldoSinFicha,
    cartera,
    inmovilizado: inmovilizado ? { diferencias: inmovilizado.diferencias } : null,
    retirados,
  });
  for (const e of [...erroresEstado].reverse()) comprobaciones.puntos.unshift({ clave: `estado:${e.slice(0, 24)}`, nivel: 'ERROR', texto: e });
  if (erroresEstado.length) {
    comprobaciones.nivel = 'ERRORES';
    comprobaciones.mensaje = `Todavía no se puede traer la contabilidad: ${erroresEstado[0]}`;
  }
  if (fueraDelPlan.length) {
    comprobaciones.puntos.push({
      clave: 'plan:fuera-del-plan',
      nivel: 'AVISO',
      texto: `${varios(fueraDelPlan.length, 'cuenta sale', 'cuentas salen')} en otros ficheros pero no en el plan: se crean con el nombre de ese fichero.`,
      detalle: fueraDelPlan.slice(0, 50),
    });
  }
  if (inmovilizado?.sinCuenta) {
    comprobaciones.puntos.push({ clave: 'inmovilizado:sin-cuenta', nivel: 'FALTA', texto: `${varios(inmovilizado.sinCuenta, 'bien no trae', 'bienes no traen')} su cuenta (2xx): no se importan.` });
    if (comprobaciones.nivel === 'CORRECTO') {
      comprobaciones.nivel = 'FALTAN_DATOS';
      comprobaciones.mensaje = `Puedes seguir, pero faltan datos: ${comprobaciones.puntos.find((p) => p.nivel === 'FALTA')!.texto}`;
    }
  }
  const excluidos = [...new Set<FicheroExcluido>([...comprobaciones.excluidos, ...(diarioFuera ? (['DIARIO'] as const) : []), ...(inmovilizadoFuera ? (['INMOVILIZADO'] as const) : [])])];
  comprobaciones.excluidos = excluidos;

  const vivos = await puntosVivos(companyId, ejercicio, { apertura: apertura?.lineas ?? null, bancos: ajustes.bancos ?? {}, datosFiscales: ajustes.datosFiscales ?? {}, importada: false });

  const analisis: Omit<AnalisisCarga, 'huella'> = {
    ejercicio,
    tipoCarga,
    ajustes,
    datos,
    saldos,
    diario,
    pygComparativo,
    excluidos,
    cuentas: listaCuentas,
    fueraDelPlan,
    listado,
    plan,
    apertura,
    cartera,
    inmovilizado,
    marcaLlevanzaExterna,
    fijaInicioEnApp,
    retirados,
    cargaVigente: ctx.vigente,
    bancos: vivos.bancos,
    repeticion,
    comprobaciones,
    erroresEstado,
  };
  // La huella sale de lo que traen los ficheros; lo que se arregla fuera (bancos, datos fiscales,
  // datos de la empresa, series) se recalcula cada vez y no la cambia.
  const huella = huellaDe(analisis, ajustes);
  const juntas = juntarComprobaciones(comprobaciones, vivos.puntos, anioOrigen, [], () => false);
  return { ...analisis, comprobaciones: { nivel: juntas.nivel, mensaje: juntas.mensaje, puntos: juntas.puntos, excluidos: juntas.excluidos }, huella };
}

/** SHA-256 de lo que haria la importacion: si cambia entre el resumen y la confirmacion, 409. */
function huellaDe(a: Omit<AnalisisCarga, 'huella'>, ajustes: AjustesCarga): string {
  const { bancos: _b, datosFiscales: _d, ...ajustesFicheros } = ajustes;
  const resumen = {
    ajustes: ajustesFicheros,
    hojas: a.datos.hojas.map((h) => [h.id, h.tipo, h.excluida, h.mapeo]),
    cuentasNuevas: a.plan.cuentasNuevas.map((c) => c.codigo),
    nombres: a.plan.nombres?.cambian.map((n) => [n.codigo, n.nuevo]) ?? [],
    longitud: a.plan.longitud,
    terceros: a.plan.terceros.map((t) => [t.codigo, t.accion, t.ficha?.id ?? null, t.sustituye ?? null]),
    historico: a.diario && !a.excluidos.includes('DIARIO') ? [a.diario.resumen, a.diario.asientos.length] : null,
    apertura: a.apertura ? [a.apertura.lineas.map((l) => [l.cuenta, l.debe, l.haber]), a.apertura.sustituye.map((s) => s.id)] : null,
    cartera: a.cartera ? [...a.cartera.partidas, ...a.cartera.sinDetalle].map((p) => [p.tipo, p.subcuenta, p.documento, p.pendiente]) : null,
    inmovilizado: a.inmovilizado && !a.excluidos.includes('INMOVILIZADO') ? a.inmovilizado.activos.map((x) => [x.descripcion, x.cuentaBien, x.coste, x.amortAcumulada]) : null,
    llevanza: a.marcaLlevanzaExterna,
    retirados: a.retirados,
    vigente: a.cargaVigente?.id ?? null,
    repeticion: [a.repeticion.modo, a.repeticion.partidasMantenidas.map((p) => p.id), a.repeticion.activosMantenidos.map((x) => x.id)],
    nivel: a.comprobaciones.nivel,
    puntos: a.comprobaciones.puntos.map((p) => [p.clave, p.nivel]),
  };
  return createHash('sha256').update(JSON.stringify(resumen)).digest('hex');
}

// ---------------------------------------------------------------------------
// Lo que se ensena en pantalla
// ---------------------------------------------------------------------------

export interface VistaCarga {
  ejercicio: number;
  tipoCarga: TipoCarga;
  hojas: HojaAnalizada[];
  repetidos: string[];
  plan: {
    cuentas: number;
    nuevas: number;
    existentes: number;
    nuevasMuestra: Array<{ codigo: string; nombre: string }>;
    fueraDelPlan: string[];
    nombresCambian: Array<{ codigo: string; actual: string; nuevo: string }>;
    nombresSeQuedan: Array<{ codigo: string; actual: string; nuevo: string; motivo: string }>;
    omitidas: Array<{ codigo: string; motivo: string }>;
    longitud: VistaPlan['longitud'];
    avisos: string[];
  };
  terceros: { resumen: VistaPlan['resumen']; lista: VistaPlan['terceros'] };
  historico: {
    asientos: number;
    apuntes: number;
    desde: string;
    hasta: string;
    especiales: AnalisisDiario['especiales'];
    cuadraConSumasYSaldos: boolean | null;
    seImporta: boolean;
  } | null;
  apertura: {
    fecha: string;
    origen: 'SUMAS_Y_SALDOS' | 'DIARIO';
    tipoSumasSaldos: AnalisisSaldos['tipo'];
    lineas: number;
    debe: number;
    haber: number;
    masas: AnalisisSaldos['masas'];
    resultado: number;
    sustituye: string[];
  } | null;
  cartera: {
    partidas: number;
    cobros: number;
    pagos: number;
    sinDetalle: number;
    facturasEnlazadas: number;
    cuadre: ResultadoCartera['cuadre'];
  } | null;
  inmovilizado: { activos: number; coste: number; amortAcumulada: number; seImporta: boolean } | null;
  llevanzaExterna: boolean;
  retirados: Record<string, number>;
  sustituyeVersion: number | null;
  /** Bancos de la apertura: saldo contable, extracto escrito y cuenta de Tesoreria. */
  bancos: BancoComprobar[] | null;
  /** Frente a la carga vigente (otra provisional o la definitiva). */
  repeticion: {
    modo: AnalisisRepeticion['modo'];
    textoModo: string;
    /** Subcuentas que cambian (como mucho 500), con el filtro «solo diferencias» ya hecho. */
    diferencias: AnalisisRepeticion['comparacion'];
    totalDiferencias: number;
    partidasQueSiguen: number;
    activosQueSiguen: number;
  } | null;
  datosFiscales: AjustesCarga['datosFiscales'] | null;
  /** Resultado de 2026 que escribio la persona («Resultado segun la gestoria»). */
  resultadoDeclarado: number | null;
  comprobaciones: ResultadoComprobaciones;
  /** Frase del dialogo de confirmacion. */
  confirmacion: string;
  puedeConfirmar: boolean;
  huella: string;
}

export function vistaDe(a: AnalisisCarga): VistaCarga {
  const debe = round2(a.apertura?.lineas.reduce((s, l) => s + l.debe, 0) ?? 0);
  const haber = round2(a.apertura?.lineas.reduce((s, l) => s + l.haber, 0) ?? 0);
  const fichas = a.plan.resumen.crear + a.plan.resumen.enlazar;
  const historico = a.diario && !a.excluidos.includes('DIARIO') ? a.diario.resumen.asientos : 0;
  const partes = [
    a.plan.cuentasNuevas.length ? varios(a.plan.cuentasNuevas.length, 'cuenta', 'cuentas') : '',
    fichas ? varios(fichas, 'cliente o proveedor', 'clientes y proveedores') : '',
    historico ? varios(historico, `asiento de ${a.ejercicio - 1}`, `asientos de ${a.ejercicio - 1}`) : '',
    a.apertura ? `la apertura del 1-1-${a.ejercicio}` : '',
    a.cartera && a.cartera.partidas.length + a.cartera.sinDetalle.length ? varios(a.cartera.partidas.length + a.cartera.sinDetalle.length, 'factura pendiente', 'facturas pendientes') : '',
    a.inmovilizado && a.inmovilizado.activos.length && !a.excluidos.includes('INMOVILIZADO') ? varios(a.inmovilizado.activos.length, 'bien de inmovilizado', 'bienes de inmovilizado') : '',
  ].filter(Boolean);
  const lista = partes.length > 1 ? `${partes.slice(0, -1).join(', ')} y ${partes[partes.length - 1]}` : (partes[0] ?? 'nada nuevo');
  // Lo que mas importa a quien no sabe de contabilidad: desde ahora no se apunta nada de ese año.
  const anterior = a.ejercicio - 1;
  const totalRetirados = Object.values(a.retirados).reduce((s, n) => s + n, 0);
  const consecuencias = [
    a.marcaLlevanzaExterna ? ` ${anterior} quedará como «lo llevó la gestoría»: se podrá consultar, pero no apuntar nada con fecha de ${anterior}.` : '',
    a.fijaInicioEnApp
      ? ` Los impuestos se llevarán en la app desde el 1-1-${a.ejercicio}: los modelos de ${anterior} los presentó la gestoría y no saldrán como pendientes.`
      : '',
    totalRetirados
      ? ` ${varios(totalRetirados, `asiento de ${anterior} apuntado en la app se retira (no se borra).`, `asientos de ${anterior} apuntados en la app se retiran (no se borran).`)}`
      : '',
  ].join('');
  return {
    ejercicio: a.ejercicio,
    tipoCarga: a.tipoCarga,
    hojas: a.datos.hojas,
    repetidos: a.datos.repetidos,
    plan: {
      cuentas: a.cuentas.length,
      nuevas: a.plan.cuentasNuevas.length,
      existentes: a.plan.cuentasExistentes,
      nuevasMuestra: a.plan.cuentasNuevas.slice(0, 50).map((c) => ({ codigo: c.codigo, nombre: c.nombre })),
      fueraDelPlan: a.fueraDelPlan.slice(0, 50),
      nombresCambian: a.plan.nombres?.cambian ?? [],
      nombresSeQuedan: a.plan.nombres?.seQuedan ?? [],
      omitidas: a.plan.omitidas,
      longitud: a.plan.longitud,
      avisos: a.plan.avisos,
    },
    terceros: { resumen: a.plan.resumen, lista: a.plan.terceros },
    historico: a.diario
      ? {
          ...a.diario.resumen,
          especiales: a.diario.especiales,
          cuadraConSumasYSaldos: a.diario.comparacion ? a.diario.comparacion.cuadra : null,
          seImporta: !a.excluidos.includes('DIARIO') && a.diario.descuadrados.length === 0,
        }
      : null,
    apertura:
      a.apertura && a.saldos
        ? {
            fecha: a.apertura.fecha,
            origen: a.saldos.origen,
            tipoSumasSaldos: a.saldos.analisis.tipo,
            lineas: a.apertura.lineas.length,
            debe,
            haber,
            masas: a.saldos.analisis.masas,
            resultado: a.saldos.analisis.resultado,
            sustituye: a.apertura.sustituye.map((s) => s.numero),
          }
        : null,
    cartera: a.cartera
      ? {
          partidas: a.cartera.partidas.length,
          cobros: round2(a.cartera.partidas.filter((p) => p.tipo === 'COBRO').reduce((s, p) => s + p.pendiente, 0)),
          pagos: round2(a.cartera.partidas.filter((p) => p.tipo === 'PAGO').reduce((s, p) => s + p.pendiente, 0)),
          sinDetalle: a.cartera.sinDetalle.length,
          facturasEnlazadas: a.cartera.facturas.size,
          cuadre: a.cartera.cuadre,
        }
      : null,
    inmovilizado: a.inmovilizado
      ? {
          activos: a.inmovilizado.activos.length,
          coste: round2(a.inmovilizado.activos.reduce((s, x) => s + x.coste, 0)),
          amortAcumulada: round2(a.inmovilizado.activos.reduce((s, x) => s + x.amortAcumulada, 0)),
          seImporta: !a.excluidos.includes('INMOVILIZADO'),
        }
      : null,
    llevanzaExterna: a.marcaLlevanzaExterna,
    retirados: a.retirados,
    sustituyeVersion: a.cargaVigente?.version ?? null,
    bancos: a.bancos,
    repeticion: a.cargaVigente
      ? {
          modo: a.repeticion.modo,
          textoModo:
            a.repeticion.modo === 'COMPLEMENTARIO'
              ? `Enero de ${a.ejercicio} está bloqueado: la apertura no se toca y las diferencias van en un asiento de ajuste del 1-1-${a.ejercicio}.`
              : a.repeticion.modo === 'REEMPLAZAR'
                ? `La apertura del 1-1-${a.ejercicio} se sustituye por la nueva.`
                : `Se pone la apertura del 1-1-${a.ejercicio}.`,
          diferencias: a.repeticion.comparacion.slice(0, 500),
          totalDiferencias: a.repeticion.comparacion.length,
          partidasQueSiguen: a.repeticion.partidasMantenidas.length,
          activosQueSiguen: a.repeticion.activosMantenidos.length,
        }
      : null,
    datosFiscales: a.ajustes.datosFiscales ?? null,
    resultadoDeclarado: a.ajustes.resultadoDeclarado ?? null,
    comprobaciones: a.comprobaciones,
    confirmacion: `Se crearán ${lista}.${consecuencias} Podrás deshacerlo mientras no haya cobros ni pagos de ${a.ejercicio} sobre estos datos.`,
    puedeConfirmar: a.comprobaciones.nivel !== 'ERRORES',
    huella: a.huella,
  };
}

/** Importe en texto para los mensajes (reexportado para las fases). */
export const eur = importeTexto;
/** Saldos del sumas y saldos (reexportado para el comparativo). */
export type { CuentaSaldo };
