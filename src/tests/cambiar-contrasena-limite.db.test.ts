/**
 * POST /auth/cambiar-contrasena: limite de intentos fallidos POR USUARIO (BD real).
 *
 * Va en un fichero propio: los limitadores viven en memoria por instancia de
 * modulo y Jest crea un registro de modulos por fichero, asi que aqui no se
 * mezcla con las llamadas de otros tests. Para no chocar con el limite por IP
 * (10/min), cada peticion sale de una IP distinta (X-Forwarded-For; la app
 * tiene trust proxy = 1): lo que se comprueba es el limitador por usuario.
 *
 * Solo corre en CI o contra una BD local. La contrasena se genera en cada
 * ejecucion y al terminar se borra lo creado.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { randomBytes } from 'crypto';
import request from 'supertest';
import { app } from '../app';
import { prisma } from '../config/database';
import { authService } from '../services/auth.service';
import { hashPassword, verifyPassword } from '../utils/password';

function hostDeLaBd(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? '').hostname;
  } catch {
    return '';
  }
}
const BD_DE_PRUEBAS = process.env.CI === 'true' || ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostDeLaBd());
const describeBd = BD_DE_PRUEBAS ? describe : describe.skip;

const SUFIJO = `${Date.now()}${randomBytes(3).toString('hex')}`;
const CONTRASENA = randomBytes(18).toString('base64url');

describeBd('cambiar la contraseña: límite de intentos por usuario (BD real)', () => {
  let userId: string;
  let token: string;

  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { email: `limite-${SUFIJO}@test.local`, passwordHash: hashPassword(CONTRASENA), debeCambiarContrasena: true },
      select: { id: true, email: true },
    });
    userId = u.id;
    token = (await authService.login({ email: u.email, password: CONTRASENA })).token;
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it('10 intentos con la actual errónea: el 11.º da 429 aunque cambie la IP', async () => {
    const intento = (i: number) =>
      request(app)
        .post('/auth/cambiar-contrasena')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Forwarded-For', `10.77.0.${i + 1}`)
        .send({ actual: `mala-${i}-${randomBytes(6).toString('hex')}`, nueva: randomBytes(18).toString('base64url') });

    for (let i = 0; i < 10; i++) {
      const res = await intento(i);
      expect(`${i} ${res.status} ${res.body.details?.campo}`).toBe(`${i} 400 actual`);
    }
    const bloqueado = await intento(10);
    expect(bloqueado.status).toBe(429);
    expect(bloqueado.body.message).toBe('Demasiados intentos. Espera unos minutos y vuelve a probar.');

    // Nada ha cambiado en la BD.
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true, debeCambiarContrasena: true } });
    expect(verifyPassword(CONTRASENA, u.passwordHash)).toBe(true);
    expect(u.debeCambiarContrasena).toBe(true);
  });
});
