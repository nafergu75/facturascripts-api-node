/**
 * Plan base: cuentas de clientes y proveedores que traen los ficheros de otros
 * programas (401, 407, 431, 436, 438 y 490 con su subgrupo 49).
 */
import { describe, it, expect } from '@jest/globals';
import { PGC_BASE } from '../domain/pgc-model';

describe('PGC_BASE', () => {
  it.each([
    ['401', '40', 'pasivo'],
    ['407', '40', 'activo'],
    ['431', '43', 'activo'],
    ['436', '43', 'activo'],
    ['438', '43', 'pasivo'],
    ['49', '4', 'activo'],
    ['490', '49', 'activo'],
  ])('incluye la %s colgando de la %s', (codigo, padre, tipo) => {
    const n = PGC_BASE.find((x) => x.code === codigo);
    expect(n).toMatchObject({ parentCode: padre, type: tipo });
  });

  it('sigue ordenado y sin codigos repetidos (el padre antes que el hijo)', () => {
    const codigos = PGC_BASE.map((n) => n.code);
    expect(new Set(codigos).size).toBe(codigos.length);
    expect([...codigos].sort((a, b) => a.localeCompare(b))).toEqual(codigos);
    for (const n of PGC_BASE) if (n.parentCode) expect(codigos.indexOf(n.parentCode)).toBeLessThan(codigos.indexOf(n.code));
  });
});
