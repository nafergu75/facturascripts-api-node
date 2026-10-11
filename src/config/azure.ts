/**
 * Configuracion de Azure Document Intelligence (lector de facturas).
 *
 * Va fuera de envSchema, como leerCarmen: una errata en estas variables no debe
 * tumbar la API. Si algo no vale, se avisa en el log (sin el valor) y el lector
 * pasa a Claude.
 *
 * Se lee en cada llamada (no al cargar el modulo): asi los tests pueden cambiar
 * las variables y en Vercel basta con redesplegar.
 */
import { logger } from './logger';

export interface ConfigAzure {
  /** https://<recurso>.cognitiveservices.azure.com, sin la barra final. */
  endpoint: string;
  /** Nunca se registra en el log ni aparece en un mensaje de error. */
  clave: string;
}

/** auto: Azure si esta configurado; claude: interruptor de emergencia que fuerza el respaldo. */
export type ModoLector = 'auto' | 'claude';

const HOSTS_VALIDOS = /\.(cognitiveservices\.azure\.com|api\.cognitive\.microsoft\.com)$/i;

/** Endpoint y clave de Azure, o null si no estan o el endpoint no es valido. */
export function leerAzure(fuente: NodeJS.ProcessEnv = process.env): ConfigAzure | null {
  const endpointBruto = (fuente.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT ?? '').trim();
  const clave = (fuente.AZURE_DOCUMENT_INTELLIGENCE_KEY ?? '').trim();
  if (!endpointBruto || !clave) return null;

  let url: URL;
  try {
    url = new URL(endpointBruto);
  } catch {
    logger.warn('AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT no es una URL valida: el lector usa Claude.');
    return null;
  }
  // Solo https y un host de Azure: la clave no debe viajar a ningun otro sitio.
  if (url.protocol !== 'https:' || !HOSTS_VALIDOS.test(url.hostname) || url.search || url.hash || url.username || url.password) {
    logger.warn('AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT no es un endpoint de Azure (https://<recurso>.cognitiveservices.azure.com): el lector usa Claude.');
    return null;
  }
  const endpoint = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  return { endpoint, clave };
}

/** OCR_LECTOR: 'auto' (por defecto) o 'claude'. Otro valor: 'auto' con un aviso. */
export function modoLector(fuente: NodeJS.ProcessEnv = process.env): ModoLector {
  const v = (fuente.OCR_LECTOR ?? '').trim().toLowerCase();
  if (v === 'claude') return 'claude';
  if (v && v !== 'auto') logger.warn("OCR_LECTOR no vale 'auto' ni 'claude': se usa 'auto'.");
  return 'auto';
}

/** Lo que muestra /health: solo si existe, nunca los valores. */
export function estadoOcr(fuente: NodeJS.ProcessEnv = process.env): { azureConfigurado: boolean; lector: ModoLector } {
  return { azureConfigurado: leerAzure(fuente) !== null, lector: modoLector(fuente) };
}
