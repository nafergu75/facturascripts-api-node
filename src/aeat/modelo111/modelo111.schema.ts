import { z } from 'zod';
import { nifSchema, periodoFiscalSchema } from '../common/aeat-schemas';

export const modelo111Schema = z.object({
  nif: nifSchema,
  denominacion: z.string().max(80).optional().default(''),
  datos: z.object({
    periodo: periodoFiscalSchema,
    nPerceptoresTrabajo: z.number().int().nonnegative(),
    percepcionesTrabajo: z.number(),
    retencionesTrabajo: z.number(),
    totalRetenciones: z.number(),
    resultadoIngresar: z.number(),
  }),
});

export type Modelo111Input = z.infer<typeof modelo111Schema>;
