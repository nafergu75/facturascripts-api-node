export interface Company {
  id: string;
  name: string;
  /** URL base de la instancia FacturaScripts de esta empresa (incluye /api/3). */
  fsBaseUrl: string;
  /** API Key de FacturaScripts. Se almacenara cifrada en la BD. */
  fsApiKeyEnc?: string;
  isActive: boolean;
}
