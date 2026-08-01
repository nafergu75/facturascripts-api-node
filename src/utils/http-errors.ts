export class HttpError extends Error {
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.details = details;
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, HttpError);
    }
  }
}

export const badRequest = (m = 'Bad Request', d?: unknown) => new HttpError(400, m, d);
export const unauthorized = (m = 'Unauthorized', d?: unknown) => new HttpError(401, m, d);
export const forbidden = (m = 'Forbidden', d?: unknown) => new HttpError(403, m, d);
export const notFound = (m = 'Not Found', d?: unknown) => new HttpError(404, m, d);
export const conflict = (m = 'Conflict', d?: unknown) => new HttpError(409, m, d);
export const notImplemented = (m = 'Not Implemented', d?: unknown) => new HttpError(501, m, d);
export const internalError = (m = 'Internal Server Error', d?: unknown) => new HttpError(500, m, d);

/** Error especifico al hablar con la API de FacturaScripts. */
export class FacturaScriptsError extends HttpError {
  constructor(statusCode: number, message: string, details?: unknown) {
    super(statusCode, message, details);
    this.name = 'FacturaScriptsError';
  }
}
