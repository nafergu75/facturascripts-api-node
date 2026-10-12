/**
 * TAX MODELS SERVICE - Generación de Modelos Fiscales (303, 111, 200)
 *
 * Responsabilidades:
 * - Generar modelo 303 (IVA trimestral) con datos AEAT
 * - Generar modelo 111 (retenciones) con datos AEAT
 * - Generar modelo 200 (impuesto de sociedades) con datos AEAT
 * - Persistencia y gestión de estado (BORRADOR, PRESENTADO)
 * - Integración con plantillas AEAT existentes
 * - Auditoría de generación y presentación
 */

import { badRequest, notFound } from '../utils/http-errors';
import { prisma } from '../config/database';
import { estadosEnRectificacion } from './declaracionesAeat/declaraciones.service';
import { taxDocumentsService } from './tax-documents.service';
import { reportsService } from './reports.service';
import { registrarAuditoria } from './auditoria.service';
import { esEmpresaEspanolaFiscal, MENSAJE_SIN_MODELOS, ventasQuePuedenDevengarseEntre } from './impuestosCalculo.service';
import { esTipoOperacion, fechaDevengoVenta, paisLegacy } from '../domain/tipo-operacion.model';
/** Quien y cuando genero o presento un modelo (se guarda en `datos.auditoria`). */
type ModeloFiscalAuditoria = Record<string, unknown> & {
  generadoPor: string;
  generadoEn: string;
  marcadoPresentadoPor?: string;
  marcadoPresentadoEn?: string;
  justificante?: { numero: string; fecha: string };
  origen: 'autorrelleno' | 'manual-mixto' | 'importado';
  version: string;
};
import type { DatosModelo111, DatosModelo115, DatosModelo303 } from '../domain/impuestos.model';
import { calcularModelo115 } from './impuestosCalculo.service';
import { periodoFiscal } from './nominas/fiscal';
import { aparicionesEntre, importe347Gasto, whereGastosFiscales } from '../domain/factura-gasto.model';
import {
  calcularBorrador303,
  calcularCasillasModelo,
  casillasGuardadas303,
  datosGuardados303,
  declaracionRetenciones,
  periodo303De,
  periodoFiscalDe,
  type DeclaracionRetencionesPeriodo,
  type OpcionesBorrador303,
  type ResultadoBorrador303,
} from './impuestosModulo.service';
import { casillasPantalla303, NOMBRE_TIPO_DECLARACION_303, type CasillaPantalla303 } from './modelo303.service';
import { casillasAGuardadas, ficheroDeclaracion, formularioDeclaracion, type FormularioRetenciones } from './aeatRetenciones/declaracion';
import type { Modelo190 } from './nominas/fiscal';
import { DR190 } from './aeatRetenciones/diseno';
import { comprobarDiseno190 } from './nominas/modelo190';
import { textoExceso, traspaso4709De, type Traspaso4709 } from './aeatRetenciones/traspaso4709';

/** Aviso del diseño del 190 para la pantalla (null si esta publicado; sin error para ejercicios antiguos). */
function avisoDiseno190(ejercicio: number): string | null {
  try {
    return comprobarDiseno190(ejercicio).aviso;
  } catch (e) {
    return e instanceof Error ? e.message : null;
  }
}

type CasillasGuardadas = Record<string, unknown>;

type PorTipoActividades = NonNullable<DatosModelo111['actividadesPorTipo']>;

/**
 * Casillas del 111 para la pantalla de modelos fiscales a partir de las
 * oficiales (las que guarda el modulo Impuestos y usa el TXT): claves '01'..'30'
 * con su importe y el desglose por tipo de rendimiento. Los profesionales van
 * por el tipo real de sus facturas (15 %, 7 %) si el desglose cuadra con las
 * casillas 08 y 09; si no (casillas editadas a mano), en una fila con el tipo
 * medio. En el trabajo el porcentaje es siempre el medio (cada nomina lleva el suyo).
 */
function casillasPantalla111(oficiales: CasillasGuardadas, porTipo?: PorTipoActividades) {
  const v = (k: string) => Number(oficiales[k] ?? 0) || 0;
  const cent = (n: number) => Math.round(n * 100);
  const tasa = (cuota: number, base: number) => (base ? Math.round((cuota / base) * 10000) / 100 : 0);
  const base08 = v('08_percepciones_actividades');
  const cuota09 = v('09_retenciones_actividades');
  const desgloseCuadra =
    !!porTipo?.length &&
    cent(porTipo.reduce((a, t) => a + t.base, 0)) === cent(base08) &&
    cent(porTipo.reduce((a, t) => a + t.cuota, 0)) === cent(cuota09);
  const profesionales = desgloseCuadra
    ? porTipo!.map((t) => ({ tipo: `Profesionales (${t.porcentaje} %)`, base: t.base, cuota: t.cuota, operaciones: t.perceptores, porcentaje: t.porcentaje, medio: false }))
    : [{ tipo: 'Profesionales', base: base08, cuota: cuota09, operaciones: v('07_perceptores_actividades'), porcentaje: tasa(cuota09, base08), medio: true }];
  const retenciones = [
    { tipo: 'Trabajo (nóminas)', base: v('02_percepciones_trabajo'), cuota: v('03_retenciones_trabajo'), operaciones: v('01_perceptores_trabajo') },
    { tipo: 'Trabajo en especie (ingresos a cuenta)', base: v('05_percepciones_especie'), cuota: v('06_ingresos_a_cuenta'), operaciones: v('04_perceptores_especie') },
  ]
    .map((r) => ({ ...r, porcentaje: tasa(r.cuota, r.base), medio: true }))
    .concat(profesionales)
    .filter((r) => r.base || r.cuota || r.operaciones);
  return {
    casillas: {
      '01': v('01_perceptores_trabajo'),
      '02': v('02_percepciones_trabajo'),
      '03': v('03_retenciones_trabajo'),
      '04': v('04_perceptores_especie'),
      '05': v('05_percepciones_especie'),
      '06': v('06_ingresos_a_cuenta'),
      '07': v('07_perceptores_actividades'),
      '08': v('08_percepciones_actividades'),
      '09': v('09_retenciones_actividades'),
      '28': v('28_total_retenciones'),
      '30': v('30_resultado'),
      retenciones,
    },
    totalBase: Math.round((v('02_percepciones_trabajo') + v('05_percepciones_especie') + v('08_percepciones_actividades')) * 100) / 100,
    totalRetenido: v('28_total_retenciones'),
  };
}

/**
 * Periodo del 111 y del 115: '1T'..'4T' o '01'..'12' (mensual). Un numero es un
 * trimestre (la pantalla antigua mandaba trimestre=1..4). 400 si no vale.
 */
export function periodoRetenciones(entrada: number | string): string {
  if (typeof entrada === 'number') {
    if (Number.isInteger(entrada) && entrada >= 1 && entrada <= 4) return `${entrada}T`;
    throw badRequest('El trimestre va del 1 al 4.');
  }
  const p = String(entrada ?? '').toUpperCase().trim();
  if (/^[1-4]T$/.test(p)) return p;
  if (/^(0?[1-9]|1[0-2])$/.test(p)) return p.padStart(2, '0');
  throw badRequest(`Periodo "${entrada}" no válido: usa un trimestre (1T a 4T) o un mes (01 a 12).`);
}

const trimestreDe = (periodo: string): number | null => (/^[1-4]T$/.test(periodo) ? Number(periodo[0]) : null);

/** Avisos de donde salen las cifras del 111 o del 115 (presentado, editado a mano...). */
function avisosFuente(r: DeclaracionRetencionesPeriodo, origen: string): string[] {
  if (r.fuente === 'calculado-sin-guardar') {
    return [`Modelo presentado antes de que la app guardara sus casillas: se muestran las calculadas hoy con ${origen}. Compruébalas con el justificante de la sede.`];
  }
  if (r.fila.estado === 'presentado') return [`Modelo presentado: se muestran las casillas tal como se presentaron, aunque después hayan cambiado ${origen}.`];
  if (r.fila.estado === 'omitido') return ['Modelo marcado como omitido: se muestran las casillas guardadas.'];
  if (r.fuente === 'guardado') return ['Casillas editadas a mano en Impuestos: se muestran tal como se guardaron.'];
  return [];
}

/** 400 si la empresa no esta establecida en Espana (no presenta modelos de la AEAT). */
async function exigirEmpresaEspanola(companyId: string): Promise<void> {
  if (!(await esEmpresaEspanolaFiscal(companyId))) throw badRequest(MENSAJE_SIN_MODELOS);
}

/**
 * Fichero del 111 o del 115 de un periodo para importar en la sede: la misma
 * declaracion que la pantalla (presentado: lo guardado). Solo lee (B6).
 */
export async function ficheroRetenciones(companyId: string, codigo: '111' | '115', ejercicio: number, periodoEntrada: number | string): Promise<{ nombre: string; contenido: string }> {
  const periodo = periodoRetenciones(periodoEntrada);
  const r = await declaracionRetenciones(companyId, codigo, ejercicio, periodo);
  return { nombre: `${codigo}_${ejercicio}_${periodo}.txt`, contenido: ficheroDeclaracion(r.declaracion) };
}

/**
 * Exceso de retencion de abonos del 111 o 115 (decision P1) y su traspaso a la
 * 4709, para la pantalla: el importe, el asiento si ya esta hecho y el aviso.
 */
async function excesoConTraspaso(companyId: string, codigo: '111' | '115', ejercicio: number, periodo: string, exceso: number | undefined) {
  const cent = Math.max(0, Math.round((exceso ?? 0) * 100));
  const hecho = await traspaso4709De(companyId, codigo, ejercicio, periodo);
  if (!cent && !hecho) return { excesoAbonos: null, traspaso4709: null, aviso: null };
  // Sin hacer, ya lo dice el aviso del calculo (avisoExcesoRetencion); hecho, se dice con su asiento.
  // Si despues se corrige o se anula un abono (o entra otra factura), el asiento ya no coincide.
  return { excesoAbonos: cent / 100, traspaso4709: hecho, aviso: hecho ? textoExceso(codigo, cent / 100, hecho) : null };
}

export class TaxModelsService {
  /**
   * MODELO 303: IVA TRIMESTRAL O MENSUAL
   *
   * Borrador del 303 con el diseño de registro oficial 2026: las casillas que
   * enseña la pantalla salen del mismo cálculo que el fichero que se importa en
   * la sede (calcularBorrador303), con su número y la descripción de la AEAT.
   * Guarda en ModeloImpuesto lo mismo que "Recalcular importes" de Impuestos
   * (casillas con nombre y datos del fichero), para que las dos pantallas no se
   * pisen. Un modelo presentado, omitido o editado a mano no se recalcula: si
   * está presentado se enseñan las casillas guardadas (las mismas que el fichero).
   * `periodo303`: trimestre (1 a 4, o 1T a 4T) o mes (01 a 12) para quien lo
   * presenta cada mes (REDEME o SII).
   * Las listas de facturas de abajo salen de los libros de IVA (informativas).
   */
  async generarModelo303(
    companyId: string,
    ejercicio: number,
    periodo303: number | string,
    userId?: string,
    opciones: OpcionesBorrador303 = {},
  ): Promise<{
    ejercicio: number;
    /** Trimestre (1-4); null si el periodo es un mes. */
    trimestre: number | null;
    /** Periodo del 303: 1T-4T o 01-12. */
    periodo: string;
    /** La empresa presenta el 303 cada mes (REDEME, SII, gran empresa o periodicidad mensual). */
    mensual: boolean;
    ivaRepercutido: { total: number; desglose: any[] };
    ivaSoportado: { total: number; desglose: any[] };
    resultado: number;
    estado: string;
    origen: string | null;
    casillas: CasillasGuardadas;
    casillas303: CasillaPantalla303[];
    tipoDeclaracion: string;
    tiposDeclaracion: Array<{ codigo: string; nombre: string }>;
    aCompensar: ResultadoBorrador303['aCompensar'];
    cuentas: ResultadoBorrador303['cuentas'];
    cuentaBancariaId: string | null;
    sinActividad: boolean;
    errores: string[];
    advertencias: string[];
    /** Autoliquidación rectificativa en preparación o presentada (B4). */
    rectificativa: { justificanteAnterior: string } | null;
    /** Id de la fila del calendario; null si aún no existe (leer no la crea). */
    id: string | null;
  }> {
    // Una empresa no establecida en Espana no presenta modelos de la AEAT.
    await exigirEmpresaEspanola(companyId);
    const periodo = periodo303De(periodo303);
    const trimestre = periodo.endsWith('T') ? Number(periodo[0]) : null;
    const periodoFiscal = periodoFiscalDe({ ejercicio, periodo });
    const { borrador, aCompensar, cuentas, cuentaBancariaId, presentado, mensual } = await calcularBorrador303(companyId, periodoFiscal, opciones);

    // Listas de facturas del periodo (libros de IVA, por trimestre; en un mes,
    // las de ese mes), solo para consultar.
    const period = `Q${trimestre ?? Math.ceil(Number(periodo) / 3)}-${ejercicio}`;
    const delPeriodo = (f: { fecha?: unknown }) => {
      if (trimestre) return true;
      const fecha = f.fecha instanceof Date ? f.fecha.toISOString() : String(f.fecha ?? '');
      return fecha.slice(0, 7) === `${ejercicio}-${periodo}`;
    };
    const [emitidas, recibidas] = await Promise.all([
      taxDocumentsService.obtenerLibroIVAEmitidas(companyId, period),
      taxDocumentsService.obtenerLibroIVARecibidas(companyId, period),
    ]);

    const casillas = casillasGuardadas303(borrador.datos) as CasillasGuardadas;

    // Solo lee (B6): la fila se guarda al recalcular en Impuestos o al presentar.
    const modelo = await prisma.modeloImpuesto.findUnique({ where: { companyId_codigo_ejercicio_periodo: { companyId, codigo: '303', ejercicio, periodo } } });
    const estado = modelo?.estado ?? 'vigente';

    // Presentado: el borrador ya sale de las casillas guardadas (las mismas
    // que el fichero), con su aviso.
    const avisos = [...borrador.advertencias];
    const oficiales = borrador.casillas;
    const tipoDeclaracion: string = borrador.tipoDeclaracion;
    if (estado === 'presentado' && !presentado) {
      avisos.push('Modelo presentado antes de guardar sus casillas oficiales: se muestran las de las facturas de hoy.');
    } else if (modelo?.origen === 'manual-mixto' && estado !== 'presentado') {
      avisos.push('Casillas editadas a mano en Impuestos: aquí se ven las calculadas de las facturas; el fichero de Impuestos lleva las del último cálculo.');
    }

    return {
      id: modelo?.id ?? null,
      ejercicio,
      trimestre,
      periodo,
      mensual,
      ivaRepercutido: { total: oficiales['27'] ?? 0, desglose: emitidas.facturas.filter(delPeriodo) },
      ivaSoportado: { total: oficiales['45'] ?? 0, desglose: recibidas.facturas.filter(delPeriodo) },
      resultado: oficiales['71'] ?? 0,
      estado,
      origen: modelo?.origen ?? null,
      casillas: estado === 'presentado' && modelo?.casillas ? (modelo.casillas as CasillasGuardadas) : casillas,
      rectificativa: borrador.rectificativa,
      casillas303: casillasPantalla303({ casillas: oficiales }),
      tipoDeclaracion,
      tiposDeclaracion: borrador.tiposDeclaracion.map((codigo) => ({ codigo, nombre: NOMBRE_TIPO_DECLARACION_303[codigo] })),
      aCompensar,
      cuentas,
      cuentaBancariaId,
      sinActividad: borrador.sinActividad,
      errores: borrador.errores,
      advertencias: avisos,
    };
  }

  /**
   * MODELO 111: RETENCIONES E INGRESOS A CUENTA
   *
   * Solo adapta a la pantalla el calculo del modulo Impuestos (fuente unica,
   * services/nominas/fiscal.ts): trabajo [01]-[06] con las nominas por fecha de
   * pago y perceptores distintos, y profesionales [07]-[09]. Guarda en
   * ModeloImpuesto lo mismo que "Recalcular importes" (casillas oficiales y
   * datos del TXT), para que las dos pantallas no se pisen. Un modelo presentado,
   * omitido o editado a mano no se recalcula.
   */
  async generarModelo111(
    companyId: string,
    ejercicio: number,
    periodoEntrada: number | string,
    userId?: string
  ): Promise<{
    ejercicio: number;
    /** 1-4 en los trimestrales; null en un periodo mensual. */
    trimestre: number | null;
    /** '1T'..'4T' o '01'..'12'. */
    periodo: string;
    casillas: any;
    casillasOficiales: CasillasGuardadas;
    totalBase: number;
    totalRetenido: number;
    estado: string;
    estadoTexto: string | null;
    origen: string | null;
    avisos: string[];
    /** Formulario oficial (identificacion, casillas 01-30, liquidacion): misma declaracion que el fichero. */
    formulario: FormularioRetenciones;
    id: string;
    /** Retencion de abonos que no cabe en [09] (decision P1): se pasa de la 4751 a la 4709. null si no hay. */
    excesoAbonos: number | null;
    /** Asiento de ese traspaso, si ya esta hecho. */
    traspaso4709: Traspaso4709 | null;
  }> {
    const periodo = periodoRetenciones(periodoEntrada);
    // La misma funcion que el fichero: presentado = lo guardado; sin presentar, calculado (no se guarda).
    const r = await declaracionRetenciones(companyId, '111', ejercicio, periodo);
    const datos = r.datos as DatosModelo111;
    const oficiales = casillasAGuardadas('111', r.declaracion.casillas);
    const pantalla = casillasPantalla111(oficiales, datos.actividadesPorTipo);
    const formulario = formularioDeclaracion(r.declaracion);
    const avisos = [...(datos.avisos ?? []), ...avisosFuente(r, 'las nóminas o las facturas')];
    const exceso = await excesoConTraspaso(companyId, '111', ejercicio, periodo, datos.excesoAbonos);
    if (exceso.aviso) avisos.push(exceso.aviso);

    return {
      id: r.fila.id,
      ejercicio,
      trimestre: trimestreDe(periodo),
      periodo,
      casillas: pantalla.casillas,
      casillasOficiales: oficiales,
      totalBase: pantalla.totalBase,
      totalRetenido: pantalla.totalRetenido,
      estado: r.fila.estado,
      estadoTexto: (await estadosEnRectificacion(companyId, '111', ejercicio)).get(periodo) ?? null,
      origen: r.fila.origen,
      avisos,
      formulario,
      excesoAbonos: exceso.excesoAbonos,
      traspaso4709: exceso.traspaso4709,
    };
  }

  /**
   * MODELO 115: RETENCIONES POR ALQUILERES (TRIMESTRAL)
   *
   * Lo calcula el modulo Impuestos (calcularModelo115: facturas de gasto de
   * ALQUILER con retencion, con el criterio fiscal de las facturas de gasto),
   * como el 111. Se guarda en ModeloImpuesto con las mismas reglas: un modelo
   * presentado, omitido o editado a mano no se recalcula.
   */
  async generarModelo115(
    companyId: string,
    ejercicio: number,
    periodoEntrada: number | string,
    userId?: string
  ): Promise<{
    id: string;
    ejercicio: number;
    /** 1-4 en los trimestrales; null en un periodo mensual. */
    trimestre: number | null;
    /** '1T'..'4T' o '01'..'12'. */
    periodo: string;
    baseImponible: number;
    porcentajeRetencion: number;
    retencion: number;
    operaciones: number;
    estado: string;
    estadoTexto: string | null;
    casillas: Record<string, number>;
    casillasOficiales: CasillasGuardadas;
    perceptores: NonNullable<DatosModelo115['perceptores']>;
    avisos: string[];
    /** Formulario oficial (identificacion, casillas 01-05, liquidacion): misma declaracion que el fichero. */
    formulario: FormularioRetenciones;
    /** Retencion de abonos que no cabe en [03] (decision P1): se pasa de la 4751 a la 4709. null si no hay. */
    excesoAbonos: number | null;
    /** Asiento de ese traspaso, si ya esta hecho. */
    traspaso4709: Traspaso4709 | null;
  }> {
    const periodo = periodoRetenciones(periodoEntrada);
    // La misma funcion que el fichero: presentado = lo guardado; sin presentar, calculado (no se guarda).
    const r = await declaracionRetenciones(companyId, '115', ejercicio, periodo);
    const datos = r.datos as DatosModelo115;
    const c = r.declaracion.casillas;
    const avisos: string[] = [...(datos.avisos ?? []), ...avisosFuente(r, 'las facturas')];
    const exceso = await excesoConTraspaso(companyId, '115', ejercicio, periodo, datos.excesoAbonos);
    if (exceso.aviso) avisos.push(exceso.aviso);

    const baseImponible = c['02'];
    const retencion = c['03'];
    return {
      id: r.fila.id,
      ejercicio,
      trimestre: trimestreDe(periodo),
      periodo,
      baseImponible,
      porcentajeRetencion: baseImponible ? Math.round((retencion / baseImponible) * 10000) / 100 : 0,
      retencion,
      operaciones: (datos.perceptores ?? []).reduce((a, p) => a + p.facturas, 0),
      estado: r.fila.estado,
      estadoTexto: (await estadosEnRectificacion(companyId, '115', ejercicio)).get(periodo) ?? null,
      casillas: { '01': c['01'], '02': baseImponible, '03': retencion, '04': c['04'], '05': c['05'] },
      casillasOficiales: casillasAGuardadas('115', c),
      perceptores: datos.perceptores ?? [],
      avisos,
      formulario: formularioDeclaracion(r.declaracion),
      excesoAbonos: exceso.excesoAbonos,
      traspaso4709: exceso.traspaso4709,
    };
  }

  /**
   * Resumen anual del 115 (los datos del modelo 180): los cuatro trimestres
   * y el total por arrendador. Solo lee: no escribe en ModeloImpuesto.
   */
  async resumenAnual115(
    companyId: string,
    ejercicio: number
  ): Promise<{
    ejercicio: number;
    totalBase: number;
    totalRetenido: number;
    estado: 'vigente';
    casillas: Record<string, never>;
    desgloseTrimestral: Array<{ numero: number; base: number; cuota: number; operaciones: number; estado: string; estadoTexto: string | null }>;
    arrendadores: NonNullable<DatosModelo115['perceptores']>;
    avisos: string[];
  }> {
    await exigirEmpresaEspanola(companyId);
    const guardados = await prisma.modeloImpuesto.findMany({
      where: { companyId, codigo: '115', ejercicio, periodo: { in: ['1T', '2T', '3T', '4T'] } },
      select: { periodo: true, estado: true },
    });
    const desgloseTrimestral = [];
    const enRectificacion = await estadosEnRectificacion(companyId, '115', ejercicio);
    for (const numero of [1, 2, 3, 4]) {
      const d = await calcularModelo115(companyId, periodoFiscal(ejercicio, `${numero}T`));
      desgloseTrimestral.push({
        numero,
        base: d.baseRetenciones,
        cuota: d.retenciones,
        operaciones: (d.perceptores ?? []).reduce((a, p) => a + p.facturas, 0),
        estado: guardados.find((g) => g.periodo === `${numero}T`)?.estado ?? 'vigente',
        estadoTexto: enRectificacion.get(`${numero}T`) ?? null,
      });
    }
    const anual = await calcularModelo115(companyId, periodoFiscal(ejercicio, '0A'));
    const avisos: string[] = [];
    if (!anual.perceptores?.length) avisos.push(`No hay facturas de alquiler con retención en ${ejercicio}.`);
    return {
      ejercicio,
      totalBase: anual.baseRetenciones,
      totalRetenido: anual.retenciones,
      estado: 'vigente',
      casillas: {},
      desgloseTrimestral,
      arrendadores: anual.perceptores ?? [],
      avisos,
    };
  }

  /**
   * MODELO 190: RESUMEN ANUAL DE RETENCIONES
   *
   * Totales del 190 con la misma fuente que el 111 (services/nominas/fiscal.ts):
   * un registro por perceptor (nominas por fecha de pago y profesionales), y el
   * desglose de los cuatro 111 del ano. Guarda en ModeloImpuesto lo mismo que el
   * modulo Impuestos (solo totales: el detalle por perceptor lleva datos de los
   * trabajadores y esta en /nominas/190, con nominas:read). Un modelo
   * presentado, omitido o editado a mano no se recalcula.
   */
  async generarModelo190(
    companyId: string,
    ejercicio: number,
    userId?: string
  ): Promise<{
    ejercicio: number;
    totalBase: number;
    totalRetenido: number;
    estado: string;
    estadoTexto: string | null;
    casillas: any;
    desgloseTrimestral: any[];
    avisos: string[];
    cuadre111: { total: number; coincide: boolean };
    /** Casillas del resumen del formulario oficial (las del registro de declarante del fichero). */
    formulario: { titulo: string; fuente: string; resumen: Array<{ casilla: string; rotulo: string; valor: number; signo: 'N' | ' '; tipo: 'numero' | 'importe' }> };
    /** Aviso fijo si el ejercicio no tiene aun diseño de registro publicado (se usa el ultimo). */
    avisoDiseno: string | null;
    id: string | null;
  }> {
    // Una empresa no establecida en Espana no presenta modelos de la AEAT.
    await exigirEmpresaEspanola(companyId);
    const calculo = await calcularCasillasModelo(companyId, '190', ejercicio, '0A');
    const oficiales = calculo.casillas as CasillasGuardadas;
    const datos = calculo.datos as { avisos: string[]; cuadre111: { total: number; coincide: boolean }; desglose: Modelo190['desglose'] };

    // Por trimestres, con la misma fuente que los totales del 190 (sin el resumen
    // antiguo, que el 190 no incluye): las filas suman lo mismo que el total.
    const cent = (n: number) => Math.round(n * 100);
    const desgloseTrimestral = datos.desglose.map((d) => {
      const t = d.trabajo;
      const a = d.actividades;
      const p = casillasPantalla111(
        {
          '01_perceptores_trabajo': t.perceptoresDinerarios,
          '02_percepciones_trabajo': t.percepcionesDinerarias,
          '03_retenciones_trabajo': t.retencionesDinerarias,
          '04_perceptores_especie': t.perceptoresEspecie,
          '05_percepciones_especie': t.percepcionesEspecie,
          '06_ingresos_a_cuenta': t.ingresosACuenta,
          '07_perceptores_actividades': a.perceptores,
          '08_percepciones_actividades': a.percepciones,
          '09_retenciones_actividades': a.retenciones,
          '28_total_retenciones': (cent(t.retencionesDinerarias) + cent(t.ingresosACuenta) + cent(a.retenciones)) / 100,
        },
        a.porTipo,
      );
      return { numero: Number(d.periodo[0]), retenciones: p.casillas.retenciones, base: p.totalBase, cuota: p.totalRetenido };
    });

    // Solo lee (B6): la fila se guarda al recalcular en Impuestos o al presentar.
    const modelo = await prisma.modeloImpuesto.findUnique({ where: { companyId_codigo_ejercicio_periodo: { companyId, codigo: '190', ejercicio, periodo: '0A' } } });
    const manda = modelo && (modelo.estado === 'presentado' || modelo.estado === 'omitido' || modelo.origen === 'manual-mixto');

    // Lo guardado manda (presentado o editado a mano); si es de antes (otro formato), el calculo.
    const guardadas = (manda ? (modelo?.casillas as CasillasGuardadas | null) : null) ?? {};
    const base = 'retenciones_ingresos_cuenta' in guardadas ? guardadas : oficiales;
    const v = (k: string) => Number(base[k] ?? 0) || 0;
    const casillas = {
      '01': v('num_percepciones'),
      '02': v('importe_percepciones'),
      '03': v('retenciones_ingresos_cuenta'),
      resumen: {
        numeroPercepciones: v('num_percepciones'),
        perceptores: v('num_perceptores'),
        importePercepciones: v('importe_percepciones'),
        importeRetenciones: v('retenciones_ingresos_cuenta'),
      },
    };

    return {
      id: modelo?.id ?? null,
      ejercicio,
      totalBase: v('importe_percepciones'),
      totalRetenido: v('retenciones_ingresos_cuenta'),
      estado: modelo?.estado ?? 'vigente',
      estadoTexto: (await estadosEnRectificacion(companyId, '190', ejercicio)).get('0A') ?? null,
      casillas,
      desgloseTrimestral,
      avisos: datos.avisos ?? [],
      cuadre111: { total: datos.cuadre111.total, coincide: datos.cuadre111.coincide },
      formulario: {
        titulo: DR190.formulario.titulo,
        fuente: DR190.fuente,
        // Mismos rotulos y casillas que el registro de tipo 1 del fichero.
        resumen: (DR190.formulario.resumen ?? []).map((r) => {
          const valor = r.campo === 'numeroPercepciones' ? v('num_percepciones') : r.campo === 'importePercepciones' ? v('importe_percepciones') : v('retenciones_ingresos_cuenta');
          return { casilla: r.casilla, rotulo: r.rotulo, valor, signo: r.campo === 'importePercepciones' && valor < 0 ? ('N' as const) : (' ' as const), tipo: r.campo === 'numeroPercepciones' ? ('numero' as const) : ('importe' as const) };
        }),
      },
      avisoDiseno: avisoDiseno190(ejercicio),
    };
  }

  /**
   * Obtener modelo por código, ejercicio y período
   */
  async obtenerModelo(
    companyId: string,
    codigo: string,
    ejercicio: number,
    periodo: string
  ): Promise<any> {
    const modelo = await prisma.modeloImpuesto.findUnique({
      where: {
        companyId_codigo_ejercicio_periodo: {
          companyId,
          codigo,
          ejercicio,
          periodo,
        },
      },
    });

    if (!modelo) {
      throw notFound(
        `Modelo ${codigo} para período ${periodo}/${ejercicio} no encontrado`
      );
    }

    return modelo;
  }

  /**
   * Listar modelos por empresa, código y ejercicio
   */
  async listarModelos(
    companyId: string,
    codigo?: string,
    ejercicio?: number
  ): Promise<any[]> {
    const where: any = { companyId };

    if (codigo) where.codigo = codigo;
    if (ejercicio) where.ejercicio = ejercicio;

    return await prisma.modeloImpuesto.findMany({
      where,
      orderBy: [{ ejercicio: 'desc' }, { periodo: 'desc' }],
    });
  }
}

export const taxModelsService = new TaxModelsService();
