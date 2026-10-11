/**
 * Lecturas de facturas con Azure (y Claude de respaldo), para los dos lectores:
 *
 *  POST /<lector>/lecturas                 sube el archivo y empieza a leer (202) o lo lee ya (200)
 *  GET  /<lector>/lecturas/:id             estado de la lectura (la pantalla consulta cada pocos segundos)
 *  POST /<lector>/lecturas/:id/descartar   la deja descartada y borra el archivo
 *
 * La lectura se busca siempre con la empresa de la ruta y el lector: una
 * lectura de otra empresa o del otro lector da 404.
 */
import { Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import { asyncHandler } from '../utils/async-handler';
import { leerFacturaSubida } from '../utils/archivo-subido';
import { badRequest } from '../utils/http-errors';
import { sendOk } from '../utils/response';
import { consultarLectura, descartarLectura, iniciarLectura, MAX_ARCHIVO_LECTURA, MENSAJE_ARCHIVO_GRANDE } from '../services/lectura/lectura.service';
import type { Lector } from '../services/lectura/tipos';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ARCHIVO_LECTURA } });

/** Multipart (campo 'archivo') de 4 MB como mucho; si pasa, un 400 en castellano. */
export const subirArchivoLectura: RequestHandler = (req, res, next) =>
  upload.single('archivo')(req, res, (err?: unknown) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') return next(badRequest(MENSAJE_ARCHIVO_GRANDE, { codigo: 'ARCHIVO_GRANDE' }));
    if (err) return next(badRequest('No se pudo leer el archivo subido.'));
    next();
  });

export function controladorLecturas(lector: Lector) {
  return {
    crear: asyncHandler(async (req: Request, res: Response) => {
      let archivo;
      try {
        archivo = leerFacturaSubida(req);
      } catch (err) {
        throw badRequest((err as Error).message, { codigo: 'ARCHIVO_NO_VALIDO' });
      }
      const { status, data } = await iniciarLectura(req.companyId as string, req.user?.userId, lector, archivo);
      sendOk(res, data, undefined, status);
    }),

    consultar: asyncHandler(async (req: Request, res: Response) => {
      sendOk(res, await consultarLectura(req.companyId as string, lector, req.params.id));
    }),

    descartar: asyncHandler(async (req: Request, res: Response) => {
      await descartarLectura(req.companyId as string, lector, req.params.id);
      res.status(200).json({ ok: true });
    }),
  };
}

export const lecturasGastos = controladorLecturas('GASTO');
export const lecturasVentas = controladorLecturas('VENTA');
