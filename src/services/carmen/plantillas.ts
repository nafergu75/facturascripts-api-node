/**
 * Formatos y piezas comunes de las respuestas de datos. Las cifras salen
 * siempre de los servicios de la app; aquí solo se redactan.
 */
import type { ColumnaInforme, FilaInforme } from '../informesContables.documentos';
import type { Boton, HuecosEntrada, TablaCarmen } from './tipos';

export const MAX_FILAS_TABLA = 15;

/**
 * Importe en euros al estilo es-ES («1.234,50 €», «-12,00 €»). Se formatea a
 * mano porque Intl en es-ES no separa los miles de 4 cifras (1234,50 €) y la
 * opción useGrouping:'always' depende de la versión de Node.
 */
export function eur(n: number): string {
  const v = Math.round(n * 100) / 100;
  const [ent, dec] = Math.abs(v).toFixed(2).split('.');
  return `${v < 0 ? '-' : ''}${ent.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec} €`;
}

/** AAAA-MM-DD → DD/MM/AAAA. */
export function fechaES(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso;
}

/** «1 factura» / «3 facturas». */
export function plural(n: number, singular: string, pluralTexto?: string): string {
  return `${n.toLocaleString('es-ES')} ${n === 1 ? singular : (pluralTexto ?? `${singular}s`)}`;
}

/** Tabla recortada a 15 filas, con el total de filas que había. */
export function tabla(
  titulo: string,
  periodo: string,
  columnas: ColumnaInforme[],
  filas: FilaInforme[],
  notas?: string[],
): TablaCarmen {
  return {
    titulo,
    periodo,
    columnas,
    filas: filas.slice(0, MAX_FILAS_TABLA),
    totalFilas: filas.length,
    ...(notas && notas.length ? { notas } : {}),
  };
}

export function botonIntencion(texto: string, id: string, huecos?: HuecosEntrada): Boton {
  return { texto, accion: { tipo: 'intencion', id, ...(huecos ? { huecos } : {}) } };
}
