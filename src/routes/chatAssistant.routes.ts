import { Router } from 'express';
import { chatAssistantController } from '../controllers/chatAssistant.controller';
import { authorize } from '../middleware/authorize.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';

const router = Router({ mergeParams: true });

// Freno barato en memoria (OWASP API4). El tope que cuenta es el de la BD
// (mensajes por usuario y día, y preguntas a la IA): ver presupuesto.service.
const chatLimit = rateLimit({ ventanaMs: 60_000, max: 20 });

// Sin authorize: Carmen comprueba el permiso de cada intención, y las
// conversaciones siempre se filtran por empresa y usuario (solo las propias).
router.post('/', chatLimit, chatAssistantController.chat);
router.get('/estado', chatAssistantController.estado);
router.get('/catalogo', chatAssistantController.catalogo);
router.get('/sesiones', chatAssistantController.sesiones);
router.post('/mensajes/:id/valoracion', chatAssistantController.valorar);

// Ajustes y uso de la IA: solo el administrador de la empresa (o el global).
router.get('/ajustes', authorize('admin:empresa'), chatAssistantController.getAjustes);
router.put('/ajustes', authorize('admin:empresa'), chatAssistantController.putAjustes);
router.get('/uso', authorize('admin:empresa'), chatAssistantController.uso);

router.get('/:sessionId/messages', chatAssistantController.getHistory);
router.delete('/:sessionId', chatAssistantController.borrar);

export default router;
