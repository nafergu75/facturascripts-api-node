/**
 * Vaciado de produccion, sin base de datos: que cada tabla del esquema tenga
 * su destino, el orden de borrado frente a las claves ajenas, las condiciones
 * de los borrados parciales, el SQL de la copia, que no se escriba la URL de la
 * base (tampoco en la prueba de acceso), que las MARCAS y las carpetas del
 * almacen sigan al dia, el esquema en los dos sentidos, la parada de
 * VERI*FACTU y la restauracion cortada o solo de ficheros.
 * El recorrido completo contra una base esta en vaciado-produccion.db.test.ts.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Prisma, type PrismaClient } from '@prisma/client';
import { clasificarTablas, condicionBorrado, ordenDeBorrado, ordenDeRestauracion, REGLAS, MARCAS_AUDITORIA } from '../services/vaciadoProduccion/tablas';
import { cadenaSql, literalSql, restaurarFicheros, RestauracionCortada } from '../services/vaciadoProduccion/copia';
import { comprobarEsquema, esquemaCorrecto, motivosEsquema, ocultador, urlDelScript } from '../services/vaciadoProduccion/bd';
import { almacenBlob, almacenDisco, empresaDeClave, esDeLaApp, PREFIJOS_APP, rutaLocalDe, sinAlmacen } from '../services/vaciadoProduccion/almacen';
import { capturarSalida, causaFalloBase, estaDentro, main, repoQueLaContiene, textoRestauracionCortada } from '../services/vaciadoProduccion/cli';
import { comprobarVerifactu, informeSimulacion } from '../services/vaciadoProduccion/vaciado';

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

/** Base simulada: responde a las consultas de information_schema y a los COUNT. */
function baseFalsa(tablas: Record<string, string[]>, cuentas: (sql: string) => number = () => 0) {
  return {
    $queryRawUnsafe: jest.fn(async (sql: string) => {
      if (sql.includes('DATABASE() AS base')) return [{ base: 'conta', version: '8.0.11-TiDB-v7.5.0' }];
      if (sql.includes('information_schema.TABLES')) return Object.keys(tablas).map((t) => ({ t }));
      if (sql.includes('information_schema.COLUMNS')) return Object.entries(tablas).flatMap(([t, cs]) => cs.map((c) => ({ t, c })));
      return [{ n: BigInt(cuentas(sql)) }];
    }),
  } as unknown as Pick<PrismaClient, '$queryRawUnsafe'>;
}

describe('esquema de la base en los dos sentidos', () => {
  const modelo = [
    { nombre: 'Customer', columnas: [{ nombre: 'id', tipo: 'String' }, { nombre: 'nombre', tipo: 'String' }] },
    { nombre: 'Company', columnas: [{ nombre: 'id', tipo: 'String' }] },
  ];

  it('igual que el modelo: correcto (sin _prisma_migrations, como en producción)', async () => {
    const e = await comprobarEsquema(baseFalsa({ customer: ['id', 'nombre'], company: ['id'] }), modelo);
    expect(esquemaCorrecto(e)).toBe(true);
    expect(e.conMigraciones).toBe(false);
  });

  it('una columna que solo está en la base (otra versión publicada) para el script', async () => {
    const e = await comprobarEsquema(baseFalsa({ Customer: ['id', 'nombre', 'notaProd'], Company: ['id'], _prisma_migrations: ['id'] }), modelo);
    expect(e.sobranColumnas).toEqual(['Customer.notaProd']);
    expect(e.sobranTablas).toEqual([]);
    expect(esquemaCorrecto(e)).toBe(false);
    expect(motivosEsquema(e).join('\n')).toContain('La base tiene columnas que esta versión no conoce: Customer.notaProd.');
  });

  it('las columnas de una tabla que no es del modelo no cuentan aparte (ya para la tabla)', async () => {
    const e = await comprobarEsquema(baseFalsa({ Customer: ['id', 'nombre'], Company: ['id'], clientes: ['id', 'x'] }), modelo);
    expect(e.sobranTablas).toEqual(['clientes']);
    expect(e.sobranColumnas).toEqual([]);
  });
});

describe('simulación tras un borrado cortado', () => {
  it('las filas de varias empresas que ya no existen se suman por tabla (sin nombres repetidos)', () => {
    const tabla = (nombre: string, porEmpresa: Array<[string, number]>) => ({
      tabla: { nombre, destino: 'VACIAR' as const, motivo: '', columnas: [], clave: ['id'], columnaEmpresa: 'companyId', relaciones: [], autoReferencias: [], empresaPor: null },
      total: porEmpresa.reduce((a, [, n]) => a + n, 0),
      porEmpresa: new Map<string | null, number>(porEmpresa),
      aBorrar: porEmpresa.reduce((a, [, n]) => a + n, 0),
      aConservar: 0,
    });
    const estado = { base: 'conta', version: 'TiDB', esTidb: true, tablasEnBase: 2, faltanTablas: [], faltanColumnas: [], sobranTablas: [], sobranColumnas: [], conMigraciones: false };
    const lineas = informeSimulacion(
      {
        estado,
        paradas: [],
        avisos: [],
        usuarios: [],
        conservados: [],
        empresas: [],
        filas: [tabla('Customer', [['ya-no-1', 2], ['ya-no-2', 1]]), tabla('Supplier', [['ya-no-1', 1], ['ya-no-2', 1]])],
        objetos: null,
        referencias: null,
        ajustesPlataforma: [],
      },
      sinAlmacen('sin clave'),
    ).join('\n');
    expect(lineas).toContain('Filas sin empresa, o de empresas que ya no existen: 5');
    expect(lineas).toMatch(/Customer 3 · Supplier 2/);
  });
});

describe('VERI*FACTU: solo para lo de la AEAT de verdad', () => {
  const tablasF1 = [
    { nombre: 'VerifactuConfig', columnas: [{ nombre: 'estado', tipo: 'String' }, { nombre: 'entorno', tipo: 'String' }] },
    { nombre: 'VerifactuRegistro', columnas: [{ nombre: 'entorno', tipo: 'String' }, { nombre: 'huella', tipo: 'String' }] },
    { nombre: 'VerifactuCertificado', columnas: [{ nombre: 'companyId', tipo: 'String' }] },
    { nombre: 'VerifactuBitacora', columnas: [{ nombre: 'tipo', tipo: 'String' }] },
    { nombre: 'RegistroFacturacionSinEntorno', columnas: [{ nombre: 'estadoEnvio', tipo: 'String' }] },
  ];

  it('registros, certificados y bitácora del entorno de PRUEBAS no paran', async () => {
    const db = baseFalsa({}, (sql) => (sql.includes("'PRODUCCION'") || sql.includes('RegistroFacturacionSinEntorno') ? 0 : 7));
    expect(await comprobarVerifactu(db, tablasF1)).toEqual([]);
  });

  it('registros de PRODUCCIÓN, una empresa activa o una tabla de registros sin entorno con filas: para', async () => {
    const db = baseFalsa({}, (sql) => {
      if (sql.includes('VerifactuConfig')) return 1;
      if (sql.includes('VerifactuRegistro')) return sql.includes("'PRODUCCION'") ? 2 : 9;
      if (sql.includes('RegistroFacturacionSinEntorno')) return 3;
      return 5;
    });
    const paradas = await comprobarVerifactu(db, tablasF1);
    expect(paradas).toHaveLength(3);
    expect(paradas[0]).toContain('VERI*FACTU activo');
    expect(paradas[1]).toContain('VerifactuRegistro tiene 2 registros');
    expect(paradas[2]).toContain('RegistroFacturacionSinEntorno tiene 3 registros');
  });
});

describe('prueba de acceso: la salida de la app no se ve', () => {
  it('lo que escribe la app mientras corre se guarda y no sale por pantalla', () => {
    const escrito: string[] = [];
    const original = process.stdout.write;
    const originalErr = process.stderr.write;
    process.stdout.write = ((t: string) => escrito.push(String(t)) > 0) as typeof process.stdout.write;
    process.stderr.write = ((t: string) => escrito.push(String(t)) > 0) as typeof process.stderr.write;
    try {
      const c = capturarSalida();
      process.stdout.write("Can't reach database server at gateway99.eu-central-1.prod.invalid:4000\n");
      process.stderr.write('credentials for usr4AbCd are not valid\n');
      const capturado = c.soltar();
      expect(capturado).toContain('gateway99');
      expect(capturado).toContain('usr4AbCd');
      process.stdout.write('después\n');
    } finally {
      process.stdout.write = original;
      process.stderr.write = originalErr;
    }
    expect(escrito.join('')).toBe('después\n');
  });

  it('la causa se dice sin servidor ni usuario', () => {
    const causas = [
      causaFalloBase("Can't reach database server at gateway99.eu-central-1.prod.invalid:4000"),
      causaFalloBase('Authentication failed against database server at localhost, the provided database credentials for usr4AbCd are not valid'),
      causaFalloBase('Timed out fetching a new connection from the connection pool (P2024)'),
      causaFalloBase('Invalid prisma.user.findUnique() invocation: P2010 raw query failed at gateway99'),
    ];
    expect(causas[0]).toContain('No se ha podido conectar');
    expect(causas[1]).toContain('ha rechazado el usuario o la contraseña de conexión');
    expect(causas[2]).toContain('ha tardado demasiado');
    expect(causas[3]).toContain('código P2010');
    expect(causas.join('\n')).not.toMatch(/gateway99|usr4AbCd|localhost|Cl4ve/);
  });
});

describe('restauración cortada y ficheros solos', () => {
  it('cortada en las filas: vaciar con --borrar y repetir --restaurar con la misma copia', () => {
    const tapar = ocultador('mysql://usr4AbCd:Cl4ve@gateway99.invalid:4000/conta');
    const filas = textoRestauracionCortada(new RestauracionCortada('Lost connection to gateway99.invalid:4000', 'filas', 'Customer'), 'C:\\copias\\conta-copia-20261014-1200', tapar).join('\n');
    expect(filas).toContain('LA RESTAURACIÓN SE HA CORTADO A MEDIAS, en la tabla Customer');
    expect(filas).toContain('scripts/vaciar-produccion.sh --borrar');
    expect(filas).toMatch(/--restaurar ".*conta-copia-20261014-1200"/);
    expect(filas).not.toContain('gateway99');
    const ficheros = textoRestauracionCortada(new RestauracionCortada('red', 'ficheros', 'lecturas/a.pdf'), 'C:\\copias\\x', tapar).join('\n');
    expect(ficheros).toContain('--restaurar-ficheros');
    expect(ficheros).not.toContain('--borrar');
  });

  it('--restaurar-ficheros sube solo los que faltan, sin tocar la base, y no sube nada si la copia está mal', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'vaciado-ficheros-'));
    try {
      const carpeta = path.join(tmp, 'copia');
      const almacen = path.join(tmp, 'storage');
      const ficheros = [
        { clave: 'lecturas/e1/a.pdf', contenido: 'pdf-a' },
        { clave: 'archivo/e1/b.pdf', contenido: 'pdf-b' },
      ];
      for (const f of ficheros) {
        mkdirSync(path.dirname(path.join(carpeta, 'ficheros', f.clave)), { recursive: true });
        writeFileSync(path.join(carpeta, 'ficheros', f.clave), f.contenido);
      }
      const manifiesto = {
        formato: 1,
        creada: '2026-10-14T10:00:00.000Z',
        base: { nombre: 'conta', version: 'x' },
        codigo: null,
        almacen: 'disco',
        admins: [],
        tablas: [],
        ficheros: ficheros.map((f) => ({
          clave: f.clave,
          ref: `storage/${f.clave}`,
          tamano: f.contenido.length,
          tipo: null,
          local: `ficheros/${f.clave}`,
          sha256: createHash('sha256').update(f.contenido).digest('hex'),
        })),
      };
      writeFileSync(path.join(carpeta, 'manifiesto.json'), JSON.stringify(manifiesto));
      // Uno ya esta en el almacen (con otro contenido): no se toca.
      mkdirSync(path.join(almacen, 'lecturas', 'e1'), { recursive: true });
      writeFileSync(path.join(almacen, 'lecturas', 'e1', 'a.pdf'), 'el-de-ahora');

      const r = await restaurarFicheros({ almacen: almacenDisco(almacen), carpeta });
      expect([r.total, r.subidos, r.yaEstaban, r.avisos]).toEqual([2, 1, 1, []]);
      expect(readFileSync(path.join(almacen, 'archivo', 'e1', 'b.pdf'), 'utf8')).toBe('pdf-b');
      expect(readFileSync(path.join(almacen, 'lecturas', 'e1', 'a.pdf'), 'utf8')).toBe('el-de-ahora');
      // Otra vez: nada que subir.
      expect((await restaurarFicheros({ almacen: almacenDisco(almacen), carpeta })).subidos).toBe(0);

      // Un fichero de la copia cambiado: error antes de subir nada.
      rmSync(path.join(almacen, 'archivo'), { recursive: true });
      writeFileSync(path.join(carpeta, 'ficheros', 'lecturas', 'e1', 'a.pdf'), 'pdf-X');
      await expect(restaurarFicheros({ almacen: almacenDisco(almacen), carpeta })).rejects.toThrow('no coincide con el original');
      expect(existsSync(path.join(almacen, 'archivo'))).toBe(false);
      // Sin clave de Blob: no sube nada.
      await expect(restaurarFicheros({ almacen: sinAlmacen('sin clave'), carpeta })).rejects.toThrow('hace falta la clave de Vercel Blob');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
