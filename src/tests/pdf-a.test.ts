import { generarPdfA } from '../utils/pdf-a';

describe('generarPdfA (PDF/A archivable)', () => {
  it('produce un PDF válido con las marcas estructurales de PDF/A', async () => {
    const pdf = await generarPdfA('Libro Diario 2026', ['Asiento 1 ...', 'Asiento 2 ...']);
    const s = pdf.toString('latin1');

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(s.endsWith('%%EOF') || s.trimEnd().endsWith('%%EOF')).toBe(true);

    // OutputIntent con subtipo PDF/A y perfil ICC
    expect(s).toContain('/OutputIntents');
    expect(s).toContain('/GTS_PDFA1');
    expect(s).toContain('/DestOutputProfile');

    // Metadato XMP con identificador pdfaid (stream en texto plano)
    expect(s).toContain('/Metadata');
    expect(s).toContain('http://www.aiim.org/pdfa/ns/id/');
    expect(s).toContain('<pdfaid:conformance>B</pdfaid:conformance>');

    // Fuente embebida (TrueType -> FontFile2); NO fuentes estándar-14
    expect(s).toContain('/FontFile2');

    // Identificador de fichero en el trailer
    expect(s).toContain('/ID');
  });

  it('por defecto declara PDF/A-2 y admite forzar 1b', async () => {
    const def = (await generarPdfA('T', ['x'])).toString('latin1');
    expect(def).toContain('<pdfaid:part>2</pdfaid:part>');

    const uno = (await generarPdfA('T', ['x'], { conformance: '1B' })).toString('latin1');
    expect(uno).toContain('<pdfaid:part>1</pdfaid:part>');
  });

  it('pagina el contenido (más de 54 líneas => varias páginas)', async () => {
    const muchas = Array.from({ length: 120 }, (_, i) => `Linea ${i + 1}`);
    const pdf = await generarPdfA('Largo', muchas);
    const s = pdf.toString('latin1');
    const paginas = (s.match(/\/Type\s*\/Page(?![s])/g) || []).length;
    expect(paginas).toBeGreaterThanOrEqual(3);
  });
});
