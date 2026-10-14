/**
 * Cifrado v1 de los secretos de VERI*FACTU (utils/crypto.ts): AES-256-GCM con
 * prefijo de version y el contexto como datos asociados.
 */
import { cifrarV1, decrypt, descifrarV1, encrypt } from '../utils/crypto';
import { enCallbackDeTransaccion } from '../config/guardaTransaccion';

describe('cifrarV1 / descifrarV1', () => {
  const ctx = 'verifactu:empresa-1:pfx';

  it('ida y vuelta, con el prefijo v1: y un iv distinto cada vez', () => {
    const a = cifrarV1('secreto con ñ', ctx);
    const b = cifrarV1('secreto con ñ', ctx);
    expect(a.startsWith('v1:')).toBe(true);
    expect(a).not.toBe(b);
    expect(a).not.toContain('secreto');
    expect(descifrarV1(a, ctx)).toBe('secreto con ñ');
  });

  it('con el contexto de otra empresa o de otro campo no se descifra', () => {
    const c = cifrarV1('secreto', ctx);
    expect(() => descifrarV1(c, 'verifactu:empresa-2:pfx')).toThrow();
    expect(() => descifrarV1(c, 'verifactu:empresa-1:pass')).toThrow();
  });

  it('un dato tocado, sin prefijo o con otro formato: error', () => {
    const c = cifrarV1('secreto', ctx);
    const [, iv, tag, datos] = c.split(':');
    const otroTag = (tag[0] === 'a' ? 'b' : 'a') + tag.slice(1);
    expect(() => descifrarV1(`v1:${iv}:${otroTag}:${datos}`, ctx)).toThrow();
    expect(() => descifrarV1(c.slice(3), ctx)).toThrow(/prefijo/);
    expect(() => descifrarV1('v1:solo', ctx)).toThrow();
    expect(() => cifrarV1('x', '')).toThrow();
  });

  it('nunca dentro de una transaccion', () => {
    const c = cifrarV1('secreto', ctx);
    expect(() => enCallbackDeTransaccion(() => descifrarV1(c, ctx))).toThrow(/transacción/);
    expect(() => enCallbackDeTransaccion(() => cifrarV1('x', ctx))).toThrow(/transacción/);
  });

  it('encrypt y decrypt siguen como antes (sin version ni contexto)', () => {
    const c = encrypt('clave de FacturaScripts');
    expect(c.split(':')).toHaveLength(3);
    expect(decrypt(c)).toBe('clave de FacturaScripts');
  });
});
