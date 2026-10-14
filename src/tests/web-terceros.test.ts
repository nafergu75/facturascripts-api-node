/**
 * Web de clientes y proveedores (peticion del usuario del 14-10-2026: «En el
 * alta de los proveedores falta una casilla para la web»).
 *
 *  - normalizarWeb: sin espacios, https:// si no lleva protocolo, solo
 *    dominios razonables y un motivo claro si no lo es. Vacio = sin web.
 *  - Traer la contabilidad de 2026: la columna «Web» de los listados de
 *    clientes y proveedores llega a la ficha; una que no es una web se deja
 *    fuera sin parar la carga.
 *  - Esquema: columna opcional en Supplier y Customer, con su marca en el
 *    script de produccion.
 *
 * Sin base de datos.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { LARGO_MAXIMO_WEB, normalizarWeb } from '../utils/web';
import { campoDeTitulo, detectarCabecera } from '../services/arranque/campos';
import { extraerHoja } from '../services/arranque/extractores';
import { controlCif } from '../utils/nif';
import { LARGO_VALOR_HISTORIAL, valorParaHistorial } from '../services/suppliers/supplierAudit.service';

const ok = (v: unknown) => {
  const r = normalizarWeb(v);
  if (!r.ok) throw new Error(`no la acepta: ${r.motivo}`);
  return r.web;
};
const motivo = (v: unknown) => {
  const r = normalizarWeb(v);
  if (r.ok) throw new Error(`la acepta: ${r.web}`);
  return r.motivo;
};

describe('normalizarWeb', () => {
  it('vacía, en blanco, null o sin llegar: sin web', () => {
    expect(ok(undefined)).toBeNull();
    expect(ok(null)).toBeNull();
    expect(ok('')).toBeNull();
    expect(ok('   ')).toBeNull();
  });

  it('sin protocolo: se le pone https://', () => {
    expect(ok('www.empresa.com')).toBe('https://www.empresa.com');
    expect(ok('empresa.es')).toBe('https://empresa.es');
    expect(ok('tienda.empresa.co.uk/ofertas?ref=1#arriba')).toBe('https://tienda.empresa.co.uk/ofertas?ref=1#arriba');
    expect(ok('//empresa.es')).toBe('https://empresa.es');
  });

  it('con http:// o https:// se respeta (el protocolo, en minúsculas)', () => {
    expect(ok('http://empresa.es')).toBe('http://empresa.es');
    expect(ok('HTTPS://Www.Empresa.com/Catalogo')).toBe('https://Www.Empresa.com/Catalogo');
  });

  it('quita los espacios de delante, de detrás y de en medio', () => {
    expect(ok('  www.empresa.com  ')).toBe('https://www.empresa.com');
    expect(ok('www.empresa .com')).toBe('https://www.empresa.com');
    expect(ok('\twww.empresa.com\n')).toBe('https://www.empresa.com');
  });

  it('dominios con ñ o acentos, guiones, puerto y terminaciones largas', () => {
    expect(ok('www.ñandú.es')).toBe('https://www.ñandú.es');
    expect(ok('mi-empresa.valencia')).toBe('https://mi-empresa.valencia');
    expect(ok('empresa.com:8080/tienda')).toBe('https://empresa.com:8080/tienda');
    expect(ok('empresa.com.')).toBe('https://empresa.com.');
  });

  it('una palabra sin terminación: pide el .com, .es...', () => {
    expect(motivo('empresa')).toBe('Falta la terminación de la web (.com, .es...). Escríbela completa, por ejemplo www.empresa.com.');
    expect(motivo('localhost')).toMatch(/Falta la terminación/);
  });

  it('un correo: dice que va en el email', () => {
    expect(motivo('info@empresa.com')).toMatch(/^Eso parece un correo electrónico: va en el campo del email/);
    expect(motivo('mailto:info@empresa.com')).toMatch(/^Eso es un correo electrónico: va en el campo del email/);
  });

  it('otro protocolo (javascript:, ftp://, data:): no', () => {
    const texto = 'La web tiene que empezar por http:// o https://, o escríbela sin nada delante: www.empresa.com.';
    expect(motivo('javascript:alert(1)')).toBe(texto);
    expect(motivo('ftp://empresa.com')).toBe(texto);
    expect(motivo('data:text/html,hola')).toBe(texto);
  });

  it('IP, dominios mal formados, usuario y caracteres raros: no', () => {
    const texto = 'La web no es válida. Escríbela como www.empresa.com o https://empresa.com.';
    expect(motivo('192.168.1.10')).toBe(texto);
    expect(motivo('https://')).toBe(texto);
    expect(motivo('empresa..com')).toBe(texto);
    expect(motivo('-empresa.com')).toBe(texto);
    expect(motivo('empresa.c0m')).toBe(texto);
    expect(motivo('empresa_sl.com')).toBe(texto);
    expect(motivo('https://[::1]/')).toBe(texto);
    expect(motivo('https://user:clave@empresa.com')).toMatch(/^La web no puede llevar usuario ni contraseña/);
    expect(motivo('empresa.com/"><script>')).toMatch(/^La web lleva caracteres que no puede tener/);
    expect(motivo(12345)).toBe(texto);
    expect(motivo({ web: 'empresa.com' })).toBe(texto);
  });

  it(`como mucho ${LARGO_MAXIMO_WEB} caracteres, contando el https://`, () => {
    const ruta = 'a'.repeat(LARGO_MAXIMO_WEB - 'https://empresa.es/'.length);
    expect(ok(`empresa.es/${ruta}`)).toHaveLength(LARGO_MAXIMO_WEB);
    expect(motivo(`empresa.es/${ruta}a`)).toBe(`La web es demasiado larga (${LARGO_MAXIMO_WEB} caracteres como mucho).`);
  });
});

describe('historial del proveedor: valores que no caben en VARCHAR(191)', () => {
  it('lo corto va tal cual en JSON; sin valor, null', () => {
    expect(valorParaHistorial('https://empresa.es')).toBe('"https://empresa.es"');
    expect(valorParaHistorial(true)).toBe('true');
    expect(valorParaHistorial(null)).toBeNull();
    expect(valorParaHistorial(undefined)).toBeNull();
  });

  it('lo largo se recorta con «…», cabe en la columna y sigue siendo JSON', () => {
    const web = `https://empresa.es/${'a'.repeat(236)}`;
    expect(web).toHaveLength(LARGO_MAXIMO_WEB);
    const v = valorParaHistorial(web)!;
    expect(v).toHaveLength(LARGO_VALOR_HISTORIAL);
    const leido = JSON.parse(v) as string;
    expect(leido.endsWith('…')).toBe(true);
    expect(web.startsWith(leido.slice(0, -1))).toBe(true);
  });

  it('con comillas o barras (que ocupan el doble en JSON) y con emojis, también cabe', () => {
    for (const texto of ['"'.repeat(200), '\\'.repeat(300), '😀'.repeat(150), `Nombre «${'ñ'.repeat(195)}»`]) {
      const v = valorParaHistorial(texto)!;
      expect(v.length).toBeLessThanOrEqual(LARGO_VALOR_HISTORIAL);
      const leido = JSON.parse(v) as string;
      expect(leido.endsWith('…')).toBe(true);
      expect(texto.startsWith(leido.slice(0, -1))).toBe(true);
    }
  });
});

describe('Traer la contabilidad de 2026: columna «Web» de los listados', () => {
  it('reconoce los títulos de la columna', () => {
    for (const t of ['Web', 'WWW', 'URL', 'Página web', 'Sitio web', 'Website', 'Dirección web']) expect(campoDeTitulo(t)).toBe('web');
    // Una «Dirección» sola sigue siendo el domicilio.
    expect(campoDeTitulo('Dirección')).toBe('direccion');
  });

  it('la web llega normalizada a la ficha; una que no es una web se deja fuera', () => {
    const cif = (siete: string) => `B${siete}${controlCif(siete).cifra}`;
    const filas = [
      ['Cuenta', 'NIF', 'Nombre', 'Email', 'Web'],
      ['4300000001', cif('4612301'), 'Cliente Web SL', 'web@cliente.es', ' www.clienteweb.es '],
      ['4300000002', cif('4612302'), 'Cliente Sin Web SL', '', ''],
      ['4300000003', cif('4612303'), 'Cliente Raro SL', '', 'no tiene'],
    ];
    const r = extraerHoja('TERCEROS_CLIENTES', filas, { cabecera: detectarCabecera(filas) });
    expect(r.error).toBeNull();
    const terceros = (r.extraccion as { terceros: Array<{ nombre?: string; ficha?: Record<string, string> }> }).terceros;
    expect(terceros.map((t) => [t.nombre, t.ficha?.web])).toEqual([
      ['Cliente Web SL', 'https://www.clienteweb.es'],
      ['Cliente Sin Web SL', undefined],
      ['Cliente Raro SL', undefined],
    ]);
    expect(terceros[0].ficha).toEqual({ email: 'web@cliente.es', web: 'https://www.clienteweb.es' });
  });
});

describe('esquema', () => {
  const raiz = join(__dirname, '..', '..');
  const esquema = readFileSync(join(raiz, 'prisma', 'schema.prisma'), 'utf8');
  const script = readFileSync(join(raiz, 'scripts', 'aplicar-esquema-prod.sh'), 'utf8');
  /** El bloque `model X { ... }` del esquema. */
  const bloque = (nombre: string) => {
    const desde = esquema.indexOf(`model ${nombre} {`);
    return esquema.slice(desde, esquema.indexOf('\n}', desde));
  };

  it('web opcional de hasta 255 caracteres en Supplier y Customer, con su marca en el script de producción', () => {
    for (const [nombre, marca] of [
      ['Supplier', 'Web del proveedor'],
      ['Customer', 'Web del cliente'],
    ]) {
      expect(bloque(nombre)).toMatch(/\n\s+web\s+String\?\s+@db\.VarChar\(255\)\r?\n/);
      expect(bloque(nombre)).toContain(marca);
      expect(script).toContain(`'${marca}'`);
    }
  });
});
