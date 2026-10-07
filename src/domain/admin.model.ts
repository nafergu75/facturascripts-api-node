/** Empresa tal como la ve el panel de administracion (sin secretos de FacturaScripts). */
export interface EmpresaAdmin {
  id: string;
  codigo?: string | null;
  nombre: string;
  activa: boolean;
  creadoEn?: string;
  /** Datos de LegalConfig, si la empresa ya los tiene rellenos. */
  denominacion?: string | null;
  nif?: string | null;
  /** Pais de LegalConfig (ISO alfa-2); null si aun no hay datos legales. */
  pais?: string | null;
  /** Usuarios con acceso (membresias). */
  usuarios?: number;
  /** Solo en el alta: si ya tiene todos los datos para facturar y, si no, cuales faltan. */
  completo?: boolean;
  pendientes?: string[];
}

/** Acceso de un usuario a una empresa. */
export interface AccesoEmpresa {
  companyId: string;
  nombre: string;
  codigo: string | null;
  activa: boolean;
  rol: string;
}

/** Usuario tal como lo ve el panel. Nunca lleva el hash de la contrasena. */
export interface UsuarioAdmin {
  id: string;
  email: string;
  activo: boolean;
  esAdminGlobal: boolean;
  creadoEn?: string;
  empresas?: AccesoEmpresa[];
}
