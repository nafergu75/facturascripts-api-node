/**
 * Respaldo con Claude con vision: la lectura de hoy de cada lector, adaptada a
 * la interfaz comun.
 *
 *  - Gastos: leerDocumentoConClaude de gastos-extractor.service.
 *  - Ventas: leerDocumentoConClaude de invoice-extractor.service.
 *
 * No se cambia su logica: solo se convierte su resultado a LecturaNormalizada
 * (fuente 'claude', confianza null) y se conserva la confianza heuristica de
 * hoy como confianza de la lectura. Aqui no se lee el QR: haria falta una
 * libreria de QR (instalar un paquete, pendiente P4).
 */
import { normalizarAnthropicKey } from '../../config/env';
import { logger } from '../../config/logger';
import { esFechaReal } from '../../schemas/factura-gasto.schemas';
import { redondear2 } from '../../utils/money';
import {
  _construirGastoExtraido,
  clasificarDocumentoGasto,
  leerDocumentoConClaude as leerGastoConClaude,
  type LecturaClaude as LecturaClaudeGasto,
} from '../gastos-extractor.service';
import { construirExtraccion, leerDocumentoConClaude as leerVentaConClaude, type LecturaClaude as LecturaClaudeVenta } from '../invoice-extractor.service';
import { nifLeido } from './azure-factura.mapper';
import { lecturaVacia, type ArchivoLectura, type ArranqueLectura, type Campo, type ContextoLectura, type ExtractorFacturas, type Lector, type LecturaNormalizada, type TipoDocumentoLeido } from './tipos';

const MIME_ADMITIDOS = /^(application\/pdf|image\/(jpeg|png|webp|gif))$/i;

const deClaude = <T>(valor: T | null | undefined): Campo<T> => ({ valor: valor ?? null, confianza: null, fuente: 'claude' });
const calculado = <T>(valor: T | null): Campo<T> => ({ valor, confianza: null, fuente: 'calculado' });
const fechaValida = (f: string | null | undefined) => (f && esFechaReal(f) ? f : null);

/** Lectura de gastos de hoy -> LecturaNormalizada. */
export function normalizarGastoClaude(g: LecturaClaudeGasto): LecturaNormalizada {
  const l = lecturaVacia('claude');
  l.emisor.nombre = deClaude(g.proveedor);
  l.emisor.nif = deClaude(nifLeido(g.nif_proveedor));
  l.numero = deClaude(g.numero);
  l.fechaEmision = deClaude(fechaValida(g.fecha));
  l.concepto = deClaude(g.concepto);
  l.moneda = g.moneda ? deClaude(g.moneda.toUpperCase()) : calculado('EUR');

  const tipoDoc = clasificarDocumentoGasto(g);
  const crudo = (g.tipo_documento ?? '').toLowerCase();
  const tipo: TipoDocumentoLeido = tipoDoc !== 'factura' ? tipoDoc : crudo === 'ticket' || crudo === 'recibo' ? crudo : 'factura';
  l.tipoDocumento = deClaude(tipo);

  const base = g.base;
  // Igual que hoy (aplicarFallbacksHeuristicos): sin IVA leido, total - base.
  const iva = g.iva_cantidad ?? (base !== null && g.total !== null && !g.retencion_cantidad ? redondear2(g.total - base) : null);
  if (base !== null) {
    const tipoIva = g.iva_porcentaje ?? (base && iva !== null ? Math.round((iva / base) * 100) : 0);
    l.desglose = [{ tipoIva, base: deClaude(redondear2(base)), cuota: deClaude(iva !== null ? redondear2(iva) : redondear2((base * tipoIva) / 100)), tipoRecargo: null, cuotaRecargo: null }];
  }
  const pct = g.retencion_porcentaje ?? null;
  const ret = g.retencion_cantidad ?? (pct && base ? redondear2((base * pct) / 100) : null);
  if (ret) {
    l.retencion = { tipo: deClaude(pct ?? (base ? Math.round((ret / base) * 100) : null)), importe: deClaude(redondear2(ret)) };
    l.totales.retencion = deClaude(redondear2(ret));
  }
  l.totales.base = deClaude(base !== null ? redondear2(base) : null);
  l.totales.cuotaIva = deClaude(iva !== null ? redondear2(iva) : null);
  l.totales.totalAPagar = deClaude(g.total !== null ? redondear2(g.total) : null);
  l.totales.totalFactura = calculado(base !== null ? redondear2(base + (iva ?? 0)) : null);
  return l;
}

const TIPO_VENTA: Record<string, TipoDocumentoLeido> = { factura: 'factura', factura_simplificada: 'simplificada', ticket: 'ticket', recibo: 'recibo', albaran: 'otro', otro: 'otro' };

/**
 * Lectura de ventas de hoy -> LecturaNormalizada. Este lector no lee la
 * moneda: se supone la de la contabilidad (antes siempre EUR, y V17 bloqueaba
 * las ventas de las empresas que llevan sus cuentas en USD).
 */
export function normalizarVentaClaude(v: LecturaClaudeVenta, monedaCuenta = 'EUR'): LecturaNormalizada {
  const l = lecturaVacia('claude');
  l.tipoDocumento = deClaude(TIPO_VENTA[v.doc_kind ?? 'factura'] ?? 'factura');
  l.emisor.nombre = deClaude(v.vendor_name);
  l.emisor.nif = deClaude(nifLeido(v.vendor_tax_id));
  l.emisor.direccion = deClaude(v.vendor_address ? { calle: v.vendor_address } : null);
  l.receptor.nombre = deClaude(v.customer_name);
  l.receptor.nif = deClaude(nifLeido(v.customer_tax_id));
  l.numero = deClaude([v.series, v.number].filter(Boolean).join('-') || null);
  l.fechaEmision = deClaude(fechaValida(v.issue_date));
  l.fechaVencimiento = deClaude(fechaValida(v.due_date));
  l.moneda = calculado(monedaCuenta);
  l.concepto = deClaude(v.description);
  l.iban = deClaude(v.iban ? v.iban.replace(/\s+/g, '').toUpperCase() : null);
  l.desglose = v.base_amounts.map((b) => ({ tipoIva: b.vat_rate, base: deClaude(redondear2(b.base)), cuota: deClaude(redondear2(b.vat_amount)), tipoRecargo: null, cuotaRecargo: null }));
  const bases = redondear2(v.base_amounts.reduce((s, b) => s + b.base, 0));
  const iva = redondear2(v.base_amounts.reduce((s, b) => s + b.vat_amount, 0));
  if (v.retention_amount) {
    l.retencion = { tipo: deClaude(v.retention_rate), importe: deClaude(redondear2(v.retention_amount)) };
    l.totales.retencion = deClaude(redondear2(v.retention_amount));
  }
  l.totales.base = calculado(v.base_amounts.length ? bases : null);
  l.totales.cuotaIva = calculado(v.base_amounts.length ? iva : null);
  l.totales.totalFactura = calculado(v.base_amounts.length ? redondear2(bases + iva) : null);
  l.totales.totalAPagar = deClaude(v.total !== null ? redondear2(v.total) : null);
  return l;
}

/** Hay una clave de Anthropic valida en el servidor (la misma regla que config.anthropicApiKey). */
export const claudeConfigurado = (): boolean => !!normalizarAnthropicKey(process.env.ANTHROPIC_API_KEY);

export function claudeVisionExtractor(lector: Lector): ExtractorFacturas {
  return {
    id: 'claude',
    configurado: claudeConfigurado,
    admite: (mime) => MIME_ADMITIDOS.test(mime),
    async iniciar(archivo: ArchivoLectura, ctx?: ContextoLectura): Promise<ArranqueLectura> {
      if (!claudeConfigurado()) return { tipo: 'fallo', codigo: 'CLAUDE_SIN_CLAVE', reintentable: false };
      try {
        if (lector === 'GASTO') {
          const g = await leerGastoConClaude(archivo.buffer, archivo.mime);
          return { tipo: 'hecho', lectura: normalizarGastoClaude(g), texto: null, qr: null, confianzaLector: _construirGastoExtraido(g).confianza };
        }
        const v = await leerVentaConClaude(archivo.buffer, archivo.mime);
        return { tipo: 'hecho', lectura: normalizarVentaClaude(v, ctx?.monedaCuenta), texto: null, qr: null, confianzaLector: construirExtraccion(v).confidence };
      } catch (err) {
        // El texto del error puede llevar datos del documento: solo el estado.
        logger.warn('[ocr-claude] La lectura con Claude ha fallado', { lector, http: (err as { statusCode?: number }).statusCode ?? null });
        return { tipo: 'fallo', codigo: 'CLAUDE_ERROR', reintentable: false };
      }
    },
  };
}
