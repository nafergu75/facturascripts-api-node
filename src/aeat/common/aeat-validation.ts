import { z } from 'zod';

export type SchemaZod<T> = z.ZodType<T>;

/** Valida `input` con el esquema y devuelve el dato tipado (lanza ZodError si falla). */
export function validarConSchema<T>(schema: SchemaZod<T>, input: unknown): T {
  return schema.parse(input);
}

// Patrones reutilizables para los esquemas de cada modelo
export const patrones = {
  nif: /^[A-Z0-9]{9}$/, // NIF/NIE ya ajustado a 9 (ultima posicion control)
  periodo: /^(0[1-9]|1[0-2]|[1-4]T|0A)$/, // 01..12, 1T..4T, 0A
  fechaAAAAMMDD: /^\d{8}$/,
  ejercicio: /^\d{4}$/,
};
