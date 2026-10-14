/**
 * Plantillas de las facturas de venta. Puro: sin BD.
 *
 * Cada serie de facturas tiene su plantilla (InvoiceSeries.plantilla); la
 * factura guarda la suya en IncomeInvoice.plantillaId, que ya existia con el
 * valor 'default' (la de siempre).
 *  - 'default' (Estandar): la de siempre.
 *  - 'A': envases (packs, unidades, kg de plastico e IEEPNR), como la factura
 *    NZ004_26. El IVA se calcula por tipo, no por linea.
 *  - 'B': ceramica y materiales de construccion. Aun sin diseno: no se puede
 *    elegir (asi ninguna factura emitida cambia de aspecto cuando lo tenga).
 *  - 'C': la estandar con otro nombre (prestaciones de servicios).
 */

export const PLANTILLAS_VENTA = ['default', 'A', 'B', 'C'] as const;
export type PlantillaVentaId = (typeof PLANTILLAS_VENTA)[number];

export interface PlantillaVenta {
  id: PlantillaVentaId;
  nombre: string;
  descripcion: string;
  /** Lleva packs, kg de plastico, IEEPNR, texto adicional y peso bruto. */
  envases: boolean;
  /** 'linea': la cuota de IVA se redondea en cada linea (la de siempre). 'tipo': sobre la suma de bases de cada tipo. */
  calculoIva: 'linea' | 'tipo';
  /** Solo para empresas espanolas (el IEEPNR es un impuesto espanol). */
  soloEmpresaEspanola: boolean;
  /** Tiene su diseno. Sin el (la B, por ahora) no se puede elegir. */
  disenada: boolean;
}

/** Lo que decide las plantillas de una empresa: si es espanola y si repercute el IEEPNR. */
export interface ContextoPlantillas {
  espanola: boolean;
  /** Configuracion > Facturacion: «Repercuto el IEEPNR en mis facturas». */
  repercuteIeepnr: boolean;
}

export const CATALOGO_PLANTILLAS: readonly PlantillaVenta[] = [
  { id: 'default', nombre: 'Estándar', descripcion: 'La de siempre', envases: false, calculoIva: 'linea', soloEmpresaEspanola: false, disenada: true },
  {
    id: 'A',
    nombre: 'Plantilla A (envases)',
    descripcion: 'Packs, unidades, kg de plástico e IEEPNR, como la factura NZ004_26',
    envases: true,
    calculoIva: 'tipo',
    soloEmpresaEspanola: true,
    disenada: true,
  },
  {
    id: 'B',
    nombre: 'Plantilla B',
    descripcion: 'Cerámica y materiales de construcción. Aún no tiene diseño, así que todavía no se puede elegir',
    envases: false,
    calculoIva: 'linea',
    soloEmpresaEspanola: false,
    disenada: false,
  },
  {
    id: 'C',
    nombre: 'Plantilla C',
    descripcion: 'La estándar con otro nombre, para prestaciones de servicios',
    envases: false,
    calculoIva: 'linea',
    soloEmpresaEspanola: false,
    disenada: true,
  },
];

export function esPlantillaVenta(v: unknown): v is PlantillaVentaId {
  return typeof v === 'string' && (PLANTILLAS_VENTA as readonly string[]).includes(v);
}

/** Un valor desconocido (o vacio) pasa a 'default'. */
export function normalizarPlantillaId(v: unknown): PlantillaVentaId {
  return esPlantillaVenta(v) ? v : 'default';
}

function plantilla(id: unknown): PlantillaVenta {
  const n = normalizarPlantillaId(id);
  return CATALOGO_PLANTILLAS.find((p) => p.id === n)!;
}

/**
 * Plantilla automatica de la serie de codigo «A»: la A si la empresa es
 * espanola y repercute el IEEPNR; si no, la estandar. Asi una empresa que no
 * vende envases sigue con la de siempre en su serie A.
 */
export function plantillaAutomaticaSerieA(ctx: ContextoPlantillas): PlantillaVentaId {
  return ctx.espanola && ctx.repercuteIeepnr ? 'A' : 'default';
}

/**
 * El catalogo para una empresa. `disponible`: se puede elegir (la A, no en una
 * extranjera; la B, sin diseno aun, en ninguna). `automaticaSerieA`: es la que
 * usa la serie A cuando no tiene una elegida.
 */
export function catalogoPlantillas(ctx: ContextoPlantillas): Array<PlantillaVenta & { disponible: boolean; automaticaSerieA: boolean }> {
  const automatica = plantillaAutomaticaSerieA(ctx);
  return CATALOGO_PLANTILLAS.map((p) => ({
    ...p,
    disponible: p.disenada && plantillaDisponible(p.id, ctx.espanola),
    automaticaSerieA: p.id === automatica,
  }));
}

/** Se puede usar en esta empresa (la A, solo en una espanola). */
export function plantillaDisponible(id: unknown, espanola: boolean): boolean {
  return espanola || !plantilla(id).soloEmpresaEspanola;
}

/** Tiene su diseno, asi que se puede elegir en una serie (la B, todavia no). */
export function plantillaDisenada(id: unknown): boolean {
  return plantilla(id).disenada;
}

/**
 * Plantilla que usa una serie: la elegida o, sin elegir (null), la automatica
 * (la A en la serie de codigo «A» de una empresa espanola que repercute el
 * IEEPNR; la estandar en el resto). Una plantilla solo para Espana en una
 * empresa extranjera pasa a la estandar.
 */
export function plantillaEfectivaSerie(serie: { codigo: string; plantilla?: string | null }, ctx: ContextoPlantillas): PlantillaVentaId {
  const elegida = serie.plantilla ? normalizarPlantillaId(serie.plantilla) : null;
  const id: PlantillaVentaId = elegida ?? (serie.codigo === 'A' ? plantillaAutomaticaSerieA(ctx) : 'default');
  return plantillaDisponible(id, ctx.espanola) ? id : 'default';
}

/** Lleva packs, kg, IEEPNR, texto adicional y peso bruto. Solo la A. */
export function admiteEnvases(id: unknown): boolean {
  return plantilla(id).envases;
}

/** El IVA se calcula sobre la suma de bases de cada tipo (opcion cuotaPorTipo). */
export function ivaPorTipo(id: unknown): boolean {
  return plantilla(id).calculoIva === 'tipo';
}

/** Diseno del PDF: el de la A o el de siempre (la C es la estandar; la B, mientras no tenga el suyo). */
export function dibujoDe(id: unknown): 'A' | 'estandar' {
  return normalizarPlantillaId(id) === 'A' ? 'A' : 'estandar';
}

/** Texto adicional bajo el concepto (del articulo o de la linea): 500 caracteres y 6 lineas como mucho. */
export const TEXTO_ADICIONAL_MAX = 500;
export const TEXTO_ADICIONAL_LINEAS_MAX = 6;

/**
 * Texto adicional de la factura (de un articulo o de una linea): saltos de
 * linea normalizados, sin espacios al final y como mucho 500 caracteres y 6
 * lineas. null si llega vacio; { ok: false } si no es texto o no cumple.
 */
export function limpiarTextoAdicional(v: unknown): { ok: true; valor: string | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, valor: null };
  if (typeof v !== 'string') return { ok: false };
  const texto = v
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();
  if (!texto) return { ok: true, valor: null };
  if (texto.length > TEXTO_ADICIONAL_MAX || texto.split('\n').length > TEXTO_ADICIONAL_LINEAS_MAX) return { ok: false };
  return { ok: true, valor: texto };
}
