import { randomUUID } from 'crypto';
import * as XLSX from 'xlsx';
import { prisma } from '../config/database';
import { getFsClientForCompany } from './facturascripts-client';
import { listarCuentasBancarias } from './bancos.service';
import { fichaModelo } from './impuestosTextos';
import { generarPdfA } from '../utils/pdf-a';
import {
  EstadoModeloImpuesto,
  ModeloImpuestoDetalle,
  ModeloImpuestoResumen,
} from '../domain/impuestosModulo.model';
import {
  DatosModelo111,
  DatosModelo115,
  DatosModelo303,
  PeriodoFiscal,
} from '../domain/impuestos.model';
import { DatosModelo200 } from '../domain/impuesto-sociedades.model';
import {
  calcularModelo111,
  calcularModelo115,
  calcularModelo303,
  calcularModelo347,
  calcularModelo390,
  esEmpresaEspanolaFiscal,
  MENSAJE_SIN_MODELOS,
} from './impuestosCalculo.service';
import { calcularModelo200 } from './impuestoSociedadesCalculo.service';
import { calcularModelo190 } from './nominas/fiscal';
import {
  casillasAGuardadas,
  casillasDeDatos111,
  casillasDeDatos115,
  declaracionDeGuardadas,
  esOpcion,
  ficheroDeclaracion,
  tieneCasillasGuardadas,
  type DeclaracionRetenciones,
} from './aeatRetenciones/declaracion';
import { PERIODO_111_115 } from './aeatRetenciones/diseno';
import { calcularBorrador349, ficheroModelo349 } from './borradoresAeat/borrador349.service';
import { calcularBorrador180, ficheroModelo180 } from './borradoresAeat/borrador180.service';
import { calcularBorrador202, ficheroModelo202 } from './borradoresAeat/borrador202.service';
import { conservarOpciones } from './borradoresAeat/comun';
import { fichero200, fichero347, fichero390 } from './borradoresAeat.service';
import {
  Borrador303,
  casillasOficiales303De,
  ContextoEmpresa303,
  esUltimoPeriodo303,
  ficheroBorrador303,
  montarBorrador303,
} from './modelo303.service';
import { badRequest, forbidden, notFound } from '../utils/http-errors';
import {
  calendarioEjercicio,
  filasQueFaltan,
  planCambioCalendario,
  type EntradaCalendario,
  type OpcionesCalendario,
} from '../domain/calendarioFiscal';
import { AJUSTES_FISCALES_POR_DEFECTO, ajustesFiscalesDeFila, type AjustesFiscales } from '../domain/ajustes.model';
import { contextoDeclaracion } from './declaracionesAeat/declaraciones.service';
import { anioEspana, hoyEspana } from '../utils/fechas';
import { plazoAeat, ultimoDiaFebrero } from '../domain/plazosAeat';

/**
 * LOS GET NO ESCRIBEN (B6, igual en todos los modelos de la AEAT): el detalle,
 * el TXT y el PDF de un modelo, los GET de /tax-models, los de los borradores
 * (/impuestos/borradores, /tax-models/349|180|202), el del historial de
 * declaraciones y el fichero del 190 calculan al momento y no guardan casillas,
 * datos, opciones ni numeros. Solo guardan las rutas POST, PUT y DELETE con
 * impuestos:write (o nominas:write en el 190).
 * Una sola excepcion, a proposito: la lista del calendario
 * (GET /impuestos/modelos) crea las filas vacias que faltan del ejercicio
 * (sin importes), porque el cambio de periodicidad (ajustes fiscales) decide
 * desde cuando aplica mirando esas filas. Ningun importe se guarda al leer.
 * Un id de fila que aun no existe ("cal-<codigo>-<ejercicio>-<periodo>") se
 * lee sin crearla; la crea la primera operacion de escritura.
 *
 * Modulo "Impuestos" estilo Quipu:
 *  - Calendario fiscal por ejercicio (303/111/115/349 trimestrales; 390/347/200 anuales).
 *  - Estados: vigente (verde) / expirado (naranja) / omitido / presentado.
 *  - "Recalcular importes" = autorrelleno desde contabilidad + config (NIF/IBAN),
 *    SE GUARDA AUTOMATICAMENTE y PISA cualquier edicion manual previa.
 *  - "Guardar" = conserva la edicion manual (origen 'manual-mixto'); los totales
 *    dependientes NO se recalculan (el usuario los ajusta a mano, como en el video).
 * Persistencia Prisma (tabla ModeloImpuesto) con fallback en memoria (tests).
 */

type Casillas = Record<string, number | string | null>;

interface FilaModelo {
  id: string;
  companyId: string;
  codigo: string;
  ejercicio: number;
  periodo: string;
  estado: string;
  casillas: Casillas | null;
  datos: unknown | null;
  origen: string | null;
}

const memoria = new Map<string, FilaModelo>();
const dbOk = (): boolean =>
  typeof (prisma as { modeloImpuesto?: { findMany?: unknown } }).modeloImpuesto?.findMany === 'function';

// --- Calendario fiscal (plazos AEAT) ---

const DESCRIPCIONES: Record<string, string> = {
  '303': 'IVA — autoliquidación trimestral',
  '111': 'Retenciones IRPF (trabajo y profesionales)',
  '115': 'Retenciones por alquileres',
  '349': 'Operaciones intracomunitarias',
  '390': 'IVA — resumen anual',
  '347': 'Operaciones con terceros (> 3.005,06)',
  '200': 'Impuesto sobre Sociedades',
  '130': 'Pago fraccionado del IRPF (autónomos)',
  '190': 'Retenciones: resumen anual (trabajo y profesionales)',
  '180': 'Retenciones por alquileres: resumen anual',
  '202': 'Pago fraccionado del Impuesto sobre Sociedades',
};

/**
 * Ultimo dia de presentacion que marca la norma para el modelo y periodo, sin
 * mover por fines de semana ni festivos (plazos generales de la AEAT).
 */
function fechaOrdinariaModelo(codigo: string, ejercicio: number, periodo: string): string {
  const TRIM: Record<string, string> = { '1T': `${ejercicio}-04-20`, '2T': `${ejercicio}-07-20`, '3T': `${ejercicio}-10-20` };
  if (periodo in TRIM) return TRIM[periodo];
  // 202: del 1 al 20 de abril, octubre y diciembre.
  const PAGO: Record<string, string> = { '1P': `${ejercicio}-04-20`, '2P': `${ejercicio}-10-20`, '3P': `${ejercicio}-12-20` };
  if (periodo in PAGO) return PAGO[periodo];
  if (/^(0[1-9]|1[0-2])$/.test(periodo)) {
    const mes = Number(periodo);
    const siguiente = String(mes + 1).padStart(2, '0');
    if (codigo === '303') {
      // IVA mensual: solo lo presentan las empresas en el SII (gran empresa,
      // REDEME o SII voluntario), que tienen los 30 primeros dias naturales del
      // mes siguiente (art. 71.4 RIVA); el de enero, hasta el ultimo dia de
      // febrero, y el de diciembre, hasta el 30 de enero.
      if (mes === 1) return ultimoDiaFebrero(ejercicio);
      if (mes === 12) return `${ejercicio + 1}-01-30`;
      return `${ejercicio}-${siguiente}-30`;
    }
    // 349 mensual (art. 81 RIVA): el de julio, hasta el 20 de septiembre; el de
    // diciembre, hasta el 30 de enero.
    if (codigo === '349' && mes === 7) return `${ejercicio}-09-20`;
    if (codigo === '349' && mes === 12) return `${ejercicio + 1}-01-30`;
    // 111 y 115 mensuales (gran empresa): hasta el dia 20 del mes siguiente;
    // el de diciembre, hasta el 20 de enero.
    if (mes === 12) return `${ejercicio + 1}-01-20`;
    return `${ejercicio}-${siguiente}-20`;
  }
  if (periodo === '4T') {
    // 111/115: 20 de enero; 303/349: 30 de enero
    return codigo === '111' || codigo === '115' ? `${ejercicio + 1}-01-20` : `${ejercicio + 1}-01-30`;
  }
  // anuales
  if (codigo === '390') return `${ejercicio + 1}-01-30`;
  // 347: todo febrero (el 29 en los bisiestos).
  if (codigo === '347') return ultimoDiaFebrero(ejercicio + 1);
  if (codigo === '200') return `${ejercicio + 1}-07-25`;
  if (codigo === '190' || codigo === '180') return `${ejercicio + 1}-01-31`;
  return `${ejercicio + 1}-01-30`;
}

/**
 * Fecha limite de presentacion del modelo y periodo: la de la norma o, si cae
 * en sabado, domingo o fiesta nacional, el siguiente dia habil (plazoAeat).
 * Asi el 390 de 2026 (sabado 30-1-2027) vence el lunes 1-2-2027.
 */
export function fechaVencimientoModelo(codigo: string, ejercicio: number, periodo: string): string {
  return plazoAeat(fechaOrdinariaModelo(codigo, ejercicio, periodo));
}

/** El 130 no se calcula todavia: se rellena a mano. */
export const MENSAJE_130_MANUAL = 'La app todavía no calcula el modelo 130: rellena sus casillas a mano y guárdalo.';
const RELLENO_MANUAL = new Set(['130']);

/**
 * Lo que decide el calendario de la empresa: sus ajustes fiscales
 * (Configuracion > Impuestos; sin fila, los de por defecto) y si es autonomo.
 *
 * Con `ejercicio`: a un año anterior al de la ultima vez que se guardaron los
 * ajustes no se le aplican (se crean con los de por defecto, como antes de
 * existir esta pantalla): un cambio de regimen no reescribe años pasados.
 */
export async function opcionesCalendarioEmpresa(companyId: string, ejercicio?: number): Promise<OpcionesCalendario> {
  const tabla = (prisma as { ajustesFiscales?: { findUnique?: unknown } }).ajustesFiscales;
  const legal = (prisma as { legalConfig?: { findUnique?: unknown } }).legalConfig;
  const [fila, cfg] = await Promise.all([
    typeof tabla?.findUnique === 'function' ? prisma.ajustesFiscales.findUnique({ where: { companyId } }).catch(() => null) : null,
    typeof legal?.findUnique === 'function'
      ? prisma.legalConfig.findUnique({ where: { companyId }, select: { tipoSociedad: true } }).catch(() => null)
      : null,
  ]);
  const anterior = ejercicio !== undefined && !!fila?.updatedAt && ejercicio < anioEspana(fila.updatedAt);
  return { ajustes: anterior ? AJUSTES_FISCALES_POR_DEFECTO : ajustesFiscalesDeFila(fila), autonomo: cfg?.tipoSociedad === 'AUTONOMO' };
}

const clave = (companyId: string, codigo: string, ejercicio: number, periodo: string): string =>
  `${companyId}:${codigo}:${ejercicio}:${periodo}`;

/**
 * Crea (si faltan) las filas vacias del calendario del ejercicio, sin importes.
 * Una empresa no establecida en Espana no presenta modelos de la AEAT: no se
 * le crea nada.
 */
async function asegurarCalendario(companyId: string, ejercicio: number): Promise<void> {
  if (!(await esEmpresaEspanolaFiscal(companyId))) return;
  const deseado = calendarioEjercicio(ejercicio, await opcionesCalendarioEmpresa(companyId, ejercicio));
  // Solo se anaden las que faltan y no se solapan con otra fila del mismo modelo
  // (p. ej. el 1T trimestral que ya existia cuando se paso a IVA mensual).
  if (dbOk()) {
    const existentes = await prisma.modeloImpuesto.findMany({ where: { companyId, ejercicio }, select: { codigo: true, periodo: true } });
    const faltan = filasQueFaltan(ejercicio, deseado, existentes);
    if (faltan.length) {
      await prisma.modeloImpuesto.createMany({
        data: faltan.map(({ codigo, periodo }) => ({ companyId, codigo, ejercicio, periodo, estado: 'vigente' })),
        skipDuplicates: true,
      });
    }
    return;
  }
  const existentes = [...memoria.values()].filter((f) => f.companyId === companyId && f.ejercicio === ejercicio);
  for (const { codigo, periodo } of filasQueFaltan(ejercicio, deseado, existentes)) {
    const k = clave(companyId, codigo, ejercicio, periodo);
    memoria.set(k, { id: k, companyId, codigo, ejercicio, periodo, estado: 'vigente', casillas: null, datos: null, origen: null });
  }
}

/** Un modelo del calendario (de la BD o el que se crearia), para Configuracion > Impuestos. */
export interface ModeloPrevisto {
  codigo: string;
  periodo: string;
  periodoEtiqueta: string;
  descripcion: string;
  fechaVencimiento: string;
  rellenoManual: boolean;
  /** vigente/expirado (segun hoy), presentado u omitido. */
  estado: EstadoModeloImpuesto;
}

const FILA_VACIA = { id: '', companyId: '', estado: 'vigente', casillas: null, datos: null, origen: null };

function aPrevisto(f: Pick<FilaModelo, 'codigo' | 'ejercicio' | 'periodo' | 'estado'>, hoy: string): ModeloPrevisto {
  const r = aResumen({ ...FILA_VACIA, ...f }, hoy);
  return {
    codigo: f.codigo,
    periodo: f.periodo,
    periodoEtiqueta: r.periodoEtiqueta,
    descripcion: r.descripcion,
    fechaVencimiento: r.fechaVencimiento,
    rellenoManual: RELLENO_MANUAL.has(f.codigo),
    estado: r.estado,
  };
}

const porVencimiento = (a: ModeloPrevisto, b: ModeloPrevisto) => a.fechaVencimiento.localeCompare(b.fechaVencimiento) || a.codigo.localeCompare(b.codigo);

/** Calendario teorico del ejercicio con esas opciones, entero (no escribe nada). */
export function vistaCalendario(ejercicio: number, opciones: OpcionesCalendario, hoy = `${ejercicio}-01-01`): ModeloPrevisto[] {
  return calendarioEjercicio(ejercicio, opciones)
    .map(({ codigo, periodo }) => aPrevisto({ codigo, ejercicio, periodo, estado: 'vigente' }, hoy))
    .sort(porVencimiento);
}

/** Resultado de aplicar unos ajustes fiscales nuevos al calendario de un ejercicio. */
export interface CambioCalendario {
  ejercicio: number;
  /** Primer dia al que se aplican; null = el ejercicio ya no los admite (se aplican desde el siguiente). */
  aplicadoDesde: string | null;
  borradas: number;
  creadas: number;
  /** De las borradas, las de periodos ya vencidos (solo con aplicarDesde hacia atras). */
  borradasVencidas: number;
}

type FilaPlan = { id: string; codigo: string; ejercicio: number; periodo: string; estado: string; origen: string | null };

/** El plan del cambio de un ejercicio: desde hoy, o desde `aplicarDesde` en el año en curso. */
function planDelEjercicio(ejercicio: number, existentes: FilaPlan[], opciones: OpcionesCalendario, hoy: string, aplicarDesde?: string) {
  const anio = Number(hoy.slice(0, 4));
  return planCambioCalendario(ejercicio, existentes, calendarioEjercicio(ejercicio, opciones), {
    hoy,
    aplicarDesde: ejercicio === anio ? aplicarDesde : undefined,
  });
}

const vencidas = (filas: FilaPlan[], ids: string[], hoy: string) => {
  const set = new Set(ids);
  return filas.filter((f) => set.has(f.id) && fechaVencimientoModelo(f.codigo, f.ejercicio, f.periodo) < hoy).length;
};

/**
 * Calendario de un ejercicio tal como quedaria con esas opciones, a partir de
 * las filas que ya existen (no escribe nada): las presentadas, omitidas o
 * editadas a mano y las de periodos ya empezados se quedan como estan; se
 * quitan y se añaden las que cambiarian (planCambioCalendario). Sin filas, el
 * calendario entero (se creara asi al abrir el ejercicio). Un año pasado no cambia.
 */
export async function calendarioResultante(
  companyId: string,
  ejercicio: number,
  opciones: OpcionesCalendario,
  hoy: string,
  aplicarDesde?: string,
): Promise<{ modelos: ModeloPrevisto[] } & Omit<CambioCalendario, 'ejercicio'>> {
  const anio = Number(hoy.slice(0, 4));
  const filas: FilaPlan[] = dbOk()
    ? await prisma.modeloImpuesto.findMany({
        where: { companyId, ejercicio },
        select: { id: true, codigo: true, ejercicio: true, periodo: true, estado: true, origen: true },
      })
    : [...memoria.values()].filter((f) => f.companyId === companyId && f.ejercicio === ejercicio);
  if (!filas.length) {
    const aplicadoDesde = ejercicio >= anio ? `${ejercicio}-01-01` : null;
    return { aplicadoDesde, modelos: vistaCalendario(ejercicio, opciones, hoy), borradas: 0, creadas: 0, borradasVencidas: 0 };
  }
  const plan = ejercicio >= anio ? planDelEjercicio(ejercicio, filas, opciones, hoy, aplicarDesde) : { aplicadoDesde: null, borrar: [], crear: [] };
  const borrar = new Set(plan.borrar);
  const modelos = [
    ...filas.filter((f) => !borrar.has(f.id)).map((f) => aPrevisto(f, hoy)),
    ...plan.crear.map(({ codigo, periodo }) => aPrevisto({ codigo, ejercicio, periodo, estado: 'vigente' }, hoy)),
  ].sort(porVencimiento);
  return {
    aplicadoDesde: plan.aplicadoDesde,
    modelos,
    borradas: plan.borrar.length,
    creadas: plan.crear.length,
    borradasVencidas: vencidas(filas, plan.borrar, hoy),
  };
}

/**
 * Aplica las opciones del calendario a los ejercicios del año en curso en
 * adelante que ya tienen filas. Las presentadas, omitidas o editadas a mano no
 * se tocan, ni los periodos que ya han empezado (salvo `aplicarDesde`, solo en
 * el año en curso); el cambio empieza en el primer trimestre libre
 * (domain/calendarioFiscal, planCambioCalendario). Los años pasados no cambian.
 * Devuelve el cambio del año en curso y de los siguientes que tengan filas.
 */
export async function aplicarCambioCalendario(
  companyId: string,
  opciones: OpcionesCalendario,
  hoy: string,
  aplicarDesde?: string,
): Promise<CambioCalendario[]> {
  const anio = Number(hoy.slice(0, 4));
  if (!dbOk()) return [{ ejercicio: anio, aplicadoDesde: `${anio}-01-01`, borradas: 0, creadas: 0, borradasVencidas: 0 }];
  const filas = await prisma.modeloImpuesto.findMany({
    where: { companyId, ejercicio: { gte: anio } },
    select: { id: true, codigo: true, ejercicio: true, periodo: true, estado: true, origen: true },
  });
  const ejercicios = [...new Set([anio, ...filas.map((f) => f.ejercicio)])].sort((a, b) => a - b);
  const out: CambioCalendario[] = [];
  for (const ejercicio of ejercicios) {
    const existentes = filas.filter((f) => f.ejercicio === ejercicio);
    if (!existentes.length) {
      // Sin filas todavia: se crearan con los ajustes nuevos al abrir el ejercicio.
      out.push({ ejercicio, aplicadoDesde: `${ejercicio}-01-01`, borradas: 0, creadas: 0, borradasVencidas: 0 });
      continue;
    }
    const plan = planDelEjercicio(ejercicio, existentes, opciones, hoy, aplicarDesde);
    if (plan.borrar.length || plan.crear.length) {
      await prisma.$transaction([
        // Solo las que siguen sin presentar, sin omitir y sin editar a mano.
        prisma.modeloImpuesto.deleteMany({
          where: { companyId, id: { in: plan.borrar }, estado: 'vigente', OR: [{ origen: null }, { origen: { not: 'manual-mixto' } }] },
        }),
        prisma.modeloImpuesto.createMany({
          data: plan.crear.map(({ codigo, periodo }: EntradaCalendario) => ({ companyId, codigo, ejercicio, periodo, estado: 'vigente' })),
          skipDuplicates: true,
        }),
      ]);
    }
    out.push({
      ejercicio,
      aplicadoDesde: plan.aplicadoDesde,
      borradas: plan.borrar.length,
      creadas: plan.crear.length,
      borradasVencidas: vencidas(existentes, plan.borrar, hoy),
    });
  }
  return out;
}

const PREFIJO_VIRTUAL = 'cal-';

/** Id de una fila del calendario que aun no existe. */
export const idVirtual = (codigo: string, ejercicio: number, periodo: string) => `${PREFIJO_VIRTUAL}${codigo}-${ejercicio}-${periodo}`;

function filaVirtual(companyId: string, codigo: string, ejercicio: number, periodo: string): FilaModelo {
  return { id: idVirtual(codigo, ejercicio, periodo), companyId, codigo, ejercicio, periodo, estado: 'vigente', casillas: null, datos: null, origen: null };
}

/** Modelo, ejercicio y periodo de un id virtual (null si no lo es o no esta en el calendario de la empresa). */
async function deIdVirtual(companyId: string, modeloId: string): Promise<{ codigo: string; ejercicio: number; periodo: string } | null> {
  const m = /^cal-(\d{3})-(\d{4})-([0-9A-Z]{2})$/.exec(modeloId);
  if (!m) return null;
  const [, codigo, ej, periodo] = m;
  const ejercicio = Number(ej);
  if (!(await esEmpresaEspanolaFiscal(companyId))) return null;
  const deseado = calendarioEjercicio(ejercicio, await opcionesCalendarioEmpresa(companyId, ejercicio));
  return deseado.some((d) => d.codigo === codigo && d.periodo === periodo) ? { codigo, ejercicio, periodo } : null;
}

/**
 * Fila de un modelo por su id. Un id virtual se lee sin crear la fila; con
 * `crear` (operaciones de escritura) se crea vigente si aun no existe.
 */
async function cargarFila(companyId: string, modeloId: string, opts: { crear?: boolean } = {}): Promise<FilaModelo> {
  if (modeloId.startsWith(PREFIJO_VIRTUAL)) {
    const v = await deIdVirtual(companyId, modeloId);
    if (!v) throw notFound('Modelo de impuesto no encontrado.');
    if (dbOk()) {
      const clavePrisma = { companyId_codigo_ejercicio_periodo: { companyId, ...v } };
      let f = await prisma.modeloImpuesto.findUnique({ where: clavePrisma });
      if (!f && opts.crear) {
        try {
          f = await prisma.modeloImpuesto.create({ data: { companyId, ...v, estado: 'vigente' } });
        } catch {
          f = await prisma.modeloImpuesto.findUniqueOrThrow({ where: clavePrisma });
        }
      }
      return f ? { ...f, casillas: (f.casillas as Casillas | null) ?? null, datos: f.datos ?? null } : filaVirtual(companyId, v.codigo, v.ejercicio, v.periodo);
    }
    const k = clave(companyId, v.codigo, v.ejercicio, v.periodo);
    const f = memoria.get(k);
    if (f) return f;
    if (!opts.crear) return filaVirtual(companyId, v.codigo, v.ejercicio, v.periodo);
    const nueva = { ...filaVirtual(companyId, v.codigo, v.ejercicio, v.periodo), id: k };
    memoria.set(k, nueva);
    return nueva;
  }
  if (dbOk()) {
    const f = await prisma.modeloImpuesto.findUnique({ where: { id: modeloId } });
    if (!f || f.companyId !== companyId) throw notFound('Modelo de impuesto no encontrado.');
    return { ...f, casillas: (f.casillas as Casillas | null) ?? null, datos: f.datos ?? null };
  }
  const f = [...memoria.values()].find((x) => x.id === modeloId && x.companyId === companyId);
  if (!f) throw notFound('Modelo de impuesto no encontrado.');
  return f;
}

async function guardarFila(fila: FilaModelo): Promise<void> {
  if (dbOk()) {
    await prisma.modeloImpuesto.update({
      where: { id: fila.id },
      data: {
        estado: fila.estado,
        casillas: (fila.casillas ?? undefined) as never,
        datos: (fila.datos ?? undefined) as never,
        origen: fila.origen,
      },
    });
    return;
  }
  memoria.set(clave(fila.companyId, fila.codigo, fila.ejercicio, fila.periodo), fila);
}

function aResumen(f: FilaModelo, hoy: string): ModeloImpuestoResumen {
  const fechaVencimiento = fechaVencimientoModelo(f.codigo, f.ejercicio, f.periodo);
  const dias = Math.round((new Date(fechaVencimiento).getTime() - new Date(hoy).getTime()) / 86400000);
  // estado derivado: 'vigente'/'expirado' se calculan por fecha; omitido/presentado son pegajosos
  let estado = f.estado as EstadoModeloImpuesto;
  if (estado === 'vigente' || estado === 'expirado') estado = dias >= 0 ? 'vigente' : 'expirado';
  // 2026 (anual), 2026Q1 (trimestre) o 2026-05 (mes).
  const etiqueta =
    f.periodo === '0A' ? String(f.ejercicio) : /^\d{2}$/.test(f.periodo) || /^[1-3]P$/.test(f.periodo) ? `${f.ejercicio}-${f.periodo}` : `${f.ejercicio}Q${f.periodo[0]}`;
  return {
    id: f.id,
    companyId: f.companyId,
    codigo: f.codigo,
    descripcion:
      f.codigo === '303' && /^\d{2}$/.test(f.periodo) ? 'IVA — autoliquidación mensual' : DESCRIPCIONES[f.codigo] ?? `Modelo ${f.codigo}`,
    ejercicio: f.ejercicio,
    periodo: f.periodo,
    periodoEtiqueta: etiqueta,
    estado,
    fechaVencimiento,
    diasHastaVencimiento: dias >= 0 ? dias : undefined,
    diasDesdeVencimiento: dias < 0 ? -dias : undefined,
    tieneBorrador: !!f.casillas,
    origen: (f.origen as 'autorrelleno' | 'manual-mixto' | null) ?? undefined,
    ...(RELLENO_MANUAL.has(f.codigo) ? { rellenoManual: true } : {}),
  };
}

// --- 1) Lista y estados ---

export async function listarModelosImpuesto(
  companyId: string,
  ejercicio: number,
  tab: 'activos' | 'omitidos' | 'presentados' = 'activos',
  hoy: string = hoyEspana(),
): Promise<ModeloImpuestoResumen[]> {
  // Empresa no establecida en Espana: sin modelos de la AEAT ni calendario.
  if (!(await esEmpresaEspanolaFiscal(companyId))) return [];
  // La excepcion de B6 (ver arriba): las filas vacias del calendario.
  await asegurarCalendario(companyId, ejercicio);
  let filas: FilaModelo[];
  if (dbOk()) {
    const rows = await prisma.modeloImpuesto.findMany({ where: { companyId, ejercicio } });
    filas = rows.map((f) => ({ ...f, casillas: (f.casillas as Casillas | null) ?? null, datos: f.datos ?? null }));
  } else {
    filas = [...memoria.values()].filter((f) => f.companyId === companyId && f.ejercicio === ejercicio);
  }
  const resumenes = filas.map((f) => aResumen(f, hoy));
  const filtro: Record<typeof tab, (r: ModeloImpuestoResumen) => boolean> = {
    activos: (r) => r.estado === 'vigente' || r.estado === 'expirado',
    omitidos: (r) => r.estado === 'omitido',
    presentados: (r) => r.estado === 'presentado',
  };
  return resumenes.filter(filtro[tab]).sort((a, b) => a.fechaVencimiento.localeCompare(b.fechaVencimiento) || a.codigo.localeCompare(b.codigo));
}

async function cambiarEstado(companyId: string, modeloId: string, estado: EstadoModeloImpuesto): Promise<ModeloImpuestoResumen> {
  const fila = await cargarFila(companyId, modeloId, { crear: true });
  fila.estado = estado;
  await guardarFila(fila);
  return aResumen(fila, hoyEspana());
}

export const omitirModelo = (companyId: string, modeloId: string) => cambiarEstado(companyId, modeloId, 'omitido');
/** Recupera un omitido: vuelve a vigente/expirado (se deriva por fecha). */
export const recuperarModeloOmitido = (companyId: string, modeloId: string) => cambiarEstado(companyId, modeloId, 'vigente');
/**
 * Marca como presentado sin historial: solo para los modelos que no lo tienen
 * (130) o sin la tabla de declaraciones (tests). Los demas pasan por
 * declaracionesAeat/presentar (congelan su instantanea).
 */
export const marcarModeloListoParaPresentar = (companyId: string, modeloId: string) => cambiarEstado(companyId, modeloId, 'presentado');

/** Modelo, ejercicio, periodo y estado de una fila por su id (tambien virtual). Solo lee. */
export async function filaPorId(companyId: string, modeloId: string): Promise<Pick<FilaModelo, 'id' | 'codigo' | 'ejercicio' | 'periodo' | 'estado'>> {
  const f = await cargarFila(companyId, modeloId);
  return { id: f.id, codigo: f.codigo, ejercicio: f.ejercicio, periodo: f.periodo, estado: f.estado };
}

/** true si la BD tiene la tabla del historial de declaraciones (no en los tests en memoria). */
export const hayHistorialDeclaraciones = (): boolean => dbOk() && typeof (prisma as { declaracionAeat?: { findMany?: unknown } }).declaracionAeat?.findMany === 'function';
/** "No presentado": vuelve a la lista principal (vigente/expirado por fecha). */
export const marcarModeloNoPresentado = (companyId: string, modeloId: string) => cambiarEstado(companyId, modeloId, 'vigente');

// --- 2) Detalle, autorrelleno y guardado manual ---

/**
 * Periodo fiscal de una fila del calendario: '0A' (anual), '1T'..'4T'
 * (trimestral) o '01'..'12' (mensual: 303 de quien esta en REDEME o el SII, y
 * 111/115 de las grandes empresas). Antes solo entendia '0A' y los trimestres:
 * una fila mensual rompia el detalle del modelo con un 500.
 */
export function periodoFiscalDe(fila: Pick<FilaModelo, 'ejercicio' | 'periodo'>): PeriodoFiscal {
  const ej = fila.ejercicio;
  const periodo = String(fila.periodo ?? '').toUpperCase();
  if (periodo === '0A') {
    return { ejercicio: ej, periodo: '0A', tipo: 'anual', fechaInicio: `${ej}-01-01`, fechaFin: `${ej}-12-31` };
  }
  const T: Record<string, [string, string]> = { '1T': ['01-01', '03-31'], '2T': ['04-01', '06-30'], '3T': ['07-01', '09-30'], '4T': ['10-01', '12-31'] };
  if (T[periodo]) {
    const [ini, fin] = T[periodo];
    return { ejercicio: ej, periodo, tipo: 'trimestral', fechaInicio: `${ej}-${ini}`, fechaFin: `${ej}-${fin}` };
  }
  if (/^(0[1-9]|1[0-2])$/.test(periodo)) {
    const mes = Number(periodo);
    const ultimo = new Date(Date.UTC(ej, mes, 0)).getUTCDate(); // dia 0 del mes siguiente = ultimo de este
    return { ejercicio: ej, periodo, tipo: 'mensual', fechaInicio: `${ej}-${periodo}-01`, fechaFin: `${ej}-${periodo}-${String(ultimo).padStart(2, '0')}` };
  }
  // Pagos fraccionados del 202: acumulados desde el 1 de enero.
  const P: Record<string, string> = { '1P': '03-31', '2P': '09-30', '3P': '11-30' };
  if (P[periodo]) return { ejercicio: ej, periodo, tipo: 'trimestral', fechaInicio: `${ej}-01-01`, fechaFin: `${ej}-${P[periodo]}` };
  throw badRequest(`Periodo no válido: "${fila.periodo}". Usa 0A (anual), 1T a 4T (trimestres), 01 a 12 (meses) o 1P a 3P (pagos fraccionados).`);
}

/** Configuracion de la empresa para el autorrelleno (NIF, razon social, IBAN). */
export async function configuracionEmpresa(companyId: string): Promise<Casillas> {
  const out: Casillas = {};
  // Primero los datos de la sociedad que guarda la app (Registro Mercantil >
  // Datos para la memoria); si faltan, los de FacturaScripts.
  const legal = await Promise.resolve()
    .then(() => prisma.legalConfig.findUnique({ where: { companyId } }))
    .catch(() => null);
  out.config_nif = legal?.nif ?? null;
  out.config_razon_social = legal?.denominacion ?? null;
  if (!out.config_nif || !out.config_razon_social) {
    try {
      const fs = await getFsClientForCompany(companyId);
      const { items } = await fs.listWithMeta('empresas', { limit: 1 });
      const e = items[0] as Record<string, unknown> | undefined;
      out.config_nif = out.config_nif || ((e?.cifnif as string) ?? null);
      out.config_razon_social = out.config_razon_social || ((e?.nombre as string) ?? null);
    } catch {
      // Sin FacturaScripts: se queda con lo que haya.
    }
  }
  const cuentas = await listarCuentasBancarias(companyId);
  out.config_iban = cuentas.find((c) => c.activa)?.iban ?? null;
  // TODO: VAT intracomunitario (ROI), recargo de equivalencia y OSS desde la
  // configuracion fiscal de la empresa cuando se modele.
  return out;
}

/**
 * Calcula las CASILLAS OFICIALES de un modelo para un periodo, sin necesidad de
 * fila en BD (reutilizado por autorrellenar y por GET /impuestos/calculate).
 */
export async function calcularCasillasModelo(
  companyId: string,
  codigo: string,
  ejercicio: number,
  periodoStr: string,
): Promise<{ casillas: Casillas; datos: unknown }> {
  const fila: FilaModelo = { id: '', companyId, codigo, ejercicio, periodo: periodoStr, estado: 'vigente', casillas: null, datos: null, origen: null };
  return calcularCasillas(companyId, fila);
}

/** Mapea el calculo de cada modelo a casillas planas + guarda los datos para el TXT. */
async function calcularCasillas(companyId: string, fila: FilaModelo): Promise<{ casillas: Casillas; datos: unknown }> {
  const periodo = periodoFiscalDe(fila);
  // Los de IVA (303/349/390/347) lo comprueban por periodo en impuestosCalculo.
  // El 190 (resumen anual de retenciones, de nominas) tampoco.
  if (['111', '115', '190', '200'].includes(fila.codigo) && !(await esEmpresaEspanolaFiscal(companyId))) {
    throw badRequest(MENSAJE_SIN_MODELOS);
  }
  switch (fila.codigo) {
    case '303': {
      // Mismo calculo que la pantalla del 303 y el fichero: las cuotas a
      // compensar salen del 303 del periodo anterior.
      const { importe } = await cuotasACompensar303(companyId, periodo);
      const d = await calcularModelo303(companyId, periodo, importe);
      return { casillas: casillasGuardadas303(d), datos: datosGuardados303(d) };
    }
    case '390': {
      const d = await calcularModelo390(companyId, fila.ejercicio);
      const v = d.volumen;
      return {
        casillas: {
          cuota_devengada: d.totalCuotaDevengada,
          cuota_deducible: d.totalCuotaDeducible,
          resultado_anual: d.resultadoAnual,
          volumen_operaciones: d.volumenOperaciones,
          '103_entregas_intracomunitarias': v?.intracomunitarias ?? 0,
          '104_exportaciones_exentas_con_deduccion': v?.exportacionesYExentasConDeduccion ?? 0,
          '105_exentas_sin_deduccion': v?.exentasSinDeduccion ?? 0,
          '110_no_sujetas_localizacion': v?.noSujetas ?? 0,
          '125_inversion_sujeto_pasivo': v?.isp ?? 0,
          '108_total_volumen': v?.total ?? d.volumenOperaciones,
          ...(d.advertencias?.length ? { advertencias: d.advertencias.join(' · ') } : {}),
        },
        datos: d,
      };
    }
    case '347': {
      const d = await calcularModelo347(companyId, fila.ejercicio);
      return {
        casillas: {
          num_declarados: d.operaciones.length,
          importe_total: d.operaciones.reduce((a, o) => a + o.baseAnual, 0),
        },
        datos: d,
      };
    }
    case '349': {
      // Borrador con el diseno oficial: las mismas cifras que el fichero.
      const b = await calcularBorrador349(companyId, fila.ejercicio, fila.periodo);
      const leido = Object.fromEntries((b.pantalla?.declarante ?? []).map((c) => [c.id, c.valor]));
      return {
        casillas: {
          num_operadores: b.entrada.operadores.length,
          total_base: Number(leido.importeOperaciones ?? 0),
          num_rectificaciones: b.entrada.rectificaciones?.length ?? 0,
          importe_rectificaciones: Number(leido.importeRectificaciones ?? 0),
          ...(b.errores.length || b.avisos.length ? { advertencias: [...b.errores, ...b.avisos].join(' · ') } : {}),
        },
        datos: { entrada: b.entrada },
      };
    }
    case '180': {
      const b = await calcularBorrador180(companyId, fila.ejercicio);
      return {
        casillas: {
          num_perceptores: b.entrada.perceptores.length,
          base_retenciones: b.cuadre.base180,
          retenciones: b.cuadre.retenciones180,
          ...(b.errores.length || b.avisos.length ? { advertencias: [...b.errores, ...b.avisos].join(' · ') } : {}),
        },
        datos: { entrada: b.entrada },
      };
    }
    case '202': {
      const b = await calcularBorrador202(companyId, fila.ejercicio, fila.periodo);
      return {
        casillas: {
          '01': b.entrada.casillas['01'] ?? 0,
          '02': b.entrada.casillas['02'] ?? 0,
          '03': b.entrada.casillas['03'] ?? 0,
          ...(b.errores.length || b.avisos.length ? { advertencias: [...b.errores, ...b.avisos].join(' · ') } : {}),
        },
        datos: { entrada: b.entrada },
      };
    }
    case '111': {
      // Las 30 casillas del formulario oficial (las que la app no calcula, a 0).
      const d = await calcularModelo111(companyId, periodo);
      return { casillas: casillasAGuardadas('111', casillasDeDatos111(d)), datos: d };
    }
    case '115': {
      const d = await calcularModelo115(companyId, periodo);
      return { casillas: casillasAGuardadas('115', casillasDeDatos115(d)), datos: d };
    }
    case '190': {
      // Solo totales: el detalle por perceptor lleva datos de los trabajadores y
      // se ve en Nominas (nominas:read). Misma fuente que el 111.
      const m = await calcularModelo190(companyId, fila.ejercicio);
      return {
        casillas: {
          num_percepciones: m.totales.registros,
          num_perceptores: m.totales.perceptores,
          importe_percepciones: m.totales.percepciones,
          retenciones_ingresos_cuenta: m.totales.retenciones,
          suma_111_del_ano: m.cuadre111.total,
          cuadra_con_111: m.cuadre111.coincide ? 'si' : 'no',
        },
        // El desglose por trimestres son totales (sin datos de cada perceptor).
        datos: { ejercicio: m.ejercicio, totales: m.totales, cuadre111: m.cuadre111, desglose: m.desglose, avisos: m.avisos },
      };
    }
    case '200': {
      const d = await calcularModelo200(companyId, fila.ejercicio);
      return {
        casillas: {
          resultado_contable: d.resultadoContableAntesImpuestos,
          base_imponible: d.baseImponibleFinal,
          tipo_gravamen: d.tipoGravamen,
          cuota_integra: d.cuotaIntegra,
          cuota_liquida: d.cuotaLiquida,
          cuota_a_depositar: d.cuotaADepositarODevolver,
        },
        datos: d,
      };
    }
    case '130':
      throw badRequest(MENSAJE_130_MANUAL);
    default:
      throw badRequest(`Autorrelleno no soportado para el modelo ${fila.codigo}.`);
  }
}

export async function obtenerDetalleModelo(companyId: string, modeloId: string): Promise<ModeloImpuestoDetalle> {
  const fila = await cargarFila(companyId, modeloId);
  return {
    resumen: aResumen(fila, hoyEspana()),
    ficha: fichaModelo(fila.codigo),
    casillas: fila.casillas ?? {},
    origen: (fila.origen as 'autorrelleno' | 'manual-mixto' | null) ?? 'autorrelleno',
  };
}

/**
 * "RECALCULAR IMPORTES" (video): autorrellena las casillas desde la contabilidad
 * + configuracion (NIF/IBAN) y GUARDA AUTOMATICAMENTE. PISA cualquier edicion
 * manual previa (origen vuelve a 'autorrelleno').
 */
export async function autorrellenarModelo(companyId: string, modeloId: string): Promise<ModeloImpuestoDetalle> {
  const fila = await cargarFila(companyId, modeloId, { crear: true });

  if (fila.estado === 'presentado' || fila.estado === 'omitido') {
    throw forbidden(`No puedes recalcular un modelo ${fila.estado}. Contacta administración.`);
  }

  const [{ casillas, datos }, config] = await Promise.all([calcularCasillas(companyId, fila), configuracionEmpresa(companyId)]);
  // Las opciones del borrador no son importes y se conservan: las del 111, 115
  // y 190 (opcion_*: forma de pago, complementaria) y las del 349, 180 y 202
  // (opc_*: complementaria, base a mano...).
  const opciones = Object.fromEntries(Object.entries(fila.casillas ?? {}).filter(([k]) => esOpcion(k)));
  fila.casillas = { ...conservarOpciones(fila.casillas), ...casillas, ...config, ...opciones };
  fila.datos = datos;
  fila.origen = 'autorrelleno';
  await guardarFila(fila); // guardado automatico del autorrelleno
  return obtenerDetalleModelo(companyId, fila.id);
}

/**
 * "GUARDAR" (video): aplica cambios manuales sobre las casillas actuales y los
 * conserva (origen 'manual-mixto'). NO recalcula totales dependientes: si el
 * usuario cambia una casilla que suma en otra, debe ajustar el total a mano.
 * Un "Recalcular importes" posterior PIERDE estos cambios.
 */
export async function guardarModeloManual(
  companyId: string,
  modeloId: string,
  casillasParciales: Casillas,
): Promise<ModeloImpuestoDetalle> {
  const fila = await cargarFila(companyId, modeloId, { crear: true });
  if (fila.estado === 'presentado') {
    throw forbidden('Este modelo está presentado y sus casillas quedan como se presentaron: para cambiarlo, prepara una complementaria o una sustitutiva.');
  }
  fila.casillas = { ...(fila.casillas ?? {}), ...casillasParciales };
  // Elegir la forma de pago o marcar la complementaria no es editar importes:
  // el modelo se sigue recalculando con la contabilidad.
  const soloOpciones = Object.keys(casillasParciales).length > 0 && Object.keys(casillasParciales).every(esOpcion);
  if (!soloOpciones) fila.origen = 'manual-mixto';
  await guardarFila(fila);
  return obtenerDetalleModelo(companyId, fila.id);
}

// --- 3) TXT (diseno AEAT) y PDF ---

/**
 * Genera el TXT AEAT del modelo desde los DATOS del ultimo autorrelleno (si no
 * hay, recalcula al vuelo). OJO (documentado): las ediciones MANUALES de
 * casillas NO viajan al TXT — TODO mapear casillas->datos por modelo; hoy el
 * TXT refleja el autorrelleno, como indica la advertencia del propio video.
 */
// --- Modelo 303: borrador con el diseno oficial 2026 (pantalla y fichero) ---

/** Opciones del borrador del 303 que elige la persona en la pantalla. */
export interface OpcionesBorrador303 {
  /** Tipo de declaracion (I, U, C, D, N); sin el, el que toca por el resultado. */
  tipoDeclaracion?: string | null;
  /** Cuotas a compensar de periodos anteriores [110]; sin el, las del 303 anterior. */
  aCompensar?: number | null;
  /** Cuenta bancaria para domiciliar o para la devolucion; sin ella, la primera activa. */
  cuentaBancariaId?: string | null;
}

/**
 * Opciones del borrador desde la query (?tipoDeclaracion=D&aCompensar=120,50&cuentaBancariaId=...).
 * Lo vacio no cuenta; un importe a compensar que no es un numero positivo, 400.
 */
export function opcionesBorrador303DeQuery(q: Record<string, unknown>): OpcionesBorrador303 {
  const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const compensar = texto(q.aCompensar);
  let aCompensar: number | null = null;
  if (compensar !== null) {
    aCompensar = Number(compensar.replace(',', '.'));
    if (!Number.isFinite(aCompensar) || aCompensar < 0) {
      throw badRequest('Las cuotas a compensar de periodos anteriores son un importe positivo o cero.', { campo: 'aCompensar' });
    }
  }
  return { tipoDeclaracion: texto(q.tipoDeclaracion), aCompensar, cuentaBancariaId: texto(q.cuentaBancariaId) };
}

/** Casillas que se guardan en la fila del 303 (Impuestos y Carmen las leen por nombre). */
export function casillasGuardadas303(d: DatosModelo303): Casillas {
  return {
    ...d.casillas,
    // Informacion adicional (pagina 3): por tipo de operacion.
    '59_entregas_intracomunitarias': d.entregasIntracomunitarias ?? 0,
    '60_exportaciones': d.exportaciones ?? 0,
    '120_no_sujetas_localizacion': d.noSujetasLocalizacion ?? 0,
    '122_inversion_sujeto_pasivo': d.inversionSujetoPasivo ?? 0,
    ...(d.advertencias?.length ? { advertencias: d.advertencias.join(' · ') } : {}),
  };
}

/**
 * Datos que se guardan en la fila del 303: los del calculo (con las casillas
 * oficiales, que usa el fichero) y los totales con los nombres que lee el 390
 * de Modelos fiscales. Asi las dos pantallas guardan lo mismo.
 */
export function datosGuardados303(d: DatosModelo303, extra: Record<string, unknown> = {}): DatosModelo303 & Record<string, unknown> {
  return {
    ...d,
    ivaRepercutido: d.totalCuotaDevengada,
    ivaSoportado: d.totalCuotaDeducible,
    baseRepercutido: d.totalBaseDevengada,
    baseSoportado: d.totalBaseDeducible,
    ...extra,
  };
}

/** Periodo anterior del 303: 1T -> 4T del ano anterior, 01 -> 12 del ano anterior. */
export function periodoAnterior303(periodo: Pick<PeriodoFiscal, 'ejercicio' | 'periodo'>): { ejercicio: number; periodo: string } | null {
  const p = periodo.periodo;
  const t = /^([1-4])T$/.exec(p);
  if (t) return t[1] === '1' ? { ejercicio: periodo.ejercicio - 1, periodo: '4T' } : { ejercicio: periodo.ejercicio, periodo: `${Number(t[1]) - 1}T` };
  if (/^(0[1-9]|1[0-2])$/.test(p)) {
    const mes = Number(p);
    return mes === 1 ? { ejercicio: periodo.ejercicio - 1, periodo: '12' } : { ejercicio: periodo.ejercicio, periodo: String(mes - 1).padStart(2, '0') };
  }
  return null;
}

async function fila303Guardada(companyId: string, ejercicio: number, periodo: string): Promise<FilaModelo | null> {
  if (dbOk()) {
    const f = await prisma.modeloImpuesto
      .findUnique({ where: { companyId_codigo_ejercicio_periodo: { companyId, codigo: '303', ejercicio, periodo } } })
      .catch(() => null);
    return f ? { ...f, casillas: (f.casillas as Casillas | null) ?? null, datos: f.datos ?? null } : null;
  }
  return memoria.get(clave(companyId, '303', ejercicio, periodo)) ?? null;
}

/**
 * Periodo anterior con la OTRA periodicidad, cuando la empresa cambia de
 * trimestral a mensual o al reves y los dos periodos acaban el mismo dia:
 * 01 -> 4T del ano anterior, 04 -> 1T, 07 -> 2T, 10 -> 3T; y al reves,
 * 1T -> 12 del ano anterior, 2T -> 03, 3T -> 06, 4T -> 09. En los demas
 * meses no hay (el trimestre anterior acabo antes del mes anterior).
 */
export function periodoAnteriorOtraPeriodicidad303(periodo: Pick<PeriodoFiscal, 'ejercicio' | 'periodo'>): { ejercicio: number; periodo: string } | null {
  const p = periodo.periodo;
  const t = /^([1-4])T$/.exec(p);
  if (t) {
    const trimestre = Number(t[1]);
    return trimestre === 1 ? { ejercicio: periodo.ejercicio - 1, periodo: '12' } : { ejercicio: periodo.ejercicio, periodo: String((trimestre - 1) * 3).padStart(2, '0') };
  }
  if (/^(01|04|07|10)$/.test(p)) {
    const mes = Number(p);
    return mes === 1 ? { ejercicio: periodo.ejercicio - 1, periodo: '4T' } : { ejercicio: periodo.ejercicio, periodo: `${(mes - 1) / 3}T` };
  }
  return null;
}

/**
 * Cuotas a compensar [110] del periodo: lo que dejo pendiente el 303 del
 * periodo anterior guardado (su [87]) mas su resultado negativo, salvo que se
 * pidiera la devolucion (tipo D). Sin 303 anterior guardado, 0: la pantalla
 * deja ponerlo a mano.
 *
 * Si la empresa cambio de periodicidad (trimestral <-> mensual), el periodo
 * anterior es el de la otra: se mira el de la misma periodicidad y el de la
 * otra que acaba el dia antes, y manda el presentado; si ninguno lo esta, el
 * primero que tenga importes guardados. Asi el arrastre no depende de con que
 * periodicidad se abrio la pantalla.
 */
export async function cuotasACompensar303(
  companyId: string,
  periodo: Pick<PeriodoFiscal, 'ejercicio' | 'periodo'>,
): Promise<{ importe: number; origen: 'periodo-anterior' | 'sin-dato'; periodo?: string; estado?: string }> {
  const candidatos = [periodoAnterior303(periodo), periodoAnteriorOtraPeriodicidad303(periodo)].filter((p): p is { ejercicio: number; periodo: string } => p !== null);
  const filas: Array<{ anterior: { ejercicio: number; periodo: string }; fila: FilaModelo }> = [];
  for (const anterior of candidatos) {
    const fila = await fila303Guardada(companyId, anterior.ejercicio, anterior.periodo);
    if (fila && fila.estado !== 'omitido' && (fila.datos || fila.casillas)) filas.push({ anterior, fila });
  }
  const elegida = filas.find((f) => f.fila.estado === 'presentado') ?? filas[0];
  if (!elegida) return { importe: 0, origen: 'sin-dato' };
  const { anterior, fila } = elegida;
  const datos = (fila.datos ?? {}) as Partial<DatosModelo303> & { tipoDeclaracion?: string };
  const cas = fila.casillas ?? {};
  let pendiente: number;
  let resultado: number;
  if (datos.casillasOficiales) {
    pendiente = Number(datos.casillasOficiales['87'] ?? 0) || 0;
    resultado = Number(datos.casillasOficiales['71'] ?? 0) || 0;
  } else {
    pendiente = Number(cas['87_pendientes_periodos_posteriores'] ?? datos.cuotasPendientesPosteriores ?? 0) || 0;
    resultado = Number(cas['71_resultado'] ?? datos.resultadoFinal ?? datos.resultado ?? 0) || 0;
  }
  const compensa = resultado < 0 && datos.tipoDeclaracion !== 'D';
  const centimos = Math.round(pendiente * 100) + (compensa ? Math.round(-resultado * 100) : 0);
  return { importe: Math.max(centimos, 0) / 100, origen: 'periodo-anterior', periodo: `${anterior.periodo} de ${anterior.ejercicio}`, estado: fila.estado };
}

/** Cuenta bancaria de la empresa para la pantalla (IBAN tapado). */
export interface CuentaBorrador303 {
  id: string;
  iban: string;
  banco: string | null;
}

const ibanTapado = (iban: string): string => {
  const limpio = iban.replace(/\s+/g, '');
  return limpio.length > 8 ? `${limpio.slice(0, 4)} **** ${limpio.slice(-4)}` : limpio;
};

/**
 * Ajustes fiscales que usa el 303 (REDEME, SII, criterio de caja), con la regla
 * del calendario: a un año anterior al de la ultima vez que se guardaron, los
 * de por defecto (un cambio de regimen no reescribe años pasados).
 */
async function ajustesFiscales303(companyId: string, ejercicio: number): Promise<AjustesFiscales> {
  const tabla = (prisma as { ajustesFiscales?: { findUnique?: unknown } }).ajustesFiscales;
  const fila = typeof tabla?.findUnique === 'function' ? await prisma.ajustesFiscales.findUnique({ where: { companyId } }).catch(() => null) : null;
  if (fila?.updatedAt && ejercicio < anioEspana(fila.updatedAt)) return { ...AJUSTES_FISCALES_POR_DEFECTO };
  return ajustesFiscalesDeFila(fila);
}

/** NIF, razon social, ajustes fiscales (REDEME, SII, criterio de caja) e IBAN de la empresa. */
async function contextoEmpresa303(
  companyId: string,
  ejercicio: number,
  cuentaBancariaId?: string | null,
  periodo?: string,
): Promise<{ ctx: ContextoEmpresa303; cuentas: CuentaBorrador303[]; cuentaBancariaId: string | null; mensual: boolean }> {
  const [cfg, ajustes, todas] = await Promise.all([
    configuracionEmpresa(companyId),
    ajustesFiscales303(companyId, ejercicio),
    listarCuentasBancarias(companyId).catch(() => []),
  ]);
  // Campo 24 de la página 1: en el último periodo, quien está exonerado del 390
  // (SII) dice si su volumen del año es distinto de cero (art. 121 LIVA).
  let volumenAnual: number | null = null;
  if (periodo && esUltimoPeriodo303(periodo) && ajustes.sii) {
    const anual = await calcularModelo390(companyId, ejercicio);
    volumenAnual = anual.volumen?.total ?? anual.volumenOperaciones;
  }
  const activas = todas.filter((c) => c.activa && c.iban);
  const elegida = cuentaBancariaId ? activas.find((c) => c.id === cuentaBancariaId) : activas[0];
  if (cuentaBancariaId && !elegida) throw badRequest('Esa cuenta bancaria no es de la empresa o no está activa.', { campo: 'cuentaBancariaId' });
  return {
    ctx: {
      nif: String(cfg.config_nif ?? '').trim(),
      razonSocial: String(cfg.config_razon_social ?? '').trim(),
      redeme: ajustes.redeme,
      sii: ajustes.sii,
      granEmpresa: ajustes.granEmpresa,
      volumenAnual,
      criterioCaja: ajustes.criterioCaja,
      iban: elegida?.iban ?? null,
    },
    cuentas: activas.map((c) => ({ id: c.id, iban: ibanTapado(c.iban), banco: c.bancoNombre ?? null })),
    cuentaBancariaId: elegida?.id ?? null,
    // Liquidacion mensual (art. 71.3 RIVA): REDEME, SII, gran empresa o asi elegida en los ajustes.
    mensual: ajustes.periodicidadIva === 'MENSUAL' || ajustes.redeme || ajustes.sii || ajustes.granEmpresa,
  };
}

export interface ResultadoBorrador303 {
  borrador: Borrador303;
  aCompensar: { importe: number; origen: 'manual' | 'periodo-anterior' | 'sin-dato' | 'presentado'; periodo?: string; estado?: string };
  cuentas: CuentaBorrador303[];
  cuentaBancariaId: string | null;
  /** El borrador es el del 303 presentado (casillas guardadas), no un calculo de hoy. */
  presentado: boolean;
  /** La empresa presenta el 303 cada mes (REDEME, SII, gran empresa o periodicidad mensual en los ajustes). */
  mensual: boolean;
}

/** Periodo del 303: trimestre (1T-4T) o mes (01-12). Admite 1-4 como trimestre y 1-12 con "M" (M5 -> 05). */
export function periodo303De(valor: unknown): string {
  const t = String(valor ?? '').trim().toUpperCase();
  if (/^[1-4]$/.test(t)) return `${t}T`;
  if (/^[1-4]T$/.test(t)) return t;
  const mes = /^M?(\d{1,2})$/.exec(t);
  if (mes && Number(mes[1]) >= 1 && Number(mes[1]) <= 12 && (t.startsWith('M') || mes[1].length === 2)) return mes[1].padStart(2, '0');
  throw badRequest('El periodo del 303 es un trimestre (1T a 4T) o un mes (01 a 12).', { campo: 'periodo', valor: valor ?? null });
}

/** Lo que se guarda con el 303 presentado además del cálculo: tipo, IBAN de la DID y rectificativa. */
type Guardado303 = DatosModelo303 & {
  tipoDeclaracion?: string;
  ibanPresentado?: string | null;
  rectificativa?: { justificanteAnterior: string } | null;
  /** Indicadores de la página 1 con que se presentó (SII voluntario, volumen...). */
  indicadores?: Record<number, string | null> | null;
  /** NIF y razón social con que se presentó (los config_* de las casillas de la fila). */
  empresaPresentada?: { nif: string | null; razonSocial: string | null };
};

/** Datos guardados del 303 presentado de un periodo (con sus casillas oficiales), o null. */
async function presentado303(companyId: string, periodo: PeriodoFiscal): Promise<Guardado303 | null> {
  const fila = await fila303Guardada(companyId, periodo.ejercicio, periodo.periodo);
  if (fila?.estado !== 'presentado') return null;
  const datos = fila.datos as Guardado303 | null;
  // Los guardados antes del diseño 2026 sin desglose no sirven para el fichero.
  if (!datos?.casillasOficiales && !datos?.ivaDevengado) return null;
  const cas = (fila.casillas ?? {}) as Record<string, unknown>;
  const texto = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return { ...datos, periodo, empresaPresentada: { nif: texto(cas.config_nif), razonSocial: texto(cas.config_razon_social) } };
}

/**
 * Borrador del 303 de un periodo: el que enseña la pantalla y el que va al
 * fichero (una sola fuente para los dos). Si el 303 del periodo está
 * presentado, sale de las casillas guardadas (las que se presentaron) con el
 * tipo de declaración que se presentó, aunque después cambien las facturas;
 * si no, se calcula al momento.
 */
export async function calcularBorrador303(companyId: string, periodo: PeriodoFiscal, opciones: OpcionesBorrador303 = {}): Promise<ResultadoBorrador303> {
  const guardado = await presentado303(companyId, periodo);
  if (guardado) {
    const empresa = await contextoEmpresa303(companyId, periodo.ejercicio, opciones.cuentaBancariaId, guardado.indicadores ? undefined : periodo.periodo);
    // Congelado: también el NIF y la razón social, el IBAN de la página DID y la
    // marca de rectificativa con que se presentó. Si después cambian los datos
    // de la empresa, la pantalla y el fichero siguen siendo los presentados.
    const presentada = guardado.empresaPresentada;
    const ctxPresentado = {
      ...empresa.ctx,
      nif: presentada?.nif ?? empresa.ctx.nif,
      razonSocial: presentada?.razonSocial ?? empresa.ctx.razonSocial,
      ...(guardado.ibanPresentado !== undefined ? { iban: guardado.ibanPresentado } : {}),
    };
    const borrador = montarBorrador303(
      { ...guardado, casillasOficiales: casillasOficiales303De(guardado) },
      ctxPresentado,
      guardado.tipoDeclaracion,
      {
        comoSePresento: true,
        indicadores: guardado.indicadores ?? null,
        rectificativa: guardado.rectificativa ? { ...guardado.rectificativa, resultadoAnterior: 0 } : null,
      },
    );
    borrador.advertencias.unshift('Modelo presentado: se muestran las casillas tal como se presentaron, aunque después hayan cambiado las facturas. El fichero sale de esas mismas casillas.');
    return {
      borrador,
      aCompensar: { importe: borrador.casillas['110'] ?? 0, origen: 'presentado', estado: 'presentado' },
      cuentas: empresa.cuentas,
      cuentaBancariaId: empresa.cuentaBancariaId,
      presentado: true,
      mensual: empresa.mensual,
    };
  }
  const manual = opciones.aCompensar !== undefined && opciones.aCompensar !== null;
  if (manual && (!Number.isFinite(opciones.aCompensar) || (opciones.aCompensar as number) < 0)) {
    throw badRequest('Las cuotas a compensar de periodos anteriores son un importe positivo o cero.', { campo: 'aCompensar' });
  }
  const aCompensar = manual
    ? { importe: Math.round((opciones.aCompensar as number) * 100) / 100, origen: 'manual' as const }
    : await cuotasACompensar303(companyId, periodo);
  const [datos, empresa, decl] = await Promise.all([
    calcularModelo303(companyId, periodo, aCompensar.importe),
    contextoEmpresa303(companyId, periodo.ejercicio, opciones.cuentaBancariaId, periodo.periodo),
    contextoDeclaracion(companyId, '303', periodo.ejercicio, periodo.periodo),
  ]);
  // Rectificativa en preparación (B4): [70] con el [69] de la anterior y su justificante.
  const rectificativa =
    decl.enCurso?.tipo === 'C' ? { justificanteAnterior: decl.justificanteAnterior ?? '', resultadoAnterior: decl.resultadoAnterior, devolucionAcordada: decl.devolucionAcordada } : null;
  return {
    borrador: montarBorrador303(datos, empresa.ctx, opciones.tipoDeclaracion, { rectificativa }),
    aCompensar,
    cuentas: empresa.cuentas,
    cuentaBancariaId: empresa.cuentaBancariaId,
    presentado: false,
    mensual: empresa.mensual,
  };
}

/**
 * Fichero oficial del 303 de un trimestre (1T-4T) o de un mes (01-12) con el
 * diseno de registro 2026: lo que descarga el boton de la pantalla del 303.
 * Sale del mismo borrador que la pantalla (si esta presentado, de las casillas
 * guardadas). Sin NIF ni razon social no se genera: la sede lo rechazaria.
 */
export async function generarTxt303(companyId: string, ejercicio: number, periodo303: string, opciones: OpcionesBorrador303 = {}) {
  const periodo = periodoFiscalDe({ ejercicio, periodo: periodo303De(periodo303) });
  const { borrador } = await calcularBorrador303(companyId, periodo, opciones);
  return {
    nombre: `303_${ejercicio}_${periodo.periodo}.txt`,
    contenido: ficheroBorrador303(borrador),
    advertencias: borrador.advertencias,
  };
}

/** Fichero oficial del 303 de un trimestre (ver generarTxt303). */
export function generarTxt303Trimestre(companyId: string, ejercicio: number, trimestre: 1 | 2 | 3 | 4, opciones: OpcionesBorrador303 = {}) {
  return generarTxt303(companyId, ejercicio, `${trimestre}T`, opciones);
}

/** Declaracion del 111 o del 115 de un periodo y de donde salen sus cifras. */
export interface DeclaracionRetencionesPeriodo {
  /** La fila de ModeloImpuesto (id '' si aun no existe: no se crea al leer). */
  fila: FilaModelo;
  declaracion: DeclaracionRetenciones;
  /** Datos del calculo: los de ahora si se calcula; si no, los guardados (o los de ahora si no hay). */
  datos: DatosModelo111 | DatosModelo115;
  /**
   * 'calculado': sin presentar, calculado con la contabilidad de hoy (no se guarda).
   * 'guardado': presentado, omitido o editado a mano (lo guardado manda).
   * 'guardado-antiguo': presentado antes de que se guardaran las casillas: se rehacen con los datos guardados.
   * 'calculado-sin-guardar': presentado sin casillas ni datos guardados: solo queda el calculo de hoy.
   */
  fuente: 'calculado' | 'guardado' | 'guardado-antiguo' | 'calculado-sin-guardar';
}

const datosDeRetenciones = (codigo: '111' | '115', d: unknown): DatosModelo111 | DatosModelo115 | null => {
  if (!d || typeof d !== 'object') return null;
  const x = d as Record<string, unknown>;
  if (codigo === '111') return typeof x.totalRetenciones === 'number' && typeof x.resultadoIngresar === 'number' ? (d as DatosModelo111) : null;
  return typeof x.retenciones === 'number' && typeof x.resultadoIngresar === 'number' ? (d as DatosModelo115) : null;
};

/** Fila de ModeloImpuesto de un modelo y periodo, sin crearla: si no existe, una vigente sin id. */
async function filaDePeriodoSoloLectura(companyId: string, codigo: string, ejercicio: number, periodo: string): Promise<FilaModelo> {
  if (dbOk()) {
    const f = await prisma.modeloImpuesto.findUnique({ where: { companyId_codigo_ejercicio_periodo: { companyId, codigo, ejercicio, periodo } } });
    if (f) return { ...f, casillas: (f.casillas as Casillas | null) ?? null, datos: f.datos ?? null };
  } else {
    const f = memoria.get(clave(companyId, codigo, ejercicio, periodo));
    if (f) return f;
  }
  return { id: '', companyId, codigo, ejercicio, periodo, estado: 'vigente', casillas: null, datos: null, origen: null };
}

/** Periodo para los textos: «1T» -> «del 1T»; «05» -> «de mayo». */
function delPeriodo(p: string): string {
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  return /^\d{2}$/.test(p) ? `de ${MESES[Number(p) - 1]}` : `del ${p}`;
}

/**
 * LA fuente del 111 y del 115: la pantalla (tax-models) y el fichero (TXT del
 * modulo Impuestos) salen de aqui, tambien con filas antiguas o presentadas.
 * Solo lee (B6): nunca crea ni guarda la fila; «Recalcular importes» (POST) es
 * quien guarda.
 *  - Presentado (u omitido): lo guardado, con los datos de la empresa con que
 *    se guardo. Una fila presentada de antes del formato actual se rehace con
 *    sus datos guardados; si no los tiene, con el calculo de hoy (fuente
 *    'calculado-sin-guardar', con aviso).
 *  - Editado a mano (manual-mixto): sus casillas, con los datos de la empresa de hoy.
 *  - Si no: el calculo con la contabilidad de hoy y las opciones guardadas.
 * Si se esta preparando una complementaria (historial de declaraciones), lleva
 * la marca, el justificante de la anterior y lo ya ingresado en [29] o [04].
 */
export async function declaracionRetenciones(
  companyId: string,
  codigo: '111' | '115',
  ejercicio: number,
  periodo: string,
): Promise<DeclaracionRetencionesPeriodo> {
  const p = String(periodo ?? '').toUpperCase();
  if (!PERIODO_111_115.test(p)) throw badRequest(`El ${codigo} es mensual (01 a 12) o trimestral (1T a 4T): el periodo "${periodo}" no es válido.`);
  if (!(await esEmpresaEspanolaFiscal(companyId))) throw badRequest(MENSAJE_SIN_MODELOS);
  const [fila, config, decl] = await Promise.all([
    filaDePeriodoSoloLectura(companyId, codigo, ejercicio, p),
    configuracionEmpresa(companyId),
    contextoDeclaracion(companyId, codigo, ejercicio, p),
  ]);
  const guardadas = (fila.casillas ?? {}) as Record<string, unknown>;
  const calculadasDe = (d: DatosModelo111 | DatosModelo115) => (codigo === '111' ? casillasDeDatos111(d as DatosModelo111) : casillasDeDatos115(d as DatosModelo115));
  const cerrado = fila.estado === 'presentado' || fila.estado === 'omitido';
  const complementaria = decl.enCurso?.tipo === 'C' ? { justificanteAnterior: decl.justificanteAnterior ?? '', resultadoAnterior: decl.resultadoAnterior } : null;

  if (cerrado) {
    const guardados = datosDeRetenciones(codigo, fila.datos);
    if (tieneCasillasGuardadas(codigo, guardadas) || guardados) {
      const datos = guardados ?? ((await calcularCasillas(companyId, fila)).datos as DatosModelo111 | DatosModelo115);
      const fuente = tieneCasillasGuardadas(codigo, guardadas) ? 'guardado' : 'guardado-antiguo';
      // Los datos de la empresa con que se presento mandan (los de hoy solo si no se guardaron).
      return { fila, datos, fuente, declaracion: declaracionDeGuardadas(codigo, { ...config, ...guardadas }, ejercicio, p, calculadasDe(datos)) };
    }
    // Presentado sin casillas ni datos guardados: la pantalla enseña el cálculo
    // de hoy con aviso, pero el fichero NO se inventa con esas cifras (podrían
    // no ser las presentadas): es un error que impide descargarlo.
    const datos = (await calcularCasillas(companyId, fila)).datos as DatosModelo111 | DatosModelo115;
    const declaracion = declaracionDeGuardadas(codigo, { ...config, ...guardadas }, ejercicio, p, calculadasDe(datos));
    declaracion.errores.push(
      `El ${codigo} ${delPeriodo(p)} de ${ejercicio} consta como presentado, pero la app no guardó lo que se presentó. No se rehace el fichero con las cifras de hoy porque podrían no coincidir. La copia está en la sede de la AEAT (justificante de la presentación); si hay que corregirlo, prepara una complementaria.`,
    );
    return { fila, datos, fuente: 'calculado-sin-guardar', declaracion };
  }

  if (fila.origen === 'manual-mixto' && tieneCasillasGuardadas(codigo, guardadas)) {
    const datos = datosDeRetenciones(codigo, fila.datos) ?? ((await calcularCasillas(companyId, fila)).datos as DatosModelo111 | DatosModelo115);
    return { fila, datos, fuente: 'guardado', declaracion: declaracionDeGuardadas(codigo, { ...guardadas, ...config }, ejercicio, p, calculadasDe(datos), complementaria) };
  }

  // Sin presentar: el calculo de hoy, con las opciones guardadas (no se guarda nada).
  const { casillas, datos } = await calcularCasillas(companyId, fila);
  const opciones = Object.fromEntries(Object.entries(guardadas).filter(([k]) => esOpcion(k)));
  const actuales = { ...casillas, ...config, ...opciones } as Record<string, unknown>;
  const d = datos as DatosModelo111 | DatosModelo115;
  return {
    fila: { ...fila, casillas: actuales as Casillas, datos },
    datos: d,
    fuente: 'calculado',
    declaracion: declaracionDeGuardadas(codigo, actuales, ejercicio, p, calculadasDe(d), complementaria),
  };
}

export async function generarTxtModelo(companyId: string, modeloId: string): Promise<{ nombre: string; contenido: string }> {
  const fila = await cargarFila(companyId, modeloId);
  if (fila.codigo === '111' || fila.codigo === '115') {
    // La misma funcion que la pantalla: presentado = lo guardado; sin presentar, recalculado.
    const r = await declaracionRetenciones(companyId, fila.codigo, fila.ejercicio, fila.periodo);
    return { nombre: `${fila.codigo}_${fila.ejercicio}_${fila.periodo}.txt`, contenido: ficheroDeclaracion(r.declaracion) };
  }
  // El 347, el 390 y el 200 salen siempre al momento con el diseño oficial
  // (borradoresAeat.service), igual que su pantalla, nunca del JSON guardado:
  // /tax-models lo escribía con otra forma y el TXT fallaba o salía en blanco.
  if (fila.codigo === '347') return fichero347(companyId, fila.ejercicio);
  if (fila.codigo === '390') return fichero390(companyId, fila.ejercicio);
  if (fila.codigo === '200') return fichero200(companyId, fila.ejercicio);
  // El 303, del mismo borrador que su pantalla (presentado: lo guardado).
  if (fila.codigo === '303') {
    const t = await generarTxt303(companyId, fila.ejercicio, fila.periodo);
    return { nombre: t.nombre, contenido: t.contenido };
  }
  // Solo lee (B6): cada modelo calcula su fichero al momento (o sale de lo presentado).
  const refrescada = fila;
  switch (refrescada.codigo) {
    // 349, 180 y 202: el fichero con el diseno oficial, calculado al momento.
    case '349':
      return ficheroModelo349(companyId, refrescada.ejercicio, refrescada.periodo);
    case '180':
      return ficheroModelo180(companyId, refrescada.ejercicio);
    case '202':
      return ficheroModelo202(companyId, refrescada.ejercicio, refrescada.periodo);
    case '130':
      throw badRequest('La app todavía no genera el fichero del modelo 130: preséntalo con el formulario de la sede de la AEAT.');
    case '190':
      throw badRequest('El fichero del 190 lleva los datos de cada trabajador: descárgalo en Nóminas > Modelo 190 (solo administración y contabilidad).');
    default:
      throw badRequest(`TXT no soportado para el modelo ${refrescada.codigo}.`);
  }
}

/** Copia en PDF del modelo: titulo + casillas guardadas (autorrelleno o manual). */
export async function generarPdfModelo(companyId: string, modeloId: string): Promise<{ nombre: string; contenido: Buffer }> {
  const fila = await cargarFila(companyId, modeloId);
  const detalle = await obtenerDetalleModelo(companyId, modeloId);
  const lineas: string[] = [
    `${detalle.ficha.titulo}`,
    `Periodo: ${detalle.resumen.periodoEtiqueta}    Vence: ${detalle.resumen.fechaVencimiento}    Estado: ${detalle.resumen.estado}`,
    `Origen de los datos: ${detalle.origen}`,
    ''.padEnd(90, '-'),
  ];
  const entradas = Object.entries(detalle.casillas);
  if (!entradas.length) lineas.push('(sin casillas: pulsa "Recalcular importes" para autorrellenar)');
  for (const [k, v] of entradas) {
    const valor = typeof v === 'number' ? v.toFixed(2) : String(v ?? '');
    lineas.push(`${k.padEnd(40, '.')} ${valor}`);
  }
  lineas.push(''.padEnd(90, '-'), 'Documento generado por la API (copia informativa, no valida para presentacion).');
  return {
    nombre: `${fila.codigo}_${fila.ejercicio}_${fila.periodo}.pdf`,
    contenido: await generarPdfA(`Modelo ${fila.codigo} - ${fila.ejercicio} ${fila.periodo}`, lineas),
  };
}

// --- 4) Excel de ingresos y gastos (flujo de validacion del video) ---

/**
 * Excel con los ingresos y gastos del periodo para revisar ANTES de presentar
 * (flujo del video: exportar -> revisar -> corregir facturas -> recalcular).
 * Hojas: "Ingresos" (facturas de venta) y "Gastos" (facturas de compra).
 */
export async function exportarIngresosGastosExcel(
  companyId: string,
  filtro: { ejercicio: number; periodo?: string },
): Promise<Buffer> {
  const ej = filtro.ejercicio;
  const per = (filtro.periodo ?? '0A').toUpperCase().replace('Q', '').replace(/^([1-4])$/, '$1T'); // 'Q1'->'1T'

  // Rango de fechas: año completo (0A), trimestre (1T..4T) o MES (01..12).
  let rango: { fechaInicio: string; fechaFin: string };
  if (/^(0?[1-9]|1[0-2])$/.test(per) && per !== '1' && !per.endsWith('T')) {
    const mes = per.padStart(2, '0');
    const ultimoDia = new Date(ej, Number(mes), 0).getDate();
    rango = { fechaInicio: `${ej}-${mes}-01`, fechaFin: `${ej}-${mes}-${String(ultimoDia).padStart(2, '0')}` };
  } else {
    const fila: FilaModelo = { id: '', companyId, codigo: '303', ejercicio: ej, periodo: per === '0A' ? '0A' : per, estado: 'vigente', casillas: null, datos: null, origen: null };
    rango = periodoFiscalDe(fila);
  }

  const fs = await getFsClientForCompany(companyId);
  const [ventas, compras] = await Promise.all([
    fs.listWithMeta('facturaclientes', { 'filter[fecha_gte]': rango.fechaInicio, 'filter[fecha_lte]': rango.fechaFin, limit: 1000 }),
    fs.listWithMeta('facturaproveedores', { 'filter[fecha_gte]': rango.fechaInicio, 'filter[fecha_lte]': rango.fechaFin, limit: 1000 }),
  ]);

  const filaDe = (f: Record<string, unknown>, tercero: string) => ({
    Codigo: f.codigo ?? f.idfactura,
    Fecha: f.fecha,
    Tercero: f[tercero] ?? '',
    Nombre: f.nombrecliente ?? f.nombre ?? '',
    NIF: f.cifnif ?? '',
    Base: Number(f.neto ?? 0),
    IVA: Number(f.totaliva ?? 0),
    IRPF: Number(f.totalirpf ?? 0),
    Total: Number(f.total ?? 0),
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet((ventas.items as Array<Record<string, unknown>>).map((f) => filaDe(f, 'codcliente'))),
    'Ingresos',
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet((compras.items as Array<Record<string, unknown>>).map((f) => filaDe(f, 'codproveedor'))),
    'Gastos',
  );
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

// id estable para memoria (tests): expone helper para localizar por codigo+periodo
export async function buscarModelo(companyId: string, ejercicio: number, codigo: string, periodo: string): Promise<ModeloImpuestoResumen | undefined> {
  const todos = [
    ...(await listarModelosImpuesto(companyId, ejercicio, 'activos')),
    ...(await listarModelosImpuesto(companyId, ejercicio, 'omitidos')),
    ...(await listarModelosImpuesto(companyId, ejercicio, 'presentados')),
  ];
  return todos.find((m) => m.codigo === codigo && m.periodo === periodo);
}
void randomUUID; // (reservado para ids en almacenes futuros)

// --- Solo lectura (Carmen) ---

/** Modelo del calendario con su estado, aunque la fila todavía no exista en la BD. */
export interface ModeloCalendarioLectura extends ModeloImpuestoResumen {
  /** false: la fila no existe todavía (nadie ha abierto ese ejercicio en la pantalla). */
  guardado: boolean;
}

/**
 * Calendario fiscal del ejercicio en curso y del anterior SIN escribir nada:
 * a diferencia de listarModelosImpuesto, no crea las filas que faltan
 * (asegurarCalendario); una fila que no existe cuenta como 'vigente' sin
 * borrador, que es como nacería al abrir la pantalla. Lo usa Carmen (INT-30).
 */
export async function calendarioFiscalSoloLectura(companyId: string, hoy: string): Promise<ModeloCalendarioLectura[]> {
  // Como listarModelosImpuesto: una empresa no establecida en Espana no tiene calendario de la AEAT.
  if (!(await esEmpresaEspanolaFiscal(companyId))) return [];
  const anio = Number(hoy.slice(0, 4));
  const ejercicios = [anio - 1, anio];
  let filas: FilaModelo[];
  if (dbOk()) {
    const rows = await prisma.modeloImpuesto.findMany({
      where: { companyId, ejercicio: { in: ejercicios } },
      select: { id: true, companyId: true, codigo: true, ejercicio: true, periodo: true, estado: true, casillas: true, origen: true },
    });
    filas = rows.map((f) => ({ ...f, casillas: (f.casillas as Casillas | null) ?? null, datos: null }));
  } else {
    filas = [...memoria.values()].filter((f) => f.companyId === companyId && ejercicios.includes(f.ejercicio));
  }
  const out: ModeloCalendarioLectura[] = [];
  for (const ejercicio of ejercicios) {
    const opciones = await opcionesCalendarioEmpresa(companyId, ejercicio);
    // Las filas que ya hay y las que se crearian al abrir el ejercicio en la pantalla.
    const delAnio = filas.filter((f) => f.ejercicio === ejercicio);
    for (const fila of delAnio) out.push({ ...aResumen(fila, hoy), guardado: true });
    for (const { codigo, periodo } of filasQueFaltan(ejercicio, calendarioEjercicio(ejercicio, opciones), delAnio)) {
      const base: FilaModelo = { id: '', companyId, codigo, ejercicio, periodo, estado: 'vigente', casillas: null, datos: null, origen: null };
      out.push({ ...aResumen(base, hoy), guardado: false });
    }
  }
  return out.sort((a, b) => a.fechaVencimiento.localeCompare(b.fechaVencimiento) || a.codigo.localeCompare(b.codigo));
}

/** Un modelo guardado (estado y casillas) sin crearlo si no existe. Solo lee. */
export async function modeloGuardadoSoloLectura(
  companyId: string,
  codigo: string,
  ejercicio: number,
  periodo: string,
): Promise<{ id: string; estado: string; casillas: Casillas | null; origen: string | null } | null> {
  if (dbOk()) {
    const f = await prisma.modeloImpuesto.findUnique({
      where: { companyId_codigo_ejercicio_periodo: { companyId, codigo, ejercicio, periodo } },
      select: { id: true, estado: true, casillas: true, origen: true },
    });
    return f ? { ...f, casillas: (f.casillas as Casillas | null) ?? null } : null;
  }
  const f = memoria.get(clave(companyId, codigo, ejercicio, periodo));
  return f ? { id: f.id, estado: f.estado, casillas: f.casillas, origen: f.origen } : null;
}
