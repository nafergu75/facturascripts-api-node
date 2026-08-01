import { albaranesService } from '../services/albaranes.service';
import { makeScopedController } from './scoped-crud.controller';

export const albaranesController = makeScopedController(albaranesService, 'Albaran eliminado');
