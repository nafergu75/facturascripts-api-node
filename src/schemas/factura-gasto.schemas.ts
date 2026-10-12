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
import {
  CAUSA_INFO,
  CAUSAS_NO_ADMITIDAS,
  TEXTO_IMPAGO_CONCURSO,
  TIPOS_RECTIFICATIVA,
  esCausa,
  lineasDiferencia,
  r2GastoConSigno,
  sentido,
  type Causa,
} from '../domain/rectificativa-gasto.model';

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
  // Con signo solo en los abonos y rectificativas (se comprueba en validarFacturaGasto).
  precioUnitario: numero('el precio').min(-1e10, 'El precio es demasiado grande.').max(1e10, 'El precio es demasiado grande.'),
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

const OriginalSchema = z.object({
  /** Factura de la app. */
  id: z.string().trim().min(1).optional(),
  /** Factura de fuera de la app: numero que puso el proveedor y fecha de expedicion. */
  numero: z
    .string()
    .trim()
    .min(1, 'Escribe el número de la factura que rectifica.')
    .max(60, 'El número de la factura que rectifica es demasiado largo (60 caracteres como mucho).')
    .optional(),
  fecha: fecha('la fecha de la factura que rectifica').optional(),
  /** Reparto de la rectificacion entre varias originales, con signo. */
  base: numero('la base del reparto').optional(),
  cuota: numero('la cuota del reparto').optional(),
  retencion: numero('la retención del reparto').optional(),
});

/** Tramo del reparto de un rappel entre periodos, con signo. */
const TramoSchema = z.object({
  desde: fecha('el inicio del tramo'),
  hasta: fecha('el final del tramo'),
  base: numero('la base del tramo'),
  cuota: numero('la cuota del tramo').optional(),
  retencion: numero('la retención del tramo').optional(),
});

const LineasCompletas = (nombre: string) =>
  z.object({
    lineas: z
      .array(LineaSchema, { required_error: `Faltan las líneas de ${nombre}.`, invalid_type_error: `Faltan las líneas de ${nombre}.` })
      .min(1, `Faltan las líneas de ${nombre}.`)
      .max(200, 'Una factura admite como mucho 200 líneas.'),
  });

/** Bloque de un abono o rectificativa de proveedor (domain/rectificativa-gasto.model.ts). */
const RectificativaSchema = z.object({
  tipo: z.enum(TIPOS_RECTIFICATIVA, { errorMap: () => ({ message: 'Elige si la rectificativa es por diferencias o por sustitución.' }) }),
  causa: z.string({ required_error: 'Elige la causa de la rectificación.', invalid_type_error: 'Elige la causa de la rectificación.' }),
  motivo: z.string().trim().max(500, 'El motivo es demasiado largo (500 caracteres como mucho).').optional(),
  originales: z.array(OriginalSchema).max(50, 'Una rectificativa puede rectificar como mucho 50 facturas.').default([]),
  periodo: z
    .object({
      desde: fecha('el inicio del periodo'),
      hasta: fecha('el final del periodo'),
      /**
       * Rappel de varios periodos: lo que toca a cada tramo (para el 349). Sin
       * el, la app lo reparte por meses en proporcion a lo comprado a ese proveedor.
       */
      reparto: z.array(TramoSchema).max(60, 'El reparto admite como mucho 60 tramos.').optional(),
    })
    .optional(),
  corregida: LineasCompletas('la factura corregida').optional(),
  importesOriginales: LineasCompletas('la factura original').optional(),
  /** La pantalla lo manda tras el 409 rectificar_303 (seccion 11). */
  confirmaRectificar303: z.boolean().optional(),
  /** Original de fuera: false = «No, se descuenta de lo que le debo» (compensacion de fuera). */
  yaPagada: z.boolean().optional(),
});

export type RectificativaBody = Omit<z.infer<typeof RectificativaSchema>, 'causa'> & { causa: Causa };

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
  /** Abono o rectificativa de proveedor. Sin el, una factura normal. */
  rectificativa: RectificativaSchema.optional(),
});

/** Linea validada. `ivaFijado` solo lo pone el servidor (diferencias de una sustitucion). */
export type LineaGastoBody = z.infer<typeof LineaSchema> & { ivaFijado?: number };
export type FacturaGastoBody = Omit<z.infer<typeof FacturaGastoSchema>, 'lineas' | 'rectificativa'> & {
  lineas: LineaGastoBody[];
  rectificativa?: RectificativaBody;
  /** Avisos que no impiden el alta (por ejemplo, la cuota de una diferencia por redondeo). */
  avisos?: string[];
};

/**
 * Totales de una factura de gasto (el mismo redondeo que el alta: por linea y
 * despues la suma). Con signo en los abonos: sobre el valor absoluto y con el
 * signo despues, para que el abono espejo deje la original a cero.
 */
export function totalesLineas(lineas: Array<{ cantidad: number; precioUnitario: number; descuentoPorcentaje?: number; tipoIva: number; tipoRetencion?: number }>) {
  const r2 = r2GastoConSigno;
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

/** Guia para quien mete un abono como factura normal (precio o importe en negativo). */
export const COMO_ABONO =
  'Si es un abono o una rectificativa del proveedor, regístrala como abono: Compras › Nueva factura de gasto › Abono o rectificativa.';

/**
 * Valida el cuerpo de una factura de gasto: forma (Zod) y reglas que cruzan
 * campos. `paisProveedor` es el del proveedor elegido o el del nuevo (ISO-2).
 * Acepta el alias antiguo `provider` como `proveedor`.
 */
export function validarFacturaGasto(
  cuerpo: unknown,
  opciones: { paisProveedor?: string | null; permitirSerie?: boolean; empresaEspanola?: boolean } = {},
): FacturaGastoBody {
  const bruto = { ...((cuerpo ?? {}) as Record<string, unknown>) };
  if (bruto.proveedor === undefined && bruto.provider !== undefined) bruto.proveedor = bruto.provider;
  if (!opciones.permitirSerie) delete bruto.serie;
  if (bruto.rectificativa === null) delete bruto.rectificativa;
  // Sustitucion: las lineas del cuerpo son las de la factura corregida (despues se cambian por la diferencia).
  const rb = bruto.rectificativa as { tipo?: unknown; corregida?: { lineas?: unknown } } | undefined;
  if (rb && typeof rb === 'object' && rb.tipo === 'S') {
    if (!rb.corregida?.lineas) throw error('Por sustitución hacen falta las líneas de la factura corregida.', 'rectificativa.corregida');
    bruto.lineas = rb.corregida.lineas;
  }

  const r = FacturaGastoSchema.safeParse(bruto);
  if (!r.success) {
    const primero = r.error.issues[0];
    throw error(primero.message, primero.path.join('.') || 'cuerpo', r.error.flatten());
  }
  const d = r.data as FacturaGastoBody;
  if (!d.rectificativa) {
    const i = d.lineas.findIndex((l) => l.precioUnitario < 0);
    if (i >= 0) throw error(`El precio no puede ser negativo. ${COMO_ABONO}`, `lineas.${i}.precioUnitario`);
  } else {
    validarBloqueRectificativa(d);
  }

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
        l.tipoRetencion === 1 || l.tipoRetencion === 2
          ? 'Las retenciones del 1 % y del 2 % (actividades agrícolas, ganaderas y forestales o en módulos) aún no están disponibles: consúltalo con tu asesor.'
          : 'Solo las facturas de profesionales (7, 15 o 19 %) y de alquileres (19 %) llevan retención de IRPF: revisa el tipo de gasto.',
        `lineas.${i}.tipoRetencion`,
      );
    }
  });
  // Una empresa no establecida en Espana no lleva IVA español ni retenciones
  // (no presenta el 303, el 111 ni el 115), igual que en ventas.
  if (opciones.empresaEspanola === false) {
    const i = d.lineas.findIndex((l) => l.tipoIva !== 0 || l.tipoRetencion !== 0);
    if (i >= 0) {
      throw error(
        'La empresa no está establecida en España: sus facturas de gasto no llevan IVA español ni retención de IRPF. Pon el IVA y la retención al 0 % y, si la factura trae impuestos de otro país, inclúyelos en la base.',
        `lineas.${i}.${d.lineas[i].tipoIva !== 0 ? 'tipoIva' : 'tipoRetencion'}`,
      );
    }
  }
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
  if (d.rectificativa) {
    comprobarImportesRectificativa(d);
    return d;
  }
  const t = totalesLineas(d.lineas);
  if (aCentimos(t.base) <= 0) {
    throw error(
      `El importe tiene que ser mayor que cero. ${COMO_ABONO}`,
      'lineas',
    );
  }
  if (d.totalDocumento !== undefined && Math.abs(aCentimos(d.totalDocumento) - aCentimos(t.total)) > 2) {
    throw error(
      `El total calculado (${eur(t.total)}) no coincide con el de la factura (${eur(d.totalDocumento)}): revisa las bases, el IVA y la retención.`,
      'totalDocumento',
    );
  }
  return d;
}

const ddmmaaaa = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}`;

/**
 * Reglas del bloque `rectificativa` que no necesitan la BD (seccion 7.2 de la
 * especificacion): causa, tipo, originales o periodo, fechas y, en la
 * sustitucion con una original de fuera, las lineas de diferencia. Las que
 * miran las originales de la app (empresa, proveedor, anuladas, lo pendiente)
 * van en el alta.
 */
function validarBloqueRectificativa(d: FacturaGastoBody): void {
  const r = d.rectificativa!;
  const causa = String(r.causa ?? '').trim().toUpperCase();
  if ((CAUSAS_NO_ADMITIDAS as readonly string[]).includes(causa)) throw error(TEXTO_IMPAGO_CONCURSO, 'rectificativa.causa');
  if (!esCausa(causa)) throw error('Elige la causa de la rectificación.', 'rectificativa.causa');
  r.causa = causa;

  if (r.originales.length && r.periodo) {
    throw error('Indica las facturas que rectifica o el periodo, no las dos cosas.', 'rectificativa.periodo');
  }
  if (!r.originales.length && !r.periodo) {
    throw error('Indica qué factura rectifica, o el periodo si es un descuento por volumen.', 'rectificativa.originales');
  }
  if (r.periodo) {
    if (!CAUSA_INFO[causa].admitePeriodo) {
      throw error('Un periodo solo vale para un rappel o un descuento por volumen: indica la factura que rectifica.', 'rectificativa.periodo');
    }
    if (r.periodo.hasta < r.periodo.desde) throw error('El final del periodo no puede ser anterior al inicio.', 'rectificativa.periodo.hasta');
    const tramos = [...(r.periodo.reparto ?? [])].map((t, i) => ({ ...t, i })).sort((a, b) => a.desde.localeCompare(b.desde));
    tramos.forEach((t, k) => {
      const campo = `rectificativa.periodo.reparto.${t.i}`;
      if (t.hasta < t.desde || t.desde < r.periodo!.desde || t.hasta > r.periodo!.hasta) {
        throw error('Cada tramo del reparto tiene que estar dentro del periodo del rappel.', campo);
      }
      if (k > 0 && t.desde <= tramos[k - 1].hasta) throw error('Los tramos del reparto no pueden solaparse.', campo);
    });
    if (r.tipo === 'S') throw error('Una rectificativa por sustitución corrige una factura concreta: indica cuál.', 'rectificativa.periodo');
  }
  r.originales.forEach((o, i) => {
    if (o.id) return;
    if (!o.numero) throw error('Escribe el número de la factura que rectifica.', `rectificativa.originales.${i}.numero`);
    if (!o.fecha) throw error('Indica la fecha de la factura que rectifica.', `rectificativa.originales.${i}.fecha`);
    if (o.fecha > d.fechaEmision) {
      throw error(`La rectificativa no puede tener fecha anterior a la de la factura que rectifica (${ddmmaaaa(o.fecha)}).`, 'fechaEmision');
    }
  });
  if (r.tipo === 'S') {
    if (r.originales.length !== 1) throw error('Una rectificativa por sustitución corrige una sola factura.', 'rectificativa.originales');
    const o = r.originales[0];
    if (!o.id && !r.importesOriginales) {
      throw error('La factura original no está en la app: escribe sus líneas para calcular la diferencia.', 'rectificativa.importesOriginales');
    }
    if (r.importesOriginales?.lineas.some((l) => l.precioUnitario < 0) || r.corregida?.lineas.some((l) => l.precioUnitario < 0)) {
      throw error('En una rectificativa por sustitución, las dos facturas van con sus importes en positivo.', 'rectificativa.corregida');
    }
    if (!o.id) {
      const dif = lineasDiferencia(r.importesOriginales!.lineas, r.corregida!.lineas);
      d.lineas = dif.lineas.map((l) => ({ ...l, descuentoPorcentaje: 0, tipoRetencion: l.tipoRetencion ?? 0 }));
      if (dif.avisos.length) d.avisos = [...(d.avisos ?? []), ...dif.avisos];
    }
  }
}

/** Base, IVA (con la cuota fijada de las lineas de diferencia) y retencion de unas lineas, con signo. */
export function totalesRectificativa(lineas: LineaGastoBody[]): { base: number; iva: number; retencion: number; total: number } {
  let base = 0;
  let iva = 0;
  let ret = 0;
  for (const l of lineas) {
    const t = totalesLineas([l]);
    base += aCentimos(t.base);
    iva += l.ivaFijado !== undefined ? aCentimos(r2GastoConSigno(l.ivaFijado)) : aCentimos(t.iva);
    ret += aCentimos(t.retencion);
  }
  return { base: base / 100, iva: iva / 100, retencion: ret / 100, total: (base + iva - ret) / 100 };
}

/**
 * Reglas de importes de una rectificativa con las lineas ya definitivas (en la
 * sustitucion, la diferencia): que cambie algun importe, el signo segun la
 * causa, el total del documento y el reparto entre originales. La usan
 * validarFacturaGasto y el alta de una sustitucion con la original en la app,
 * despues de calcular la diferencia.
 */
export function comprobarImportesRectificativa(d: FacturaGastoBody): void {
  const r = d.rectificativa!;
  const { base, iva, total } = totalesRectificativa(d.lineas);
  if (d.lineas.length === 0 || (aCentimos(base) === 0 && aCentimos(iva) === 0)) {
    throw error(
      'Esta rectificativa no cambia ningún importe: no se registra como abono. Guarda el documento junto a la factura original y, si cambia algún dato que no es fiscal (la dirección, por ejemplo), corrígelo en la ficha del proveedor.',
      'lineas',
    );
  }
  // Un error en el IVA (el tipo o la cuota) deja la base como estaba. Si la base cambia, es
  // que se ha copiado la factura entera o que la causa es otra (devolucion, precio...).
  // Por sustitucion se mira la factura corregida, no la diferencia: no se comprueba aqui.
  if (r.causa === 'ERROR_IVA' && r.tipo === 'I' && aCentimos(base) !== 0) {
    throw error(
      'Una rectificativa por un error en el IVA no cambia la base. Pon la línea con el IVA equivocado en negativo y otra igual con el IVA correcto, o elige «Por sustitución» y cambia solo el tipo de IVA. Si también cambia el importe, elige otra causa.',
      'lineas',
    );
  }
  if (CAUSA_INFO[r.causa].soloBaja && r.tipo === 'I' && sentido(base, iva) !== 'ABONO') {
    throw error('Un descuento o una devolución resta: revisa el signo.', 'lineas');
  }
  if (d.totalDocumento !== undefined) {
    // Por sustitucion, el documento trae el total de la factura corregida.
    const esperado = r.tipo === 'S' && r.corregida ? totalesLineas(r.corregida.lineas).total : total;
    if (Math.abs(aCentimos(d.totalDocumento) - aCentimos(esperado)) > 2) {
      throw error(
        `El total calculado (${eur(esperado)}) no coincide con el de la factura (${eur(d.totalDocumento)}): revisa las bases, el IVA, la retención y el signo.`,
        'totalDocumento',
      );
    }
  }
  const tramos = r.periodo?.reparto ?? [];
  if (tramos.length) {
    const suma = (k: 'base' | 'cuota' | 'retencion') => tramos.reduce((a, x) => a + aCentimos(x[k] ?? 0), 0);
    if (suma('base') !== aCentimos(base)) {
      throw error(`El reparto por periodos (${eur(suma('base') / 100)}) no suma la base de la rectificativa (${eur(base)}).`, 'rectificativa.periodo.reparto');
    }
    if (tramos.every((x) => x.cuota !== undefined) && suma('cuota') !== aCentimos(iva)) {
      throw error(`El reparto del IVA por periodos (${eur(suma('cuota') / 100)}) no suma el IVA de la rectificativa (${eur(iva)}).`, 'rectificativa.periodo.reparto');
    }
  }
  if (r.originales.length > 1 && r.originales.some((o) => o.base !== undefined || o.cuota !== undefined)) {
    const i = r.originales.findIndex((o) => o.base === undefined);
    if (i >= 0) throw error('Indica la base que corresponde a cada factura, o deja que la app la reparta.', `rectificativa.originales.${i}.base`);
    const sumaBase = r.originales.reduce((a, o) => a + aCentimos(o.base ?? 0), 0);
    if (sumaBase !== aCentimos(base)) {
      throw error(
        `El reparto entre las facturas que rectifica (${eur(sumaBase / 100)}) no suma la base de la rectificativa (${eur(base)}).`,
        'rectificativa.originales',
      );
    }
    if (r.originales.every((o) => o.cuota !== undefined)) {
      const sumaCuota = r.originales.reduce((a, o) => a + aCentimos(o.cuota ?? 0), 0);
      if (sumaCuota !== aCentimos(iva)) {
        throw error(
          `El reparto del IVA entre las facturas que rectifica (${eur(sumaCuota / 100)}) no suma el IVA de la rectificativa (${eur(iva)}).`,
          'rectificativa.originales',
        );
      }
    }
  }
}
