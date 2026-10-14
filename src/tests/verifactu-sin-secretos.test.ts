/**
 * Guardas estaticas de la fase F2 de VERI*FACTU sobre el codigo:
 *  - el PFX y la contraseña cifrados (pfxEnc, passEnc) solo los toca
 *    certificado.service.ts (y el esquema);
 *  - nadie apaga la comprobacion del servidor TLS (rejectUnauthorized);
 *  - el cliente de la AEAT solo lo usa la prueba de conexion, que no abre
 *    transacciones de emision;
 *  - node-forge solo se importa en certificado.ts (abrir el PKCS#12) y nunca
 *    se llama a sus verificaciones de firma.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC = join(__dirname, '..');

function ficheros(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === 'tests' || f === 'node_modules' ? [] : ficheros(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}
const codigo = ficheros(SRC).map((p) => ({ ruta: relative(SRC, p).split('\\').join('/'), texto: readFileSync(p, 'utf8') }));

describe('VERI*FACTU F2: sin secretos ni atajos en el codigo', () => {
  it('pfxEnc y passEnc solo en certificado.service.ts', () => {
    const con = codigo.filter((f) => /\bpfxEnc\b|\bpassEnc\b/.test(f.texto)).map((f) => f.ruta);
    expect(con).toEqual(['services/verifactu/certificado.service.ts']);
  });

  it('ningun rejectUnauthorized en src', () => {
    expect(codigo.filter((f) => /rejectUnauthorized/.test(f.texto)).map((f) => f.ruta)).toEqual([]);
  });

  it('cliente-aeat solo lo usa la prueba de conexion (fuera de transaccion)', () => {
    const usan = codigo.filter((f) => /from '[./a-zA-Z]*cliente-aeat'/.test(f.texto)).map((f) => f.ruta);
    expect(usan).toEqual(['services/verifactu/conexion.service.ts']);
  });

  it('node-forge solo en certificado.ts, y nunca para verificar firmas', () => {
    const forge = codigo.filter((f) => /from 'node-forge'|require\('node-forge'\)/.test(f.texto)).map((f) => f.ruta);
    expect(forge).toEqual(['services/verifactu/certificado.ts']);
    const texto = codigo.find((f) => f.ruta === 'services/verifactu/certificado.ts')!.texto;
    expect(texto).not.toMatch(/\.verify\(|verifyCertificateChain|createCaStore/);
  });
});
