import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import { prisma } from '../config/database';
import { AssistantEngine } from '../services/chatbot/assistant-engine';

const engine = new AssistantEngine();

function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

export const chatAssistantController = {
  // POST /companies/:companyId/chat-assistant
  chat: asyncHandler(async (req, res) => {
    const { message, sessionId, currentPage } = req.body as {
      message?: string;
      sessionId?: string;
      currentPage?: string;
    };

    if (!message || !message.trim()) {
      throw badRequest('El campo "message" es obligatorio.');
    }

    const result = await engine.chat(message.trim(), {
      userId: req.user!.userId,
      companyId: req.companyId!,
      sessionId: sessionId && sessionId.trim() ? sessionId.trim() : generateSessionId(),
      currentPage,
    });

    sendOk(res, result);
  }),

  // GET /companies/:companyId/chat-assistant/:sessionId/messages
  getHistory: asyncHandler(async (req, res) => {
    const { sessionId } = req.params;

    const messages = await prisma.chatMessage.findMany({
      where: { sessionId, companyId: req.companyId! },
      orderBy: { createdAt: 'asc' },
    });

    sendOk(res, { sessionId, messages });
  }),
};
