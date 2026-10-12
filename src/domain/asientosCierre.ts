/**
 * Como se reconocen los asientos del cierre de un ejercicio. Un unico criterio
 * para todo (estado del ejercicio, bloqueo de meses, cierre y su deshacer,
 * puesta en marcha, informes y el arreglo SQL de reapertura), el mismo que
 * tipoAsiento() en contabilidadDatos.service:
 *
 *  - Por el origen: REGULARIZACION y CIERRE (Cierre y traspaso de saldos) y
 *    CIERRE_AUTOMATICO (el antiguo POST /accounting/closures/generar-asiento).
 *  - Por el concepto, en los anteriores al 06-10-2026: el cierre los grababa
 *    con origen AJUSTE_MANUAL y conceptos «Regularizacion ejercicio X»,
 *    «Cierre ejercicio X» y «Apertura ejercicio X+1».
 *
 * En MySQL la comparacion de texto no distingue mayusculas ni tildes (cotejo
 * utf8mb4_unicode_ci), asi que «Regularización» y «regularizacion» coinciden.
 *
 * El diario de un año que llevo la gestoria (Traer la contabilidad de 2026) se
 * guarda con origen HISTORICO*: su regularizacion y su cierre cuentan por el
 * origen (asi ese año sale cerrado) y su concepto no confunde a los filtros
 * por concepto, que solo miran los asientos que no son historicos.
 */
import type { Prisma } from '@prisma/client';

export const ORIGENES_CIERRE = ['REGULARIZACION', 'CIERRE', 'CIERRE_AUTOMATICO', 'HISTORICO_REGULARIZACION', 'HISTORICO_CIERRE'] as const;
/** Origenes de la apertura de un ejercicio: la del cierre o la importada, y su ajuste con el cierre definitivo. */
export const ORIGENES_APERTURA = ['APERTURA', 'APERTURA_AJUSTE'] as const;
/** Los asientos del diario historico (origen HISTORICO...) no se reconocen por su concepto. */
const NO_HISTORICO: Prisma.JournalEntryWhereInput = { NOT: { origen: { startsWith: 'HISTORICO' } } };
export const CONCEPTOS_CIERRE = ['Regularizacion ejercicio', 'Regularización ejercicio', 'Cierre ejercicio', 'Cierre contable'] as const;
export const CONCEPTO_APERTURA = 'Apertura ejercicio';

/** Filtro (sobre JournalEntry) de los asientos de regularizacion o cierre. */
export const FILTRO_ASIENTOS_CIERRE: Prisma.JournalEntryWhereInput = {
  OR: [{ origen: { in: [...ORIGENES_CIERRE] } }, ...CONCEPTOS_CIERRE.map((c) => ({ descripcion: { startsWith: c }, ...NO_HISTORICO }))],
};

/** Filtro (sobre JournalEntry) de los asientos de apertura. */
export const FILTRO_ASIENTOS_APERTURA: Prisma.JournalEntryWhereInput = {
  OR: [{ origen: { in: [...ORIGENES_APERTURA] } }, { descripcion: { startsWith: CONCEPTO_APERTURA }, ...NO_HISTORICO }],
};


/** Estado de un asiento de 2026 hecho en la app y retirado al traer la contabilidad de la gestoria. */
export const ESTADO_SUSTITUIDO = 'Retirado (2026 lo lleva la gestoría)';
export const TEXTO_SUSTITUIDO =
  'Este asiento de 2026 está retirado: al traer la contabilidad de la gestoría, 2026 es de solo lectura y no cuenta. No se puede aprobar ni cambiar.';
