/**
 * CONTROLADOR DEL MOTOR CONTABLE - Orquestador
 *
 * Responsabilidades:
 * - Orquestar llamadas al motor contable (AccountingEngineService)
 * - Gestionar transacciones atómicas con Prisma
 * - Validar datos (empresa, plan contable, reglas)
 * - Retornar errores claros para usuarios no-contables
 * - Registrar auditoría de todas las operaciones
 */

import { badRequest, notFound, notImplemented } from '../utils/http-errors';
import { registrarAuditoria } from '../services/auditoria.service';
import { accountingEngineService } from '../services/accounting-engine.service';
import { prisma } from '../config/database';

export class AccountingEngineController {
  /**
   * Contabilizar factura de ingreso (VENTA)
   *
   * Genera automáticamente un asiento contable con:
   * - Cliente (DEBE)
   * - Ventas (HABER)
   * - IVA repercutido (HABER)
   * - IRPF retenido (DEBE) [si aplica]
   *
   * Estado inicial: DRAFT o PENDING_REVIEW según mode
   */
  async contabilizarFacturaIngreso(
    companyId: string,
    invoiceId: string,
    mode: 'AUTO' | 'MANUAL' = 'AUTO',
  ): Promise<{
    journalEntryId: string;
    estado: 'DRAFT' | 'PENDING_REVIEW';
    advertencias?: string[];
  }> {
    try {
      // Validar empresa existe
      const empresa = await prisma.company.findUnique({
        where: { id: companyId },
      });
      if (!empresa) {
        throw badRequest('Empresa no encontrada.');
      }

      // Validar plan contable inicializado
      const chartExists = await prisma.chartOfAccounts.findFirst({
        where: { companyId, esBasePGC: true },
      });
      if (!chartExists) {
        throw badRequest(
          'El plan contable no ha sido inicializado. Solicita a tu admin que lo haga.'
        );
      }

      // Obtener factura de ingreso
      const factura = await prisma.incomeInvoice.findUnique({
        where: { id: invoiceId },
        include: { customer: true, lineas: true },
      });
      if (!factura) {
        throw notFound(`Factura de ingreso ${invoiceId} no encontrada.`);
      }

      // Validar que no esté ya contabilizada
      const entryExistente = await prisma.journalEntry.findFirst({
        where: {
          companyId,
          invoiceId,
          estado: { in: ['POSTED', 'PENDING_REVIEW', 'DRAFT'] },
        },
      });
      if (entryExistente) {
        throw badRequest(`Esta factura ya ha sido contabilizada (asiento: ${entryExistente.id}).`);
      }

      // Transacción atómica: crear asiento + líneas + VATBook + marcar factura ACCOUNTED
      const result = await prisma.$transaction(async (tx) => {
        const asiento = await accountingEngineService.contabilizarFacturaIngreso(
          companyId,
          invoiceId,
          {
            baseTotal: factura.baseTotal,
            ivaTotal: factura.ivaTotal,
            ivaRate: factura.lineas[0]?.tipoIva || 21,
            retencionTotal: factura.retencionTotal,
            retencionRate: factura.lineas[0]?.tipoRetencion || 0,
            totalFactura: factura.totalFactura,
            fechaEmision: factura.fechaEmision,
            numeroFactura: factura.numeroCompleto,
            clienteId: factura.customerId,
            clienteNif: factura.customer.nifCif,
            clienteNombre: factura.customer.nombreFiscal,
            tipoOperacion: 'NACIONAL',
          },
          tx,
        );

        // Marcar factura como contabilizada dentro de la misma transacción
        await tx.incomeInvoice.update({
          where: { id: invoiceId },
          data: { estado: 'ACCOUNTED' },
        });

        return asiento;
      });

      // Auditoría
      await registrarAuditoria({
        userId: 'SYSTEM',
        companyId,
        action: 'CONTABILIZAR_FACTURA_INGRESO_AUTO',
        resourceType: 'IncomeInvoice',
        resourceId: invoiceId,
        meta: { journalEntryId: result.asientoId, modo: mode },
      });

      return {
        journalEntryId: result.asientoId,
        estado: mode === 'AUTO' ? 'DRAFT' : 'PENDING_REVIEW',
        advertencias: [],
      };
    } catch (err) {
      if (err instanceof Error && 'statusCode' in err) {
        throw err;
      }
      throw badRequest(
        `Error contabilizando factura: ${err instanceof Error ? err.message : 'desconocido'}`
      );
    }
  }

  /**
   * Contabilizar factura de gasto (COMPRA/SERVICIO)
   *
   * Genera asiento PGC de gastos:
   * - 600/622/621/623 DEBE  (gasto según tipoGasto)
   * - 472             DEBE  (IVA soportado deducible)
   * - 4751            HABER (IRPF retenido al proveedor, deuda con AEAT — si aplica)
   * - 400             HABER (proveedor acreedor = base + IVA - retención)
   */
  async contabilizarFacturaGasto(
    companyId: string,
    invoiceId: string,
    mode: 'AUTO' | 'MANUAL' = 'AUTO',
  ): Promise<{
    journalEntryId: string;
    estado: 'DRAFT' | 'PENDING_REVIEW';
    advertencias?: string[];
  }> {
    try {
      // Validar empresa
      const empresa = await prisma.company.findUnique({ where: { id: companyId } });
      if (!empresa) throw badRequest('Empresa no encontrada.');

      // Validar plan contable inicializado
      const chartExists = await prisma.chartOfAccounts.findFirst({
        where: { companyId, esBasePGC: true },
      });
      if (!chartExists) {
        throw badRequest('El plan contable no ha sido inicializado. Solicita a tu admin que lo haga.');
      }

      // Obtener factura de gasto con proveedor
      const factura = await prisma.expenseInvoice.findUnique({
        where: { id: invoiceId },
        include: { supplier: true },
      });
      if (!factura || factura.companyId !== companyId) {
        throw notFound(`Factura de gasto ${invoiceId} no encontrada.`);
      }

      // Validar estado contabilizable
      if (!['DRAFT', 'CONFIRMED'].includes(factura.estado)) {
        throw badRequest(
          `La factura de gasto está en estado "${factura.estado}" y no puede contabilizarse. Solo se permiten DRAFT o CONFIRMED.`,
        );
      }

      // Evitar doble contabilización
      const entryExistente = await prisma.journalEntry.findFirst({
        where: {
          companyId,
          invoiceId,
          invoiceType: 'GASTO',
          estado: { in: ['POSTED', 'PENDING_REVIEW', 'DRAFT'] },
        },
      });
      if (entryExistente) {
        throw badRequest(`Esta factura de gasto ya ha sido contabilizada (asiento: ${entryExistente.id}).`);
      }

      // Transacción atómica: crear asiento + líneas + VATBook + RetentionBook + marcar factura
      const result = await prisma.$transaction(async (tx) => {
        const asiento = await accountingEngineService.contabilizarFacturaGasto(
          companyId,
          invoiceId,
          {
            baseTotal: factura.baseTotal,
            ivaTotal: factura.ivaTotal,
            ivaRate: factura.tipoIva,
            retencionTotal: factura.retencionTotal,
            retencionRate: factura.tipoRetencion,
            totalFactura: factura.totalFactura,
            fechaEmision: factura.fechaEmision,
            numeroFactura: factura.numeroCompleto,
            proveedorId: factura.supplierId,
            proveedorNif: factura.supplier.nifCif,
            proveedorNombre: factura.supplier.nombreFiscal,
            tipoGasto: factura.tipoGasto as 'COMPRA' | 'SERVICIO_PROFESIONAL' | 'ALQUILER' | 'SUMINISTROS',
          },
          tx,
        );

        await tx.expenseInvoice.update({
          where: { id: invoiceId },
          data: { estado: 'ACCOUNTED' },
        });

        return asiento;
      });

      // Auditoría
      await registrarAuditoria({
        userId: 'SYSTEM',
        companyId,
        action: 'CONTABILIZAR_FACTURA_GASTO_AUTO',
        resourceType: 'ExpenseInvoice',
        resourceId: invoiceId,
        meta: { journalEntryId: result.asientoId, modo: mode },
      });

      return {
        journalEntryId: result.asientoId,
        estado: mode === 'AUTO' ? 'DRAFT' : 'PENDING_REVIEW',
        advertencias: [],
      };
    } catch (err) {
      if (err instanceof Error && 'statusCode' in err) throw err;
      throw badRequest(`Error contabilizando gasto: ${err instanceof Error ? err.message : 'desconocido'}`);
    }
  }

  /**
   * Aprobar un asiento (PENDING_REVIEW → POSTED)
   *
   * Transiciona un asiento a estado definitivo.
   * Validaciones finales:
   * - Asiento en PENDING_REVIEW
   * - Debe = Haber
   * - Todas las cuentas existen y activas
   */
  async aprobarAsiento(
    companyId: string,
    journalEntryId: string,
    userId: string,
    observaciones?: string,
  ): Promise<{
    journalEntryId: string;
    estado: 'POSTED';
    contabilizadoEn: Date;
  }> {
    try {
      // Obtener asiento
      const asiento = await prisma.journalEntry.findFirst({
        where: { id: journalEntryId, companyId },
        include: { lineas: true },
      });

      if (!asiento) {
        throw notFound(`Asiento ${journalEntryId} no encontrado.`);
      }

      // Validar estado: los asientos AUTO se crean en DRAFT y los MANUAL en
      // PENDING_REVIEW; ambos son aprobables (mismo criterio que ajustarLineaAsiento).
      if (!['DRAFT', 'PENDING_REVIEW'].includes(asiento.estado)) {
        throw badRequest(
          `No se puede aprobar un asiento en estado ${asiento.estado}. Solo se pueden aprobar asientos en DRAFT o PENDING_REVIEW.`
        );
      }

      // Validar debe = haber
      const totalDebe = asiento.lineas.reduce((s, l) => s + (l.debe || 0), 0);
      const totalHaber = asiento.lineas.reduce((s, l) => s + (l.haber || 0), 0);
      if (Math.abs(totalDebe - totalHaber) > 0.01) {
        throw badRequest(
          `Asiento desequilibrado: debe ${totalDebe} ≠ haber ${totalHaber}. Contacta al equipo de soporte.`
        );
      }

      // Validar todas las cuentas existen y están activas
      for (const linea of asiento.lineas) {
        const cuenta = await prisma.chartOfAccounts.findFirst({
          where: {
            companyId,
            codigo: linea.accountCode,
          },
        });
        if (!cuenta) {
          throw badRequest(
            `Cuenta PGC ${linea.accountCode} no encontrada. No se puede contabilizar.`
          );
        }
        if (!cuenta.activo) {
          throw badRequest(
            `Cuenta PGC ${linea.accountCode} está inactiva. Solicita a tu asesor que la active.`
          );
        }
      }

      // Actualizar estado
      const ahora = new Date();
      const asientoActualizado = await prisma.journalEntry.update({
        where: { id: journalEntryId },
        data: {
          estado: 'POSTED',
          updatedAt: ahora,
        },
      });

      // Auditoría
      await registrarAuditoria({
        userId,
        companyId,
        action: 'APROBAR_ASIENTO',
        resourceType: 'JournalEntry',
        resourceId: journalEntryId,
        meta: { observaciones },
      });

      return {
        journalEntryId,
        estado: 'POSTED',
        contabilizadoEn: ahora,
      };
    } catch (err) {
      if (err instanceof Error && 'statusCode' in err) {
        throw err;
      }
      throw badRequest(`Error aprobando asiento: ${err instanceof Error ? err.message : ''}`);
    }
  }

  /**
   * Recalcular un asiento (si factura fue modificada)
   *
   * Flujo:
   * 1. Busca asiento anterior (POSTED o PENDING_REVIEW)
   * 2. Crea reversión (líneas opuestas, estado POSTED inmediato)
   * 3. Marca anterior como REVERSED
   * 4. Genera nuevo asiento (PENDING_REVIEW) con datos corregidos
   *
   * TODO: Completar la generación del nuevo asiento llamando a contabilizar nuevamente
   */
  async recalcularAsiento(
    companyId: string,
    journalEntryId: string,
    userId: string,
  ): Promise<{
    asientoReversado: string;
    asientoNuevo: string;
    estado: 'PENDING_REVIEW';
  }> {
    // Funcionalidad pendiente de implementar: la generación del nuevo asiento con
    // las líneas corregidas requiere recuperar los datos actualizados de la factura
    // y volver a pasar por el motor contable. Hasta que no esté completa, bloqueamos
    // la ruta para evitar crear asientos vacíos que corrompen la contabilidad.
    throw notImplemented(
      'Recalcular asiento no está disponible en esta versión. ' +
      'Para corregir un asiento, use "Ajustar línea" en el detalle del asiento.'
    );
  }

  /**
   * Obtener asiento con contexto completo
   *
   * Retorna:
   * - Asiento + líneas
   * - Factura asociada
   * - Validaciones (debe=haber, cuentas, etc.)
   * - Permisos (permitidoAprobar, permitidoAjustar)
   */
  async obtenerAsientoDetallado(
    companyId: string,
    journalEntryId: string,
  ): Promise<{
    asiento: any;
    lineas: any[];
    factura?: any;
    validaciones: {
      cuadrado: boolean;
      errores: string[];
      advertencias: string[];
    };
    permitidoAprobar: boolean;
    permitidoAjustar: boolean;
  }> {
    try {
      const asiento = await prisma.journalEntry.findFirst({
        where: { id: journalEntryId, companyId },
        include: { lineas: true },
      });

      if (!asiento) {
        throw notFound(`Asiento ${journalEntryId} no encontrado.`);
      }

      // Obtener factura asociada buscando en la tabla correcta según invoiceType
      let factura: any = null;
      if (asiento.invoiceId) {
        if (asiento.invoiceType === 'GASTO' || asiento.origen === 'FACTURA_GASTO') {
          factura = await prisma.expenseInvoice.findUnique({
            where: { id: asiento.invoiceId },
            include: { supplier: true },
          });
        } else {
          factura = await prisma.incomeInvoice.findUnique({
            where: { id: asiento.invoiceId },
            include: { customer: true },
          });
        }
      }

      // Validar debe = haber
      const totalDebe = asiento.lineas.reduce((s: number, l: any) => s + (l.debe || 0), 0);
      const totalHaber = asiento.lineas.reduce((s: number, l: any) => s + (l.haber || 0), 0);
      const cuadrado = Math.abs(totalDebe - totalHaber) <= 0.01;

      const errores: string[] = [];
      if (!cuadrado) {
        errores.push(
          `Asiento desequilibrado: debe ${totalDebe} ≠ haber ${totalHaber}`
        );
      }

      return {
        asiento,
        lineas: asiento.lineas,
        factura,
        validaciones: {
          cuadrado,
          errores,
          advertencias: [],
        },
        permitidoAprobar: asiento.estado === 'PENDING_REVIEW',
        permitidoAjustar: ['DRAFT', 'PENDING_REVIEW'].includes(asiento.estado),
      };
    } catch (err) {
      if (err instanceof Error && 'statusCode' in err) {
        throw err;
      }
      throw badRequest(`Error obteniendo asiento: ${err instanceof Error ? err.message : ''}`);
    }
  }

  /**
   * Listar asientos con filtros
   *
   * Filtros:
   * - estado: DRAFT, PENDING_REVIEW, POSTED, REVERSED
   * - desde/hasta: rango de fechas
   * - origen: INCOME_INVOICE, EXPENSE_INVOICE, etc.
   */
  async listarAsientos(
    companyId: string,
    filtros: {
      estado?: string;
      desde?: string;
      hasta?: string;
      origen?: string;
    },
  ): Promise<any[]> {
    try {
      const where: any = { companyId };

      if (filtros.estado) {
        where.estado = filtros.estado;
      }
      if (filtros.origen) {
        where.origen = filtros.origen;
      }
      if (filtros.desde || filtros.hasta) {
        where.fecha = {};
        if (filtros.desde) {
          where.fecha.gte = new Date(filtros.desde);
        }
        if (filtros.hasta) {
          where.fecha.lte = new Date(filtros.hasta);
        }
      }

      return prisma.journalEntry.findMany({
        where,
        include: { lineas: true },
        orderBy: { fecha: 'desc' },
      });
    } catch (err) {
      throw badRequest(`Error listando asientos: ${err instanceof Error ? err.message : ''}`);
    }
  }

  /**
   * Ajustar línea de asiento (cambiar cuenta, debe/haber)
   *
   * Restricciones:
   * - Solo si asiento en DRAFT o PENDING_REVIEW
   * - Después de ajuste, debe = haber (validación)
   * - Auditoría del cambio
   */
  async ajustarLineaAsiento(
    companyId: string,
    journalEntryId: string,
    lineId: string,
    cambios: { accountCode?: string; debe?: number; haber?: number },
    userId: string,
  ): Promise<{
    lineaActualizada: any;
    asientoValidado: boolean;
  }> {
    try {
      // Obtener asiento
      const asiento = await prisma.journalEntry.findFirst({
        where: { id: journalEntryId, companyId },
        include: { lineas: true },
      });

      if (!asiento) {
        throw notFound(`Asiento ${journalEntryId} no encontrado.`);
      }

      // Validar estado
      if (!['DRAFT', 'PENDING_REVIEW'].includes(asiento.estado)) {
        throw badRequest(
          `No se puede ajustar un asiento en estado ${asiento.estado}. Solo se pueden ajustar asientos en DRAFT o PENDING_REVIEW.`
        );
      }

      // Actualizar línea
      const lineaActualizada = await prisma.journalEntryLine.update({
        where: { id: lineId },
        data: cambios,
      });

      // Validar debe = haber después de ajuste
      const lineasActualizadas = await prisma.journalEntryLine.findMany({
        where: { entryId: journalEntryId },
      });
      const totalDebe = lineasActualizadas.reduce((s, l) => s + (l.debe || 0), 0);
      const totalHaber = lineasActualizadas.reduce((s, l) => s + (l.haber || 0), 0);
      const cuadrado = Math.abs(totalDebe - totalHaber) <= 0.01;

      if (!cuadrado) {
        throw badRequest(
          `Ajuste desequilibra el asiento: debe ${totalDebe} ≠ haber ${totalHaber}`
        );
      }

      // Auditoría
      await registrarAuditoria({
        userId,
        companyId,
        action: 'AJUSTAR_LINEA_ASIENTO',
        resourceType: 'JournalEntryLine',
        resourceId: lineId,
        meta: { cambios },
      });

      return {
        lineaActualizada,
        asientoValidado: cuadrado,
      };
    } catch (err) {
      if (err instanceof Error && 'statusCode' in err) {
        throw err;
      }
      throw badRequest(`Error ajustando línea: ${err instanceof Error ? err.message : ''}`);
    }
  }
}

export const accountingEngineController = new AccountingEngineController();
