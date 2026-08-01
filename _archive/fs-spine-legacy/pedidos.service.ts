import { createSalesDocumentService } from './sales-document.service';

// Pedidos de cliente -> recurso FacturaScripts: pedidoclientes
export const pedidosService = createSalesDocumentService('pedidoclientes');
