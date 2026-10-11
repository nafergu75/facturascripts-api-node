import { z } from 'zod';
import { nifSchema, periodoFiscalSchema } from '../common/aeat-schemas';

/** El 115 es mensual (01-12) o trimestral (1T-4T): no tiene periodo anual. */
const periodo115 = periodoFiscalSchema.refine((p) => /^(0[1-9]|1[0-2]|[1-4]T)$/.test(p.periodo), { message: 'El 115 es mensual (01-12) o trimestral (1T-4T)' });

export const modelo115Schema = z.object({
  nif: nifSchema,
  /** Razon social (60) o "APELLIDOS, NOMBRE" de una persona fisica. */
  razonSocial: z.string().max(81).optional().default(''),
  datos: z.object({
    periodo: periodo115,
    nPerceptores: z.number().int().nonnegative(),
    baseRetenciones: z.number().nonnegative(),
    retenciones: z.number().nonnegative(),
    resultadoAnteriores: z.number().nonnegative(),
    resultadoIngresar: z.number().nonnegative(),
  }),
});

export type Modelo115Input = z.infer<typeof modelo115Schema>;
