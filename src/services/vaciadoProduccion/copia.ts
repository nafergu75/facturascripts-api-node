/**
 * Copia local completa antes del vaciado, y su restauracion.
 *
 * La copia es una carpeta FUERA del repositorio con:
 *  - tablas/NNN-<Tabla>.sql: TODAS las filas de TODAS las tablas del esquema
 *    (tambien las que se conservan), como sentencias INSERT, una por linea,
 *    salvo el certificado de VERI*FACTU y su contraseña (COLUMNAS_SIN_COPIA);
 *  - ficheros/...: los ficheros del almacen que son de la app;
 *  - manifiesto.json: filas por tabla, ficheros, administradores y orden de
 *    restauracion;
 *  - LEEME.txt: que es y como se restaura.
 *
 * Si algo falla (o los datos cambian mientras se copian), la copia lanza un
 * error y el vaciado no borra nada.
 *
 * Los valores se leen como texto (CAST ... AS CHAR; los binarios en
 * hexadecimal) para no depender de como convierte Prisma cada tipo: la
 * restauracion inserta ese mismo texto y MySQL/TiDB lo convierte al tipo de la
 * columna.
 */
import { createHash } from 'crypto';
import { createReadStream, promises as fsp } from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { PrismaClient } from '@prisma/client';
import { id, ordenDeRestauracion, type Destino, type Tabla } from './tablas';
import { num, plural } from './bd';
import { rutaLocalDe, type Almacen, type Objeto } from './almacen';

export const FORMATO_COPIA = 1;
/** Filas que se leen de cada vez. */
const PAGINA = 1000;
/** Tamano maximo aproximado de cada sentencia INSERT (una fila mas grande va sola). */
const MAX_SENTENCIA = 512 * 1024;

export interface TablaCopia {
  tabla: string;
  destino: Destino;
  filas: number;
  /** Ruta relativa dentro de la carpeta de la copia. */
  fichero: string;
  bytes: number;
}

export interface FicheroCopia {
  clave: string;
  ref: string;
  tamano: number;
  tipo: string | null;
  /** Ruta relativa dentro de la carpeta de la copia. */
  local: string;
  sha256: string;
}

export interface AdminCopia {
  id: string;
  email: string;
  /** Huella corta de su passwordHash: la comprobacion final mira que no ha cambiado. */
  huellaClave: string;
}

export interface Manifiesto {
  formato: number;
  creada: string;
  base: { nombre: string; version: string };
  codigo: string | null;
  almacen: Almacen['tipo'];
  admins: AdminCopia[];
  /** En orden de restauracion (padres antes que hijas). */
  tablas: TablaCopia[];
  ficheros: FicheroCopia[];
}

export const huella = (texto: string): string => createHash('sha256').update(texto).digest('hex').slice(0, 16);

/** Literal de cadena de MySQL, en una sola linea (los saltos de linea van escapados). */
export function cadenaSql(s: string): string {
  const esc: Record<string, string> = { '\0': '\\0', '\n': '\\n', '\r': '\\r', '\b': '\\b', '\t': '\\t', '\x1a': '\\Z', "'": "\\'", '"': '\\"', '\\': '\\\\' };
  return `'${s.replace(/[\0\n\r\b\t\x1a'"\\]/g, (c) => esc[c])}'`;
}

/** Literal SQL de un valor leido como texto (o hexadecimal si la columna es binaria). */
export function literalSql(valor: unknown, binario: boolean): string {
  if (valor === null || valor === undefined) return 'NULL';
  const s = Buffer.isBuffer(valor) ? valor.toString('utf8') : String(valor);
  if (binario) {
    if (!/^[0-9A-Fa-f]*$/.test(s)) throw new Error('Un valor binario no ha llegado en hexadecimal.');
    return `X'${s}'`;
  }
  return cadenaSql(s);
}

/** Expresion del SELECT que devuelve la columna como texto. */
/**
 * Columnas que la copia local NO guarda: van vacias (''). Son el certificado
 * de VERI*FACTU de cada empresa y su contraseña. Estan cifrados, pero la
 * ENCRYPTION_KEY de produccion esta en el mismo ordenador que la copia
 * (backend/.env.vercel-prod.local): juntos equivaldrian al certificado con su
 * contraseña. Tras restaurar, la ficha del certificado sigue ahi, pero hay que
 * volver a subirlo (la app dice «vuelve a subirlo» al usarlo).
 */
export const COLUMNAS_SIN_COPIA: Readonly<Record<string, readonly string[]>> = { VerifactuCertificado: ['pfxEnc', 'passEnc'] };

const columnaComoTexto = (tabla: string, c: { nombre: string; tipo: string }): string => {
  if (COLUMNAS_SIN_COPIA[tabla]?.includes(c.nombre)) return `'' AS ${id(c.nombre)}`;
  return c.tipo === 'Bytes' ? `HEX(${id(c.nombre)}) AS ${id(c.nombre)}` : `CAST(${id(c.nombre)} AS CHAR) AS ${id(c.nombre)}`;
};

/** Ficheros de la copia: nombre de cada tabla con su posicion en el orden de restauracion. */
const ficheroTabla = (i: number, tabla: string) => `tablas/${String(i + 1).padStart(3, '0')}-${tabla}.sql`;

export interface OpcionesCopia {
  db: PrismaClient;
  tablas: readonly Tabla[];
  almacen: Almacen;
  /** Ficheros del almacen que se copian (los de la app). */
  objetos: readonly Objeto[];
  carpeta: string;
  base: { nombre: string; version: string };
  codigo: string | null;
  admins: readonly { id: string; email: string; passwordHash: string }[];
  progreso?: (texto: string) => void;
}

/**
 * Escribe la copia completa. Si la carpeta ya existe, no la pisa. Devuelve el
 * manifiesto (tambien escrito en la carpeta). Lanza un error si algo no cuadra.
 */
export async function hacerCopia(o: OpcionesCopia): Promise<Manifiesto> {
  const avisar = o.progreso ?? (() => undefined);
  const carpeta = path.resolve(o.carpeta);
  await fsp.mkdir(path.dirname(carpeta), { recursive: true });
  await fsp.mkdir(carpeta); // falla si ya existe: no se mezclan copias
  await fsp.mkdir(path.join(carpeta, 'tablas'));

  const porNombre = new Map(o.tablas.map((t) => [t.nombre, t]));
  const orden = ordenDeRestauracion(o.tablas);
  const tablasCopia: TablaCopia[] = [];
  for (const [i, nombre] of orden.entries()) {
    const t = porNombre.get(nombre)!;
    const fichero = ficheroTabla(i, nombre);
    const { filas, bytes } = await copiarTabla(o.db, t, path.join(carpeta, fichero));
    tablasCopia.push({ tabla: nombre, destino: t.destino, filas, fichero, bytes });
    if (filas) avisar(`  ${nombre}: ${plural(filas, 'fila', 'filas')}`);
  }

  const ficheros: FicheroCopia[] = [];
  const usadas = new Set<string>();
  for (const obj of o.objetos) {
    let local = `ficheros/${rutaLocalDe(obj.clave)}`;
    // Dos claves que en Windows quedarian con el mismo nombre: se numera la segunda.
    for (let n = 2; usadas.has(local.toLowerCase()); n++) local = `ficheros/${rutaLocalDe(obj.clave)}.${n}`;
    usadas.add(local.toLowerCase());
    const { contenido, tipo } = await o.almacen.leer(obj);
    if (contenido.length !== obj.tamano) {
      throw new Error(`El fichero ${obj.clave} se ha descargado con ${contenido.length} bytes y tenía ${obj.tamano}.`);
    }
    const destino = path.join(carpeta, ...local.split('/'));
    await fsp.mkdir(path.dirname(destino), { recursive: true });
    await fsp.writeFile(destino, contenido);
    const st = await fsp.stat(destino);
    if (st.size !== contenido.length) throw new Error(`No se ha podido guardar entero ${obj.clave} en la copia.`);
    ficheros.push({ clave: obj.clave, ref: obj.ref, tamano: obj.tamano, tipo, local, sha256: createHash('sha256').update(contenido).digest('hex') });
  }
  if (ficheros.length) avisar(`  Ficheros: ${plural(ficheros.length, 'fichero', 'ficheros')}`);

  const manifiesto: Manifiesto = {
    formato: FORMATO_COPIA,
    creada: new Date().toISOString(),
    base: o.base,
    codigo: o.codigo,
    almacen: o.almacen.tipo,
    admins: o.admins.map((a) => ({ id: a.id, email: a.email, huellaClave: huella(a.passwordHash) })),
    tablas: tablasCopia,
    ficheros,
  };
  await fsp.writeFile(path.join(carpeta, 'manifiesto.json'), JSON.stringify(manifiesto, null, 2));
  await fsp.writeFile(path.join(carpeta, 'LEEME.txt'), leeme(manifiesto), 'utf8');

  // Segunda lectura: cada fichero de tabla existe y mide lo escrito.
  for (const t of tablasCopia) {
    const st = await fsp.stat(path.join(carpeta, t.fichero));
    if (st.size !== t.bytes) throw new Error(`La copia de ${t.tabla} no se ha guardado entera.`);
  }
  return manifiesto;
}

/** Copia una tabla en su fichero, por paginas segun la clave primaria. */
async function copiarTabla(db: PrismaClient, t: Tabla, destino: string): Promise<{ filas: number; bytes: number }> {
  const antes = num((await db.$queryRawUnsafe<Array<{ n: unknown }>>(`SELECT COUNT(*) AS n FROM ${id(t.nombre)}`))[0]?.n);
  const fh = await fsp.open(destino, 'w');
  let bytes = 0;
  let filas = 0;
  try {
    const columnas = t.columnas;
    const binaria = columnas.map((c) => c.tipo === 'Bytes');
    const ignorar = t.destino === 'VACIAR' ? '' : 'IGNORE ';
    const cabecera = `INSERT ${ignorar}INTO ${id(t.nombre)} (${columnas.map((c) => id(c.nombre)).join(', ')}) VALUES `;
    const clave = t.clave.length ? t.clave : columnas.map((c) => c.nombre);
    const claves = clave.map((c, i) => `${id(c)} AS ${id(`__k${i}`)}`);
    const orden = clave.map((c) => id(c)).join(', ');
    const select = `SELECT ${columnas.map((c) => columnaComoTexto(t.nombre, c)).join(', ')}, ${claves.join(', ')} FROM ${id(t.nombre)}`;

    let ultima: unknown[] | null = null;
    let linea = '';
    const escribir = async (texto: string) => {
      const b = Buffer.from(texto, 'utf8');
      await fh.write(b);
      bytes += b.length;
    };
    for (;;) {
      const where = ultima ? ` WHERE (${orden}) > (${ultima.map(() => '?').join(', ')})` : '';
      const pagina: Array<Record<string, unknown>> = await db.$queryRawUnsafe(`${select}${where} ORDER BY ${orden} LIMIT ${PAGINA}`, ...(ultima ?? []));
      for (const fila of pagina) {
        const tupla = `(${columnas.map((c, i) => literalSql(fila[c.nombre], binaria[i])).join(', ')})`;
        if (linea && linea.length + tupla.length + 2 > MAX_SENTENCIA) {
          await escribir(`${linea};\n`);
          linea = '';
        }
        linea = linea ? `${linea}, ${tupla}` : `${cabecera}${tupla}`;
        filas++;
      }
      if (pagina.length < PAGINA) break;
      const u: Record<string, unknown> = pagina[pagina.length - 1];
      ultima = clave.map((_, i) => u[`__k${i}`]);
    }
    if (linea) await escribir(`${linea};\n`);
  } finally {
    await fh.close();
  }
  if (filas !== antes) {
    throw new Error(`${t.nombre}: tenía ${antes} filas y se han copiado ${filas}. Los datos han cambiado mientras se copiaban: no uses la app y vuelve a lanzarlo.`);
  }
  return { filas, bytes };
}

function leeme(m: Manifiesto): string {
  const filas = m.tablas.reduce((s, t) => s + t.filas, 0);
  return [
    'COPIA DE LA BASE DE DATOS DE CONTA ANTES DEL VACIADO',
    '',
    `Hecha el ${m.creada} (hora UTC) de la base «${m.base.nombre}» (${m.base.version}).`,
    `Contiene ${filas} filas de ${m.tablas.length} tablas y ${m.ficheros.length} ficheros.`,
    '',
    'Qué hay:',
    '  tablas/      una sentencia INSERT por línea, en el orden en que se restauran',
    '  ficheros/    los ficheros que la app tenía guardados (facturas, PDF, lecturas...)',
    '  manifiesto.json  el índice de todo lo anterior',
    '',
    'Contiene datos personales y fiscales: guárdala en un sitio seguro y no la compartas.',
    'No lleva los certificados de VERI*FACTU ni sus contraseñas: si la restauras, vuelve a subirlos en Configuración > VERI*FACTU.',
    '',
    `Para restaurarla (solo sobre la base ya vaciada), desde Git Bash, en la carpeta del backend con la que se hizo (${path.resolve('.')}):`,
    '  ENV_PROD=../backend/.env.vercel-prod.local bash scripts/vaciar-produccion.sh --restaurar "<esta carpeta>"',
    'Si has restaurado la base desde TiDB Cloud, faltan los ficheros. Súbelos solos con:',
    '  ENV_PROD=../backend/.env.vercel-prod.local bash scripts/vaciar-produccion.sh --restaurar-ficheros "<esta carpeta>"',
    'Más detalles en docs/vaciar-produccion.md.',
    '',
  ].join('\r\n');
}

export async function leerManifiesto(carpeta: string): Promise<Manifiesto> {
  const texto = await fsp.readFile(path.join(path.resolve(carpeta), 'manifiesto.json'), 'utf8');
  const m = JSON.parse(texto) as Manifiesto;
  if (m.formato !== FORMATO_COPIA || !Array.isArray(m.tablas) || !Array.isArray(m.ficheros)) {
    throw new Error('Esa carpeta no tiene una copia del vaciado que este script sepa leer (manifiesto.json).');
  }
  return m;
}

export interface OpcionesRestaurar {
  db: PrismaClient;
  /** Tablas del esquema actual. */
  tablas: readonly Tabla[];
  almacen: Almacen;
  carpeta: string;
  progreso?: (texto: string) => void;
}

export interface ResultadoRestaurar {
  filas: Map<string, number>;
  ficheros: number;
  avisos: string[];
}

/**
 * La restauracion ya habia empezado a escribir cuando ha fallado: la base (o el
 * almacen) ha quedado a medias. Quien la lanza explica como salir.
 */
export class RestauracionCortada extends Error {
  constructor(
    mensaje: string,
    /** 'filas': la base tiene parte de la copia. 'ficheros': las filas estan todas y faltan ficheros. */
    readonly fase: 'filas' | 'ficheros',
    /** Tabla o fichero en el que se ha cortado. */
    readonly donde: string,
  ) {
    super(mensaje);
    this.name = 'RestauracionCortada';
  }
}

/** Motivo de un error en una linea: el «Message» de Prisma si lo hay; si no, la ultima linea con texto. */
function motivoCorto(e: unknown): string {
  const texto = e instanceof Error ? e.message : String(e);
  const prisma = /Message: `([^`]*)`/.exec(texto);
  if (prisma) return prisma[1];
  return texto.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? texto;
}

/** Columnas de la cabecera INSERT de un fichero de tabla de la copia. */
async function columnasDeFichero(fichero: string): Promise<string[]> {
  const fh = await fsp.open(fichero, 'r');
  try {
    const trozo = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(trozo, 0, trozo.length, 0);
    const cabecera = /^INSERT (?:IGNORE )?INTO `(?:[^`]|``)+` \(([^)]*)\) VALUES /.exec(trozo.subarray(0, bytesRead).toString('utf8'));
    if (!cabecera) throw new Error(`${path.basename(fichero)} no empieza por un INSERT de la copia.`);
    return cabecera[1].split(', ').map((c) => c.replace(/^`|`$/g, '').replace(/``/g, '`'));
  } finally {
    await fh.close();
  }
}

/** Ruta en disco de un fichero de la copia. */
const rutaEnCopia = (carpeta: string, local: string) => path.join(carpeta, ...local.split('/'));

/**
 * Todos los ficheros de la copia estan y son los que se copiaron (tamano y
 * sha256). Se mira antes de escribir nada.
 */
async function comprobarFicherosDeCopia(m: Manifiesto, carpeta: string): Promise<void> {
  for (const f of m.ficheros) {
    const contenido = await fsp.readFile(rutaEnCopia(carpeta, f.local)).catch(() => null);
    if (!contenido || contenido.length !== f.tamano) throw new Error(`Falta en la copia, o está incompleto, el fichero ${f.local}.`);
    if (createHash('sha256').update(contenido).digest('hex') !== f.sha256) throw new Error(`El fichero ${f.local} de la copia no coincide con el original.`);
  }
}

/**
 * Sube al almacen los ficheros de la copia con su misma ruta. Los que ya estan
 * en el almacen no se tocan (asi se puede repetir tras un corte).
 */
async function subirFicherosDeCopia(
  m: Manifiesto,
  carpeta: string,
  almacen: Almacen,
  avisar: (texto: string) => void,
): Promise<{ subidos: number; yaEstaban: number; avisos: string[] }> {
  const avisos: string[] = [];
  let subidos = 0;
  let yaEstaban = 0;
  if (!m.ficheros.length) return { subidos, yaEstaban, avisos };
  const existentes = new Set((await almacen.listar()).map((x) => x.clave));
  for (const f of m.ficheros) {
    if (existentes.has(f.clave)) {
      yaEstaban++;
      continue;
    }
    let ref: string;
    try {
      ref = await almacen.subir(f.clave, await fsp.readFile(rutaEnCopia(carpeta, f.local)), f.tipo);
    } catch (e) {
      throw new RestauracionCortada(
        `No se ha podido subir ${f.clave} (${motivoCorto(e)}). Se habían subido ${subidos}.`,
        'ficheros',
        f.clave,
      );
    }
    subidos++;
    if (ref !== f.ref) avisos.push(`${f.clave} ha quedado en otra dirección (${almacen.tipo}): la base apunta a la antigua.`);
  }
  avisar(`  Ficheros: ${plural(subidos, 'subido', 'subidos')}${yaEstaban ? ` (${plural(yaEstaban, 'ya estaba', 'ya estaban')})` : ''}`);
  return { subidos, yaEstaban, avisos };
}

/**
 * Vuelve a meter la copia en la base y los ficheros en el almacen. Solo sobre
 * la base vaciada: si alguna tabla que el vaciado deja vacia tiene filas, se
 * para sin escribir nada. Las tablas que se conservan entran con INSERT IGNORE
 * (lo que ya hay se queda como esta).
 *
 * Antes de escribir nada comprueba la copia entera: tablas y columnas de esta
 * version, y ficheros completos y sin cambios. Si falla despues de haber
 * escrito, lanza RestauracionCortada.
 */
export async function restaurarCopia(o: OpcionesRestaurar): Promise<ResultadoRestaurar> {
  const avisar = o.progreso ?? (() => undefined);
  const carpeta = path.resolve(o.carpeta);
  const m = await leerManifiesto(carpeta);
  const actuales = new Map(o.tablas.map((t) => [t.nombre, t]));
  const desconocidas = m.tablas.filter((t) => !actuales.has(t.tabla)).map((t) => t.tabla);
  if (desconocidas.length) throw new Error(`La copia tiene tablas que esta versión no conoce: ${desconocidas.join(', ')}. Restaura con la versión del código con la que se hizo la copia.`);
  const conDatos: string[] = [];
  for (const t of o.tablas) {
    if (t.destino !== 'VACIAR') continue;
    const [f] = await o.db.$queryRawUnsafe<Array<{ n: unknown }>>(`SELECT COUNT(*) AS n FROM ${id(t.nombre)}`);
    if (num(f?.n)) conDatos.push(`${t.nombre} (${num(f?.n)})`);
  }
  if (conDatos.length) {
    throw new Error(
      `La base no está vacía: ${conDatos.slice(0, 10).join(', ')}${conDatos.length > 10 ? '…' : ''}. La copia solo se restaura sobre la base vaciada. ` +
        'Si es porque una restauración anterior se cortó a medias, vacía la base con --borrar y repite --restaurar con esta misma copia. ' +
        'Si ya has empezado a usar la app, no restaures esta copia: pregunta antes.',
    );
  }
  // La copia entera tiene que estar bien antes de tocar nada.
  const distintas: string[] = [];
  for (const t of m.tablas) {
    if (!t.filas) continue;
    const fichero = path.join(carpeta, t.fichero);
    const st = await fsp.stat(fichero).catch(() => null);
    if (!st || st.size !== t.bytes) throw new Error(`Falta en la copia, o está incompleto, ${t.fichero}.`);
    const columnas = await columnasDeFichero(fichero);
    const delModelo = actuales.get(t.tabla)!.columnas.map((c) => c.nombre);
    if (columnas.length !== delModelo.length || columnas.some((c) => !delModelo.includes(c))) distintas.push(t.tabla);
  }
  if (distintas.length) {
    throw new Error(
      `La copia es de otra versión del esquema: las columnas de ${distintas.join(', ')} no son las de esta versión. ` +
        `Restáurala con el código con el que se hizo${m.codigo ? ` (commit ${m.codigo})` : ''}.`,
    );
  }
  await comprobarFicherosDeCopia(m, carpeta);
  if (m.ficheros.length && o.almacen.tipo === 'ninguno') {
    throw new Error('La copia tiene ficheros y no hay acceso al almacén (falta la clave de Vercel Blob): no se restaura nada.');
  }

  const filas = new Map<string, number>();
  let escritas = 0;
  let tablaActual = '';
  try {
    for (const t of m.tablas) {
      tablaActual = t.tabla;
      let n = 0;
      if (t.filas) {
        const lector = readline.createInterface({ input: createReadStream(path.join(carpeta, t.fichero), { encoding: 'utf8' }), crlfDelay: Infinity });
        for await (const linea of lector) {
          if (!linea.trim()) continue;
          if (!linea.startsWith('INSERT ')) throw new Error(`${t.fichero}: línea que no es un INSERT.`);
          // Sin comprobar claves ajenas mientras se inserta: las referencias a la
          // propia tabla pueden venir antes que su fila padre. En la misma
          // conexion que el INSERT (transaccion).
          const insertadas = await o.db.$transaction(
            async (tx) => {
              await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
              return tx.$executeRawUnsafe(linea.replace(/;\s*$/, ''));
            },
            { maxWait: 60_000, timeout: 300_000 },
          );
          n += insertadas;
          escritas += insertadas;
        }
      }
      filas.set(t.tabla, n);
      if (t.filas) avisar(`  ${t.tabla}: ${plural(n, 'fila', 'filas')}${n < t.filas ? ` (las otras ${t.filas - n} ya estaban)` : ''}`);
    }
  } catch (e) {
    // Sin ninguna fila escrita no hay nada a medias: el error tal cual.
    if (!escritas) throw e;
    throw new RestauracionCortada(motivoCorto(e), 'filas', tablaActual);
  } finally {
    await o.db.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1').catch(() => undefined);
  }

  const r = await subirFicherosDeCopia(m, carpeta, o.almacen, avisar);
  return { filas, ficheros: r.subidos + r.yaEstaban, avisos: r.avisos };
}

export interface ResultadoFicheros {
  total: number;
  subidos: number;
  yaEstaban: number;
  avisos: string[];
}

/**
 * Sube SOLO los ficheros de la copia, sin tocar la base: para cuando la base
 * se ha restaurado desde TiDB Cloud (esa copia no lleva los ficheros, que el
 * vaciado ya borro del almacen). Los que ya estan no se tocan, asi que se
 * puede repetir.
 */
export async function restaurarFicheros(o: { almacen: Almacen; carpeta: string; progreso?: (texto: string) => void }): Promise<ResultadoFicheros> {
  const carpeta = path.resolve(o.carpeta);
  const m = await leerManifiesto(carpeta);
  if (!m.ficheros.length) return { total: 0, subidos: 0, yaEstaban: 0, avisos: [] };
  if (o.almacen.tipo === 'ninguno') throw new Error('Para subir los ficheros hace falta la clave de Vercel Blob (BLOB_READ_WRITE_TOKEN). No se ha subido nada.');
  await comprobarFicherosDeCopia(m, carpeta);
  const r = await subirFicherosDeCopia(m, carpeta, o.almacen, o.progreso ?? (() => undefined));
  return { total: m.ficheros.length, ...r };
}
