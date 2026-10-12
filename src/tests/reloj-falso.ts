/**
 * Reloj falso para los tests que dependen de la fecha (spec arranque-2027,
 * B.15): solo se falsea Date. Los temporizadores, process.nextTick y
 * setImmediate siguen siendo los de verdad, así que Prisma, supertest y los
 * reintentos funcionan igual. Después de cada test hay que llamar a
 * relojReal() (o jest.useRealTimers()).
 */
const NO_FALSEAR: NonNullable<Parameters<typeof jest.useFakeTimers>[0]> extends infer C
  ? C extends { doNotFake?: infer D }
    ? D
    : never
  : never = [
  'nextTick',
  'setImmediate',
  'clearImmediate',
  'setInterval',
  'clearInterval',
  'setTimeout',
  'clearTimeout',
  'queueMicrotask',
  'hrtime',
  'performance',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
];

/** Pone el reloj en ese instante (ISO con zona, p. ej. '2026-12-31T23:30:00Z'). */
export function relojEn(instante: string): void {
  jest.useFakeTimers({ doNotFake: NO_FALSEAR, now: new Date(instante) });
}

export function relojReal(): void {
  jest.useRealTimers();
}
