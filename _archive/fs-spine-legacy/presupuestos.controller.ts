import { presupuestosService } from '../services/presupuestos.service';
import { makeScopedController } from './scoped-crud.controller';

export const presupuestosController = makeScopedController(presupuestosService, 'Presupuesto eliminado');
