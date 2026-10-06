import { createHash, randomUUID } from 'crypto';
import { badRequest } from '../../utils/http-errors';
import { deleteObjects, getObjectByKey, listObjects, putObject } from '../../utils/storage';

/**
 * Subida de ficheros grandes por trozos (Puesta en marcha).
 *
 * Vercel corta las peticiones de mas de ~4,5 MB, asi que el navegador parte el
 * fichero en trozos de ~3 MB y los manda uno a uno. Cada trozo se guarda en el
 * almacenamiento (Vercel Blob privado en produccion, disco en local) bajo
 * `puesta-en-marcha/subidas/<empresa>/<subidaId>/`, junto con un meta.json
 * (nombre, tamano y numero de trozos). La vista previa y la confirmacion
 * reciben `subidaId` en vez del fichero, lo reensamblan y lo procesan igual.
 *
 * La clave lleva la empresa: una subida solo se puede usar desde la empresa que
 * la hizo. Los trozos se borran al confirmar; las subidas abandonadas, al
 * empezar otra en la misma empresa pasadas 24 horas.
 */

export const TAM_MAX_SUBIDA = 50 * 1024 * 1024;
export const TAM_MAX_TROZO = 4 * 1024 * 1024;
const MAX_TROZOS = 200;
const CADUCIDAD_MS = 24 * 60 * 60 * 1000;
const ID_RE = /^[a-f0-9-]{36}$/;
const EXTENSIONES = /\.(xlsx|xls|csv|txt)$/i;

interface MetaSubida {
  nombre: string;
  tamano: number;
  total: number;
  creada: string;
}

const prefijoEmpresa = (companyId: string) => `puesta-en-marcha/subidas/${companyId}/`;
const prefijoSubida = (companyId: string, subidaId: string) => `${prefijoEmpresa(companyId)}${subidaId}/`;
const claveMeta = (companyId: string, subidaId: string) => `${prefijoSubida(companyId, subidaId)}meta.json`;
const claveTrozo = (companyId: string, subidaId: string, i: number) => `${prefijoSubida(companyId, subidaId)}trozo-${String(i).padStart(4, '0')}`;

function entero(v: unknown, campo: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw badRequest(`El campo "${campo}" no es válido.`);
  return n;
}

function validarId(subidaId: unknown): string {
  const id = String(subidaId ?? '').toLowerCase();
  if (!ID_RE.test(id)) throw badRequest('El identificador de la subida no es válido.');
  return id;
}

async function leerMeta(companyId: string, subidaId: string): Promise<MetaSubida> {
  const raw = await getObjectByKey(claveMeta(companyId, subidaId));
  if (!raw) throw badRequest('La subida no existe o ha caducado: vuelve a seleccionar el fichero.');
  return JSON.parse(raw.toString('utf-8')) as MetaSubida;
}

/** Borra las subidas de la empresa de hace mas de 24 horas (sin fallar si no puede). */
async function limpiarCaducadas(companyId: string): Promise<void> {
  try {
    const limite = Date.now() - CADUCIDAD_MS;
    const viejas = (await listObjects(prefijoEmpresa(companyId))).filter((o) => o.fecha.getTime() < limite).map((o) => o.key);
    await deleteObjects(viejas);
  } catch {
    // Limpieza oportunista: si falla, ya se intentara en la siguiente subida.
  }
}

export interface DatosTrozo {
  subidaId?: string;
  indice: unknown;
  total: unknown;
  nombre?: unknown;
  tamano?: unknown;
  /** SHA-256 (hex) del trozo, opcional: si viene, se comprueba. */
  hash?: unknown;
}

/**
 * Guarda un trozo. El primero (indice 0) abre la subida y devuelve su id; los
 * demas tienen que traer ese id.
 */
export async function recibirTrozo(
  companyId: string,
  datos: DatosTrozo,
  trozo: Buffer | undefined,
): Promise<{ subidaId: string; indice: number; total: number; completa: boolean }> {
  if (!trozo || trozo.length === 0) throw badRequest('Falta el trozo del fichero (campo "trozo").');
  if (trozo.length > TAM_MAX_TROZO) throw badRequest('El trozo es demasiado grande (máximo 4 MB).');
  const indice = entero(datos.indice, 'indice');
  const total = entero(datos.total, 'total');
  if (total < 1 || total > MAX_TROZOS) throw badRequest('Número de trozos no válido.');
  if (indice >= total) throw badRequest('El índice del trozo no es válido.');
  if (datos.hash !== undefined && datos.hash !== '') {
    const hash = createHash('sha256').update(trozo).digest('hex');
    if (String(datos.hash).toLowerCase() !== hash) throw badRequest(`El trozo ${indice + 1} ha llegado dañado: vuelve a subir el fichero.`);
  }

  let subidaId: string;
  if (indice === 0) {
    const nombre = String(datos.nombre ?? '').trim();
    if (!EXTENSIONES.test(nombre)) throw badRequest('El fichero tiene que ser un Excel (.xlsx, .xls) o un CSV.');
    const tamano = entero(datos.tamano, 'tamano');
    if (tamano === 0) throw badRequest('El fichero está vacío.');
    if (tamano > TAM_MAX_SUBIDA) throw badRequest(`El fichero pesa demasiado (máximo ${TAM_MAX_SUBIDA / 1024 / 1024} MB).`);
    await limpiarCaducadas(companyId);
    subidaId = randomUUID();
    const meta: MetaSubida = { nombre: nombre.slice(0, 200), tamano, total, creada: new Date().toISOString() };
    await putObject(claveMeta(companyId, subidaId), Buffer.from(JSON.stringify(meta)), 'application/json');
  } else {
    subidaId = validarId(datos.subidaId);
    const meta = await leerMeta(companyId, subidaId);
    if (meta.total !== total) throw badRequest('El número de trozos no coincide con el del inicio de la subida.');
  }

  await putObject(claveTrozo(companyId, subidaId, indice), trozo);
  return { subidaId, indice, total, completa: indice === total - 1 };
}

/** Junta los trozos de una subida de la empresa y devuelve el fichero. */
export async function reensamblarSubida(companyId: string, subidaIdRaw: unknown): Promise<{ buffer: Buffer; originalname: string }> {
  const subidaId = validarId(subidaIdRaw);
  const meta = await leerMeta(companyId, subidaId);
  const trozos: Buffer[] = [];
  // De 4 en 4: suficiente para no tardar y sin abrir decenas de conexiones.
  for (let i = 0; i < meta.total; i += 4) {
    const lote = await Promise.all(
      Array.from({ length: Math.min(4, meta.total - i) }, (_, k) => getObjectByKey(claveTrozo(companyId, subidaId, i + k))),
    );
    lote.forEach((b, k) => {
      if (!b) throw badRequest(`Falta el trozo ${i + k + 1} de ${meta.total}: la subida no terminó. Vuelve a subir el fichero.`);
      trozos.push(b);
    });
  }
  const buffer = Buffer.concat(trozos);
  if (buffer.length !== meta.tamano) {
    throw badRequest('El fichero reconstruido no tiene el tamaño esperado: vuelve a subirlo.');
  }
  return { buffer, originalname: meta.nombre };
}

/** Borra los trozos y el meta de una subida (sin fallar si ya no estan). */
export async function borrarSubida(companyId: string, subidaIdRaw: unknown): Promise<void> {
  const subidaId = validarId(subidaIdRaw);
  try {
    const claves = (await listObjects(prefijoSubida(companyId, subidaId))).map((o) => o.key);
    await deleteObjects(claves);
  } catch {
    // Si no se puede borrar ahora, la limpieza de subidas caducadas lo hara.
  }
}
