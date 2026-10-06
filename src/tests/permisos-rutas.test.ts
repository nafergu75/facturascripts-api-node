// Cada authorize('x') de las rutas debe pedir un permiso del catalogo RBAC.
//
// Regresion: 30 rutas pedian permisos inexistentes ('contable' y 'admin', que son
// nombres de ROL, y 'fiscal:*' / 'compras:*', que no estaban en el catalogo).
// Ningun rol los tiene, asi que solo el admin (comodin '*') pasaba: el rol
// contable recibia 403 en modelos fiscales, cierre contable y plan contable.
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { PERMISOS, permisosDeRoles, usuarioTienePermiso } from '../services/rbac.service';

const DIR_RUTAS = join(__dirname, '..', 'routes');

function permisosPedidosEnRutas(): Array<{ fichero: string; permiso: string }> {
  const pedidos: Array<{ fichero: string; permiso: string }> = [];
  for (const fichero of readdirSync(DIR_RUTAS).filter((f) => f.endsWith('.ts'))) {
    const codigo = readFileSync(join(DIR_RUTAS, fichero), 'utf-8');
    // authorize('a') o authorize('a', 'b'): se comprueba cada permiso.
    for (const m of codigo.matchAll(/authorize\(([^)]*)\)/g)) {
      for (const p of m[1].matchAll(/'([^']+)'/g)) pedidos.push({ fichero, permiso: p[1] });
    }
  }
  return pedidos;
}

/**
 * Rutas de escritura que pueden no llevar authorize(), con el motivo. Cualquier
 * otra ruta POST/PUT/PATCH/DELETE debe pedir un permiso.
 */
const ESCRITURA_SIN_PERMISO: Record<string, string> = {
  'auth.routes.ts POST /login': 'publica',
  'auth.routes.ts POST /dev-login': 'solo desarrollo, protegida por NODE_ENV',
  'auth.routes.ts POST /refresh': 'autenticada por el refresh token',
  'auth.routes.ts POST /logout': 'cerrar la propia sesion',
  'chatAssistant.routes.ts POST /': 'consulta al asistente, no modifica datos',
  'income-reader.routes.ts POST /email-hook': 'entrada de correo; acotada por companyScope',
};

function rutasEscrituraSinAuthorize(): string[] {
  const sin: string[] = [];
  for (const fichero of readdirSync(DIR_RUTAS).filter((f) => f.endsWith('.ts'))) {
    const codigo = readFileSync(join(DIR_RUTAS, fichero), 'utf-8');
    // router.<metodo>('<ruta>', ...middlewares...): basta con mirar hasta el cierre de la llamada.
    for (const m of codigo.matchAll(/\b\w+\.(post|put|patch|delete)\(\s*'([^']*)'([\s\S]*?)\);/g)) {
      const protegidoPorFichero = /\.use\(\s*authorize\(/.test(codigo);
      if (!m[3].includes('authorize(') && !protegidoPorFichero) sin.push(`${fichero} ${m[1].toUpperCase()} ${m[2]}`);
    }
  }
  return sin;
}

describe('permisos que exigen las rutas', () => {
  it('toda ruta de escritura pide un permiso (salvo excepciones justificadas)', () => {
    const sinPermiso = rutasEscrituraSinAuthorize().filter((r) => !(r in ESCRITURA_SIN_PERMISO));
    expect(sinPermiso).toEqual([]);
  });

  it('todos existen en el catalogo RBAC', () => {
    const catalogo = new Set(PERMISOS.map((p) => p.code));
    const inexistentes = permisosPedidosEnRutas().filter((p) => !catalogo.has(p.permiso));
    expect(inexistentes).toEqual([]);
  });

  it('el rol contable puede trabajar con impuestos, compras y contabilidad', () => {
    const contable = permisosDeRoles(['contable']);
    for (const p of ['impuestos:read', 'impuestos:write', 'compras:read', 'compras:write', 'contabilidad:write']) {
      expect(usuarioTienePermiso(contable, p)).toBe(true);
    }
  });

  it('authorize con varios permisos deja pasar a quien tenga uno de ellos', () => {
    const { authorize } = jest.requireActual('../middleware/authorize.middleware') as typeof import('../middleware/authorize.middleware');
    const pasa = (roles: string[]) => {
      const next = jest.fn();
      authorize('compras:write', 'ventas:write')({ user: { roles } } as never, {} as never, next);
      return next.mock.calls[0][0] === undefined;
    };
    expect(pasa(['ventas'])).toBe(true);
    expect(pasa(['contable'])).toBe(true);
    expect(pasa(['solo-lectura'])).toBe(false);
  });

  it('el rol solo_lectura de la BD tiene los mismos permisos que solo-lectura', () => {
    expect(permisosDeRoles(['solo_lectura']).sort()).toEqual(permisosDeRoles(['solo-lectura']).sort());
    expect(permisosDeRoles(['solo_lectura'])).toContain('tesoreria:read');
  });

  it('solo-lectura lee compras pero no escribe', () => {
    const lectura = permisosDeRoles(['solo-lectura']);
    expect(usuarioTienePermiso(lectura, 'compras:read')).toBe(true);
    expect(usuarioTienePermiso(lectura, 'compras:write')).toBe(false);
  });
});
