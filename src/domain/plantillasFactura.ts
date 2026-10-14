/**
 * Plantillas de las facturas de venta. Puro: sin BD.
 *
 * Cada serie de facturas tiene su plantilla (InvoiceSeries.plantilla); la
 * factura guarda la suya en IncomeInvoice.plantillaId, que ya existia con el
 * valor 'default' (la de siempre).
 *  - 'default' (Estandar): la de siempre.
 *  - 'A': envases (packs, unidades, kg de plastico e IEEPNR), como la factura
 *    NZ004_26. El IVA se calcula por tipo, no por linea.
 *  - 'B': ceramica y materiales de construccion (palets, cajas, m2, piezas,
 *    formato, calidad, peso, obra, pesos neto y bruto y cargo de palets), como
 *    la factura NZ013_2026. El IVA se calcula por tipo, no por linea.
 *  - 'C': la estandar con otro nombre (prestaciones de servicios).
 *
 * Plantilla automatica (la serie sin plantilla elegida), por el codigo de la
 * serie: la A en la serie A si la empresa repercute el IEEPNR; la B en la
 * serie B si la empresa dice que vende ceramica (Configuracion > Facturacion);
 * la C en la serie C; el resto, la estandar. La A y la B, solo en empresas
 * espanolas. Asi una empresa que usa la A o la B para otra cosa no cambia de
 * calculo ni de PDF sin enterarse.
 */

export const PLANTILLAS_VENTA = ['default', 'A', 'B', 'C'] as const;
export type PlantillaVentaId = (typeof PLANTILLAS_VENTA)[number];

export interface PlantillaVenta {
  id: PlantillaVentaId;
  nombre: string;
  descripcion: string;
  /** Lleva packs, kg de plastico, IEEPNR, texto adicional y peso bruto (la A). */
  envases: boolean;
  /** Lleva palets, cajas, m2, piezas, formato, calidad, peso, unidad del precio, cargo de palets, obra, texto adicional y pesos neto y bruto (la B). */
  ceramica: boolean;
  /** Admite descuento por linea (la A y la B no: su PDF no tiene esa columna). */
  descuento: boolean;
  /** 'linea': la cuota de IVA se redondea en cada linea (la de siempre). 'tipo': sobre la suma de bases de cada tipo. */
  calculoIva: 'linea' | 'tipo';
  /** Solo para empresas espanolas (la A por el IEEPNR; la B, por su PDF en espanol y en euros). */
  soloEmpresaEspanola: boolean;
  /** Tiene su diseno. Sin el no se puede elegir. */
  disenada: boolean;
}

/** Lo que decide las plantillas de una empresa: si es espanola, si repercute el IEEPNR y si vende ceramica. */
export interface ContextoPlantillas {
  espanola: boolean;
  /** Configuracion > Facturacion: «Repercuto el IEEPNR en mis facturas». */
  repercuteIeepnr: boolean;
  /** Configuracion > Facturacion: «Vendo ceramica y materiales de construccion». Sin indicar, no. */
  vendeCeramica?: boolean;
}

export const CATALOGO_PLANTILLAS: readonly PlantillaVenta[] = [
  {
    id: 'default',
    nombre: 'Estándar',
    descripcion: 'La de siempre',
    envases: false,
    ceramica: false,
    descuento: true,
    calculoIva: 'linea',
    soloEmpresaEspanola: false,
    disenada: true,
  },
  {
    id: 'A',
    nombre: 'Plantilla A (envases)',
    descripcion: 'Packs, unidades, kg de plástico e IEEPNR, como la factura NZ004_26',
    envases: true,
    ceramica: false,
    descuento: false,
    calculoIva: 'tipo',
    soloEmpresaEspanola: true,
    disenada: true,
  },
  {
    id: 'B',
    nombre: 'Plantilla B (cerámica)',
    descripcion: 'Palets, cajas, m², piezas, formato, calidad, peso, obra y cargo de palets, como la factura NZ013_2026',
    envases: false,
    ceramica: true,
    descuento: false,
    calculoIva: 'tipo',
    soloEmpresaEspanola: true,
    disenada: true,
  },
  {
    id: 'C',
    nombre: 'Plantilla C (servicios)',
    descripcion: 'La estándar con otro nombre, para prestaciones de servicios',
    envases: false,
    ceramica: false,
    descuento: true,
    calculoIva: 'linea',
    soloEmpresaEspanola: false,
    disenada: true,
  },
];

/** Codigos de serie con plantilla automatica propia (el resto, la estandar). */
export const SERIES_CON_PLANTILLA_AUTOMATICA = ['A', 'B', 'C'] as const;

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
 * Plantilla automatica de la serie de codigo «B»: la B si la empresa es
 * espanola y dice que vende ceramica; si no, la estandar. Asi una serie B que
 * la empresa usa para otra cosa sigue con la de siempre (IVA por linea,
 * descuento y el PDF de siempre).
 */
export function plantillaAutomaticaSerieB(ctx: ContextoPlantillas): PlantillaVentaId {
  return ctx.espanola && ctx.vendeCeramica === true ? 'B' : 'default';
}

/**
 * Plantilla automatica de una serie sin plantilla elegida, por su codigo: la A
 * en la serie A (plantillaAutomaticaSerieA); la B en la serie B
 * (plantillaAutomaticaSerieB) y la C en la serie C; el resto, la estandar. Una
 * solo para Espana en una empresa extranjera pasa a la estandar.
 */
export function plantillaAutomatica(codigo: string, ctx: ContextoPlantillas): PlantillaVentaId {
  const c = String(codigo ?? '').trim().toUpperCase();
  const id: PlantillaVentaId = c === 'A' ? plantillaAutomaticaSerieA(ctx) : c === 'B' ? plantillaAutomaticaSerieB(ctx) : c === 'C' ? 'C' : 'default';
  return plantillaDisponible(id, ctx.espanola) ? id : 'default';
}

/**
 * El catalogo para una empresa. `disponible`: se puede elegir (la A y la B, no
 * en una extranjera). `automaticaSerieA`: es la que usa la serie A cuando no
 * tiene una elegida. `seriesAutomaticas`: las series de codigo A, B o C que la
 * usan sin elegirla (las demas series, sin elegir, usan la estandar).
 */
export function catalogoPlantillas(
  ctx: ContextoPlantillas,
): Array<PlantillaVenta & { disponible: boolean; automaticaSerieA: boolean; seriesAutomaticas: string[] }> {
  const automatica = plantillaAutomaticaSerieA(ctx);
  return CATALOGO_PLANTILLAS.map((p) => ({
    ...p,
    disponible: p.disenada && plantillaDisponible(p.id, ctx.espanola),
    automaticaSerieA: p.id === automatica,
    seriesAutomaticas: SERIES_CON_PLANTILLA_AUTOMATICA.filter((c) => plantillaAutomatica(c, ctx) === p.id),
  }));
}

/** Se puede usar en esta empresa (la A y la B, solo en una espanola). */
export function plantillaDisponible(id: unknown, espanola: boolean): boolean {
  return espanola || !plantilla(id).soloEmpresaEspanola;
}

/** Tiene su diseno, asi que se puede elegir en una serie. */
export function plantillaDisenada(id: unknown): boolean {
  return plantilla(id).disenada;
}

/**
 * Plantilla que usa una serie: la elegida o, sin elegir (null), la automatica
 * de su codigo (plantillaAutomatica). Una plantilla solo para Espana en una
 * empresa extranjera pasa a la estandar.
 */
export function plantillaEfectivaSerie(serie: { codigo: string; plantilla?: string | null }, ctx: ContextoPlantillas): PlantillaVentaId {
  const elegida = serie.plantilla ? normalizarPlantillaId(serie.plantilla) : null;
  const id: PlantillaVentaId = elegida ?? plantillaAutomatica(serie.codigo, ctx);
  return plantillaDisponible(id, ctx.espanola) ? id : 'default';
}

/** Lleva packs, kg, IEEPNR y peso bruto. Solo la A. */
export function admiteEnvases(id: unknown): boolean {
  return plantilla(id).envases;
}

/** Lleva palets, cajas, m2, piezas, formato, calidad, peso, cargo de palets, obra y pesos neto y bruto. Solo la B. */
export function admiteCeramica(id: unknown): boolean {
  return plantilla(id).ceramica;
}

/** Admite descuento por linea (la estandar y la C; la A y la B, no). */
export function admiteDescuento(id: unknown): boolean {
  return plantilla(id).descuento;
}

/** Lleva texto adicional bajo el concepto (la A y la B). */
export function admiteTextoAdicional(id: unknown): boolean {
  return plantilla(id).envases || plantilla(id).ceramica;
}

/** Lleva peso bruto escrito a mano (la A y la B). */
export function admitePesoBruto(id: unknown): boolean {
  return plantilla(id).envases || plantilla(id).ceramica;
}

/** El IVA se calcula sobre la suma de bases de cada tipo (opcion cuotaPorTipo). */
export function ivaPorTipo(id: unknown): boolean {
  return plantilla(id).calculoIva === 'tipo';
}

/** Diseno del PDF: el de la A, el de la B o el de siempre (la C es la estandar). */
export function dibujoDe(id: unknown): 'A' | 'B' | 'estandar' {
  const n = normalizarPlantillaId(id);
  return n === 'A' ? 'A' : n === 'B' ? 'B' : 'estandar';
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
