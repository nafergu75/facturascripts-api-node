/**
 * Generador de PDF MINIMO sin dependencias: una o varias paginas A4 con lineas
 * de texto monoespaciado (Courier). Suficiente para la "copia en PDF" del
 * modelo (titulo + casillas), como la descarga del video.
 * TODO: maquetacion real con plantilla oficial (pdfkit/puppeteer) si se quiere
 * replicar el formulario AEAT pixel a pixel.
 */
const sinAcentos = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7E]/g, '?');

const escaparPdf = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

const LINEAS_POR_PAGINA = 54;

export function generarPdfSimple(titulo: string, lineas: string[]): Buffer {
  // Trocear en paginas
  const paginas: string[][] = [];
  for (let i = 0; i < Math.max(1, lineas.length); i += LINEAS_POR_PAGINA) {
    paginas.push(lineas.slice(i, i + LINEAS_POR_PAGINA));
  }

  const objetos: string[] = [];
  const idsPagina: number[] = [];
  // obj 1 = catalogo, obj 2 = pages, obj 3 = fuente; paginas y contenidos despues
  let nextId = 4;
  const contenidos: Array<{ pageId: number; contId: number; body: string }> = [];

  for (const pag of paginas) {
    const pageId = nextId++;
    const contId = nextId++;
    idsPagina.push(pageId);
    let texto = 'BT /F1 14 Tf 50 800 Td (' + escaparPdf(sinAcentos(titulo)) + ') Tj ET\n';
    let y = 770;
    for (const linea of pag) {
      texto += 'BT /F1 9 Tf 50 ' + y + ' Td (' + escaparPdf(sinAcentos(linea)) + ') Tj ET\n';
      y -= 13;
    }
    contenidos.push({ pageId, contId, body: texto });
  }

  objetos[1] = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  objetos[2] =
    '2 0 obj\n<< /Type /Pages /Kids [' + idsPagina.map((id) => `${id} 0 R`).join(' ') + `] /Count ${idsPagina.length} >>\nendobj\n`;
  objetos[3] = '3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>\nendobj\n';
  for (const c of contenidos) {
    objetos[c.pageId] =
      `${c.pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${c.contId} 0 R >>\nendobj\n`;
    objetos[c.contId] = `${c.contId} 0 obj\n<< /Length ${Buffer.byteLength(c.body)} >>\nstream\n${c.body}endstream\nendobj\n`;
  }

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i < nextId; i++) {
    offsets[i] = Buffer.byteLength(pdf);
    pdf += objetos[i];
  }
  const xrefPos = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${nextId}\n0000000000 65535 f \n`;
  for (let i = 1; i < nextId; i++) {
    pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += `trailer\n<< /Size ${nextId} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
