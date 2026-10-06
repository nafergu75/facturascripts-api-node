// Regresion: auth.service revoca refresh tokens por `jti`. Durante un tiempo el
// schema.prisma definia esa columna como `token`, asi que TODA revocacion
// lanzaba "Unknown argument `jti`" y el logout no invalidaba nada (la tabla
// RevokedToken permanecia vacia). Estos tests fijan el contrato.
//
// Se mockea Prisma (Map en memoria) para no depender de la BD. No se importa
// ../app a proposito: arrastra servicios con desfases de tipos ajenos a auth.
jest.mock('../config/database', () => {
  const revocados = new Map<string, { jti: string; userId: string; expiresAt: Date }>();
  return {
    __revocados: revocados,
    prisma: {
      user: { findUnique: jest.fn(() => Promise.resolve(null)) },
      revokedToken: {
        findUnique: jest.fn(({ where: { jti } }: { where: { jti: string } }) =>
          Promise.resolve(revocados.get(jti) ?? null),
        ),
        create: jest.fn(({ data }: { data: { jti: string; userId: string; expiresAt: Date } }) => {
          revocados.set(data.jti, data);
          return Promise.resolve(data);
        }),
        upsert: jest.fn(
          ({ where: { jti }, create }: { where: { jti: string }; create: { jti: string; userId: string; expiresAt: Date } }) => {
            if (!revocados.has(jti)) revocados.set(jti, create);
            return Promise.resolve(revocados.get(jti));
          },
        ),
        deleteMany: jest.fn(() => Promise.resolve({ count: 0 })),
      },
    },
    connectDatabase: jest.fn(),
    disconnectDatabase: jest.fn(),
  };
});

import { authService } from '../services/auth.service';
import { prisma } from '../config/database';

/** Extrae el jti del payload sin verificar firma. */
function jtiDe(token: string): string {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).jti;
}

const revokedToken = prisma.revokedToken as unknown as {
  findUnique: jest.Mock;
  create: jest.Mock;
  upsert: jest.Mock;
};

describe('revocacion de refresh tokens', () => {
  it('logout persiste el jti en RevokedToken', async () => {
    const refresh = authService.signRefreshToken('u-1');
    const jti = jtiDe(refresh);

    await authService.logout(refresh);

    const fila = await revokedToken.findUnique({ where: { jti } });
    expect(fila).not.toBeNull();
    expect(fila.userId).toBe('u-1');
  });

  it('guarda el jti, NO el JWT completo (la columna es jti, no token)', async () => {
    const refresh = authService.signRefreshToken('u-2');
    const jti = jtiDe(refresh);

    await authService.logout(refresh);

    const fila = await revokedToken.findUnique({ where: { jti } });
    expect(fila).toHaveProperty('jti', jti);
    expect(fila).not.toHaveProperty('token');
    // Un jti es un UUID, no un JWT: si esto falla es que se guardo el token entero.
    expect(fila.jti).not.toContain('.');
  });

  it('refresh rechaza un token ya revocado', async () => {
    const refresh = authService.signRefreshToken('u-3');
    await authService.logout(refresh);

    await expect(authService.refresh(refresh)).rejects.toThrow(/revocado/i);
  });

  it('refresh deja pasar un token NO revocado hasta la carga de usuario', async () => {
    const refresh = authService.signRefreshToken('u-4');

    // El usuario mockeado no existe: llegar a este error prueba que la
    // comprobacion de revocacion se supero sin bloquear.
    await expect(authService.refresh(refresh)).rejects.toThrow(/Usuario inactivo o inexistente/i);
  });

  it('logout es idempotente', async () => {
    const refresh = authService.signRefreshToken('u-5');

    await authService.logout(refresh);
    await expect(authService.logout(refresh)).resolves.toBeUndefined();
  });

  it('logout con un token invalido no lanza', async () => {
    await expect(authService.logout('esto-no-es-un-jwt')).resolves.toBeUndefined();
    expect(revokedToken.create).not.toHaveBeenCalled();
  });
});
