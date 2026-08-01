/**
 * REPORTS SERVICE - Informes Financieros Automáticos
 *
 * Responsabilidades:
 * - Agregar datos de asientos contables POSTED
 * - Calcular Balance (grupos 1-5)
 * - Calcular P&L (grupos 6-7)
 * - Mayor por cuenta
 * - Evolución de ingresos/gastos por mes
 * - Análisis por cliente
 */

import { notFound } from '../utils/http-errors';
import { prisma } from '../config/database';

export class ReportsService {
  /**
   * Obtener Balance General (grupos 1-5)
   *
   * Agrupa saldos por grupo contable:
   * - Grupo 1: Patrimonio Neto
   * - Grupo 2: Inmovilizado (no circulante)
   * - Grupo 3-5: Activo circulante
   * - Grupo 4: Pasivos
   */
  async obtenerBalance(
    companyId: string,
    from: string,
    to: string
  ): Promise<{
    fecha: string;
    activo: { noCirculante: number; circulante: number };
    pasivo: { noCirculante: number; circulante: number };
    patrimonioNeto: number;
  }> {
    const fromDate = new Date(from);
    const toDate = new Date(to);

    // Agregar por accountCode, filtrando solo POSTED
    const saldos = await prisma.journalEntryLine.groupBy({
      by: ['accountCode'],
      where: {
        companyId,
        entry: {
          companyId,
          estado: 'POSTED',
          fecha: { gte: fromDate, lte: toDate },
        },
      },
      _sum: { debe: true, haber: true },
    });

    const balance = {
      fecha: to,
      activo: { noCirculante: 0, circulante: 0 },
      pasivo: { noCirculante: 0, circulante: 0 },
      patrimonioNeto: 0,
    };

    for (const saldo of saldos) {
      if (!saldo.accountCode) continue;

      const neto = (saldo._sum.debe || 0) - (saldo._sum.haber || 0);
      const grupo = parseInt(saldo.accountCode.charAt(0));

      if (grupo === 1) {
        balance.patrimonioNeto += neto;
      } else if (grupo === 2) {
        balance.activo.noCirculante += neto;
      } else if (grupo === 3) {
        balance.activo.circulante += neto;
      } else if (grupo === 4) {
        // PGC grupo 4: mapeo a nivel de subcuenta (no todo el grupo es pasivo)
        // 43x Clientes, 44x Deudores varios → activo circulante
        // 472 IVA soportado, 473 HP retenciones → activo circulante
        // 40x Proveedores, 41x Acreedores, 42x Personal, 475/476/477/4751 → pasivo circulante
        const code = saldo.accountCode;
        if (
          code.startsWith('43') ||
          code.startsWith('44') ||
          code.startsWith('472') ||
          code.startsWith('473')
        ) {
          balance.activo.circulante += neto;
        } else {
          balance.pasivo.circulante += neto;
        }
      } else if (grupo === 5) {
        balance.activo.circulante += neto;
      }
    }

    return balance;
  }

  /**
   * Obtener Cuenta de Pérdidas y Ganancias (P&L)
   *
   * Grupo 7: Ingresos (HABER)
   * Grupo 6: Gastos (DEBE)
   */
  async obtenerPyG(
    companyId: string,
    from: string,
    to: string
  ): Promise<{
    desde: string;
    hasta: string;
    ingresos: number;
    gastos: number;
    resultadoExplotacion: number;
  }> {
    const fromDate = new Date(from);
    const toDate = new Date(to);

    const movimientos = await prisma.journalEntryLine.groupBy({
      by: ['accountCode'],
      where: {
        companyId,
        entry: {
          companyId,
          estado: 'POSTED',
          fecha: { gte: fromDate, lte: toDate },
        },
      },
      _sum: { debe: true, haber: true },
    });

    let ingresos = 0;
    let gastos = 0;

    for (const mov of movimientos) {
      if (!mov.accountCode) continue;

      const grupo = parseInt(mov.accountCode.charAt(0));

      if (grupo === 7) {
        // Ingresos: naturaleza HABER → saldo neto = haber - debe
        ingresos += (mov._sum.haber || 0) - (mov._sum.debe || 0);
      } else if (grupo === 6) {
        // Gastos: naturaleza DEBE → saldo neto positivo = debe - haber
        gastos += (mov._sum.debe || 0) - (mov._sum.haber || 0);
      }
    }

    return {
      desde: from,
      hasta: to,
      ingresos,
      gastos,
      resultadoExplotacion: ingresos - gastos,
    };
  }

  /**
   * Obtener Mayor por Cuenta
   *
   * Listado de movimientos (debe/haber) de una cuenta específica
   */
  async obtenerMayor(
    companyId: string,
    accountCode: string,
    from: string,
    to: string
  ): Promise<{
    cuenta: string;
    movimientos: any[];
    saldoFinal: number;
  }> {
    const fromDate = new Date(from);
    const toDate = new Date(to);

    const movimientos = await prisma.journalEntryLine.findMany({
      where: {
        companyId,
        accountCode,
        entry: {
          companyId,
          estado: 'POSTED',
          fecha: { gte: fromDate, lte: toDate },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    let saldoFinal = 0;
    for (const mov of movimientos) {
      saldoFinal += (mov.debe || 0) - (mov.haber || 0);
    }

    return {
      cuenta: accountCode,
      movimientos: movimientos.map((m) => ({
        fecha: m.createdAt,
        referencia: m.referencia,
        debe: m.debe,
        haber: m.haber,
      })),
      saldoFinal,
    };
  }

  /**
   * Evolución mensual: Ingresos vs Gastos por mes
   */
  async obtenerEvolucionMensual(
    companyId: string,
    year: number
  ): Promise<{
    year: number;
    meses: Record<string, { ingresos: number; gastos: number; beneficio: number }>;
  }> {
    const movimientos = await prisma.journalEntry.findMany({
      where: {
        companyId,
        estado: 'POSTED',
        fecha: {
          gte: new Date(year, 0, 1),
          lte: new Date(year, 11, 31),
        },
      },
      include: { lineas: true },
    });

    const meses: Record<
      string,
      { ingresos: number; gastos: number; beneficio: number }
    > = {};

    for (let i = 1; i <= 12; i++) {
      const mes = i.toString().padStart(2, '0');
      meses[mes] = { ingresos: 0, gastos: 0, beneficio: 0 };
    }

    for (const entry of movimientos) {
      const mes = (entry.fecha.getMonth() + 1).toString().padStart(2, '0');
      for (const linea of entry.lineas) {
        if (!linea.accountCode) continue;
        const grupo = parseInt(linea.accountCode.charAt(0));
        if (grupo === 7) {
          meses[mes].ingresos += linea.haber || 0;
        } else if (grupo === 6) {
          meses[mes].gastos += linea.debe || 0;
        }
      }
    }

    // Calcular beneficios
    for (const mes of Object.keys(meses)) {
      meses[mes].beneficio = meses[mes].ingresos - meses[mes].gastos;
    }

    return { year, meses };
  }

  /**
   * Análisis por cliente: Facturación y saldo pendiente
   */
  async obtenerAnalisisPorCliente(
    companyId: string,
    from: string,
    to: string
  ): Promise<{
    clientes: Array<{
      id: string;
      nombre: string;
      totalFacturado: number;
      saldoPendiente: number;
    }>;
  }> {
    const facturas = await prisma.incomeInvoice.findMany({
      where: {
        companyId,
        estado: { in: ['PENDING', 'PAID'] },
        fechaEmision: {
          gte: from,
          lte: to,
        },
      },
      include: { customer: true },
      orderBy: { totalFactura: 'desc' },
    });

    const clientesMap = new Map<
      string,
      {
        id: string;
        nombre: string;
        totalFacturado: number;
        saldoPendiente: number;
      }
    >();

    for (const factura of facturas) {
      const key = factura.customerId;
      if (!clientesMap.has(key)) {
        clientesMap.set(key, {
          id: factura.customerId,
          nombre: factura.customer.nombreFiscal,
          totalFacturado: 0,
          saldoPendiente: 0,
        });
      }

      const cliente = clientesMap.get(key)!;
      cliente.totalFacturado += factura.totalFactura;
      if (factura.estado === 'PENDING') {
        cliente.saldoPendiente += factura.totalFactura;
      }
    }

    return {
      clientes: Array.from(clientesMap.values()),
    };
  }
}

export const reportsService = new ReportsService();

// ─────────────────────────────────────────────────────────────────────────────
// MÓDULO DE INFORMES — 6 informes del front (income / expenses / result /
// vat / retentions / treasury). Cada uno consume datos ya contabilizados
// (VATBook, RetentionBook, JournalEntryLine) sin recalcular lógica contable.
// ─────────────────────────────────────────────────────────────────────────────

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isoDay(d: Date): string {
  return d.toISOString().split('T')[0];
}

interface DayAmount { date: string; amount: number }
interface MonthAmount { year: number; month: number; amount: number }

function groupByDayMonth(rows: Array<{ fecha: Date; importe: number }>): {
  byDay: DayAmount[];
  byMonth: MonthAmount[];
} {
  const dayMap = new Map<string, number>();
  const monthMap = new Map<string, MonthAmount>();

  for (const row of rows) {
    const day = isoDay(row.fecha);
    dayMap.set(day, (dayMap.get(day) ?? 0) + row.importe);

    const y = row.fecha.getFullYear();
    const m = row.fecha.getMonth() + 1;
    const mk = `${y}-${String(m).padStart(2, '0')}`;
    if (!monthMap.has(mk)) monthMap.set(mk, { year: y, month: m, amount: 0 });
    monthMap.get(mk)!.amount += row.importe;
  }

  return {
    byDay: [...dayMap.entries()]
      .map(([date, amount]) => ({ date, amount: r2(amount) }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    byMonth: [...monthMap.values()]
      .sort((a, b) => a.year - b.year || a.month - b.month)
      .map((m) => ({ ...m, amount: r2(m.amount) })),
  };
}

export class FinancialReportsService {
  // Helper: obtiene IDs de asientos POSTED para filtrar libros fiscales.
  // VATBook y RetentionBook no tienen relación directa con JournalEntry en el schema,
  // por lo que filtramos via asientoId IN (postedIds).
  private async postedAsientoIds(companyId: string): Promise<string[]> {
    const entries = await prisma.journalEntry.findMany({
      where: { companyId, estado: 'POSTED' },
      select: { id: true },
    });
    return entries.map((e) => e.id);
  }

  // ── Ingresos ───────────────────────────────────────────────────────────────
  async getIncomeReport(companyId: string, fromDate: Date, toDate: Date) {
    const postedIds = await this.postedAsientoIds(companyId);
    const rows = await prisma.vATBook.findMany({
      where: {
        companyId,
        tipoLibro: 'EMITIDAS',
        fechaFactura: { gte: fromDate, lte: toDate },
        // Solo incluir entradas de asientos ya aprobados (POSTED)
        ...(postedIds.length > 0 && { asientoId: { in: postedIds } }),
      },
      orderBy: { fechaFactura: 'asc' },
    });

    const items = rows.map((r) => ({ fecha: r.fechaFactura, importe: r.baseImponible }));
    const { byDay, byMonth } = groupByDayMonth(items);
    const totalIncome = r2(items.reduce((s, r) => s + r.importe, 0));

    return {
      companyId,
      period: { from: isoDay(fromDate), to: isoDay(toDate) },
      summary: { totalIncome, currency: 'EUR' },
      byDay,
      byMonth,
    };
  }

  // ── Gastos ─────────────────────────────────────────────────────────────────
  async getExpensesReport(companyId: string, fromDate: Date, toDate: Date) {
    const postedIds = await this.postedAsientoIds(companyId);
    const rows = await prisma.vATBook.findMany({
      where: {
        companyId,
        tipoLibro: 'RECIBIDAS',
        fechaFactura: { gte: fromDate, lte: toDate },
        ...(postedIds.length > 0 && { asientoId: { in: postedIds } }),
      },
      orderBy: { fechaFactura: 'asc' },
    });

    const items = rows.map((r) => ({ fecha: r.fechaFactura, importe: r.baseImponible }));
    const { byDay, byMonth } = groupByDayMonth(items);
    const totalExpenses = r2(items.reduce((s, r) => s + r.importe, 0));

    return {
      companyId,
      period: { from: isoDay(fromDate), to: isoDay(toDate) },
      summary: { totalExpenses, currency: 'EUR' },
      byDay,
      byMonth,
    };
  }

  // ── Resultado ──────────────────────────────────────────────────────────────
  async getResultReport(companyId: string, fromDate: Date, toDate: Date) {
    const [income, expenses] = await Promise.all([
      this.getIncomeReport(companyId, fromDate, toDate),
      this.getExpensesReport(companyId, fromDate, toDate),
    ]);

    // Merge byMonth: cada mes tiene income + expenses + result
    const monthMap = new Map<
      string,
      { year: number; month: number; income: number; expenses: number }
    >();

    for (const m of income.byMonth) {
      const k = `${m.year}-${String(m.month).padStart(2, '0')}`;
      if (!monthMap.has(k)) monthMap.set(k, { year: m.year, month: m.month, income: 0, expenses: 0 });
      monthMap.get(k)!.income = m.amount;
    }
    for (const m of expenses.byMonth) {
      const k = `${m.year}-${String(m.month).padStart(2, '0')}`;
      if (!monthMap.has(k)) monthMap.set(k, { year: m.year, month: m.month, income: 0, expenses: 0 });
      monthMap.get(k)!.expenses = m.amount;
    }

    const byMonth = [...monthMap.values()]
      .sort((a, b) => a.year - b.year || a.month - b.month)
      .map((m) => ({ ...m, result: r2(m.income - m.expenses) }));

    const totalIncome = income.summary.totalIncome;
    const totalExpenses = expenses.summary.totalExpenses;

    return {
      companyId,
      period: { from: isoDay(fromDate), to: isoDay(toDate) },
      summary: {
        totalIncome,
        totalExpenses,
        result: r2(totalIncome - totalExpenses),
        currency: 'EUR',
      },
      byMonth,
    };
  }

  // ── IVA ────────────────────────────────────────────────────────────────────
  async getVatReport(companyId: string, fromDate: Date, toDate: Date) {
    const postedIds = await this.postedAsientoIds(companyId);
    const vatWhere = (tipo: string) => ({
      companyId,
      tipoLibro: tipo,
      fechaFactura: { gte: fromDate, lte: toDate },
      ...(postedIds.length > 0 && { asientoId: { in: postedIds } }),
    });
    const [emitidas, recibidas] = await Promise.all([
      prisma.vATBook.findMany({ where: vatWhere('EMITIDAS'), orderBy: { fechaFactura: 'asc' } }),
      prisma.vATBook.findMany({ where: vatWhere('RECIBIDAS'), orderBy: { fechaFactura: 'asc' } }),
    ]);

    const vatOutput = r2(emitidas.reduce((s, r) => s + r.cuotaIva, 0));
    const vatInput = r2(recibidas.reduce((s, r) => s + r.cuotaIva, 0));

    // byMonth combinado
    const monthMap = new Map<
      string,
      { year: number; month: number; vatOutput: number; vatInput: number }
    >();

    const addMonth = (date: Date, out: number, inp: number) => {
      const y = date.getFullYear();
      const m = date.getMonth() + 1;
      const k = `${y}-${String(m).padStart(2, '0')}`;
      if (!monthMap.has(k)) monthMap.set(k, { year: y, month: m, vatOutput: 0, vatInput: 0 });
      const entry = monthMap.get(k)!;
      entry.vatOutput += out;
      entry.vatInput += inp;
    };

    for (const r of emitidas) addMonth(r.fechaFactura, r.cuotaIva, 0);
    for (const r of recibidas) addMonth(r.fechaFactura, 0, r.cuotaIva);

    const byMonth = [...monthMap.values()]
      .sort((a, b) => a.year - b.year || a.month - b.month)
      .map((m) => ({
        year: m.year,
        month: m.month,
        vatOutput: r2(m.vatOutput),
        vatInput: r2(m.vatInput),
        vatPayable: r2(m.vatOutput - m.vatInput),
      }));

    return {
      companyId,
      period: { from: isoDay(fromDate), to: isoDay(toDate) },
      summary: {
        vatOutput,
        vatInput,
        vatPayable: r2(vatOutput - vatInput),
        currency: 'EUR',
      },
      byMonth,
    };
  }

  // ── Retenciones ────────────────────────────────────────────────────────────
  async getRetentionReport(companyId: string, fromDate: Date, toDate: Date) {
    // RetentionBook no tiene fechaFactura: usa el campo `ano` (año del ejercicio fiscal
    // derivado de la fecha de emisión de la factura, no de la fecha de creación del registro).
    // Filtramos también por asientos POSTED para excluir datos de borradores/reversados.
    const postedIds = await this.postedAsientoIds(companyId);
    const fromYear = fromDate.getFullYear();
    const toYear = toDate.getFullYear();

    const rows = await prisma.retentionBook.findMany({
      where: {
        companyId,
        ano: { gte: fromYear, lte: toYear },
        ...(postedIds.length > 0 && { asientoId: { in: postedIds } }),
      },
      orderBy: { ano: 'asc' },
    });

    const totalRetentions = r2(rows.reduce((s, r) => s + r.cuotaRetencion, 0));

    // byMonth: usa el campo `mes` cuando está disponible (registros creados tras la
    // migración que lo añadió). Los registros antiguos sin `mes` (NULL) caen en el
    // mes 1 del año como aproximación, igual que antes de esta mejora.
    const monthMap = new Map<string, MonthAmount>();
    for (const r of rows) {
      const y = r.ano;
      const m = r.mes ?? 1;
      const k = `${y}-${String(m).padStart(2, '0')}`;
      if (!monthMap.has(k)) monthMap.set(k, { year: y, month: m, amount: 0 });
      monthMap.get(k)!.amount += r.cuotaRetencion;
    }
    const byMonth = [...monthMap.values()]
      .sort((a, b) => a.year - b.year || a.month - b.month)
      .map((m) => ({ ...m, amount: r2(m.amount) }));

    // byProvider (ordenado mayor retención primero, útil para modelo 190)
    const providerMap = new Map<
      string,
      { nif: string; nombre: string; base: number; retencion: number; tipo: string }
    >();
    for (const r of rows) {
      if (!providerMap.has(r.nifTercero)) {
        providerMap.set(r.nifTercero, {
          nif: r.nifTercero,
          nombre: r.nombreTercero,
          tipo: r.tipoRetencionNombre,
          base: 0,
          retencion: 0,
        });
      }
      const p = providerMap.get(r.nifTercero)!;
      p.base += r.baseImponible;
      p.retencion += r.cuotaRetencion;
    }
    const byProvider = [...providerMap.values()]
      .map((p) => ({ ...p, base: r2(p.base), retencion: r2(p.retencion) }))
      .sort((a, b) => b.retencion - a.retencion);

    return {
      companyId,
      period: { from: isoDay(fromDate), to: isoDay(toDate) },
      summary: { totalRetentions, currency: 'EUR' },
      byMonth,
      byProvider,
    };
  }

  // ── Tesorería ──────────────────────────────────────────────────────────────
  // Lee líneas de asientos POSTED en cuentas 57x (Tesorería: Caja 570, Bancos 572).
  // DEBE = entrada de dinero, HABER = salida.
  async getTreasuryReport(companyId: string, fromDate: Date, toDate: Date) {
    // Saldo de apertura: todo lo POSTED en 57x antes del periodo
    const beforeLines = await prisma.journalEntryLine.findMany({
      where: {
        companyId,
        accountCode: { startsWith: '57' },
        entry: { estado: 'POSTED', fecha: { lt: fromDate } },
      },
    });
    const openingBalance = r2(
      beforeLines.reduce((s, l) => s + (l.debe || 0) - (l.haber || 0), 0),
    );

    // Movimientos del periodo
    const periodLines = await prisma.journalEntryLine.findMany({
      where: {
        companyId,
        accountCode: { startsWith: '57' },
        entry: { estado: 'POSTED', fecha: { gte: fromDate, lte: toDate } },
      },
      include: {
        entry: { select: { fecha: true, descripcion: true, numeroAsiento: true } },
      },
      orderBy: { entry: { fecha: 'asc' } },
    });

    const totalIn = r2(periodLines.reduce((s, l) => s + (l.debe || 0), 0));
    const totalOut = r2(periodLines.reduce((s, l) => s + (l.haber || 0), 0));

    // Movimientos con saldo acumulado progresivo
    let running = openingBalance;
    const movements = periodLines.map((l) => {
      const amount = r2((l.debe || 0) - (l.haber || 0));
      running = r2(running + amount);
      return {
        date: isoDay(l.entry.fecha),
        description: l.entry.descripcion,
        reference: l.referencia ?? l.entry.numeroAsiento,
        amount,
        balance: running,
      };
    });

    return {
      companyId,
      period: { from: isoDay(fromDate), to: isoDay(toDate) },
      summary: {
        openingBalance,
        closingBalance: r2(openingBalance + totalIn - totalOut),
        totalIn,
        totalOut,
        currency: 'EUR',
      },
      movements,
    };
  }
}

export const financialReportsService = new FinancialReportsService();
