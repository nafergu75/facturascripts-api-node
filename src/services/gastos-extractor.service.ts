/**
 * ============================================================================
 * EXTRACTOR DE GASTOS CON IA (gastos-extractor)
 * ============================================================================
 *
 * Servicio complementario del lector de gastos en el dashboard de Conta API.
 * Recibe imagen/PDF de comprobante de gasto (factura de proveedor, ticket,
 * recibo, etc.) y extrae datos contables usando Claude Opus con vision:
 *
 *  - numeroFactura, proveedor, nifProveedor
 *  - fecha (YYYY-MM-DD)
 *  - conceptoGasto (descripción)
 *  - base, iva, total
 *  - Sugerencia de cuentaContable (grupo 6: 600, 602, 621, 622, 626, 627, 628, 629, 640, 642)
 *  - confianza (0.0-1.0)
 *  - errores (array de validaciones)
 *
 * La sugerencia de cuenta se basa en el concepto del gasto y SIEMPRE se valida
 * contra `listarCuentasBase()` para NO inventar cuentas.
 * ============================================================================
 */

import Anthropic from '@anthropic-ai/sdk';
import { randomUUID as uuid } from 'crypto';
import { badRequest } from '../utils/http-errors';
import { listarCuentasBase } from './planContable.service';

// ---------------------------------------------------------------------------
// Esquema de salida (contrato con los consumidores)
// ---------------------------------------------------------------------------

export interface GastoExtraido {
  numeroFactura: string | null;
  proveedor: string | null;
  nifProveedor: string | null;
  fecha: string | null; // YYYY-MM-DD
  conceptoGasto: string | null; // "servicios", "arrendamiento", "suministros", etc.
  base: number; // sin IVA
  iva: number;
  total: number; // base + iva
  cuentaContableBase: string | null; // código de 3 dígitos, ej. "629"
  cuentaContableNombre: string | null; // nombre descriptivo
  confianza: number; // 0.0-1.0
  errores: string[];
}

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

const OCR_MODEL = 'claude-opus-4-8';
const anthropicClient = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const MIME_IMAGEN = /^image\/(jpeg|png|gif|webp)$/i;

const PROMPT_EXTRACCION = `Eres un experto en contabilidad española de gastos e impuestos.
Analiza esta imagen de comprobante de gasto (factura, ticket, recibo, etc.)
y extrae los datos con la herramienta "registrar_extraccion_gasto".

REGLAS CLAVE:
1. NÚMERO DE FACTURA: Busca "Factura:", "Invoice:", "Nº", "FV", o números destacados.
2. FECHA: Formatos españoles DD/MM/YYYY, convierte a YYYY-MM-DD.
3. PROVEEDOR: Nombre de quien emite el comprobante.
4. NIF/CIF PROVEEDOR: Patrón español (8 dígitos + letra, o letra + 7 dígitos + letra).
5. CONCEPTO: Tipo de gasto ("arrendamiento", "reparación", "servicios", "suministros", "nómina", "compra", etc.).
6. BASE IMPONIBLE: Cantidad sin impuestos.
7. IVA: Porcentaje y/o cantidad.
8. TOTAL: Total a pagar.

Si algo falta o es ilegible, deja null. NO inventes datos.
Formatos: fechas YYYY-MM-DD; importes sin símbolo; NIF sin "ES" ni separadores.`;

const HERRAMIENTA_EXTRACCION: Anthropic.Tool = {
  name: 'registrar_extraccion_gasto',
  description: 'Registra los datos del comprobante de gasto (campos ausentes se omiten).',
  input_schema: {
    type: 'object',
    properties: {
      numero: { type: 'string', description: 'Número de factura/comprobante' },
      fecha: { type: 'string', description: 'Fecha de emisión, YYYY-MM-DD' },
      proveedor: { type: 'string', description: 'Razón social del proveedor' },
      nif_proveedor: { type: 'string', description: 'NIF/CIF del proveedor, sin prefijo ES' },
      concepto: {
        type: 'string',
        description: 'Tipo de gasto: arrendamiento, reparación, servicios, suministros, nómina, compra, publicidad, etc.',
      },
      base: { type: 'number', description: 'Base imponible (sin IVA)' },
      iva_porcentaje: { type: 'number', description: 'Porcentaje de IVA (21, 10, 4, 0, etc.)' },
      iva_cantidad: { type: 'number', description: 'Cantidad de IVA' },
      total: { type: 'number', description: 'Total a pagar (base + IVA)' },
    },
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  if (!/^([0-9]{8}[A-Z]|[A-Z][0-9]{7}[A-Z0-9])$/i.test(cleaned)) return false;
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
 * Mapea el concepto de gasto a una cuenta contable del grupo 6.
 * Siempre valida que la cuenta exista en el plan contable.
 * Si no existe o no se puede determinar, retorna 629 (Otros servicios).
 */
function sugerirCuentaParaGasto(concepto: string | null): { codigo: string; nombre: string } {
  const cuentasDisponibles = listarCuentasBase();
  const cuentasGastos = cuentasDisponibles.filter((c) => c.tipo === 'gasto');

  if (!concepto) {
    const default629 = cuentasGastos.find((c) => c.codigo === '629');
    return {
      codigo: default629?.codigo ?? '629',
      nombre: default629?.nombre ?? 'Otros servicios',
    };
  }

  const conceptoLower = concepto.toLowerCase();

  // Mapeo de conceptos → códigos de cuenta
  const mapeos: Array<{ patrones: string[]; codigo: string }> = [
    { patrones: ['arrendamiento', 'alquiler', 'renta', 'canon'], codigo: '621' },
    { patrones: ['reparación', 'reparaciones', 'mantenimiento', 'conservación', 'arreglo'], codigo: '622' },
    { patrones: ['banco', 'servicio bancario', 'comisión', 'interés'], codigo: '626' },
    { patrones: ['publicidad', 'publicidad y propaganda', 'marketing', 'propaganda', 'relaciones públicas'], codigo: '627' },
    { patrones: ['suministro', 'suministros', 'material', 'materiales', 'electricidad', 'agua', 'gas', 'combustible'], codigo: '628' },
    { patrones: ['salario', 'salarios', 'sueldo', 'sueldos', 'nómina', 'remuneración'], codigo: '640' },
    { patrones: ['seguridad social', 'seguro social', 'cotización', 'aportación patronal'], codigo: '642' },
    { patrones: ['compra', 'compras', 'mercancía', 'mercaderías', 'aprovisionamiento'], codigo: '600' },
  ];

  for (const mapeo of mapeos) {
    if (mapeo.patrones.some((p) => conceptoLower.includes(p))) {
      const cuenta = cuentasGastos.find((c) => c.codigo === mapeo.codigo);
      if (cuenta) {
        return { codigo: cuenta.codigo, nombre: cuenta.nombre };
      }
    }
  }

  // Fallback: 629 (Otros servicios)
  const default629 = cuentasGastos.find((c) => c.codigo === '629');
  return {
    codigo: default629?.codigo ?? '629',
    nombre: default629?.nombre ?? 'Otros servicios',
  };
}

/**
 * Heurísticas fallback para completar datos faltantes cuando Claude no los devuelve.
 */
function aplicarFallbacksHeuristicos(lectura: LecturaClaude, textoExtraido: string): LecturaClaude {
  // Fallback 1: Número de factura
  if (!lectura.numero) {
    const m = textoExtraido.match(/(?:factura|invoice|f|nº)\s*[#:\s]*(\d{6,12})/i);
    if (m) lectura.numero = m[1];
    else {
      const m2 = textoExtraido.match(/\b(\d{6,12})\b/);
      if (m2) lectura.numero = m2[1];
    }
  }

  // Fallback 2: Fecha (formatos españoles DD/MM/YYYY)
  if (!lectura.fecha || !lectura.fecha.match(/^\d{4}-\d{2}-\d{2}$/)) {
    const fechas = textoExtraido.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g);
    if (fechas && fechas.length > 0) {
      const parts = fechas[0]!.split('/');
      if (parts.length === 3) {
        const [d, m, y] = parts;
        const year = parseInt(y!, 10);
        const month = parseInt(m!, 10);
        const day = parseInt(d!, 10);
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 2000 && year <= 2100) {
          lectura.fecha = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }
      }
    }
  }

  // Fallback 3: NIF/CIF
  if (!lectura.nif_proveedor) {
    const nifs = textoExtraido.match(/\b([A-Z]\d{7}[A-Z0-9]|[0-9]{8}[A-Z])\b/gi);
    if (nifs && nifs.length > 0) {
      lectura.nif_proveedor = nifs[0]!.toUpperCase();
    }
  }

  // Fallback 4: Nombre proveedor (líneas largas que no sean boilerplate)
  if (!lectura.proveedor) {
    const lineas = textoExtraido.split('\n').filter((l) => l.length > 10 && l.length < 100 && l.trim() !== '');
    for (const l of lineas) {
      const cleaned = l.trim();
      if (
        !/^[\d\s,./()-]*$/.test(cleaned) &&
        !/precios|legisl|registro|inscrit|rogamos|condici|pago|banco|iban|factura/i.test(cleaned) &&
        cleaned.length >= 8 &&
        !/^\d{1,2}\/\d{1,2}\/\d{4}/.test(cleaned)
      ) {
        lectura.proveedor = cleaned;
        break;
      }
    }
  }

  // Fallback 5: Base, IVA, Total (si faltan)
  if (lectura.base === null || lectura.base === 0) {
    const baseMatch = textoExtraido.match(/(?:base|subtotal|base\s+imponible|sin\s+iva)\s*[:\s]*([0-9]+(?:[.,][0-9]{2})?)/i);
    if (baseMatch) {
      lectura.base = parseFloat(baseMatch[1].replace(',', '.'));
    }
  }

  if (!lectura.iva_cantidad && lectura.base && lectura.total) {
    lectura.iva_cantidad = lectura.total - lectura.base;
  }

  return lectura;
}

interface LecturaClaude {
  numero: string | null;
  fecha: string | null;
  proveedor: string | null;
  nif_proveedor: string | null;
  concepto: string | null;
  base: number | null;
  iva_porcentaje: number | null;
  iva_cantidad: number | null;
  total: number | null;
  raw_text: string | null;
}

/**
 * Lee un documento (PDF/imagen) con Claude Opus y vision.
 */
async function leerDocumentoConClaude(buffer: Buffer, mimeType: string): Promise<LecturaClaude> {
  if (!anthropicClient) {
    throw badRequest('El extractor IA no está disponible: falta ANTHROPIC_API_KEY en el servidor.');
  }

  const esPdf = /pdf/i.test(mimeType);
  const esImagen = MIME_IMAGEN.test(mimeType);
  if (!esPdf && !esImagen) {
    throw badRequest(`Formato no soportado: ${mimeType}. Usa PDF o imagen (JPG/PNG/WEBP/GIF).`);
  }

  const data = buffer.toString('base64');
  let response: Anthropic.Message;
  try {
    response = await anthropicClient.messages.create({
      model: OCR_MODEL,
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      messages: [
        {
          role: 'user',
          content: [
            esPdf
              ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
              : {
                  type: 'image',
                  source: { type: 'base64', media_type: (mimeType.toLowerCase()) as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data },
                },
            { type: 'text', text: PROMPT_EXTRACCION },
          ],
        },
      ],
      tools: [HERRAMIENTA_EXTRACCION],
      tool_choice: { type: 'tool', name: 'registrar_extraccion_gasto' },
    });
  } catch (err) {
    const e = err as { status?: number; error?: { error?: { message?: string } } };
    const detalle = e.error?.error?.message ?? (err instanceof Error ? err.message : String(err));
    if (/credit balance/i.test(detalle)) {
      throw badRequest('El extractor IA no tiene crédito: recarga en console.anthropic.com');
    }
    if (e.status === 401) {
      throw badRequest('La ANTHROPIC_API_KEY no es válida.');
    }
    throw badRequest(`Error del extractor IA: ${detalle}`);
  }

  const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  if (!toolUse) throw badRequest('El extractor IA no pudo leer el documento.');

  const input = toolUse.input as Record<string, unknown>;

  return {
    numero: cadena(input.numero),
    fecha: cadena(input.fecha),
    proveedor: cadena(input.proveedor),
    nif_proveedor: limpiarNif(input.nif_proveedor),
    concepto: cadena(input.concepto),
    base: numero(input.base) ?? null,
    iva_porcentaje: numero(input.iva_porcentaje) ?? null,
    iva_cantidad: numero(input.iva_cantidad) ?? null,
    total: numero(input.total) ?? null,
    raw_text: null,
  };
}

/**
 * Construye el esquema final de salida GastoExtraido a partir de la lectura de Claude.
 */
function construirGastoExtraido(lectura: LecturaClaude): GastoExtraido {
  const errores: string[] = [];
  let confianza = 0.85; // inicio optimista

  // Base e IVA
  const base = redondear(lectura.base ?? 0);
  const ivaImporte = redondear(lectura.iva_cantidad ?? 0);
  const total = redondear(lectura.total ?? 0);

  // Validaciones
  if (!lectura.numero) {
    errores.push('Número de factura no detectado');
    confianza -= 0.1;
  }
  if (!lectura.fecha) {
    errores.push('Fecha no detectada');
    confianza -= 0.15;
  }
  if (!lectura.proveedor) {
    errores.push('Nombre del proveedor no detectado');
    confianza -= 0.1;
  }

  if (lectura.nif_proveedor && !validarNif(lectura.nif_proveedor)) {
    errores.push(`NIF/CIF inválido: ${lectura.nif_proveedor}`);
    confianza -= 0.05;
  }

  if (base === 0 && total === 0) {
    errores.push('Base e importe total no se pudieron detectar');
    confianza -= 0.2;
  }

  // Validar que total cuadre con base + iva
  if (base > 0 && total > 0) {
    const calculado = redondear(base + ivaImporte);
    if (Math.abs(calculado - total) > 0.01) {
      errores.push(`Total no cuadra: base (${base}) + IVA (${ivaImporte}) = ${calculado}, pero documento dice ${total}`);
      confianza -= 0.1;
    }
  }

  // Sugerir cuenta
  const { codigo: cuentaCodigo, nombre: cuentaNombre } = sugerirCuentaParaGasto(lectura.concepto);

  confianza = Math.max(Math.min(confianza, 1.0), 0.0);

  return {
    numeroFactura: lectura.numero,
    proveedor: lectura.proveedor,
    nifProveedor: lectura.nif_proveedor,
    fecha: lectura.fecha,
    conceptoGasto: lectura.concepto,
    base,
    iva: ivaImporte,
    total,
    cuentaContableBase: cuentaCodigo,
    cuentaContableNombre: cuentaNombre,
    confianza,
    errores,
  };
}

// ---------------------------------------------------------------------------
// Servicio público
// ---------------------------------------------------------------------------

export const gastosExtractorService = {
  /**
   * Extrae datos de un comprobante de gasto (PDF/imagen) usando Claude Opus.
   * Retorna GastoExtraido con todos los datos y sugerencia de cuenta contable.
   */
  async extraer(
    archivo: { buffer: Buffer; originalname: string; mimetype: string },
  ): Promise<GastoExtraido> {
    const lectura = await leerDocumentoConClaude(archivo.buffer, archivo.mimetype);
    const lectraConFallbacks = aplicarFallbacksHeuristicos(lectura, ''); // raw_text vacío por ahora
    const gasto = construirGastoExtraido(lectraConFallbacks);
    return gasto;
  },
};
