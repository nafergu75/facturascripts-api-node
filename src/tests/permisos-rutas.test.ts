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
    for (const m of codigo.matchAll(/authorize\(\s*'([^']+)'\s*\)/g)) pedidos.push({ fichero, permiso: m[1] });
  }
  return pedidos;
}

describe('permisos que exigen las rutas', () => {
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

  it('solo-lectura lee compras pero no escribe', () => {
    const lectura = permisosDeRoles(['solo-lectura']);
    expect(usuarioTienePermiso(lectura, 'compras:read')).toBe(true);
    expect(usuarioTienePermiso(lectura, 'compras:write')).toBe(false);
  });
});
