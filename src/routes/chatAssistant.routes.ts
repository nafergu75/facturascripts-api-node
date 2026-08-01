import { Router } from 'express';
import { chatAssistantController } from '../controllers/chatAssistant.controller';
import { rateLimit } from '../middleware/rate-limit.middleware';

const router = Router({ mergeParams: true });

// El chat consume LLM/recursos: limite mas estricto que el global (OWASP API4).
const chatLimit = rateLimit({ ventanaMs: 60_000, max: 20 });

router.post('/', chatLimit, chatAssistantController.chat);
router.get('/:sessionId/messages', chatAssistantController.getHistory);

export default router;
