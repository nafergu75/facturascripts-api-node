/**
 * Fichero del modelo 190 de una empresa: calcula los perceptores, comprueba la
 * declaracion, le da su numero identificativo (numeracion190.ts) y compone el
 * fichero (modelo190.ts). Lo usa la ruta POST /nominas/190/:ejercicio/fichero.
 */
import { badRequest } from '../../utils/http-errors';
import { normalizarNif } from '../../utils/nif';
import { configuracionEmpresa } from '../impuestosModulo.service';
import { calcularModelo190 } from './fiscal';
import { avisosFichero190, comprobarDiseno190, erroresFichero190, generarFicheroModelo190, idRegistro190, type Declarante190 } from './modelo190';
import { asignarNumero190, firmaRegistros } from './numeracion190';

export interface EntradaFichero190 {
  telefono?: string;
  contacto?: string;
  email?: string;
  tipoDeclaracion?: 'C' | 'S' | null;
  numeroAnterior?: string;
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
  };
}

export async function ficheroModelo190(companyId: string, ejercicio: number, e: EntradaFichero190): Promise<Fichero190> {
  comprobarDiseno190(ejercicio);
  const [m, cfg] = await Promise.all([calcularModelo190(companyId, ejercicio), configuracionEmpresa(companyId)]);
  const perceptores = m.perceptores;
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
