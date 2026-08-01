import { z } from 'zod';
import { nifSchema, periodoFiscalSchema } from '../common/aeat-schemas';

export const modelo115Schema = z.object({
  nif: nifSchema,
  razonSocial: z.string().max(80).optional().default(''),
  datos: z.object({
    periodo: periodoFiscalSchema,
    nPerceptores: z.number().int().nonnegative(),
    baseRetenciones: z.number(),
    retenciones: z.number(),
    resultadoAnteriores: z.number(),
    resultadoIngresar: z.number(),
  }),
});

export type Modelo115Input = z.infer<typeof modelo115Schema>;
