import { pedidosService } from '../services/pedidos.service';
import { makeScopedController } from './scoped-crud.controller';

export const pedidosController = makeScopedController(pedidosService, 'Pedido eliminado');
