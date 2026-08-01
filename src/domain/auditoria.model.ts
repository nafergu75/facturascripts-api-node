export interface AuditLog {
  id: string;
  timestamp: string;
  userId: string;
  companyId?: string;
  action: string; // ej: 'CREATE_ASIENTO', 'UPDATE_SUBCUENTA'
  resourceType: string; // ej: 'ASIENTO', 'SUBCUENTA', 'FACTURA'
  resourceId?: string;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>;
}
