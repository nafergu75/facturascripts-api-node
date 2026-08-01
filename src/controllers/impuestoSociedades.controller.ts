import { Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import { calcularModelo200 } from '../services/impuestoSociedadesCalculo.service';
import { generarFicheroModelo200 } from '../services/impuestosExport.service';

function parseEjercicio(raw: unknown): number {
  const e = Number(raw);
  if (!Number.isInteger(e) || e < 2000) throw badRequest('Parametro "ejercicio" invalido.');
  return e;
}

function enviarFichero(res: Response, nombre: string, contenido: string): void {
  res.setHeader('Content-Type', 'text/plain; charset=ISO-8859-1');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  res.status(200).send(Buffer.from(contenido, 'latin1'));
}

export const impuestoSociedadesController = {
  // GET /companies/:companyId/modelo-200/preview?ejercicio=2026
  preview: asyncHandler(async (req, res) => {
    const ejercicio = parseEjercicio(req.query.ejercicio);
    sendOk(res, await calcularModelo200(req.companyId!, ejercicio));
  }),

  // GET /companies/:companyId/modelo-200/fichero?ejercicio=2026&nif=...
  fichero: asyncHandler(async (req, res) => {
    const ejercicio = parseEjercicio(req.query.ejercicio);
    const nif = String(req.query.nif ?? '');
    const datos = await calcularModelo200(req.companyId!, ejercicio);
    const fichero = generarFicheroModelo200(nif, ejercicio, { razonSocial: datos.razonSocial });
    enviarFichero(res, `200_${ejercicio}.txt`, fichero);
  }),
};
