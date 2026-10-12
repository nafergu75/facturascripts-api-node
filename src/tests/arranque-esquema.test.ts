/**
 * Esquema de «Traer la contabilidad de 2026»: las marcas que comprueba el
 * script de produccion estan en el esquema, y los importes nuevos se leen como
 * number. Sin base de datos.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CAMPOS_DECIMALES } from '../config/decimales';

const raiz = join(__dirname, '..', '..');
const esquema = readFileSync(join(raiz, 'prisma', 'schema.prisma'), 'utf8');
const script = readFileSync(join(raiz, 'scripts', 'aplicar-esquema-prod.sh'), 'utf8');

describe('esquema del arranque', () => {
  const marcas = [...(/MARCAS=\(([\s\S]*?)\n\)/.exec(script)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);

  it('el script de producción comprueba las marcas nuevas', () => {
    for (const m of ['llevanza', 'fechaSaldoInicial', 'model CargaArranque', 'model PartidaPendiente', 'model ActivoFijo', 'model DotacionAmortizacion']) {
      expect(marcas).toContain(m);
    }
  });

  it('todas las marcas del script están en el esquema', () => {
    for (const m of marcas) expect({ marca: m, esta: esquema.includes(m) }).toEqual({ marca: m, esta: true });
  });

  it('los importes nuevos se leen como number', () => {
    for (const c of ['saldoContableInicial', 'importeOriginal', 'importePendiente', 'coste', 'valorResidual', 'amortAcumuladaInicial', 'coeficiente', 'importe']) {
      expect(CAMPOS_DECIMALES.has(c)).toBe(true);
    }
  });
});
