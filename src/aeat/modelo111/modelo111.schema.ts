import { z } from 'zod';
import { nifSchema, periodoFiscalSchema } from '../common/aeat-schemas';

const importe = z.number().finite();
const perceptores = z.number().int().nonnegative();
/** El 111 es mensual (01-12) o trimestral (1T-4T): no tiene periodo anual. */
const periodo111 = periodoFiscalSchema.refine((p) => /^(0[1-9]|1[0-2]|[1-4]T)$/.test(p.periodo), { message: 'El 111 es mensual (01-12) o trimestral (1T-4T)' });

export const modelo111Schema = z.object({
  nif: nifSchema,
  /** Denominacion (60) o "APELLIDOS, NOMBRE" de una persona fisica. */
  denominacion: z.string().max(81).optional().default(''),
  datos: z.object({
    periodo: periodo111,
    nPerceptoresTrabajo: perceptores,
    percepcionesTrabajo: importe,
    retencionesTrabajo: importe,
    nPerceptoresEspecie: perceptores.optional(),
    percepcionesEspecie: importe.optional(),
    ingresosACuentaEspecie: importe.optional(),
    nPerceptoresActividades: perceptores.optional(),
    percepcionesActividades: importe.optional(),
    retencionesActividades: importe.optional(),
    /** Casillas [10] a [27] por numero de casilla. */
    otrasCasillas: z.record(z.string().regex(/^(1\d|2[0-7])$/), importe).optional(),
    totalRetenciones: importe,
    resultadoAnteriores: importe.optional(),
    resultadoIngresar: importe,
  }),
});

export type Modelo111Input = z.infer<typeof modelo111Schema>;
