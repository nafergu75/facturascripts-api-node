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
} from './impuestosCalculo.service';
import { calcularModelo200 } from './impuestoSociedadesCalculo.service';
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
  '303': 'IVA — autoliquidacion trimestral',
  '111': 'Retenciones IRPF (trabajo y profesionales)',
  '115': 'Retenciones por alquileres',
  '349': 'Operaciones intracomunitarias',
  '390': 'IVA — resumen anual',
  '347': 'Operaciones con terceros (> 3.005,06)',
  '200': 'Impuesto sobre Sociedades',
};

/** Fecha limite de presentacion del modelo/periodo (plazos generales AEAT). */
export function fechaVencimientoModelo(codigo: string, ejercicio: number, periodo: string): string {
  const TRIM: Record<string, string> = { '1T': `${ejercicio}-04-20`, '2T': `${ejercicio}-07-20`, '3T': `${ejercicio}-10-20` };
  if (periodo in TRIM) return TRIM[periodo];
  if (periodo === '4T') {
    // 111/115: 20 de enero; 303/349: 30 de enero
    return codigo === '111' || codigo === '115' ? `${ejercicio + 1}-01-20` : `${ejercicio + 1}-01-30`;
  }
  // anuales
  if (codigo === '390') return `${ejercicio + 1}-01-30`;
  if (codigo === '347') return `${ejercicio + 1}-02-28`;
  if (codigo === '200') return `${ejercicio + 1}-07-25`;
  return `${ejercicio + 1}-01-30`;
}

/** Modelos que componen el calendario de un ejercicio. */
function calendarioEjercicio(ejercicio: number): Array<{ codigo: string; periodo: string }> {
  const out: Array<{ codigo: string; periodo: string }> = [];
  for (const codigo of ['303', '111', '115', '349']) {
    for (const periodo of ['1T', '2T', '3T', '4T']) out.push({ codigo, periodo });
  }
  for (const codigo of ['390', '347', '200']) out.push({ codigo, periodo: '0A' });
  void ejercicio;
  return out;
}

const clave = (companyId: string, codigo: string, ejercicio: number, periodo: string): string =>
  `${companyId}:${codigo}:${ejercicio}:${periodo}`;

/** Crea (si faltan) las filas del calendario del ejercicio. */
async function asegurarCalendario(companyId: string, ejercicio: number): Promise<void> {
  for (const { codigo, periodo } of calendarioEjercicio(ejercicio)) {
    if (dbOk()) {
      await prisma.modeloImpuesto.upsert({
        where: { companyId_codigo_ejercicio_periodo: { companyId, codigo, ejercicio, periodo } },
        update: {},
        create: { companyId, codigo, ejercicio, periodo, estado: 'vigente' },
      });
    } else {
      const k = clave(companyId, codigo, ejercicio, periodo);
      if (!memoria.has(k)) {
        memoria.set(k, { id: k, companyId, codigo, ejercicio, periodo, estado: 'vigente', casillas: null, datos: null, origen: null });
      }
    }
  }
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
  const etiqueta = f.periodo === '0A' ? String(f.ejercicio) : `${f.ejercicio}Q${f.periodo[0]}`;
  return {
    id: f.id,
    companyId: f.companyId,
    codigo: f.codigo,
    descripcion: DESCRIPCIONES[f.codigo] ?? `Modelo ${f.codigo}`,
    ejercicio: f.ejercicio,
    periodo: f.periodo,
    periodoEtiqueta: etiqueta,
    estado,
    fechaVencimiento,
    diasHastaVencimiento: dias >= 0 ? dias : undefined,
    diasDesdeVencimiento: dias < 0 ? -dias : undefined,
    tieneBorrador: !!f.casillas,
    origen: (f.origen as 'autorrelleno' | 'manual-mixto' | null) ?? undefined,
  };
}

// --- 1) Lista y estados ---

export async function listarModelosImpuesto(
  companyId: string,
  ejercicio: number,
  tab: 'activos' | 'omitidos' | 'presentados' = 'activos',
  hoy: string = new Date().toISOString().slice(0, 10),
): Promise<ModeloImpuestoResumen[]> {
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

function periodoFiscalDe(fila: FilaModelo): PeriodoFiscal {
  const ej = fila.ejercicio;
  if (fila.periodo === '0A') {
    return { ejercicio: ej, periodo: '0A', tipo: 'anual', fechaInicio: `${ej}-01-01`, fechaFin: `${ej}-12-31` };
  }
  const T: Record<string, [string, string]> = { '1T': ['01-01', '03-31'], '2T': ['04-01', '06-30'], '3T': ['07-01', '09-30'], '4T': ['10-01', '12-31'] };
  const [ini, fin] = T[fila.periodo];
  return { ejercicio: ej, periodo: fila.periodo, tipo: 'trimestral', fechaInicio: `${ej}-${ini}`, fechaFin: `${ej}-${fin}` };
}

/** Configuracion de la empresa para el autorrelleno (NIF, razon social, IBAN). */
async function configuracionEmpresa(companyId: string): Promise<Casillas> {
  const out: Casillas = {};
  try {
    const fs = await getFsClientForCompany(companyId);
    const { items } = await fs.listWithMeta('empresas', { limit: 1 });
    const e = items[0] as Record<string, unknown> | undefined;
    out.config_nif = (e?.cifnif as string) ?? null;
    out.config_razon_social = (e?.nombre as string) ?? null;
  } catch {
    out.config_nif = null;
    out.config_razon_social = null;
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
  switch (fila.codigo) {
    case '303': {
      const d = await calcularModelo303(companyId, periodo);
      return { casillas: { ...d.casillas }, datos: d };
    }
    case '390': {
      const d = await calcularModelo390(companyId, fila.ejercicio);
      return {
        casillas: {
          cuota_devengada: d.totalCuotaDevengada,
          cuota_deducible: d.totalCuotaDeducible,
          resultado_anual: d.resultadoAnual,
          volumen_operaciones: d.volumenOperaciones,
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
      return { casillas: { num_operadores: d.operaciones.length, total_base: d.totalBase }, datos: d };
    }
    case '111': {
      const d = await calcularModelo111(companyId, periodo);
      return {
        casillas: {
          '01_perceptores_trabajo': d.nPerceptoresTrabajo,
          '02_percepciones_trabajo': d.percepcionesTrabajo,
          '03_retenciones_trabajo': d.retencionesTrabajo,
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
