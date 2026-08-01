import { CompanyScopedService, Paginated } from '../domain/common.types';
import { Asiento } from '../domain/asiento.model';
import { notImplemented } from '../utils/http-errors';

// Skeleton: cubrira asientos, libro diario y balances en iteraciones posteriores.
export const contabilidadService: CompanyScopedService<Asiento> = {
  async list(): Promise<Paginated<Asiento>> {
    throw notImplemented('Listado directo de asientos: pendiente (usar /cuentas-anuales/libro-diario).');
  },
  async getById(): Promise<Asiento> {
    throw notImplemented('Detalle de asiento: pendiente.');
  },
  async create(): Promise<Asiento> {
    throw notImplemented('Alta directa de asiento: pendiente (usar /facturas/:id/contabilizar).');
  },
  async update(): Promise<Asiento> {
    throw notImplemented('Edicion de asiento: pendiente.');
  },
  async remove(): Promise<void> {
    throw notImplemented('Baja de asiento: pendiente.');
  },
};
