/**
 * Validacion del cuerpo de una factura de gasto (alta, edicion y lector).
 *
 * Los errores son 400 con el PRIMER mensaje en castellano y
 * details: { campo: 'lineas.0.tipoIva', errores } para que la pantalla marque
 * el campo. No se usa validate() del middleware, que responde un mensaje
 * generico («Datos de entrada invalidos.»).
 */
import { z } from 'zod';
import { TIPOS_GASTO, TIPO_GASTO_INFO, TIPOS_IVA_GASTO, type TipoGasto } from '../domain/factura-gasto.model';
import { badRequest } from '../utils/http-errors';
import { aCentimos } from '../utils/money';

/** true si AAAA-MM-DD es una fecha que existe (no 2026-02-30). */
export function esFechaReal(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const fecha = (nombre: string) =>
  z
    .string({ required_error: `Falta ${nombre}.`, invalid_type_error: `${nombre[0].toUpperCase()}${nombre.slice(1)} tiene que ser una fecha AAAA-MM-DD.` })
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha tiene que ser AAAA-MM-DD.')
    .refine(esFechaReal, 'Esa fecha no existe.');

const numero = (nombre: string) =>
  z.number({ required_error: `Falta ${nombre}.`, invalid_type_error: `${nombre[0].toUpperCase()}${nombre.slice(1)} tiene que ser un número.` }).finite();

const LineaSchema = z.object({
  descripcion: z
    .string({ required_error: 'Falta la descripción de la línea.', invalid_type_error: 'Falta la descripción de la línea.' })
    .trim()
    .min(1, 'Falta la descripción de la línea.')
    .max(500, 'La descripción de la línea es demasiado larga (500 caracteres como mucho).'),
  cantidad: numero('la cantidad').positive('La cantidad tiene que ser mayor que cero.').max(1_000_000, 'La cantidad es demasiado grande.'),
  precioUnitario: numero('el precio').min(0, 'El precio no puede ser negativo.').max(1e10, 'El precio es demasiado grande.'),
  descuentoPorcentaje: numero('el descuento').min(0, 'El descuento va de 0 a 100 %.').max(100, 'El descuento va de 0 a 100 %.').default(0),
  tipoIva: numero('el IVA').refine((v) => (TIPOS_IVA_GASTO as readonly number[]).includes(v), 'El IVA tiene que ser 0, 4, 5, 10 o 21 %.'),
  tipoRetencion: numero('la retención').int('La retención tiene que ser un porcentaje entero.').min(0, 'La retención no puede ser negativa.').max(50, 'La retención no puede pasar del 50 %.').default(0),
  /** Cuenta de gasto de la linea (avanzado). */
  cuenta: z.string().regex(/^6\d{2,9}$/, 'La cuenta de gasto tiene que ser del grupo 6.').optional(),
});

const ProveedorSchema = z
  .object(
    {
      id: z.string().trim().min(1).optional(),
      nuevo: z.record(z.unknown()).optional(),
    },
    { required_error: 'Elige el proveedor de la factura.', invalid_type_error: 'Elige el proveedor de la factura.' },
  )
  .refine((p) => !!p.id !== !!p.nuevo, 'Elige un proveedor dado de alta o da de alta uno nuevo.');

export const FacturaGastoSchema = z.object({
  proveedor: ProveedorSchema,
  numeroFacturaProveedor: z
    .string({
      required_error: 'Escribe el número que puso el proveedor en su factura.',
      invalid_type_error: 'Escribe el número que puso el proveedor en su factura.',
    })
    .trim()
    .min(1, 'Escribe el número que puso el proveedor en su factura.')
    .max(60, 'El número de factura del proveedor es demasiado largo (60 caracteres como mucho).'),
  fechaEmision: fecha('la fecha de la factura'),
  fechaRegistro: fecha('la fecha de registro').optional(),
  fechaVencimiento: fecha('el vencimiento').optional(),
  tipoGasto: z.enum(TIPOS_GASTO, {
    errorMap: () => ({ message: 'Elige el tipo de gasto: compras, profesionales, alquileres o suministros.' }),
  }),
  cuentaGasto: z.string().regex(/^6\d{2,9}$/, 'La cuenta de gasto tiene que ser del grupo 6.').optional(),
  lineas: z
    .array(LineaSchema, { required_error: 'La factura necesita al menos una línea.', invalid_type_error: 'La factura necesita al menos una línea.' })
    .min(1, 'La factura necesita al menos una línea.')
    .max(200, 'Una factura admite como mucho 200 líneas.'),
  observaciones: z.string().max(2000, 'Las observaciones son demasiado largas (2.000 caracteres como mucho).').optional(),
  /** Total que pone la factura: si viene, se cruza con el calculado. */
  totalDocumento: numero('el total de la factura').optional(),
  /** Serie del registro interno (por defecto 'G'). No se cambia al modificar. */
  serie: z.string().regex(/^[A-Z0-9]{1,10}$/, 'La serie tiene que ser de 1 a 10 letras mayúsculas o cifras.').optional(),
});

export type FacturaGastoBody = z.infer<typeof FacturaGastoSchema>;
export type LineaGastoBody = z.infer<typeof LineaSchema>;

/** Totales de una factura de gasto (el mismo redondeo que el alta: por linea y despues la suma). */
export function totalesLineas(lineas: Array<{ cantidad: number; precioUnitario: number; descuentoPorcentaje?: number; tipoIva: number; tipoRetencion?: number }>) {
  const r2 = (v: number) => Math.round(v * 100) / 100;
  let base = 0;
  let iva = 0;
  let ret = 0;
  for (const l of lineas) {
    const pvp = r2(l.cantidad * l.precioUnitario);
    const b = r2(pvp - r2((pvp * (l.descuentoPorcentaje ?? 0)) / 100));
    base += aCentimos(b);
    iva += aCentimos(r2((b * l.tipoIva) / 100));
    ret += aCentimos(r2((b * (l.tipoRetencion ?? 0)) / 100));
  }
  return { base: base / 100, iva: iva / 100, retencion: ret / 100, total: (base + iva - ret) / 100 };
}

/** 1060 -> '1.060,00 €' (con punto de miles tambien en los numeros de cuatro cifras). */
export function eur(n: number): string {
  const [ent, dec] = Math.abs(n).toFixed(2).split('.');
  return `${n < 0 ? '-' : ''}${ent.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec} €`;
}

const error = (mensaje: string, campo: string, errores?: unknown) => badRequest(mensaje, { campo, ...(errores ? { errores } : {}) });

/**
 * Valida el cuerpo de una factura de gasto: forma (Zod) y reglas que cruzan
 * campos. `paisProveedor` es el del proveedor elegido o el del nuevo (ISO-2).
 * Acepta el alias antiguo `provider` como `proveedor`.
 */
export function validarFacturaGasto(cuerpo: unknown, opciones: { paisProveedor?: string | null; permitirSerie?: boolean } = {}): FacturaGastoBody {
  const bruto = { ...((cuerpo ?? {}) as Record<string, unknown>) };
  if (bruto.proveedor === undefined && bruto.provider !== undefined) bruto.proveedor = bruto.provider;
  if (!opciones.permitirSerie) delete bruto.serie;

  const r = FacturaGastoSchema.safeParse(bruto);
  if (!r.success) {
    const primero = r.error.issues[0];
    throw error(primero.message, primero.path.join('.') || 'cuerpo', r.error.flatten());
  }
  const d = r.data;

  if (d.fechaRegistro && d.fechaRegistro < d.fechaEmision) {
    throw error('La fecha de registro no puede ser anterior a la fecha de la factura.', 'fechaRegistro');
  }
  if (d.fechaVencimiento && d.fechaVencimiento < d.fechaEmision) {
    throw error('El vencimiento no puede ser anterior a la fecha de la factura.', 'fechaVencimiento');
  }
  const admitidas = TIPO_GASTO_INFO[d.tipoGasto as TipoGasto].retenciones;
  d.lineas.forEach((l, i) => {
    if (!admitidas.includes(l.tipoRetencion)) {
      throw error(
        'Solo las facturas de profesionales (1, 2, 7, 15 o 19 %) y de alquileres (19 %) llevan retención de IRPF: revisa el tipo de gasto.',
        `lineas.${i}.tipoRetencion`,
      );
    }
  });
  const pais = String(opciones.paisProveedor ?? 'ES').trim().toUpperCase() || 'ES';
  if (pais !== 'ES' && pais !== 'ESP') {
    const i = d.lineas.findIndex((l) => l.tipoIva !== 0 || l.tipoRetencion !== 0);
    if (i >= 0) {
      throw error(
        'Un proveedor de fuera de España no te cobra IVA español: pon el IVA al 0 % y el total como base. La inversión del sujeto pasivo y las retenciones a no residentes aún no están disponibles: consúltalo con tu asesor.',
        `lineas.${i}.${d.lineas[i].tipoIva !== 0 ? 'tipoIva' : 'tipoRetencion'}`,
      );
    }
  }
  const t = totalesLineas(d.lineas);
  if (aCentimos(t.base) <= 0) {
    throw error('El importe tiene que ser mayor que cero. Las facturas rectificativas de proveedor aún no están disponibles.', 'lineas');
  }
  if (d.totalDocumento !== undefined && Math.abs(aCentimos(d.totalDocumento) - aCentimos(t.total)) > 2) {
    throw error(
      `El total calculado (${eur(t.total)}) no coincide con el de la factura (${eur(d.totalDocumento)}): revisa las bases, el IVA y la retención.`,
      'totalDocumento',
    );
  }
  return d;
}
