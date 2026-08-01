import { RequestHandler } from 'express';
import { config } from '../config/env';

/**
 * Cabeceras de seguridad equivalentes a las de `helmet`, implementadas a mano
 * para no añadir dependencias (entorno sin instalación de paquetes garantizada).
 *
 * Cubre OWASP "Security Headers": evita sniffing de MIME, clickjacking, fuga de
 * referer y, en producción, fuerza HTTPS (HSTS). La CSP se mantiene laxa porque
 * la API sirve JSON + Swagger UI (que usa estilos/scripts inline); endurecerla
 * más requeriría nonces en Swagger.
 */
export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');

  // HSTS: solo en producción (en local rompería http://localhost).
  if (config.isProd) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }

  next();
};
