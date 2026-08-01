import { RequestHandler } from 'express';

/**
 * Marca una ruta como LEGACY siguiendo RFC 8594 (Deprecation/Sunset headers).
 * No altera el cuerpo de la respuesta: el frontend vanilla sigue recibiendo lo
 * mismo, pero clientes y proxies saben que el sucesor canónico es el spine
 * Prisma. Ver ADR-002 "Consolidación de spine: Prisma canónico".
 *
 * @param sucesor Ruta canónica que sustituye a esta (ej. '/companies/:companyId/invoices').
 */
export function deprecacion(sucesor: string): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('Deprecation', 'true');
    res.setHeader('Link', `<${sucesor}>; rel="successor-version"`);
    res.setHeader(
      'Warning',
      `299 - "Ruta legacy (spine FacturaScripts). Usa ${sucesor}. Se mantiene solo por compatibilidad con el frontend vanilla. Ver ADR-002."`,
    );
    next();
  };
}
