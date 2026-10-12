/**
 * Operaciones de escritura del historial de declaraciones (B4 y B5), con el
 * cálculo de cada modelo: presentar, preparar una complementaria o
 * sustitutiva y asignar el número. Las llaman las rutas con permiso de
 * escritura (declaraciones-aeat.routes y el módulo Impuestos).
 */
import { badRequest } from '../../utils/http-errors';
import {
  asignarNumero,
  configModelo,
  contextoDeclaracion,
  entradaRectificacion,
  guardarRegistros,
  historialDeclaraciones,
  incluyeRegistro,
  prepararRectificacion,
  registrarPresentacion,
  type CodigoAeat,
  type HistorialDeclaraciones,
  type Justificante,
} from './declaraciones.service';
import { presentable, registrosActuales, resultadoAnterior } from './modelos';

/**
 * Marca como presentada la declaración en curso del modelo y periodo: calcula
 * lo que se presenta (lo mismo que la pantalla y el fichero), y si tiene
 * errores no la marca (400). Las informativas reciben aquí su número si aún no
 * lo tienen.
 */
export async function presentarDeclaracion(
  companyId: string,
  userId: string,
  codigo: CodigoAeat,
  ejercicio: number,
  periodo: string,
  justificante: Justificante | null,
  opciones: Record<string, unknown> = {},
): Promise<HistorialDeclaraciones> {
  const config = configModelo(codigo);
  if (config.numero) {
    const ctx = await contextoDeclaracion(companyId, codigo, ejercicio, periodo);
    // Sin número aún (y sin estar ya presentada): se le pone antes de calcular el fichero.
    if (!ctx.congelada && !ctx.numero) await asignarNumero(companyId, userId, codigo, ejercicio, periodo);
  }
  const p = await presentable(companyId, codigo, ejercicio, periodo, opciones);
  if (p.errores.length) {
    throw badRequest(`Corrige esto antes de marcarlo como presentado: ${p.errores.join(' ')}`, { errores: p.errores });
  }
  await registrarPresentacion(companyId, userId, codigo, ejercicio, periodo, justificante, p.instantanea);
  return historialDeclaraciones(companyId, codigo, ejercicio, periodo);
}

/** Prepara una complementaria o sustitutiva con lo que pone cada modelo. */
export async function prepararRectificacionModelo(
  companyId: string,
  userId: string,
  codigo: CodigoAeat,
  ejercicio: number,
  periodo: string,
  body: Record<string, unknown>,
): Promise<HistorialDeclaraciones> {
  const config = configModelo(codigo);
  const entrada = entradaRectificacion(codigo, body);
  await prepararRectificacion(companyId, userId, codigo, ejercicio, periodo, entrada, {
    resultadoAnterior: (presentadas) => resultadoAnterior(codigo, presentadas),
    ...(config.clase === 'informativa' ? { registrosActuales: async () => (await registrosActuales(companyId, codigo, ejercicio, periodo)).map((r) => r.clave) } : {}),
  });
  return historialDeclaraciones(companyId, codigo, ejercicio, periodo);
}

/** Historial más, en las informativas, la lista de registros con los ya presentados y los elegidos. */
export async function historialConRegistros(companyId: string, codigo: CodigoAeat, ejercicio: number, periodo: string) {
  const [historial, ctx] = await Promise.all([historialDeclaraciones(companyId, codigo, ejercicio, periodo), contextoDeclaracion(companyId, codigo, ejercicio, periodo)]);
  if (ctx.config.clase !== 'informativa' || !ctx.enCurso || ctx.enCurso.tipo !== 'C') return { ...historial, registros: null };
  const actuales = await registrosActuales(companyId, codigo, ejercicio, periodo);
  // Los elegidos y los que han aparecido después de preparar la complementaria (sin presentar antes).
  const incluye = incluyeRegistro(ctx) ?? (() => true);
  return {
    ...historial,
    registros: actuales.map((r) => ({ ...r, presentado: ctx.registrosPresentados.has(r.clave), incluido: incluye(r.clave) })),
  };
}

/** Guarda los registros elegidos de la complementaria y apunta como vistos los que hay ahora. */
export async function guardarRegistrosModelo(companyId: string, codigo: CodigoAeat, ejercicio: number, periodo: string, registros: unknown): Promise<void> {
  const actuales = configModelo(codigo).clase === 'informativa' ? (await registrosActuales(companyId, codigo, ejercicio, periodo)).map((r) => r.clave) : [];
  await guardarRegistros(companyId, codigo, ejercicio, periodo, registros, actuales);
}
