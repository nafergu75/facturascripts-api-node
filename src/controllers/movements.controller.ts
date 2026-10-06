import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import { prisma } from '../config/database';
import { Decimal } from '@prisma/client/runtime/library';

export const movementsController = {
  // POST /companies/:companyId/movements
  create: asyncHandler(async (req, res) => {
    const { companyId } = req.params;
    const { type, amount, category, description, date, referenceDocument, fiscalYear, status } =
      req.body;

    const movement = await prisma.movement.create({
      data: {
        companyId,
        type,
        amount: new Decimal(amount),
        category,
        description,
        date: new Date(date),
        referenceDocument,
        fiscalYear: fiscalYear || new Date(date).getFullYear(),
        status: status || 'draft',
      },
    });

    sendOk(res, movement);
  }),

  // GET /companies/:companyId/movements
  list: asyncHandler(async (req, res) => {
    const { companyId } = req.params;
    const { limit = 50, page = 1, type, category } = req.query;

    const skip = (Number(page) - 1) * Number(limit);

    const where: any = { companyId };
    if (type) where.type = String(type);
    if (category) where.category = String(category);

    const movements = await prisma.movement.findMany({
      where,
      take: Number(limit),
      skip,
      orderBy: { date: 'desc' },
    });

    sendOk(res, movements);
  }),

  // GET /companies/:companyId/stats/summary - resumen totales
  getSummary: asyncHandler(async (req, res) => {
    const { companyId } = req.params;

    const movements = await prisma.movement.findMany({
      where: { companyId },
    });

    const totalIncome = movements
      .filter((m) => m.type === 'income')
      .reduce((sum, m) => sum.plus(m.amount), new Decimal(0));

    const totalExpense = movements
      .filter((m) => m.type === 'expense')
      .reduce((sum, m) => sum.plus(m.amount), new Decimal(0));

    const balance = totalIncome.minus(totalExpense);

    sendOk(res, {
      totalIncome: parseFloat(totalIncome.toString()),
      totalExpense: parseFloat(totalExpense.toString()),
      balance: parseFloat(balance.toString()),
      totalMovements: movements.length,
    });
  }),

  /**
   * Resumen fiscal del periodo a partir de las FACTURAS (no de los movimientos):
   * ventas emitidas e IVA repercutido, gastos e IVA soportado, y retenciones.
   * Mismo criterio que el 303: ventas FINAL y ni ventas ni gastos en borrador.
   */
  getResumenFiscal: asyncHandler(async (req, res) => {
    const companyId = req.companyId ?? req.params.companyId;
    const anio = Number(req.query.anio ?? new Date().getFullYear());
    const trimestre = req.query.trimestre ? Number(req.query.trimestre) : null;
    if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) throw badRequest('Año no válido.');
    if (trimestre !== null && ![1, 2, 3, 4].includes(trimestre)) throw badRequest('Trimestre no válido (1 a 4).');
    const mesDesde = trimestre ? (trimestre - 1) * 3 + 1 : 1;
    const mesHasta = trimestre ? trimestre * 3 : 12;
    const desde = `${anio}-${String(mesDesde).padStart(2, '0')}-01`;
    const hasta = `${anio}-${String(mesHasta).padStart(2, '0')}-31`;
    const fechas = { gte: desde, lte: hasta };
    const suma = { baseTotal: true, ivaTotal: true, retencionTotal: true, totalFactura: true } as const;

    const [ventas, gastos] = await Promise.all([
      prisma.incomeInvoice.aggregate({
        where: { companyId, estadoDocumento: 'FINAL', estado: { not: 'DRAFT' }, fechaEmision: fechas },
        _sum: suma,
        _count: true,
      }),
      prisma.expenseInvoice.aggregate({
        where: { companyId, estado: { not: 'DRAFT' }, fechaEmision: fechas },
        _sum: suma,
        _count: true,
      }),
    ]);
    const n = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;
    const ivaRepercutido = n(ventas._sum.ivaTotal);
    const ivaSoportado = n(gastos._sum.ivaTotal);

    sendOk(res, {
      periodo: { anio, trimestre, desde, hasta },
      ventas: {
        facturas: ventas._count,
        base: n(ventas._sum.baseTotal),
        iva: ivaRepercutido,
        retencion: n(ventas._sum.retencionTotal),
        total: n(ventas._sum.totalFactura),
      },
      gastos: {
        facturas: gastos._count,
        base: n(gastos._sum.baseTotal),
        iva: ivaSoportado,
        retencion: n(gastos._sum.retencionTotal),
        total: n(gastos._sum.totalFactura),
      },
      // Orientativo: el 303 real puede ajustar IVA no deducible, prorrata o compensaciones.
      ivaResultado: n(ivaRepercutido - ivaSoportado),
      // Retenciones que la empresa practica en sus gastos (modelo 111/115).
      retencionesAIngresar: n(gastos._sum.retencionTotal),
    });
  }),

  // GET /companies/:companyId/stats/by-category - gastos por categoría
  getByCategory: asyncHandler(async (req, res) => {
    const { companyId } = req.params;

    const movements = await prisma.movement.findMany({
      where: { companyId, type: 'expense' },
    });

    const byCategory = movements.reduce(
      (acc, m) => {
        if (!acc[m.category]) {
          acc[m.category] = new Decimal(0);
        }
        acc[m.category] = acc[m.category].plus(m.amount);
        return acc;
      },
      {} as Record<string, Decimal>
    );

    const totalExpense = Object.values(byCategory).reduce((sum, amount) => sum.plus(amount), new Decimal(0));

    const result = Object.entries(byCategory).map(([category, expense]) => ({
      category,
      expense: parseFloat(expense.toString()),
      percentage: totalExpense.greaterThan(0)
        ? (parseFloat(expense.toString()) / parseFloat(totalExpense.toString())) * 100
        : 0,
    }));

    sendOk(res, result.sort((a, b) => b.expense - a.expense));
  }),

  // GET /companies/:companyId/stats/by-month - ingresos y gastos por mes
  getByMonth: asyncHandler(async (req, res) => {
    const { companyId } = req.params;

    const movements = await prisma.movement.findMany({
      where: { companyId },
    });

    const byMonth = movements.reduce(
      (acc, m) => {
        const monthKey = m.date.toISOString().substring(0, 7);

        if (!acc[monthKey]) {
          acc[monthKey] = { income: new Decimal(0), expense: new Decimal(0) };
        }

        if (m.type === 'income') {
          acc[monthKey].income = acc[monthKey].income.plus(m.amount);
        } else {
          acc[monthKey].expense = acc[monthKey].expense.plus(m.amount);
        }

        return acc;
      },
      {} as Record<string, { income: Decimal; expense: Decimal }>
    );

    const result = Object.entries(byMonth)
      .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
      .map(([month, { income, expense }]) => ({
        month,
        income: parseFloat(income.toString()),
        expense: parseFloat(expense.toString()),
        balance: parseFloat(income.minus(expense).toString()),
      }));

    sendOk(res, result);
  }),

  // PATCH /companies/:companyId/movements/:id
  update: asyncHandler(async (req, res) => {
    const { companyId, id } = req.params;
    const { type, amount, category, description, date, referenceDocument, status } = req.body;

    const updateData: any = {};
    if (type) updateData.type = type;
    if (amount) updateData.amount = new Decimal(amount);
    if (category) updateData.category = category;
    if (description) updateData.description = description;
    if (date) updateData.date = new Date(date);
    if (referenceDocument !== undefined) updateData.referenceDocument = referenceDocument;
    if (status) updateData.status = status;

    const movement = await prisma.movement.update({
      where: { id },
      data: updateData,
    });

    sendOk(res, movement);
  }),

  // DELETE /companies/:companyId/movements/:id
  delete: asyncHandler(async (req, res) => {
    const { id } = req.params;

    await prisma.movement.delete({
      where: { id },
    });

    sendOk(res, { success: true });
  }),
};
