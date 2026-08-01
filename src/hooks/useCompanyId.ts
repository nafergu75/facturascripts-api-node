/**
 * Hook para obtener el companyId de la ruta
 * Asume que React Router está configurado con params /:companyId
 */

import { useParams } from 'react-router-dom';

export function useCompanyId(): string {
  const { companyId } = useParams<{ companyId: string }>();

  if (!companyId) {
    throw new Error('companyId no encontrado en parámetros de ruta');
  }

  return companyId;
}

/**
 * Hook para obtener el companyId de forma segura (sin throw)
 */
export function useCompanyIdSafe(): string | null {
  const { companyId } = useParams<{ companyId: string }>();
  return companyId || null;
}
