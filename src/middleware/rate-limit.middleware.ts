import { Request, RequestHandler } from 'express';

export interface RateLimitOpts {
  ventanaMs?: number;
  max?: number;
  /**
   * Agrupacion de la cuota. Por defecto la IP. Usar `porEmail()` para limitar
   * por cuenta y frenar el brute-force distribuido (muchas IPs, un solo email).
   */
  keyGenerator?: (req: Request) => string;
  /**
   * Si true, las respuestas < 400 devuelven la cuota consumida. Evita que el
   * uso legitimo agote el limite: solo penaliza intentos fallidos.
   */
  soloFallos?: boolean;
  mensaje?: string;
}

/** Clave por cuenta, normalizada para que `A@X.com` y `a@x.com` compartan cuota. */
export function porEmail(req: Request): string {
  const email = String((req.body as { email?: unknown } | undefined)?.email ?? '')
    .trim()
    .toLowerCase();
  return `email:${email}`;
}

/**
 * Rate limiting basico en memoria (ventana deslizante simple).
 *
 * NOTA OWASP API4:2023 (Unrestricted Resource Consumption): en produccion el
 * rate limiting deberia hacerse a nivel de GATEWAY/reverse-proxy (Nginx, API
 * Gateway, Cloudflare) o con un store distribuido (Redis). Este middleware es un
 * fallback en proceso, no apto para multi-instancia.
 */
export function rateLimit(opts: RateLimitOpts = {}): RequestHandler {
  const ventanaMs = opts.ventanaMs ?? 60_000;
  const max = opts.max ?? 120;
  const keyGenerator = opts.keyGenerator ?? ((req: Request) => req.ip ?? req.socket.remoteAddress ?? 'unknown');
  const soloFallos = opts.soloFallos ?? false;
  const mensaje = opts.mensaje ?? 'Demasiadas peticiones, intentalo mas tarde.';

  // Cada limitador tiene su PROPIO store: asi el limite estricto de /auth no se
  // mezcla con el global ni con el de /chat-assistant (antes compartian un Map).
  const hits = new Map<string, number[]>();
  let ultimaPurga = Date.now();

  /**
   * Barrido de claves caducadas. Sin esto el Map crece una entrada por cada
   * clave vista y nunca la suelta (fuga de memoria / DoS a largo plazo).
   * Se ejecuta como mucho una vez por ventana: O(n) amortizado, no por peticion.
   */
  function purgar(ahora: number): void {
    if (ahora - ultimaPurga < ventanaMs) return;
    ultimaPurga = ahora;
    for (const [clave, marcas] of hits) {
      const vivas = marcas.filter((t) => ahora - t < ventanaMs);
      if (vivas.length === 0) hits.delete(clave);
      else hits.set(clave, vivas);
    }
  }

  return (req, res, next) => {
    const ahora = Date.now();
    purgar(ahora);

    const clave = keyGenerator(req);
    const previos = (hits.get(clave) ?? []).filter((t) => ahora - t < ventanaMs);

    if (previos.length >= max) {
      hits.set(clave, previos); // persiste el filtrado: no reevaluar marcas muertas
      res.setHeader('Retry-After', Math.ceil(ventanaMs / 1000));
      res.status(429).json({ message: mensaje, statusCode: 429 });
      return;
    }

    previos.push(ahora);
    hits.set(clave, previos);

    if (soloFallos) {
      res.on('finish', () => {
        if (res.statusCode >= 400) return; // fallo: la marca se queda
        const marcas = hits.get(clave);
        if (!marcas) return;
        const i = marcas.indexOf(ahora);
        if (i !== -1) marcas.splice(i, 1);
        if (marcas.length === 0) hits.delete(clave);
      });
    }

    next();
  };
}
