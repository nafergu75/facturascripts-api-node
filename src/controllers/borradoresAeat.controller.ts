import { Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import {
  borrador200,
  borrador347,
  borrador390,
  fichero200,
  fichero347,
  fichero390,
  opciones200De,
  opciones390De,
  type Opciones200,
  type Opciones390,
} from '../services/borradoresAeat.service';
import { DISENO_390 } from '../aeat/oficial/modelo390';
import { DISENO_200 } from '../aeat/oficial/modelo200';
import type { PaginaOficial } from '../aeat/oficial/diseno';

/**
 * Borradores de los modelos 347, 390 y 200 con el diseño oficial de la AEAT
 * (montado en /companies/:companyId/impuestos/borradores). La pantalla y el
 * fichero salen del mismo cálculo. Los dos GET solo leen (B6): la persona de
 * contacto sale de Datos de la empresa (apartado Contacto) (B3) y la complementaria,
 * sustitutiva o rectificativa, del historial de declaraciones (B4).
 */

const MODELOS = ['347', '390', '200'] as const;
type Modelo = (typeof MODELOS)[number];

function modeloDe(req: Request): Modelo {
  const m = String(req.params.modelo);
  if (!(MODELOS as readonly string[]).includes(m)) throw badRequest(`No hay borrador del modelo ${m}. Están el 347, el 390 y el 200.`);
  return m as Modelo;
}

function ejercicioDe(req: Request): number {
  const e = Number(req.query.ejercicio);
  if (!Number.isInteger(e) || e < 2000 || e > 2100) throw badRequest('Indica el ejercicio (por ejemplo, ?ejercicio=2027).');
  return e;
}

const opciones390 = (req: Request): Opciones390 => opciones390De(req.query as Record<string, unknown>);
const opciones200 = (req: Request): Opciones200 => opciones200De(req.query as Record<string, unknown>);

/** Texto corto de una casilla para la pantalla: sin el apartado inicial ni el número entre corchetes. */
function descripcionCorta(desc: string): string {
  const partes = desc.replace(/\s*\[\d+\]\.?\s*$/, '').split(' - ');
  return (partes.length > 2 ? partes.slice(1) : partes).join(' - ').trim();
}

/** Casillas de cada página con su descripción oficial, en el orden del diseño. */
function conDetalle<P extends { codigo: string; casillas: Record<string, number | string> }>(paginas: P[], disenos: Record<string, PaginaOficial>) {
  return paginas.map((p) => {
    const vistas = new Set<string>();
    const detalle = disenos[p.codigo].campos
      .filter((c) => c.casilla !== undefined && p.casillas[c.casilla] !== undefined && !vistas.has(c.casilla) && vistas.add(c.casilla))
      .map((c) => ({ casilla: c.casilla!, descripcion: descripcionCorta(c.desc), valor: p.casillas[c.casilla!] }));
    return { ...p, detalle };
  });
}

function enviarFichero(res: Response, nombre: string, contenido: string): void {
  res.setHeader('Content-Type', 'text/plain; charset=ISO-8859-1');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  res.status(200).send(Buffer.from(contenido, 'latin1'));
}

export const borradoresAeatController = {
  /** GET /impuestos/borradores/:modelo?ejercicio=2027 — casillas, páginas y avisos. */
  borrador: asyncHandler(async (req, res) => {
    const modelo = modeloDe(req);
    const ejercicio = ejercicioDe(req);
    const b =
      modelo === '347'
        ? await borrador347(req.companyId!, ejercicio)
        : modelo === '390'
          ? await borrador390(req.companyId!, ejercicio, opciones390(req))
          : await borrador200(req.companyId!, ejercicio, opciones200(req));
    // El fichero se descarga aparte: no hace falta repetirlo en la respuesta.
    const { fichero: _fichero, ...resto } = b;
    if ('paginas' in resto) {
      const disenos = modelo === '390' ? DISENO_390.paginas : DISENO_200.paginas;
      sendOk(res, { modelo, ...resto, paginas: conDetalle(resto.paginas, disenos) });
      return;
    }
    sendOk(res, { modelo, ...resto });
  }),

  /** GET /impuestos/borradores/:modelo/fichero?ejercicio=2027 — fichero importable en la sede (ISO-8859-1). */
  fichero: asyncHandler(async (req, res) => {
    const modelo = modeloDe(req);
    const ejercicio = ejercicioDe(req);
    const f =
      modelo === '347'
        ? await fichero347(req.companyId!, ejercicio)
        : modelo === '390'
          ? await fichero390(req.companyId!, ejercicio, opciones390(req))
          : await fichero200(req.companyId!, ejercicio, opciones200(req));
    enviarFichero(res, f.nombre, f.contenido);
  }),
};
