/**
 * ============================================================================
 * EXTRACTOR CONTABLE DE FACTURAS (invoice-extractor)
 * ============================================================================
 *
 * Endpoint central de extracción contable con IA: recibe un PDF/imagen de
 * factura, lo lee con Claude vision y devuelve un JSON estructurado únicamente
 * basado en el schema InvoiceExtraction:
 *  - Clasificación: tipo de documento (invoice/credit_note/ticket)
 *  - Dirección: income (venta) o expense (gasto)
 *  - Confianza: 0.0-1.0 (no etiquetas cualitativas)
 *  - Datos de vendor y customer (nombre, tax_id, dirección, país)
 *  - Desglose de IVA en bases array
 *  - Retenciones siempre en withholdings array con type, rate, amount
 *  - Validaciones robustas en validation.errors
 *  - Cálculos deterministas: total_net = subtotal + tax_total - withholding_total
 *
 * División de responsabilidades:
 *  - Claude SOLO lee el documento (números, fechas, NIFs, bases, retención).
 *  - Todo lo derivable se calcula AQUÍ de forma determinista.
 *    Así el resultado es reproducible y no depende de que el modelo "calcule".
 *
 * Persistencia: reutiliza la tabla IncomeReaderDocument con
 * sourceType 'EXTRACTOR_IA' y parsedData = InvoiceExtraction.
 * ============================================================================
 */
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID as uuid } from 'crypto';
import { prisma } from '../config/database';
import { config } from '../config/env';
import { putObject, getObject } from '../utils/storage';
import { badRequest, notFound } from '../utils/http-errors';

// ---------------------------------------------------------------------------
// Esquema de salida (contrato con los consumidores)
// ---------------------------------------------------------------------------

export interface InvoiceExtraction {
  document_type: 'invoice' | 'credit_note' | 'ticket';
  direction: 'income' | 'expense';
  confidence: number; // 0.0-1.0
  vendor: {
    name: string | null;
    tax_id: string | null;
    address: string | null;
    country: string;
  };
  customer: {
    name: string | null;
    tax_id: string | null;
    address: string | null;
    country: string;
  };
  invoice: {
    number: string | null;
    series: string | null;
    issue_date: string | null; // YYYY-MM-DD
    due_date: string | null; // YYYY-MM-DD
    original_number: string | null;
  };
  amounts: {
    currency: 'EUR';
    bases: Array<{
      tax_rate: number; // porcentaje, ej. 21.0
      base_amount: number;
      tax_amount: number;
    }>;
    withholdings: Array<{
      type: string; // "IRPF", etc.
      rate: number; // porcentaje, ej. 15.0
      amount: number;
    }>;
    subtotal: number; // suma de todas las bases
    tax_total: number; // suma de todos los tax_amount
    withholding_total: number; // suma de withholdings amounts
    total_gross: number; // subtotal + tax_total
    total_net: number; // total_gross - withholding_total
  };
  payment: {
    method: string | null; // "transfer", "cash", etc.
    terms: string | null; // "immediate", "30 days", etc.
    iban: string | null;
  };
  lines: Array<{
    description: string | null;
    quantity: number;
    unit_price: number;
    line_total: number;
    tax_rate: number;
  }>;
  raw_text: string | null; // OCR raw text (opcional, para debug)
  meta: {
    source_file_name: string | null;
    source_mime_type: string | null;
    pages: number;
  };
  validation: {
    checks: {
      total_matches_bases_and_taxes: boolean;
      tax_id_vendor_valid: boolean;
      tax_id_customer_valid: boolean;
      withholding_consistent: boolean;
    };
    errors: string[];
  };
}

// ---------------------------------------------------------------------------
// Lectura del documento con Claude vision (tool-calling forzado)
// ---------------------------------------------------------------------------

const OCR_MODEL = 'claude-opus-4-8';
const anthropicClient = config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey }) : null;
const MIME_IMAGEN = /^image\/(jpeg|png|gif|webp)$/i;

const PROMPT_EXTRACCION =
  'Eres un experto en contabilidad española para pymes y autónomos y en análisis de documentos contables ' +
  'digitalizados (facturas de venta, facturas de gasto, tickets, albaranes, recibos). Analiza el documento ' +
  'adjunto (puede venir de un escaneo con errores de OCR, incluso rotado 90°) y registra sus datos con la ' +
  'herramienta "registrar_extraccion_factura". ' +
  '\n\nReglas clave:\n' +
  '1. NÚMERO DE FACTURA: Busca etiquetas "Factura:", "Invoice:", "Nº", "FV", o números destacados (6-12 dígitos). ' +
  'Si está en encabezado o margen, extrae igualmente.\n' +
  '2. FECHA: Busca formatos españoles DD/MM/YYYY u otros formatos. Convierte a YYYY-MM-DD.\n' +
  '3. EMPRESA EMISORA (vendor): Busca "De:", "Empresa:", "Proveedor:", o nombre destacado en encabezado. ' +
  'IGNORA texto boilerplate (registro mercantil, legislación, condiciones, bancos, domicilios). Extrae forma ' +
  'societaria (S.L., S.A., SLU, etc.) si la hay.\n' +
  '4. NIF/CIF EMISOR: Busca patrones españoles (8 dígitos + letra, o letra + 7 dígitos + letra). ' +
  'Acepta con/sin guiones/espacios.\n' +
  '5. CLIENTE/RECEPTOR (customer): "A:", "Cliente:", "Facturado a:", o segundo nombre destacado.\n' +
  '6. IVA: Desglosa TODAS las bases imponibles y sus cuotas de IVA por tipo (21%, 10%, 4%, 0%).\n' +
  '7. RETENCIÓN (IRPF/otra): Si aparecen palabras clave (retención, IRPF, descuento practicado), extrae ' +
  'el porcentaje Y el importe. Crítica para contabilización.\n' +
  '8. TOTAL: El "total a pagar" (neto de retención si la hay).\n' +
  '\nFormatos: fechas YYYY-MM-DD; importes como números sin símbolo; NIF/CIF sin "ES" ' +
  'ni separadores. Si no aparece o es ilegible, OMITE (no inventes). ' +
  'Los tickets/facturas simplificadas sin cliente se marcan doc_kind "factura_simplificada" o "ticket".';

const HERRAMIENTA_EXTRACCION: Anthropic.Tool = {
  name: 'registrar_extraccion_factura',
  description: 'Registra los datos leídos del documento contable (los campos ausentes se omiten).',
  input_schema: {
    type: 'object',
    properties: {
      doc_kind: {
        type: 'string',
        enum: ['factura', 'factura_simplificada', 'ticket', 'albaran', 'recibo', 'otro'],
        description: 'Tipo de documento detectado',
      },
      number: { type: 'string', description: 'Número de factura (sin la serie si va aparte)' },
      series: { type: 'string', description: 'Serie de la factura, si existe (ej. "A", "2026")' },
      issue_date: { type: 'string', description: 'Fecha de emisión, YYYY-MM-DD' },
      due_date: { type: 'string', description: 'Fecha de vencimiento, YYYY-MM-DD (opcional)' },
      vendor_name: { type: 'string', description: 'Razón social de quien EMITE la factura' },
      vendor_tax_id: { type: 'string', description: 'NIF/CIF del emisor, sin prefijo ES' },
      vendor_address: { type: 'string', description: 'Dirección del emisor (opcional)' },
      customer_name: { type: 'string', description: 'Razón social del receptor/cliente' },
      customer_tax_id: { type: 'string', description: 'NIF/CIF del receptor, sin prefijo ES' },
      customer_address: { type: 'string', description: 'Dirección del receptor (opcional)' },
      base_amounts: {
        type: 'array',
        description: 'Desglose completo de bases imponibles con su IVA',
        items: {
          type: 'object',
          properties: {
            base: { type: 'number', description: 'Base imponible' },
            vat_rate: { type: 'number', description: 'Tipo de IVA en % (21, 10, 4, 0...)' },
            vat_amount: { type: 'number', description: 'Cuota de IVA' },
          },
          required: ['base'],
        },
      },
      retention_type: { type: 'string', description: 'Tipo de retención (IRPF, etc.), si la hay' },
      retention_rate: { type: 'number', description: 'Porcentaje de retención si la factura la lleva, ej. 15' },
      retention_amount: { type: 'number', description: 'Importe de la retención si la factura la lleva' },
      total: { type: 'number', description: 'Importe total de la factura (el "total a pagar" que figura en el documento)' },
      payment_method: { type: 'string', description: 'Método de pago (transfer, cash, etc.)' },
      payment_terms: { type: 'string', description: 'Condiciones de pago (immediate, 30 days, etc.)' },
      iban: { type: 'string', description: 'IBAN si aparece en el documento' },
      description: { type: 'string', description: 'Descripción breve del concepto principal de la factura' },
    },
  },
};

const cadena = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const numero = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const limpiarNif = (v: unknown): string | null => {
  const s = cadena(v);
  return s ? s.toUpperCase().replace(/^ES/, '').replace(/[.\s-]/g, '') : null;
};
const redondear = (n: number): number => Math.round(n * 100) / 100;

/**
 * Valida un NIF/CIF español usando el algoritmo de letra de control.
 */
function validarNif(nif: string | null): boolean {
  if (!nif || nif.length < 8 || nif.length > 9) return false;
  const cleaned = nif.toUpperCase().replace(/[.\s-]/g, '');
  // Patrón: 8 dígitos + letra, o letra + 7 dígitos + letra
  if (!/^([0-9]{8}[A-Z]|[A-Z][0-9]{7}[A-Z0-9])$/i.test(cleaned)) return false;
  // Si es 8 dígitos + letra, validar con algoritmo
  if (/^[0-9]{8}[A-Z]$/.test(cleaned)) {
    const num = parseInt(cleaned.slice(0, 8), 10);
    const letra = cleaned.charAt(8);
    const letrasValidas = 'TRWAGMYFPDXBNJZSQVHLCKE';
    const letraCalculada = letrasValidas[num % 23];
    return letra === letraCalculada;
  }
  return true; // Letras iniciales (CIF) aceptadas sin validación adicional
}

/**
 * Heurísticas fallback para completar datos faltantes cuando Claude no los devuelve.
 * Se aplica POST-Claude para mejorar robustez sin romper la lectura IA.
 */
function aplicarFallbacksHeuristicos(lectura: LecturaClaude, textoExtraido: string): LecturaClaude {
  // Fallback 1: Número de factura - buscar 6-12 dígitos en contexto
  if (!lectura.number || lectura.number.trim() === '') {
    const m = textoExtraido.match(/(?:factura|invoice|f)\s*[#:\s]*(\d{6,12})/i);
    if (m) lectura.number = m[1];
    else {
      const m2 = textoExtraido.match(/\b(\d{6,12})\b/);
      if (m2) lectura.number = m2[1];
    }
  }

  // Fallback 2: Fecha - formatos españoles DD/MM/YYYY
  if (!lectura.issue_date || !lectura.issue_date.match(/^\d{4}-\d{2}-\d{2}$/)) {
    const fechas = textoExtraido.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g);
    if (fechas && fechas.length > 0) {
      const parts = fechas[0]!.split('/');
      if (parts.length === 3) {
        const [d, m, y] = parts;
        const year = parseInt(y!, 10);
        const month = parseInt(m!, 10);
        const day = parseInt(d!, 10);
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 2000 && year <= 2100) {
          lectura.issue_date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }
      }
    }
  }

  // Fallback 3: NIF/CIF (patrones españoles: formato 8 dígitos + letra OR letra + 7 dígitos + letra)
  if (!lectura.vendor_tax_id) {
    const nifs = textoExtraido.match(/\b([A-Z]\d{7}[A-Z0-9]|[0-9]{8}[A-Z])\b/gi);
    if (nifs && nifs.length > 0) {
      lectura.vendor_tax_id = nifs[0]!.toUpperCase();
    }
  }

  // Fallback 4: Nombre proveedor - líneas largas que no sean boilerplate
  if (!lectura.vendor_name || lectura.vendor_name.length < 5) {
    const lineas = textoExtraido.split('\n').filter((l) => l.length > 10 && l.length < 100 && l.trim() !== '');
    for (const l of lineas) {
      const cleaned = l.trim();
      if (
        !/^[\d\s,./()-]*$/.test(cleaned) &&
        !/precios|legisl|registro|inscrit|rogamos|condici|pago|banco|iban/i.test(cleaned) &&
        cleaned.length >= 8 &&
        !/^\d{1,2}\/\d{1,2}\/\d{4}/.test(cleaned)
      ) {
        lectura.vendor_name = cleaned;
        break;
      }
    }
  }

  // Fallback 5: Retención (IRPF, cuota de retención)
  if (!lectura.retention_amount || lectura.retention_amount === 0) {
    const retencionMatches = textoExtraido.match(
      /(?:retenci[óo]n|irpf|retenida?|descuento)\s*[:\s]*([0-9]+(?:[.,][0-9]{2})?)\s*(?:[€$]|eur)?/gi
    );
    if (retencionMatches && retencionMatches.length > 0) {
      const numMatch = retencionMatches[0].match(/([0-9]+(?:[.,][0-9]{2})?)/);
      if (numMatch) {
        lectura.retention_amount = parseFloat(numMatch[1].replace(',', '.'));
      }
    }
  }

  // Fallback 6: Tasa de retención (ej. "15%" IRPF)
  if (!lectura.retention_rate) {
    const tasasMatch = textoExtraido.match(/(\d{1,2})%\s*(?:retenci|irpf|retenida|practicada)/i);
    if (tasasMatch) {
      lectura.retention_rate = parseInt(tasasMatch[1], 10);
    }
  }

  return lectura;
}

interface LecturaClaude {
  doc_kind: string | null;
  number: string | null;
  series: string | null;
  issue_date: string | null;
  due_date: string | null;
  vendor_name: string | null;
  vendor_tax_id: string | null;
  vendor_address: string | null;
  customer_name: string | null;
  customer_tax_id: string | null;
  customer_address: string | null;
  base_amounts: Array<{ base: number; vat_rate: number; vat_amount: number }>;
  retention_type: string | null;
  retention_rate: number | null;
  retention_amount: number | null;
  total: number | null;
  payment_method: string | null;
  payment_terms: string | null;
  iban: string | null;
  description: string | null;
  raw_text: string | null;
}

async function leerDocumentoConClaude(buffer: Buffer, mimeType: string): Promise<LecturaClaude> {
  if (!anthropicClient) {
    throw badRequest('El extractor IA no está disponible: falta ANTHROPIC_API_KEY en el servidor.');
  }
  const esPdf = /pdf/i.test(mimeType);
  const esImagen = MIME_IMAGEN.test(mimeType);
  if (!esPdf && !esImagen) {
    throw badRequest(`Formato no soportado por el extractor IA: ${mimeType}. Usa PDF o imagen (JPG/PNG/WEBP/GIF).`);
  }

  const data = buffer.toString('base64');
  let response: Anthropic.Message | undefined;
  try {
    response = await anthropicClient!.messages.create({
      model: OCR_MODEL,
      max_tokens: 2048,
      thinking: { type: 'adaptive' },
      messages: [
        {
          role: 'user',
          content: [
            esPdf
              ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
              : { type: 'image', source: { type: 'base64', media_type: (mimeType.toLowerCase()) as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data } },
            { type: 'text', text: PROMPT_EXTRACCION },
          ],
        },
      ],
      tools: [HERRAMIENTA_EXTRACCION],
      tool_choice: { type: 'tool', name: 'registrar_extraccion_factura' },
    });
  } catch (err) {
    const e = err as { status?: number; error?: { error?: { message?: string } } };
    const detalle = e.error?.error?.message ?? (err instanceof Error ? err.message : String(err));
    if (/credit balance/i.test(detalle)) {
      throw badRequest('El extractor IA no tiene crédito en la API de Anthropic: recarga saldo en console.anthropic.com (Plans & Billing).');
    }
    if (e.status === 401) {
      throw badRequest('La ANTHROPIC_API_KEY configurada no es válida.');
    }
    throw badRequest(`Error del proveedor de IA al leer el documento: ${detalle}`);
  }

  const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  if (!toolUse) throw badRequest('El extractor IA no pudo leer el documento.');
  const input = toolUse.input as Record<string, unknown>;

  const basesIn = Array.isArray(input.base_amounts) ? input.base_amounts : [];
  const base_amounts = basesIn
    .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
    .map((b) => ({
      base: numero(b.base) ?? 0,
      vat_rate: numero(b.vat_rate) ?? 0,
      vat_amount: numero(b.vat_amount) ?? 0,
    }))
    .filter((b) => b.base > 0 || b.vat_amount > 0);

  return {
    doc_kind: cadena(input.doc_kind),
    number: cadena(input.number),
    series: cadena(input.series),
    issue_date: cadena(input.issue_date),
    due_date: cadena(input.due_date),
    vendor_name: cadena(input.vendor_name),
    vendor_tax_id: limpiarNif(input.vendor_tax_id),
    vendor_address: cadena(input.vendor_address),
    customer_name: cadena(input.customer_name),
    customer_tax_id: limpiarNif(input.customer_tax_id),
    customer_address: cadena(input.customer_address),
    base_amounts,
    retention_type: cadena(input.retention_type),
    retention_rate: numero(input.retention_rate),
    retention_amount: numero(input.retention_amount),
    total: numero(input.total),
    payment_method: cadena(input.payment_method),
    payment_terms: cadena(input.payment_terms),
    iban: cadena(input.iban),
    description: cadena(input.description),
    raw_text: null,
  };
}

// ---------------------------------------------------------------------------
// Post-procesado determinista: construcción del schema
// ---------------------------------------------------------------------------

/**
 * Determina si es income (venta) o expense (gasto) basándose en NIF empresa.
 */
function determinarDireccion(
  lectura: LecturaClaude,
  empresaNif: string | null,
  empresaNombre: string | null,
): { direction: 'income' | 'expense'; confidence: number } {
  const nifEmpresa = empresaNif ? empresaNif.toUpperCase().replace(/^ES/, '').replace(/[.\s-]/g, '') : null;

  // Si el vendor es la empresa → es una venta (income)
  if (nifEmpresa && lectura.vendor_tax_id === nifEmpresa) {
    return { direction: 'income', confidence: 0.95 };
  }
  // Si el customer es la empresa → es un gasto (expense)
  if (nifEmpresa && lectura.customer_tax_id === nifEmpresa) {
    return { direction: 'expense', confidence: 0.95 };
  }
  // Fallback: tickets/facturas simplificadas sin cliente → gasto
  if (lectura.doc_kind === 'ticket' || lectura.doc_kind === 'factura_simplificada') {
    return { direction: 'expense', confidence: 0.7 };
  }
  // Desconocido
  return { direction: 'expense', confidence: 0.3 };
}

export function construirExtraccion(
  lectura: LecturaClaude,
  opts: { empresaNif?: string | null; empresaNombre?: string | null } = {},
): InvoiceExtraction {
  const errores: string[] = [];
  let confidence = 0.8; // inicio optimista

  // 1) Determinar tipo de documento
  let document_type: 'invoice' | 'credit_note' | 'ticket' = 'invoice';
  if (lectura.doc_kind === 'ticket' || lectura.doc_kind === 'factura_simplificada') {
    document_type = 'ticket';
  }
  // TODO: Detectar credit notes si aparecen en el documento

  // 2) Dirección (income/expense)
  const { direction, confidence: dirConf } = determinarDireccion(lectura, opts.empresaNif ?? null, opts.empresaNombre ?? null);
  confidence = Math.min(confidence, dirConf);

  // 3) Bases y retenciones
  const subtotal = redondear(lectura.base_amounts.reduce((s, b) => s + b.base, 0));
  const tax_total = redondear(lectura.base_amounts.reduce((s, b) => s + b.vat_amount, 0));
  const withholdings: InvoiceExtraction['amounts']['withholdings'] = [];
  let withholding_total = 0;

  if (lectura.retention_amount !== null && lectura.retention_amount > 0) {
    const retAmount = redondear(lectura.retention_amount);
    withholdings.push({
      type: lectura.retention_type ?? 'IRPF',
      rate: lectura.retention_rate ?? 0,
      amount: retAmount,
    });
    withholding_total = redondear(withholding_total + retAmount);
  }

  const total_gross = redondear(subtotal + tax_total);
  const total_net = redondear(total_gross - withholding_total);

  // 4) Validaciones
  const checks: InvoiceExtraction['validation']['checks'] = {
    total_matches_bases_and_taxes: true,
    tax_id_vendor_valid: validarNif(lectura.vendor_tax_id),
    tax_id_customer_valid: validarNif(lectura.customer_tax_id),
    withholding_consistent: true,
  };

  // Validar que total cuadre
  if (lectura.total !== null) {
    const cuadraBruto = Math.abs(lectura.total - total_gross) <= 0.01;
    const cuadraLiquido = Math.abs(lectura.total - total_net) <= 0.01;
    if (!cuadraBruto && !cuadraLiquido) {
      checks.total_matches_bases_and_taxes = false;
      errores.push(
        `Total no cuadra: documento dice ${lectura.total.toFixed(2)}, ` +
          `calculado bruto ${total_gross.toFixed(2)}, neto ${total_net.toFixed(2)}`
      );
      confidence = Math.max(confidence - 0.2, 0.3);
    }
  } else {
    errores.push('Total no detectado en el documento');
    confidence = Math.max(confidence - 0.1, 0.5);
  }

  // Validar retención vs base
  if (lectura.retention_amount !== null && lectura.retention_amount > 0 && lectura.retention_rate !== null && subtotal > 0) {
    const esperado = redondear((subtotal * lectura.retention_rate) / 100);
    if (Math.abs(esperado - lectura.retention_amount) > 0.02) {
      checks.withholding_consistent = false;
      errores.push(
        `Retención inconsistente: ${lectura.retention_rate}% de ${subtotal.toFixed(2)} es ${esperado.toFixed(2)}, ` +
          `pero documento dice ${lectura.retention_amount.toFixed(2)}`
      );
    }
  }

  // Validar NIFs
  if (lectura.vendor_tax_id && !validarNif(lectura.vendor_tax_id)) {
    checks.tax_id_vendor_valid = false;
    errores.push(`NIF/CIF del vendor (${lectura.vendor_tax_id}) inválido`);
  }
  if (lectura.customer_tax_id && !validarNif(lectura.customer_tax_id)) {
    checks.tax_id_customer_valid = false;
    errores.push(`NIF/CIF del customer (${lectura.customer_tax_id}) inválido`);
  }

  // Advertencias generales
  if (!lectura.issue_date) {
    errores.push('Fecha de emisión no detectada');
    confidence = Math.max(confidence - 0.15, 0.4);
  }
  if (!lectura.number) {
    errores.push('Número de factura no detectado');
    confidence = Math.max(confidence - 0.1, 0.5);
  }
  if (!lectura.vendor_name) {
    errores.push('Nombre del vendor no detectado');
    confidence = Math.max(confidence - 0.1, 0.5);
  }

  confidence = Math.max(Math.min(confidence, 1.0), 0.0);

  // 5) Líneas (si se detectan detalles de productos)
  const lines: InvoiceExtraction['lines'] = lectura.base_amounts.map((base, idx) => ({
    description: lectura.description && idx === 0 ? lectura.description : `Item ${idx + 1}`,
    quantity: 1.0,
    unit_price: base.base,
    line_total: base.base,
    tax_rate: base.vat_rate,
  }));

  return {
    document_type,
    direction,
    confidence,
    vendor: {
      name: lectura.vendor_name,
      tax_id: lectura.vendor_tax_id,
      address: lectura.vendor_address,
      country: 'ES',
    },
    customer: {
      name: lectura.customer_name,
      tax_id: lectura.customer_tax_id,
      address: lectura.customer_address,
      country: 'ES',
    },
    invoice: {
      number: lectura.number,
      series: lectura.series,
      issue_date: lectura.issue_date,
      due_date: lectura.due_date,
      original_number: null,
    },
    amounts: {
      currency: 'EUR',
      bases: lectura.base_amounts.map((b) => ({
        tax_rate: b.vat_rate,
        base_amount: redondear(b.base),
        tax_amount: redondear(b.vat_amount),
      })),
      withholdings,
      subtotal: redondear(subtotal),
      tax_total: redondear(tax_total),
      withholding_total: redondear(withholding_total),
      total_gross: redondear(total_gross),
      total_net: redondear(total_net),
    },
    payment: {
      method: lectura.payment_method,
      terms: lectura.payment_terms,
      iban: lectura.iban,
    },
    lines,
    raw_text: lectura.raw_text,
    meta: {
      source_file_name: null,
      source_mime_type: null,
      pages: 1,
    },
    validation: {
      checks,
      errors: errores,
    },
  };
}

// ---------------------------------------------------------------------------
// Servicio público
// ---------------------------------------------------------------------------

export const invoiceExtractorService = {
  /**
   * Extrae los datos contables de una factura (PDF/imagen) y persiste el
   * documento en estado READY_FOR_VERIFICATION. Devuelve el JSON completo.
   */
  async extraer(
    companyId: string,
    userId: string | undefined,
    archivo: { buffer: Buffer; originalname: string; mimetype: string },
    opts: { empresaNif?: string | null; empresaNombre?: string | null } = {},
  ): Promise<{ documentId: string; extraccion: InvoiceExtraction }> {
    const lectura = await leerDocumentoConClaude(archivo.buffer, archivo.mimetype);
    const extraccion = construirExtraccion(lectura, opts);

    const seguro = archivo.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = await putObject(`extractor-ia/${uuid()}-${seguro}`, archivo.buffer, archivo.mimetype);

    const documento = await prisma.incomeReaderDocument.create({
      data: {
        companyId,
        userId,
        sourceType: 'EXTRACTOR_IA',
        originalFileName: archivo.originalname,
        mimeType: archivo.mimetype,
        fileSize: archivo.buffer.length,
        storagePath,
        status: 'READY_FOR_VERIFICATION',
        uploadedAt: new Date(),
        processingStartedAt: new Date(),
        processingCompletedAt: new Date(),
        parsedData: extraccion as never,
      },
    });

    return { documentId: documento.id, extraccion };
  },

  /** Detalle de un documento del extractor. */
  async detalle(companyId: string, id: string): Promise<{ documentId: string; status: string; extraccion: InvoiceExtraction }> {
    const doc = await prisma.incomeReaderDocument.findFirst({ where: { id, companyId, sourceType: 'EXTRACTOR_IA' } });
    if (!doc) throw notFound('Documento del extractor no encontrado.');
    return { documentId: doc.id, status: doc.status, extraccion: doc.parsedData as unknown as InvoiceExtraction };
  },

  /**
   * Corrige la extracción (revisión manual del usuario) antes de confirmar.
   * Acepta un parche parcial y recalcula el schema completo.
   */
  async corregir(
    companyId: string,
    id: string,
    patch: Partial<InvoiceExtraction>,
    opts: { empresaNif?: string | null; empresaNombre?: string | null } = {},
  ): Promise<{ documentId: string; extraccion: InvoiceExtraction }> {
    const doc = await prisma.incomeReaderDocument.findFirst({ where: { id, companyId, sourceType: 'EXTRACTOR_IA' } });
    if (!doc) throw notFound('Documento del extractor no encontrado.');
    if (doc.status !== 'READY_FOR_VERIFICATION') throw badRequest('Solo se pueden corregir documentos pendientes de confirmar.');

    const previa = doc.parsedData as unknown as InvoiceExtraction;
    // Merging: si el usuario edita, usa los nuevos valores; sino, mantiene los previos
    const merged = { ...previa, ...patch };

    // Reconstruir lectura desde el schema merged para recalcular
    const lectura: LecturaClaude = {
      doc_kind: merged.document_type === 'ticket' ? 'ticket' : 'factura',
      number: merged.invoice.number,
      series: merged.invoice.series,
      issue_date: merged.invoice.issue_date,
      due_date: merged.invoice.due_date,
      vendor_name: merged.vendor.name,
      vendor_tax_id: merged.vendor.tax_id ? limpiarNif(merged.vendor.tax_id) : null,
      vendor_address: merged.vendor.address,
      customer_name: merged.customer.name,
      customer_tax_id: merged.customer.tax_id ? limpiarNif(merged.customer.tax_id) : null,
      customer_address: merged.customer.address,
      base_amounts: merged.amounts.bases.map((b) => ({
        base: b.base_amount,
        vat_rate: b.tax_rate,
        vat_amount: b.tax_amount,
      })),
      retention_type: merged.amounts.withholdings.length > 0 ? merged.amounts.withholdings[0].type : null,
      retention_rate: merged.amounts.withholdings.length > 0 ? merged.amounts.withholdings[0].rate : null,
      retention_amount: merged.amounts.withholdings.length > 0 ? merged.amounts.withholdings[0].amount : null,
      total: merged.amounts.total_net,
      payment_method: merged.payment.method,
      payment_terms: merged.payment.terms,
      iban: merged.payment.iban,
      description: null,
      raw_text: merged.raw_text,
    };

    const extraccion = construirExtraccion(lectura, opts);

    await prisma.incomeReaderDocument.update({
      where: { id },
      data: { parsedData: extraccion as never },
    });

    return { documentId: id, extraccion };
  },

  /**
   * Confirma la extracción: guarda el PDF en su carpeta definitiva.
   * Nota: La creación del asiento contable se delegará a otro servicio.
   */
  async confirmar(companyId: string, id: string): Promise<{ documentId: string; storagePath: string; extraccion: InvoiceExtraction }> {
    const doc = await prisma.incomeReaderDocument.findFirst({ where: { id, companyId, sourceType: 'EXTRACTOR_IA' } });
    if (!doc) throw notFound('Documento del extractor no encontrado.');
    if (doc.status !== 'READY_FOR_VERIFICATION') throw badRequest(`El documento está en estado ${doc.status}, no se puede confirmar.`);

    const extraccion = doc.parsedData as unknown as InvoiceExtraction;

    // Validar que no haya errores críticos
    if (extraccion.validation.errors.length > 0) {
      throw badRequest(
        `La extracción tiene errores de validación: ${extraccion.validation.errors.join('; ')}. Corrige antes de confirmar.`
      );
    }

    // Construir ruta: facturas/{companyId}/{año}/{Qx}/{income|expense}/{filename}
    let carpeta = 'sin-clasificar';
    if (extraccion.invoice.issue_date) {
      const m = extraccion.invoice.issue_date.match(/^(\d{4})-(\d{2})-\d{2}$/);
      if (m) {
        const year = m[1];
        const mes = parseInt(m[2], 10);
        const quarter = ['Q1', 'Q2', 'Q3', 'Q4'][Math.floor((mes - 1) / 3)];
        const tipo = extraccion.direction === 'income' ? 'income' : 'expense';
        carpeta = `${year}/${quarter}/${tipo}`;
      }
    }

    // Nombre: {date}-{type}-{number}-{vendor|customer}.pdf
    const numeroCompleto = [extraccion.invoice.series, extraccion.invoice.number].filter(Boolean).join('-');
    const contraparte = extraccion.direction === 'income' ? extraccion.customer.name : extraccion.vendor.name;
    const slugFn = (s: string) =>
      s
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .toUpperCase()
        .slice(0, 40);
    const nombreSugerido = `${extraccion.invoice.issue_date || 'FECHA-DESCONOCIDA'}_${extraccion.document_type.toUpperCase()}_${
      numeroCompleto ? slugFn(numeroCompleto) : 'SIN-NUMERO'
    }_${contraparte ? slugFn(contraparte) : 'CONTRAPARTE-DESCONOCIDA'}.pdf`;

    const buffer = await getObject(doc.storagePath);
    const keyFinal = `facturas/${companyId}/${carpeta}/${nombreSugerido}`;
    const rutaFinal = await putObject(keyFinal, buffer, doc.mimeType);

    await prisma.incomeReaderDocument.update({
      where: { id },
      data: { status: 'VERIFIED', verifiedAt: new Date(), storagePath: rutaFinal },
    });

    return { documentId: id, storagePath: rutaFinal, extraccion };
  },
};
