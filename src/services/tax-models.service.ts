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
import { taxDocumentsService } from './tax-documents.service';
import { reportsService } from './reports.service';
import { registrarAuditoria } from './auditoria.service';
import { esEmpresaEspanolaFiscal, MENSAJE_SIN_MODELOS } from './impuestosCalculo.service';
import { esTipoOperacion } from '../domain/tipo-operacion.model';
import {
  generarCasillas303,
  generarCasillas111,
  generarCasillas200,
  generarCasillas347,
  generarCasillas115,
  generarCasillas390,
  generarCasillas190,
  ModeloFiscalAuditoria,
} from '../utils/aeat-models';

/** 400 si la empresa no esta establecida en Espana (no presenta modelos de la AEAT). */
async function exigirEmpresaEspanola(companyId: string): Promise<void> {
  if (!(await esEmpresaEspanolaFiscal(companyId))) throw badRequest(MENSAJE_SIN_MODELOS);
}

export class TaxModelsService {
  /**
   * MODELO 303: IVA TRIMESTRAL
   *
   * Genera modelo 303 a partir de:
   * - IVA repercutido (facturas emitidas)
   * - IVA soportado (facturas recibidas)
   * - Casillas completas AEAT 303
   */
  async generarModelo303(
    companyId: string,
    ejercicio: number,
    trimestre: number,
    userId?: string
  ): Promise<{
    ejercicio: number;
    trimestre: number;
    ivaRepercutido: { total: number; desglose: any[] };
    ivaSoportado: { total: number; desglose: any[] };
    resultado: number;
    estado: string;
    casillas: any;
    id: string;
  }> {
    // Una empresa no establecida en Espana no presenta modelos de la AEAT.
    await exigirEmpresaEspanola(companyId);
    // Validar trimestre
    if (trimestre < 1 || trimestre > 4) {
      throw badRequest('Trimestre debe estar entre 1 y 4');
    }

    const period = `Q${trimestre}-${ejercicio}`;

    // Obtener datos de libros de IVA
    const emitidas = await taxDocumentsService.obtenerLibroIVAEmitidas(
      companyId,
      period
    );
    const recibidas = await taxDocumentsService.obtenerLibroIVARecibidas(
      companyId,
      period
    );

    // Calcular totales. La base repercutida es la de las ventas que devengan IVA:
    // las del libro sin tipo de operacion (anteriores) como siempre y las
    // NACIONAL; las exentas, intracomunitarias, exportaciones, no sujetas e ISP
    // van a la informacion adicional ([59], [60], [120], [122]).
    const ivaRepercutido = emitidas.totalCuotas;
    const ivaSoportado = recibidas.totalCuotas;
    const resultado = ivaRepercutido - ivaSoportado;
    const baseRepercutido = emitidas.baseDevengada;

    // Generar casillas AEAT completas
    const casillas: Record<string, any> = generarCasillas303({
      baseRepercutido,
      cuotaRepercutido: ivaRepercutido,
      baseSoportado: recibidas.totalBases,
      cuotaSoportado: ivaSoportado,
      resultado,
    });
    const DESCRIPCION_INFORMATIVA: Record<keyof typeof emitidas.informativas, string> = {
      '59': 'Entregas intracomunitarias de bienes y servicios',
      '60': 'Exportaciones y operaciones asimiladas',
      '120': 'Operaciones no sujetas por reglas de localización',
      '122': 'Operaciones sujetas con inversión del sujeto pasivo',
    };
    for (const [numero, valor] of Object.entries(emitidas.informativas) as Array<[keyof typeof emitidas.informativas, number]>) {
      // Solo si hay importe: los libros anteriores (sin tipo) no cambian.
      if (valor !== 0) casillas[numero] = { numero, descripcion: DESCRIPCION_INFORMATIVA[numero], valor, tipo: 'informativa' };
    }

    // Auditoría
    const auditoria: ModeloFiscalAuditoria = {
      generadoPor: userId || 'SYSTEM',
      generadoEn: new Date().toISOString(),
      origen: 'autorrelleno',
      version: `${ejercicio}.Q${trimestre}`,
    };

    // Buscar modelo existente
    let modelo = await prisma.modeloImpuesto.findUnique({
      where: {
        companyId_codigo_ejercicio_periodo: {
          companyId,
          codigo: '303',
          ejercicio,
          periodo: `${trimestre}T`,
        },
      },
    });

    // Crear o actualizar modelo
    if (!modelo) {
      modelo = await prisma.modeloImpuesto.create({
        data: {
          companyId,
          codigo: '303',
          ejercicio,
          periodo: `${trimestre}T`,
          estado: 'vigente',
          casillas,
          datos: {
            ivaRepercutido,
            ivaSoportado,
            resultado,
            periodoDescription: `Q${trimestre}-${ejercicio}`,
            baseRepercutido,
            baseSoportado: recibidas.totalBases,
            auditoria,
          },
          origen: 'autorrelleno',
        },
      });
    } else if (modelo.estado !== 'presentado' && modelo.estado !== 'omitido') {
      // Un modelo presentado u omitido no se recalcula: lo guardado tiene que
      // seguir siendo lo que se presento, aunque luego cambie una factura.
      modelo = await prisma.modeloImpuesto.update({
        where: { id: modelo.id },
        data: {
          casillas,
          datos: {
            ivaRepercutido,
            ivaSoportado,
            resultado,
            periodoDescription: `Q${trimestre}-${ejercicio}`,
            baseRepercutido,
            baseSoportado: recibidas.totalBases,
            auditoria,
          },
          origen: 'autorrelleno',
        },
      });
    }

    // Registrar auditoría
    await registrarAuditoria({
      userId: userId || 'SYSTEM',
      companyId,
      action: 'GENERAR_MODELO_303',
      resourceType: 'modelo_fiscal',
      resourceId: `303-${ejercicio}-${trimestre}T`,
    });

    return {
      id: modelo.id,
      ejercicio,
      trimestre,
      ivaRepercutido: {
        total: ivaRepercutido,
        desglose: emitidas.facturas,
      },
      ivaSoportado: {
        total: ivaSoportado,
        desglose: recibidas.facturas,
      },
      resultado,
      estado: modelo.estado,
      casillas,
    };
  }

  /**
   * MODELO 111: RETENCIONES E INGRESOS A CUENTA
   *
   * Genera modelo 111 a partir de:
   * - Retenciones practicadas en facturas de ingreso (IRPF de clientes)
   * - Retenciones practicadas en facturas de gasto (IRPF a proveedores)
   * - Casillas completas AEAT 111
   */
  async generarModelo111(
    companyId: string,
    ejercicio: number,
    trimestre: number,
    userId?: string
  ): Promise<{
    ejercicio: number;
    trimestre: number;
    casillas: any;
    totalBase: number;
    totalRetenido: number;
    estado: string;
    id: string;
  }> {
    // Una empresa no establecida en Espana no presenta modelos de la AEAT.
    await exigirEmpresaEspanola(companyId);
    // Validar trimestre
    if (trimestre < 1 || trimestre > 4) {
      throw badRequest('Trimestre debe estar entre 1 y 4');
    }

    // Obtener retenciones del período
    // Calcular meses del trimestre (Q1: 1-3, Q2: 4-6, Q3: 7-9, Q4: 10-12)
    const startMonth = (trimestre - 1) * 3 + 1;
    const endMonth = trimestre * 3;

    const retenciones = await prisma.retentionBook.findMany({
      where: {
        companyId,
        ano: ejercicio,
        mes: { gte: startMonth, lte: endMonth },
      },
      orderBy: { mes: 'asc' },
    });

    // Agrupar por tipo y porcentaje de retención
    const casillasMap = new Map<string, {
      tipo: string;
      porcentaje: number;
      base: number;
      cuota: number;
      count: number;
    }>();

    let totalBase = 0;
    let totalRetenido = 0;

    for (const ret of retenciones) {
      const key = `${ret.tipoRetencionNombre}-${ret.porcentajeRetencion}`;

      if (!casillasMap.has(key)) {
        casillasMap.set(key, {
          tipo: ret.tipoRetencionNombre || 'IRPF',
          porcentaje: ret.porcentajeRetencion,
          base: 0,
          cuota: 0,
          count: 0,
        });
      }

      const entrada = casillasMap.get(key)!;
      entrada.base += ret.baseImponible || 0;
      entrada.cuota += ret.cuotaRetencion || 0;
      entrada.count += 1;

      totalBase += ret.baseImponible || 0;
      totalRetenido += ret.cuotaRetencion || 0;
    }

    // Convertir a array de casillas
    const retencionesProcesadas = Array.from(casillasMap.values()).map((c) => ({
      tipo: c.tipo,
      porcentaje: c.porcentaje,
      base: c.base,
      cuota: c.cuota,
      operaciones: c.count,
    }));

    // Generar casillas AEAT completas
    const casillas = generarCasillas111({
      retenciones: retencionesProcesadas,
      totalBase,
      totalRetenido,
    });

    // Auditoría
    const auditoria: ModeloFiscalAuditoria = {
      generadoPor: userId || 'SYSTEM',
      generadoEn: new Date().toISOString(),
      origen: 'autorrelleno',
      version: `${ejercicio}.Q${trimestre}`,
    };

    // Buscar modelo existente
    let modelo = await prisma.modeloImpuesto.findUnique({
      where: {
        companyId_codigo_ejercicio_periodo: {
          companyId,
          codigo: '111',
          ejercicio,
          periodo: `${trimestre}T`,
        },
      },
    });

    // Crear o actualizar modelo
    if (!modelo) {
      modelo = await prisma.modeloImpuesto.create({
        data: {
          companyId,
          codigo: '111',
          ejercicio,
          periodo: `${trimestre}T`,
          estado: 'vigente',
          casillas,
          datos: {
            totalBase,
            totalRetenido,
            periodoDescription: `Q${trimestre}-${ejercicio}`,
            retenciones: retencionesProcesadas,
            auditoria,
          },
          origen: 'autorrelleno',
        },
      });
    } else if (modelo.estado !== 'presentado' && modelo.estado !== 'omitido') {
      // Un modelo presentado u omitido no se recalcula: lo guardado tiene que
      // seguir siendo lo que se presento, aunque luego cambie una factura.
      modelo = await prisma.modeloImpuesto.update({
        where: { id: modelo.id },
        data: {
          casillas,
          datos: {
            totalBase,
            totalRetenido,
            periodoDescription: `Q${trimestre}-${ejercicio}`,
            retenciones: retencionesProcesadas,
            auditoria,
          },
          origen: 'autorrelleno',
        },
      });
    }

    // Registrar auditoría
    await registrarAuditoria({
      userId: userId || 'SYSTEM',
      companyId,
      action: 'GENERAR_MODELO_111',
      resourceType: 'modelo_fiscal',
      resourceId: `111-${ejercicio}-${trimestre}T`,
    });

    return {
      id: modelo.id,
      ejercicio,
      trimestre,
      casillas,
      totalBase,
      totalRetenido,
      estado: modelo.estado,
    };
  }

  /**
   * MODELO 200: IMPUESTO DE SOCIEDADES (MVP)
   *
   * Genera modelo 200 a partir del:
   * - Resultado contable del P&L (anual)
   * - Aplicación de tipo impositivo
   * - Casillas completas AEAT 200
   *
   * MVP: Base imponible = resultado contable (sin ajustes complejos)
   */
  async generarModelo200(
    companyId: string,
    ejercicio: number,
    userId?: string
  ): Promise<{
    ejercicio: number;
    resultadoContable: number;
    baseImponible: number;
    tipoImpositivo: number;
    cuotaIntegra: number;
    deducciones: number;
    cuotaLiquida: number;
    estado: string;
    casillas: any;
    id: string;
  }> {
    // Una empresa no establecida en Espana no presenta modelos de la AEAT.
    await exigirEmpresaEspanola(companyId);
    // Obtener resultado contable del P&L anual
    const from = `${ejercicio}-01-01`;
    const to = `${ejercicio}-12-31`;
    const pyl = await reportsService.obtenerPyG(companyId, from, to);

    const resultadoContable = pyl.resultadoExplotacion || 0;
    const baseImponible = Math.max(0, resultadoContable); // No hay base negativa en MVP
    const tipoImpositivo = 25; // 25% por defecto (tipo general en España)
    const cuotaIntegra = baseImponible * (tipoImpositivo / 100);
    const deducciones = 0; // MVP: sin deducciones
    const cuotaLiquida = Math.max(0, cuotaIntegra - deducciones);

    // Generar casillas AEAT completas
    const casillas = generarCasillas200({
      resultadoContable,
      baseImponible,
      tipoImpositivo,
      cuotaIntegra,
      deducciones,
      cuotaLiquida,
      retencionesPracticadas: 0, // MVP
      anticiposPagados: 0, // MVP
    });

    // Auditoría
    const auditoria: ModeloFiscalAuditoria = {
      generadoPor: userId || 'SYSTEM',
      generadoEn: new Date().toISOString(),
      origen: 'autorrelleno',
      version: `${ejercicio}.0A`,
    };

    // Buscar modelo existente
    let modelo = await prisma.modeloImpuesto.findUnique({
      where: {
        companyId_codigo_ejercicio_periodo: {
          companyId,
          codigo: '200',
          ejercicio,
          periodo: '0A', // Anual
        },
      },
    });

    // Crear o actualizar modelo
    if (!modelo) {
      modelo = await prisma.modeloImpuesto.create({
        data: {
          companyId,
          codigo: '200',
          ejercicio,
          periodo: '0A',
          estado: 'vigente',
          casillas,
          datos: {
            resultadoContable,
            baseImponible,
            tipoImpositivo,
            cuotaIntegra,
            deducciones,
            cuotaLiquida,
            periodoDescription: `${ejercicio}`,
            auditoria,
          },
          origen: 'autorrelleno',
        },
      });
    } else if (modelo.estado !== 'presentado' && modelo.estado !== 'omitido') {
      // Un modelo presentado u omitido no se recalcula: lo guardado tiene que
      // seguir siendo lo que se presento, aunque luego cambie una factura.
      modelo = await prisma.modeloImpuesto.update({
        where: { id: modelo.id },
        data: {
          casillas,
          datos: {
            resultadoContable,
            baseImponible,
            tipoImpositivo,
            cuotaIntegra,
            deducciones,
            cuotaLiquida,
            periodoDescription: `${ejercicio}`,
            auditoria,
          },
          origen: 'autorrelleno',
        },
      });
    }

    // Registrar auditoría
    await registrarAuditoria({
      userId: userId || 'SYSTEM',
      companyId,
      action: 'GENERAR_MODELO_200',
      resourceType: 'modelo_fiscal',
      resourceId: `200-${ejercicio}-0A`,
    });

    return {
      id: modelo.id,
      ejercicio,
      resultadoContable,
      baseImponible,
      tipoImpositivo,
      cuotaIntegra,
      deducciones,
      cuotaLiquida,
      estado: modelo.estado,
      casillas,
    };
  }

  /**
   * MODELO 347: OPERACIONES CON TERCEROS (ANUAL)
   *
   * Genera modelo 347 a partir de:
   * - Facturas de ingreso emitidas (clientes)
   * - Facturas de gasto recibidas (proveedores)
   * - Operaciones superiores a 3.000,06€ en el ejercicio
   */
  async generarModelo347(
    companyId: string,
    ejercicio: number,
    userId?: string
  ): Promise<{
    ejercicio: number;
    terceros: any[];
    totalTerceros: number;
    totalOperaciones: number;
    estado: string;
    casillas: any;
    id: string;
  }> {
    // Una empresa no establecida en Espana no presenta modelos de la AEAT.
    await exigirEmpresaEspanola(companyId);
    // Obtener clientes (facturas de ingreso)
    const clientesFacturas = await prisma.incomeInvoice.findMany({
      where: {
        companyId,
        estadoDocumento: 'FINAL',
        fechaEmision: {
          gte: `${ejercicio}-01-01`,
          lte: `${ejercicio}-12-31`,
        },
      },
      include: {
        customer: true,
      },
    });

    // Obtener proveedores (facturas de gasto)
    const proveedoresFacturas = await prisma.expenseInvoice.findMany({
      where: {
        companyId,
        fechaEmision: {
          gte: `${ejercicio}-01-01`,
          lte: `${ejercicio}-12-31`,
        },
      },
      include: {
        supplier: true,
      },
    });

    // Agrupar terceros y filtrar por importe mínimo (3.000,06€)
    const tercerosMapa = new Map<string, {
      nif: string;
      nombre: string;
      tipoTercero: 'cliente' | 'proveedor';
      totalOperaciones: number;
      operaciones: any[];
    }>();

    // Se declara el tercero cuyo total ANUAL con IVA supera 3.005,06 €. Antes el
    // umbral era 3.000,06 y se aplicaba factura a factura: tres facturas de
    // 2.000 € al mismo cliente no salian.
    const MINIMO_347 = 3005.06;
    const importe = (f: { baseTotal: number; ivaTotal: number }) => Math.round((Number(f.baseTotal) + Number(f.ivaTotal)) * 100) / 100;
    // Las operaciones con el extranjero no van en el 347 (las intracomunitarias, en el 349).
    const espanol = (pais: string | null | undefined) => !pais || pais.toUpperCase() === 'ES';

    // Solo las ventas interiores: las facturas con tipo de operacion fuera del 347
    // (intracomunitarias, exportaciones, servicios a extranjeros, empresa
    // extranjera) no entran; las anteriores (sin tipo), como siempre.
    const TIPOS_347 = ['NACIONAL', 'EXENTA', 'ISP_NACIONAL'];
    const declarable = (tipo: string | null) => !esTipoOperacion(tipo) || TIPOS_347.includes(tipo);

    // Procesar clientes
    for (const factura of clientesFacturas) {
      if (!factura.customer.nifCif || !espanol(factura.customer.pais) || !declarable(factura.tipoOperacion)) continue;

      const key = `cliente-${factura.customer.nifCif}`;
      if (!tercerosMapa.has(key)) {
        tercerosMapa.set(key, {
          nif: factura.customer.nifCif,
          nombre: factura.customer.nombreFiscal || 'Sin nombre',
          tipoTercero: 'cliente',
          totalOperaciones: 0,
          operaciones: [],
        });
      }

      const tercero = tercerosMapa.get(key)!;
      tercero.totalOperaciones += importe(factura);
      tercero.operaciones.push({
        tipoOperacion: 'venta',
        importe: importe(factura),
        id: factura.id,
      });
    }

    // Procesar proveedores
    for (const factura of proveedoresFacturas) {
      if (!factura.supplier.nifCif || !espanol(factura.supplier.pais)) continue;

      const key = `proveedor-${factura.supplier.nifCif}`;
      if (!tercerosMapa.has(key)) {
        tercerosMapa.set(key, {
          nif: factura.supplier.nifCif,
          nombre: factura.supplier.nombreFiscal || 'Sin nombre',
          tipoTercero: 'proveedor',
          totalOperaciones: 0,
          operaciones: [],
        });
      }

      const tercero = tercerosMapa.get(key)!;
      tercero.totalOperaciones += importe(factura);
      tercero.operaciones.push({
        tipoOperacion: 'compra',
        importe: importe(factura),
        id: factura.id,
      });
    }

    const terceros = Array.from(tercerosMapa.values())
      .map((t) => ({ ...t, totalOperaciones: Math.round(t.totalOperaciones * 100) / 100 }))
      .filter((t) => t.totalOperaciones > MINIMO_347);
    const totalOperaciones = terceros.reduce((sum, t) => sum + t.totalOperaciones, 0);

    // Generar casillas AEAT
    const casillas = generarCasillas347({
      terceros: terceros.map((t) => ({
        ...t,
        operaciones: t.operaciones.map((o) => ({
          tipoOperacion: o.tipoOperacion,
          importe: o.importe,
        })),
      })),
      totalTerceros: totalOperaciones,
    });

    // Auditoría
    const auditoria: ModeloFiscalAuditoria = {
      generadoPor: userId || 'SYSTEM',
      generadoEn: new Date().toISOString(),
      origen: 'autorrelleno',
      version: `${ejercicio}.0A`,
    };

    // Buscar modelo existente
    let modelo = await prisma.modeloImpuesto.findUnique({
      where: {
        companyId_codigo_ejercicio_periodo: {
          companyId,
          codigo: '347',
          ejercicio,
          periodo: '0A',
        },
      },
    });

    // Crear o actualizar modelo
    if (!modelo) {
      modelo = await prisma.modeloImpuesto.create({
        data: {
          companyId,
          codigo: '347',
          ejercicio,
          periodo: '0A',
          estado: 'vigente',
          casillas,
          datos: {
            terceros: terceros.map((t) => ({
              nif: t.nif,
              nombre: t.nombre,
              tipoTercero: t.tipoTercero,
              totalOperaciones: t.totalOperaciones,
            })),
            totalTerceros: terceros.length,
            totalImportes: totalOperaciones,
            periodoDescription: `${ejercicio}`,
            auditoria,
          },
          origen: 'autorrelleno',
        },
      });
    } else if (modelo.estado !== 'presentado' && modelo.estado !== 'omitido') {
      // Un modelo presentado u omitido no se recalcula: lo guardado tiene que
      // seguir siendo lo que se presento, aunque luego cambie una factura.
      modelo = await prisma.modeloImpuesto.update({
        where: { id: modelo.id },
        data: {
          casillas,
          datos: {
            terceros: terceros.map((t) => ({
              nif: t.nif,
              nombre: t.nombre,
              tipoTercero: t.tipoTercero,
              totalOperaciones: t.totalOperaciones,
            })),
            totalTerceros: terceros.length,
            totalImportes: totalOperaciones,
            periodoDescription: `${ejercicio}`,
            auditoria,
          },
          origen: 'autorrelleno',
        },
      });
    }

    // Registrar auditoría
    await registrarAuditoria({
      userId: userId || 'SYSTEM',
      companyId,
      action: 'GENERAR_MODELO_347',
      resourceType: 'modelo_fiscal',
      resourceId: `347-${ejercicio}-0A`,
    });

    return {
      id: modelo.id,
      ejercicio,
      terceros,
      totalTerceros: terceros.length,
      totalOperaciones,
      estado: modelo.estado,
      casillas,
    };
  }

  /**
   * MODELO 115: ARRENDAMIENTOS LOCALES (TRIMESTRAL)
   *
   * Genera modelo 115 a partir de:
   * - Facturas de arrendamiento sujetas a retención IRPF
   * - Cuentas contables: 621 (arrendamiento), 721 (otros arrendamientos)
   */
  async generarModelo115(
    companyId: string,
    ejercicio: number,
    trimestre: number,
    userId?: string
  ): Promise<{
    ejercicio: number;
    trimestre: number;
    baseImponible: number;
    porcentajeRetencion: number;
    retencion: number;
    operaciones: number;
    estado: string;
    casillas: any;
    id: string;
  }> {
    // Una empresa no establecida en Espana no presenta modelos de la AEAT.
    await exigirEmpresaEspanola(companyId);
    // Validar trimestre
    if (trimestre < 1 || trimestre > 4) {
      throw badRequest('Trimestre debe estar entre 1 y 4');
    }

    // Calcular meses del trimestre
    const startMonth = (trimestre - 1) * 3 + 1;
    const endMonth = trimestre * 3;
    const startDate = `${ejercicio}-${String(startMonth).padStart(2, '0')}-01`;
    const endDate = `${ejercicio}-${String(endMonth).padStart(2, '0')}-${endMonth === 2 ? '28' : '31'}`;

    // Obtener facturas de arrendamiento del período
    // Se buscan en las facturas de gasto con conceptos de arrendamiento
    const arrendamientos = await prisma.expenseInvoice.findMany({
      where: {
        companyId,
        fechaEmision: {
          gte: startDate,
          lte: endDate,
        },
        // Nota: En un MVP, se filtran por nombre del proveedor o concepto
        // Ideally, debería haber una categoría/tipo de factura específica
      },
      include: {
        supplier: true,
      },
    });

    // Filtrar solo arrendamientos (esto es una simplificación MVP)
    // En producción, se consultaría una tabla de categorías o conceptos
    const sonArrendamientos = arrendamientos.filter(
      (f) =>
        f.observaciones?.toLowerCase().includes('arrendamiento') ||
        f.observaciones?.toLowerCase().includes('alquiler') ||
        f.supplier.nombreFiscal?.toLowerCase().includes('alquiler')
    );

    // Calcular totales
    let baseImponible = 0;
    let totalRetencion = 0;
    const desgloseArrendamientos = [];

    for (const arr of sonArrendamientos) {
      baseImponible += arr.totalFactura;
      totalRetencion += arr.retencionTotal || 0;

      desgloseArrendamientos.push({
        nifArrendador: arr.supplier.nifCif || '',
        nombreArrendador: arr.supplier.nombreFiscal || 'Sin nombre',
        base: arr.totalFactura,
        retencion: arr.retencionTotal || 0,
        concepto: arr.observaciones || 'Arrendamiento',
      });
    }

    // Porcentaje efectivo de retención (típicamente 15% en arrendamientos)
    const porcentajeRetencion = baseImponible > 0 ? (totalRetencion / baseImponible) * 100 : 0;

    // Generar casillas AEAT
    const casillas = generarCasillas115({
      baseImponible,
      porcentajeRetencion: Math.round(porcentajeRetencion * 100) / 100,
      retencion: totalRetencion,
      operaciones: sonArrendamientos.length,
      trimestre,
      desgloseArrendamientos,
    });

    // Auditoría
    const auditoria: ModeloFiscalAuditoria = {
      generadoPor: userId || 'SYSTEM',
      generadoEn: new Date().toISOString(),
      origen: 'autorrelleno',
      version: `${ejercicio}.Q${trimestre}`,
    };

    // Buscar modelo existente
    let modelo = await prisma.modeloImpuesto.findUnique({
      where: {
        companyId_codigo_ejercicio_periodo: {
          companyId,
          codigo: '115',
          ejercicio,
          periodo: `${trimestre}T`,
        },
      },
    });

    // Crear o actualizar modelo
    if (!modelo) {
      modelo = await prisma.modeloImpuesto.create({
        data: {
          companyId,
          codigo: '115',
          ejercicio,
          periodo: `${trimestre}T`,
          estado: 'vigente',
          casillas,
          datos: {
            baseImponible,
            porcentajeRetencion,
            retencion: totalRetencion,
            operaciones: sonArrendamientos.length,
            periodoDescription: `Q${trimestre}-${ejercicio}`,
            desgloseArrendamientos,
            auditoria,
          },
          origen: 'autorrelleno',
        },
      });
    } else if (modelo.estado !== 'presentado' && modelo.estado !== 'omitido') {
      // Un modelo presentado u omitido no se recalcula: lo guardado tiene que
      // seguir siendo lo que se presento, aunque luego cambie una factura.
      modelo = await prisma.modeloImpuesto.update({
        where: { id: modelo.id },
        data: {
          casillas,
          datos: {
            baseImponible,
            porcentajeRetencion,
            retencion: totalRetencion,
            operaciones: sonArrendamientos.length,
            periodoDescription: `Q${trimestre}-${ejercicio}`,
            desgloseArrendamientos,
            auditoria,
          },
          origen: 'autorrelleno',
        },
      });
    }

    // Registrar auditoría
    await registrarAuditoria({
      userId: userId || 'SYSTEM',
      companyId,
      action: 'GENERAR_MODELO_115',
      resourceType: 'modelo_fiscal',
      resourceId: `115-${ejercicio}-${trimestre}T`,
    });

    return {
      id: modelo.id,
      ejercicio,
      trimestre,
      baseImponible,
      porcentajeRetencion,
      retencion: totalRetencion,
      operaciones: sonArrendamientos.length,
      estado: modelo.estado,
      casillas,
    };
  }

  /**
   * MODELO 390: RESUMEN ANUAL DE IVA
   *
   * Genera modelo 390 a partir de:
   * - Agregación de 4 trimestres de modelo 303
   * - Totales anuales de IVA repercutido/soportado
   * - Resultado anual
   */
  async generarModelo390(
    companyId: string,
    ejercicio: number,
    userId?: string
  ): Promise<{
    ejercicio: number;
    totalRepercutido: number;
    totalSoportado: number;
    resultadoAnual: number;
    estado: string;
    casillas: any;
    desgloseTrimestral: any[];
    id: string;
  }> {
    // Una empresa no establecida en Espana no presenta modelos de la AEAT.
    await exigirEmpresaEspanola(companyId);
    // Obtener los 4 trimestres de modelo 303
    const modelos303 = await prisma.modeloImpuesto.findMany({
      where: {
        companyId,
        codigo: '303',
        ejercicio,
      },
      orderBy: { periodo: 'asc' },
    });

    if (modelos303.length === 0) {
      throw badRequest('No se encontraron modelos 303 para este ejercicio. Genera primero los trimestres.');
    }

    // Agregar datos de los 4 trimestres
    let totalBaseRepercutido = 0;
    let totalCuotaRepercutido = 0;
    let totalBaseSoportado = 0;
    let totalCuotaSoportado = 0;
    let resultadoAnual = 0;

    const trimestres = modelos303
      .filter((m) => m.periodo.match(/^\d+T$/))
      .slice(0, 4)
      .map((modelo) => {
        const datos = (modelo.datos as any) || {};
        const baseRep = datos.baseRepercutido || 0;
        const cuotaRep = datos.ivaRepercutido || 0;
        const baseSop = datos.baseSoportado || 0;
        const cuotaSop = datos.ivaSoportado || 0;
        const resultado = (datos.resultado || 0);

        totalBaseRepercutido += baseRep;
        totalCuotaRepercutido += cuotaRep;
        totalBaseSoportado += baseSop;
        totalCuotaSoportado += cuotaSop;
        resultadoAnual += resultado;

        const trimestre = parseInt(modelo.periodo.charAt(0));
        return {
          numero: trimestre,
          baseRepercutido: baseRep,
          cuotaRepercutido: cuotaRep,
          baseSoportado: baseSop,
          cuotaSoportado: cuotaSop,
          resultado,
        };
      });

    // Generar casillas AEAT 390
    const casillas = generarCasillas390({
      trimestres,
      totalBaseRepercutido,
      totalCuotaRepercutido,
      totalBaseSoportado,
      totalCuotaSoportado,
      resultadoAnual,
    });

    // Auditoría
    const auditoria: ModeloFiscalAuditoria = {
      generadoPor: userId || 'SYSTEM',
      generadoEn: new Date().toISOString(),
      origen: 'autorrelleno',
      version: `${ejercicio}.0A`,
    };

    // Buscar modelo existente
    let modelo = await prisma.modeloImpuesto.findUnique({
      where: {
        companyId_codigo_ejercicio_periodo: {
          companyId,
          codigo: '390',
          ejercicio,
          periodo: '0A',
        },
      },
    });

    // Crear o actualizar modelo
    if (!modelo) {
      modelo = await prisma.modeloImpuesto.create({
        data: {
          companyId,
          codigo: '390',
          ejercicio,
          periodo: '0A',
          estado: 'vigente',
          casillas,
          datos: {
            totalRepercutido: totalCuotaRepercutido,
            totalSoportado: totalCuotaSoportado,
            resultadoAnual,
            periodoDescription: `${ejercicio}`,
            desgloseTrimestral: trimestres,
            auditoria,
          },
          origen: 'autorrelleno',
        },
      });
    } else if (modelo.estado !== 'presentado' && modelo.estado !== 'omitido') {
      // Un modelo presentado u omitido no se recalcula: lo guardado tiene que
      // seguir siendo lo que se presento, aunque luego cambie una factura.
      modelo = await prisma.modeloImpuesto.update({
        where: { id: modelo.id },
        data: {
          casillas,
          datos: {
            totalRepercutido: totalCuotaRepercutido,
            totalSoportado: totalCuotaSoportado,
            resultadoAnual,
            periodoDescription: `${ejercicio}`,
            desgloseTrimestral: trimestres,
            auditoria,
          },
          origen: 'autorrelleno',
        },
      });
    }

    // Registrar auditoría
    await registrarAuditoria({
      userId: userId || 'SYSTEM',
      companyId,
      action: 'GENERAR_MODELO_390',
      resourceType: 'modelo_fiscal',
      resourceId: `390-${ejercicio}-0A`,
    });

    return {
      id: modelo.id,
      ejercicio,
      totalRepercutido: totalCuotaRepercutido,
      totalSoportado: totalCuotaSoportado,
      resultadoAnual,
      estado: modelo.estado,
      casillas,
      desgloseTrimestral: trimestres,
    };
  }

  /**
   * MODELO 190: RESUMEN ANUAL DE RETENCIONES
   *
   * Genera modelo 190 a partir de:
   * - Agregación de 4 trimestres de modelo 111
   * - Totales anuales de bases y retenciones
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
    casillas: any;
    desgloseTrimestral: any[];
    id: string;
  }> {
    // Una empresa no establecida en Espana no presenta modelos de la AEAT.
    await exigirEmpresaEspanola(companyId);
    // Obtener los 4 trimestres de modelo 111
    const modelos111 = await prisma.modeloImpuesto.findMany({
      where: {
        companyId,
        codigo: '111',
        ejercicio,
      },
      orderBy: { periodo: 'asc' },
    });

    if (modelos111.length === 0) {
      throw badRequest('No se encontraron modelos 111 para este ejercicio. Genera primero los trimestres.');
    }

    // Agregar datos de los 4 trimestres
    let totalBase = 0;
    let totalRetenido = 0;

    const trimestres = modelos111
      .filter((m) => m.periodo.match(/^\d+T$/))
      .slice(0, 4)
      .map((modelo) => {
        const datos = (modelo.datos as any) || {};
        const base = datos.totalBase || 0;
        const retenido = datos.totalRetenido || 0;
        const retenciones = datos.retenciones || [];

        totalBase += base;
        totalRetenido += retenido;

        const trimestre = parseInt(modelo.periodo.charAt(0));
        return {
          numero: trimestre,
          retenciones,
          base,
          cuota: retenido,
        };
      });

    // Generar casillas AEAT 190
    const casillas = generarCasillas190({
      trimestres,
      totalBase,
      totalRetenido,
    });

    // Auditoría
    const auditoria: ModeloFiscalAuditoria = {
      generadoPor: userId || 'SYSTEM',
      generadoEn: new Date().toISOString(),
      origen: 'autorrelleno',
      version: `${ejercicio}.0A`,
    };

    // Buscar modelo existente
    let modelo = await prisma.modeloImpuesto.findUnique({
      where: {
        companyId_codigo_ejercicio_periodo: {
          companyId,
          codigo: '190',
          ejercicio,
          periodo: '0A',
        },
      },
    });

    // Crear o actualizar modelo
    if (!modelo) {
      modelo = await prisma.modeloImpuesto.create({
        data: {
          companyId,
          codigo: '190',
          ejercicio,
          periodo: '0A',
          estado: 'vigente',
          casillas,
          datos: {
            totalBase,
            totalRetenido,
            periodoDescription: `${ejercicio}`,
            desgloseTrimestral: trimestres,
            auditoria,
          },
          origen: 'autorrelleno',
        },
      });
    } else if (modelo.estado !== 'presentado' && modelo.estado !== 'omitido') {
      // Un modelo presentado u omitido no se recalcula: lo guardado tiene que
      // seguir siendo lo que se presento, aunque luego cambie una factura.
      modelo = await prisma.modeloImpuesto.update({
        where: { id: modelo.id },
        data: {
          casillas,
          datos: {
            totalBase,
            totalRetenido,
            periodoDescription: `${ejercicio}`,
            desgloseTrimestral: trimestres,
            auditoria,
          },
          origen: 'autorrelleno',
        },
      });
    }

    // Registrar auditoría
    await registrarAuditoria({
      userId: userId || 'SYSTEM',
      companyId,
      action: 'GENERAR_MODELO_190',
      resourceType: 'modelo_fiscal',
      resourceId: `190-${ejercicio}-0A`,
    });

    return {
      id: modelo.id,
      ejercicio,
      totalBase,
      totalRetenido,
      estado: modelo.estado,
      casillas,
      desgloseTrimestral: trimestres,
    };
  }

  /**
   * Marcar modelo como PRESENTADO
   *
   * Registra el número de justificante y fecha de presentación
   * con información de auditoría completa
   */
  async marcarPresentado(
    companyId: string,
    codigo: string,
    ejercicio: number,
    periodo: string,
    justificante: { numero: string; fecha: string },
    userId?: string
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

    // Obtener auditoría preexistente
    const datosActuales = (modelo.datos as any) || {};
    const auditoria: ModeloFiscalAuditoria = datosActuales.auditoria || {
      generadoPor: 'SYSTEM',
      generadoEn: new Date().toISOString(),
      origen: 'autorrelleno',
      version: `${ejercicio}.${periodo}`,
    };

    // Actualizar auditoría con presentación
    auditoria.marcadoPresentadoPor = userId || 'SYSTEM';
    auditoria.marcadoPresentadoEn = new Date().toISOString();
    auditoria.justificante = justificante;

    const resultado = await prisma.modeloImpuesto.update({
      where: { id: modelo.id },
      data: {
        estado: 'presentado',
        datos: {
          ...datosActuales,
          justificante,
          fechaPresentacion: new Date().toISOString(),
          auditoria,
        },
      },
    });

    // Registrar auditoría
    await registrarAuditoria({
      userId: userId || 'SYSTEM',
      companyId,
      action: `MARCAR_${codigo}_PRESENTADO`,
      resourceType: 'modelo_fiscal',
      resourceId: `${codigo}-${ejercicio}-${periodo}`,
    });

    return resultado;
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
