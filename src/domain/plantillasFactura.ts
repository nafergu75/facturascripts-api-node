/**
 * Plantillas de las facturas de venta. Puro: sin BD.
 *
 * Cada serie de facturas tiene su plantilla (InvoiceSeries.plantilla); la
 * factura guarda la suya en IncomeInvoice.plantillaId, que ya existia con el
 * valor 'default' (la de siempre).
 *  - 'default' (Estandar): la de siempre.
 *  - 'A': envases (packs, unidades, kg de plastico e IEEPNR), como la factura
 *    NZ004_26. El IVA se calcula por tipo, no por linea.
 *  - 'B' y 'C': de momento salen igual que la estandar.
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
}

export const CATALOGO_PLANTILLAS: readonly PlantillaVenta[] = [
  { id: 'default', nombre: 'Estándar', descripcion: 'La de siempre', envases: false, calculoIva: 'linea', soloEmpresaEspanola: false },
  {
    id: 'A',
    nombre: 'Plantilla A (envases)',
    descripcion: 'Packs, unidades, kg de plástico e IEEPNR, como la factura NZ004_26',
    envases: true,
    calculoIva: 'tipo',
    soloEmpresaEspanola: true,
  },
  { id: 'B', nombre: 'Plantilla B', descripcion: 'De momento sale igual que la estándar', envases: false, calculoIva: 'linea', soloEmpresaEspanola: false },
  { id: 'C', nombre: 'Plantilla C', descripcion: 'De momento sale igual que la estándar', envases: false, calculoIva: 'linea', soloEmpresaEspanola: false },
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

/** El catalogo para una empresa: la A no esta disponible en una extranjera. */
export function catalogoPlantillas(espanola: boolean): Array<PlantillaVenta & { disponible: boolean }> {
  return CATALOGO_PLANTILLAS.map((p) => ({ ...p, disponible: espanola || !p.soloEmpresaEspanola }));
}

/** Se puede usar en esta empresa. */
export function plantillaDisponible(id: unknown, espanola: boolean): boolean {
  return espanola || !plantilla(id).soloEmpresaEspanola;
}

/**
 * Plantilla que usa una serie: la elegida o, sin elegir (null), la A en la
 * serie de codigo «A» de una empresa espanola y la estandar en el resto. Una
 * plantilla solo para Espana en una empresa extranjera pasa a la estandar.
 */
export function plantillaEfectivaSerie(serie: { codigo: string; plantilla?: string | null }, espanola: boolean): PlantillaVentaId {
  const elegida = serie.plantilla ? normalizarPlantillaId(serie.plantilla) : null;
  const id: PlantillaVentaId = elegida ?? (serie.codigo === 'A' && espanola ? 'A' : 'default');
  return plantillaDisponible(id, espanola) ? id : 'default';
}

/** Lleva packs, kg, IEEPNR, texto adicional y peso bruto. Solo la A. */
export function admiteEnvases(id: unknown): boolean {
  return plantilla(id).envases;
}

/** El IVA se calcula sobre la suma de bases de cada tipo (opcion cuotaPorTipo). */
export function ivaPorTipo(id: unknown): boolean {
  return plantilla(id).calculoIva === 'tipo';
}

/** Diseno del PDF: el de la A o el de siempre (B y C, de momento, el de siempre). */
export function dibujoDe(id: unknown): 'A' | 'estandar' {
  return normalizarPlantillaId(id) === 'A' ? 'A' : 'estandar';
}
