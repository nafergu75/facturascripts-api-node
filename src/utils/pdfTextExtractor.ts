/**
 * PDF Text Extractor
 * Extrae texto de PDFs (especialmente los procesados por iLovePDF OCR)
 * Usa la librería pdf-parse: https://github.com/modesty/pdf-parse
 */

import * as fs from 'fs';
import { logger } from '../config/logger';

export interface ExtractedText {
  text: string;
  pages: number;
  pageTexts?: string[]; // Texto por página si se solicita
  rawCharCount: number;
  cleanCharCount: number;
}

/**
 * Extrae texto de un archivo PDF
 * Optimizado para PDFs resultantes de OCR (searchable PDFs)
 */
export async function extractTextFromPdf(
  filePath: string,
  options?: {
    returnPageTexts?: boolean; // Si true, retorna array de texto por página
    minimalCleanup?: boolean; // Si true, evita limpieza agresiva
  }
): Promise<ExtractedText> {
  try {
    // Validar que el archivo existe
    if (!fs.existsSync(filePath)) {
      throw new Error(`PDF file not found: ${filePath}`);
    }

    logger.debug(`[PDFExtractor] Extrayendo texto de: ${filePath}`);

    // Leer el archivo como buffer
    const fileBuffer = fs.readFileSync(filePath);

    // Procesar el PDF
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pdfParse = require('pdf-parse') as any;
    const pdfData = await pdfParse(fileBuffer);
    const { numpages } = pdfData;

    logger.debug(`[PDFExtractor] PDF tiene ${numpages} páginas`);

    // Extraer texto página por página
    const pageTexts: string[] = [];
    let fullText = '';

    for (let i = 1; i <= numpages; i++) {
      // Nota: pdf-parse no proporciona acceso directo al contenido por página
      // La mejor alternativa es usar pdfData.text que contiene todo el texto
      // Si necesitas texto exacto por página, considera usar pdfjs-dist
      // Por ahora, aproximamos dividiendo por saltos de página comunes
    }

    // Obtener texto completo del PDF
    let rawText = pdfData.text || '';
    const rawCharCount = rawText.length;

    // Limpieza del texto para mejorar calidad
    // Se evita limpieza excesiva para no perder estructura
    let cleanText = rawText;

    if (!options?.minimalCleanup) {
      // Normalizar saltos de línea múltiples
      cleanText = cleanText.replace(/\n{3,}/g, '\n\n');

      // Remover espacios múltiples (pero preservar estructura básica)
      cleanText = cleanText.replace(/[ \t]{2,}/g, ' ');

      // Trimear espacios en blanco al inicio/fin de líneas
      cleanText = cleanText
        .split('\n')
        .map((line: string) => line.trim())
        .join('\n');

      // Remover líneas completamente vacías excesivas
      cleanText = cleanText.replace(/^\s*[\r\n]/gm, '');
    }

    // Remover caracteres de control problemáticos (pero preservar saltos de línea)
    cleanText = cleanText.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');

    const cleanCharCount = cleanText.length;

    logger.info(
      `[PDFExtractor] Texto extraído: ${numpages} páginas, ${rawCharCount} chars brutos, ${cleanCharCount} chars limpios`
    );

    const result: ExtractedText = {
      text: cleanText,
      pages: numpages,
      rawCharCount,
      cleanCharCount,
    };

    // Si se solicita, devolver texto por página
    if (options?.returnPageTexts) {
      // Para obtener texto exacto por página, se necesitaría pdfjs-dist
      // Por ahora, aproximamos dividiendo por saltos de página detectados
      // En una implementación real, considera usar pdfjs-dist para precisión
      result.pageTexts = approximatePageTexts(cleanText, numpages);
    }

    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error(`[PDFExtractor] Error extrayendo texto: ${errorMsg}`);
    throw new Error(`Failed to extract text from PDF: ${errorMsg}`);
  }
}

/**
 * Extrae texto de múltiples PDFs
 * Útil para procesar lotes de facturas
 */
export async function extractTextFromPdfBatch(
  filePaths: string[],
  options?: {
    returnPageTexts?: boolean;
    minimalCleanup?: boolean;
  }
): Promise<Array<{ filePath: string; data: ExtractedText } | { filePath: string; error: string }>> {
  const results = [];

  for (const filePath of filePaths) {
    try {
      const data = await extractTextFromPdf(filePath, options);
      results.push({ filePath, data });
      logger.debug(`[PDFExtractor] Procesado: ${filePath}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      results.push({ filePath, error: errorMsg });
      logger.warn(`[PDFExtractor] Error en ${filePath}: ${errorMsg}`);
    }
  }

  return results;
}

/**
 * Valida si un archivo es un PDF válido sin necesidad de extraer texto
 */
export async function validatePdfFile(filePath: string): Promise<{ isValid: boolean; pages?: number; error?: string }> {
  try {
    if (!fs.existsSync(filePath)) {
      return { isValid: false, error: 'File not found' };
    }

    const stats = fs.statSync(filePath);

    // Validar magia de bytes para PDF (%PDF)
    const buffer = Buffer.alloc(4);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, 4, 0);
    fs.closeSync(fd);

    if (buffer.toString('utf-8', 0, 4) !== '%PDF') {
      return { isValid: false, error: 'Invalid PDF file (magic bytes check failed)' };
    }

    // Intentar leer estructura mínima del PDF
    const fileBuffer = fs.readFileSync(filePath);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pdfParse = require('pdf-parse') as any;
    const pdfData = await pdfParse(fileBuffer);

    return {
      isValid: true,
      pages: pdfData.numpages,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return { isValid: false, error: errorMsg };
  }
}

/**
 * Aproxima texto por página dividiendo el texto completo
 * Nota: No es perfectamente preciso, pero funciona como aproximación
 * Para precisión total, usar pdfjs-dist
 */
function approximatePageTexts(text: string, estimatedPages: number): string[] {
  if (estimatedPages <= 1) {
    return [text];
  }

  // Dividir el texto en aproximadamente el número de páginas
  const charsPerPage = Math.ceil(text.length / estimatedPages);
  const pages: string[] = [];

  for (let i = 0; i < estimatedPages; i++) {
    const start = i * charsPerPage;
    const end = Math.min((i + 1) * charsPerPage, text.length);
    pages.push(text.substring(start, end).trim());
  }

  return pages;
}

export default {
  extractTextFromPdf,
  extractTextFromPdfBatch,
  validatePdfFile,
};
