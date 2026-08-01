import { z } from 'zod';

/**
 * Schema de validación para query params de POST /contabilizar/:invoiceId
 *
 * Query params:
 *   - tipo: 'INGRESO' | 'GASTO' (OBLIGATORIO)
 *   - mode: 'AUTO' | 'MANUAL' (opcional, default: AUTO)
 */
export const contabilizarQuerySchema = z.object({
  tipo: z.enum(['INGRESO', 'GASTO'], {
    errorMap: () => ({ message: 'Parameter "tipo" must be INGRESO or GASTO' }),
  }),
  mode: z.enum(['AUTO', 'MANUAL']).default('AUTO').optional(),
});

export type ContabilizarQuery = z.infer<typeof contabilizarQuerySchema>;
