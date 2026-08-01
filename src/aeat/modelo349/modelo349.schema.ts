import { z } from 'zod';
import { nifSchema, periodoFiscalSchema } from '../common/aeat-schemas';

export const operacionIntracomSchema = z.object({
  cifnif: z.string().min(1).max(17),
  nombre: z.string().min(1).max(40),
  clave: z.enum(['E', 'A']),
  base: z.number(),
});

export const modelo349Schema = z.object({
  nif: nifSchema,
  razonSocial: z.string().max(40).optional().default(''),
  datos: z.object({
    periodo: periodoFiscalSchema,
    operaciones: z.array(operacionIntracomSchema),
    totalBase: z.number(),
  }),
});

export type Modelo349Input = z.infer<typeof modelo349Schema>;
