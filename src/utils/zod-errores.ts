import type { ZodError } from 'zod';
import { badRequest, HttpError } from './http-errors';

/**
 * Convierte el primer fallo de una validación Zod en un 400 con el campo
 * (details.campo), que es lo que la pantalla usa para señalar el error
 * (campoDelError). `mensajes` da el texto claro de cada campo; un campo que no
 * se conoce (cuerpo con datos de más) dice cuál sobra.
 */
export function errorDeValidacion(error: ZodError, mensajes: Record<string, string>): HttpError {
  const issue = error.issues[0];
  if (issue?.code === 'unrecognized_keys') {
    const sobra = issue.keys[0];
    return badRequest(`El dato "${sobra}" no se puede cambiar aquí.`, { campo: sobra });
  }
  const campo = issue ? String(issue.path[0] ?? '') : '';
  return badRequest(mensajes[campo] ?? 'Los datos no son válidos.', campo ? { campo } : undefined);
}
