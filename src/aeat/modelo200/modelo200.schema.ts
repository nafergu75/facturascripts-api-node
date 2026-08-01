import { z } from 'zod';
import { nifSchema, ejercicioSchema } from '../common/aeat-schemas';

export const modelo200Schema = z.object({
  nif: nifSchema,
  ejercicio: ejercicioSchema,
  opts: z
    .object({
      razonSocial: z.string().max(80).optional(),
      tipoDeclaracion: z.string().length(1).optional(),
      versionPrograma: z.string().max(4).optional(),
      nifEmpresaDesarrollo: z.string().max(9).optional(),
    })
    .optional()
    .default({}),
});

export type Modelo200Input = z.infer<typeof modelo200Schema>;
