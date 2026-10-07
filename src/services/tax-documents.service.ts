/**
 * TAX DOCUMENTS SERVICE - Documentos y Libros de Hacienda
 *
 * Responsabilidades:
 * - Libros de IVA (facturas emitidas/recibidas)
 * - Resúmenes para Hacienda (modelo 303, 190, etc.)
 * - Agregaciones fiscales
 * - Exportación de datos
 */

import { badRequest } from '../utils/http-errors';
import { prisma } from '../config/database';
import { esTipoOperacion, REGLA_OPERACION } from '../domain/tipo-operacion.model';

/** Casillas de informacion adicional del 303 que salen del libro de emitidas. */
export interface InformativasLibro303 {
  /** [59] entregas intracomunitarias de bienes y servicios */
  '59': number;
  /** [60] exportaciones y asimiladas */
  '60': number;
  /** [120] no sujetas por reglas de localizacion */
  '120': number;
  /** [122] inversion del sujeto pasivo */
  '122': number;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Reparto de los apuntes del libro de emitidas para el 303: la base que
 * devenga IVA (las filas sin tipo, anteriores a esta funcion, como siempre, y
 * las NACIONAL) y las bases de las casillas [59], [60], [120] y [122] segun el
 * tipo de operacion guardado en el libro. Puro.
 */
export function repartoLibroEmitidas(
  filas: Array<{ baseImponible: number; tipoOperacion?: string | null; causaExencion?: string | null; nifTercero: string }>,
): { baseDevengada: number; informativas: InformativasLibro303 } {
  let baseDevengada = 0;
  const informativas: InformativasLibro303 = { '59': 0, '60': 0, '120': 0, '122': 0 };
  for (const f of filas) {
    const tipo = esTipoOperacion(f.tipoOperacion) ? f.tipoOperacion : null;
    if (!tipo || tipo === 'NACIONAL') {
      baseDevengada += f.baseImponible || 0;
      continue;
    }
    // El libro no guarda el pais: sale del prefijo del NIF-IVA (FR..., DE...).
    const c = REGLA_OPERACION[tipo].casilla303({ cliente: { pais: null, nifCif: f.nifTercero }, causaExencion: f.causaExencion });
    if (c === '59' || c === '60' || c === '120' || c === '122') informativas[c] = round2(informativas[c] + (f.baseImponible || 0));
  }
  return { baseDevengada, informativas };
}

export class TaxDocumentsService {
  /**
   * Obtener Libro de IVA - Facturas Emitidas
   *
   * Agrupa VATBook con tipoLibro=EMITIDAS por período
   */
  async obtenerLibroIVAEmitidas(
    companyId: string,
    period: string
  ): Promise<{
    periodo: string;
    facturas: any[];
    totalBases: number;
    totalCuotas: number;
    /** Base de las filas que devengan IVA (sin tipo, como siempre, o NACIONAL). */
    baseDevengada: number;
    /** Bases de [59], [60], [120] y [122] por el tipo de operacion de cada fila. */
    informativas: InformativasLibro303;
  }> {
    // Parse period: Q1-2026, Q2-2026, etc.
    const match = period.match(/^Q(\d)-(\d{4})$/);
    if (!match) {
      throw badRequest(
        'Format: Q1-2026, Q2-2026, Q3-2026, Q4-2026'
      );
    }

    const numTrimestre = parseInt(match[1]);
    const ano = parseInt(match[2]);

    if (numTrimestre < 1 || numTrimestre > 4) {
      throw badRequest('Trimestre debe ser 1-4');
    }

    const startDate = new Date(ano, (numTrimestre - 1) * 3, 1);
    const endDate = new Date(ano, numTrimestre * 3, 0);

    const facturas = await prisma.vATBook.findMany({
      where: {
        companyId,
        tipoLibro: 'EMITIDAS',
        fechaFactura: { gte: startDate, lte: endDate },
      },
      orderBy: { fechaFactura: 'asc' },
    });

    const totalBases = facturas.reduce(
      (s, f) => s + (f.baseImponible || 0),
      0
    );
    const totalCuotas = facturas.reduce((s, f) => s + (f.cuotaIva || 0), 0);
    const { baseDevengada, informativas } = repartoLibroEmitidas(facturas);

    return {
      periodo: period,
      facturas: facturas.map((f) => ({
        fecha: f.fechaFactura,
        numero: f.numeroFactura,
        nif: f.nifTercero,
        nombre: f.nombreTercero,
        base: f.baseImponible,
        tipoIva: f.tipoIva,
        cuota: f.cuotaIva,
        // Tipo de operacion y causa de exencion (null en los apuntes anteriores).
        tipoOperacion: f.tipoOperacion ?? null,
        causaExencion: f.causaExencion ?? null,
      })),
      totalBases,
      totalCuotas,
      baseDevengada,
      informativas,
    };
  }

  /**
   * Obtener Libro de IVA - Facturas Recibidas
   */
  async obtenerLibroIVARecibidas(
    companyId: string,
    period: string
  ): Promise<{
    periodo: string;
    facturas: any[];
    totalBases: number;
    totalCuotas: number;
  }> {
    const match = period.match(/^Q(\d)-(\d{4})$/);
    if (!match) {
      throw badRequest(
        'Format: Q1-2026, Q2-2026, Q3-2026, Q4-2026'
      );
    }

    const numTrimestre = parseInt(match[1]);
    const ano = parseInt(match[2]);

    if (numTrimestre < 1 || numTrimestre > 4) {
      throw badRequest('Trimestre debe ser 1-4');
    }

    const startDate = new Date(ano, (numTrimestre - 1) * 3, 1);
    const endDate = new Date(ano, numTrimestre * 3, 0);

    const facturas = await prisma.vATBook.findMany({
      where: {
        companyId,
        tipoLibro: 'RECIBIDAS',
        fechaFactura: { gte: startDate, lte: endDate },
      },
      orderBy: { fechaFactura: 'asc' },
    });

    const totalBases = facturas.reduce(
      (s, f) => s + (f.baseImponible || 0),
      0
    );
    const totalCuotas = facturas.reduce((s, f) => s + (f.cuotaIva || 0), 0);

    return {
      periodo: period,
      facturas: facturas.map((f) => ({
        fecha: f.fechaFactura,
        numero: f.numeroFactura,
        nif: f.nifTercero,
        nombre: f.nombreTercero,
        base: f.baseImponible,
        tipoIva: f.tipoIva,
        cuota: f.cuotaIva,
      })),
      totalBases,
      totalCuotas,
    };
  }

  /**
   * Resumen 303 (IVA Trimestral)
   *
   * Calcula:
   * - Totales de IVA emitidas (repercutido)
   * - Totales de IVA recibidas (soportado)
   * - Cuota a ingresar/deuda
   */
  async obtenerResumen303(
    companyId: string,
    period: string
  ): Promise<{
    periodo: string;
    emitidas: { totalBases: number; totalCuotas: number };
    recibidas: { totalBases: number; totalCuotas: number };
    cuotaAIngresar: number;
    deuda: boolean;
  }> {
    const emitidas = await this.obtenerLibroIVAEmitidas(
      companyId,
      period
    );
    const recibidas = await this.obtenerLibroIVARecibidas(
      companyId,
      period
    );

    const cuotaAIngresar = emitidas.totalCuotas - recibidas.totalCuotas;

    return {
      periodo: period,
      emitidas: {
        totalBases: emitidas.totalBases,
        totalCuotas: emitidas.totalCuotas,
      },
      recibidas: {
        totalBases: recibidas.totalBases,
        totalCuotas: recibidas.totalCuotas,
      },
      cuotaAIngresar,
      deuda: cuotaAIngresar > 0,
    };
  }

  /**
   * Resumen 190 (Retenciones)
   *
   * Agrupa retenciones por tercero, tipo, año
   */
  async obtenerResumen190(
    companyId: string,
    year: number
  ): Promise<{
    ano: number;
    retenciones: any[];
    totalBases: number;
    totalRetenciones: number;
  }> {
    const retenciones = await prisma.retentionBook.findMany({
      where: {
        companyId,
        ano: year,
      },
      orderBy: { nifTercero: 'asc' },
    });

    const totalBases = retenciones.reduce(
      (s, r) => s + (r.baseImponible || 0),
      0
    );
    const totalRetenciones = retenciones.reduce(
      (s, r) => s + (r.cuotaRetencion || 0),
      0
    );

    return {
      ano: year,
      retenciones: retenciones.map((r) => ({
        nif: r.nifTercero,
        nombre: r.nombreTercero,
        tipo: r.tipoRetencionNombre,
        porcentaje: r.porcentajeRetencion,
        base: r.baseImponible,
        cuota: r.cuotaRetencion,
      })),
      totalBases,
      totalRetenciones,
    };
  }

  /**
   * Exportar Modelo 303
   *
   * Genera borrador de modelo 303 en formato TXT (AEAT) o JSON
   */
  async exportarModelo303(
    companyId: string,
    period: string,
    format: 'txt' | 'json'
  ): Promise<string | any> {
    const resumen = await this.obtenerResumen303(
      companyId,
      period
    );

    if (format === 'json') {
      return resumen;
    }

    // Formato TXT simplificado para AEAT
    let txt = `MODELO 303 - ${period}\n`;
    txt += `================================================\n`;
    txt += `Empresa: ${companyId}\n`;
    txt += `Período: ${period}\n`;
    txt += `\n`;
    txt += `IVA REPERCUTIDO (Facturas Emitidas):\n`;
    txt += `  Base Imponible: ${resumen.emitidas.totalBases.toFixed(
      2
    )} €\n`;
    txt += `  Cuota IVA: ${resumen.emitidas.totalCuotas.toFixed(2)} €\n`;
    txt += `\n`;
    txt += `IVA SOPORTADO (Facturas Recibidas):\n`;
    txt += `  Base Imponible: ${resumen.recibidas.totalBases.toFixed(
      2
    )} €\n`;
    txt += `  Cuota IVA: ${resumen.recibidas.totalCuotas.toFixed(2)} €\n`;
    txt += `\n`;
    txt += `RESULTADO:\n`;
    txt += `  Cuota a ${
      resumen.deuda ? 'INGRESAR' : 'DEVOLVER'
    }: ${Math.abs(resumen.cuotaAIngresar).toFixed(2)} €\n`;
    txt += `================================================\n`;
    txt += `NOTA: Este es un borrador. Verificar con asesor antes de presentar.\n`;

    return txt;
  }
}

export const taxDocumentsService = new TaxDocumentsService();
