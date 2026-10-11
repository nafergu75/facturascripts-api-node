// P12 (spec verifactu, apartado 8): el esbozo antiguo de Veri*Factu guardaba la
// huella en un Map en memoria, con una cadena que no es la de la AEAT y en UTC.
// Se retiro entero; este test evita que vuelva por un merge.
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');

describe('P12: sin restos del esbozo anterior de Veri*Factu', () => {
  it('no existen verifactu.service.ts ni verifactu.model.ts', () => {
    expect(existsSync(join(SRC, 'services', 'verifactu.service.ts'))).toBe(false);
    expect(existsSync(join(SRC, 'domain', 'verifactu.model.ts'))).toBe(false);
  });

  it('el SDK no ofrece la ruta de huellas, que nunca existió', () => {
    expect(readFileSync(join(SRC, 'sdk', 'sdk.ts'), 'utf8')).not.toMatch(/huellas/i);
  });
});
