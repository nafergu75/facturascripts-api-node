import { ChatResponse } from './types';

/**
 * Cliente REST del asistente "Carmen":
 *   POST /companies/:id/chat-assistant
 *   GET  /companies/:id/chat-assistant/:sessionId/messages
 */
export class ChatAssistantApi {
  constructor(
    private readonly baseUrl: string,
    private readonly companyId: string,
    private readonly token: string,
  ) {}

  private url(path: string): string {
    return `${this.baseUrl}/companies/${this.companyId}/chat-assistant${path}`;
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(this.url(path), {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
    return body.data as T;
  }

  enviarMensaje(message: string, sessionId?: string, currentPage?: string): Promise<ChatResponse> {
    return this.json('', { method: 'POST', body: JSON.stringify({ message, sessionId, currentPage }) });
  }
}
