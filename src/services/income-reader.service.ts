/**
 * ============================================================================
 * LECTOR DE FACTURAS CANÓNICO (income-reader)
 * ============================================================================
 *
 * Este es el lector OFICIAL del proyecto y el único que debe usarse para nuevas
 * funcionalidades. Lo consume el frontend Chakra en /lector vía
 * `frontend-chakra/src/api/incomeReaderApi.ts`. El lector antiguo
 * (`lectorFacturas.service.ts`, usado por el frontend vanilla en `frontend/`)
 * está marcado como LEGACY y delega su OCR de PDF/imagen en `procesarOCR` de
 * este archivo: la integración con Claude vive aquí, no duplicada allí.
 *
 * Contrato canónico (ver ADR "Consolidación de lector OCR"):
 *  - Rutas: /companies/:companyId/income-reader/* (income-reader.routes.ts)
 *      POST /web-upload | /mobile-upload   subir documento (multipart 'archivo')
 *      POST /email-hook                    alta desde adjunto de email
 *      GET  /pending                       documentos READY_FOR_VERIFICATION
 *      GET  /:id                           detalle de un documento
 *      PUT  /:id                           corregir parsedData (correcciones)
 *      POST /:id/verify                    crear factura de ingreso desde lo leído
 *      POST /:id/reject                    rechazar documento
 *  - Persistencia: tabla Prisma `IncomeReaderDocument` (no Map en memoria).
 *  - Estados (campo `status`): UPLOADED → READY_FOR_VERIFICATION → VERIFIED,
 *      o REJECTED en caso de error de OCR o rechazo manual.
 *  - OCR: Claude vision (`procesarOCR`), modelo claude-opus-4-8, tool-calling
 *      forzado. Sin ANTHROPIC_API_KEY o archivo no soportado → confianza 0
 *      (revisión manual), sin romper el flujo.
 *  - Documento leído (`ParsedInvoiceData`): nifEmisor/nombreEmisor,
 *      nifReceptor/nombreReceptor, numero, fecha, fechaVencimiento,
 *      baseImponible, totalIva, totalRetencion, total, lineas[], confianza.
 * ============================================================================
 */
import { badRequest, notFound } from '../utils/http-errors';
import { randomUUID as uuid } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../config/database';
import { config } from '../config/env';
import { putObject, getObject } from '../utils/storage';
import {
  esVigente,
  diasParaCaducidad,
  validarCoherenciaIncomeReader,
  mensajeDocumentoExpirado,
} from '../helpers/documento';

/**
 * Datos extraídos del OCR de una factura/ticket de ingreso.
 */
export interface ParsedInvoiceData {
  // Datos del emisor (proveedor/cliente que nos emite la factura)
  nifEmisor?: string;
  nombreEmisor?: string;

  // Datos del receptor (nosotros)
  nifReceptor?: string;
  nombreReceptor?: string;

  // Factura
  numero?: string;
  fecha?: string; // YYYY-MM-DD
  fechaVencimiento?: string; // YYYY-MM-DD

  // Totales
  baseImponible?: number;
  totalIva?: number;
  totalRetencion?: number;
  total?: number;

  // Líneas detectadas
  lineas?: Array<{
    descripcion: string;
    cantidad?: number;
    precioUnitario?: number;
    totalLinea?: number;
    baseImponible?: number;
    tipoIva?: number;
    tipoRetencion?: number;
  }>;

  // Metadata
  tipoDetectado?: 'venta' | 'compra'; // Si es autofactura o factura de proveedor
  confianza?: number; // 0-100, % de confianza del OCR
  /**
   * Por qué quedó (o no) con datos. Permite al frontend distinguir "no hay OCR
   * configurado" de "el documento no se pudo leer", sin tener que adivinarlo
   * desde `confianza`. SIN_CLAVE = falta ANTHROPIC_API_KEY; FORMATO_NO_SOPORTADO
   * = no es PDF/imagen/XML; NO_LEGIBLE = se intentó y no se extrajo nada; OK = se
   * extrajeron datos (revisar `confianza` para el nivel).
   */
  ocrEstado?: 'OK' | 'SIN_CLAVE' | 'FORMATO_NO_SOPORTADO' | 'NO_LEGIBLE';
}

export interface IncomeReaderDocumentResp {
  id: string;
  companyId: string;
  sourceType: string;
  originalFileName: string;
  status: string;
  uploadedAt: Date;
  processingStartedAt?: Date;
  processingCompletedAt?: Date;
  verifiedAt?: Date;
  expiresAt?: Date;
  estaExpirado?: boolean; // Derivado: true si expiresAt existe y ya pasó
  parsedData?: ParsedInvoiceData;
  linkedInvoiceId?: string;
  rejectionReason?: string;
}

// --- OCR de PDF/imagen via Claude (mismo patron que lectorFacturas.service / Carmen) ---
const OCR_MODEL = 'claude-opus-4-8';
const anthropicClient = config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey }) : null;
const MIME_IMAGEN_OCR = /^image\/(jpeg|png|gif|webp)$/i;

const PROMPT_LECTURA_FACTURA =
  'Eres un asistente contable. Analiza la factura o ticket adjunto (PDF o imagen) y registra sus datos con la ' +
  'herramienta "registrar_datos_factura". Usa el formato de fecha YYYY-MM-DD. Los importes deben ser numeros ' +
  'sin simbolo de moneda ni separadores de miles. Los NIF/CIF van sin el prefijo "ES". Si un dato no aparece ' +
  'en el documento, omite ese campo: no inventes valores.';

const HERRAMIENTA_EXTRACCION_INGRESO: Anthropic.Tool = {
  name: 'registrar_datos_factura',
  description: 'Registra los datos detectados en la factura o ticket (campos ausentes en el documento se omiten).',
  input_schema: {
    type: 'object',
    properties: {
      numero: { type: 'string', description: 'Numero de factura (incluye serie si la hay, ej. "A-0001")' },
      fecha: { type: 'string', description: 'Fecha de emision, formato YYYY-MM-DD' },
      fechaVencimiento: { type: 'string', description: 'Fecha de vencimiento/pago, formato YYYY-MM-DD, si aparece' },
      nifEmisor: { type: 'string', description: 'NIF/CIF de quien emite la factura (proveedor/cliente)' },
      nombreEmisor: { type: 'string', description: 'Nombre o razon social de quien emite la factura' },
      nifReceptor: { type: 'string', description: 'NIF/CIF del receptor de la factura' },
      nombreReceptor: { type: 'string', description: 'Nombre o razon social del receptor de la factura' },
      baseImponible: { type: 'number', description: 'Base imponible total, sin impuestos' },
      totalIva: { type: 'number', description: 'Cuota total de IVA' },
      totalRetencion: { type: 'number', description: 'Cuota total de retencion (IRPF), si aplica' },
      total: { type: 'number', description: 'Importe total de la factura' },
      lineas: {
        type: 'array',
        description: 'Lineas/conceptos de la factura',
        items: {
          type: 'object',
          properties: {
            descripcion: { type: 'string' },
            cantidad: { type: 'number' },
            precioUnitario: { type: 'number' },
            totalLinea: { type: 'number' },
            baseImponible: { type: 'number' },
            tipoIva: { type: 'number', description: 'Porcentaje de IVA aplicado (ej. 21)' },
            tipoRetencion: { type: 'number', description: 'Porcentaje de retencion aplicado (ej. 15), si aplica' },
          },
          required: ['descripcion'],
        },
      },
    },
  },
};

const cadena = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const numeroOpt = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Heurística simple de confianza: % de campos clave detectados por el OCR. */
function calcularConfianza(d: ParsedInvoiceData): number {
  const campos = [d.nifEmisor, d.numero, d.fecha, d.total, d.lineas && d.lineas.length > 0 ? 'ok' : undefined];
  const detectados = campos.filter((c) => c !== undefined).length;
  return Math.round((detectados / campos.length) * 100);
}

/** Normaliza el `input` (sin tipar) de la tool call de Claude a `ParsedInvoiceData`. */
function normalizarSalidaOCR(input: Record<string, unknown>): ParsedInvoiceData {
  const lineasIn = Array.isArray(input.lineas) ? input.lineas : [];
  const lineas = lineasIn
    .filter((l): l is Record<string, unknown> => typeof l === 'object' && l !== null)
    .map((l) => ({
      descripcion: cadena(l.descripcion) ?? 'Concepto',
      cantidad: numeroOpt(l.cantidad),
      precioUnitario: numeroOpt(l.precioUnitario),
      totalLinea: numeroOpt(l.totalLinea),
      baseImponible: numeroOpt(l.baseImponible),
      tipoIva: numeroOpt(l.tipoIva),
      tipoRetencion: numeroOpt(l.tipoRetencion),
    }));

  const datos: ParsedInvoiceData = {
    nifEmisor: cadena(input.nifEmisor)?.toUpperCase().replace(/^ES/i, ''),
    nombreEmisor: cadena(input.nombreEmisor),
    nifReceptor: cadena(input.nifReceptor)?.toUpperCase().replace(/^ES/i, ''),
    nombreReceptor: cadena(input.nombreReceptor),
    numero: cadena(input.numero),
    fecha: cadena(input.fecha),
    fechaVencimiento: cadena(input.fechaVencimiento),
    baseImponible: numeroOpt(input.baseImponible),
    totalIva: numeroOpt(input.totalIva),
    totalRetencion: numeroOpt(input.totalRetencion),
    total: numeroOpt(input.total),
    lineas: lineas.length > 0 ? lineas : undefined,
  };
  datos.confianza = calcularConfianza(datos);
  return datos;
}

// --- Parser de Facturae XML (e-factura española), portado desde el lector legacy ---
// Es el parser CANÓNICO: el lector legacy (lectorFacturas.service.ts) lo reutiliza
// a través de un wrapper fino. Sin OCR ni clave: trabaja sobre el XML estructurado.

/** Extrae el contenido del primer tag que coincida (parser ligero, sin librería). */
function tagXml(xml: string, nombre: string): string | undefined {
  // (?=[\s>/]) evita que 'InvoiceTotal' capture '<InvoiceTotals>'.
  const m = new RegExp(`<${nombre}(?=[\\s>/])[^>]*>([\\s\\S]*?)</${nombre}\\s*>`, 'i').exec(xml);
  return m?.[1]?.trim();
}
const numXml = (s?: string): number | undefined => (s !== undefined && s !== '' ? Number(s) : undefined);

/** True si el buffer/mime parece un XML Facturae. */
function esFacturaeXml(buffer: Buffer, mimeType: string): boolean {
  const cabeza = buffer.subarray(0, 200).toString('utf8');
  return /xml/i.test(mimeType) || cabeza.trimStart().startsWith('<?xml') || /<(fe:)?Facturae/i.test(cabeza);
}

/**
 * Parser de Facturae 3.x (XML de factura electrónica española) → ParsedInvoiceData.
 * Extrae cabecera (numero/fecha/NIFs), desglose de IVA por bloque <Tax> y totales.
 * Implementado con regex sobre los tags estándar; TODO: validar firma XAdES y
 * migrar a un parser XML completo (fast-xml-parser) si se necesitan todos los casos.
 */
export function parsearFacturaeXML(xml: string): ParsedInvoiceData {
  const seller = tagXml(xml, 'SellerParty') ?? '';
  const buyer = tagXml(xml, 'BuyerParty') ?? '';
  const invoice = tagXml(xml, 'Invoice') ?? xml;

  // Líneas: un desglose por cada bloque <Tax> dentro de TaxesOutputs de la factura.
  const taxes = tagXml(invoice, 'TaxesOutputs') ?? '';
  const lineas: NonNullable<ParsedInvoiceData['lineas']> = [];
  for (const m of taxes.matchAll(/<Tax>([\s\S]*?)<\/Tax>/gi)) {
    const t = m[1];
    const base = numXml(tagXml(tagXml(t, 'TaxableBase') ?? '', 'TotalAmount'));
    const tipo = numXml(tagXml(t, 'TaxRate'));
    if (base !== undefined) {
      lineas.push({ descripcion: `Base al ${tipo ?? 0}%`, cantidad: 1, baseImponible: base, tipoIva: tipo });
    }
  }

  const numeroSerie = tagXml(invoice, 'InvoiceSeriesCode');
  const numeroFactura = tagXml(invoice, 'InvoiceNumber');

  const datos: ParsedInvoiceData = {
    numero: [numeroSerie, numeroFactura].filter(Boolean).join('-') || undefined,
    fecha: tagXml(invoice, 'IssueDate'),
    nifEmisor: tagXml(seller, 'TaxIdentificationNumber')?.toUpperCase().replace(/^ES/i, ''),
    nombreEmisor: tagXml(seller, 'CorporateName') ?? ([tagXml(seller, 'Name'), tagXml(seller, 'FirstSurname')].filter(Boolean).join(' ') || undefined),
    nifReceptor: tagXml(buyer, 'TaxIdentificationNumber')?.toUpperCase().replace(/^ES/i, ''),
    nombreReceptor: tagXml(buyer, 'CorporateName') ?? ([tagXml(buyer, 'Name'), tagXml(buyer, 'FirstSurname')].filter(Boolean).join(' ') || undefined),
    lineas: lineas.length > 0 ? lineas : undefined,
    baseImponible: numXml(tagXml(invoice, 'TotalGrossAmountBeforeTaxes')),
    totalIva: numXml(tagXml(invoice, 'TotalTaxOutputs')),
    total: numXml(tagXml(invoice, 'InvoiceTotal')),
  };
  datos.confianza = calcularConfianza(datos);
  datos.ocrEstado = 'OK';
  return datos;
}

/**
 * Guarda el archivo subido en el almacenamiento (Vercel Blob en producción,
 * disco local en dev) y devuelve su referencia. Ver utils/storage.ts.
 */
async function guardarArchivo(buffer: Buffer, nombreOriginal: string, mimeType = 'application/octet-stream'): Promise<string> {
  const seguro = nombreOriginal.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `income-documents/${uuid()}-${Date.now()}-${seguro}`;
  return putObject(key, buffer, mimeType);
}

/**
 * Leer archivo almacenado desde storagePath.
 * storagePath es el resultado de guardarArchivo (key en object storage).
 */
async function leerArchivoAlmacenado(storagePath: string): Promise<Buffer> {
  return getObject(storagePath);
}

/**
 * Verificar si un documento ha expirado.
 * Retorna true si expiresAt existe y ya pasó.
 */
/**
 * OCR real de PDF/imagen via Claude (vision). Si no hay ANTHROPIC_API_KEY
 * configurada, o el archivo no es un PDF/imagen soportado, devuelve
 * confianza 0 (revisión manual). Los errores de la API se registran en el
 * log del servidor y NO se propagan: el documento queda en revisión manual.
 *
 * EXPORTADO como entrypoint OCR canónico: el lector legacy
 * (`lectorFacturas.service.ts`) lo reutiliza para no duplicar la integración
 * con Claude. No cambies su firma sin revisar ese consumidor.
 */
export async function procesarOCR(buffer: Buffer, mimeType: string): Promise<ParsedInvoiceData> {
  // 1) Facturae XML: parser estructurado, NO necesita Claude ni ANTHROPIC_API_KEY.
  if (esFacturaeXml(buffer, mimeType)) {
    try {
      const datos = parsearFacturaeXML(buffer.toString('utf8'));
      // Si el XML no era Facturae (no se extrajo nada útil) lo tratamos como no legible.
      return (datos.confianza ?? 0) > 0 ? datos : { confianza: 0, ocrEstado: 'NO_LEGIBLE' };
    } catch {
      return { confianza: 0, ocrEstado: 'NO_LEGIBLE' };
    }
  }

  // 2) PDF/imagen: OCR real vía Claude.
  if (!anthropicClient) return { confianza: 0, ocrEstado: 'SIN_CLAVE' };

  const esPdf = /pdf/i.test(mimeType);
  const esImagen = MIME_IMAGEN_OCR.test(mimeType);
  if (!esPdf && !esImagen) return { confianza: 0, ocrEstado: 'FORMATO_NO_SOPORTADO' };

  const data = buffer.toString('base64');

  try {
    const response = await anthropicClient.messages.create({
      model: OCR_MODEL,
      max_tokens: 1536,
      thinking: { type: 'adaptive' },
      messages: [
        {
          role: 'user',
          content: [
            esPdf
              ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
              : { type: 'image', source: { type: 'base64', media_type: mimeType.toLowerCase() as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data } },
            { type: 'text', text: PROMPT_LECTURA_FACTURA },
          ],
        },
      ],
      tools: [HERRAMIENTA_EXTRACCION_INGRESO],
      tool_choice: { type: 'tool', name: 'registrar_datos_factura' },
    });

    const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!toolUse) return { confianza: 0, ocrEstado: 'NO_LEGIBLE' };
    const datos = normalizarSalidaOCR(toolUse.input as Record<string, unknown>);
    // Claude respondió pero sin ningún campo útil → no legible (no "sin OCR").
    datos.ocrEstado = (datos.confianza ?? 0) > 0 ? 'OK' : 'NO_LEGIBLE';
    return datos;
  } catch (err) {
    console.error('income-reader: error en OCR con Claude', err);
    return { confianza: 0, ocrEstado: 'NO_LEGIBLE' };
  }
}

/**
 * Tarea de procesamiento en background.
 * En producción, usar cola (Bull, RabbitMQ, etc.) y workers separados.
 * Estados: UPLOADED → PROCESSING → READY_FOR_VERIFICATION (éxito) o ERROR (fallo).
 * Valida expiración: si el documento ya expiró, lo rechaza sin procesar OCR.
 */
async function procesarDocumentoEnBackground(documentId: string, companyId: string, buffer: Buffer, mimeType: string): Promise<void> {
  try {
    // Obtener documento para validar expiración
    const documento = await prisma.incomeReaderDocument.findUnique({
      where: { id: documentId },
    });

    if (!documento) {
      console.error(`Documento no encontrado: ${documentId}`);
      return;
    }

    // Validar si documento ya expiró
    if (!esVigente(documento)) {
      await prisma.incomeReaderDocument.update({
        where: { id: documentId },
        data: {
          status: 'REJECTED',
          rejectionReason: 'Documento expirado. No se puede procesar.',
          processingCompletedAt: new Date(),
        },
      });
      return;
    }

    // Marcar como PROCESSING
    await prisma.incomeReaderDocument.update({
      where: { id: documentId },
      data: {
        status: 'PROCESSING',
        processingStartedAt: new Date(),
        errorMensaje: null, // Limpiar error anterior si reintentan
      },
    });

    // Ejecutar OCR
    const parsedData = await procesarOCR(buffer, mimeType);

    // Validar si OCR tuvo éxito real
    // (confianza 0 y ocrEstado != OK = fallo suave)
    if ((parsedData.confianza ?? 0) === 0 && parsedData.ocrEstado !== 'OK') {
      // OCR falló: marcar ERROR
      await prisma.incomeReaderDocument.update({
        where: { id: documentId },
        data: {
          status: 'ERROR',
          errorMensaje: `OCR no pudo leer el documento. Estado: ${parsedData.ocrEstado || 'desconocido'}`,
          processingCompletedAt: new Date(),
        },
      });
      return;
    }

    // OCR tuvo éxito: guardar datos
    await prisma.incomeReaderDocument.update({
      where: { id: documentId },
      data: {
        status: 'READY_FOR_VERIFICATION',
        parsedData: parsedData as any,
        processingCompletedAt: new Date(),
        errorMensaje: null,
      },
    });
  } catch (err) {
    // Exception en OCR: marcar ERROR
    console.error(`Error procesando documento ${documentId}:`, err);
    try {
      await prisma.incomeReaderDocument.update({
        where: { id: documentId },
        data: {
          status: 'ERROR',
          errorMensaje: `Excepción en OCR: ${String(err).substring(0, 500)}`,
          processingCompletedAt: new Date(),
        },
      });
    } catch (updateErr) {
      console.error(`Error actualizando documento ${documentId}:`, updateErr);
    }
  }
}

export const incomeReaderService = {
  /**
   * POST /api/income-reader/mobile-upload
   * Subir foto desde app móvil.
   */
  async subirDesdeMovil(
    companyId: string,
    userId: string,
    archivo: { buffer: Buffer; originalname: string; mimetype: string },
  ): Promise<IncomeReaderDocumentResp> {
    // Guardar archivo
    const storagePath = await guardarArchivo(archivo.buffer, archivo.originalname, archivo.mimetype);

    // Crear documento en BD con estado UPLOADED
    const documento = await prisma.incomeReaderDocument.create({
      data: {
        companyId,
        userId,
        sourceType: 'MOBILE_CAMERA',
        originalFileName: archivo.originalname,
        mimeType: archivo.mimetype,
        fileSize: archivo.buffer.length,
        storagePath,
        status: 'UPLOADED',
        uploadedAt: new Date(),
      },
    });

    // Encolar procesamiento en background
    procesarDocumentoEnBackground(documento.id, companyId, archivo.buffer, archivo.mimetype).catch(console.error);

    return {
      id: documento.id,
      companyId: documento.companyId,
      sourceType: documento.sourceType,
      originalFileName: documento.originalFileName,
      status: documento.status,
      uploadedAt: documento.uploadedAt,
    };
  },

  /**
   * POST /api/income-reader/web-upload
   * Subir archivo desde web (drag & drop).
   */
  async subirDesdeWeb(
    companyId: string,
    userId: string,
    archivo: { buffer: Buffer; originalname: string; mimetype: string },
  ): Promise<IncomeReaderDocumentResp> {
    // Guardar archivo
    const storagePath = await guardarArchivo(archivo.buffer, archivo.originalname, archivo.mimetype);

    // Crear documento en BD con estado UPLOADED
    const documento = await prisma.incomeReaderDocument.create({
      data: {
        companyId,
        userId,
        sourceType: 'WEB_UPLOAD',
        originalFileName: archivo.originalname,
        mimeType: archivo.mimetype,
        fileSize: archivo.buffer.length,
        storagePath,
        status: 'UPLOADED',
        uploadedAt: new Date(),
      },
    });

    // Encolar procesamiento en background
    procesarDocumentoEnBackground(documento.id, companyId, archivo.buffer, archivo.mimetype).catch(console.error);

    return {
      id: documento.id,
      companyId: documento.companyId,
      sourceType: documento.sourceType,
      originalFileName: documento.originalFileName,
      status: documento.status,
      uploadedAt: documento.uploadedAt,
    };
  },

  /**
   * POST /api/income-reader/email-hook
   * Webhook para recibir facturas por email.
   * Payload: { readerEmail, remitente, adjuntos: [{buffer, nombre, mimetype}] }
   */
  async procesarDesdeEmail(
    companyId: string,
    readerEmail: string,
    remitente: string,
    adjuntos: Array<{ buffer: Buffer; nombre: string; mimetype: string }>,
  ): Promise<IncomeReaderDocumentResp[]> {
    const resultados: IncomeReaderDocumentResp[] = [];

    // Validar que el readerEmail está configurado para esta empresa
    const config = await prisma.readerEmailConfig.findFirst({
      where: { companyId, readerEmail, isReaderEmailActive: true },
    });

    if (!config) {
      throw badRequest(`Email del lector no configurado o inactivo para esta empresa.`);
    }

    // Procesar cada adjunto
    for (const adjunto of adjuntos) {
      try {
        const storagePath = await guardarArchivo(adjunto.buffer, adjunto.nombre, adjunto.mimetype);

        const documento = await prisma.incomeReaderDocument.create({
          data: {
            companyId,
            sourceType: 'EMAIL_FORWARD',
            originalFileName: adjunto.nombre,
            mimeType: adjunto.mimetype,
            fileSize: adjunto.buffer.length,
            storagePath,
            status: 'UPLOADED',
            uploadedAt: new Date(),
          },
        });

        // Encolar procesamiento
        procesarDocumentoEnBackground(documento.id, companyId, adjunto.buffer, adjunto.mimetype).catch(console.error);

        resultados.push({
          id: documento.id,
          companyId: documento.companyId,
          sourceType: documento.sourceType,
          originalFileName: documento.originalFileName,
          status: documento.status,
          uploadedAt: documento.uploadedAt,
        });
      } catch (err) {
        console.error(`Error procesando adjunto ${adjunto.nombre}:`, err);
      }
    }

    return resultados;
  },

  /**
   * GET /api/income-reader/pending?companyId=...
   * Listar documentos pendientes de verificar.
   */
  async listarPendientes(companyId: string): Promise<IncomeReaderDocumentResp[]> {
    const documentos = await prisma.incomeReaderDocument.findMany({
      where: {
        companyId,
        status: 'READY_FOR_VERIFICATION',
      },
      orderBy: { processingCompletedAt: 'desc' },
    });

    return documentos.map((d) => ({
      id: d.id,
      companyId: d.companyId,
      sourceType: d.sourceType,
      originalFileName: d.originalFileName,
      status: d.status,
      uploadedAt: d.uploadedAt,
      processingStartedAt: d.processingStartedAt ?? undefined,
      processingCompletedAt: d.processingCompletedAt ?? undefined,
      parsedData: d.parsedData as ParsedInvoiceData | undefined,
      linkedInvoiceId: d.linkedInvoiceId ?? undefined,
    }));
  },

  /**
   * GET /api/income-reader/:id
   * Obtener detalle de un documento.
   */
  async obtenerDetalle(companyId: string, id: string): Promise<IncomeReaderDocumentResp> {
    const documento = await prisma.incomeReaderDocument.findFirst({
      where: { id, companyId },
    });

    if (!documento) {
      throw notFound('Documento no encontrado.');
    }

    return {
      id: documento.id,
      companyId: documento.companyId,
      sourceType: documento.sourceType,
      originalFileName: documento.originalFileName,
      status: documento.status,
      uploadedAt: documento.uploadedAt,
      processingStartedAt: documento.processingStartedAt ?? undefined,
      processingCompletedAt: documento.processingCompletedAt ?? undefined,
      verifiedAt: documento.verifiedAt ?? undefined,
      expiresAt: documento.expiresAt ?? undefined,
      estaExpirado: !esVigente(documento),
      parsedData: documento.parsedData as ParsedInvoiceData | undefined,
      linkedInvoiceId: documento.linkedInvoiceId ?? undefined,
      rejectionReason: documento.rejectionReason ?? undefined,
    };
  },

  /**
   * PUT /api/income-reader/:id
   * Actualizar datos extraídos de un documento (correcciones manuales).
   */
  async actualizarParsedData(
    companyId: string,
    id: string,
    patch: Partial<ParsedInvoiceData>,
  ): Promise<IncomeReaderDocumentResp> {
    const documento = await prisma.incomeReaderDocument.findFirst({
      where: { id, companyId },
    });

    if (!documento) {
      throw notFound('Documento no encontrado.');
    }

    if (documento.status !== 'READY_FOR_VERIFICATION') {
      throw badRequest('Solo se pueden editar documentos en estado READY_FOR_VERIFICATION.');
    }

    const parsedActualizado = {
      ...(documento.parsedData as Record<string, unknown> || {}),
      ...patch,
    } as Record<string, unknown>;

    const actualizado = await prisma.incomeReaderDocument.update({
      where: { id },
      data: { parsedData: parsedActualizado as any },
    });

    return {
      id: actualizado.id,
      companyId: actualizado.companyId,
      sourceType: actualizado.sourceType,
      originalFileName: actualizado.originalFileName,
      status: actualizado.status,
      uploadedAt: actualizado.uploadedAt,
      processingStartedAt: actualizado.processingStartedAt ?? undefined,
      processingCompletedAt: actualizado.processingCompletedAt ?? undefined,
      parsedData: actualizado.parsedData as ParsedInvoiceData | undefined,
    };
  },

  /**
   * POST /api/income-reader/:id/verify
   * Verificar documento y crear factura de ingreso.
   * Crea un cliente temporal si es necesario y mapea los datos extraídos a una factura.
   */
  async verificarYCrearFactura(
    companyId: string,
    documentId: string,
  ): Promise<IncomeReaderDocumentResp> {
    const documento = await prisma.incomeReaderDocument.findFirst({
      where: { id: documentId, companyId },
    });

    if (!documento) {
      throw notFound('Documento no encontrado.');
    }

    // Validar si documento está expirado
    if (!esVigente(documento)) {
      throw badRequest('El documento ha expirado y no puede verificarse.');
    }

    if (documento.status !== 'READY_FOR_VERIFICATION') {
      throw badRequest('El documento debe estar en estado READY_FOR_VERIFICATION.');
    }

    const parsed = documento.parsedData as ParsedInvoiceData | null;
    if (!parsed) {
      throw badRequest('El documento no tiene datos extraídos.');
    }

    // Importar el servicio de facturas de ingreso
    const { incomeInvoicesService } = await import('./income-invoices.service');

    // Crear o usar cliente existente
    let customerId: string;

    // Si hay NIF del emisor (quien nos emite la factura), buscar cliente
    if (parsed.nifEmisor) {
      const existente = await prisma.customer.findFirst({
        where: { companyId, nifCif: parsed.nifEmisor },
      });

      if (existente) {
        customerId = existente.id;
      } else {
        // Crear cliente nuevo
        const nuevoCliente = await prisma.customer.create({
          data: {
            companyId,
            nombreFiscal: parsed.nombreEmisor || `Cliente ${parsed.nifEmisor}`,
            nifCif: parsed.nifEmisor,
            pais: 'ES',
            activo: true,
          },
        });
        customerId = nuevoCliente.id;
      }
    } else {
      throw badRequest('Falta el NIF del emisor en los datos extraídos.');
    }

    // Mapear líneas extraídas
    const lineas = (parsed.lineas || []).map((l) => ({
      descripcion: l.descripcion || 'Servicio',
      cantidad: l.cantidad ?? 1,
      precioUnitario: l.precioUnitario ?? (l.totalLinea ?? 0),
      descuentoPorcentaje: 0,
      tipoIva: l.tipoIva ?? 21,
      tipoRetencion: l.tipoRetencion ?? 0,
    }));

    if (lineas.length === 0) {
      throw badRequest('No hay líneas en los datos extraídos.');
    }

    // Crear factura de ingreso
    const factura = await incomeInvoicesService.crearIngreso({
      companyId,
      customer: { id: customerId },
      serie: new Date().getFullYear().toString(),
      numero: Math.floor(Math.random() * 10000), // Número temporal
      fechaEmision: parsed.fecha ?? new Date().toISOString().slice(0, 10),
      fechaVencimiento: parsed.fechaVencimiento,
      lineas,
      observaciones: `Digitalizado desde: ${documento.originalFileName}`,
    });

    // Actualizar documento como verificado
    await prisma.incomeReaderDocument.update({
      where: { id: documentId },
      data: {
        status: 'VERIFIED',
        linkedInvoiceId: factura.id,
        verifiedAt: new Date(),
      },
    });

    return await this.obtenerDetalle(companyId, documentId);
  },

  /**
   * POST /api/income-reader/:id/reject
   * Rechazar un documento.
   */
  async rechazar(companyId: string, id: string, motivo?: string): Promise<IncomeReaderDocumentResp> {
    const documento = await prisma.incomeReaderDocument.findFirst({
      where: { id, companyId },
    });

    if (!documento) {
      throw notFound('Documento no encontrado.');
    }

    const actualizado = await prisma.incomeReaderDocument.update({
      where: { id },
      data: {
        status: 'REJECTED',
        rejectionReason: motivo || 'Rechazado por el usuario',
      },
    });

    return {
      id: actualizado.id,
      companyId: actualizado.companyId,
      sourceType: actualizado.sourceType,
      originalFileName: actualizado.originalFileName,
      status: actualizado.status,
      uploadedAt: actualizado.uploadedAt,
      rejectionReason: actualizado.rejectionReason ?? undefined,
    };
  },

  /**
   * GET /api/income-reader/config/:companyId
   * Obtener configuración de email del lector.
   */
  async obtenerConfig(companyId: string): Promise<{ readerEmail: string; isActive: boolean } | null> {
    const config = await prisma.readerEmailConfig.findUnique({
      where: { companyId },
    });

    if (!config) return null;

    return {
      readerEmail: config.readerEmail,
      isActive: config.isReaderEmailActive,
    };
  },

  /**
   * POST /api/income-reader/config/:companyId
   * Crear o actualizar configuración de email del lector.
   */
  async actualizarConfig(
    companyId: string,
    readerEmail: string,
    isActive: boolean = true,
  ): Promise<{ readerEmail: string; isActive: boolean }> {
    const config = await prisma.readerEmailConfig.upsert({
      where: { companyId },
      update: { readerEmail, isReaderEmailActive: isActive },
      create: { companyId, readerEmail, isReaderEmailActive: isActive },
    });

    return {
      readerEmail: config.readerEmail,
      isActive: config.isReaderEmailActive,
    };
  },

  /**
   * Reintentar OCR de un documento en estado ERROR.
   * Se llama explícitamente (no automático).
   * Vuelve a procesar el archivo desde storagePath.
   */
  async reintentarOCR(companyId: string, documentId: string): Promise<IncomeReaderDocumentResp> {
    // Obtener documento
    const documento = await prisma.incomeReaderDocument.findFirst({
      where: { id: documentId, companyId },
    });

    if (!documento) {
      throw notFound('Documento no encontrado.');
    }

    if (documento.status !== 'ERROR') {
      throw badRequest(
        `No puedes reintentar OCR en estado ${documento.status}. Solo documentos en ERROR pueden reintentarse.`
      );
    }

    // Leer archivo desde almacenamiento
    let buffer: Buffer;
    try {
      buffer = await leerArchivoAlmacenado(documento.storagePath);
    } catch (err) {
      throw badRequest(`No se pudo leer el archivo almacenado: ${String(err)}`);
    }

    // Procesar OCR (usa la misma lógica que background)
    await procesarDocumentoEnBackground(documentId, companyId, buffer, documento.mimeType);

    // Devolver estado actualizado
    return this.obtenerDetalle(companyId, documentId);
  },
};
