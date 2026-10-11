/**
 * Fichero del modelo 190 de una empresa: calcula los perceptores, comprueba la
 * declaracion, le da su numero identificativo (numeracion190.ts) y compone el
 * fichero (modelo190.ts). Lo usa la ruta POST /nominas/190/:ejercicio/fichero.
 */
import { badRequest } from '../../utils/http-errors';
import { normalizarNif } from '../../utils/nif';
import { configuracionEmpresa } from '../impuestosModulo.service';
import { calcularModelo190, type Perceptor190 } from './fiscal';
import { avisosFichero190, comprobarDiseno190, erroresFichero190, generarFicheroModelo190, idRegistro190, type Declarante190 } from './modelo190';
import { asignarNumero190, firmaRegistros } from './numeracion190';

export interface EntradaFichero190 {
  telefono?: string;
  contacto?: string;
  email?: string;
  tipoDeclaracion?: 'C' | 'S' | null;
  numeroAnterior?: string;
  /** Complementaria: ids (idRegistro190) de los registros omitidos que se incluyen. */
  perceptores?: string[];
}

/**
 * Instrucciones del modelo 190 de la sede (GI10): «En la declaración
 * complementaria solamente se incluirán las percepciones omitidas que motivan
 * su presentación». Diseño de 2025, posición 121: la «C» es para «incluir
 * percepciones que [...] hubieran sido completamente omitidas»; modificar lo
 * declarado se hace en la sede o con una sustitutiva.
 */
export const MENSAJE_COMPLEMENTARIA_SIN_SELECCION =
  'En una complementaria solo van los perceptores que se quedaron fuera de la declaración anterior: márcalos en la relación de perceptores. ' +
  'Si lo que quieres es corregir datos ya declarados, presenta una sustitutiva (S), que reemplaza a la anterior con todos los perceptores.';

/** Registros que van en el fichero: todos, o en una complementaria solo los elegidos. 400 si no hay seleccion o no existe. */
export function perceptoresDeLaDeclaracion<T extends Perceptor190>(perceptores: T[], tipo: 'C' | 'S' | null | undefined, seleccion: string[] | undefined): T[] {
  if (tipo !== 'C') return perceptores;
  const ids = [...new Set((seleccion ?? []).map(String))];
  if (!ids.length) throw badRequest(MENSAJE_COMPLEMENTARIA_SIN_SELECCION);
  const porId = new Map(perceptores.map((p) => [idRegistro190(p), p]));
  const desconocidos = ids.filter((id) => !porId.has(id));
  if (desconocidos.length) {
    throw badRequest('Algunos perceptores marcados ya no están en el 190 del ejercicio (han cambiado las nóminas o las facturas): vuelve a cargar la pantalla y márcalos de nuevo.', { desconocidos });
  }
  return perceptores.filter((p) => ids.includes(idRegistro190(p)));
}

export interface Fichero190 {
  contenido: string;
  numeroDeclaracion: string;
  registros: number;
  avisos: string[];
}

const texto = (v: unknown) => (v === undefined || v === null || String(v).trim() === '' ? undefined : String(v).trim());

/** Datos del cuerpo (o de la query) de la ruta del fichero. 400 si el tipo no es C ni S. */
export function entradaFichero190(q: Record<string, unknown>): EntradaFichero190 {
  const tipo = String(q.tipoDeclaracion ?? '').toUpperCase().trim();
  if (tipo && tipo !== 'C' && tipo !== 'S') throw badRequest('El tipo de declaración del 190 es C (complementaria) o S (sustitutiva).');
  return {
    telefono: texto(q.telefono),
    contacto: texto(q.contacto),
    email: texto(q.email),
    tipoDeclaracion: (tipo || null) as 'C' | 'S' | null,
    numeroAnterior: texto(q.numeroAnterior)?.replace(/\s/g, ''),
    perceptores: Array.isArray(q.perceptores) ? q.perceptores.map(String) : typeof q.perceptores === 'string' && q.perceptores ? q.perceptores.split(',') : undefined,
  };
}

export async function ficheroModelo190(companyId: string, ejercicio: number, e: EntradaFichero190): Promise<Fichero190> {
  comprobarDiseno190(ejercicio);
  const [m, cfg] = await Promise.all([calcularModelo190(companyId, ejercicio), configuracionEmpresa(companyId)]);
  const perceptores = perceptoresDeLaDeclaracion(m.perceptores, e.tipoDeclaracion, e.perceptores);
  const declarante: Declarante190 = {
    nif: normalizarNif(cfg.config_nif ?? ''),
    nombre: String(cfg.config_razon_social ?? ''),
    telefono: e.telefono,
    contacto: e.contacto,
    email: e.email,
    tipoDeclaracion: e.tipoDeclaracion ?? null,
    numeroAnterior: e.numeroAnterior,
  };
  // Primero lo que la sede rechazaria: asi un fichero que no sale no gasta numero.
  const errores = erroresFichero190(declarante, perceptores);
  if (errores.length) {
    throw badRequest(`No se puede generar el fichero del 190: ${errores.slice(0, 5).join(' ')}${errores.length > 5 ? ` (y ${errores.length - 5} más)` : ''}`, { errores });
  }
  const { numero } = await asignarNumero190(companyId, ejercicio, {
    tipo: declarante.tipoDeclaracion ?? 'N',
    anterior: declarante.tipoDeclaracion ? (declarante.numeroAnterior ?? null) : null,
    firma: firmaRegistros(perceptores.map(idRegistro190)),
  });
  const conNumero = { ...declarante, numeroDeclaracion: numero };
  return {
    contenido: generarFicheroModelo190(ejercicio, conNumero, perceptores),
    numeroDeclaracion: numero,
    registros: perceptores.length,
    avisos: avisosFichero190(ejercicio, conNumero),
  };
}
