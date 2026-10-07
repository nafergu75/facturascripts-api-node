import type { Areas, Nivel } from '../services/rbac.service';

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
  /** true si sus permisos en esta empresa estan ajustados a medida (nunca con rol admin). */
  personalizado: boolean;
  /** Lo que puede en cada area por este acceso; null con el perfil Administrador ("todo"). */
  areas: Areas | null;
}

/** Usuario tal como lo ve el panel. Nunca lleva el hash de la contrasena. */
export interface UsuarioAdmin {
  id: string;
  email: string;
  activo: boolean;
  esAdminGlobal: boolean;
  /** Contrasena provisional: todavia no ha puesto la suya. */
  debeCambiarContrasena: boolean;
  /** Hasta cuando vale su contrasena provisional (ISO); null si no es provisional o no caduca. */
  contrasenaProvisionalHasta: string | null;
  /** La provisional ya no vale: hay que generarle otra. */
  contrasenaProvisionalCaducada: boolean;
  creadoEn?: string;
  empresas?: AccesoEmpresa[];
}

/**
 * Respuesta del alta (POST /admin/usuarios) y del restablecimiento (PATCH):
 * la contrasena provisional va SOLO si la genero el servidor, una sola vez.
 */
export type UsuarioConContrasena = UsuarioAdmin & { contrasenaProvisional?: string };

/** Respuesta de PUT /admin/usuarios/:userId/empresas/:companyId. */
export interface AccesoAsignado {
  rol: string;
  rolAnterior: string | null;
  personalizado: boolean;
  personalizadoAntes: boolean;
  areas: Areas | null;
  areasAnteriores: Areas | null;
  /** false: ya estaba asi; no se escribe ni se audita nada. */
  cambiado: boolean;
}

/** Catalogo de la matriz de permisos (GET /admin/permisos/catalogo). */
export interface CatalogoPermisos {
  areas: Array<{ clave: string; nombre: string; descripcion: string }>;
  niveles: readonly Nivel[];
  perfiles: Array<{ rol: string; nombre: string; todo: boolean; areas: Areas | null; descripcion?: string }>;
}
