/**
 * Lector de facturas de INGRESO. Rutas: /companies/:companyId/ingresos-extractor/*
 */
import { Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { badRequest } from '../utils/http-errors';
import { sendOk } from '../utils/response';
import { leerFacturaSubida } from '../utils/archivo-subido';
import { ingresosExtractorService } from '../services/ingresos-extractor.service';
import { clientePorNif } from '../services/lectura/terceros-lector';

export const ingresosExtractorController = {
  /**
   * POST /extraer-ia: lee la factura y la deja pendiente de confirmar. Con
   * clienteExistente: el cliente dado de alta con ese NIF, o null.
   */
  extraer: asyncHandler(async (req: Request, res: Response) => {
    const archivo = leerFacturaSubida(req);
    const ingreso = await ingresosExtractorService.extraer(req.companyId!, req.user?.userId, archivo);
    const clienteExistente = await clientePorNif(req.companyId!, ingreso.nifCliente);
    sendOk(res, { ...ingreso, clienteExistente }, undefined, 201);
  }),

  /**
   * POST /confirmar { documentId, clienteId?, revisado?, lineas?: [{ cuenta }] }:
   * crea la factura de ingreso con los datos guardados al leer. Del cuerpo solo
   * se toman el cliente elegido (clienteId, uno dado de alta) y la cuenta de
   * cada linea («Cambiar cuenta»); el resto se ignora a proposito. Sin
   * clienteId, el cliente dado de alta con el NIF leido; si no hay ninguno, 400
   * TERCERO_NO_DADO_DE_ALTA (ya no se crea solo).
   */
  confirmar: asyncHandler(async (req: Request, res: Response) => {
    const documentId = (req.body ?? {}).documentId;
    if (typeof documentId !== 'string' || !documentId) throw badRequest('Falta documentId.');
    const revisado = (req.body ?? {}).revisado === true;
    const lineas = (req.body ?? {}).lineas;
    const clienteId = (req.body ?? {}).clienteId;
    if (clienteId !== undefined && clienteId !== null && (typeof clienteId !== 'string' || !clienteId.trim())) {
      throw badRequest('El cliente elegido no es válido: vuelve a elegirlo.', { campo: 'clienteId' });
    }
    sendOk(
      res,
      await ingresosExtractorService.confirmar(req.companyId!, documentId, { revisado, userId: req.user?.userId, lineas, clienteId: clienteId ? clienteId.trim() : undefined }),
      undefined,
      201,
    );
  }),
};
