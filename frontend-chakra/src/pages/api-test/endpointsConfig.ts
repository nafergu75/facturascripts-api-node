/**
 * Catálogo estático de endpoints reales para /api-test.
 * Cada pathTemplate es una ruta verificada contra el código fuente del backend
 * (src/routes/*.routes.ts) en el momento de escribir este archivo — no hay
 * endpoints inventados. Si renombras una ruta en el backend, actualiza aquí.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type ApiEndpoint = {
  id: string;
  module: 'lector' | 'contabilidad' | 'informes' | 'seguridad';
  name: string;
  method: HttpMethod;
  /** Ruta relativa a la API. :companyId se sustituye automáticamente con la empresa activa. */
  pathTemplate: string;
  description: string;
  sampleBody?: any;
  requiresAuth?: boolean;
  /** Nota visible si se sabe de antemano que este endpoint está bloqueado/incompleto. */
  knownLimitation?: string;
};

export const apiEndpoints: ApiEndpoint[] = [
  // ─── Seguridad / Auth ──────────────────────────────────────────────────────
  {
    id: 'auth-health',
    module: 'seguridad',
    name: 'Estado del servicio de auth',
    method: 'GET',
    pathTemplate: '/auth/health',
    description: 'Comprueba que el servicio de autenticación responde. No requiere token.',
    requiresAuth: false,
  },
  {
    id: 'auth-login',
    module: 'seguridad',
    name: 'Login',
    method: 'POST',
    pathTemplate: '/auth/login',
    description: 'Inicia sesión con email y contraseña. Devuelve token de acceso (24h) y refreshToken.',
    sampleBody: { email: 'tu-email@ejemplo.com', password: 'tu-contraseña' },
    requiresAuth: false,
  },
  {
    id: 'auth-refresh',
    module: 'seguridad',
    name: 'Refrescar sesión',
    method: 'POST',
    pathTemplate: '/auth/refresh',
    description: 'Cambia un refreshToken válido por un nuevo par de tokens (rotación). El refreshToken usado queda revocado.',
    sampleBody: { refreshToken: 'pega-aqui-tu-refreshToken' },
    requiresAuth: false,
  },
  {
    id: 'auth-logout',
    module: 'seguridad',
    name: 'Logout',
    method: 'POST',
    pathTemplate: '/auth/logout',
    description: 'Revoca un refreshToken de forma inmediata (logout real, no solo borrar el token en el navegador).',
    sampleBody: { refreshToken: 'pega-aqui-tu-refreshToken' },
    requiresAuth: false,
  },

  // ─── Lector de facturas ────────────────────────────────────────────────────
  {
    id: 'lector-pending',
    module: 'lector',
    name: 'Listar documentos pendientes',
    method: 'GET',
    pathTemplate: '/companies/:companyId/income-reader/pending',
    description: 'Documentos ya leídos (OCR) y a la espera de revisión manual antes de crear la factura.',
    requiresAuth: true,
  },
  {
    id: 'lector-detalle',
    module: 'lector',
    name: 'Detalle de documento',
    method: 'GET',
    pathTemplate: '/companies/:companyId/income-reader/:id',
    description: 'Datos extraídos por el OCR. Vienen vacíos si la lectura automática no está configurada, el formato no se admite o el documento no era legible (el campo ocrEstado lo indica).',
    requiresAuth: true,
  },
  {
    id: 'lector-verificar',
    module: 'lector',
    name: 'Verificar y crear factura',
    method: 'POST',
    pathTemplate: '/companies/:companyId/income-reader/:id/verify',
    description: 'Crea la factura de ingreso a partir de los datos del documento. Falla si faltan NIF emisor o líneas.',
    requiresAuth: true,
  },
  {
    id: 'lector-rechazar',
    module: 'lector',
    name: 'Rechazar documento',
    method: 'POST',
    pathTemplate: '/companies/:companyId/income-reader/:id/reject',
    description: 'Marca el documento como rechazado (no se creará ninguna factura a partir de él).',
    sampleBody: { motivo: 'Documento ilegible' },
    requiresAuth: true,
  },

  // ─── Contabilidad ──────────────────────────────────────────────────────────
  {
    id: 'contabilidad-contabilizar',
    module: 'contabilidad',
    name: 'Contabilizar factura de ingreso',
    method: 'POST',
    pathTemplate: '/companies/:companyId/accounting/contabilizar/:invoiceId?tipo=INGRESO&mode=AUTO',
    description: 'Genera el asiento contable (430/700/477/473) a partir de una factura de ingreso ya existente.',
    requiresAuth: true,
  },
  {
    id: 'contabilidad-listar-asientos',
    module: 'contabilidad',
    name: 'Listar asientos',
    method: 'GET',
    pathTemplate: '/companies/:companyId/accounting/journal-entries',
    description: 'Lista de asientos contables. Admite ?estado=&desde=&hasta=&origen= como filtros opcionales.',
    requiresAuth: true,
  },
  {
    id: 'contabilidad-detalle-asiento',
    module: 'contabilidad',
    name: 'Detalle de asiento',
    method: 'GET',
    pathTemplate: '/companies/:companyId/accounting/journal-entries/:journalEntryId',
    description: 'Asiento completo con líneas, factura asociada y si se puede aprobar o ajustar.',
    requiresAuth: true,
  },
  {
    id: 'contabilidad-aprobar',
    module: 'contabilidad',
    name: 'Aprobar asiento',
    method: 'POST',
    pathTemplate: '/companies/:companyId/accounting/journal-entries/:journalEntryId/approve',
    description: 'Pasa el asiento de DRAFT/PENDING_REVIEW a POSTED (definitivo, cuenta para informes oficiales).',
    sampleBody: { observaciones: '' },
    requiresAuth: true,
  },
  {
    id: 'contabilidad-recalcular',
    module: 'contabilidad',
    name: 'Recalcular asiento',
    method: 'POST',
    pathTemplate: '/companies/:companyId/accounting/journal-entries/:journalEntryId/recalculate',
    description: 'Regenera un asiento si la factura cambió. Útil para ver en vivo cómo se detecta un 501.',
    requiresAuth: true,
    knownLimitation: 'Bloqueado intencionadamente: devuelve 501. Usa "Ajustar línea" como alternativa (no incluido aquí, requiere lineId real).',
  },

  // ─── Informes y exportaciones ──────────────────────────────────────────────
  {
    id: 'informes-balance',
    module: 'informes',
    name: 'Balance de situación',
    method: 'GET',
    pathTemplate: '/companies/:companyId/reports/balance?from=2026-01-01&to=2026-12-31',
    description: 'Activo, pasivo y patrimonio neto a partir de asientos POSTED. Requiere from/to (YYYY-MM-DD).',
    requiresAuth: true,
  },
  {
    id: 'informes-pyg',
    module: 'informes',
    name: 'Pérdidas y ganancias',
    method: 'GET',
    pathTemplate: '/companies/:companyId/reports/profit-and-loss?from=2026-01-01&to=2026-12-31',
    description: 'Ingresos - gastos del periodo, solo con asientos POSTED.',
    requiresAuth: true,
  },
  {
    id: 'informes-iva',
    module: 'informes',
    name: 'IVA repercutido / soportado',
    method: 'GET',
    pathTemplate: '/companies/:companyId/reports/vat?fromDate=2026-01-01&toDate=2026-12-31',
    description: 'Libro de IVA agregado por mes, base para el modelo 303.',
    requiresAuth: true,
  },
  {
    id: 'informes-retenciones',
    module: 'informes',
    name: 'Retenciones IRPF',
    method: 'GET',
    pathTemplate: '/companies/:companyId/reports/retentions?fromDate=2026-01-01&toDate=2026-12-31',
    description: 'Retenciones practicadas, agrupadas por proveedor y por año (o mes, si el registro lo tiene).',
    requiresAuth: true,
  },
  {
    id: 'informes-tesoreria',
    module: 'informes',
    name: 'Tesorería',
    method: 'GET',
    pathTemplate: '/companies/:companyId/reports/treasury?fromDate=2026-01-01&toDate=2026-12-31',
    description: 'Movimientos de cuentas 57x (caja/bancos) a partir de asientos POSTED.',
    requiresAuth: true,
  },
];

export const MODULE_LABEL: Record<ApiEndpoint['module'], string> = {
  lector: 'Lector de facturas',
  contabilidad: 'Contabilidad',
  informes: 'Informes y exportaciones',
  seguridad: 'Seguridad / Auth',
};

export const METHOD_COLOR: Record<HttpMethod, string> = {
  GET: 'blue',
  POST: 'green',
  PUT: 'orange',
  PATCH: 'orange',
  DELETE: 'red',
};
