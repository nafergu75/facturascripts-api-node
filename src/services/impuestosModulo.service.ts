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
  DatosModelo347,
  DatosModelo349,
  DatosModelo390,
  PeriodoFiscal,
} from '../domain/impuestos.model';
import { DatosModelo200 } from '../domain/impuesto-sociedades.model';
import {
  calcularModelo111,
  calcularModelo115,
  calcularModelo303,
  calcularModelo347,
  calcularModelo349,
  calcularModelo390,
  esEmpresaEspanolaFiscal,
  MENSAJE_SIN_MODELOS,
} from './impuestosCalculo.service';
import { calcularModelo200 } from './impuestoSociedadesCalculo.service';
import { calcularModelo190 } from './nominas/fiscal';
import {
  envolverFichero,
  generarFicheroModelo111,
  generarFicheroModelo115,
  generarFicheroModelo200,
  generarFicheroModelo303,
  generarFicheroModelo347,
  generarFicheroModelo349,
  generarFicheroModelo390,
  generarPaginaModelo303_03,
} from './impuestosExport.service';
import { badRequest, forbidden, notFound } from '../utils/http-errors';
import {
  calendarioEjercicio,
  filasQueFaltan,
  planCambioCalendario,
  type EntradaCalendario,
  type OpcionesCalendario,
} from '../domain/calendarioFiscal';
import { AJUSTES_FISCALES_POR_DEFECTO, ajustesFiscalesDeFila } from '../domain/ajustes.model';
import { anioEspana } from '../utils/fechas';

/**
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
};

/** Fecha limite de presentacion del modelo/periodo (plazos generales AEAT). */
export function fechaVencimientoModelo(codigo: string, ejercicio: number, periodo: string): string {
  const TRIM: Record<string, string> = { '1T': `${ejercicio}-04-20`, '2T': `${ejercicio}-07-20`, '3T': `${ejercicio}-10-20` };
  if (periodo in TRIM) return TRIM[periodo];
  if (/^(0[1-9]|1[0-2])$/.test(periodo)) {
    const mes = Number(periodo);
    const siguiente = String(mes + 1).padStart(2, '0');
    if (codigo === '303') {
      // IVA mensual: solo lo presentan las empresas en el SII (gran empresa,
      // REDEME o SII voluntario), que tienen los 30 primeros dias naturales del
      // mes siguiente (art. 71.4 RIVA); el de enero, hasta el ultimo dia de
      // febrero, y el de diciembre, hasta el 30 de enero.
      if (mes === 1) return `${ejercicio}-02-${String(new Date(Date.UTC(ejercicio, 2, 0)).getUTCDate()).padStart(2, '0')}`;
      if (mes === 12) return `${ejercicio + 1}-01-30`;
      return `${ejercicio}-${siguiente}-30`;
    }
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
  if (codigo === '347') return `${ejercicio + 1}-02-28`;
  if (codigo === '200') return `${ejercicio + 1}-07-25`;
  if (codigo === '190') return `${ejercicio + 1}-01-31`;
  return `${ejercicio + 1}-01-30`;
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
 * Crea (si faltan) las filas del calendario del ejercicio. Una empresa no
 * establecida en Espana no presenta modelos de la AEAT: no se le crea nada.
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

async function cargarFila(companyId: string, modeloId: string): Promise<FilaModelo> {
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
  const etiqueta = f.periodo === '0A' ? String(f.ejercicio) : /^\d{2}$/.test(f.periodo) ? `${f.ejercicio}-${f.periodo}` : `${f.ejercicio}Q${f.periodo[0]}`;
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
  hoy: string = new Date().toISOString().slice(0, 10),
): Promise<ModeloImpuestoResumen[]> {
  // Empresa no establecida en Espana: sin modelos de la AEAT ni calendario.
  if (!(await esEmpresaEspanolaFiscal(companyId))) return [];
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
  const fila = await cargarFila(companyId, modeloId);
  fila.estado = estado;
  await guardarFila(fila);
  return aResumen(fila, new Date().toISOString().slice(0, 10));
}

export const omitirModelo = (companyId: string, modeloId: string) => cambiarEstado(companyId, modeloId, 'omitido');
/** Recupera un omitido: vuelve a vigente/expirado (se deriva por fecha). */
export const recuperarModeloOmitido = (companyId: string, modeloId: string) => cambiarEstado(companyId, modeloId, 'vigente');
export const marcarModeloListoParaPresentar = (companyId: string, modeloId: string) => cambiarEstado(companyId, modeloId, 'presentado');
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
  throw badRequest(`Periodo no válido: "${fila.periodo}". Usa 0A (anual), 1T a 4T (trimestres) o 01 a 12 (meses).`);
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
      const d = await calcularModelo303(companyId, periodo);
      return {
        casillas: {
          ...d.casillas,
          // Informacion adicional (pagina 3): por tipo de operacion.
          '59_entregas_intracomunitarias': d.entregasIntracomunitarias ?? 0,
          '60_exportaciones': d.exportaciones ?? 0,
          '120_no_sujetas_localizacion': d.noSujetasLocalizacion ?? 0,
          '122_inversion_sujeto_pasivo': d.inversionSujetoPasivo ?? 0,
          ...(d.advertencias?.length ? { advertencias: d.advertencias.join(' · ') } : {}),
        },
        datos: d,
      };
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
      const d = await calcularModelo349(companyId, periodo);
      return {
        casillas: {
          num_operadores: d.operaciones.length,
          total_base: d.totalBase,
          ...(d.advertencias?.length ? { advertencias: d.advertencias.join(' · ') } : {}),
        },
        datos: d,
      };
    }
    case '111': {
      const d = await calcularModelo111(companyId, periodo);
      return {
        casillas: {
          '01_perceptores_trabajo': d.nPerceptoresTrabajo,
          '02_percepciones_trabajo': d.percepcionesTrabajo,
          '03_retenciones_trabajo': d.retencionesTrabajo,
          '04_perceptores_especie': d.nPerceptoresEspecie ?? 0,
          '05_percepciones_especie': d.percepcionesEspecie ?? 0,
          '06_ingresos_a_cuenta': d.ingresosACuentaEspecie ?? 0,
          '07_perceptores_actividades': d.nPerceptoresActividades ?? 0,
          '08_percepciones_actividades': d.percepcionesActividades ?? 0,
          '09_retenciones_actividades': d.retencionesActividades ?? 0,
          '28_total_retenciones': d.totalRetenciones,
          '30_resultado': d.resultadoIngresar,
        },
        datos: d,
      };
    }
    case '115': {
      const d = await calcularModelo115(companyId, periodo);
      return {
        casillas: {
          '01_perceptores': d.nPerceptores,
          '02_base': d.baseRetenciones,
          '03_retenciones': d.retenciones,
          '04_anteriores': d.resultadoAnteriores,
          '05_resultado': d.resultadoIngresar,
        },
        datos: d,
      };
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
    resumen: aResumen(fila, new Date().toISOString().slice(0, 10)),
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
  const fila = await cargarFila(companyId, modeloId);

  if (fila.estado === 'presentado' || fila.estado === 'omitido') {
    throw forbidden(`No puedes recalcular un modelo ${fila.estado}. Contacta administración.`);
  }

  const [{ casillas, datos }, config] = await Promise.all([calcularCasillas(companyId, fila), configuracionEmpresa(companyId)]);
  fila.casillas = { ...casillas, ...config };
  fila.datos = datos;
  fila.origen = 'autorrelleno';
  await guardarFila(fila); // guardado automatico del autorrelleno
  return obtenerDetalleModelo(companyId, modeloId);
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
  const fila = await cargarFila(companyId, modeloId);
  fila.casillas = { ...(fila.casillas ?? {}), ...casillasParciales };
  fila.origen = 'manual-mixto';
  await guardarFila(fila);
  return obtenerDetalleModelo(companyId, modeloId);
}

// --- 3) TXT (diseno AEAT) y PDF ---

/**
 * Genera el TXT AEAT del modelo desde los DATOS del ultimo autorrelleno (si no
 * hay, recalcula al vuelo). OJO (documentado): las ediciones MANUALES de
 * casillas NO viajan al TXT — TODO mapear casillas->datos por modelo; hoy el
 * TXT refleja el autorrelleno, como indica la advertencia del propio video.
 */
/**
 * Fichero oficial del 303 de un trimestre, calculado al momento (lo que
 * descarga el boton de la pantalla del 303). Sin NIF no se genera: la sede de
 * la AEAT lo rechazaria.
 */
export async function generarTxt303Trimestre(companyId: string, ejercicio: number, trimestre: 1 | 2 | 3 | 4) {
  const fila: FilaModelo = { id: '', companyId, codigo: '303', ejercicio, periodo: `${trimestre}T`, estado: 'vigente', casillas: null, datos: null, origen: null };
  const periodo = periodoFiscalDe(fila);
  const cfg = await configuracionEmpresa(companyId);
  const nif = String(cfg.config_nif ?? '').trim();
  if (!nif) {
    throw badRequest('Falta el NIF de la empresa. Rellénalo en Registro Mercantil > Datos para la memoria y vuelve a descargar el fichero.');
  }
  const d = await calcularModelo303(companyId, periodo);
  const pag1 = generarFicheroModelo303(nif, periodo, d, String(cfg.config_razon_social ?? '')).replace(/\r\n$/, '');
  const pag3 = generarPaginaModelo303_03(d);
  return {
    nombre: `303_${ejercicio}_${trimestre}T.txt`,
    contenido: envolverFichero('303', ejercicio, periodo.periodo, pag1 + pag3, { versionPrograma: '0101' }),
    advertencias: d.advertencias ?? [],
  };
}

export async function generarTxtModelo(companyId: string, modeloId: string): Promise<{ nombre: string; contenido: string }> {
  const fila = await cargarFila(companyId, modeloId);
  if (!fila.datos) await autorrellenarModelo(companyId, modeloId);
  const refrescada = await cargarFila(companyId, modeloId);
  const datos = refrescada.datos;
  const cas = refrescada.casillas ?? {};
  const nif = String(cas.config_nif ?? '');
  const razon = String(cas.config_razon_social ?? '');
  const periodo = periodoFiscalDe(refrescada);
  const nombre = `${refrescada.codigo}_${refrescada.ejercicio}_${refrescada.periodo}.txt`;

  switch (refrescada.codigo) {
    case '303': {
      const d = datos as DatosModelo303;
      const pag1 = generarFicheroModelo303(nif, periodo, d, razon).replace(/\r\n$/, '');
      const pag3 = generarPaginaModelo303_03(d);
      return { nombre, contenido: envolverFichero('303', periodo.ejercicio, periodo.periodo, pag1 + pag3, { versionPrograma: '0101' }) };
    }
    case '390': {
      const paginas = generarFicheroModelo390(nif, refrescada.ejercicio, datos as DatosModelo390).replace(/\r\n$/, '');
      return { nombre, contenido: envolverFichero('390', refrescada.ejercicio, '0A', paginas, { versionPrograma: '0102' }) };
    }
    case '347':
      return { nombre, contenido: generarFicheroModelo347(nif, refrescada.ejercicio, datos as DatosModelo347, razon) };
    case '349':
      return { nombre, contenido: generarFicheroModelo349(nif, periodo, datos as DatosModelo349, razon) };
    case '111':
      return { nombre, contenido: generarFicheroModelo111(nif, periodo, datos as DatosModelo111, { denominacion: razon }) };
    case '115':
      return { nombre, contenido: generarFicheroModelo115(nif, periodo, datos as DatosModelo115, { razonSocial: razon }) };
    case '200':
      return { nombre, contenido: generarFicheroModelo200(nif, refrescada.ejercicio, { razonSocial: razon }) };
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
