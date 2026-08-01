import { z } from 'zod';
import { nifSchema, periodoFiscalSchema, desgloseIvaSchema } from '../common/aeat-schemas';

/** Entrada validada para generar el fichero del Modelo 303. */
export const modelo303Schema = z.object({
  nif: nifSchema,
  razonSocial: z.string().max(80).optional().default(''),
  datos: z.object({
    periodo: periodoFiscalSchema,
    ivaDevengado: z.array(desgloseIvaSchema),
    totalBaseDevengada: z.number(),
    totalCuotaDevengada: z.number(),
    ivaDeducible: z.array(desgloseIvaSchema),
    totalBaseDeducible: z.number(),
    totalCuotaDeducible: z.number(),
    resultado: z.number(),
  }),
});

export type Modelo303Input = z.infer<typeof modelo303Schema>;
