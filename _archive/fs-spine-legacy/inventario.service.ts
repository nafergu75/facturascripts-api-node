import { CompanyScopedService, Paginated } from '../domain/common.types';
import { notImplemented } from '../utils/http-errors';

// Inventario/stock. Tipo generico por ahora; se concretara al mapear FacturaScripts.
export const inventarioService: CompanyScopedService<Record<string, unknown>> = {
  async list(): Promise<Paginated<Record<string, unknown>>> {
    throw notImplemented('Listado de inventario: pendiente (mapear recurso FS stocks).');
  },
  async getById(): Promise<Record<string, unknown>> {
    throw notImplemented('Detalle de inventario: pendiente.');
  },
  async create(): Promise<Record<string, unknown>> {
    throw notImplemented('Alta de inventario: pendiente.');
  },
  async update(): Promise<Record<string, unknown>> {
    throw notImplemented('Edicion de inventario: pendiente.');
  },
  async remove(): Promise<void> {
    throw notImplemented('Baja de inventario: pendiente.');
  },
};
