import type { RequestHandler } from 'express';
import { llevanzaExterna } from '../services/periodos.service';

/** Texto del aviso en los modelos de un año que llevo la gestoria. */
export const textoModeloGestoria = (anio: number) =>
  `Este modelo de ${anio} lo presenta tu gestoría: lo que ves aquí sale solo de lo que hay en la app de ${anio}. No lo presentes desde aquí.`;

/**
 * Modelos de la AEAT de un año que llevo la gestoria (Traer la contabilidad de
 * 2026): la consulta no se bloquea, pero la respuesta lleva el aviso
 * (avisoGestoria en los datos y la cabecera X-Aviso-Gestoria).
 */
export const avisoModelosGestoria: RequestHandler = async (req, res, next) => {
  if (req.method !== 'GET' || !req.companyId) return next();
  const anio = Number(req.query.ejercicio);
  if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) return next();
  try {
    if (!(await llevanzaExterna(req.companyId, anio))) return next();
  } catch {
    return next();
  }
  const texto = textoModeloGestoria(anio);
  res.setHeader('X-Aviso-Gestoria', encodeURIComponent(texto));
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const b = body as Record<string, unknown>;
      const destino = b.data && typeof b.data === 'object' && !Array.isArray(b.data) ? (b.data as Record<string, unknown>) : b;
      destino.avisoGestoria = texto;
    }
    return json(body);
  };
  return next();
};
