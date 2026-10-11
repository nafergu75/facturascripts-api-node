/**
 * Numero identificativo del modelo 190 (posiciones 108-120 del registro de
 * tipo 1): "Se consignará el número identificativo correspondiente a la
 * declaración. Campo de contenido numérico de 13 posiciones"
 * (DISENOS_LOGICOS_190_2025, pagina 4). Lo genera la app: 190, el ejercicio
 * (4 cifras) y un contador de 6 cifras por empresa y ejercicio. Nunca se repite
 * en la misma empresa y ejercicio, y nunca coincide con el de la declaracion
 * anterior de una complementaria o sustitutiva (123-135).
 *
 * Se guarda, sin columnas nuevas, en el JSON `datos` de la fila del 190
 * (ModeloImpuesto, codigo '190', periodo '0A'), bajo la clave `numeracion190`.
 * Quien reescriba ese JSON (autorrelleno, pantalla de modelos fiscales) tiene
 * que conservarla con conservarNumeracion190.
 */
import { createHash } from 'crypto';
import { prisma } from '../../config/database';
import { conflict } from '../../utils/http-errors';

export type TipoDeclaracion190 = 'N' | 'C' | 'S';

export interface NumeroEmitido190 {
  numero: string;
  tipo: TipoDeclaracion190;
  /** Numero de la declaracion a la que complementa o sustituye. */
  anterior: string | null;
  /** Huella de los registros de perceptor incluidos (para reutilizar el numero si se descarga otra vez lo mismo). */
  firma: string;
  emitidoEn: string;
}

export interface Numeracion190 {
  emitidos: NumeroEmitido190[];
}

const CLAVE = 'numeracion190';

/** Numeracion guardada en el JSON `datos` (vacia si no hay o tiene otro formato). */
export function numeracionDeDatos(datos: unknown): Numeracion190 {
  const n = datos && typeof datos === 'object' ? (datos as Record<string, unknown>)[CLAVE] : null;
  const emitidos = n && typeof n === 'object' && Array.isArray((n as Numeracion190).emitidos) ? (n as Numeracion190).emitidos : [];
  return { emitidos: emitidos.filter((e) => e && /^190\d{10}$/.test(String(e.numero))) };
}

/** `nuevos` con la numeracion de `previos` (para no perderla al reescribir los datos del 190). */
export function conservarNumeracion190<T>(previos: unknown, nuevos: T): T {
  const n = numeracionDeDatos(previos);
  if (!n.emitidos.length || !nuevos || typeof nuevos !== 'object') return nuevos;
  return { ...(nuevos as object), [CLAVE]: n } as T;
}

/** Huella de una seleccion de registros (ids ordenados). */
export function firmaRegistros(ids: string[]): string {
  return createHash('sha256').update([...ids].sort().join('\n')).digest('hex').slice(0, 16);
}

/**
 * Numero para una declaracion (puro): el ya emitido si es la misma declaracion
 * (mismo tipo, misma anterior, mismos registros) y no se ha presentado; si no,
 * el siguiente del contador, saltando los ya usados y el de la anterior.
 */
export function siguienteNumero190(
  ejercicio: number,
  numeracion: Numeracion190,
  d: { tipo: TipoDeclaracion190; anterior: string | null; firma: string; presentado: boolean },
): { numero: string; nuevo: boolean } {
  const prefijo = `190${String(ejercicio).padStart(4, '0')}`;
  const ultimo = numeracion.emitidos[numeracion.emitidos.length - 1];
  const mismaDeclaracion =
    !!ultimo && ultimo.numero.startsWith(prefijo) && ultimo.tipo === d.tipo && (ultimo.anterior ?? null) === (d.anterior ?? null) && ultimo.firma === d.firma;
  if (!d.presentado && mismaDeclaracion && ultimo.numero !== d.anterior) {
    return { numero: ultimo.numero, nuevo: false };
  }
  const usados = new Set([...numeracion.emitidos.map((e) => e.numero), ...(d.anterior ? [d.anterior] : [])]);
  let n = numeracion.emitidos.filter((e) => e.numero.startsWith(prefijo)).reduce((max, e) => Math.max(max, Number(e.numero.slice(7))), 0) + 1;
  while (usados.has(`${prefijo}${String(n).padStart(6, '0')}`)) n++;
  if (n > 999999) throw new Error('Contador del número identificativo del 190 agotado');
  return { numero: `${prefijo}${String(n).padStart(6, '0')}`, nuevo: true };
}

const claveFila = (companyId: string, ejercicio: number) => ({ companyId_codigo_ejercicio_periodo: { companyId, codigo: '190', ejercicio, periodo: '0A' } });

/** Fila del 190 del ejercicio (la del calendario fiscal); se crea si aun no existe. */
async function filaModelo190(companyId: string, ejercicio: number) {
  const fila = await prisma.modeloImpuesto.findUnique({ where: claveFila(companyId, ejercicio) });
  if (fila) return fila;
  try {
    return await prisma.modeloImpuesto.create({ data: { companyId, codigo: '190', ejercicio, periodo: '0A', estado: 'vigente' } });
  } catch {
    // Otra peticion la ha creado a la vez.
    return prisma.modeloImpuesto.findUniqueOrThrow({ where: claveFila(companyId, ejercicio) });
  }
}

/**
 * Numero identificativo de la declaracion que se va a descargar, guardado en
 * la fila del 190 (ver siguienteNumero190). Dos descargas a la vez no se llevan
 * el mismo numero: se guarda solo si la fila no ha cambiado desde que se leyo.
 */
export async function asignarNumero190(
  companyId: string,
  ejercicio: number,
  d: { tipo: TipoDeclaracion190; anterior: string | null; firma: string },
): Promise<{ numero: string; nuevo: boolean }> {
  for (let intento = 0; intento < 5; intento++) {
    const fila = await filaModelo190(companyId, ejercicio);
    const numeracion = numeracionDeDatos(fila.datos);
    const r = siguienteNumero190(ejercicio, numeracion, { ...d, presentado: fila.estado === 'presentado' });
    if (!r.nuevo) return r;
    const previos = fila.datos && typeof fila.datos === 'object' && !Array.isArray(fila.datos) ? (fila.datos as Record<string, unknown>) : {};
    const emitido: NumeroEmitido190 = { numero: r.numero, tipo: d.tipo, anterior: d.anterior, firma: d.firma, emitidoEn: new Date().toISOString() };
    const { count } = await prisma.modeloImpuesto.updateMany({
      where: { id: fila.id, actualizadoEn: fila.actualizadoEn },
      data: { datos: { ...previos, [CLAVE]: { emitidos: [...numeracion.emitidos, emitido] } } as never },
    });
    if (count === 1) return r;
  }
  throw conflict('Se estaba generando otro fichero del 190 a la vez: vuelve a descargarlo.');
}

/**
 * Para la pantalla: el ultimo numero que genero la app y el justificante con
 * que se marco presentado el 190 (lo que se pide como declaracion anterior).
 */
export async function estadoNumeracion190(
  companyId: string,
  ejercicio: number,
): Promise<{ ultimo: NumeroEmitido190 | null; presentado: boolean; justificantePresentado: string | null }> {
  const fila = await prisma.modeloImpuesto.findUnique({ where: claveFila(companyId, ejercicio) });
  const emitidos = numeracionDeDatos(fila?.datos).emitidos;
  const datos = (fila?.datos ?? {}) as { justificante?: { numero?: unknown } };
  const justificante = String(datos.justificante?.numero ?? '').replace(/\s/g, '');
  return {
    ultimo: emitidos[emitidos.length - 1] ?? null,
    presentado: fila?.estado === 'presentado',
    justificantePresentado: /^\d{13}$/.test(justificante) ? justificante : null,
  };
}
