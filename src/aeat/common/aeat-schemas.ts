import { z } from 'zod';
import { patrones } from './aeat-validation';

/**
 * Esquemas Zod reutilizables por todos los modelos AEAT. Centralizan las reglas
 * comunes (NIF de 9, periodo 01..12/1T..4T/0A, ejercicio, desglose de IVA).
 */
export const nifSchema = z.string().regex(patrones.nif, 'NIF debe ser 9 caracteres alfanumericos (mayusculas)');

export const ejercicioSchema = z.number().int().min(2000).max(2100);

export const periodoFiscalSchema = z.object({
  ejercicio: ejercicioSchema,
  periodo: z.string().regex(patrones.periodo, 'periodo debe ser 01..12, 1T..4T o 0A'),
  tipo: z.enum(['mensual', 'trimestral', 'anual']),
  fechaInicio: z.string().min(10),
  fechaFin: z.string().min(10),
});

export const desgloseIvaSchema = z.object({
  tipo: z.number().nonnegative(),
  base: z.number(),
  cuota: z.number(),
});
