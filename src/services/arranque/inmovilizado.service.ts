/**
 * Inmovilizado: fichas de los bienes (traidas de la gestoria o dadas de alta a
 * mano) y la dotacion mensual de su amortizacion.
 *
 *  - La amortizacion se calcula mes a mes (amortizacion.ts) y se apunta en un
 *    asiento por mes, en borrador (68x al debe y 28x al haber, una linea por
 *    bien), que se aprueba en el Motor contable como los demas borradores.
 *  - Cada bien y mes queda en DotacionAmortizacion: un mes ya dotado no se
 *    vuelve a calcular. Anular el asiento del mes deja volver a calcularlo.
 *  - Una ficha se edita mientras no tenga dotaciones; despues solo se le puede
 *    dar de baja.
 *  - Los meses de un año que lleva la gestoria no se dotan en la app (su
 *    amortizacion ya esta en su contabilidad).
 */
import { prisma, type TransaccionBD } from '../../config/database';
import { badRequest, conflict, notFound } from '../../utils/http-errors';
import { aCentimos } from '../../utils/money';
import { registrarAuditoria } from '../auditoria.service';
import { comprobarFechaAbierta } from '../periodos.service';
import { grabarAsientos, OPCIONES_TX } from '../puestaEnMarcha/asientosEnBloque';
import { cuentasDeAmortizacion } from './analisis.service';
import { cuotaDelMes, esPeriodo, mesesEntre, primerMes, valorNeto, type ActivoParaAmortizar } from './amortizacion';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const mesES = (p: string) => `${p.slice(5, 7)}/${p.slice(0, 4)}`;
const ultimoDiaDe = (p: string) => {
  const d = new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(5, 7)), 0)).getUTCDate();
  return `${p}-${String(d).padStart(2, '0')}`;
};

export type FilaActivo = Awaited<ReturnType<typeof prisma.activoFijo.findFirstOrThrow>>;

const paraCalculo = (a: FilaActivo): ActivoParaAmortizar => ({
  coste: Number(a.coste),
  valorResidual: Number(a.valorResidual),
  amortAcumuladaInicial: Number(a.amortAcumuladaInicial),
  coeficiente: Number(a.coeficiente),
  fechaInicioAmortizacion: a.fechaInicioAmortizacion,
  fechaBaja: a.fechaBaja,
});

/** Dotaciones que cuentan: sin anular y con su asiento vivo (si alguien lo anulo en el Motor, ya no cuenta). */
async function dotacionesVigentes(db: TransaccionBD | typeof prisma, companyId: string, activoIds?: string[]) {
  const filas = await db.dotacionAmortizacion.findMany({
    where: { companyId, anulada: false, ...(activoIds ? { activoFijoId: { in: activoIds } } : {}) },
    orderBy: { periodo: 'asc' },
  });
  if (!filas.length) return filas;
  const vivos = new Set(
    (
      await db.journalEntry.findMany({
        where: { companyId, id: { in: [...new Set(filas.map((f) => f.journalEntryId))] }, estado: { in: ['DRAFT', 'PENDING_REVIEW', 'POSTED'] } },
        select: { id: true },
      })
    ).map((e) => e.id),
  );
  return filas.filter((f) => vivos.has(f.journalEntryId));
}

/** Años que lleva la gestoria (sus meses no se dotan en la app). */
async function aniosExternos(companyId: string): Promise<Set<number>> {
  const fys = await prisma.fiscalYear.findMany({ where: { companyId, llevanza: 'EXTERNA' }, select: { label: true } });
  return new Set(fys.map((f) => Number(f.label)));
}

export interface ActivoVista {
  id: string;
  descripcion: string;
  subcuentaBien: string;
  subcuentaAmortAcum: string;
  subcuentaDotacion: string;
  fechaAlta: string;
  fechaInicioAmortizacion: string;
  fechaBaja: string | null;
  coste: number;
  valorResidual: number;
  coeficiente: number;
  amortAcumuladaInicial: number;
  /** Lo dotado en la app (borradores incluidos). */
  dotado: number;
  amortizacionTotal: number;
  valorNeto: number;
  ultimoMesDotado: string | null;
  /** Se puede editar mientras no tenga dotaciones. */
  editable: boolean;
  activo: boolean;
  traidoDeLaGestoria: boolean;
}

/** Fichas de la empresa con lo amortizado y el valor neto. Por defecto, solo las activas. */
export async function listarActivos(companyId: string, opciones: { todos?: boolean } = {}) {
  const activos = await prisma.activoFijo.findMany({ where: { companyId, ...(opciones.todos ? {} : { activo: true }) }, orderBy: [{ subcuentaBien: 'asc' }, { descripcion: 'asc' }] });
  const dot = await dotacionesVigentes(prisma, companyId, activos.map((a) => a.id));
  const porActivo = new Map<string, { suma: number; ultimo: string | null }>();
  for (const d of dot) {
    const x = porActivo.get(d.activoFijoId) ?? { suma: 0, ultimo: null };
    x.suma = r2(x.suma + Number(d.importe));
    if (!x.ultimo || d.periodo > x.ultimo) x.ultimo = d.periodo;
    porActivo.set(d.activoFijoId, x);
  }
  const lista: ActivoVista[] = activos.map((a) => {
    const d = porActivo.get(a.id) ?? { suma: 0, ultimo: null };
    return {
      id: a.id,
      descripcion: a.descripcion,
      subcuentaBien: a.subcuentaBien,
      subcuentaAmortAcum: a.subcuentaAmortAcum,
      subcuentaDotacion: a.subcuentaDotacion,
      fechaAlta: a.fechaAlta,
      fechaInicioAmortizacion: a.fechaInicioAmortizacion,
      fechaBaja: a.fechaBaja,
      coste: Number(a.coste),
      valorResidual: Number(a.valorResidual),
      coeficiente: Number(a.coeficiente),
      amortAcumuladaInicial: Number(a.amortAcumuladaInicial),
      dotado: d.suma,
      amortizacionTotal: r2(Number(a.amortAcumuladaInicial) + d.suma),
      valorNeto: valorNeto(paraCalculo(a), d.suma),
      ultimoMesDotado: d.ultimo,
      editable: !porActivo.has(a.id),
      activo: a.activo,
      traidoDeLaGestoria: !!a.cargaId,
    };
  });
  const totales = {
    coste: r2(lista.reduce((s, a) => s + a.coste, 0)),
    amortizacion: r2(lista.reduce((s, a) => s + a.amortizacionTotal, 0)),
    valorNeto: r2(lista.reduce((s, a) => s + a.valorNeto, 0)),
  };
  return { activos: lista, totales };
}

// ---------------------------------------------------------------------------
// Alta, edicion y baja
// ---------------------------------------------------------------------------

export interface DatosActivo {
  descripcion: string;
  subcuentaBien: string;
  subcuentaAmortAcum: string;
  subcuentaDotacion: string;
  fechaAlta: string;
  fechaInicioAmortizacion: string;
  coste: number;
  valorResidual: number;
  amortAcumuladaInicial: number;
  fechaAmortAcumulada: string | null;
  coeficiente: number;
}

const digitos = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\D/g, '') : '');
const importe = (v: unknown, campo: string, nombre: string): number => {
  if (v === undefined || v === null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) throw badRequest(`${nombre}: escribe un importe positivo.`, { campo });
  return r2(n);
};

/** Valida los datos de una ficha (alta o edicion). `previo`: la ficha que se edita. */
export function validarActivo(raw: unknown, previo?: Partial<DatosActivo>): DatosActivo {
  if (!raw || typeof raw !== 'object') throw badRequest('Faltan los datos del bien.');
  const b = raw as Record<string, unknown>;
  const val = <K extends keyof DatosActivo>(k: K): unknown => (b[k] !== undefined ? b[k] : previo?.[k]);
  const descripcion = String(val('descripcion') ?? '').trim();
  if (!descripcion) throw badRequest('Escribe qué bien es (por ejemplo, «Furgoneta Renault»).', { campo: 'descripcion' });
  const subcuentaBien = digitos(val('subcuentaBien'));
  if (!/^2[0-3]\d{1,13}$/.test(subcuentaBien)) {
    throw badRequest('La cuenta del bien tiene que ser de inmovilizado (empieza por 20, 21, 22 o 23).', { campo: 'subcuentaBien' });
  }
  const propias = cuentasDeAmortizacion(subcuentaBien);
  const subcuentaAmortAcum = digitos(val('subcuentaAmortAcum')) || propias.amortAcum;
  if (!/^28\d{1,13}$/.test(subcuentaAmortAcum)) throw badRequest('La cuenta de amortización acumulada empieza por 28.', { campo: 'subcuentaAmortAcum' });
  const subcuentaDotacion = digitos(val('subcuentaDotacion')) || propias.dotacion;
  if (!/^68\d{1,13}$/.test(subcuentaDotacion)) throw badRequest('La cuenta del gasto de amortización empieza por 68.', { campo: 'subcuentaDotacion' });
  const fechaAlta = String(val('fechaAlta') ?? '');
  if (!FECHA.test(fechaAlta)) throw badRequest('Escribe la fecha de alta del bien (AAAA-MM-DD).', { campo: 'fechaAlta' });
  const fechaInicioAmortizacion = String(val('fechaInicioAmortizacion') ?? '') || fechaAlta;
  if (!FECHA.test(fechaInicioAmortizacion)) throw badRequest('La fecha de inicio de la amortización tiene que ser AAAA-MM-DD.', { campo: 'fechaInicioAmortizacion' });
  if (fechaInicioAmortizacion < fechaAlta) throw badRequest('La amortización no puede empezar antes del alta del bien.', { campo: 'fechaInicioAmortizacion' });
  const coste = importe(val('coste'), 'coste', 'Coste');
  if (coste <= 0) throw badRequest('Escribe lo que costó el bien.', { campo: 'coste' });
  const valorResidual = importe(val('valorResidual'), 'valorResidual', 'Valor residual');
  if (valorResidual >= coste) throw badRequest('El valor residual tiene que ser menor que el coste.', { campo: 'valorResidual' });
  const amortAcumuladaInicial = importe(val('amortAcumuladaInicial'), 'amortAcumuladaInicial', 'Amortización acumulada');
  if (aCentimos(amortAcumuladaInicial) > aCentimos(coste - valorResidual)) {
    throw badRequest('La amortización acumulada no puede pasar del coste menos el valor residual.', { campo: 'amortAcumuladaInicial' });
  }
  let coeficiente: number;
  const vida = b.vidaUtil;
  if (vida !== undefined && vida !== null && vida !== '') {
    const anios = Number(vida);
    if (!Number.isFinite(anios) || anios <= 0) throw badRequest('Escribe la vida útil en años (por ejemplo, 10).', { campo: 'vidaUtil' });
    coeficiente = Math.round((100 / anios) * 1000) / 1000;
  } else {
    coeficiente = Number(val('coeficiente') ?? NaN);
  }
  if (!Number.isFinite(coeficiente) || coeficiente <= 0 || coeficiente > 100) {
    throw badRequest('Escribe el porcentaje de amortización anual (entre 0 y 100) o la vida útil en años.', { campo: 'coeficiente' });
  }
  const fechaAmortAcumulada = amortAcumuladaInicial ? String(val('fechaAmortAcumulada') ?? '') || null : null;
  if (fechaAmortAcumulada && !FECHA.test(fechaAmortAcumulada)) throw badRequest('La fecha de la amortización acumulada tiene que ser AAAA-MM-DD.', { campo: 'fechaAmortAcumulada' });
  return {
    descripcion: descripcion.slice(0, 191),
    subcuentaBien,
    subcuentaAmortAcum,
    subcuentaDotacion,
    fechaAlta,
    fechaInicioAmortizacion,
    coste,
    valorResidual,
    amortAcumuladaInicial,
    fechaAmortAcumulada,
    coeficiente,
  };
}

async function activoDeEmpresa(companyId: string, id: string): Promise<FilaActivo> {
  const a = await prisma.activoFijo.findFirst({ where: { id, companyId } });
  if (!a) throw notFound('Ese bien no existe en esta empresa.');
  return a;
}

export async function crearActivo(companyId: string, raw: unknown, userId: string) {
  const d = validarActivo(raw);
  const a = await prisma.activoFijo.create({ data: { companyId, ...d } });
  await registrarAuditoria({ userId, companyId, action: 'INMOVILIZADO_ALTA', resourceType: 'ActivoFijo', resourceId: a.id, meta: { descripcion: d.descripcion, coste: d.coste } });
  return a;
}

export async function actualizarActivo(companyId: string, id: string, raw: unknown, userId: string) {
  const previo = await activoDeEmpresa(companyId, id);
  if ((await dotacionesVigentes(prisma, companyId, [id])).length) {
    throw conflict('Este bien ya tiene amortización apuntada: no se puede cambiar. Anula antes esos meses o dale de baja y da de alta otro.');
  }
  const d = validarActivo(raw, {
    descripcion: previo.descripcion,
    subcuentaBien: previo.subcuentaBien,
    subcuentaAmortAcum: previo.subcuentaAmortAcum,
    subcuentaDotacion: previo.subcuentaDotacion,
    fechaAlta: previo.fechaAlta,
    fechaAmortAcumulada: previo.fechaAmortAcumulada,
    ...paraCalculo(previo),
  });
  const a = await prisma.activoFijo.update({ where: { id }, data: d });
  await registrarAuditoria({ userId, companyId, action: 'INMOVILIZADO_CAMBIO', resourceType: 'ActivoFijo', resourceId: id, meta: { descripcion: d.descripcion } });
  return a;
}

/** Baja del bien en una fecha: amortiza hasta ese dia y deja de salir en la lista. */
export async function darDeBaja(companyId: string, id: string, fechaRaw: unknown, userId: string) {
  const a = await activoDeEmpresa(companyId, id);
  const fecha = String(fechaRaw ?? '');
  if (!FECHA.test(fecha)) throw badRequest('Escribe la fecha de baja (AAAA-MM-DD).', { campo: 'fechaBaja' });
  if (fecha < a.fechaAlta) throw badRequest('La baja no puede ser anterior al alta.', { campo: 'fechaBaja' });
  const despues = (await dotacionesVigentes(prisma, companyId, [id])).filter((d) => d.periodo > fecha.slice(0, 7));
  if (despues.length) {
    throw conflict(`Este bien ya tiene amortización apuntada después de la baja (${despues.map((d) => mesES(d.periodo)).join(', ')}). Anula antes esos meses.`);
  }
  const r = await prisma.activoFijo.update({ where: { id }, data: { fechaBaja: fecha, activo: false } });
  await registrarAuditoria({ userId, companyId, action: 'INMOVILIZADO_BAJA', resourceType: 'ActivoFijo', resourceId: id, meta: { fecha } });
  return r;
}

// ---------------------------------------------------------------------------
// Dotaciones
// ---------------------------------------------------------------------------

export interface MesDotacion {
  periodo: string;
  importe: number;
  bienes: number;
  asiento: { id: string; numero: string } | null;
}

/** Mes AAAA-MM de hoy en España. */
const mesActual = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);

/** Meses con amortizacion por apuntar hasta `hasta` (sin los que lleva la gestoria). */
export async function mesesSinDotar(companyId: string, hasta: string = mesActual()): Promise<MesDotacion[]> {
  const plan = await planDeDotaciones(companyId, hasta);
  return plan.map((m) => ({ periodo: m.periodo, importe: m.importe, bienes: m.lineas.length, asiento: null }));
}

interface MesPlan {
  periodo: string;
  importe: number;
  lineas: Array<{ activo: FilaActivo; importe: number }>;
}

/** Lo que falta por dotar, mes a mes, hasta `hasta`. */
async function planDeDotaciones(companyId: string, hasta: string, db: TransaccionBD | typeof prisma = prisma): Promise<MesPlan[]> {
  const activos = await db.activoFijo.findMany({ where: { companyId, OR: [{ activo: true }, { fechaBaja: { not: null } }] } });
  if (!activos.length) return [];
  const externos = await aniosExternos(companyId);
  const vigentes = await dotacionesVigentes(db, companyId, activos.map((a) => a.id));
  const dotado = new Map<string, Map<string, number>>();
  for (const d of vigentes) {
    const m = dotado.get(d.activoFijoId) ?? new Map<string, number>();
    m.set(d.periodo, Number(d.importe));
    dotado.set(d.activoFijoId, m);
  }
  const meses = new Map<string, MesPlan>();
  for (const a of activos) {
    const calculo = paraCalculo(a);
    const suyos = dotado.get(a.id) ?? new Map<string, number>();
    let acumulado = 0;
    for (const periodo of mesesEntre(primerMes(calculo), hasta)) {
      if (a.fechaBaja && periodo > a.fechaBaja.slice(0, 7)) break;
      if (externos.has(Number(periodo.slice(0, 4)))) continue;
      const ya = suyos.get(periodo);
      if (ya !== undefined) {
        acumulado = r2(acumulado + ya);
        continue;
      }
      const cuota = cuotaDelMes(calculo, periodo, acumulado);
      if (aCentimos(cuota) <= 0) continue;
      acumulado = r2(acumulado + cuota);
      const m = meses.get(periodo) ?? { periodo, importe: 0, lineas: [] };
      m.lineas.push({ activo: a, importe: cuota });
      m.importe = r2(m.importe + cuota);
      meses.set(periodo, m);
    }
  }
  return [...meses.values()].sort((a, b) => a.periodo.localeCompare(b.periodo));
}

/**
 * «Calcular amortización hasta <mes>»: un asiento en borrador por cada mes que
 * falte (68x al debe, 28x al haber), con su DotacionAmortizacion por bien.
 */
export async function calcularDotaciones(companyId: string, hastaRaw: unknown, userId: string): Promise<{ meses: MesDotacion[]; texto: string }> {
  const hasta = String(hastaRaw ?? '');
  if (!esPeriodo(hasta)) throw badRequest('Indica hasta qué mes calcular (AAAA-MM).', { campo: 'hasta' });
  const limite = `${Number(mesActual().slice(0, 4)) + 1}-12`;
  if (hasta > limite) throw badRequest(`Como mucho se calcula hasta diciembre de ${limite.slice(0, 4)}.`, { campo: 'hasta' });
  const plan = await planDeDotaciones(companyId, hasta);
  if (!plan.length) return { meses: [], texto: `No hay amortización pendiente hasta ${mesES(hasta)}.` };
  // Cada mes tiene que poder apuntarse (ni bloqueado, ni cerrado, ni de la gestoria).
  for (const m of plan) await comprobarFechaAbierta(companyId, ultimoDiaDe(m.periodo), 'apuntar la amortización');

  const hechos = await prisma.$transaction(async (tx) => {
    const out: MesDotacion[] = [];
    for (const m of plan) {
      const lineas = m.lineas.flatMap(({ activo, importe }) => [
        { cuenta: activo.subcuentaDotacion, nombre: 'Amortización del inmovilizado', debe: importe, haber: 0, referencia: activo.descripcion },
        { cuenta: activo.subcuentaAmortAcum, nombre: 'Amortización acumulada', debe: 0, haber: importe, referencia: activo.descripcion },
      ]);
      const [asiento] = await grabarAsientos(tx, companyId, [
        { fecha: ultimoDiaDe(m.periodo), concepto: `Amortización del inmovilizado ${mesES(m.periodo)}`, origen: 'AMORTIZACION', estado: 'DRAFT', lineas },
      ]);
      for (const { activo, importe } of m.lineas) {
        // Un mes anulado antes se reaprovecha (hay un unico por bien y mes).
        await tx.dotacionAmortizacion.upsert({
          where: { activoFijoId_periodo: { activoFijoId: activo.id, periodo: m.periodo } },
          create: { companyId, activoFijoId: activo.id, periodo: m.periodo, importe, journalEntryId: asiento.id },
          update: { importe, journalEntryId: asiento.id, anulada: false },
        });
      }
      out.push({ periodo: m.periodo, importe: m.importe, bienes: m.lineas.length, asiento });
    }
    return out;
  }, OPCIONES_TX);
  await registrarAuditoria({
    userId,
    companyId,
    action: 'DOTACION_AMORTIZACION',
    resourceType: 'ActivoFijo',
    meta: { hasta, meses: hechos.map((m) => ({ periodo: m.periodo, importe: m.importe, asiento: m.asiento?.numero })) },
  });
  const total = r2(hechos.reduce((s, m) => s + m.importe, 0));
  const meses = hechos.length === 1 ? `el mes ${mesES(hechos[0].periodo)}` : `${hechos.length} meses (de ${mesES(hechos[0].periodo)} a ${mesES(hechos[hechos.length - 1].periodo)})`;
  return {
    meses: hechos,
    texto: `Amortización de ${meses}: ${total.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €. Los asientos están en borrador: apruébalos en el Motor contable.`,
  };
}

/** Anula la amortizacion apuntada de un mes (su asiento queda anulado) para poder calcularla de nuevo. */
export async function anularDotacionMes(companyId: string, periodoRaw: unknown, userId: string) {
  const periodo = String(periodoRaw ?? '');
  if (!esPeriodo(periodo)) throw badRequest('Indica el mes (AAAA-MM).', { campo: 'periodo' });
  const filas = await prisma.dotacionAmortizacion.findMany({ where: { companyId, periodo, anulada: false } });
  if (!filas.length) throw notFound(`No hay amortización apuntada en ${mesES(periodo)}.`);
  const ids = [...new Set(filas.map((f) => f.journalEntryId))];
  const asientos = await prisma.journalEntry.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, estado: true, fecha: true, numeroAsiento: true } });
  for (const a of asientos) {
    if (a.estado === 'POSTED') await comprobarFechaAbierta(companyId, a.fecha.toISOString().slice(0, 10), 'anular la amortización');
  }
  await prisma.$transaction([
    prisma.journalEntry.updateMany({ where: { companyId, id: { in: ids }, estado: { in: ['DRAFT', 'PENDING_REVIEW', 'POSTED'] } }, data: { estado: 'REVERSED' } }),
    prisma.dotacionAmortizacion.updateMany({ where: { companyId, periodo, anulada: false }, data: { anulada: true } }),
  ]);
  await registrarAuditoria({ userId, companyId, action: 'DOTACION_AMORTIZACION_ANULADA', resourceType: 'ActivoFijo', meta: { periodo, asientos: asientos.map((a) => a.numeroAsiento) } });
  return { periodo, asientos: asientos.map((a) => a.numeroAsiento), texto: `Amortización de ${mesES(periodo)} anulada. Puedes volver a calcularla.` };
}
