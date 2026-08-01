import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

class OCRAnalyticsController {
  // KPIs: Estadísticas generales de los últimos N días
  async getKPIs(req: Request, res: Response) {
    try {
      const { companyId } = req.params;
      const { days = '30' } = req.query;
      const daysNum = parseInt(String(days), 10);

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const fromDate = new Date(today);
      fromDate.setDate(fromDate.getDate() - daysNum);

      // PDFs procesados hoy
      const todayCount = await prisma.oCRSession.count({
        where: {
          companyId,
          createdAt: { gte: today },
        },
      });

      // Estadísticas de rango seleccionado
      const sessions = await prisma.oCRSession.findMany({
        where: {
          companyId,
          createdAt: { gte: fromDate },
        },
        select: {
          status: true,
          processingTimeSeconds: true,
        },
      });

      const completedSessions = sessions.filter((s) => s.status === 'COMPLETED');
      const failedSessions = sessions.filter((s) => s.status === 'FAILED');

      const avgProcessingTime = completedSessions.length > 0
        ? Math.round(
            completedSessions.reduce((sum: number, s) => sum + (s.processingTimeSeconds || 0), 0) /
              completedSessions.length
          )
        : 0;

      const errorRate = sessions.length > 0
        ? Math.round((failedSessions.length / sessions.length) * 100 * 100) / 100
        : 0;

      return res.json({
        ok: true,
        data: {
          todayCount,
          avgTime: avgProcessingTime,
          errorRate,
          totalProcessed: sessions.length,
          completedCount: completedSessions.length,
          failedCount: failedSessions.length,
          periodDays: daysNum,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return res.status(500).json({
        ok: false,
        error: `Failed to fetch KPIs: ${message}`,
      });
    }
  }

  // Timeline: PDFs procesados por día (últimos N días)
  async getTimeline(req: Request, res: Response) {
    try {
      const { companyId } = req.params;
      const { from, to, days = '30' } = req.query;

      let fromDate: Date;
      let toDate: Date;

      if (from && to) {
        fromDate = new Date(String(from));
        toDate = new Date(String(to));
      } else {
        toDate = new Date();
        toDate.setHours(23, 59, 59, 999);
        fromDate = new Date(toDate);
        fromDate.setDate(fromDate.getDate() - parseInt(String(days), 10));
        fromDate.setHours(0, 0, 0, 0);
      }

      const sessions = await prisma.oCRSession.findMany({
        where: {
          companyId,
          createdAt: {
            gte: fromDate,
            lte: toDate,
          },
        },
        select: {
          createdAt: true,
          status: true,
        },
        orderBy: { createdAt: 'asc' },
      });

      // Group by date
      const grouped = new Map<string, { count: number; completed: number; failed: number }>();

      sessions.forEach((session: typeof sessions[0]) => {
        const dateStr = session.createdAt.toISOString().split('T')[0];
        if (!grouped.has(dateStr)) {
          grouped.set(dateStr, { count: 0, completed: 0, failed: 0 });
        }
        const stats = grouped.get(dateStr)!;
        stats.count++;
        if (session.status === 'COMPLETED') stats.completed++;
        if (session.status === 'FAILED') stats.failed++;
      });

      const timeline = Array.from(grouped.entries()).map(([date, stats]) => ({
        date,
        count: stats.count,
        completed: stats.completed,
        failed: stats.failed,
      }));

      return res.json({
        ok: true,
        data: timeline,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return res.status(500).json({
        ok: false,
        error: `Failed to fetch timeline: ${message}`,
      });
    }
  }

  // Distribution: Reparto de PDFs por tipo (expense/income) y empresa
  async getDistribution(req: Request, res: Response) {
    try {
      const { companyId } = req.params;
      const { from, to, days = '30' } = req.query;

      let fromDate: Date;
      let toDate: Date;

      if (from && to) {
        fromDate = new Date(String(from));
        toDate = new Date(String(to));
      } else {
        toDate = new Date();
        toDate.setHours(23, 59, 59, 999);
        fromDate = new Date(toDate);
        fromDate.setDate(fromDate.getDate() - parseInt(String(days), 10));
        fromDate.setHours(0, 0, 0, 0);
      }

      const sessions = await prisma.oCRSession.findMany({
        where: {
          companyId,
          createdAt: {
            gte: fromDate,
            lte: toDate,
          },
        },
        select: {
          invoiceType: true,
          status: true,
        },
      });

      // Group by invoiceType
      const byType = new Map<string, { count: number; completed: number; failed: number }>();

      sessions.forEach((session: typeof sessions[0]) => {
        const type = session.invoiceType || 'unknown';
        if (!byType.has(type)) {
          byType.set(type, { count: 0, completed: 0, failed: 0 });
        }
        const stats = byType.get(type)!;
        stats.count++;
        if (session.status === 'COMPLETED') stats.completed++;
        if (session.status === 'FAILED') stats.failed++;
      });

      const byTypeData = Array.from(byType.entries()).map(([type, stats]) => ({
        type,
        count: stats.count,
        completed: stats.completed,
        failed: stats.failed,
        successRate: stats.count > 0 ? Math.round((stats.completed / stats.count) * 100) : 0,
      }));

      return res.json({
        ok: true,
        data: {
          byType: byTypeData,
          total: sessions.length,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return res.status(500).json({
        ok: false,
        error: `Failed to fetch distribution: ${message}`,
      });
    }
  }

  // Global stats: Agregado de todas las empresas (solo superadmin)
  async getGlobalStats(req: Request, res: Response) {
    try {
      // Verificar que es admin
      const userId = (req as any).userId;
      const user = await prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user?.isGlobalAdmin) {
        return res.status(403).json({
          ok: false,
          error: 'Only global admins can access global stats',
        });
      }

      const { from, to, days = '30' } = req.query;

      let fromDate: Date;
      let toDate: Date;

      if (from && to) {
        fromDate = new Date(String(from));
        toDate = new Date(String(to));
      } else {
        toDate = new Date();
        toDate.setHours(23, 59, 59, 999);
        fromDate = new Date(toDate);
        fromDate.setDate(fromDate.getDate() - parseInt(String(days), 10));
        fromDate.setHours(0, 0, 0, 0);
      }

      const sessions = await prisma.oCRSession.findMany({
        where: {
          createdAt: {
            gte: fromDate,
            lte: toDate,
          },
        },
        select: {
          companyId: true,
          invoiceType: true,
          status: true,
          processingTimeSeconds: true,
        },
      });

      // Aggregate by company
      const byCompany = new Map<string, { count: number; completed: number; failed: number }>();

      sessions.forEach((session: typeof sessions[0]) => {
        if (!byCompany.has(session.companyId)) {
          byCompany.set(session.companyId, { count: 0, completed: 0, failed: 0 });
        }
        const stats = byCompany.get(session.companyId)!;
        stats.count++;
        if (session.status === 'COMPLETED') stats.completed++;
        if (session.status === 'FAILED') stats.failed++;
      });

      const byCompanyData = Array.from(byCompany.entries()).map(([companyId, stats]) => ({
        companyId,
        count: stats.count,
        completed: stats.completed,
        failed: stats.failed,
        successRate: stats.count > 0 ? Math.round((stats.completed / stats.count) * 100) : 0,
      }));

      const completed = sessions.filter((s) => s.status === 'COMPLETED');
      const avgTime = completed.length > 0
        ? Math.round(
            completed.reduce((sum: number, s) => sum + (s.processingTimeSeconds || 0), 0) / completed.length
          )
        : 0;

      return res.json({
        ok: true,
        data: {
          totalSessions: sessions.length,
          completedCount: completed.length,
          failedCount: sessions.filter((s) => s.status === 'FAILED').length,
          avgTime,
          successRate: sessions.length > 0 ? Math.round((completed.length / sessions.length) * 100) : 0,
          byCompany: byCompanyData,
          periodDays: days,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return res.status(500).json({
        ok: false,
        error: `Failed to fetch global stats: ${message}`,
      });
    }
  }
}

export default new OCRAnalyticsController();
