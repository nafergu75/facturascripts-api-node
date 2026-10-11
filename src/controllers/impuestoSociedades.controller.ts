import { Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import { calcularModelo200 } from '../services/impuestoSociedadesCalculo.service';
import { fichero200 } from '../services/borradoresAeat.service';

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

  // GET /companies/:companyId/modelo-200/fichero?ejercicio=2026
  // Mismo fichero que /impuestos/borradores/200/fichero (diseño oficial). El NIF
  // y la razón social salen de los datos de la empresa, no de la URL.
  fichero: asyncHandler(async (req, res) => {
    const ejercicio = parseEjercicio(req.query.ejercicio);
    const { nombre, contenido } = await fichero200(req.companyId!, ejercicio);
    enviarFichero(res, nombre, contenido);
  }),
};
