/**
 * Exportacion de los informes contables a PDF y Excel (sin BD): que salgan
 * Debe, Haber y Saldo legibles, cada cifra bajo su titulo de columna, con los
 * importes enteros (hasta 9.999.999,99) y el saldo a cero escrito.
 */
import { describe, it, expect } from '@jest/globals';
import * as XLSX from 'xlsx';
import { PDFDocument } from 'pdf-lib';
import { aImporte, fechaES, num, tablaAPdf, tablaAXlsx, textoCelda, type TablaInforme } from '../services/informesContables.documentos';
import { escaparXml, letraColumna, nombreHoja } from '../utils/hojaExcel';
import { hoyEspana } from '../utils/fechas';
import { textosDePdf } from './texto-pdf';
import { fallosColumnasPdf, fallosColumnasXlsx, FILA_CABECERA_XLSX } from './columnas-informe';

/** Mayor de un cliente: saldo inicial, cargo grande, cobro que lo deja a cero, abono en negativo y anticipo. */
const detalle = (extra: Partial<TablaInforme> = {}): TablaInforme => ({
  titulo: 'Mayor del cliente Distribuciones Cerámicas del Mediterráneo SL',
  periodo: 'Ejercicio 2026 · NIF B12345678',
  empresa: { nombre: 'Empresa Ñandú SL', nif: 'B87654321' },
  apaisado: true,
  columnas: [
    { titulo: 'Fecha', tipo: 'fecha', ancho: 1.7 },
    { titulo: 'Asiento', tipo: 'codigo', ancho: 2.4 },
    { titulo: 'Concepto', tipo: 'texto', ancho: 6.5 },
    { titulo: 'Factura', tipo: 'texto', ancho: 2.2 },
    { titulo: 'Debe', tipo: 'importe', ancho: 2 },
    { titulo: 'Haber', tipo: 'importe', ancho: 2 },
    { titulo: 'Saldo', tipo: 'importe', ancho: 2, saldo: true },
  ],
  filas: [
    { celdas: [null, null, 'Saldo inicial', null, null, null, 1200], estilo: 'nota' },
    {
      celdas: ['2026-01-15', 'FAC-ING-2026-000001', 'Factura de ingreso #A-1 - Distribuciones Cerámicas del Mediterráneo y Baleares SL, pavimento de la obra', 'A-1', 9999999.99, 0, 10001199.99],
    },
    { celdas: ['2026-02-01', 'COBRO-00001', 'Cobro factura A-1', 'A-1', 0, 10001199.99, 0] },
    { celdas: ['2026-04-20', 'FAC-ING-R-1', 'Factura de ingreso #R-1 (rectificativa)', 'R-1', -1730.91, 0, -1730.91] },
    { celdas: ['2026-06-30', 'AJ-0001', 'Anticipo recibido por transferencia', null, 0, 12500, -14230.91] },
    { celdas: [null, null, 'Totales y saldo final', null, 9998269.08, 10013699.99, -14230.91], estilo: 'total' },
  ],
  notas: ['Saldo positivo: lo que nos debe.'],
  fichero: 'mayor_cliente',
  ...extra,
});

describe('formato de las cifras', () => {
  it('miles con punto, dos decimales con coma y el signo menos', () => {
    expect(num(1234.5)).toBe('1.234,50');
    expect(num(8654.68)).toBe('8.654,68');
    expect(num(9999999.99)).toBe('9.999.999,99');
    expect(num(-1730.91)).toBe('−1.730,91');
    expect(num(0)).toBe('0,00');
    expect(num(-0.001)).toBe('0,00');
  });

  it('un importe que llega como texto o como Decimal se lee como numero', () => {
    expect(aImporte('1234.50')).toBe(1234.5);
    expect(aImporte({ toNumber: () => 8654.68 })).toBe(8654.68);
    expect(aImporte('A-1')).toBeNull();
    const col = { tipo: 'importe' as const };
    expect(textoCelda('367292.46', col)).toBe('367.292,46');
  });

  it('el cero de Debe y Haber se deja en blanco; el de un saldo, no', () => {
    expect(textoCelda(0, { tipo: 'importe' }, 'normal')).toBe('');
    expect(textoCelda(0, { tipo: 'importe', saldo: true }, 'normal')).toBe('0,00');
    expect(textoCelda(0, { tipo: 'importe' }, 'total')).toBe('0,00');
  });
});

describe('PDF', () => {
  it('apaisado: Debe, Haber y Saldo con todas sus cifras, cada una bajo su titulo', async () => {
    const pdf = await tablaAPdf(detalle());
    const doc = await PDFDocument.load(pdf);
    const { width, height } = doc.getPages()[0].getSize();
    expect(width).toBeGreaterThan(height);
    const textos = await textosDePdf(pdf);
    const todo = textos.map((t) => t.texto);
    expect(todo).toEqual(expect.arrayContaining(['DEBE', 'HABER', 'SALDO', 'Saldo inicial', 'Totales y saldo final']));
    expect(todo).toEqual(expect.arrayContaining(['1.200,00', '9.999.999,99', '10.001.199,99', '0,00', '−1.730,91', '12.500,00', '−14.230,91', '9.998.269,08', '10.013.699,99']));
    expect(fallosColumnasPdf(detalle(), textos)).toEqual([]);
  });

  it('el saldo que queda a cero tras un cobro se escribe (0,00) en la columna Saldo', async () => {
    const textos = await textosDePdf(await tablaAPdf(detalle()));
    const cobro = textos.find((t) => t.texto === 'COBRO-00001')!;
    const saldo = textos.find((t) => t.texto === 'SALDO')!;
    const enLaFila = textos.filter((t) => t.y === cobro.y);
    expect(enLaFila.find((t) => t.texto === '0,00')?.derecha).toBeCloseTo(saldo.derecha, 0);
  });

  it('en vertical cede el concepto (se recorta con «…»), nunca los importes', async () => {
    const t = detalle({ apaisado: false });
    const textos = await textosDePdf(await tablaAPdf(t));
    expect(fallosColumnasPdf(t, textos)).toEqual([]);
    expect(textos.some((x) => x.texto.endsWith('…'))).toBe(true);
    expect(textos.map((x) => x.texto)).toEqual(expect.arrayContaining(['9.999.999,99', '10.013.699,99']));
  });

  it('con muchas filas, la cabecera se repite en cada pagina y nada se corre', async () => {
    const base = detalle();
    let saldo = 1200;
    const movimientos = Array.from({ length: 90 }, (_, i) => {
      const debe = i % 2 ? 0 : 1000 + i;
      const haber = i % 2 ? 1000 + i - 1 : 0;
      saldo = Math.round((saldo + debe - haber) * 100) / 100;
      return { celdas: ['2026-03-01', `FAC-${i}`, `Movimiento ${i}`, null, debe, haber, saldo] as Array<string | number | null> };
    });
    const t: TablaInforme = { ...base, filas: [base.filas[0], ...movimientos, { celdas: [null, null, 'Totales y saldo final', null, 1, 1, saldo], estilo: 'total' }] };
    const pdf = await tablaAPdf(t);
    const textos = await textosDePdf(pdf);
    const paginas = (await PDFDocument.load(pdf)).getPageCount();
    expect(paginas).toBeGreaterThan(1);
    expect(textos.filter((x) => x.texto === 'DEBE').length).toBe(paginas);
    expect(textos.filter((x) => x.texto === 'SALDO').length).toBe(paginas);
    expect(fallosColumnasPdf(t, textos)).toEqual([]);
  });

  it('un titulo largo se parte en dos lineas en vez de pisar al de al lado', async () => {
    const t: TablaInforme = {
      titulo: 'Mayor de clientes',
      periodo: 'Ejercicio 2026',
      empresa: { nombre: 'Empresa SL', nif: '' },
      apaisado: true,
      columnas: [
        { titulo: 'Cliente', tipo: 'texto', ancho: 6 },
        { titulo: 'NIF', tipo: 'codigo', ancho: 2 },
        { titulo: 'Subcuenta', tipo: 'codigo', ancho: 2.4 },
        { titulo: 'Saldo inicial', tipo: 'importe', ancho: 2, saldo: true },
        { titulo: 'Debe', tipo: 'importe', ancho: 2 },
        { titulo: 'Haber', tipo: 'importe', ancho: 2 },
        { titulo: 'Saldo final', tipo: 'importe', ancho: 2, saldo: true },
        { titulo: 'Pendiente s/ facturas', tipo: 'importe', ancho: 2.2, saldo: true },
      ],
      filas: [
        { celdas: ['Distribuciones Cerámicas del Mediterráneo y Baleares SL', 'B46079190', '43000001', 0, 375947.14, 171154.68, 204792.46, 219712.46] },
        { celdas: ['Total (1)', null, null, 0, 375947.14, 171154.68, 204792.46, null], estilo: 'total' },
      ],
      fichero: 'mayor_clientes',
    };
    const textos = await textosDePdf(await tablaAPdf(t));
    expect(fallosColumnasPdf(t, textos)).toEqual([]);
    // El saldo inicial a cero de la fila normal se escribe.
    expect(textos.filter((x) => x.texto === '0,00').length).toBe(2);
  });

  it('el asiento mas largo de su columna sale entero, sin «…» por redondeo (6, 12 y 27 caracteres)', async () => {
    // La columna mide justo lo que su codigo mas largo: con 57,6 + 10 − 10 = 57,5999… se recortaba «FAC-ING-A-…».
    for (const codigos of [['AJ-001', 'AJ-002'], ['FAC-ING-A-10', 'FAC-ING-A-43', 'COBRO-00012'], ['FAC-GAST-2026/INV-000123456', 'PAGO-00001']]) {
      for (const apaisado of [true, false]) {
        const base = detalle({ apaisado });
        let i = 0;
        const filas = base.filas.map((f) => ((f.estilo ?? 'normal') === 'normal' ? { ...f, celdas: f.celdas.map((v, k) => (k === 1 ? codigos[i++ % codigos.length] : v)) } : f));
        const t = { ...base, filas };
        const textos = await textosDePdf(await tablaAPdf(t));
        expect(fallosColumnasPdf(t, textos)).toEqual([]);
        expect(textos.map((x) => x.texto)).toEqual(expect.arrayContaining(codigos));
      }
    }
  });

  it('una nota larga pasa a otra linea en vez de cortarse, y el pie conserva entera la fecha de generacion', async () => {
    // Como en el aviso real, cifra y «€» con espacio duro: la linea nunca se parte entre los dos.
    const ventas = Array.from({ length: 30 }, (_, i) => `A-${100 + i} (2.420,00\u00a0€)`).join(', ');
    const nota = `Atención: las ventas ${ventas} no tienen asiento y no salen en el mayor. Contabilízalas desde la ficha de cada factura.`;
    const t = detalle({
      apaisado: false,
      titulo: 'Mayor del cliente Distribuciones Cerámicas del Mediterráneo y Baleares Sociedad Limitada',
      periodo: 'Ejercicio 2026 · NIF B12345678 · Subcuentas 4300000001 y 4300000002',
      notas: ['Saldo positivo: lo que nos debe.', nota],
    });
    const textos = await textosDePdf(await tablaAPdf(t));
    const lineas = textos.filter((x) => x.tam === 7.5).map((x) => x.texto);
    expect(lineas.length).toBeGreaterThan(2);
    expect(lineas.some((l) => l.endsWith('…'))).toBe(false);
    expect(lineas.some((l) => l.startsWith('€'))).toBe(false);
    expect(lineas.join(' ')).toBe(`Saldo positivo: lo que nos debe. ${nota}`);
    // Pie: se recorta el titulo, nunca «Generado el dd/mm/aaaa».
    const pie = textos.find((x) => x.tam === 7 && x.texto.includes('Generado el'))!;
    expect(pie.texto.endsWith(` · Generado el ${fechaES(hoyEspana())}`)).toBe(true);
    expect(pie.texto).toContain('…');
  });
});

describe('Excel', () => {
  const leer = (buf: Buffer) => XLSX.read(buf, { type: 'buffer', cellStyles: true, cellNF: true });
  /** XML de una parte del .xlsx. */
  const parte = (buf: Buffer, ruta: string) => {
    const zip = XLSX.CFB.read(buf, { type: 'buffer' });
    const i = zip.FullPaths.findIndex((p: string) => p.endsWith(ruta));
    return Buffer.from(zip.FileIndex[i].content).toString('utf8');
  };

  it('cada celda en su columna, importes como numeros, fechas como fechas y anchos suficientes', () => {
    const buf = tablaAXlsx(detalle());
    expect(fallosColumnasXlsx(detalle(), buf)).toEqual([]);
    const ws = leer(buf).Sheets[leer(buf).SheetNames[0]];
    // Titulos justo encima de los datos (fila 5); empresa, titulo y periodo arriba.
    expect(ws['A1'].v).toContain('Empresa Ñandú SL');
    expect(ws['A2'].v).toBe(detalle().titulo);
    expect(ws['E5'].v).toBe('Debe');
    expect(ws['F5'].v).toBe('Haber');
    expect(ws['G5'].v).toBe('Saldo');
    expect(FILA_CABECERA_XLSX).toBe(4);
    // Saldo inicial: el texto en Concepto y la cifra en Saldo; Debe y Haber vacios.
    expect(ws['C6'].v).toBe('Saldo inicial');
    expect(ws['E6']?.v).toBeUndefined();
    expect(ws['G6']).toMatchObject({ t: 'n', v: 1200 });
    // El cobro deja el saldo a cero y se ve (formato sin seccion de cero en blanco).
    expect(ws['G8']).toMatchObject({ t: 'n', v: 0, z: '#,##0.00;-#,##0.00' });
    // Totales: suma del Debe, del Haber y saldo final, cada uno en su columna.
    expect([ws['C11'].v, ws['E11'].v, ws['F11'].v, ws['G11'].v]).toEqual(['Totales y saldo final', 9998269.08, 10013699.99, -14230.91]);
    // Anchos: fecha 11 como poco, importes 14 y la cifra mas larga entera.
    const cols = ws['!cols'] as Array<{ width: number }>;
    expect(cols[0].width).toBeGreaterThanOrEqual(11);
    for (const k of [4, 5, 6]) expect(cols[k].width).toBeGreaterThanOrEqual(num(10013699.99).length + 1);
    // El concepto, como mucho 60 y con el texto ajustado.
    expect(cols[2].width).toBeLessThanOrEqual(61);
  });

  it('cabecera y totales destacados, fila de titulos fija, autofiltro e impresion apaisada ajustada al ancho', () => {
    const buf = tablaAXlsx(detalle());
    const hoja = parte(buf, 'xl/worksheets/sheet1.xml');
    const estilos = parte(buf, 'xl/styles.xml');
    const libro = parte(buf, 'xl/workbook.xml');
    expect(hoja).toContain('<pane ySplit="5" topLeftCell="A6" activePane="bottomLeft" state="frozen"/>');
    // El total final queda fuera del autofiltro (fila 11): al filtrar sigue a la vista.
    expect(hoja).toContain('<autoFilter ref="A5:G10"/>');
    expect(hoja).toContain('orientation="landscape" fitToWidth="1" fitToHeight="0"');
    expect(hoja).toContain('<pageSetUpPr fitToPage="1"/>');
    expect(libro).toContain('_xlnm.Print_Titles');
    // Estilo de la celda E5 (titulo Debe) y de G11 (saldo final): negrita, con relleno y a la derecha.
    const xfs = [...estilos.matchAll(/<xf numFmtId="(\d+)" fontId="(\d+)" fillId="(\d+)" borderId="(\d+)" xfId="0"[^>]*?(?:\/>|>(.*?)<\/xf>)/g)];
    const estiloDe = (ref: string) => xfs[Number(new RegExp(`<c r="${ref}" s="(\\d+)"`).exec(hoja)?.[1] ?? -1)];
    const debe = estiloDe('E5');
    expect(debe?.[2]).toBe('1'); // negrita
    expect(debe?.[3]).not.toBe('0'); // relleno
    expect(debe?.[5]).toContain('horizontal="right"');
    const total = estiloDe('G11');
    expect(total?.[2]).toBe('1');
    expect(total?.[3]).not.toBe('0');
    expect(estilos).toContain('<b/>');
    // «Saldo inicial»: el texto en gris (fuente 3) y la cifra en tinta normal (fuente 0), como en el PDF.
    expect(estiloDe('C6')?.[2]).toBe('3');
    expect(estiloDe('G6')?.[2]).toBe('0');
  });

  it('pie de pagina con una empresa que empieza por una cifra: no se lee como tamaño de letra', () => {
    const hoja = parte(tablaAXlsx(detalle({ empresa: { nombre: '3D Cerámicas SL', nif: '' } })), 'xl/worksheets/sheet1.xml');
    expect(hoja).toContain('<oddFooter>&amp;L&amp;8 3D Cerámicas SL · ');
    expect(parte(tablaAXlsx(detalle()), 'xl/worksheets/sheet1.xml')).toContain('<oddFooter>&amp;L&amp;8Empresa Ñandú SL · ');
  });

  it('vuelve a leerse igual (Debe, Haber y Saldo numericos) y los tres informes de 3 columnas se imprimen en vertical', () => {
    const t: TablaInforme = {
      titulo: 'Balance de situación',
      periodo: 'Ejercicio 2026',
      empresa: { nombre: 'Empresa SL', nif: 'B1' },
      columnas: [
        { titulo: 'Partida', tipo: 'texto', ancho: 9 },
        { titulo: '2026', tipo: 'importe', ancho: 2 },
        { titulo: '2025', tipo: 'importe', ancho: 2 },
      ],
      filas: [
        { celdas: ['ACTIVO', null, null], estilo: 'seccion' },
        { celdas: ['III. Deudores comerciales y otras cuentas a cobrar', 204792.46, 0], sangria: 1 },
        { celdas: ['TOTAL ACTIVO (A + B)', 375947.14, 0], estilo: 'total' },
      ],
      fichero: 'balance',
    };
    const buf = tablaAXlsx(t);
    expect(fallosColumnasXlsx(t, buf)).toEqual([]);
    expect(parte(buf, 'xl/worksheets/sheet1.xml')).toContain('orientation="portrait"');
    // La sangria va como sangria de la celda, no como espacios delante.
    expect(parte(buf, 'xl/styles.xml')).toContain('indent="1"');
  });

  it('textos con caracteres especiales y nombres de hoja validos', () => {
    expect(escaparXml('A & B <c> "d"\u0001')).toBe('A &amp; B &lt;c&gt; &quot;d&quot;');
    expect(letraColumna(0)).toBe('A');
    expect(letraColumna(25)).toBe('Z');
    expect(letraColumna(26)).toBe('AA');
    expect(nombreHoja('Mayor [2026]: clientes/proveedores?')).toBe('Mayor 2026 clientes proveedores');
    expect(nombreHoja('Balance de sumas y saldos por subcuenta')).toHaveLength(31);
    expect(nombreHoja("'''")).toBe('Informe');
    const t = detalle({ titulo: 'Mayor del cliente López & Hijos <SA>', empresa: { nombre: 'Ñandú & Cía', nif: '' } });
    const wb = XLSX.read(tablaAXlsx(t), { type: 'buffer' });
    expect(wb.SheetNames[0]).toBe('Mayor del cliente López & Hijos');
    expect(wb.Sheets[wb.SheetNames[0]]['A2'].v).toBe('Mayor del cliente López & Hijos <SA>');
  });
});
