export type ID = string;

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Contrato CRUD generico (recursos no acotados a empresa). */
export interface CrudService<T = unknown> {
  list(params?: Record<string, unknown>): Promise<Paginated<T>>;
  getById(id: ID, params?: Record<string, unknown>): Promise<T>;
  create(data: Record<string, unknown>): Promise<T>;
  update(id: ID, data: Record<string, unknown>): Promise<T>;
  remove(id: ID): Promise<void>;
}

/**
 * Contrato CRUD para recursos ACOTADOS a una empresa: reciben el companyId como
 * primer argumento para resolver la instancia FacturaScripts correspondiente.
 */
export interface CompanyScopedService<T = unknown> {
  list(companyId: ID, params?: Record<string, unknown>): Promise<Paginated<T>>;
  getById(companyId: ID, id: ID, params?: Record<string, unknown>): Promise<T>;
  create(companyId: ID, data: Record<string, unknown>): Promise<T>;
  update(companyId: ID, id: ID, data: Record<string, unknown>): Promise<T>;
  remove(companyId: ID, id: ID): Promise<void>;
}
