/**
 * Puesta en marcha: traer la contabilidad de otro programa.
 *
 *  a. Balance de sumas y saldos al cierre del ultimo ejercicio -> asiento de APERTURA.
 *  b. Libro diario / mayor del ejercicio en curso hasta la fecha de arranque -> asientos.
 *  c. Balance y PyG de ejercicios anteriores -> solo comparativo (PriorYearData), sin asientos.
 *
 * Sin estado entre peticiones (Vercel): la vista previa y la confirmacion leen
 * el mismo fichero (o los mismos datos ya mapeados) y hacen el mismo calculo.
 */
import { prisma } from '../../config/database';
import { badRequest, conflict } from '../../utils/http-errors';
import { aCentimos } from '../../utils/money';
import type { SaldosEjercicio } from '../contabilidadDatos.service';
import { anularAsientos, grabarAsientos, OPCIONES_TX, rangoEjercicio, type AsientoNuevo, type Tx } from './asientosEnBloque';
import {
  agruparAsientos,
  normalizarCuenta,
  totalesSaldos,
  type Agrupacion,
  type CuentaSaldo,
  type LecturaBalance,
  type LecturaDiario,
} from './lectorContable';
import { analizarCuentas, crearCuentasNuevas, prepararPlanEmpresa, type CuentaNueva } from './planCuentas';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const esPyg = (codigo: string) => codigo.startsWith('6') || codigo.startsWith('7');
const fechaEs = (f: string) => f.split('-').reverse().join('/');

/** Lectura sin las cuentas/apuntes (lo que se devuelve para poder corregir el mapeo). */
type InfoLectura = Omit<LecturaBalance, 'cuentas'> | Omit<LecturaDiario, 'apuntes'>;

function infoLectura<T extends LecturaBalance | LecturaDiario>(l: T | null): InfoLectura | null {
  if (!l) return null;
  const copia = { ...l } as Partial<LecturaBalance & LecturaDiario>;
  delete copia.cuentas;
  delete copia.apuntes;
  return copia as InfoLectura;
}

/** Cuenta 129 a usar: la que ya traiga el fichero o, si no, la longitud habitual de sus codigos. */
export function cuentaResultado(codigos: string[]): string {
  const existente = codigos.filter((c) => c.startsWith('129')).sort()[0];
  if (existente) return existente;
  const largos = new Map<number, number>();
  for (const c of codigos) largos.set(c.length, (largos.get(c.length) ?? 0) + 1);
  const largo = [...largos.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
  return '129'.padEnd(Math.max(3, largo), '0');
}

/** Saldos recibidos como JSON (datos ya mapeados por el cliente). */
export function cuentasDesdeJson(valor: unknown): CuentaSaldo[] {
  let lista = valor;
  if (typeof lista === 'string') {
    try {
      lista = JSON.parse(lista);
    } catch {
      throw badRequest('Las cuentas enviadas no son un JSON válido.');
    }
  }
  if (!Array.isArray(lista)) throw badRequest('Envía un fichero o la lista de cuentas con su saldo.');
  const out = new Map<string, CuentaSaldo>();
  for (const item of lista as Array<Record<string, unknown>>) {
    const codigo = normalizarCuenta(item?.codigo);
    const saldo = Number(item?.saldo);
    if (!codigo || !Number.isFinite(saldo)) throw badRequest(`Cuenta o saldo no válido: ${JSON.stringify(item).slice(0, 80)}`);
    const previa = out.get(codigo);
    if (previa) previa.saldo = round2(previa.saldo + saldo);
    else out.set(codigo, { codigo, nombre: String(item.nombre ?? '').slice(0, 150), saldo: round2(saldo) });
  }
  return [...out.values()].filter((c) => aCentimos(c.saldo) !== 0);
}

async function ejercicioCerrado(companyId: string, ejercicio: number): Promise<boolean> {
  const fy = await prisma.fiscalYear.findFirst({ where: { companyId, label: String(ejercicio) } });
  if (fy?.estado === 'CLOSED') return true;
  const cierre = await prisma.journalEntry.findFirst({
    where: { companyId, estado: 'POSTED', origen: { in: ['REGULARIZACION', 'CIERRE'] }, fecha: rangoEjercicio(ejercicio) },
    select: { id: true },
  });
  return !!cierre;
}

/** Crea el ejercicio (FiscalYear) si no existe. */
export async function asegurarEjercicio(tx: Tx, companyId: string, ejercicio: number) {
  const label = String(ejercicio);
  const fy = await tx.fiscalYear.findFirst({ where: { companyId, label } });
  if (fy) return fy;
  return tx.fiscalYear.create({
    data: { companyId, label, fechaInicio: `${ejercicio}-01-01`, fechaFin: `${ejercicio}-12-31`, estado: 'OPEN' },
  });
}

function validarEjercicio(raw: unknown): number {
  const e = Number(raw);
  if (!Number.isInteger(e) || e < 1990 || e > 2100) throw badRequest('Indica el ejercicio (año) correcto.');
  return e;
}

// ---------------------------------------------------------------------------
// a. Asiento de apertura
// ---------------------------------------------------------------------------

export interface OpcionesApertura {
  ejercicio?: unknown;
  fecha?: unknown;
  reemplazar?: boolean;
  guardarComparativo?: boolean;
}

export interface LineaVista {
  cuenta: string;
  nombre: string;
  debe: number;
  haber: number;
}

export interface VistaApertura {
  ejercicio: number;
  fecha: string;
  lectura: InfoLectura | null;
  cuentas: Array<CuentaSaldo & { nueva: boolean; pyg: boolean }>;
  totales: { deudor: number; acreedor: number; diferencia: number; cuadra: boolean };
  pyg: { cuentas: number; resultado: number; cuentaResultado: string };
  asiento: { fecha: string; concepto: string; lineas: LineaVista[]; debe: number; haber: number; cuadra: boolean };
  cuentasNuevas: CuentaNueva[];
  aperturaExistente: { id: string; numero: string; fecha: string } | null;
  errores: string[];
  avisos: string[];
  puedeConfirmar: boolean;
}

async function aperturaDelEjercicio(companyId: string, ejercicio: number) {
  return prisma.journalEntry.findFirst({
    where: { companyId, estado: 'POSTED', origen: 'APERTURA', fecha: rangoEjercicio(ejercicio) },
    orderBy: { fecha: 'desc' },
    select: { id: true, numeroAsiento: true, fecha: true },
  });
}

export async function previsualizarApertura(
  companyId: string,
  entrada: { lectura?: LecturaBalance; cuentas?: CuentaSaldo[] },
  opciones: OpcionesApertura,
): Promise<VistaApertura> {
  const cuentas = entrada.lectura?.cuentas ?? entrada.cuentas ?? [];
  if (cuentas.length === 0) throw badRequest('No hay cuentas con saldo que importar.');

  // Ejercicio y fecha: la indicada, o el 1 de enero del ejercicio.
  let ejercicio: number;
  let fecha: string;
  if (opciones.fecha) {
    fecha = String(opciones.fecha);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || Number.isNaN(Date.parse(fecha))) throw badRequest('La fecha de apertura tiene que ser AAAA-MM-DD.');
    ejercicio = opciones.ejercicio !== undefined && opciones.ejercicio !== '' ? validarEjercicio(opciones.ejercicio) : Number(fecha.slice(0, 4));
    if (Number(fecha.slice(0, 4)) !== ejercicio) throw badRequest(`La fecha de apertura (${fechaEs(fecha)}) no es del ejercicio ${ejercicio}.`);
  } else {
    ejercicio = validarEjercicio(opciones.ejercicio ?? new Date().getFullYear());
    const fy = await prisma.fiscalYear.findFirst({ where: { companyId, label: String(ejercicio) } });
    fecha = fy?.fechaInicio && fy.fechaInicio.startsWith(String(ejercicio)) ? fy.fechaInicio : `${ejercicio}-01-01`;
  }

  const errores: string[] = [];
  const avisos: string[] = [...(entrada.lectura?.avisos ?? [])];

  const { nombres, nuevas, errores: erroresPlan } = await analizarCuentas(companyId, cuentas);
  errores.push(...erroresPlan);

  const balance = cuentas.filter((c) => !esPyg(c.codigo));
  const pygCuentas = cuentas.filter((c) => esPyg(c.codigo));
  const resultado = round2(-pygCuentas.reduce((s, c) => s + c.saldo, 0)); // > 0 beneficio
  const c129 = cuentaResultado(cuentas.map((c) => c.codigo));

  // Lineas del asiento: saldos de balance + resultado de la PyG en la 129.
  const porCuenta = new Map<string, number>();
  for (const c of balance) porCuenta.set(c.codigo, round2((porCuenta.get(c.codigo) ?? 0) + c.saldo));
  if (aCentimos(resultado) !== 0) {
    porCuenta.set(c129, round2((porCuenta.get(c129) ?? 0) - resultado));
    avisos.push(
      `El fichero trae ${pygCuentas.length} cuenta(s) de gastos e ingresos (grupos 6 y 7). Su resultado, ${resultado.toLocaleString('es-ES', { minimumFractionDigits: 2 })} € (${resultado >= 0 ? 'beneficio' : 'pérdida'}), se lleva a la cuenta ${c129} (Resultado del ejercicio).`,
    );
  }
  if (!nombres.has(c129) && porCuenta.has(c129)) {
    const extra = await analizarCuentas(companyId, [{ codigo: c129, nombre: 'Resultado del ejercicio' }]);
    for (const [k, v] of extra.nombres) nombres.set(k, v);
    nuevas.push(...extra.nuevas);
  }

  const lineas: LineaVista[] = [...porCuenta.entries()]
    .filter(([, s]) => aCentimos(s) !== 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cuenta, s]) => ({ cuenta, nombre: nombres.get(cuenta) ?? '', debe: s > 0 ? s : 0, haber: s < 0 ? round2(-s) : 0 }));
  const debe = round2(lineas.reduce((s, l) => s + l.debe, 0));
  const haber = round2(lineas.reduce((s, l) => s + l.haber, 0));
  const cuadra = aCentimos(debe) === aCentimos(haber);

  const tot = totalesSaldos(cuentas);
  if (!cuadra) {
    errores.push(
      `El balance no cuadra: saldos deudores ${tot.deudor.toFixed(2)} € y acreedores ${tot.acreedor.toFixed(2)} € (diferencia ${tot.diferencia.toFixed(2)} €). Revisa que el fichero tenga todas las cuentas y el signo de los saldos.`,
    );
  }

  if (await ejercicioCerrado(companyId, ejercicio)) {
    errores.push(`El ejercicio ${ejercicio} está cerrado: no se le puede añadir un asiento de apertura.`);
  }
  const previa = await aperturaDelEjercicio(companyId, ejercicio);
  const aperturaExistente = previa ? { id: previa.id, numero: previa.numeroAsiento, fecha: previa.fecha.toISOString().slice(0, 10) } : null;
  if (aperturaExistente) {
    const txt = `Ya hay un asiento de apertura del ejercicio ${ejercicio} (${aperturaExistente.numero}, ${fechaEs(aperturaExistente.fecha)}).`;
    if (opciones.reemplazar) avisos.push(`${txt} Se anulará y se creará el nuevo.`);
    else errores.push(`${txt} Marca "Reemplazar la apertura anterior" para anularlo y crear el nuevo.`);
  }

  const movimientosAntes = await prisma.journalEntry.count({
    where: { companyId, estado: 'POSTED', origen: { not: 'APERTURA' }, fecha: { gte: rangoEjercicio(ejercicio).gte, lt: new Date(`${fecha}T00:00:00.000Z`) } },
  });
  if (movimientosAntes > 0) {
    avisos.push(`Hay ${movimientosAntes} asiento(s) del ${ejercicio} con fecha anterior a la apertura (${fechaEs(fecha)}): no contarán en el balance.`);
  }

  return {
    ejercicio,
    fecha,
    lectura: infoLectura(entrada.lectura ?? null),
    cuentas: cuentas.map((c) => ({ ...c, nombre: c.nombre || nombres.get(c.codigo) || '', nueva: nuevas.some((n) => n.codigo === c.codigo), pyg: esPyg(c.codigo) })),
    totales: { ...tot, cuadra },
    pyg: { cuentas: pygCuentas.length, resultado, cuentaResultado: c129 },
    asiento: { fecha, concepto: `Apertura ejercicio ${ejercicio}`, lineas, debe, haber, cuadra },
    cuentasNuevas: nuevas,
    aperturaExistente,
    errores,
    avisos,
    puedeConfirmar: errores.length === 0,
  };
}

export async function confirmarApertura(
  companyId: string,
  entrada: { lectura?: LecturaBalance; cuentas?: CuentaSaldo[] },
  opciones: OpcionesApertura,
): Promise<{ vista: VistaApertura; asiento: { id: string; numero: string }; anulados: number; cuentasCreadas: number; comparativoGuardado: boolean }> {
  const vista = await previsualizarApertura(companyId, entrada, opciones);
  if (vista.aperturaExistente && !opciones.reemplazar) {
    throw conflict(vista.errores.find((e) => e.startsWith('Ya hay')) ?? 'Ya hay un asiento de apertura de ese ejercicio.', { aperturaExistente: vista.aperturaExistente });
  }
  if (!vista.puedeConfirmar) throw badRequest(vista.errores[0], { errores: vista.errores });

  await prepararPlanEmpresa(companyId);
  const cuentas = entrada.lectura?.cuentas ?? entrada.cuentas ?? [];

  const resultado = await prisma.$transaction(async (tx) => {
    // Repetir la comprobacion dentro de la transaccion (dos clics seguidos).
    const previas = await tx.journalEntry.findMany({
      where: { companyId, estado: 'POSTED', origen: 'APERTURA', fecha: rangoEjercicio(vista.ejercicio) },
      select: { id: true },
    });
    if (previas.length && !opciones.reemplazar) throw conflict(`Ya hay un asiento de apertura del ejercicio ${vista.ejercicio}.`);
    const anulados = await anularAsientos(tx, companyId, previas.map((p) => p.id));

    await asegurarEjercicio(tx, companyId, vista.ejercicio);
    const cuentasCreadas = await crearCuentasNuevas(tx, companyId, vista.cuentasNuevas);
    const [asiento] = await grabarAsientos(tx, companyId, [
      {
        fecha: vista.fecha,
        concepto: vista.asiento.concepto,
        origen: 'APERTURA',
        lineas: vista.asiento.lineas.map((l) => ({ ...l, referencia: 'Saldos importados' })),
      },
    ]);
    return { asiento, anulados, cuentasCreadas };
  }, OPCIONES_TX);

  // El mismo balance sirve de comparativo (columna N-1) del ejercicio anterior.
  let comparativoGuardado = false;
  if (opciones.guardarComparativo) {
    await guardarSaldosComparativo(companyId, vista.ejercicio - 1, cuentas, 'todo', 'Balance de apertura importado');
    comparativoGuardado = true;
  }

  return { vista, ...resultado, comparativoGuardado };
}

/** Anula la apertura del ejercicio (p. ej. para volver a importar). */
export async function anularApertura(companyId: string, ejercicio: number): Promise<{ anulados: number }> {
  if (await ejercicioCerrado(companyId, ejercicio)) throw badRequest(`El ejercicio ${ejercicio} está cerrado: deshaz antes el cierre.`);
  return prisma.$transaction(async (tx) => {
    const previas = await tx.journalEntry.findMany({
      where: { companyId, estado: 'POSTED', origen: 'APERTURA', fecha: rangoEjercicio(ejercicio) },
      select: { id: true },
    });
    if (!previas.length) throw badRequest(`El ejercicio ${ejercicio} no tiene asiento de apertura.`);
    return { anulados: await anularAsientos(tx, companyId, previas.map((p) => p.id)) };
  });
}

// ---------------------------------------------------------------------------
// b. Libro diario / mayor del ejercicio en curso
// ---------------------------------------------------------------------------

export interface OpcionesDiario {
  ejercicio?: unknown;
  agrupacion?: Agrupacion;
  incluirEspeciales?: boolean;
  reemplazar?: boolean;
}

export interface VistaDiario {
  ejercicio: number;
  agrupacion: Exclude<Agrupacion, 'auto'>;
  lectura: InfoLectura | null;
  resumen: { asientos: number; apuntes: number; debe: number; haber: number; desde: string; hasta: string };
  descuadrados: Array<{ clave: string; fecha: string; debe: number; haber: number; diferencia: number }>;
  excluidos: Array<{ clave: string; fecha: string; tipo: string; importe: number }>;
  fueraDeEjercicio: number;
  muestra: Array<{ clave: string; fecha: string; concepto: string; lineas: LineaVista[]; debe: number; haber: number }>;
  cuentasNuevas: CuentaNueva[];
  apertura: { numero: string; fecha: string } | null;
  importacionPrevia: { asientos: number } | null;
  errores: string[];
  avisos: string[];
  puedeConfirmar: boolean;
}

async function prepararDiario(companyId: string, lectura: LecturaDiario, opciones: OpcionesDiario) {
  const errores: string[] = [];
  const avisos: string[] = [...lectura.avisos];

  const anios = new Map<number, number>();
  for (const a of lectura.apuntes) anios.set(Number(a.fecha.slice(0, 4)), (anios.get(Number(a.fecha.slice(0, 4))) ?? 0) + 1);
  const ejercicio =
    opciones.ejercicio !== undefined && opciones.ejercicio !== ''
      ? validarEjercicio(opciones.ejercicio)
      : [...anios.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const delEjercicio = lectura.apuntes.filter((a) => a.fecha.startsWith(String(ejercicio)));
  const fueraDeEjercicio = lectura.apuntes.length - delEjercicio.length;
  if (fueraDeEjercicio > 0) {
    errores.push(`${fueraDeEjercicio} apunte(s) no son del ejercicio ${ejercicio}. Importa un fichero por ejercicio (solo el del año en curso; los anteriores van como balance de apertura).`);
  }

  const { asientos, agrupacion } = agruparAsientos(delEjercicio, opciones.agrupacion ?? 'auto');
  const excluidos = opciones.incluirEspeciales ? [] : asientos.filter((a) => a.especial);
  const aImportar = asientos.filter((a) => !excluidos.includes(a));
  if (excluidos.length) {
    avisos.push(
      `Se omiten ${excluidos.length} asiento(s) de apertura, regularización o cierre del fichero: la apertura se hace con el balance importado y el cierre con "Cierre y traspaso de saldos".`,
    );
  }

  const descuadrados = aImportar
    .filter((a) => !a.cuadra)
    .map((a) => ({ clave: a.clave, fecha: a.fecha, debe: a.debe, haber: a.haber, diferencia: round2(a.debe - a.haber) }));
  if (descuadrados.length) {
    errores.push(
      agrupacion === 'asiento'
        ? `${descuadrados.length} asiento(s) no cuadran (Debe distinto de Haber). Revisa que el fichero tenga todos los apuntes de cada asiento.`
        : `${descuadrados.length} ${agrupacion === 'fecha' ? 'día(s)' : 'mes(es)'} no cuadran. Si el fichero es un mayor de solo algunas cuentas, faltan las contrapartidas: exporta el diario completo o el mayor de todas las cuentas.`,
    );
  }

  const cuentasFichero = new Map<string, string>();
  for (const a of aImportar) for (const l of a.lineas) if (!cuentasFichero.has(l.cuenta) || (!cuentasFichero.get(l.cuenta) && l.nombre)) cuentasFichero.set(l.cuenta, l.nombre);
  const { nombres, nuevas, errores: erroresPlan } = await analizarCuentas(
    companyId,
    [...cuentasFichero.entries()].map(([codigo, nombre]) => ({ codigo, nombre })),
  );
  errores.push(...erroresPlan);

  if (await ejercicioCerrado(companyId, ejercicio)) errores.push(`El ejercicio ${ejercicio} está cerrado: no se pueden añadir asientos.`);

  const ap = await aperturaDelEjercicio(companyId, ejercicio);
  const apertura = ap ? { numero: ap.numeroAsiento, fecha: ap.fecha.toISOString().slice(0, 10) } : null;
  if (!apertura) {
    avisos.push(`El ejercicio ${ejercicio} aún no tiene asiento de apertura: importa antes el balance del cierre anterior o las cuentas de balance empezarán en cero.`);
  } else {
    const antes = aImportar.filter((a) => a.fecha < apertura.fecha).length;
    if (antes) errores.push(`${antes} asiento(s) tienen fecha anterior a la apertura (${fechaEs(apertura.fecha)}) y no contarían en el balance.`);
  }

  const previos = await prisma.journalEntry.count({ where: { companyId, estado: 'POSTED', origen: 'IMPORTACION', fecha: rangoEjercicio(ejercicio) } });
  const importacionPrevia = previos ? { asientos: previos } : null;
  if (importacionPrevia) {
    const txt = `Ya se importaron ${previos} asiento(s) del ${ejercicio}.`;
    if (opciones.reemplazar) avisos.push(`${txt} Se anularán y se cargarán los de este fichero.`);
    else errores.push(`${txt} Marca "Reemplazar la importación anterior" para no duplicarlos.`);
  }

  const nApuntes = aImportar.reduce((s, a) => s + a.lineas.length, 0);
  const vista: VistaDiario = {
    ejercicio,
    agrupacion,
    lectura: infoLectura(lectura),
    resumen: {
      asientos: aImportar.length,
      apuntes: nApuntes,
      debe: round2(aImportar.reduce((s, a) => s + a.debe, 0)),
      haber: round2(aImportar.reduce((s, a) => s + a.haber, 0)),
      desde: aImportar[0]?.fecha ?? '',
      hasta: aImportar[aImportar.length - 1]?.fecha ?? '',
    },
    descuadrados: descuadrados.slice(0, 50),
    excluidos: excluidos.map((a) => ({ clave: a.clave, fecha: a.fecha, tipo: a.especial!, importe: a.debe })),
    fueraDeEjercicio,
    muestra: aImportar.slice(0, 15).map((a) => ({
      clave: a.clave,
      fecha: a.fecha,
      concepto: a.concepto,
      lineas: a.lineas.map((l) => ({ cuenta: l.cuenta, nombre: l.nombre || nombres.get(l.cuenta) || '', debe: l.debe, haber: l.haber })),
      debe: a.debe,
      haber: a.haber,
    })),
    cuentasNuevas: nuevas,
    apertura,
    importacionPrevia,
    errores,
    avisos,
    puedeConfirmar: errores.length === 0 && aImportar.length > 0,
  };
  return { vista, aImportar, nombres };
}

export async function previsualizarDiario(companyId: string, lectura: LecturaDiario, opciones: OpcionesDiario): Promise<VistaDiario> {
  return (await prepararDiario(companyId, lectura, opciones)).vista;
}

export async function confirmarDiario(
  companyId: string,
  lectura: LecturaDiario,
  opciones: OpcionesDiario,
): Promise<{ vista: VistaDiario; asientosCreados: number; anulados: number; cuentasCreadas: number }> {
  const { vista, aImportar, nombres } = await prepararDiario(companyId, lectura, opciones);
  if (vista.importacionPrevia && !opciones.reemplazar) {
    throw conflict(vista.errores.find((e) => e.startsWith('Ya se importaron')) ?? 'Ya hay asientos importados de ese ejercicio.');
  }
  if (!vista.puedeConfirmar) throw badRequest(vista.errores[0] ?? 'No hay asientos que importar.', { errores: vista.errores });

  await prepararPlanEmpresa(companyId);
  const asientos: AsientoNuevo[] = aImportar.map((a) => ({
    fecha: a.fecha,
    concepto: a.concepto,
    origen: 'IMPORTACION',
    lineas: a.lineas.map((l) => ({
      cuenta: l.cuenta,
      nombre: nombres.get(l.cuenta) || l.nombre,
      debe: l.debe,
      haber: l.haber,
      referencia: [a.numeroOriginal ? `As. ${a.numeroOriginal}` : '', l.concepto].filter(Boolean).join(' · ') || undefined,
    })),
  }));

  return prisma.$transaction(async (tx) => {
    const previos = await tx.journalEntry.findMany({
      where: { companyId, estado: 'POSTED', origen: 'IMPORTACION', fecha: rangoEjercicio(vista.ejercicio) },
      select: { id: true },
    });
    if (previos.length && !opciones.reemplazar) throw conflict(`Ya hay asientos importados del ejercicio ${vista.ejercicio}.`);
    const anulados = await anularAsientos(tx, companyId, previos.map((p) => p.id));
    await asegurarEjercicio(tx, companyId, vista.ejercicio);
    const cuentasCreadas = await crearCuentasNuevas(tx, companyId, vista.cuentasNuevas);
    const creados = await grabarAsientos(tx, companyId, asientos);
    return { vista, asientosCreados: creados.length, anulados, cuentasCreadas };
  }, OPCIONES_TX);
}

/** Anula los asientos importados de un ejercicio. */
export async function anularDiarioImportado(companyId: string, ejercicio: number): Promise<{ anulados: number }> {
  if (await ejercicioCerrado(companyId, ejercicio)) throw badRequest(`El ejercicio ${ejercicio} está cerrado: deshaz antes el cierre.`);
  return prisma.$transaction(async (tx) => {
    const previos = await tx.journalEntry.findMany({
      where: { companyId, estado: 'POSTED', origen: 'IMPORTACION', fecha: rangoEjercicio(ejercicio) },
      select: { id: true },
    });
    if (!previos.length) throw badRequest(`No hay asientos importados del ejercicio ${ejercicio}.`);
    return { anulados: await anularAsientos(tx, companyId, previos.map((p) => p.id)) };
  }, OPCIONES_TX);
}

// ---------------------------------------------------------------------------
// c. Balance y PyG de ejercicios anteriores (solo comparativo)
// ---------------------------------------------------------------------------

export type ParteComparativo = 'todo' | 'balance' | 'pyg';

interface DatosComparativo {
  formato: 'saldos-v1';
  cuentas: CuentaSaldo[];
}

function leerDatosComparativo(json: string | null | undefined): DatosComparativo | null {
  if (!json) return null;
  try {
    const d = JSON.parse(json) as DatosComparativo;
    return d?.formato === 'saldos-v1' && Array.isArray(d.cuentas) ? d : null;
  } catch {
    return null;
  }
}

function resumenComparativo(cuentas: CuentaSaldo[]) {
  const balance = cuentas.filter((c) => !esPyg(c.codigo));
  const pyg = cuentas.filter((c) => esPyg(c.codigo));
  const ingresos = round2(-pyg.filter((c) => c.codigo.startsWith('7')).reduce((s, c) => s + c.saldo, 0));
  const gastos = round2(pyg.filter((c) => c.codigo.startsWith('6')).reduce((s, c) => s + c.saldo, 0));
  return {
    cuentasBalance: balance.length,
    cuentasPyg: pyg.length,
    ingresos,
    gastos,
    resultado: round2(ingresos - gastos),
    totalesBalance: totalesSaldos(balance),
  };
}

function combinar(existentes: CuentaSaldo[], nuevas: CuentaSaldo[], parte: ParteComparativo): CuentaSaldo[] {
  const deLaParte = (c: CuentaSaldo) => parte === 'todo' || (parte === 'pyg' ? esPyg(c.codigo) : !esPyg(c.codigo));
  const quedan = existentes.filter((c) => !deLaParte(c));
  return [...quedan, ...nuevas.filter(deLaParte)].sort((a, b) => a.codigo.localeCompare(b.codigo));
}

export interface VistaComparativo {
  ejercicio: number;
  parte: ParteComparativo;
  lectura: InfoLectura | null;
  cuentas: CuentaSaldo[];
  resumen: ReturnType<typeof resumenComparativo>;
  existente: { cuentas: number; actualizado: string } | null;
  avisos: string[];
  errores: string[];
}

export async function previsualizarComparativo(
  companyId: string,
  entrada: { lectura?: LecturaBalance; cuentas?: CuentaSaldo[] },
  opciones: { ejercicio?: unknown; parte?: ParteComparativo },
): Promise<VistaComparativo> {
  const ejercicio = validarEjercicio(opciones.ejercicio);
  const parte: ParteComparativo = opciones.parte ?? 'todo';
  const leidas = entrada.lectura?.cuentas ?? entrada.cuentas ?? [];
  const avisos = [...(entrada.lectura?.avisos ?? [])];
  const errores: string[] = [];
  const cuentas = leidas.filter((c) => parte === 'todo' || (parte === 'pyg' ? esPyg(c.codigo) : !esPyg(c.codigo)));
  if (cuentas.length < leidas.length) avisos.push(`Se ignoran ${leidas.length - cuentas.length} cuenta(s) que no son ${parte === 'pyg' ? 'de gastos e ingresos' : 'de balance'}.`);
  if (cuentas.length === 0) errores.push(parte === 'pyg' ? 'El fichero no trae cuentas de los grupos 6 y 7.' : 'El fichero no trae cuentas de balance.');
  const resumen = resumenComparativo(cuentas);
  if (parte !== 'pyg' && resumen.cuentasBalance && aCentimos(resumen.totalesBalance.diferencia + (parte === 'todo' ? -resumen.resultado : 0)) !== 0) {
    avisos.push(`El balance no cuadra (diferencia ${resumen.totalesBalance.diferencia.toFixed(2)} €). Se guarda igualmente, solo es información comparativa.`);
  }
  const previo = await prisma.priorYearData.findFirst({ where: { companyId, ejercicio } });
  const datosPrevios = leerDatosComparativo(previo?.datosJSON);
  return {
    ejercicio,
    parte,
    lectura: infoLectura(entrada.lectura ?? null),
    cuentas,
    resumen,
    existente: previo ? { cuentas: datosPrevios?.cuentas.length ?? 0, actualizado: previo.updatedAt.toISOString() } : null,
    avisos,
    errores,
  };
}

async function guardarSaldosComparativo(companyId: string, ejercicio: number, cuentas: CuentaSaldo[], parte: ParteComparativo, origen: string) {
  const previo = await prisma.priorYearData.findFirst({ where: { companyId, ejercicio } });
  const combinadas = combinar(leerDatosComparativo(previo?.datosJSON)?.cuentas ?? [], cuentas, parte);
  const r = resumenComparativo(combinadas);
  const datos = {
    estado: 'CONFIRMADO',
    ingresos: r.ingresos,
    gasto: r.gastos,
    beneficio: r.resultado,
    datosJSON: JSON.stringify({ formato: 'saldos-v1', cuentas: combinadas } satisfies DatosComparativo),
    observaciones: `${origen} el ${new Date().toISOString().slice(0, 10)}`,
  };
  if (previo) return prisma.priorYearData.update({ where: { id: previo.id }, data: datos });
  return prisma.priorYearData.create({ data: { companyId, ejercicio, ...datos } });
}

export async function confirmarComparativo(
  companyId: string,
  entrada: { lectura?: LecturaBalance; cuentas?: CuentaSaldo[] },
  opciones: { ejercicio?: unknown; parte?: ParteComparativo },
): Promise<VistaComparativo> {
  const vista = await previsualizarComparativo(companyId, entrada, opciones);
  if (vista.errores.length) throw badRequest(vista.errores[0], { errores: vista.errores });
  await guardarSaldosComparativo(companyId, vista.ejercicio, vista.cuentas, vista.parte, 'Importado');
  return vista;
}

export async function borrarComparativo(companyId: string, ejercicio: number): Promise<{ borrado: boolean }> {
  const r = await prisma.priorYearData.deleteMany({ where: { companyId, ejercicio } });
  return { borrado: r.count > 0 };
}

/**
 * Saldos importados de un ejercicio anterior, con la forma que usan los estados
 * financieros (columna N-1). null si no hay. Si el balance ya lleva el resultado
 * en la 129 y tambien se importo la PyG, se quita la 129 para no contarlo dos veces.
 */
export async function saldosComparativosImportados(companyId: string, ejercicio: number): Promise<SaldosEjercicio | null> {
  if (typeof (prisma as { priorYearData?: { findFirst?: unknown } }).priorYearData?.findFirst !== 'function') return null;
  let fila;
  try {
    fila = await prisma.priorYearData.findFirst({ where: { companyId, ejercicio } });
  } catch {
    return null;
  }
  const datos = leerDatosComparativo(fila?.datosJSON);
  if (!datos || datos.cuentas.length === 0) return null;

  const balance = new Map<string, number>();
  const pyg = new Map<string, number>();
  for (const c of datos.cuentas) {
    const m = esPyg(c.codigo) ? pyg : balance;
    m.set(c.codigo, round2((m.get(c.codigo) ?? 0) + c.saldo));
  }
  if (pyg.size) {
    const resultado = -[...pyg.values()].reduce((s, v) => s + v, 0);
    const en129 = [...balance.entries()].filter(([k]) => k.startsWith('129'));
    const suma129 = -en129.reduce((s, [, v]) => s + v, 0);
    if (en129.length && aCentimos(resultado) !== 0 && aCentimos(resultado) === aCentimos(suma129)) {
      for (const [k] of en129) balance.delete(k);
    }
  }
  return { balance, pyg, resultadoAnteriores: 0 };
}

// ---------------------------------------------------------------------------
// Estado general
// ---------------------------------------------------------------------------

export async function estadoPuestaEnMarcha(companyId: string) {
  const [ejercicios, aperturas, importados, comparativos] = await Promise.all([
    prisma.fiscalYear.findMany({ where: { companyId }, orderBy: { label: 'desc' }, select: { label: true, estado: true, fechaInicio: true, fechaFin: true } }),
    prisma.journalEntry.findMany({
      where: { companyId, estado: 'POSTED', origen: 'APERTURA' },
      orderBy: { fecha: 'desc' },
      select: { id: true, numeroAsiento: true, fecha: true, lineas: { select: { debe: true } } },
    }),
    prisma.journalEntry.findMany({ where: { companyId, estado: 'POSTED', origen: 'IMPORTACION' }, select: { fecha: true } }),
    prisma.priorYearData.findMany({ where: { companyId }, orderBy: { ejercicio: 'desc' } }),
  ]);

  const porAnio = new Map<number, { asientos: number; desde: string; hasta: string }>();
  for (const e of importados) {
    const f = e.fecha.toISOString().slice(0, 10);
    const y = Number(f.slice(0, 4));
    const r = porAnio.get(y) ?? { asientos: 0, desde: f, hasta: f };
    r.asientos++;
    if (f < r.desde) r.desde = f;
    if (f > r.hasta) r.hasta = f;
    porAnio.set(y, r);
  }

  return {
    ejercicios,
    aperturas: aperturas.map((a) => ({
      ejercicio: a.fecha.getUTCFullYear(),
      id: a.id,
      numero: a.numeroAsiento,
      fecha: a.fecha.toISOString().slice(0, 10),
      importe: round2(a.lineas.reduce((s, l) => s + Number(l.debe), 0)),
      apuntes: a.lineas.length,
    })),
    diariosImportados: [...porAnio.entries()].sort((a, b) => b[0] - a[0]).map(([ejercicio, r]) => ({ ejercicio, ...r })),
    comparativos: comparativos.map((c) => {
      const d = leerDatosComparativo(c.datosJSON);
      const r = d ? resumenComparativo(d.cuentas) : null;
      return {
        ejercicio: c.ejercicio,
        cuentasBalance: r?.cuentasBalance ?? 0,
        cuentasPyg: r?.cuentasPyg ?? 0,
        resultado: r?.resultado ?? Number(c.beneficio),
        actualizado: c.updatedAt.toISOString(),
      };
    }),
  };
}
