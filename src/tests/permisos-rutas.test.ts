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
  // PENDIENTE: el OCR sirve a compras y a ventas; falta decidir el permiso.
  'ocr.routes.ts POST /ocr/invoices': 'pendiente de permiso',
  'ocr.routes.ts POST /ocr/cleanup': 'pendiente de permiso',
  'ocr-sessions.routes.ts POST /ocr/sessions/:sessionId/retry': 'pendiente de permiso',
  'ocr-sessions.routes.ts POST /ocr/sessions/:sessionId/send-to-reader': 'pendiente de permiso',
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

  it('solo-lectura lee compras pero no escribe', () => {
    const lectura = permisosDeRoles(['solo-lectura']);
    expect(usuarioTienePermiso(lectura, 'compras:read')).toBe(true);
    expect(usuarioTienePermiso(lectura, 'compras:write')).toBe(false);
  });
});
