/**
 * Azure Document Intelligence como ExtractorFacturas: el cliente REST
 * (azure-di.client) mas el mapeo de prebuilt-invoice (azure-factura.mapper).
 * Es asincrono: iniciar devuelve 'pendiente' y cada consultar hace UNA
 * llamada a Azure, sin esperar dentro.
 */
import { leerAzure, modoLector } from '../../config/azure';
import { analizar, borrarResultado, consultarResultado } from './azure-di.client';
import { mapearFacturaAzure } from './azure-factura.mapper';
import type { ArchivoLectura, ArranqueLectura, ConsultaLectura, ContextoLectura, ExtractorFacturas } from './tipos';

/** Formatos que lee Azure y que admite la app (WEBP no lo lee Azure: va a Claude). */
const MIME_AZURE = /^(application\/pdf|image\/(jpeg|png|bmp|tiff|heif))$/i;

export const azureExtractor: ExtractorFacturas = {
  id: 'azure',
  configurado: () => modoLector() === 'auto' && leerAzure() !== null,
  admite: (mime) => MIME_AZURE.test(mime),

  async iniciar(archivo: ArchivoLectura, ctx: ContextoLectura): Promise<ArranqueLectura> {
    const cfg = leerAzure();
    if (!cfg) return { tipo: 'fallo', codigo: 'AZURE_PETICION', reintentable: false };
    const r = await analizar(cfg, archivo.buffer, { locale: ctx.empresaEspanola ? 'es-ES' : undefined });
    if (r.tipo === 'aceptado') return { tipo: 'pendiente', ref: { resultId: r.resultId }, reintentarEnMs: r.retryAfterS * 1000 };
    return { tipo: 'fallo', codigo: r.codigo, reintentable: r.reintentable };
  },

  async consultar(ref: { resultId: string }, ctx: ContextoLectura): Promise<ConsultaLectura> {
    const cfg = leerAzure();
    if (!cfg) return { tipo: 'fallo', codigo: 'AZURE_PETICION', reintentable: false };
    const r = await consultarResultado(cfg, ref.resultId);
    if (r.tipo === 'pendiente') return { tipo: 'pendiente', reintentarEnMs: r.retryAfterS !== null ? r.retryAfterS * 1000 : null };
    if (r.tipo === 'fallo') return { tipo: 'fallo', codigo: r.codigo, reintentable: r.reintentable };
    return mapearFacturaAzure(r.analyzeResult, { paginasArchivo: ctx.paginasArchivo ?? null });
  },

  async limpiar(ref: { resultId: string }): Promise<void> {
    const cfg = leerAzure();
    if (cfg) await borrarResultado(cfg, ref.resultId);
  },
};
