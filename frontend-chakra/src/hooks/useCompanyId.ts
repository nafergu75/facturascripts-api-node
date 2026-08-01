/**
 * Empresa activa para las llamadas a /companies/:companyId/...
 *
 * La sesion (login) guarda el id de empresa en localStorage bajo
 * 'company_id'. Todas las paginas de este front leen ese valor a traves de
 * este hook para construir las URLs de la API.
 */
export function useCompanyId(): string {
  return localStorage.getItem('company_id') || '';
}
