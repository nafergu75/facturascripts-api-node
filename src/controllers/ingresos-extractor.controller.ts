/**
 * Lector de facturas de INGRESO. Rutas: /companies/:companyId/ingresos-extractor/*
 */
import { Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { badRequest } from '../utils/http-errors';
import { sendOk } from '../utils/response';
import { leerFacturaSubida } from '../utils/archivo-subido';
import { ingresosExtractorService } from '../services/ingresos-extractor.service';

export const ingresosExtractorController = {
  /** POST /extraer-ia: lee la factura y la deja pendiente de confirmar. */
  extraer: asyncHandler(async (req: Request, res: Response) => {
    const archivo = leerFacturaSubida(req);
    sendOk(res, await ingresosExtractorService.extraer(req.companyId!, req.user?.userId, archivo), undefined, 201);
  }),

  /**
   * POST /confirmar { documentId }: crea la factura de ingreso con los datos
   * guardados al leer. El resto del cuerpo se ignora a proposito.
   */
  confirmar: asyncHandler(async (req: Request, res: Response) => {
    const documentId = (req.body ?? {}).documentId;
    if (typeof documentId !== 'string' || !documentId) throw badRequest('Falta documentId.');
    sendOk(res, await ingresosExtractorService.confirmar(req.companyId!, documentId), undefined, 201);
  }),
};
