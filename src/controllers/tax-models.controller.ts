/**
 * TAX MODELS CONTROLLER - Endpoints para Modelos Fiscales
 */

import { Request, Response } from 'express';
import { periodoRetenciones, taxModelsService } from '../services/tax-models.service';
import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import { opcionesBorrador303DeQuery, periodo303De } from '../services/impuestosModulo.service';

/**
 * Periodo del 111 o del 115 en la consulta: `periodo` ('1T'..'4T' o '01'..'12')
 * o, como antes, `trimestre` (1-4). 400 si no viene ninguno.
 */
function periodoDeConsulta(periodo: unknown, trimestre: unknown): string | number {
  if (periodo !== undefined && periodo !== null && String(periodo).trim() !== '') return String(periodo);
  if (trimestre !== undefined && trimestre !== null && String(trimestre).trim() !== '') {
    const t = Number(trimestre);
    if (!Number.isInteger(t)) throw badRequest('El trimestre va del 1 al 4.');
    return t;
  }
  throw badRequest('Indica el periodo: un trimestre (1T a 4T) o un mes (01 a 12).');
}

export class TaxModelsController {
  /**
   * GET /tax-models/303
   * Generar o recuperar modelo 303 (IVA trimestral, o mensual con periodo=01..12)
   */
  obtenerModelo303 = asyncHandler(async (req: Request, res: Response) => {
    const { companyId } = req.params;
    const { ejercicio, trimestre, periodo } = req.query;
    const userId = (req as any).user?.id || 'SYSTEM';

    if (!ejercicio || (!trimestre && !periodo)) {
      return res.status(400).json({
        error: 'Parameters "ejercicio" and "trimestre" (or "periodo") required',
      });
    }

    // Opciones del borrador: tipo de declaracion, cuotas a compensar y cuenta bancaria.
    const resultado = await taxModelsService.generarModelo303(
      companyId,
      parseInt(ejercicio as string),
      periodo303De(periodo ?? trimestre),
      userId,
      opcionesBorrador303DeQuery(req.query as Record<string, unknown>)
    );

    sendOk(res, resultado);
  });

  /**
   * POST /tax-models/303/presentado
   * Marcar modelo 303 como presentado
   */
  marcar303Presentado = asyncHandler(async (req: Request, res: Response) => {
    const { companyId } = req.params;
    const { ejercicio, trimestre, periodo, justificante } = req.body;
    const userId = (req as any).user?.id || 'SYSTEM';

    if (!justificante?.numero || !justificante?.fecha) {
      return res.status(400).json({
        error: 'Body must include justificante with numero and fecha',
      });
    }

    // Trimestre (1-4) o, en el 303 mensual, periodo '01'..'12'.
    const resultado = await taxModelsService.marcarPresentado(
      companyId,
      '303',
      ejercicio,
      periodo303De(periodo ?? trimestre),
      justificante,
      userId
    );

    sendOk(res, resultado, { message: 'Modelo 303 marcado como presentado' });
  });

  /**
   * GET /tax-models/111
   * Generar o recuperar modelo 111 (retenciones)
   */
  obtenerModelo111 = asyncHandler(async (req: Request, res: Response) => {
    const { companyId } = req.params;
    const { ejercicio } = req.query;
    const userId = (req as any).user?.id || 'SYSTEM';

    if (!ejercicio || !/^\d{4}$/.test(String(ejercicio))) {
      throw badRequest('Indica el ejercicio (año con cuatro cifras).');
    }

    const resultado = await taxModelsService.generarModelo111(
      companyId,
      parseInt(ejercicio as string),
      periodoDeConsulta(req.query.periodo, req.query.trimestre),
      userId
    );

    sendOk(res, resultado);
  });

  /**
   * POST /tax-models/111/presentado
   * Marcar modelo 111 como presentado
   */
  marcar111Presentado = asyncHandler(async (req: Request, res: Response) => {
    const { companyId } = req.params;
    const { ejercicio, trimestre, justificante } = req.body;
    const userId = (req as any).user?.id || 'SYSTEM';

    if (!justificante?.numero || !justificante?.fecha) {
      return res.status(400).json({
        error: 'Body must include justificante with numero and fecha',
      });
    }

    const resultado = await taxModelsService.marcarPresentado(
      companyId,
      '111',
      ejercicio,
      periodoRetenciones(periodoDeConsulta(req.body.periodo, trimestre)),
      justificante,
      userId
    );

    sendOk(res, resultado, { message: 'Modelo 111 marcado como presentado' });
  });

  /**
   * POST /tax-models/200/presentado
   * Marcar modelo 200 como presentado
   */
  marcar200Presentado = asyncHandler(async (req: Request, res: Response) => {
    const { companyId } = req.params;
    const { ejercicio, justificante } = req.body;
    const userId = (req as any).user?.id || 'SYSTEM';

    if (!justificante?.numero || !justificante?.fecha) {
      return res.status(400).json({
        error: 'Body must include justificante with numero and fecha',
      });
    }

    const resultado = await taxModelsService.marcarPresentado(
      companyId,
      '200',
      ejercicio,
      '0A',
      justificante,
      userId
    );

    sendOk(res, resultado, { message: 'Modelo 200 marcado como presentado' });
  });

  /**
   * POST /tax-models/347/presentado
   * Marcar modelo 347 como presentado
   */
  marcar347Presentado = asyncHandler(async (req: Request, res: Response) => {
    const { companyId } = req.params;
    const { ejercicio, justificante } = req.body;
    const userId = (req as any).user?.id || 'SYSTEM';

    if (!justificante?.numero || !justificante?.fecha) {
      return res.status(400).json({
        error: 'Body must include justificante with numero and fecha',
      });
    }

    const resultado = await taxModelsService.marcarPresentado(
      companyId,
      '347',
      ejercicio,
      '0A',
      justificante,
      userId
    );

    sendOk(res, resultado, { message: 'Modelo 347 marcado como presentado' });
  });

  /**
   * GET /tax-models/115
   * Generar o recuperar modelo 115 (arrendamientos locales)
   */
  obtenerModelo115 = asyncHandler(async (req: Request, res: Response) => {
    const { companyId } = req.params;
    const { ejercicio, trimestre } = req.query;
    const userId = (req as any).user?.id || 'SYSTEM';

    if (!ejercicio || !/^\d{4}$/.test(String(ejercicio))) {
      throw badRequest('Indica el ejercicio (año con cuatro cifras).');
    }

    // Sin trimestre: el resumen anual por arrendador (los datos del 180). No guarda nada.
    if (!trimestre && !req.query.periodo) {
      sendOk(res, await taxModelsService.resumenAnual115(companyId, parseInt(ejercicio as string)));
      return;
    }

    const resultado = await taxModelsService.generarModelo115(
      companyId,
      parseInt(ejercicio as string),
      periodoDeConsulta(req.query.periodo, trimestre),
      userId
    );

    sendOk(res, resultado);
  });

  /**
   * POST /tax-models/115/presentado
   * Marcar modelo 115 como presentado
   */
  marcar115Presentado = asyncHandler(async (req: Request, res: Response) => {
    const { companyId } = req.params;
    const { ejercicio, trimestre, justificante } = req.body;
    const userId = (req as any).user?.id || 'SYSTEM';

    if (!justificante?.numero || !justificante?.fecha) {
      return res.status(400).json({
        error: 'Body must include justificante with numero and fecha',
      });
    }

    const resultado = await taxModelsService.marcarPresentado(
      companyId,
      '115',
      ejercicio,
      periodoRetenciones(periodoDeConsulta(req.body.periodo, trimestre)),
      justificante,
      userId
    );

    sendOk(res, resultado, { message: 'Modelo 115 marcado como presentado' });
  });

  /**
   * POST /tax-models/390/presentado
   * Marcar modelo 390 como presentado
   */
  marcar390Presentado = asyncHandler(async (req: Request, res: Response) => {
    const { companyId } = req.params;
    const { ejercicio, justificante } = req.body;
    const userId = (req as any).user?.id || 'SYSTEM';

    if (!justificante?.numero || !justificante?.fecha) {
      return res.status(400).json({
        error: 'Body must include justificante with numero and fecha',
      });
    }

    const resultado = await taxModelsService.marcarPresentado(
      companyId,
      '390',
      ejercicio,
      '0A',
      justificante,
      userId
    );

    sendOk(res, resultado, { message: 'Modelo 390 marcado como presentado' });
  });

  /**
   * GET /tax-models/190
   * Generar o recuperar modelo 190 (resumen anual de retenciones)
   */
  obtenerModelo190 = asyncHandler(async (req: Request, res: Response) => {
    const { companyId } = req.params;
    const { ejercicio } = req.query;
    const userId = (req as any).user?.id || 'SYSTEM';

    if (!ejercicio) {
      return res.status(400).json({
        error: 'Parameter "ejercicio" required',
      });
    }

    const resultado = await taxModelsService.generarModelo190(
      companyId,
      parseInt(ejercicio as string),
      userId
    );

    sendOk(res, resultado);
  });

  /**
   * POST /tax-models/190/presentado
   * Marcar modelo 190 como presentado
   */
  marcar190Presentado = asyncHandler(async (req: Request, res: Response) => {
    const { companyId } = req.params;
    const { ejercicio, justificante } = req.body;
    const userId = (req as any).user?.id || 'SYSTEM';

    if (!justificante?.numero || !justificante?.fecha) {
      return res.status(400).json({
        error: 'Body must include justificante with numero and fecha',
      });
    }

    const resultado = await taxModelsService.marcarPresentado(
      companyId,
      '190',
      ejercicio,
      '0A',
      justificante,
      userId
    );

    sendOk(res, resultado, { message: 'Modelo 190 marcado como presentado' });
  });

  /**
   * GET /tax-models
   * Listar modelos por empresa, código y/o ejercicio
   */
  listarModelos = asyncHandler(async (req: Request, res: Response) => {
    const { companyId } = req.params;
    const { codigo, ejercicio } = req.query;

    const modelos = await taxModelsService.listarModelos(
      companyId,
      codigo as string | undefined,
      ejercicio ? parseInt(ejercicio as string) : undefined
    );

    sendOk(res, modelos);
  });

  /**
   * GET /tax-models/:codigo/:ejercicio/:periodo
   * Obtener modelo específico
   */
  obtenerModeloEspecifico = asyncHandler(async (req: Request, res: Response) => {
    const { companyId, codigo, ejercicio, periodo } = req.params;

    const modelo = await taxModelsService.obtenerModelo(
      companyId,
      codigo,
      parseInt(ejercicio),
      periodo
    );

    sendOk(res, modelo);
  });
}

export const taxModelsController = new TaxModelsController();
