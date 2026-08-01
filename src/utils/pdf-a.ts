/**
 * Generador de PDF/A (archivable) en JS puro, sin binarios nativos -> corre en
 * Vercel serverless. Sustituye a `pdf-simple` para los artefactos del Registro
 * Mercantil (libros, diligencias, cuentas), que deben conservarse en formato
 * archivable.
 *
 * Implementa los requisitos de PDF/A "por construcción":
 *  - Fuente EMBEBIDA y subdividida (PDF/A prohíbe las 14 fuentes estándar).
 *  - OutputIntent con perfil ICC sRGB (color independiente de dispositivo).
 *  - Metadato XMP con el identificador pdfaid (part/conformance), consistente
 *    con el diccionario Info.
 *  - Identificador de fichero /ID en el trailer.
 *
 * CONFORMIDAD: por defecto **PDF/A-2b** porque pdf-lib emite cabecera PDF 1.7
 * (PDF/A-2 se basa en PDF 1.7). PDF/A-1b exige PDF 1.4, que pdf-lib no genera
 * limpiamente; se ofrece como opción `conformance: '1B'` pero su certificación
 * estricta requeriría forzar la versión 1.4 (post-proceso).
 *
 * VALIDACIÓN: el cumplimiento se da por construcción; la CERTIFICACIÓN formal
 * (veraPDF) es un paso de CI/manual fuera del runtime serverless, no aquí.
 */
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

export type ConformidadPdfA = '1B' | '2B';

const PRODUCTOR = 'conta-api';

// A4 en puntos PostScript.
const A4_ANCHO = 595.28;
const A4_ALTO = 841.89;
const MARGEN_X = 50;
const TITULO_Y = 800;
const PRIMERA_LINEA_Y = 770;
const INTERLINEADO = 13;
const LINEAS_POR_PAGINA = 54;
const TAM_TITULO = 14;
const TAM_LINEA = 9;

/**
 * Resuelve la carpeta de assets de forma robusta en local y en Vercel
 * serverless (donde el bundle se ejecuta desde process.cwd()). Mismo patrón que
 * la KB de Carmen; los .ttf/.icc viajan al bundle vía vercel.json includeFiles.
 */
function resolverAssetsDir(): string {
  const candidatos = [
    path.resolve(process.cwd(), 'src/assets/pdfa'),
    path.resolve(__dirname, '../assets/pdfa'),
  ];
  return candidatos.find((c) => fs.existsSync(c)) ?? candidatos[0];
}

// Carga perezosa y cacheada de los assets (se leen una vez por instancia).
let fontCache: Buffer | undefined;
let iccCache: Buffer | undefined;

function cargarFont(): Buffer {
  if (!fontCache) fontCache = fs.readFileSync(path.join(resolverAssetsDir(), 'Roboto-Regular.ttf'));
  return fontCache;
}
function cargarIcc(): Buffer {
  if (!iccCache) iccCache = fs.readFileSync(path.join(resolverAssetsDir(), 'sRGB.icc'));
  return iccCache;
}

/** Escapa los caracteres especiales de XML para el XMP. */
function escaparXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Fecha en formato XMP/ISO-8601 con zona (requisito de consistencia PDF/A). */
function fechaXmp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function construirXmp(titulo: string, part: '1' | '2', fecha: Date): string {
  const t = escaparXml(titulo);
  const f = fechaXmp(fecha);
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
   <pdfaid:part>${part}</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${t}</rdf:li></rdf:Alt></dc:title>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
   <xmp:CreateDate>${f}</xmp:CreateDate>
   <xmp:ModifyDate>${f}</xmp:ModifyDate>
   <xmp:CreatorTool>${PRODUCTOR}</xmp:CreatorTool>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <pdf:Producer>${PRODUCTOR}</pdf:Producer>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/**
 * Genera un PDF/A (por defecto 2b) de A4 con un título y líneas de texto
 * monoespaciadas/normales, equivalente en contenido a `generarPdfSimple` pero
 * archivable. Devuelve el Buffer del PDF.
 */
export async function generarPdfA(
  titulo: string,
  lineas: string[],
  opts: { conformance?: ConformidadPdfA } = {},
): Promise<Buffer> {
  const conformance = opts.conformance ?? '2B';
  const part = conformance.startsWith('1') ? '1' : '2';
  const fecha = new Date();

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(cargarFont(), { subset: true });

  // Info dict (consistente con el XMP).
  doc.setTitle(titulo);
  doc.setCreator(PRODUCTOR);
  doc.setProducer(PRODUCTOR);
  doc.setCreationDate(fecha);
  doc.setModificationDate(fecha);

  // Paginación del contenido.
  const total = Math.max(1, lineas.length);
  for (let i = 0; i < total; i += LINEAS_POR_PAGINA) {
    const page = doc.addPage([A4_ANCHO, A4_ALTO]);
    page.drawText(titulo, { x: MARGEN_X, y: TITULO_Y, size: TAM_TITULO, font });
    let y = PRIMERA_LINEA_Y;
    for (const linea of lineas.slice(i, i + LINEAS_POR_PAGINA)) {
      page.drawText(linea, { x: MARGEN_X, y, size: TAM_LINEA, font });
      y -= INTERLINEADO;
    }
  }

  // OutputIntent + perfil ICC sRGB embebido (color independiente de dispositivo).
  const iccStream = doc.context.stream(cargarIcc(), { N: 3 });
  const iccRef = doc.context.register(iccStream);
  const outputIntent = doc.context.obj({
    Type: 'OutputIntent',
    S: 'GTS_PDFA1', // subtipo estándar del OutputIntent PDF/A (válido para 1 y 2)
    OutputConditionIdentifier: PDFString.of('sRGB IEC61966-2.1'),
    Info: PDFString.of('sRGB IEC61966-2.1'),
    DestOutputProfile: iccRef,
  });
  doc.catalog.set(PDFName.of('OutputIntents'), doc.context.obj([outputIntent]));

  // Metadato XMP (plaintext, sin filtro) con el identificador pdfaid.
  const xmp = construirXmp(titulo, part, fecha);
  const metaStream = doc.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' });
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(metaStream));

  // /ID en el trailer (obligatorio en PDF/A).
  const id = PDFHexString.of(randomBytes(16).toString('hex').toUpperCase());
  doc.context.trailerInfo.ID = doc.context.obj([id, id]);

  // useObjectStreams:false -> tabla xref clásica (PDF/A-1 prohíbe object streams;
  // inofensivo para 2b y maximiza compatibilidad con validadores).
  const bytes = await doc.save({ useObjectStreams: false });
  return Buffer.from(bytes);
}
