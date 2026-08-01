/**
 * Funciones de formateo para valores comunes
 */

/**
 * Formatear número como moneda EUR
 */
export function formatCurrency(value: number): string {
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

/**
 * Formatear fecha ISO a formato local
 */
export function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return new Intl.DateTimeFormat('es-ES', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

/**
 * Formatear estado de asiento con etiqueta legible
 */
export const estadoLabels: Record<string, { label: string; color: string }> = {
  DRAFT: {
    label: 'Borrador',
    color: 'gray'
  },
  PENDING_REVIEW: {
    label: 'Pendiente de Revisión',
    color: 'yellow'
  },
  POSTED: {
    label: 'Contabilizado',
    color: 'green'
  },
  REVERSED: {
    label: 'Reversado',
    color: 'red'
  }
};

export function getEstadoLabel(estado: string): string {
  return estadoLabels[estado]?.label || estado;
}

export function getEstadoColor(estado: string): string {
  return estadoLabels[estado]?.color || 'gray';
}

/**
 * Formatear origen de asiento
 */
export const origenLabels: Record<string, string> = {
  // Valores escritos por el motor contable del backend
  FACTURA_INGRESO: 'Factura de Ingreso',
  FACTURA_GASTO: 'Factura de Gasto',
  // Aliases para compatibilidad con código legacy o asientos manuales
  INCOME_INVOICE: 'Factura de Ingreso',
  EXPENSE_INVOICE: 'Factura de Gasto',
  MANUAL: 'Asiento Manual',
  REVERSAL: 'Reversión',
};

export function getOrigenLabel(origen?: string): string {
  if (!origen) return 'No especificado';
  return origenLabels[origen] || origen;
}

/**
 * Validar que debe y haber estén balanceados
 */
export function validateBalance(debe: number, haber: number, tolerance: number = 0.01): boolean {
  return Math.abs(debe - haber) < tolerance;
}

/**
 * Formatear saldo (debe - haber)
 */
export function calculateBalance(debe: number, haber: number): number {
  return debe - haber;
}
