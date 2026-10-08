/**
 * /accounting/closures (Archivo de documentos de cierre): todas las rutas piden
 * permiso (lecturas contabilidad:read, escrituras contabilidad:write) y ninguna
 * se declara dos veces. Express usa la primera declaracion: una ruta repetida
 * sin authorize delante de la buena dejaria la lectura abierta (estatico, sin BD).
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

const FUENTE = readFileSync(join(__dirname, '..', 'routes', 'accounting-closure.routes.ts'), 'utf8');

/** [metodo, ruta, resto de la declaracion hasta el cierre del parentesis]. */
function rutas(): Array<{ metodo: string; ruta: string; cuerpo: string }> {
  const out: Array<{ metodo: string; ruta: string; cuerpo: string }> = [];
  const re = /router\.(get|post|put|patch|delete)\(\s*'([^']+)'([\s\S]*?)\);/g;
  for (let m = re.exec(FUENTE); m; m = re.exec(FUENTE)) out.push({ metodo: m[1].toUpperCase(), ruta: m[2], cuerpo: m[3] });
  return out;
}

describe('accounting-closure.routes', () => {
  it('cada lectura pide contabilidad:read y cada escritura contabilidad:write', () => {
    const lista = rutas();
    expect(lista.length).toBeGreaterThanOrEqual(11);
    for (const r of lista) {
      const permiso = r.metodo === 'GET' ? 'contabilidad:read' : 'contabilidad:write';
      expect([r.metodo, r.ruta, r.cuerpo.includes(`authorize('${permiso}')`)]).toEqual([r.metodo, r.ruta, true]);
    }
  });

  it('ninguna ruta se declara dos veces', () => {
    const claves = rutas().map((r) => `${r.metodo} ${r.ruta}`);
    expect(claves.filter((c, i) => claves.indexOf(c) !== i)).toEqual([]);
  });
});
