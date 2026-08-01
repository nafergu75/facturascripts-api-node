import { Response } from 'express';

export interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  meta?: Record<string, unknown>;
  message?: string;
}

export function sendOk<T>(
  res: Response,
  data: T,
  meta?: Record<string, unknown>,
  status = 200,
): Response {
  const body: ApiEnvelope<T> = { ok: true, data, ...(meta ? { meta } : {}) };
  return res.status(status).json(body);
}

export function sendMessage(res: Response, message: string, status = 200): Response {
  return res.status(status).json({ ok: true, message });
}
