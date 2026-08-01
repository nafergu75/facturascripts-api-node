import { z } from 'zod';
import { patrones } from '../common/aeat-validation';
import { Declarante347Dom, Declarado347Dom } from './modelo347.types';

// Esquemas Zod: implementan las reglas del diseno de registro (longitudes,
// formato NIF, claves validas, obligatoriedad). Si algo no cumple -> ZodError.
export const declarante347Schema = z.object({
  nif: z.string().regex(patrones.nif, 'NIF debe ser 9 caracteres alfanumericos'),
  razonSocial: z.string().min(1).max(40),
  ejercicio: z.number().int().min(2000).max(2100),
  numPersonas: z.number().int().nonnegative(),
  importeTotal: z.number(),
});

export const declarado347Schema = z.object({
  nifDeclarante: z.string().regex(patrones.nif),
  nifDeclarado: z.string().min(1).max(9),
  razonSocial: z.string().min(1).max(40),
  clave: z.enum(['A', 'B']),
  importeAnual: z.number(),
  ejercicio: z.number().int().min(2000).max(2100),
});

export function validarDeclarante347(input: unknown): Declarante347Dom {
  return declarante347Schema.parse(input) as Declarante347Dom;
}
export function validarDeclarado347(input: unknown): Declarado347Dom {
  return declarado347Schema.parse(input) as Declarado347Dom;
}
