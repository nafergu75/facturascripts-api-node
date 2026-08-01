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
