/**
 * Dominio del Registro Mercantil: tipos de libros, máquinas de estado y cálculo
 * de plazos legales (legalización +4 meses, depósito de cuentas +7 meses).
 */

export type TipoSociedad = 'SA' | 'SL' | 'SLU' | 'SCP' | 'OTRA';

export type TipoLibro = 'DIARIO' | 'INVENTARIOS_CUENTAS_ANUALES' | 'ACTAS' | 'SOCIOS' | 'CONTRATOS';
export const TIPOS_LIBRO: TipoLibro[] = ['DIARIO', 'INVENTARIOS_CUENTAS_ANUALES', 'ACTAS', 'SOCIOS', 'CONTRATOS'];

export type EstadoLibro = 'PENDING' | 'GENERATED' | 'PACKAGE_READY' | 'FILED' | 'ACCEPTED' | 'REJECTED';
export type EstadoPaquete = 'CREATED' | 'FILED' | 'ACCEPTED' | 'REJECTED';
export type EstadoCuentas = 'DRAFT' | 'READY' | 'FILED' | 'APROBADO' | 'DEFECTOS' | 'RECHAZADO';
export type ModeloCuentas = 'NORMAL' | 'ABREVIADO' | 'PYME';

/**
 * Suma meses a una fecha YYYY-MM-DD con recorte de fin de mes (regla del plazo):
 * 31/12 + 4 meses = 30/04 (abril no tiene 31), no 01/05.
 */
export function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const total = m - 1 + months;
  const ny = y + Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12; // 0-indexado
  const ultimoDia = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const nd = Math.min(d, ultimoDia);
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}

export interface Plazos {
  closingDate: string;
  /** Legalización de libros: cierre + 4 meses. */
  legalizationDeadline: string;
  /** Depósito de cuentas anuales: cierre + 7 meses (norma general). */
  accountsDepositDeadline: string;
}

export function calcularPlazos(closingDate: string): Plazos {
  return {
    closingDate,
    legalizationDeadline: addMonths(closingDate, 4),
    accountsDepositDeadline: addMonths(closingDate, 7),
  };
}

// --- Máquinas de estado (transiciones válidas) ---

const TRANSICIONES_PAQUETE: Record<EstadoPaquete, EstadoPaquete[]> = {
  CREATED: ['FILED'],
  FILED: ['ACCEPTED', 'REJECTED'],
  ACCEPTED: [],
  REJECTED: [],
};
export function puedeTransicionarPaquete(desde: EstadoPaquete, hasta: EstadoPaquete): boolean {
  return TRANSICIONES_PAQUETE[desde]?.includes(hasta) ?? false;
}

const TRANSICIONES_CUENTAS: Record<EstadoCuentas, EstadoCuentas[]> = {
  DRAFT: ['READY'],
  READY: ['FILED'],
  FILED: ['APROBADO', 'DEFECTOS', 'RECHAZADO'],
  APROBADO: [],
  DEFECTOS: ['FILED'], // subsanación: se vuelve a presentar
  RECHAZADO: [],
};
export function puedeTransicionarCuentas(desde: EstadoCuentas, hasta: EstadoCuentas): boolean {
  return TRANSICIONES_CUENTAS[desde]?.includes(hasta) ?? false;
}

export const RESOLUCIONES_CUENTAS: EstadoCuentas[] = ['APROBADO', 'DEFECTOS', 'RECHAZADO'];
