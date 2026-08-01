export interface EmpresaAdmin {
  id: string;
  codigo?: string | null;
  nombre: string;
  fsBaseUrl: string;
  activa: boolean;
  creadoEn?: string;
}

export interface UsuarioAdmin {
  id: string;
  email: string;
  activo: boolean;
  esAdminGlobal: boolean;
  creadoEn?: string;
}
