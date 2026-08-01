/**
 * OCR Sessions Controller
 * Gestiona las sesiones de OCR y su historial
 */

import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { logger } from '../config/logger';

const prisma = new PrismaClient();

class OcrSessionsController {
  /**
   * GET /companies/:companyId/ocr/sessions
   * Obtiene el listado de sesiones OCR con filtros
   */
  async getSessions(req: Request, res: Response) {
    try {
      const { companyId } = req.params;
      const { status, invoiceType, dateRange, limit = '50', offset = '0' } = req.query;

      // Construir where clause con filtros
      const where: any = { companyId };

      if (status && status !== 'all') {
        where.status = status;
      }

      if (invoiceType && invoiceType !== 'all') {
        where.invoiceType = invoiceType;
      }

      if (dateRange && dateRange !== 'all') {
        const days = dateRange === '1d' ? 1 : dateRange === '7d' ? 7 : dateRange === '30d' ? 30 : null;
        if (days) {
          const startDate = new Date();
          startDate.setDate(startDate.getDate() - days);
          where.createdAt = { gte: startDate };
        }
      }

      const sessions = await prisma.oCRSession.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Number(limit),
        skip: Number(offset),
      });

      const total = await prisma.oCRSession.count({ where });

      return res.status(200).json({
        ok: true,
        data: sessions,
        pagination: {
          total,
          limit: Number(limit),
          offset: Number(offset),
        },
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[OCR Sessions] Error fetching sessions: ${errorMsg}`);
      return res.status(500).json({
        ok: false,
        error: 'Error fetching OCR sessions',
      });
    }
  }

  /**
   * GET /companies/:companyId/ocr/sessions/:sessionId
   * Obtiene el detalle de una sesión OCR
   */
  async getSession(req: Request, res: Response) {
    try {
      const { companyId, sessionId } = req.params;

      const session = await prisma.oCRSession.findFirst({
        where: { id: sessionId, companyId },
        include: { documents: true },
      });

      if (!session) {
        return res.status(404).json({
          ok: false,
          error: 'Sesión OCR no encontrada',
        });
      }

      return res.status(200).json({
        ok: true,
        data: session,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[OCR Sessions] Error fetching session: ${errorMsg}`);
      return res.status(500).json({
        ok: false,
        error: 'Error fetching OCR session',
      });
    }
  }

  /**
   * GET /companies/:companyId/ocr/stats
   * Obtiene estadísticas de OCR
   */
  async getStats(req: Request, res: Response) {
    try {
      const { companyId } = req.params;

      const total = await prisma.oCRSession.count({ where: { companyId } });
      const completed = await prisma.oCRSession.count({
        where: { companyId, status: 'COMPLETED' },
      });
      const failed = await prisma.oCRSession.count({
        where: { companyId, status: 'FAILED' },
      });

      const avgTime = await prisma.oCRSession.aggregate({
        where: { companyId, status: 'COMPLETED' },
        _avg: { processingTimeSeconds: true },
      });

      // Contar creadas hoy
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const processedToday = await prisma.oCRSession.count({
        where: { companyId, createdAt: { gte: today } },
      });

      const errorRate = total > 0 ? ((failed / total) * 100).toFixed(2) : '0';

      return res.status(200).json({
        ok: true,
        data: {
          total,
          completed,
          failed,
          pending: total - completed - failed,
          successRate: total > 0 ? ((completed / total) * 100).toFixed(2) : '0',
          averageProcessingTime: Math.round(avgTime._avg.processingTimeSeconds || 0),
          errorRate: Number(errorRate),
          processedToday,
          contabilizados: 0, // Se actualiza después cuando haya vinculación con facturas
        },
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[OCR Sessions] Error fetching stats: ${errorMsg}`);
      return res.status(500).json({
        ok: false,
        error: 'Error fetching OCR statistics',
      });
    }
  }

  /**
   * POST /companies/:companyId/ocr/sessions/:sessionId/retry
   * Reintenta el OCR de una sesión fallida
   */
  async retrySesion(req: Request, res: Response) {
    try {
      const { companyId, sessionId } = req.params;

      const session = await prisma.oCRSession.findFirst({
        where: { id: sessionId, companyId },
      });

      if (!session) {
        return res.status(404).json({
          ok: false,
          error: 'Sesión OCR no encontrada',
        });
      }

      if (session.status !== 'FAILED') {
        return res.status(400).json({
          ok: false,
          error: 'Solo se pueden reintentar sesiones con error',
        });
      }

      // Actualizar estado a PENDING para que se reprocese
      const updated = await prisma.oCRSession.update({
        where: { id: sessionId },
        data: {
          status: 'PENDING',
          errorCode: null,
          errorMessage: null,
          processingStartedAt: null,
          processingCompletedAt: null,
        },
      });

      logger.info(`[OCR Sessions] Retry initiated for session ${sessionId}`);

      return res.status(200).json({
        ok: true,
        data: updated,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[OCR Sessions] Error retrying session: ${errorMsg}`);
      return res.status(500).json({
        ok: false,
        error: 'Error retrying OCR session',
      });
    }
  }

  /**
   * POST /companies/:companyId/ocr/sessions/:sessionId/send-to-reader
   * Marca una sesión como enviada al lector (gastos/ingresos)
   */
  async sendToReader(req: Request, res: Response) {
    try {
      const { companyId, sessionId } = req.params;
      const { readerType } = req.body; // 'expense' o 'income'

      const session = await prisma.oCRSession.findFirst({
        where: { id: sessionId, companyId },
      });

      if (!session) {
        return res.status(404).json({
          ok: false,
          error: 'Sesión OCR no encontrada',
        });
      }

      if (session.status !== 'COMPLETED') {
        return res.status(400).json({
          ok: false,
          error: 'Solo se pueden enviar sesiones completadas',
        });
      }

      logger.info(`[OCR Sessions] Session ${sessionId} sent to ${readerType} reader`);

      return res.status(200).json({
        ok: true,
        data: {
          sessionId,
          readerType,
          message: `Sesión enviada al lector de ${readerType === 'expense' ? 'gastos' : 'ingresos'}`,
        },
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[OCR Sessions] Error sending to reader: ${errorMsg}`);
      return res.status(500).json({
        ok: false,
        error: 'Error sending OCR session to reader',
      });
    }
  }
}

export default new OcrSessionsController();
