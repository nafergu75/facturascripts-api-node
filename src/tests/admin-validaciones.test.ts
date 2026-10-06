// Modo administrador global: validaciones y control de acceso, sin BD.
//
// Regresion: ROLES_VALIDOS incluia 'tesoreria', que no existe en el enum Role
// de la BD; asignarlo pasaba la validacion y reventaba en Prisma con un 500.
jest.mock('../config/database', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    company: { findMany: jest.fn() },
    legalConfig: { findMany: jest.fn() },
  },
  connectDatabase: jest.fn(),
  disconnectDatabase: jest.fn(),
}));

import request from 'supertest';
import { app } from '../app';
import { prisma } from '../config/database';
import { authService } from '../services/auth.service';
import { authorize } from '../middleware/authorize.middleware';
import {
  CONTRASENA_MIN,
  ROLES_VALIDOS,
  comprobarQuedaAdminGlobal,
  leerBooleano,
  normalizarCodigoEmpresa,
  normalizarEmail,
  normalizarNombreEmpresa,
  normalizarRol,
  validarContrasena,
} from '../services/admin.service';

const bd = prisma as unknown as {
  user: { findUnique: jest.Mock };
  company: { findMany: jest.Mock };
  legalConfig: { findMany: jest.Mock };
};

const estado = (fn: () => unknown): number | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as { statusCode?: number }).statusCode;
  }
};

describe('roles que se pueden asignar', () => {
  it('son exactamente los del enum Role de la BD (sin tesoreria)', () => {
    expect([...ROLES_VALIDOS].sort()).toEqual(['admin', 'contable', 'solo_lectura', 'ventas']);
  });

  it('acepta solo-lectura con guion y lo guarda como solo_lectura', () => {
    expect(normalizarRol('solo-lectura')).toBe('solo_lectura');
    expect(normalizarRol(' contable ')).toBe('contable');
  });

  it('rechaza tesoreria, roles inventados y valores vacios con 400', () => {
    for (const malo of ['tesoreria', 'superadmin', '', undefined, 3]) expect(estado(() => normalizarRol(malo))).toBe(400);
  });
});

describe('email', () => {
  it('lo pasa a minusculas y quita espacios', () => {
    expect(normalizarEmail('  Ana.Perez@Empresa.ES ')).toBe('ana.perez@empresa.es');
  });

  it('rechaza formatos raros o peligrosos', () => {
    for (const malo of ['', 'sin-arroba', 'a@b', "o'neil@x.com", 'a b@x.com', 'a@x.com;DROP', 'a@-', undefined]) {
      expect(estado(() => normalizarEmail(malo))).toBe(400);
    }
  });
});

describe('contrasena', () => {
  it(`exige al menos ${CONTRASENA_MIN} caracteres`, () => {
    expect(estado(() => validarContrasena('corta-123'))).toBe(400);
    expect(validarContrasena('una-frase-larga-2026')).toBe('una-frase-larga-2026');
  });

  it('no admite un caracter repetido ni el propio email', () => {
    expect(estado(() => validarContrasena('aaaaaaaaaaaaaaaa'))).toBe(400);
    expect(estado(() => validarContrasena('pepe@empresa.es', 'Pepe@Empresa.es'))).toBe(400);
  });

  it('rechaza valores que no son texto', () => {
    expect(estado(() => validarContrasena(undefined))).toBe(400);
    expect(estado(() => validarContrasena(123456789012345))).toBe(400);
  });
});

describe('empresa', () => {
  it('limpia el nombre y exige que tenga contenido', () => {
    expect(normalizarNombreEmpresa('  Talleres   Lopez SL ')).toBe('Talleres Lopez SL');
    expect(estado(() => normalizarNombreEmpresa('   '))).toBe(400);
    expect(estado(() => normalizarNombreEmpresa('x'.repeat(121)))).toBe(400);
  });

  it('el codigo es opcional y solo lleva letras, numeros, - y _', () => {
    expect(normalizarCodigoEmpresa(undefined)).toBeNull();
    expect(normalizarCodigoEmpresa('  ')).toBeNull();
    expect(normalizarCodigoEmpresa(' TL-01 ')).toBe('TL-01');
    for (const malo of ['a', 'con espacio', "x'; --", 'ñandu', 5]) expect(estado(() => normalizarCodigoEmpresa(malo))).toBe(400);
  });
});

describe('booleanos del cuerpo', () => {
  it('undefined si no viene; error si no es true/false', () => {
    expect(leerBooleano(undefined, 'activo')).toBeUndefined();
    expect(leerBooleano(false, 'activo')).toBe(false);
    expect(estado(() => leerBooleano('false', 'activo'))).toBe(400);
  });
});

describe('nunca sin administrador global', () => {
  it('deja quitar el permiso si queda otro administrador activo', () => {
    expect(() => comprobarQuedaAdminGlobal(['a', 'b'], 'b')).not.toThrow();
  });

  it('no deja quitarselo al unico (409)', () => {
    expect(estado(() => comprobarQuedaAdminGlobal(['a'], 'a'))).toBe(409);
    expect(estado(() => comprobarQuedaAdminGlobal([], 'a'))).toBe(409);
  });
});

describe("authorize('admin:global')", () => {
  const pasa = (user: Record<string, unknown>) => {
    const next = jest.fn();
    authorize('admin:global')({ user, companyId: 'A' } as never, {} as never, next);
    return next.mock.calls[0][0] === undefined;
  };

  it('el admin de una empresa (comodin *) NO es admin global', () => {
    expect(pasa({ userId: 'u', roles: ['admin'], rolesPorEmpresa: { A: ['admin'] }, companies: ['A'] })).toBe(false);
  });

  it('el administrador global pasa', () => {
    expect(pasa({ userId: 'u', roles: [], companies: [], esAdminGlobal: true })).toBe(true);
  });
});

describe('rutas /admin por HTTP', () => {
  const token = (claims: Partial<Parameters<typeof authService.generateToken>[0]>) =>
    authService.generateToken({ userId: 'u1', email: 'u1@test.local', roles: [], companies: [], ...claims });

  const RUTAS: Array<['get' | 'post' | 'put' | 'patch' | 'delete', string]> = [
    ['get', '/admin/empresas'],
    ['post', '/admin/empresas'],
    ['patch', '/admin/empresas/E1'],
    ['get', '/admin/usuarios'],
    ['post', '/admin/usuarios'],
    ['patch', '/admin/usuarios/U2'],
    ['put', '/admin/usuarios/U2/empresas/E1'],
    ['delete', '/admin/usuarios/U2/empresas/E1'],
    ['post', '/admin/usuarios/U2/empresas/E1'],
  ];

  it.each(RUTAS)('%s %s sin token responde 401', async (metodo, ruta) => {
    const res = await request(app)[metodo](ruta).send({});
    expect(res.status).toBe(401);
  });

  it.each(RUTAS)('%s %s con el admin de una empresa responde 403', async (metodo, ruta) => {
    const t = token({ roles: ['admin'], rolesPorEmpresa: { E1: ['admin'] }, companies: ['E1'] });
    const res = await request(app)[metodo](ruta).set('Authorization', `Bearer ${t}`).send({});
    expect(res.status).toBe(403);
    expect(bd.user.findUnique).not.toHaveBeenCalled();
  });

  it('un token de administrador ya retirado en la BD recibe 403', async () => {
    bd.user.findUnique.mockResolvedValueOnce({ isActive: true, isGlobalAdmin: false });
    const res = await request(app).get('/admin/empresas').set('Authorization', `Bearer ${token({ esAdminGlobal: true })}`);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/vuelve a entrar/);
  });

  it('un administrador desactivado en la BD recibe 403', async () => {
    bd.user.findUnique.mockResolvedValueOnce({ isActive: false, isGlobalAdmin: true });
    const res = await request(app).get('/admin/usuarios').set('Authorization', `Bearer ${token({ esAdminGlobal: true })}`);
    expect(res.status).toBe(403);
  });

  it('el administrador vigente lista las empresas con NIF, pais y usuarios', async () => {
    bd.user.findUnique.mockResolvedValueOnce({ isActive: true, isGlobalAdmin: true });
    bd.company.findMany.mockResolvedValueOnce([
      { id: 'E1', codigo: 'TL', name: 'Talleres', isActive: true, createdAt: new Date('2026-01-02'), _count: { memberships: 3 } },
      { id: 'E2', codigo: null, name: 'Nueva', isActive: false, createdAt: new Date('2026-02-03'), _count: { memberships: 0 } },
    ]);
    bd.legalConfig.findMany.mockResolvedValueOnce([{ companyId: 'E1', denominacion: 'Talleres SL', nif: 'B12345678', pais: 'ES' }]);
    const res = await request(app).get('/admin/empresas').set('Authorization', `Bearer ${token({ esAdminGlobal: true })}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      expect.objectContaining({ id: 'E1', nombre: 'Talleres', nif: 'B12345678', pais: 'ES', usuarios: 3, activa: true }),
      expect.objectContaining({ id: 'E2', nombre: 'Nueva', nif: null, pais: null, usuarios: 0, activa: false }),
    ]);
  });
});
