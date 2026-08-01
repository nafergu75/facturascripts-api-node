/**
 * Cliente HTTP wrapper - Manejo de autenticación y errores
 */

import { APIErrorResponse } from '../api/types';

// La API no usa prefijo /api: las rutas se montan en /companies/:companyId/...
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';

interface RequestOptions extends RequestInit {
  params?: Record<string, string | number | boolean | undefined>;
}

/**
 * Obtener JWT token del almacenamiento local
 */
function getAuthToken(): string | null {
  return localStorage.getItem('jwt_token');
}

/**
 * Construir URL con query parameters
 */
function buildUrl(endpoint: string, params?: Record<string, any>): string {
  const url = new URL(`${API_BASE_URL}${endpoint}`);

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.append(key, String(value));
      }
    });
  }

  return url.toString();
}

/**
 * Hacer request HTTP con manejo de errores
 */
export async function httpRequest<T = any>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<T> {
  const token = getAuthToken();
  const { params, ...fetchOptions } = options;

  const url = buildUrl(endpoint, params);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(fetchOptions.headers as Record<string, string> || {})
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      headers
    });

    // Intentar parsear JSON si está disponible
    let data: any;
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      data = await response.json();
    }

    if (!response.ok) {
      const error: APIErrorResponse = {
        statusCode: response.status,
        message: data?.message || response.statusText,
        details: data?.details || data
      };

      // Manejo especial para 401 (token expirado)
      if (response.status === 401) {
        localStorage.removeItem('jwt_token');
        window.location.href = '/login';
      }

      throw error;
    }

    // Si la respuesta es un objeto con 'data', extraerla
    return data?.data || data || {};
  } catch (error) {
    // Si es un error de API, relanzarlo
    if (error instanceof Error && 'statusCode' in error) {
      throw error;
    }

    // Errores de red u otros
    throw {
      statusCode: 0,
      message: error instanceof Error ? error.message : 'Error desconocido'
    } as APIErrorResponse;
  }
}

/**
 * GET request
 */
export function httpGet<T = any>(
  endpoint: string,
  params?: Record<string, any>,
  options?: RequestInit
): Promise<T> {
  return httpRequest<T>(endpoint, {
    ...options,
    method: 'GET',
    params
  });
}

/**
 * POST request
 */
export function httpPost<T = any>(
  endpoint: string,
  body?: any,
  options?: RequestInit
): Promise<T> {
  return httpRequest<T>(endpoint, {
    ...options,
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined
  });
}

/**
 * PUT request
 */
export function httpPut<T = any>(
  endpoint: string,
  body?: any,
  options?: RequestInit
): Promise<T> {
  return httpRequest<T>(endpoint, {
    ...options,
    method: 'PUT',
    body: body ? JSON.stringify(body) : undefined
  });
}

/**
 * PATCH request
 */
export function httpPatch<T = any>(
  endpoint: string,
  body?: any,
  options?: RequestInit
): Promise<T> {
  return httpRequest<T>(endpoint, {
    ...options,
    method: 'PATCH',
    body: body ? JSON.stringify(body) : undefined
  });
}

/**
 * DELETE request
 */
export function httpDelete<T = any>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  return httpRequest<T>(endpoint, {
    ...options,
    method: 'DELETE'
  });
}
