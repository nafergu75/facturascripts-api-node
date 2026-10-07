/**
 * Ajustes fiscales (Configuración > Impuestos), solo empresas españolas.
 *
 * En la v1 solo lo que cambia el calendario de modelos: periodicidad del IVA,
 * REDEME, SII y gran empresa (y, por la forma jurídica, el 130 de los
 * autónomos). Reglas, en pantalla y aquí: gran empresa obliga a SII; SII o
 * REDEME obligan a IVA mensual. El recargo de equivalencia, el criterio de caja
 * y la prorrata todavía no se aplican en los asientos ni en el 303: el PUT los
 * rechaza si no tienen su valor por defecto.
 *
 * Sin fila, los valores por defecto (sin crearla). El PUT hace un upsert y
 * adapta el calendario del año en curso y siguientes (aplicarCambioCalendario):
 * lo presentado u omitido no se toca y la respuesta dice desde cuándo se aplica.
 */
import { z } from 'zod';
import { prisma } from '../config/database';
import {
  AjustesFiscales,
  ajustesFiscalesDeFila,
  PERIODICIDADES_IVA,
  UMBRAL_GRAN_EMPRESA,
} from '../domain/ajustes.model';
import { badRequest, conflict } from '../utils/http-errors';
import { errorDeValidacion } from '../utils/zod-errores';
import { hoyEspana } from '../utils/fechas';
import { perfilEmpresa } from './perfilEmpresa.service';
import {
  aplicarCambioCalendario,
  opcionesCalendarioEmpresa,
  vistaCalendario,
  type CambioCalendario,
  type ModeloPrevisto,
} from './impuestosModulo.service';

export const MENSAJE_EMPRESA_NO_ESPANOLA =
  'La empresa no está establecida en España: no presenta modelos de la AEAT y no tiene ajustes fiscales.';

/** Ajustes que se ven pero todavía no se pueden activar. */
export const AJUSTES_NO_DISPONIBLES = ['recargoEquivalencia', 'criterioCaja', 'prorrata'] as const;

export interface AjustesFiscalesResp extends AjustesFiscales {
  /** false: todavía no se han guardado (son los de por defecto). */
  guardado: boolean;
  /** Forma jurídica Autónomo: 130 en lugar del 200 (se cambia en los datos de la empresa). */
  autonomo: boolean;
  noDisponibles: readonly string[];
  actualizadoEn: string | null;
  actualizadoPor: string | null;
  /** Modelos que salen en el ejercicio en curso con estos ajustes. */
  calendario: { ejercicio: number; modelos: ModeloPrevisto[] };
}

async function exigirEmpresaEspanola(companyId: string): Promise<void> {
  if (!(await perfilEmpresa(companyId)).espanola) throw conflict(MENSAJE_EMPRESA_NO_ESPANOLA);
}

async function leerFila(companyId: string) {
  return prisma.ajustesFiscales.findUnique({ where: { companyId } });
}

/** GET: los ajustes (o los de por defecto) y el calendario del año en curso. */
export async function obtenerAjustesFiscales(companyId: string, hoy: string = hoyEspana()): Promise<AjustesFiscalesResp> {
  await exigirEmpresaEspanola(companyId);
  const [fila, opciones] = await Promise.all([leerFila(companyId), opcionesCalendarioEmpresa(companyId)]);
  const ejercicio = Number(hoy.slice(0, 4));
  return {
    ...ajustesFiscalesDeFila(fila),
    guardado: !!fila,
    autonomo: opciones.autonomo,
    noDisponibles: AJUSTES_NO_DISPONIBLES,
    actualizadoEn: fila?.updatedAt.toISOString() ?? null,
    actualizadoPor: fila?.updatedBy ?? null,
    calendario: { ejercicio, modelos: vistaCalendario(ejercicio, opciones) },
  };
}

const esquema = z
  .object({
    periodicidadIva: z.enum(PERIODICIDADES_IVA),
    redeme: z.boolean(),
    sii: z.boolean(),
    granEmpresa: z.boolean(),
    recargoEquivalencia: z.boolean(),
    criterioCaja: z.boolean(),
    prorrata: z.number().min(0).max(100).nullable(),
  })
  .partial()
  .strict();

const NO_DISPONIBLE = 'todavía no se aplica en los asientos ni en el 303: no se puede activar aún.';
const MENSAJES: Record<string, string> = {
  periodicidadIva: 'La periodicidad del IVA es TRIMESTRAL o MENSUAL.',
  redeme: 'Indica si la empresa está inscrita en REDEME (sí o no).',
  sii: 'Indica si la empresa lleva los libros por el SII (sí o no).',
  granEmpresa: 'Indica si la empresa es gran empresa (sí o no).',
  recargoEquivalencia: `El recargo de equivalencia ${NO_DISPONIBLE}`,
  criterioCaja: `El criterio de caja ${NO_DISPONIBLE}`,
  prorrata: `La prorrata ${NO_DISPONIBLE}`,
};

/** Reglas entre ajustes (400 con el campo que hay que cambiar). */
export function validarReglasFiscales(a: AjustesFiscales): void {
  if (a.recargoEquivalencia) throw badRequest(MENSAJES.recargoEquivalencia, { campo: 'recargoEquivalencia' });
  if (a.criterioCaja) throw badRequest(MENSAJES.criterioCaja, { campo: 'criterioCaja' });
  if (a.prorrata !== null) throw badRequest(MENSAJES.prorrata, { campo: 'prorrata' });
  if (a.granEmpresa && !a.sii) {
    throw badRequest(`Una gran empresa (más de ${UMBRAL_GRAN_EMPRESA} de volumen de operaciones) tiene que llevar los libros por el SII: marca también el SII.`, {
      campo: 'sii',
    });
  }
  if ((a.sii || a.redeme) && a.periodicidadIva !== 'MENSUAL') {
    throw badRequest('Con el SII o la inscripción en REDEME el IVA se declara cada mes: elige la periodicidad mensual.', { campo: 'periodicidadIva' });
  }
}

/** Los ajustes actuales con los cambios que llegan, ya validados. */
async function combinar(companyId: string, entrada: unknown): Promise<AjustesFiscales> {
  const r = esquema.safeParse(entrada ?? {});
  if (!r.success) throw errorDeValidacion(r.error, MENSAJES);
  const nuevo: AjustesFiscales = { ...ajustesFiscalesDeFila(await leerFila(companyId)), ...r.data };
  validarReglasFiscales(nuevo);
  return nuevo;
}

/** Explicación, para quien no es técnico, de desde cuándo cambia el calendario del año. */
export function avisoCambioCalendario(cambio: Pick<CambioCalendario, 'ejercicio' | 'aplicadoDesde'>): string | null {
  const { ejercicio, aplicadoDesde } = cambio;
  if (aplicadoDesde === `${ejercicio}-01-01`) return null;
  if (aplicadoDesde === null) {
    return `Los modelos del ${ejercicio} ya presentados u omitidos ocupan todo el año: el calendario nuevo se aplica desde el 1 de enero de ${ejercicio + 1}.`;
  }
  const [a, m, d] = aplicadoDesde.split('-');
  return `Hay modelos del ${ejercicio} ya presentados, omitidos o editados a mano: esos no cambian y el calendario nuevo se aplica desde el ${d}/${m}/${a}.`;
}

/** PUT: guarda los ajustes (upsert) y adapta el calendario del año en curso y siguientes. */
export async function guardarAjustesFiscales(
  companyId: string,
  userId: string,
  entrada: unknown,
  hoy: string = hoyEspana(),
): Promise<AjustesFiscalesResp & { cambiosCalendario: CambioCalendario[]; aviso: string | null }> {
  await exigirEmpresaEspanola(companyId);
  const nuevo = await combinar(companyId, entrada);
  const datos = { ...nuevo, updatedBy: userId };
  await prisma.ajustesFiscales.upsert({ where: { companyId }, create: { companyId, ...datos }, update: datos });
  const opciones = await opcionesCalendarioEmpresa(companyId);
  const cambiosCalendario = await aplicarCambioCalendario(companyId, opciones, hoy);
  const delAnio = cambiosCalendario.find((c) => c.ejercicio === Number(hoy.slice(0, 4)));
  return {
    ...(await obtenerAjustesFiscales(companyId, hoy)),
    cambiosCalendario,
    aviso: delAnio ? avisoCambioCalendario(delAnio) : null,
  };
}

/** POST vista-previa: el calendario que saldría con esos ajustes, sin guardar nada. */
export async function previsualizarAjustesFiscales(
  companyId: string,
  entrada: unknown,
  hoy: string = hoyEspana(),
): Promise<{ ajustes: AjustesFiscales; ejercicio: number; modelos: ModeloPrevisto[] }> {
  await exigirEmpresaEspanola(companyId);
  const { ejercicio: ejercicioPedido, ...resto } = (entrada ?? {}) as Record<string, unknown>;
  const ejercicio = ejercicioPedido === undefined ? Number(hoy.slice(0, 4)) : Number(ejercicioPedido);
  if (!Number.isInteger(ejercicio) || ejercicio < 1990 || ejercicio > 2100) {
    throw badRequest('Indica el año del ejercicio con cuatro cifras.', { campo: 'ejercicio' });
  }
  const ajustes = await combinar(companyId, resto);
  const { autonomo } = await opcionesCalendarioEmpresa(companyId);
  return { ajustes, ejercicio, modelos: vistaCalendario(ejercicio, { ajustes, autonomo }) };
}
