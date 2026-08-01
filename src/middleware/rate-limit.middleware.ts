import { RequestHandler } from 'express';

/**
 * Rate limiting basico en memoria por IP (ventana deslizante simple).
 *
 * NOTA OWASP API4:2023 (Unrestricted Resource Consumption): en produccion el
 * rate limiting deberia hacerse a nivel de GATEWAY/reverse-proxy (Nginx, API
 * Gateway, Cloudflare) o con un store distribuido (Redis). Este middleware es un
 * fallback en proceso, no apto para multi-instancia.
 */
export function rateLimit(opts: { ventanaMs?: number; max?: number } = {}): RequestHandler {
  const ventanaMs = opts.ventanaMs ?? 60_000;
  const max = opts.max ?? 120;
  // Cada limitador tiene su PROPIO store: asi el limite estricto de /auth no se
  // mezcla con el global ni con el de /chat-assistant (antes compartian un Map).
  const hits = new Map<string, number[]>();
  return (req, res, next) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const ahora = Date.now();
    const previos = (hits.get(ip) ?? []).filter((t) => ahora - t < ventanaMs);
    if (previos.length >= max) {
      res.setHeader('Retry-After', Math.ceil(ventanaMs / 1000));
      res.status(429).json({ message: 'Demasiadas peticiones, intentalo mas tarde.', statusCode: 429 });
      return;
    }
    previos.push(ahora);
    hits.set(ip, previos);
    next();
  };
}
