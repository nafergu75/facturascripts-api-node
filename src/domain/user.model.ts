export type Role = 'admin' | 'contable' | 'ventas' | 'solo_lectura';

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  isActive: boolean;
  /** Ids de las empresas a las que el usuario tiene acceso. */
  companies: string[];
  createdAt: string;
}
