/**
 * Helpers compartidos para documentos (Income Reader + Registro Mercantil).
 * Centraliza validaciones de coherencia, vigencia y manejo de estados.
 */

/**
 * Validar si un documento está vigente (no ha expirado).
 * Retorna true si:
 * - No tiene expiresAt (vigencia indefinida), O
 * - expiresAt > ahora (aún no expira)
 *
 * Retorna false si:
 * - expiresAt <= ahora (ya expiró)
 */
export function esVigente(documento: { expiresAt: Date | null }): boolean {
  if (!documento.expiresAt) return true;
  return documento.expiresAt > new Date();
}

/**
 * Calcular días hasta caducidad.
 * Retorna:
 * - Número positivo si aún vigente (días que faltan)
 * - Número negativo si expirado (hace cuántos días)
 * - null si sin fecha de caducidad
 */
export function diasParaCaducidad(documento: {
  expiresAt: Date | null;
}): number | null {
  if (!documento.expiresAt) return null;
  return Math.floor((documento.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

/**
 * Validar coherencia de estado de un documento Income Reader.
 * Asegura que los campos no son contradictorios.
 *
 * Reglas:
 * - Si status=PROCESSING: errorMensaje debe ser null
 * - Si status=READY_FOR_VERIFICATION: errorMensaje debe ser null
 * - Si status=ERROR: errorMensaje debe existir
 * - Si status=REJECTED: rejectionReason debe existir
 * - Si expiresAt pasado: no importa status, considerar como invalida
 *
 * Retorna { válido: bool, razón: string | null }
 */
export function validarCoherenciaIncomeReader(documento: {
  status: string;
  errorMensaje: string | null;
  rejectionReason: string | null;
  expiresAt: Date | null;
}): { válido: boolean; razón: string | null } {
  // Validación 1: Si expirado, no es válido
  if (!esVigente(documento)) {
    return { válido: false, razón: 'Documento expirado' };
  }

  // Validación 2: status=ERROR debe tener errorMensaje
  if (documento.status === 'ERROR' && !documento.errorMensaje) {
    return { válido: false, razón: 'status=ERROR pero sin errorMensaje' };
  }

  // Validación 3: status!=ERROR no debe tener errorMensaje
  if (documento.status !== 'ERROR' && documento.errorMensaje) {
    return { válido: false, razón: `status=${documento.status} pero tiene errorMensaje` };
  }

  // Validación 4: status=REJECTED debe tener rejectionReason
  if (documento.status === 'REJECTED' && !documento.rejectionReason) {
    return { válido: false, razón: 'status=REJECTED pero sin rejectionReason' };
  }

  return { válido: true, razón: null };
}

/**
 * Validar coherencia de estado de un documento Registro Mercantil.
 * Asegura que versión, isLatestVersion y caducidad son coherentes.
 *
 * Reglas:
 * - version debe ser >= 1
 * - isLatestVersion=true implica que es la versión a usar
 * - isLatestVersion=false implica que existe una versión más nueva
 * - expiresAt pasado: marca como inválido independientemente de isLatestVersion
 *
 * Retorna { válido: bool, razón: string | null }
 */
export function validarCoherenciaRegistroMercantil(documento: {
  version: number;
  isLatestVersion: boolean;
  expiresAt: Date | null;
}): { válido: boolean; razón: string | null } {
  // Validación 1: version debe ser >= 1
  if (documento.version < 1) {
    return { válido: false, razón: 'version debe ser >= 1' };
  }

  // Validación 2: Si expirado, no es válido (incluso si isLatestVersion=true)
  if (!esVigente(documento)) {
    return { válido: false, razón: 'Documento expirado' };
  }

  return { válido: true, razón: null };
}

/**
 * Calcular fecha de caducidad estándar.
 * Por defecto: 4 años (período legal de archivo en España).
 */
export function calcularCaducidad(diasDesdeHoy: number = 1460): Date {
  const fecha = new Date();
  fecha.setDate(fecha.getDate() + diasDesdeHoy);
  return fecha;
}

/**
 * Generar mensaje de error estándar para documento expirado.
 */
export function mensajeDocumentoExpirado(documento: {
  expiresAt: Date | null;
  tipo?: string;
}): string {
  const tipo = documento.tipo || 'El documento';
  const fechaStr = documento.expiresAt ? documento.expiresAt.toISOString().split('T')[0] : 'desconocida';
  return `${tipo} ha expirado (vencía: ${fechaStr}).`;
}

/**
 * Generar mensaje de validación de coherencia fallida.
 * Útil para debuggear estados contradictorios.
 */
export function mensajeCoherenciaFallida(
  módulo: 'income-reader' | 'registro-mercantil',
  razón: string,
): string {
  return `[${módulo}] Coherencia de estado fallida: ${razón}`;
}
