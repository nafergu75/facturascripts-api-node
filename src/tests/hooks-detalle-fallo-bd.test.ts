/**
 * Enganches que contabilizan al confirmar: ante un fallo de la base de datos,
 * el log y la auditoria guardan el detalle tecnico de Prisma, no el texto ya
 * traducido para la persona («La base de datos ha tardado demasiado...»). Las
 * compras lo hacen igual que las ventas.
 */
jest.mock('../config/database', () => ({
  prisma: { expenseInvoice: { findUnique: jest.fn(async () => ({ id: 'g1', numeroCompleto: 'G-1' })) } },
}));
const auditoria: Array<{ action: string; meta?: Record<string, unknown> }> = [];
jest.mock('../services/auditoria.service', () => ({
  registrarAuditoria: jest.fn(async (log: { action: string; meta?: Record<string, unknown> }) => {
    auditoria.push(log);
  }),
}));
jest.mock('../config/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { Prisma } from '@prisma/client';
import { AccountingEngineController, QUE_HACER_CONTABILIZAR } from '../controllers/accounting-engine.controller';
import { AccountingHooksService } from '../services/accounting-hooks.service';
import { errorFalloBD } from '../utils/errores-bd';

const TEXTO_PRISMA = 'Invalid `prisma.journalEntry.create()` invocation: Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction.';

it('compra: la auditoria HOOK_EXPENSE_INVOICE_CONFIRMED_ERROR guarda el texto de Prisma, no el traducido', async () => {
  const caducada = new Prisma.PrismaClientKnownRequestError(TEXTO_PRISMA, { code: 'P2028', clientVersion: Prisma.prismaVersion.client });
  // «Contabilizar» ya lo devuelve traducido (503 con la causa en castellano).
  jest.spyOn(AccountingEngineController.prototype, 'contabilizarFacturaGasto').mockRejectedValueOnce(errorFalloBD(caducada, QUE_HACER_CONTABILIZAR, 'contabilizar la factura de gasto g1'));
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);

  await new AccountingHooksService().onExpenseInvoiceConfirmed('c1', 'g1');

  expect(auditoria).toEqual([expect.objectContaining({ action: 'HOOK_EXPENSE_INVOICE_CONFIRMED_ERROR', meta: { error: TEXTO_PRISMA } })]);
  expect(error).toHaveBeenCalledWith(`❌ Error contabilizando gasto g1: ${TEXTO_PRISMA}`);
  error.mockRestore();
});
