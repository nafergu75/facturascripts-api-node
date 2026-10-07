/**
 * Validacion (Zod) de lo que llega a las rutas de nominas y trabajadores.
 * Cualquier dato mal formado acaba en 400 con el detalle por campo, nunca en 500.
 */
import { z, type ZodTypeAny } from 'zod';
import { badRequest } from '../../utils/http-errors';
import { errorNaf, errorNifPersona, normalizarNaf, normalizarNif } from '../../utils/nif';
import { TIPOS_CONTRATO, TIPOS_NOMINA } from '../../domain/nominas.model';

const dosDecimales = (v: number) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;

export const importe = z
  .number({ invalid_type_error: 'tiene que ser un número', required_error: 'es obligatorio' })
  .finite('tiene que ser un número')
  .nonnegative('no puede ser negativo')
  .refine(dosDecimales, 'tiene como máximo dos decimales');

const fechaValida = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
export const fecha = z
  .string({ invalid_type_error: 'tiene que ser una fecha AAAA-MM-DD' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'tiene que ser una fecha AAAA-MM-DD')
  .refine(fechaValida, 'no es una fecha válida');

export const ejercicio = z.number({ invalid_type_error: 'tiene que ser un número' }).int('tiene que ser un año').min(2000, 'año no válido').max(2100, 'año no válido');
export const mes = z.number({ invalid_type_error: 'tiene que ser un número' }).int('tiene que ser un mes de 1 a 12').min(1, 'tiene que ser un mes de 1 a 12').max(12, 'tiene que ser un mes de 1 a 12');

const nif = z
  .string({ required_error: 'es obligatorio', invalid_type_error: 'tiene que ser un texto' })
  .transform((v) => normalizarNif(v))
  .superRefine((v, ctx) => {
    const e = errorNifPersona(v);
    if (e) ctx.addIssue({ code: z.ZodIssueCode.custom, message: e });
  });

const naf = z
  .union([z.string(), z.number()])
  .nullable()
  .optional()
  .transform((v) => (v === null || v === undefined || v === '' ? null : normalizarNaf(v)))
  .superRefine((v, ctx) => {
    if (v === null) return;
    const e = errorNaf(v);
    if (e) ctx.addIssue({ code: z.ZodIssueCode.custom, message: e });
  });

const textoOpcional = (max: number) =>
  z
    .string({ invalid_type_error: 'tiene que ser un texto' })
    .max(max, `como máximo ${max} caracteres`)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === null || v.trim() === '' ? null : v.trim()));

const camposEmpleado = {
  nif,
  nombre: z.string({ required_error: 'es obligatorio', invalid_type_error: 'tiene que ser un texto' }).trim().min(1, 'es obligatorio').max(120, 'como máximo 120 caracteres'),
  apellidos: z.string({ invalid_type_error: 'tiene que ser un texto' }).trim().max(120, 'como máximo 120 caracteres').optional(),
  naf,
  fechaAlta: fecha.nullable().optional(),
  fechaBaja: fecha.nullable().optional(),
  tipoContrato: z.enum(TIPOS_CONTRATO, { errorMap: () => ({ message: `tiene que ser ${TIPOS_CONTRATO.join(', ')}` }) }).optional(),
  jornadaParcial: z.boolean({ invalid_type_error: 'tiene que ser sí o no' }).optional(),
  grupoCotizacion: z.number().int().min(1, 'de 1 a 11').max(11, 'de 1 a 11').nullable().optional(),
  porcentajeIrpfActual: z.number().min(0, 'de 0 a 100').max(100, 'de 0 a 100').refine(dosDecimales, 'como máximo dos decimales').nullable().optional(),
  clave190: z.string().regex(/^[A-L]$/, 'una letra de la A a la L').optional(),
  subclave190: z.string().regex(/^\d{2}$/, 'dos dígitos').nullable().optional(),
  provincia: z.string().regex(/^(0[1-9]|[1-4]\d|5[0-2]|98|99)$/, 'código de provincia de dos dígitos (01-52)').nullable().optional(),
  anioNacimiento: z.number().int().min(1900, 'año no válido').max(2100, 'año no válido').nullable().optional(),
  situacionFamiliar: z.union([z.literal(1), z.literal(2), z.literal(3)], { errorMap: () => ({ message: 'tiene que ser 1, 2 o 3' }) }).nullable().optional(),
  nifConyuge: z
    .string()
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === null || v.trim() === '' ? null : normalizarNif(v)))
    .superRefine((v, ctx) => {
      if (!v) return;
      const e = errorNifPersona(v);
      if (e) ctx.addIssue({ code: z.ZodIssueCode.custom, message: e });
    }),
  discapacidad: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)], { errorMap: () => ({ message: 'tiene que ser 0, 1, 2 o 3' }) }).nullable().optional(),
  movilidadGeografica: z.boolean().nullable().optional(),
  activo: z.boolean().optional(),
  observaciones: textoOpcional(2000),
};

export const empleadoCrearSchema = z.object(camposEmpleado).strict();
export const empleadoActualizarSchema = z.object(camposEmpleado).partial().strict();
export type EmpleadoCrear = z.infer<typeof empleadoCrearSchema>;
export type EmpleadoActualizar = z.infer<typeof empleadoActualizarSchema>;

export const bajaSchema = z.object({ fechaBaja: fecha, observaciones: textoOpcional(2000) }).strict();

const camposImporte = {
  brutoDinerario: importe,
  dietasExentas: importe.optional(),
  especieValoracion: importe.optional(),
  ingresoACuenta: importe.optional(),
  ingresoACuentaRepercutido: z.boolean({ invalid_type_error: 'tiene que ser sí o no' }).optional(),
  indemnizacionExenta: importe.optional(),
  indemnizacionSujeta: importe.optional(),
  ssTrabajador: importe.optional(),
  irpf: importe.optional(),
  anticipos: importe.optional(),
  embargos: importe.optional(),
  otrasDeducciones: importe.optional(),
  liquido: importe,
  ssEmpresa: importe.optional(),
};

const camposNomina = {
  empleadoId: z.string({ required_error: 'es obligatorio' }).min(1, 'es obligatorio'),
  ejercicio,
  mes,
  tipo: z.enum(TIPOS_NOMINA, { errorMap: () => ({ message: `tiene que ser ${TIPOS_NOMINA.join(', ')}` }) }).optional(),
  ejercicioDevengo: ejercicio.nullable().optional(),
  fechaPago: fecha.optional(),
  porcentajeIrpf: z.number().min(0, 'de 0 a 100').max(100, 'de 0 a 100').refine(dosDecimales, 'como máximo dos decimales').nullable().optional(),
  observaciones: textoOpcional(2000),
  ...camposImporte,
};

export const nominaCrearSchema = z.object(camposNomina).strict();
export const nominaActualizarSchema = z.object(camposNomina).omit({ empleadoId: true }).partial().strict();
export type NominaCrear = z.infer<typeof nominaCrearSchema>;
export type NominaActualizar = z.infer<typeof nominaActualizarSchema>;

export const seleccionSchema = z
  .object({
    nominaIds: z.array(z.string().min(1)).max(5000).optional(),
    /** Anulacion: fecha del contraasiento si el periodo del asiento esta cerrado. */
    fecha: fecha.optional(),
    motivo: textoOpcional(500),
    /** Anulacion: dejar las nominas ANULADAS en vez de volver a borrador. */
    dejarAnuladas: z.boolean().optional(),
  })
  .strict();

// --- Pagos (liquidos, seguros sociales y 111) ---

const id = z.string({ invalid_type_error: 'tiene que ser un texto' }).min(1, 'es obligatorio').max(64, 'no es un identificador válido');
const medioPago = {
  /** Fecha del pago; por defecto, hoy (o la del movimiento del banco). */
  fecha: fecha.optional(),
  cuentaBancariaId: id.optional(),
  /** true: en efectivo (570). */
  caja: z.boolean({ invalid_type_error: 'tiene que ser sí o no' }).optional(),
  /** Movimiento del extracto (un cargo) que se concilia con el pago. */
  movimientoId: id.optional(),
};

export const pagoNominasSchema = z
  .object({ ...medioPago, nominaIds: z.array(z.string().min(1)).max(5000).optional(), incluirEmbargos: z.boolean().optional() })
  .strict();

export const anularPagoSchema = z
  .object({ nominaIds: z.array(z.string().min(1)).max(5000).optional(), fecha: fecha.optional(), motivo: textoOpcional(500) })
  .strict();

const tipoSS = z.enum(['NORMAL', 'COMPLEMENTARIA'], { errorMap: () => ({ message: 'tiene que ser NORMAL o COMPLEMENTARIA' }) });

export const segurosSocialesSchema = z
  .object({
    tipo: tipoSS.optional(),
    /** Importe a pagar del RLC real (null: se borra y se paga lo previsto). */
    totalRlc: importe.nullable().optional(),
    compensacionIt: importe.optional(),
    fechaCargoPrevista: fecha.optional(),
    observaciones: textoOpcional(2000),
  })
  .strict();

export const pagoSegurosSocialesSchema = z
  .object({ ...medioPago, tipo: tipoSS.optional(), totalRlc: importe.optional(), compensacionIt: importe.optional() })
  .strict();

export const anularPagoSegurosSocialesSchema = z.object({ tipo: tipoSS.optional(), fecha: fecha.optional(), motivo: textoOpcional(500) }).strict();

export const pago111Schema = z
  .object({ ...medioPago, cuentaProfesionales: z.string().regex(/^4751\d{0,6}$/, 'tiene que ser una subcuenta de la 4751').optional() })
  .strict();

export const anularPago111Schema = z.object({ fecha: fecha.optional(), motivo: textoOpcional(500) }).strict();

const NOMBRES_CAMPOS: Record<string, string> = {
  nif: 'NIF',
  naf: 'Nº de afiliación',
  nombre: 'Nombre',
  brutoDinerario: 'Bruto',
  liquido: 'Líquido',
  ssTrabajador: 'SS trabajador',
  ssEmpresa: 'SS empresa',
  irpf: 'IRPF',
};

/** Valida con un esquema Zod; si falla, 400 con el detalle por campo. */
export function parsear<S extends ZodTypeAny>(schema: S, datos: unknown): z.infer<S> {
  const r = schema.safeParse(datos ?? {});
  if (r.success) return r.data;
  const campos: Record<string, string[]> = {};
  const partes: string[] = [];
  for (const issue of r.error.issues) {
    const campo = issue.path.join('.') || 'datos';
    const msg = issue.code === 'unrecognized_keys' ? `campos no admitidos: ${issue.keys.join(', ')}` : issue.message;
    (campos[campo] ??= []).push(msg);
    partes.push(`${NOMBRES_CAMPOS[campo] ?? campo}: ${msg}`);
  }
  throw badRequest(`Datos no válidos. ${partes.slice(0, 5).join('; ')}.`, campos);
}
