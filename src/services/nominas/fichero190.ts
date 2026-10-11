/**
 * Fichero del modelo 190 de una empresa: calcula los perceptores, comprueba la
 * declaracion y compone el fichero (modelo190.ts) con lo que pone el historial
 * de declaraciones (B4 y B5): numero identificativo, complementaria o
 * sustitutiva, numero de la anterior y perceptores elegidos. La persona de
 * contacto y el telefono son los de Registro Mercantil > Datos (B3). Solo lee:
 * el numero lo asigna POST /tax-models/190/declaraciones/numero.
 */
import { badRequest } from '../../utils/http-errors';
import { normalizarNif } from '../../utils/nif';
import { configuracionEmpresa } from '../impuestosModulo.service';
import { calcularModelo190, type Perceptor190 } from './fiscal';
import { avisosFichero190, comprobarDiseno190, erroresFichero190, generarFicheroModelo190, idRegistro190, type Declarante190 } from './modelo190';
import { contactoEmpresa, declaracionInformativa, exigirNumero } from '../borradoresAeat/comun';
import { contextoDeclaracion, datosDe } from '../declaracionesAeat/declaraciones.service';

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

/** Registros que van en el fichero: todos, o en una complementaria solo los elegidos (que sigan existiendo). */
export function perceptoresDeLaDeclaracion<T extends Perceptor190>(perceptores: T[], tipo: 'C' | 'S' | null | undefined, seleccion: string[] | null | undefined): T[] {
  if (tipo !== 'C' || !seleccion) return perceptores;
  const ids = new Set(seleccion.map(String));
  const elegidos = perceptores.filter((p) => ids.has(idRegistro190(p)));
  if (!elegidos.length) throw badRequest(MENSAJE_COMPLEMENTARIA_SIN_SELECCION);
  return elegidos;
}

export interface Fichero190 {
  contenido: string;
  numeroDeclaracion: string;
  registros: number;
  avisos: string[];
}

/**
 * Fichero del 190 tal como va a la sede. Si esta presentado (y no se prepara
 * otra declaracion), el que se guardo al presentarlo. 409 si aun no tiene
 * numero identificativo.
 */
export async function ficheroModelo190(companyId: string, ejercicio: number): Promise<Fichero190> {
  comprobarDiseno190(ejercicio);
  const ctx = await contextoDeclaracion(companyId, '190', ejercicio, '0A');
  if (ctx.congelada) {
    const guardado = datosDe(ctx.ultimaPresentada).fichero;
    if (!guardado) throw badRequest('El 190 está presentado pero no se guardó su fichero: descárgalo de la sede.');
    return { contenido: guardado, numeroDeclaracion: ctx.ultimaPresentada!.numero ?? '', registros: datosDe(ctx.ultimaPresentada).registros?.length ?? 0, avisos: [] };
  }
  const d = await declaracion190(companyId, ejercicio);
  // Primero lo que la sede rechazaria; despues, el numero (lo pone una operacion de escritura).
  if (d.errores.length) {
    throw badRequest(`No se puede generar el fichero del 190: ${d.errores.slice(0, 5).join(' ')}${d.errores.length > 5 ? ` (y ${d.errores.length - 5} más)` : ''}`, { errores: d.errores });
  }
  const numero = exigirNumero(d.declarante.numeroDeclaracion, '190');
  return {
    contenido: generarFicheroModelo190(ejercicio, d.declarante, d.perceptores),
    numeroDeclaracion: numero,
    registros: d.perceptores.length,
    avisos: avisosFichero190(ejercicio, d.declarante),
  };
}

/** Declarante, perceptores que van y errores del 190 en curso (lo comparten la pantalla, el fichero y la presentacion). */
export async function declaracion190(companyId: string, ejercicio: number) {
  const [m, cfg, contacto, decl] = await Promise.all([
    calcularModelo190(companyId, ejercicio),
    configuracionEmpresa(companyId),
    contactoEmpresa(companyId),
    declaracionInformativa(companyId, '190', ejercicio, '0A'),
  ]);
  const declarante: Declarante190 = {
    nif: normalizarNif(cfg.config_nif ?? ''),
    nombre: String(cfg.config_razon_social ?? ''),
    telefono: contacto.telefono,
    contacto: contacto.personaContacto,
    tipoDeclaracion: decl.tipoDeclaracion,
    numeroAnterior: decl.declaracionAnterior ?? undefined,
    numeroDeclaracion: decl.numeroDeclaracion,
  };
  const elegidos = decl.tipoDeclaracion === 'C' && decl.seleccion ? m.perceptores.filter((p) => decl.seleccion!.includes(idRegistro190(p))) : m.perceptores;
  const errores = erroresFichero190(declarante, elegidos);
  if (decl.tipoDeclaracion === 'C' && decl.seleccion && !elegidos.length) errores.unshift(MENSAJE_COMPLEMENTARIA_SIN_SELECCION);
  return { modelo: m, declarante, perceptores: elegidos, todos: m.perceptores, errores, decl };
}
