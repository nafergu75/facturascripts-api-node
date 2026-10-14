/**
 * Ficheros guardados por la app (facturas subidas, PDF, ZIP, lecturas,
 * nominas, cargas de 2026...) para el vaciado de produccion.
 *
 * Donde estan (src/utils/storage.ts): en produccion, Vercel Blob PRIVADO (con
 * la clave BLOB_READ_WRITE_TOKEN); en local, la carpeta storage/ del proyecto.
 * Los logos de las empresas no estan aqui: van dentro de la base
 * (LegalConfig.logo) y se borran con ella.
 *
 * Solo se tocan los ficheros que cuelgan de las carpetas que usa la app
 * (PREFIJOS_APP). Si el almacen tuviera otros, se ensenan y no se borran.
 */
import { promises as fsp } from 'fs';
import * as path from 'path';
import type { PrismaClient } from '@prisma/client';
import { id, type Tabla } from './tablas';
import { num } from './bd';

export interface Objeto {
  /** Ruta dentro del almacen (pathname en Blob, ruta relativa en disco). */
  clave: string;
  /** Lo que guarda la base: URL del blob o 'storage/<clave>'. */
  ref: string;
  tamano: number;
  fecha: Date | null;
}

export interface Almacen {
  tipo: 'blob' | 'disco' | 'ninguno';
  /** Para la pantalla. */
  descripcion: string;
  listar(): Promise<Objeto[]>;
  leer(o: Objeto): Promise<{ contenido: Buffer; tipo: string | null }>;
  borrar(objetos: readonly Objeto[]): Promise<void>;
  /** Vuelve a subir un fichero con la misma clave (restaurar una copia). Devuelve su referencia. */
  subir(clave: string, contenido: Buffer, tipo: string | null): Promise<string>;
}

/**
 * Carpetas de primer nivel que usa la app al guardar (putObject). Si se anade
 * una nueva en el codigo, hay que anadirla aqui: si no, sus ficheros saldrian
 * como «no son de la app» y no se borrarian.
 */
export const PREFIJOS_APP = [
  'accounting-closures/', // cierre contable (accounting-closure.service)
  'archivo/', // archivo de facturas por trimestre (archivoFacturas, documentoArchivo)
  'arranque/', // ficheros de la gestoria de «Traer la contabilidad de 2026»
  'extractor-ia/', // extractor de facturas antiguo
  'facturas/', // facturas archivadas en JSON y PDF renombrados del extractor
  'income-documents/', // lector de ingresos antiguo
  'lecturas/', // lector de facturas (Azure y Claude)
  'nominas/', // PDF de nominas y seguros sociales
  'puesta-en-marcha/', // subidas por trozos de la puesta en marcha
  'registro-mercantil/', // libros, ZIP y cuentas anuales
] as const;

export const esDeLaApp = (clave: string): boolean => PREFIJOS_APP.some((p) => clave.startsWith(p));

/** Carpeta para agrupar en pantalla: la de primer nivel (o «(raíz)»). */
export const carpetaDe = (clave: string): string => (clave.includes('/') ? clave.slice(0, clave.indexOf('/') + 1) : '(raíz)');

/** Empresa a la que pertenece un fichero, si su ruta lleva el id de una empresa. */
export function empresaDeClave(clave: string, empresas: ReadonlySet<string>): string | null {
  for (const parte of clave.split('/')) if (empresas.has(parte)) return parte;
  return null;
}

// ---------------- Vercel Blob ----------------

export function almacenBlob(token: string): Almacen {
  const blob = () => import('@vercel/blob');
  return {
    tipo: 'blob',
    descripcion: 'Vercel Blob (privado), con la clave BLOB_READ_WRITE_TOKEN',
    async listar() {
      const { list } = await blob();
      const out: Objeto[] = [];
      let cursor: string | undefined;
      do {
        const r = await list({ cursor, limit: 1000, token });
        for (const b of r.blobs) out.push({ clave: b.pathname, ref: b.url, tamano: b.size, fecha: new Date(b.uploadedAt) });
        cursor = r.hasMore ? r.cursor : undefined;
      } while (cursor);
      return out.sort((a, b) => a.clave.localeCompare(b.clave));
    },
    async leer(o) {
      const { get } = await blob();
      const r = await get(o.ref, { access: 'private', token, useCache: false });
      if (!r || r.statusCode !== 200 || !r.stream) throw new Error(`No se ha podido descargar ${o.clave}.`);
      return { contenido: Buffer.from(await new Response(r.stream).arrayBuffer()), tipo: r.blob.contentType ?? null };
    },
    async borrar(objetos) {
      const { del } = await blob();
      for (let i = 0; i < objetos.length; i += 100) await del(objetos.slice(i, i + 100).map((o) => o.ref), { token });
    },
    async subir(clave, contenido, tipo) {
      const { put } = await blob();
      const r = await put(clave, contenido, {
        access: 'private',
        token,
        addRandomSuffix: false,
        allowOverwrite: true,
        ...(tipo ? { contentType: tipo } : {}),
      });
      return r.url;
    },
  };
}

// ---------------- Disco (solo pruebas en local) ----------------

/** `carpeta` es la carpeta storage/ (la que usa la app en local). */
export function almacenDisco(carpeta: string): Almacen {
  const raiz = path.resolve(carpeta);
  const ruta = (clave: string) => {
    const r = path.resolve(raiz, ...clave.split('/'));
    if (!r.startsWith(raiz + path.sep)) throw new Error(`Ruta fuera del almacén: ${clave}`);
    return r;
  };
  return {
    tipo: 'disco',
    descripcion: `carpeta ${raiz} (solo para pruebas en local)`,
    async listar() {
      const out: Objeto[] = [];
      const recorrer = async (dir: string): Promise<void> => {
        let entradas;
        try {
          entradas = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entradas) {
          const r = path.join(dir, e.name);
          if (e.isDirectory()) await recorrer(r);
          else {
            const clave = path.relative(raiz, r).split(path.sep).join('/');
            const st = await fsp.stat(r);
            out.push({ clave, ref: `storage/${clave}`, tamano: st.size, fecha: st.mtime });
          }
        }
      };
      await recorrer(raiz);
      return out.sort((a, b) => a.clave.localeCompare(b.clave));
    },
    async leer(o) {
      return { contenido: await fsp.readFile(ruta(o.clave)), tipo: null };
    },
    async borrar(objetos) {
      for (const o of objetos) await fsp.rm(ruta(o.clave), { force: true });
      await podarVacias(raiz, raiz);
    },
    async subir(clave, contenido) {
      const r = ruta(clave);
      await fsp.mkdir(path.dirname(r), { recursive: true });
      await fsp.writeFile(r, contenido);
      return `storage/${clave}`;
    },
  };
}

/** Quita las carpetas que se han quedado vacias (sin tocar la raiz). */
async function podarVacias(dir: string, raiz: string): Promise<void> {
  let entradas;
  try {
    entradas = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entradas) if (e.isDirectory()) await podarVacias(path.join(dir, e.name), raiz);
  if (dir !== raiz && (await fsp.readdir(dir)).length === 0) await fsp.rmdir(dir).catch(() => undefined);
}

// ---------------- Sin almacen ----------------

export function sinAlmacen(motivo: string): Almacen {
  const no = async (): Promise<never> => {
    throw new Error(motivo);
  };
  return { tipo: 'ninguno', descripcion: motivo, listar: async () => [], leer: no, borrar: no, subir: no };
}

// ---------------- Referencias en la base ----------------

/**
 * Columnas de la base que guardan la referencia de un fichero. Solo sirve para
 * ensenar cuantos hay de cada cosa: lo que se borra del almacen sale de
 * listarlo (PREFIJOS_APP), no de aqui.
 */
export const REFERENCIAS_EN_BD: ReadonlyArray<{ tabla: string; columna: string; que: string }> = [
  { tabla: 'LecturaDocumento', columna: 'archivoRef', que: 'facturas leídas con el lector' },
  { tabla: 'DocumentoArchivo', columna: 'archivoPath', que: 'archivo de facturas y nóminas' },
  { tabla: 'IncomeReaderDocument', columna: 'storagePath', que: 'lector de ingresos antiguo' },
  { tabla: 'OCRSession', columna: 'originalFilePath', que: 'sesiones OCR antiguas' },
  { tabla: 'OCRSession', columna: 'ocrPdfPath', que: 'PDF de sesiones OCR antiguas' },
  { tabla: 'AccountingClosureFile', columna: 'storagePath', que: 'ficheros del cierre contable' },
  { tabla: 'LegalBook', columna: 'filePath', que: 'libros para legalizar' },
  { tabla: 'LegalizationPackage', columna: 'zipPath', que: 'ZIP de legalización' },
  { tabla: 'LegalizationPackage', columna: 'diligencePath', que: 'diligencias del Registro' },
  { tabla: 'AnnualAccounts', columna: 'filePath', que: 'cuentas anuales' },
];

export interface ReferenciasBd {
  porTipo: Array<{ que: string; tabla: string; n: number }>;
  /** Ficheros de la gestoria guardados en las cargas de 2026 (CargaArranque.ficheros). */
  ficherosCarga: number;
  /** Logos de empresa (dentro de la base, LegalConfig.logo). */
  logos: number;
}

export async function contarReferencias(db: PrismaClient, tablas: readonly Pick<Tabla, 'nombre' | 'columnas'>[]): Promise<ReferenciasBd> {
  const existe = (t: string, c: string) => tablas.some((x) => x.nombre === t && x.columnas.some((y) => y.nombre === c));
  const porTipo: ReferenciasBd['porTipo'] = [];
  for (const r of REFERENCIAS_EN_BD) {
    if (!existe(r.tabla, r.columna)) continue;
    const [f] = await db.$queryRawUnsafe<Array<{ n: unknown }>>(
      `SELECT COUNT(*) AS n FROM ${id(r.tabla)} WHERE ${id(r.columna)} IS NOT NULL AND ${id(r.columna)} <> ''`,
    );
    if (num(f?.n)) porTipo.push({ que: r.que, tabla: r.tabla, n: num(f?.n) });
  }
  let ficherosCarga = 0;
  if (existe('CargaArranque', 'ficheros')) {
    const filas = await db.$queryRawUnsafe<Array<{ f: string | null }>>(`SELECT CAST(${id('ficheros')} AS CHAR) AS f FROM ${id('CargaArranque')}`);
    for (const { f } of filas) {
      try {
        const v = JSON.parse(f ?? '[]');
        if (Array.isArray(v)) ficherosCarga += v.length;
      } catch {
        // fila rara: no cuenta
      }
    }
  }
  let logos = 0;
  if (existe('LegalConfig', 'logo')) {
    const [f] = await db.$queryRawUnsafe<Array<{ n: unknown }>>(`SELECT COUNT(*) AS n FROM ${id('LegalConfig')} WHERE ${id('logo')} IS NOT NULL`);
    logos = num(f?.n);
  }
  return { porTipo, ficherosCarga, logos };
}

/** Nombre seguro en Windows para guardar un fichero del almacen en la copia local. */
export function rutaLocalDe(clave: string): string {
  return clave
    .split('/')
    .filter((p) => p.length > 0)
    .map((p) => {
      const limpio = p.replace(/[<>:"|?*\\\x00-\x1f]/g, '_');
      return limpio === '.' || limpio === '..' ? '_' : limpio;
    })
    .join('/');
}
