import { z } from 'zod';
import { nifSchema, ejercicioSchema, desgloseIvaSchema } from '../common/aeat-schemas';

export const modelo390Schema = z.object({
  nif: nifSchema,
  ejercicio: ejercicioSchema,
  datos: z.object({
    ejercicio: ejercicioSchema,
    resumenDevengado: z.array(desgloseIvaSchema),
    resumenDeducible: z.array(desgloseIvaSchema),
    totalCuotaDevengada: z.number(),
    totalCuotaDeducible: z.number(),
    resultadoAnual: z.number(),
    volumenOperaciones: z.number(),
  }),
});

export type Modelo390Input = z.infer<typeof modelo390Schema>;
