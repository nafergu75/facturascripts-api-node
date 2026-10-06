import express, { Express, RequestHandler } from 'express';
import request from 'supertest';
import { porEmail, rateLimit, RateLimitOpts } from '../middleware/rate-limit.middleware';

/** App minima: aisla el middleware de rutas, Prisma y JWT. */
function crearApp(opts: RateLimitOpts, handler?: RequestHandler): Express {
  const app = express();
  app.use(express.json());
  app.post('/probar', rateLimit(opts), handler ?? ((_req, res) => void res.status(200).json({ ok: true })));
  return app;
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('rateLimit', () => {
  it('deja pasar hasta max y responde 429 con Retry-After al superarlo', async () => {
    const app = crearApp({ ventanaMs: 60_000, max: 3 });

    for (let i = 0; i < 3; i++) {
      const ok = await request(app).post('/probar').send({});
      expect(ok.status).toBe(200);
    }

    const bloqueado = await request(app).post('/probar').send({});
    expect(bloqueado.status).toBe(429);
    expect(bloqueado.headers['retry-after']).toBe('60');
    expect(bloqueado.body.statusCode).toBe(429);
  });

  it('libera la cuota una vez pasada la ventana', async () => {
    const app = crearApp({ ventanaMs: 100, max: 1 });

    expect((await request(app).post('/probar').send({})).status).toBe(200);
    expect((await request(app).post('/probar').send({})).status).toBe(429);

    await dormir(150);
    expect((await request(app).post('/probar').send({})).status).toBe(200);
  });

  describe('keyGenerator porEmail', () => {
    it('separa la cuota por cuenta aunque compartan IP', async () => {
      const app = crearApp({ ventanaMs: 60_000, max: 1, keyGenerator: porEmail });

      expect((await request(app).post('/probar').send({ email: 'a@x.com' })).status).toBe(200);
      expect((await request(app).post('/probar').send({ email: 'a@x.com' })).status).toBe(429);

      // Misma IP, otra cuenta: cuota intacta.
      expect((await request(app).post('/probar').send({ email: 'b@x.com' })).status).toBe(200);
    });

    it('normaliza mayusculas y espacios para que no se esquive el limite', async () => {
      const app = crearApp({ ventanaMs: 60_000, max: 1, keyGenerator: porEmail });

      expect((await request(app).post('/probar').send({ email: 'a@x.com' })).status).toBe(200);
      expect((await request(app).post('/probar').send({ email: '  A@X.COM ' })).status).toBe(429);
    });
  });

  describe('soloFallos', () => {
    it('no consume cuota cuando la respuesta es < 400', async () => {
      const app = crearApp({ ventanaMs: 60_000, max: 2, soloFallos: true });

      for (let i = 0; i < 5; i++) {
        expect((await request(app).post('/probar').send({})).status).toBe(200);
        await dormir(10); // deja correr el listener de 'finish'
      }
    });

    it('si consume cuota cuando la respuesta es >= 400', async () => {
      const app = crearApp({ ventanaMs: 60_000, max: 2, soloFallos: true }, (_req, res) => {
        res.status(401).json({ message: 'Credenciales invalidas.' });
      });

      expect((await request(app).post('/probar').send({})).status).toBe(401);
      await dormir(10);
      expect((await request(app).post('/probar').send({})).status).toBe(401);
      await dormir(10);
      expect((await request(app).post('/probar').send({})).status).toBe(429);
    });

    it('un acierto entre fallos no reinicia los fallos ya acumulados', async () => {
      let fallar = true;
      const app = crearApp({ ventanaMs: 60_000, max: 2, soloFallos: true }, (_req, res) => {
        res.status(fallar ? 401 : 200).json({ ok: !fallar });
      });

      expect((await request(app).post('/probar').send({})).status).toBe(401);
      await dormir(10);

      fallar = false;
      expect((await request(app).post('/probar').send({})).status).toBe(200);
      await dormir(10);

      fallar = true;
      expect((await request(app).post('/probar').send({})).status).toBe(401);
      await dormir(10);
      expect((await request(app).post('/probar').send({})).status).toBe(429);
    });
  });
});
