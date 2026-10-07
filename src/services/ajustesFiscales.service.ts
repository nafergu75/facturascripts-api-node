/**
 * Ajustes fiscales (Configuración > Impuestos), solo empresas españolas.
 *
 * En la v1 solo lo que cambia el calendario de modelos: periodicidad del IVA,
 * REDEME, SII y gran empresa (y, por la forma jurídica, el 130 de los
 * autónomos). Reglas, en pantalla y aquí: gran empresa y REDEME obligan a SII
 * (art. 62.6 RIVA), y el IVA mensual existe solo con el SII: IVA mensual y SII
 * van siempre juntos (así, con IVA mensual nunca salen el 390 ni el 347). El recargo de equivalencia, el criterio de caja
 * y la prorrata todavía no se aplican en los asientos ni en el 303: el PUT los
 * rechaza si no tienen su valor por defecto.
 *
 * Sin fila, los valores por defecto (sin crearla). El PUT hace un upsert y
 * adapta el calendario del año en curso y siguientes (aplicarCambioCalendario):
 * lo presentado u omitido no se toca, ni los periodos que ya han empezado (un
 * cambio de régimen no es retroactivo; con `aplicarDesde` se adelanta a un
 * trimestre ya empezado del año en curso), y la respuesta dice desde cuándo se
 * aplica. El calendario que se enseña (GET y vista previa) sale de las filas
 * reales del año, no del teórico: lo presentado se ve y lo que no se va a
 * crear no sale.
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
  calendarioResultante,
  opcionesCalendarioEmpresa,
  type CambioCalendario,
  type ModeloPrevisto,
} from './impuestosModulo.service';
import { iniciosTrimestre } from '../domain/calendarioFiscal';

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
  /** Modelos del ejercicio en curso: los que hay (presentados incluidos) y los que se crearán. */
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
  const ejercicio = Number(hoy.slice(0, 4));
  const [fila, opciones] = await Promise.all([leerFila(companyId), opcionesCalendarioEmpresa(companyId, ejercicio)]);
  const { modelos } = await calendarioResultante(companyId, ejercicio, opciones, hoy);
  return {
    ...ajustesFiscalesDeFila(fila),
    guardado: !!fila,
    autonomo: opciones.autonomo,
    noDisponibles: AJUSTES_NO_DISPONIBLES,
    actualizadoEn: fila?.updatedAt.toISOString() ?? null,
    actualizadoPor: fila?.updatedBy ?? null,
    calendario: { ejercicio, modelos },
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
  if (a.redeme && !a.sii) {
    throw badRequest('Las empresas inscritas en REDEME llevan los libros por el SII: marca también el SII.', { campo: 'sii' });
  }
  if (a.periodicidadIva === 'MENSUAL' && !a.sii) {
    throw badRequest(
      'El IVA mensual solo es para las empresas que llevan los libros por el SII (gran empresa, REDEME o SII voluntario): marca el SII o deja el IVA trimestral.',
      { campo: 'sii' },
    );
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

/** Lo que decide el calendario (los tres de la v1 no se pueden activar). */
const mismosAjustes = (a: AjustesFiscales, b: AjustesFiscales) =>
  a.periodicidadIva === b.periodicidadIva && a.redeme === b.redeme && a.sii === b.sii && a.granEmpresa === b.granEmpresa;

const ddmmaaaa = (f: string) => f.split('-').reverse().join('/');

/**
 * `aplicarDesde` del cuerpo: el inicio de un trimestre del año en curso
 * (01-01, 04-01, 07-01 o 10-01). Sirve para adelantar el cambio a un periodo
 * que ya ha empezado, p. ej. una gran empresa desde el 1 de enero.
 */
function leerAplicarDesde(valor: unknown, hoy: string): string | undefined {
  if (valor === undefined || valor === null || valor === '') return undefined;
  const anio = Number(hoy.slice(0, 4));
  const validos = iniciosTrimestre(anio);
  if (typeof valor !== 'string' || !validos.includes(valor)) {
    throw badRequest(`Indica desde qué trimestre del ${anio} vale el cambio: ${validos.map(ddmmaaaa).join(', ')}.`, { campo: 'aplicarDesde' });
  }
  return valor;
}

/**
 * Explicación, para quien no es técnico, de desde cuándo cambia el calendario
 * del año. null si no hay nada que contar: sin cambios (guardar lo mismo no
 * avisa) o un cambio que vale para el año entero.
 */
export function avisoCambioCalendario(
  cambio: Pick<CambioCalendario, 'ejercicio' | 'aplicadoDesde' | 'borradas' | 'creadas' | 'borradasVencidas'>,
  cambiaronAjustes: boolean,
  hecho = true,
): string | null {
  const { ejercicio, aplicadoDesde } = cambio;
  if (!cambiaronAjustes && cambio.borradas + cambio.creadas === 0) return null;
  if (aplicadoDesde === null) {
    return `Los modelos del ${ejercicio} se quedan como están (ya no queda ningún trimestre por empezar sin modelos presentados, omitidos o editados a mano): el calendario nuevo se aplica desde el 1 de enero de ${ejercicio + 1}.`;
  }
  const partes: string[] = [];
  if (aplicadoDesde !== `${ejercicio}-01-01`) {
    partes.push(
      `El calendario nuevo se aplica desde el ${ddmmaaaa(aplicadoDesde)}: los modelos de antes no cambian (sus periodos ya han empezado o están presentados, omitidos o editados a mano).`,
    );
  }
  if (cambio.borradasVencidas > 0) {
    partes.push(
      `${hecho ? 'Se han quitado' : 'Se quitarán'} ${cambio.borradasVencidas} modelo(s) de periodos ya vencidos que no estaban marcados como presentados. Si ya se presentaron (por ejemplo, desde tu gestoría), márcalos como presentados${hecho ? ' en Fiscalidad' : ' antes de guardar'}.`,
    );
  }
  return partes.length ? partes.join(' ') : null;
}

/** PUT: guarda los ajustes (upsert) y adapta el calendario del año en curso y siguientes. */
export async function guardarAjustesFiscales(
  companyId: string,
  userId: string,
  entrada: unknown,
  hoy: string = hoyEspana(),
): Promise<AjustesFiscalesResp & { cambiosCalendario: CambioCalendario[]; aviso: string | null }> {
  await exigirEmpresaEspanola(companyId);
  const { aplicarDesde: pedido, ...resto } = (entrada ?? {}) as Record<string, unknown>;
  const aplicarDesde = leerAplicarDesde(pedido, hoy);
  const antes = ajustesFiscalesDeFila(await leerFila(companyId));
  const nuevo = await combinar(companyId, resto);
  const datos = { ...nuevo, updatedBy: userId };
  await prisma.ajustesFiscales.upsert({ where: { companyId }, create: { companyId, ...datos }, update: datos });
  const opciones = await opcionesCalendarioEmpresa(companyId);
  const cambiosCalendario = await aplicarCambioCalendario(companyId, opciones, hoy, aplicarDesde);
  const delAnio = cambiosCalendario.find((c) => c.ejercicio === Number(hoy.slice(0, 4)));
  return {
    ...(await obtenerAjustesFiscales(companyId, hoy)),
    cambiosCalendario,
    aviso: delAnio ? avisoCambioCalendario(delAnio, !mismosAjustes(antes, nuevo)) : null,
  };
}

/**
 * POST vista-previa: el calendario del ejercicio tal como quedaría con esos
 * ajustes, a partir de los modelos que ya hay, desde cuándo se aplicaría y el
 * mismo aviso que daría al guardar. No guarda nada.
 */
export async function previsualizarAjustesFiscales(
  companyId: string,
  entrada: unknown,
  hoy: string = hoyEspana(),
): Promise<{ ajustes: AjustesFiscales; ejercicio: number; modelos: ModeloPrevisto[]; aplicadoDesde: string | null; aviso: string | null }> {
  await exigirEmpresaEspanola(companyId);
  const { ejercicio: ejercicioPedido, aplicarDesde: pedido, ...resto } = (entrada ?? {}) as Record<string, unknown>;
  const ejercicio = ejercicioPedido === undefined ? Number(hoy.slice(0, 4)) : Number(ejercicioPedido);
  if (!Number.isInteger(ejercicio) || ejercicio < 1990 || ejercicio > 2100) {
    throw badRequest('Indica el año del ejercicio con cuatro cifras.', { campo: 'ejercicio' });
  }
  const aplicarDesde = leerAplicarDesde(pedido, hoy);
  const antes = ajustesFiscalesDeFila(await leerFila(companyId));
  const ajustes = await combinar(companyId, resto);
  const { autonomo } = await opcionesCalendarioEmpresa(companyId);
  const r = await calendarioResultante(companyId, ejercicio, { ajustes, autonomo }, hoy, aplicarDesde);
  return {
    ajustes,
    ejercicio,
    modelos: r.modelos,
    aplicadoDesde: r.aplicadoDesde,
    aviso: avisoCambioCalendario({ ejercicio, ...r }, !mismosAjustes(antes, ajustes), false),
  };
}
