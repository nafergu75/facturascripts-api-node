import Anthropic from '@anthropic-ai/sdk';
import { Prisma } from '@prisma/client';
import { config } from '../../config/env';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { RAGRetriever } from './rag-retriever';
import { CARMEN_SYSTEM_PROMPT } from './system-prompt';
import { ChatOptions, ChatResult, ChatSource, ConversationMessage, DocumentChunk } from './types';

const MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 2048;
const MAX_HISTORY_MESSAGES = 10;
const SNIPPET_LENGTH = 200;

/**
 * Orquesta una respuesta de Carmen: recupera contexto (RAG), historial de
 * conversacion, llama a Claude (si hay ANTHROPIC_API_KEY) y persiste mensajes.
 *
 * Sin ANTHROPIC_API_KEY configurada, opera en "modo degradado": devuelve la
 * documentacion recuperada directamente, sin pasar por el LLM.
 */
export class AssistantEngine {
  private client: Anthropic | null;
  private ragRetriever: RAGRetriever;

  constructor() {
    this.client = config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey }) : null;
    this.ragRetriever = new RAGRetriever();
  }

  async chat(message: string, options: ChatOptions): Promise<ChatResult> {
    const chunks = this.ragRetriever.retrieve(message, 5, { tags: this.extractTopicsFromQuery(message) });
    const context = this.buildContext(chunks);

    await this.ensureSession(options.sessionId, options.companyId, options.userId);
    const history = await this.getConversationHistory(options.sessionId);

    let assistantMessage: string;
    if (this.client) {
      try {
        assistantMessage = await this.askClaude(message, context, history, options.currentPage);
      } catch (error) {
        logger.error('carmen: error llamando a Claude API', error);
        assistantMessage = `⚠️ No he podido conectar con el motor de IA en este momento. Aquí tienes la documentación más relevante que encontré:\n\n${this.buildFallbackResponse(chunks)}`;
      }
    } else {
      assistantMessage = this.buildFallbackResponse(chunks);
    }

    const sources = this.buildSources(chunks);
    const suggestions = this.generateSuggestions(chunks);

    await this.saveMessage(options, 'user', message);
    await this.saveMessage(options, 'assistant', assistantMessage, sources);

    return { response: assistantMessage, sources, suggestions, sessionId: options.sessionId };
  }

  private async askClaude(
    message: string,
    context: string,
    history: ConversationMessage[],
    currentPage?: string,
  ): Promise<string> {
    const systemPrompt = this.adjustSystemPrompt(currentPage);

    const messages: Anthropic.MessageParam[] = [
      ...history.map((m): Anthropic.MessageParam => ({ role: m.role, content: m.content })),
      {
        role: 'user',
        content: `CONTEXTO DE LA BASE DE CONOCIMIENTO (documentación interna):\n${context}\n\nPREGUNTA DEL USUARIO:\n${message}`,
      },
    ];

    const response = await this.client!.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      thinking: { type: 'adaptive' },
      messages,
    });

    const textBlock = response.content.find((block): block is Anthropic.TextBlock => block.type === 'text');
    return textBlock?.text ?? 'No he podido generar una respuesta. Inténtalo de nuevo.';
  }

  private async ensureSession(sessionId: string, companyId: string, userId: string): Promise<void> {
    await prisma.chatSession.upsert({
      where: { id: sessionId },
      update: {},
      create: { id: sessionId, companyId, userId },
    });
  }

  private async getConversationHistory(sessionId: string): Promise<ConversationMessage[]> {
    const rows = await prisma.chatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
      take: MAX_HISTORY_MESSAGES,
    });

    return rows.reverse().map((row) => ({
      role: row.role === 'assistant' ? 'assistant' : 'user',
      content: row.content,
    }));
  }

  private async saveMessage(
    options: ChatOptions,
    role: 'user' | 'assistant',
    content: string,
    sources?: ChatSource[],
  ): Promise<void> {
    await prisma.chatMessage.create({
      data: {
        sessionId: options.sessionId,
        companyId: options.companyId,
        userId: options.userId,
        role,
        content,
        sources: sources && sources.length > 0 ? (sources as unknown as Prisma.InputJsonValue) : undefined,
      },
    });
  }

  private buildContext(chunks: DocumentChunk[]): string {
    if (chunks.length === 0) {
      return 'No se encontró documentación específica para esta pregunta.';
    }
    return chunks.map((c) => `[DOCUMENTO: ${c.source} / ${c.section}]\n${c.content}`).join('\n\n---\n\n');
  }

  private buildFallbackResponse(chunks: DocumentChunk[]): string {
    if (chunks.length === 0) {
      return (
        '⚠️ Carmen aún no tiene a Claude configurado (falta `ANTHROPIC_API_KEY` en el `.env`) ' +
        'y no encontré documentación relacionada con tu pregunta.'
      );
    }

    const docs = chunks
      .map((c) => `### ${c.section} (${c.source})\n${c.content}`)
      .join('\n\n---\n\n');

    return (
      '⚠️ Carmen aún no tiene a Claude configurado (falta `ANTHROPIC_API_KEY` en el `.env`), ' +
      `así que te muestro directamente la documentación relacionada:\n\n${docs}`
    );
  }

  private buildSources(chunks: DocumentChunk[]): ChatSource[] {
    return chunks.map((c) => ({
      title: c.section,
      snippet: c.content.length > SNIPPET_LENGTH ? `${c.content.slice(0, SNIPPET_LENGTH)}...` : c.content,
      source: c.source,
    }));
  }

  private extractTopicsFromQuery(query: string): string[] {
    const q = query.toLowerCase();
    const topics: string[] = [];
    if (q.includes('asiento') || q.includes('pendiente')) topics.push('asientos');
    if (q.includes('iva') || q.includes('libro')) topics.push('iva');
    if (q.includes('irpf') || q.includes('retención') || q.includes('retencion')) topics.push('irpf');
    if (q.includes('factura') || q.includes('confirmar')) topics.push('facturas');
    if (q.includes('balance')) topics.push('balance');
    return topics;
  }

  private adjustSystemPrompt(currentPage?: string): string {
    if (!currentPage) return CARMEN_SYSTEM_PROMPT;

    const page = currentPage.toLowerCase();
    if (page.includes('asiento') || page.includes('journal')) {
      return `${CARMEN_SYSTEM_PROMPT}\n\nNOTA DE CONTEXTO: el usuario está actualmente en la sección de Asientos. Prioriza explicaciones y pasos relacionados con asientos contables.`;
    }
    if (page.includes('reporte') || page.includes('report')) {
      return `${CARMEN_SYSTEM_PROMPT}\n\nNOTA DE CONTEXTO: el usuario está actualmente en la sección de Reportes. Ayúdale a interpretar balances, PyG y libros.`;
    }
    if (page.includes('impuesto') || page.includes('tax')) {
      return `${CARMEN_SYSTEM_PROMPT}\n\nNOTA DE CONTEXTO: el usuario está actualmente en la sección de Impuestos. Enfatiza IVA, IRPF y modelos AEAT.`;
    }
    return CARMEN_SYSTEM_PROMPT;
  }

  private generateSuggestions(chunks: DocumentChunk[]): string[] {
    const topics = new Set<string>();
    chunks.forEach((c) => c.metadata.relatedTopics.forEach((t) => topics.add(t)));
    return [...topics].slice(0, 3).map((t) => `¿Cómo funciona ${t}?`);
  }
}
