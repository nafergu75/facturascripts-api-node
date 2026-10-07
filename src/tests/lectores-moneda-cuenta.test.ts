/**
 * Test ESTATICO (lee el codigo fuente, sin BD): la contabilidad, los libros,
 * los modelos de la AEAT y los informes leen SIEMPRE las columnas en la moneda
 * de cuenta (baseTotal, ivaTotal, baseLine...), nunca las de la moneda del
 * documento (*Doc). Si un fichero fiscal o contable lee un campo *Doc, falla,
 * salvo que la linea lo justifique con el comentario `// moneda-doc: <motivo>`
 * (p. ej. el archivo, que ensena el total en divisa como dato secundario).
 *
 * Y el tipo de cambio y los importes de cuenta de una factura de venta solo
 * los escribe income-invoices.service.ts (asi no hay dos sitios que conviertan).
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const SRC = join(__dirname, '..');

/** Ficheros que alimentan contabilidad, libros, modelos e informes. */
const LECTORES_DE_CUENTA = [
  'services/accounting-engine.service.ts',
  'controllers/accounting-engine.controller.ts',
  'services/accounting-hooks.service.ts',
  'services/impuestosCalculo.service.ts',
  'services/impuestosExport.service.ts',
  'services/impuestosModulo.service.ts',
  'services/tax-models.service.ts',
  'services/tax-documents.service.ts',
  'controllers/movements.controller.ts',
  'services/archivoFacturas.service.ts',
  'services/invoice-archiving.service.ts',
  'services/reports.service.ts',
  'services/informesContables.service.ts',
  'services/informesContables.calculo.ts',
  'services/informesContables.documentos.ts',
];

/** Identificadores que acaban en Doc pero no son importes en la moneda del documento. */
const NO_SON_IMPORTES = new Set(['tipoDoc', 'tituloDoc']);

const JUSTIFICADA = /\/\/\s*moneda-doc:\s*\S/;

function lineasConDoc(fichero: string): string[] {
  const texto = readFileSync(join(SRC, fichero), 'utf8');
  const fallos: string[] = [];
  texto.split(/\r?\n/).forEach((linea, i) => {
    // Sin los comentarios de bloque o de linea (salvo la justificacion).
    const codigo = linea.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '').replace(/\/\*.*?\*\//g, '');
    const usados = (codigo.match(/\b\w+Doc\b/g) ?? []).filter((id) => !NO_SON_IMPORTES.has(id));
    if (usados.length && !JUSTIFICADA.test(linea)) fallos.push(`${fichero}:${i + 1}: ${usados.join(', ')}`);
  });
  return fallos;
}

function ficherosTs(dir: string): string[] {
  const out: string[] = [];
  for (const nombre of readdirSync(dir)) {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) {
      if (nombre !== 'tests' && nombre !== 'node_modules') out.push(...ficherosTs(ruta));
    } else if (nombre.endsWith('.ts')) out.push(ruta);
  }
  return out;
}

/** Texto de los argumentos de una llamada a partir del parentesis que la abre (con parentesis equilibrados). */
function argumentos(texto: string, abre: number): string {
  let nivel = 0;
  for (let i = abre; i < texto.length; i++) {
    if (texto[i] === '(') nivel++;
    else if (texto[i] === ')' && --nivel === 0) return texto.slice(abre + 1, i);
  }
  return texto.slice(abre + 1);
}

describe('lectores en moneda de cuenta', () => {
  it('existen todos los ficheros revisados (si se mueve uno, hay que actualizar la lista)', () => {
    for (const f of LECTORES_DE_CUENTA) expect(() => statSync(join(SRC, f))).not.toThrow();
  });

  it('ningun fichero fiscal o contable lee un campo *Doc (moneda del documento) sin justificarlo', () => {
    const fallos = LECTORES_DE_CUENTA.flatMap(lineasConDoc);
    expect(fallos).toEqual([]);
  });

  it('la regla detecta una lectura *Doc y acepta la justificada', () => {
    const detecta = (linea: string) => {
      const codigo = linea.replace(/\/\/.*$/, '');
      const usados = (codigo.match(/\b\w+Doc\b/g) ?? []).filter((id) => !NO_SON_IMPORTES.has(id));
      return usados.length > 0 && !JUSTIFICADA.test(linea);
    };
    expect(detecta('const base = f.baseTotalDoc ?? f.baseTotal;')).toBe(true);
    expect(detecta('const total = f.totalFacturaDoc; // moneda-doc: dato secundario')).toBe(false);
    expect(detecta('const base = f.baseTotal; // no lee las *Doc')).toBe(false);
    expect(detecta("const tipoDoc = 'INGRESO';")).toBe(false);
  });

  it('el tipo de cambio y los importes de cuenta de una factura de venta solo se escriben en income-invoices.service.ts', () => {
    const PROHIBIDOS = /\b(tipoCambio|fuenteTipoCambio|fechaTipoCambio|baseTotal|ivaTotal|retencionTotal|totalFactura)\w*\b/;
    const fallos: string[] = [];
    for (const ruta of ficherosTs(SRC)) {
      const rel = relative(SRC, ruta).split(sep).join('/');
      if (rel === 'services/income-invoices.service.ts') continue;
      const texto = readFileSync(ruta, 'utf8');
      const re = /incomeInvoice\.(create|createMany|update|updateMany|upsert)\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(texto))) {
        const args = argumentos(texto, m.index + m[0].length - 1);
        const prohibido = PROHIBIDOS.exec(args);
        if (prohibido) fallos.push(`${rel}: incomeInvoice.${m[1]} escribe ${prohibido[1]}`);
      }
    }
    expect(fallos).toEqual([]);
  });
});
