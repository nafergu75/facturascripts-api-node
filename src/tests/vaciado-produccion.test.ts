/**
 * Vaciado de produccion, sin base de datos: que cada tabla del esquema tenga
 * su destino, el orden de borrado frente a las claves ajenas, las condiciones
 * de los borrados parciales, el SQL de la copia, que no se escriba la URL de la
 * base y que las MARCAS y las carpetas del almacen sigan al dia.
 * El recorrido completo contra una base esta en vaciado-produccion.db.test.ts.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { readFileSync, readdirSync, statSync } from 'fs';
import * as path from 'path';
import { Prisma } from '@prisma/client';
import { clasificarTablas, condicionBorrado, ordenDeBorrado, ordenDeRestauracion, REGLAS, MARCAS_AUDITORIA } from '../services/vaciadoProduccion/tablas';
import { cadenaSql, literalSql } from '../services/vaciadoProduccion/copia';
import { ocultador, urlDelScript } from '../services/vaciadoProduccion/bd';
import { almacenBlob, empresaDeClave, esDeLaApp, PREFIJOS_APP, rutaLocalDe } from '../services/vaciadoProduccion/almacen';
import { estaDentro, main, repoQueLaContiene } from '../services/vaciadoProduccion/cli';

const RAIZ = path.resolve(__dirname, '..', '..');
const modelos = Prisma.dmmf.datamodel.models;

describe('clasificación de las tablas', () => {
  const c = clasificarTablas();

  it('todas las tablas del esquema tienen destino (sale de la DMMF, no de una lista)', () => {
    expect(c.sinClasificar).toEqual([]);
    expect(c.tablas.map((t) => t.nombre).sort()).toEqual(modelos.map((m) => m.name).sort());
  });

  it('las reglas escritas a mano son de tablas que existen', () => {
    for (const nombre of Object.keys(REGLAS)) expect([nombre, modelos.some((m) => m.name === nombre)]).toEqual([nombre, true]);
  });

  it('toda tabla con companyId se vacía (entera o, si es común, en parte) y nada de una empresa se conserva', () => {
    for (const t of c.tablas) {
      if (t.columnaEmpresa) expect([t.nombre, t.destino === 'CONSERVAR']).toEqual([t.nombre, false]);
    }
    const conservadas = c.tablas.filter((t) => t.destino === 'CONSERVAR').map((t) => t.nombre).sort();
    expect(conservadas).toEqual(['AjustePlataforma', 'ChartOfAccountsVersion', 'TipoCambioBce']);
    const parciales = c.tablas.filter((t) => t.destino === 'PARCIAL').map((t) => t.nombre).sort();
    expect(parciales).toEqual(['AuditLog', 'CarmenContador', 'ChartOfAccounts', 'RevokedToken', 'User']);
  });

  it('las hijas sin companyId se vacían con su padre', () => {
    const t = new Map(c.tablas.map((x) => [x.nombre, x]));
    for (const hija of ['IncomeInvoiceLine', 'ExpenseInvoiceLine', 'BankMovementSplit', 'SupplierContact', 'SupplierBankAccount', 'SupplierAudit']) {
      expect([hija, t.get(hija)?.destino, t.get(hija)?.empresaPor?.padre]).toEqual([hija, 'VACIAR', expect.any(String)]);
    }
  });

  it('una tabla nueva: con companyId se vacía sola; una común sin regla para el script', () => {
    const base = modelos.find((m) => m.name === 'Cobro')!;
    const nueva = { ...base, name: 'TablaNuevaDeEmpresa', dbName: null };
    const hija = {
      ...base,
      name: 'HijaNueva',
      dbName: null,
      fields: [
        { ...base.fields.find((f) => f.name === 'id')! },
        { ...base.fields.find((f) => f.name === 'id')!, name: 'padreId', isId: false, hasDefaultValue: false },
        { ...base.fields.find((f) => f.name === 'id')!, name: 'padre', kind: 'object', type: 'TablaNuevaDeEmpresa', isId: false, relationFromFields: ['padreId'], relationToFields: ['id'], isRequired: true },
      ],
    };
    const comun = { ...base, name: 'AjusteComunNuevo', dbName: null, fields: base.fields.filter((f) => f.name !== 'companyId') };
    const r = clasificarTablas([...modelos, nueva, hija, comun] as unknown as typeof modelos);
    expect(r.tablas.find((t) => t.nombre === 'TablaNuevaDeEmpresa')?.destino).toBe('VACIAR');
    expect(r.tablas.find((t) => t.nombre === 'HijaNueva')?.destino).toBe('VACIAR');
    expect(r.sinClasificar).toEqual(['AjusteComunNuevo']);
  });
});

describe('orden de borrado', () => {
  const { tablas } = clasificarTablas();
  const orden = ordenDeBorrado(tablas);

  it('cada tabla se borra antes que todas sus padres (RESTRICT y CASCADE no llegan a actuar)', () => {
    expect(orden).toHaveLength(tablas.length);
    const pos = new Map(orden.map((n, i) => [n, i]));
    for (const t of tablas) for (const r of t.relaciones) expect([t.nombre, r.padre, pos.get(t.nombre)! < pos.get(r.padre)!]).toEqual([t.nombre, r.padre, true]);
    expect(pos.get('Membership')! < pos.get('User')!).toBe(true);
    expect(pos.get('IncomeInvoiceRectificada')! < pos.get('IncomeInvoice')!).toBe(true);
    expect(pos.get('IncomeInvoice')! < pos.get('Customer')!).toBe(true);
    expect(pos.get('DotacionAmortizacion')! < pos.get('ActivoFijo')!).toBe(true);
  });

  it('la restauración va al revés y un círculo de claves ajenas se detecta', () => {
    expect(ordenDeRestauracion(tablas)).toEqual([...orden].reverse());
    const circulo = [
      { nombre: 'A', relaciones: [{ padre: 'B', columnas: ['b'], columnasPadre: ['id'], alBorrar: null, obligatoria: true }] },
      { nombre: 'B', relaciones: [{ padre: 'A', columnas: ['a'], columnasPadre: ['id'], alBorrar: null, obligatoria: true }] },
    ];
    expect(() => ordenDeBorrado(circulo)).toThrow(/en círculo/);
  });
});

describe('condiciones de borrado', () => {
  const t = (nombre: string) => clasificarTablas().tablas.find((x) => x.nombre === nombre)!;
  const admins = ['adm1', 'adm2'];

  it('vaciar entera, conservar entera y las parciales con los administradores', () => {
    expect(condicionBorrado(t('IncomeInvoice'), admins)).toEqual({ sql: '1 = 1', params: [] });
    expect(condicionBorrado(t('TipoCambioBce'), admins)).toBeNull();
    expect(condicionBorrado(t('User'), admins)).toEqual({ sql: '`id` NOT IN (?, ?)', params: admins });
    expect(condicionBorrado(t('RevokedToken'), admins)).toEqual({ sql: '`userId` NOT IN (?, ?)', params: admins });
    expect(condicionBorrado(t('ChartOfAccounts'), admins)).toEqual({ sql: '`companyId` IS NOT NULL', params: [] });
    const carmen = condicionBorrado(t('CarmenContador'), admins)!;
    expect(carmen.sql).toContain("LIKE 'global:%'");
    expect(carmen.params).toEqual(admins);
    const auditoria = condicionBorrado(t('AuditLog'), admins)!;
    expect(auditoria.sql).toContain("'AJUSTE_PLATAFORMA'");
    expect(auditoria.params).toEqual([...admins, ...MARCAS_AUDITORIA]);
  });

  it('sin administrador, o una parcial nueva sin condición, no se adivina: error', () => {
    expect(() => condicionBorrado(t('User'), [])).toThrow(/ningún administrador/);
    expect(() => condicionBorrado({ nombre: 'Nueva', destino: 'PARCIAL' }, admins)).toThrow(/no tiene condición/);
  });
});

describe('SQL de la copia', () => {
  it('cadenas en una sola línea, con comillas y barras escapadas', () => {
    expect(cadenaSql("O'Brien \\ \"x\"\nlinea2\r\t\0")).toBe("'O\\'Brien \\\\ \\\"x\\\"\\nlinea2\\r\\t\\0'");
    expect(cadenaSql('ñ€')).toBe("'ñ€'");
    expect(literalSql(null, false)).toBe('NULL');
    expect(literalSql('12.50', false)).toBe("'12.50'");
  });

  it('binarios en hexadecimal; si no llega hexadecimal, error', () => {
    expect(literalSql('89504E47', true)).toBe("X'89504E47'");
    expect(literalSql('', true)).toBe("X''");
    expect(() => literalSql("'; DROP TABLE x; --", true)).toThrow();
  });
});

describe('la URL de la base no se escribe nunca', () => {
  const url = 'mysql://usuario.raiz:Cl4ve%2Fsecreta@servidor.ejemplo-bd.test:4000/conta?sslaccept=strict';

  it('tapa la URL entera, la contraseña (también decodificada), el usuario y el servidor', () => {
    const tapar = ocultador(url, ['vercel_blob_rw_abcdef']);
    const t = tapar(`Can't reach ${url} ; host servidor.ejemplo-bd.test user usuario.raiz pass Cl4ve/secreta token vercel_blob_rw_abcdef`);
    expect(t).not.toMatch(/ejemplo-bd|usuario\.raiz|Cl4ve|vercel_blob_rw|mysql:\/\//);
  });

  it('una sola conexión y tiempo para que TiDB despierte', () => {
    expect(urlDelScript(url)).toMatch(/[?&]connection_limit=1(&|$)/);
    expect(urlDelScript(url)).toContain('connect_timeout=30');
    expect(urlDelScript(`${url}&connection_limit=5`)).toMatch(/connection_limit=1(&|$)/);
  });

  it('sin DATABASE_URL, o con una orden que no existe, no hace nada', async () => {
    const lineas: string[] = [];
    expect(await main(['simular'], {}, (...l) => lineas.push(...l))).toBe(2);
    expect(await main(['borrar-todo'], { DATABASE_URL: url }, (...l) => lineas.push(...l))).toBe(2);
    expect(await main(['simular', '--copia'], { DATABASE_URL: url }, (...l) => lineas.push(...l))).toBe(2);
    expect(lineas.join('\n')).not.toContain('ejemplo-bd');
  });

  it('la copia nunca va dentro de la carpeta del código ni de otra carpeta con git', () => {
    expect(estaDentro(path.join(RAIZ, 'copia'), RAIZ)).toBe(true);
    expect(estaDentro(RAIZ, RAIZ)).toBe(true);
    expect(estaDentro(path.join(path.dirname(RAIZ), 'otra-copia'), RAIZ)).toBe(false);
    expect(repoQueLaContiene(path.join(RAIZ, 'docs', 'copia-nueva'))).toBe(RAIZ);
  });
});

describe('marcas y carpetas del almacén al día', () => {
  it('el script lee las MARCAS de aplicar-esquema-prod.sh y esta copia del esquema las tiene todas', () => {
    const sh = readFileSync(path.join(RAIZ, 'scripts', 'aplicar-esquema-prod.sh'), 'utf8').replace(/\r/g, '');
    const bloque = sh.slice(sh.indexOf('\nMARCAS=(') + 1, sh.indexOf('\n)', sh.indexOf('\nMARCAS=(')));
    const marcas = bloque.split('\n').map((l) => /^\s*'(.*)'\s*$/.exec(l)?.[1]).filter((x): x is string => !!x);
    expect(marcas.length).toBeGreaterThanOrEqual(47);
    const esquema = readFileSync(path.join(RAIZ, 'prisma', 'schema.prisma'), 'utf8');
    for (const m of marcas) expect([m, esquema.includes(m)]).toEqual([m, true]);
    const vaciar = readFileSync(path.join(RAIZ, 'scripts', 'vaciar-produccion.sh'), 'utf8');
    expect(vaciar).toContain("sed -n '/^MARCAS=(/,/^)/p' scripts/aplicar-esquema-prod.sh");
  });

  it('carpetas de la app, empresa de cada fichero y nombres seguros en Windows', () => {
    expect(esDeLaApp('lecturas/emp1/x.pdf')).toBe(true);
    expect(esDeLaApp('otra-app/x.txt')).toBe(false);
    expect(empresaDeClave('archivo/emp1/2026/1T/ventas/a.pdf', new Set(['emp1']))).toBe('emp1');
    expect(empresaDeClave('facturas/ingresos/2026-01/A-1.json', new Set(['emp1']))).toBeNull();
    expect(rutaLocalDe('facturas/ingresos/2026-01/F:1?.json')).toBe('facturas/ingresos/2026-01/F_1_.json');
    expect(rutaLocalDe('a/../b')).toBe('a/_/b');
  });

  it('quien guarda ficheros en el almacén es alguno de los conocidos (si hay otro, revisa PREFIJOS_APP)', () => {
    const conocidos = [
      'services/accounting-closure.service.ts', // accounting-closures/
      'services/archivoFacturas.service.ts', // archivo/
      'services/arranque/cargas.service.ts', // arranque/
      'services/documentoArchivo.service.ts', // archivo/
      'services/income-reader.service.ts', // income-documents/
      'services/invoice-archiving.service.ts', // facturas/
      'services/invoice-extractor.service.ts', // extractor-ia/ y facturas/
      'services/lectura/lectura.service.ts', // lecturas/
      'services/nominas/documentos.ts', // nominas/
      'services/puestaEnMarcha/subidasTrozos.ts', // puesta-en-marcha/
      'services/registroMercantil.helpers.ts', // registro-mercantil/
    ];
    const src = path.join(RAIZ, 'src');
    const encontrados: string[] = [];
    const recorrer = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const r = path.join(dir, e);
        if (statSync(r).isDirectory()) {
          if (e !== 'tests') recorrer(r);
        } else if (e.endsWith('.ts') && !e.endsWith('.test.ts') && /\bputObject\s*\(/.test(readFileSync(r, 'utf8'))) {
          encontrados.push(path.relative(src, r).split(path.sep).join('/'));
        }
      }
    };
    recorrer(src);
    expect(encontrados.filter((f) => f !== 'utils/storage.ts').sort()).toEqual(conocidos.sort());
    expect(PREFIJOS_APP.length).toBe(10);
  });
});

jest.mock('@vercel/blob', () => {
  const blobs = Array.from({ length: 1005 }, (_, i) => ({
    url: `https://tienda.private.blob.vercel-storage.com/lecturas/e1/f${i}.pdf`,
    pathname: `lecturas/e1/f${i}.pdf`,
    size: 3,
    uploadedAt: new Date('2026-10-01T00:00:00Z'),
  }));
  return {
    list: jest.fn(async ({ cursor }: { cursor?: string }) => (cursor ? { blobs: blobs.slice(1000), hasMore: false } : { blobs: blobs.slice(0, 1000), hasMore: true, cursor: 'c2' })),
    get: jest.fn(async () => ({ statusCode: 200, stream: new Response('abc').body, blob: { contentType: 'application/pdf', size: 3 } })),
    del: jest.fn(async () => undefined),
    put: jest.fn(async (pathname: string) => ({ url: `https://tienda.private.blob.vercel-storage.com/${pathname}` })),
  };
});

describe('Vercel Blob (simulado)', () => {
  it('lista todas las páginas, descarga en privado, borra de 100 en 100 y vuelve a subir con la misma dirección', async () => {
    const blob = jest.requireMock('@vercel/blob') as Record<'list' | 'get' | 'del' | 'put', jest.Mock>;
    const a = almacenBlob('vercel_blob_rw_prueba');
    const objetos = await a.listar();
    expect(objetos).toHaveLength(1005);
    expect(blob.list).toHaveBeenCalledWith(expect.objectContaining({ token: 'vercel_blob_rw_prueba', cursor: 'c2' }));
    const leido = await a.leer(objetos[0]);
    expect(leido.contenido.toString()).toBe('abc');
    expect(blob.get).toHaveBeenCalledWith(objetos[0].ref, expect.objectContaining({ access: 'private', token: 'vercel_blob_rw_prueba' }));
    await a.borrar(objetos);
    expect(blob.del).toHaveBeenCalledTimes(11);
    expect(blob.del.mock.calls.every((c) => (c[0] as string[]).length <= 100)).toBe(true);
    const ref = await a.subir(objetos[0].clave, Buffer.from('abc'), 'application/pdf');
    expect(ref).toBe(objetos[0].ref);
    expect(blob.put).toHaveBeenCalledWith(objetos[0].clave, expect.any(Buffer), expect.objectContaining({ access: 'private', addRandomSuffix: false, allowOverwrite: true }));
  });
});
