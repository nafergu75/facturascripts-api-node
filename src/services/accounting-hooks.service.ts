/**
 * ACCOUNTING HOOKS SERVICE - Enganches Automáticos
 *
 * Responsabilidades:
 * - Detectar eventos de facturas (creación, confirmación, modificación)
 * - Disparar contabilización automática
 * - Manejar reversiones y recálculos
 * - Fail-safe: errores no rompen operaciones de facturas
 * - Validación pre-contabilización
 */

import { badRequest } from '../utils/http-errors';
import { registrarAuditoria } from './auditoria.service';
import { AccountingEngineController } from '../controllers/accounting-engine.controller';
import { prisma } from '../config/database';

export class AccountingHooksService {
  private controller = new AccountingEngineController();

  /**
   * Validación previa: verificar que factura tiene datos mínimos para contabilizar
   */
  private async validateInvoiceForAccounting(companyId: string, invoiceId: string): Promise<void> {
    const factura = await prisma.incomeInvoice.findUnique({
      where: { id: invoiceId },
      include: { customer: true, lineas: true },
    });

    if (!factura) {
      throw badRequest('Factura no encontrada para validación contable.');
    }

    // Validaciones mínimas
    if (!factura.customer) {
      throw badRequest('Factura sin cliente asignado. No se puede contabilizar.');
    }

    if (!factura.lineas || factura.lineas.length === 0) {
      throw badRequest('Factura sin líneas. No se puede contabilizar.');
    }

    if (!factura.baseTotal || factura.baseTotal <= 0) {
      throw badRequest('Factura con base 0 o negativa. No se puede contabilizar.');
    }

    if (!factura.fechaEmision) {
      throw badRequest('Factura sin fecha de emisión. No se puede contabilizar.');
    }

    // Validar que plan contable está inicializado
    const chartExists = await prisma.chartOfAccounts.findFirst({
      where: { companyId, esBasePGC: true },
    });

    if (!chartExists) {
      throw badRequest('Plan contable no inicializado. Solicita a tu admin que lo haga.');
    }
  }

  /**
   * ENGANCHE: Al confirmar factura de ingreso
   *
   * Llamado desde: income-invoices.controller.confirmInvoice()
   * DESPUÉS de que la factura se haya guardado con estado PENDING/CONFIRMED
   *
   * Comportamiento:
   * - Valida datos mínimos
   * - Llama contabilizarFacturaIngreso en modo AUTO
   * - Registra auditoría
   * - Fail-safe: no falla la confirmación si hay error en contabilización
   */
  async onIncomeInvoiceConfirmed(companyId: string, invoiceId: string): Promise<void> {
    try {
      // Validación previa
      await this.validateInvoiceForAccounting(companyId, invoiceId);

      // Contabilizar automáticamente
      const resultado = await this.controller.contabilizarFacturaIngreso(
        companyId,
        invoiceId,
        'AUTO'
      );

      // Auditoría de éxito
      await registrarAuditoria({
        userId: 'SYSTEM',
        companyId,
        action: 'HOOK_INCOME_INVOICE_CONFIRMED_SUCCESS',
        resourceType: 'IncomeInvoice',
        resourceId: invoiceId,
        meta: {
          journalEntryId: resultado.journalEntryId,
          estado: resultado.estado,
          advertencias: resultado.advertencias,
        },
      });

      // Log si hay advertencias
      if (resultado.advertencias && resultado.advertencias.length > 0) {
        console.warn(
          `⚠️ Advertencias en contabilización de factura ${invoiceId}:`,
          resultado.advertencias
        );
      }
    } catch (err) {
      // FAIL-SAFE: No falla la confirmación si hay error en contabilización
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(
        `❌ Error en contabilización automática de factura ${invoiceId}: ${errorMsg}`
      );

      // Auditoría del error (para que contable lo vea después)
      try {
        await registrarAuditoria({
          userId: 'SYSTEM',
          companyId,
          action: 'HOOK_INCOME_INVOICE_CONFIRMED_ERROR',
          resourceType: 'IncomeInvoice',
          resourceId: invoiceId,
          meta: {
            error: errorMsg,
            timestamp: new Date().toISOString(),
            nota: 'Factura confirmada pero contabilización falló. Requiere revisión manual.',
          },
        });
      } catch (auditErr) {
        console.error('Error registrando auditoría del error:', auditErr);
      }

      // NO relanzamos el error - la confirmación de factura es exitosa
      // El usuario ve la factura confirmada, pero debe revisar si hay alerta de contabilización
    }
  }

  /**
   * ENGANCHE: Al confirmar factura de gasto.
   * Dispara contabilizarFacturaGasto → asiento 600/472/4751/400 en DRAFT.
   */
  async onExpenseInvoiceConfirmed(companyId: string, invoiceId: string): Promise<void> {
    try {
      // Contabilizar
      const resultado = await this.controller.contabilizarFacturaGasto(
        companyId,
        invoiceId,
        'AUTO'
      );

      await registrarAuditoria({
        userId: 'SYSTEM',
        companyId,
        action: 'HOOK_EXPENSE_INVOICE_CONFIRMED_SUCCESS',
        resourceType: 'ExpenseInvoice',
        resourceId: invoiceId,
        meta: {
          journalEntryId: resultado.journalEntryId,
          estado: resultado.estado,
        },
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`❌ Error contabilizando gasto ${invoiceId}: ${errorMsg}`);

      try {
        await registrarAuditoria({
          userId: 'SYSTEM',
          companyId,
          action: 'HOOK_EXPENSE_INVOICE_CONFIRMED_ERROR',
          resourceType: 'ExpenseInvoice',
          resourceId: invoiceId,
          meta: { error: errorMsg },
        });
      } catch (auditErr) {
        console.error('Error registrando auditoría:', auditErr);
      }
    }
  }

  /**
   * ENGANCHE: Al modificar factura ya contabilizada
   *
   * Llamado desde: invoice update endpoint
   * CUANDO: factura que ya fue contabilizada es modificada (base, IVA, etc.)
   *
   * Comportamiento:
   * 1. Busca asiento anterior (POSTED o PENDING_REVIEW)
   * 2. Si existe:
   *    - Recalcula (crea reversión + nuevo asiento)
   *    - Regenera asiento con valores nuevos
   * 3. Auditoría completa
   *
   * Fail-safe: errores se loguean pero no rompen la modificación de factura
   */
  async onInvoiceModified(
    companyId: string,
    invoiceId: string,
    invoiceType: 'INCOME' | 'EXPENSE'
  ): Promise<void> {
    try {
      // Buscar asiento anterior (vigente)
      const asientoAnterior = await prisma.journalEntry.findFirst({
        where: {
          companyId,
          invoiceId,
          estado: { in: ['POSTED', 'PENDING_REVIEW'] },
        },
      });

      // Si hay asiento anterior, recalcular
      if (asientoAnterior) {
        console.log(
          `📝 Recalculando asiento ${asientoAnterior.id} por modificación de factura ${invoiceId}`
        );

        // Recalcular (crea reversión + nuevo asiento)
        const resultadoRecalculo = await this.controller.recalcularAsiento(
          companyId,
          asientoAnterior.id,
          'SYSTEM'
        );

        // Regenerar asiento con datos de factura modificada
        if (invoiceType === 'INCOME') {
          await this.onIncomeInvoiceConfirmed(companyId, invoiceId);
        } else {
          await this.onExpenseInvoiceConfirmed(companyId, invoiceId);
        }

        await registrarAuditoria({
          userId: 'SYSTEM',
          companyId,
          action: 'HOOK_INVOICE_MODIFIED_RECALCULATED',
          resourceType: 'JournalEntry',
          resourceId: asientoAnterior.id,
          meta: {
            invoiceType,
            asientoReversado: resultadoRecalculo.asientoReversado,
            asientoNuevo: resultadoRecalculo.asientoNuevo,
          },
        });

        console.log(
          `✅ Asiento recalculado: reversión ${resultadoRecalculo.asientoReversado}, nuevo ${resultadoRecalculo.asientoNuevo}`
        );
      } else {
        // No hay asiento anterior contabilizado - factura aún no contabilizada
        console.log(`ℹ️ Factura ${invoiceId} no tiene asiento contabilizado aún.`);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`❌ Error recalculando asiento para factura ${invoiceId}: ${errorMsg}`);

      try {
        await registrarAuditoria({
          userId: 'SYSTEM',
          companyId,
          action: 'HOOK_INVOICE_MODIFIED_ERROR',
          resourceType: 'IncomeInvoice',
          resourceId: invoiceId,
          meta: {
            error: errorMsg,
            nota: 'Factura modificada pero recalculación de asiento falló.',
          },
        });
      } catch (auditErr) {
        console.error('Error registrando auditoría del error:', auditErr);
      }

      // NO relanzamos el error - la modificación debe ser exitosa
    }
  }

  /**
   * Reversión de asiento: crear asiento con líneas opuestas
   *
   * Cuando se detecta que un asiento debe ser anulado:
   * - Se crea nuevo asiento con líneas opuestas (debe↔haber)
   * - El estado de este nuevo asiento es POSTED inmediatamente (reversión es definitiva)
   * - El asiento original se marca como REVERSED
   *
   * Private: utilizado internamente por recalculateJournalEntry
   */
  private async reversarAsiento(journalEntryId: string): Promise<string> {
    const asiento = await prisma.journalEntry.findUnique({
      where: { id: journalEntryId },
      include: { lineas: true },
    });

    if (!asiento) {
      throw badRequest(`Asiento ${journalEntryId} no encontrado para reversal.`);
    }

    // Crear asiento de reversión en una transacción
    const resultado = await prisma.$transaction(async (tx) => {
      // Crear asiento con líneas opuestas
      const asientoReversal = await tx.journalEntry.create({
        data: {
          companyId: asiento.companyId,
          fecha: new Date(),
          numeroAsiento: `${asiento.numeroAsiento}-REV`,
          descripcion: `Reversión: ${asiento.descripcion}`,
          origen: asiento.origen,
          estado: 'POSTED', // Reversión es inmediata
          invoiceId: asiento.invoiceId,
          invoiceType: asiento.invoiceType,
          lineas: {
            create: asiento.lineas.map((linea) => ({
              accountCode: linea.accountCode,
              accountName: linea.accountName,
              debe: linea.haber || 0,
              haber: linea.debe || 0,
              referencia: `REV-${linea.referencia || 'sin-ref'}`,
              companyId: asiento.companyId,
            })),
          },
        },
      });

      // Marcar original como REVERSED
      await tx.journalEntry.update({
        where: { id: journalEntryId },
        data: { estado: 'REVERSED' },
      });

      return asientoReversal.id;
    });

    return resultado;
  }
}

export const accountingHooksService = new AccountingHooksService();
