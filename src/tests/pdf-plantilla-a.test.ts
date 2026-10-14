/**
 * PDF de la plantilla A (envases e IEEPNR), sin BD: con los 7 articulos de la
 * muestra NZ004_26, un cliente y un IBAN ficticios (el repo es publico).
 *
 *  - Las etiquetas en el orden de la muestra y cada cifra bajo su columna.
 *  - Una fila «KG Plástico» por articulo, el resumen y los totales.
 *  - 60 articulos en varias paginas: cabecera de la tabla repetida, totales y
 *    pie solo en la ultima, «Página i de n».
 *  - Con un texto al pie de hasta unos 500 caracteres, NZ004_26 sigue en una
 *    pagina; unas observaciones muy largas siguen en otra, sin salirse de la
 *    hoja ni pisar el numero de pagina.
 *  - CIF para la empresa y el cliente espanol que es sociedad, NIF para el que
 *    es persona fisica (DNI o NIE); RNC, NIF-IVA (VAT) o EIN para el de fuera.
 *  - Borrador con marca de agua, bloque de rectificativa, varios tipos de IVA,
 *    proforma y otra moneda.
 *  - renderizarFactura solo usa este diseno con la plantilla A (no en el lector).
 */
import { describe, it, expect } from '@jest/globals';
import { renderizarFactura, type DatosFacturaPdf } from '../services/facturaPdf.service';
import { COLUMNAS_A, formatosA, renderizarFacturaPlantillaA, textoRegistroA } from '../services/facturaPdfPlantillaA';
import { lineasDePdf, textosDePdf, type TextoPdf } from './texto-pdf';
import { LINEAS_NZ004, TOTALES_NZ004 } from './muestra-nz004';

const IVA_LINEAS = [114.25, 216.16, 15.05, 50.8, 21.42, 207.8, 876.57];

const datosNz = (extra: Partial<DatosFacturaPdf> = {}): DatosFacturaPdf => ({
  id: 'f1',
  numeroCompleto: 'A-1',
  estadoDocumento: 'FINAL',
  tipoFactura: 'F1',
  formaPago: 'TRANSFERENCIA',
  tipoRectificativa: null,
  motivoRectificacion: null,
  esRectificativa: false,
  fechaEmision: '2026-03-04',
  fechaVencimiento: '2026-04-03',
  baseTotal: TOTALES_NZ004.base,
  ivaTotal: TOTALES_NZ004.iva,
  retencionTotal: 0,
  totalFactura: TOTALES_NZ004.total,
  observaciones: null,
  plantilla: 'A',
  pesoBrutoKg: TOTALES_NZ004.pesoBrutoKg,
  lineas: LINEAS_NZ004.map((l, i) => ({
    descripcion: l.descripcion,
    textoAdicional: l.textoAdicional,
    packs: l.packs,
    cantidad: l.cantidad,
    kgPlastico: l.kgPlastico,
    precioUnitario: l.precioUnitario,
    descuentoPorcentaje: 0,
    tipoIva: 21,
    ivaImporte: IVA_LINEAS[i],
    baseLine: Math.round((l.totalArticulo + l.ieepnr) * 100) / 100,
    ieepnrImporte: l.ieepnr,
    tipoRetencion: 0,
  })),
  cliente: { nombreFiscal: 'CLIENTE FICTICIO BEBIDAS SL', nifCif: '00000000T', direccion: 'CALLE FALSA, 1', cp: '46000', municipio: 'VALENCIA', provincia: 'VALENCIA', pais: 'ES' },
  emisor: {
    denominacion: 'BEBIDAS DE PRUEBA S.L.',
    nif: 'B12345674',
    domicilioSocial: 'CALLE INVENTADA, 2',
    codigoPostal: '12200',
    municipio: 'ONDA',
    provincia: 'CASTELLON',
    email: 'facturas@ejemplo.test',
    pais: 'ES',
    datosRegistrales: 'T 1, L 2, F 3, S 8, H CS 4, I/A 1',
    registroMercantilProvincia: 'Castellón',
  },
  original: null,
  cuenta: { iban: 'ES9121000418450200051332', bic: 'CAIXESBBXXX', bancoNombre: 'Banco de pruebas' },
  moneda: 'EUR',
  monedaCuenta: 'EUR',
  tipoCambio: 1,
  fuenteTipoCambio: 'PAR',
  conIva: true,
  ...extra,
});

const textos = async (f: DatosFacturaPdf) => textosDePdf(await renderizarFacturaPlantillaA(f));
/** El primer texto que es exactamente `s` (o lo contiene, con `parcial`). */
const buscar = (ts: TextoPdf[], s: string, parcial = false) => ts.find((t) => (parcial ? t.texto.includes(s) : t.texto === s));
const fila = (ts: TextoPdf[], de: TextoPdf) => ts.filter((t) => t.pagina === de.pagina && Math.abs(t.y - de.y) < 0.5);
const cerca = (a: number, b: number) => Math.abs(a - b) < 0.6;

describe('PDF de la plantilla A con NZ004_26', () => {
  it('las etiquetas de la muestra, en su orden', async () => {
    const ts = await textos(datosNz());
    const orden = lineasDePdf(ts).flat().map((t) => t.texto);
    const pos = (s: string) => orden.findIndex((t) => t === s || t.startsWith(s));
    const etiquetas = [
      'BEBIDAS DE PRUEBA S.L.',
      'CIF. B12345674',
      'facturas@ejemplo.test',
      'FACTURA',
      'Nº FACTURA:',
      'FECHA:',
      'CLIENTE:',
      'CONCEPTO',
      'KG.Plast',
      'PACKS',
      'UDS',
      'IEEPNR',
      'PRECIO/UDS',
      'TOTAL',
      'PESO BRUTO(kg)',
      'Subtotal',
      'I.V.A. (21%)',
      'Total',
      'OBSERVACIONES:',
      'DATOS BANCARIOS:',
      'TITULAR:',
      'IBAN:',
      'SWIFT BANK:',
      'Inscrita en el Registro Mercantil',
    ];
    const posiciones = etiquetas.map(pos);
    expect(posiciones.every((p) => p >= 0)).toBe(true);
    expect([...posiciones].sort((a, b) => a - b)).toEqual(posiciones);
    expect(orden).toContain('A-1');
    expect(orden).toContain('04/03/2026');
    expect(orden).toContain('NIF: 00000000T');
    expect(orden).toContain('DATOS BANCARIOS:  TRANSFERENCIA BANCARIA');
    expect(orden).toContain('IBAN: ES91 2100 0418 4502 0005 1332');
    expect(orden).toContain('SWIFT BANK: CAIXESBBXXX - BANCO DE PRUEBAS');
    expect(orden).toContain('TITULAR: BEBIDAS DE PRUEBA S.L.');
    expect(orden).toContain('Inscrita en el Registro Mercantil de Castellón, T 1, L 2, F 3, S 8, H CS 4, I/A 1, con CIF: B12345674');
  });

  it('cada cifra bajo su columna: la fila del articulo y la de KG Plástico', async () => {
    const ts = await textos(datosNz());
    const F = formatosA();
    LINEAS_NZ004.forEach((l, i) => {
      const concepto = ts.filter((t) => t.texto === l.descripcion)[LINEAS_NZ004.slice(0, i).filter((x) => x.descripcion === l.descripcion).length];
      expect(concepto).toBeDefined();
      const f = fila(ts, concepto);
      const en = (s: string) => f.find((t) => t.texto === s);
      expect(cerca(en(String(l.packs))!.derecha, COLUMNAS_A.packs)).toBe(true);
      expect(cerca(en(String(l.cantidad))!.derecha, COLUMNAS_A.uds)).toBe(true);
      expect(cerca(en(F.precio(l.precioUnitario))!.derecha, COLUMNAS_A.precio)).toBe(true);
      expect(cerca(en(F.importe(l.totalArticulo))!.derecha, COLUMNAS_A.total)).toBe(true);
    });
    // Las filas «KG Plástico»: los kg bajo KG.Plast y el IEEPNR bajo IEEPNR.
    const kgs = ts.filter((t) => t.texto === 'KG Plástico');
    expect(kgs).toHaveLength(7);
    kgs.forEach((k, i) => {
      const f = fila(ts, k);
      const kg = f.find((t) => t.texto === F.kg(LINEAS_NZ004[i].kgPlastico))!;
      const ieepnr = f.find((t) => t.texto === F.importe(LINEAS_NZ004[i].ieepnr))!;
      expect(cerca(kg.derecha, COLUMNAS_A.kg)).toBe(true);
      expect(cerca(ieepnr.derecha, COLUMNAS_A.ieepnr)).toBe(true);
    });
    expect(kgs.map((k) => fila(ts, k).find((t) => t.x > 250 && t.derecha < 330)!.texto)).toEqual(['103,089', '176,17', '12,267', '56,311', '19,333', '2,489', '25,333']);
    // Los titulos de las columnas, centrados encima de sus cifras.
    const cab = (s: string) => buscar(ts, s)!;
    expect(cab('PACKS').derecha).toBeLessThan(COLUMNAS_A.packs + 1);
    expect(cab('PRECIO/UDS').x).toBeGreaterThan(445);
    // Texto adicional del articulo debajo del concepto.
    expect(buscar(ts, 'Cod. RPA Azúcar: 6B30250')).toBeDefined();
    expect(buscar(ts, 'ALC. 0,0%VOL.18,10 GRADOS PLATO')).toBeDefined();
  });

  it('resumen de envases y totales', async () => {
    const ts = await textos(datosNz());
    const peso = buscar(ts, 'PESO BRUTO(kg)')!;
    const valores = ts.filter((t) => t.pagina === peso.pagina && t.y < peso.y && t.y > peso.y - 15).map((t) => t.texto);
    expect(valores).toEqual(expect.arrayContaining(['24528,62', '394,992', '9826', '46320', '177,75 €']));
    const totales = (etq: string) => fila(ts, buscar(ts, etq)!).find((t) => t.x > 511)!.texto;
    expect(totales('Subtotal')).toBe('7.152,63 €');
    expect(totales('I.V.A. (21%)')).toBe('1.502,05 €');
    expect(totales('Total')).toBe('8.654,68 €');
    expect(cerca(fila(ts, buscar(ts, 'Total')!).find((t) => t.x > 511)!.derecha, COLUMNAS_A.total)).toBe(true);
  });

  it('formatos: kg con 3 decimales sin miles, IEEPNR con 2, precio de 2 a 4 e importes con miles', () => {
    const F = formatosA();
    expect([F.kg(394.992), F.kg(176.17), F.kg(24528.62), F.kg(10)]).toEqual(['394,992', '176,17', '24528,62', '10']);
    expect([F.unidades(46320), F.unidades(9826)]).toEqual(['46320', '9826']);
    expect([F.importe(46.39), F.importe(177.75), F.importe(4162.75), F.importe(1234567.8), F.importe(-8.7)]).toEqual([
      '46,39 €',
      '177,75 €',
      '4.162,75 €',
      '1.234.567,80 €',
      '-8,70 €',
    ]);
    expect([F.precio(0.162), F.precio(1.5), F.precio(0.12345)]).toEqual(['0,162 €', '1,50 €', '0,1235 €']);
    expect(formatosA('USD').importe(10)).toBe('10,00 USD');
  });

  it('registro: con los datos registrales o, si no, los de por partes', () => {
    const e = datosNz().emisor!;
    expect(textoRegistroA({ ...e, datosRegistrales: null, inscripcion: 'Inscrita en el Registro Mercantil de Castellón, Tomo 1, Folio 2, Hoja CS-3.' }, 'B12345674')).toBe(
      'Inscrita en el Registro Mercantil de Castellón, Tomo 1, Folio 2, Hoja CS-3, con CIF: B12345674',
    );
    expect(textoRegistroA({ ...e, datosRegistrales: null, inscripcion: null }, 'B12345674')).toBeNull();
  });
});

describe('varias paginas', () => {
  it('60 articulos: cabecera de la tabla en cada pagina; resumen, totales y pie solo en la ultima', async () => {
    const lineas = Array.from({ length: 60 }, (_, i) => ({ ...datosNz().lineas[i % 7], descripcion: `ARTICULO ${String(i + 1).padStart(2, '0')}` }));
    const ts = await textos(datosNz({ lineas }));
    const paginas = Math.max(...ts.map((t) => t.pagina));
    expect(paginas).toBeGreaterThan(1);
    for (let p = 1; p <= paginas; p++) {
      expect(ts.some((t) => t.pagina === p && t.texto === 'CONCEPTO')).toBe(true);
      expect(ts.some((t) => t.pagina === p && t.texto === `Página ${p} de ${paginas}`)).toBe(true);
    }
    for (const s of ['Subtotal', 'Total', 'PESO BRUTO(kg)', 'OBSERVACIONES:']) expect(ts.filter((t) => t.texto === s).map((t) => t.pagina)).toEqual([paginas]);
    expect(ts.filter((t) => t.texto.startsWith('DATOS BANCARIOS')).map((t) => t.pagina)).toEqual([paginas]);
    // Cada articulo una vez, en orden, y su fila de kg en la misma pagina.
    const articulos = ts.filter((t) => t.texto.startsWith('ARTICULO '));
    expect(articulos.map((t) => t.texto)).toEqual(lineas.map((l) => l.descripcion));
    expect(ts.filter((t) => t.texto === 'KG Plástico')).toHaveLength(60);
    // La cabecera breve de las paginas siguientes.
    expect(ts.some((t) => t.pagina === 2 && t.texto.includes('(continuación)'))).toBe(true);
    // Nada por debajo del pie.
    expect(Math.min(...ts.map((t) => t.y))).toBeGreaterThan(8);
  });

  it('una sola pagina no lleva numero de pagina', async () => {
    const ts = await textos(datosNz());
    expect(ts.some((t) => t.texto.startsWith('Página'))).toBe(false);
    expect(Math.max(...ts.map((t) => t.pagina))).toBe(1);
  });
});

/** Alto de la hoja (A4) y lo que ocupa cada texto desde arriba: su linea base mas el descendente. */
const ALTO = 841.89;
const fondo = (t: TextoPdf) => ALTO - t.y + 2;
/** Un texto al pie inventado (tipo aviso de proteccion de datos) de `n` caracteres. */
const pie = (n: number) =>
  'Conforme al RGPD, los datos del cliente se tratan solo para gestionar la facturación y se guardan el tiempo que exige la ley. Puede ejercer sus derechos escribiendo a facturas@ejemplo.test. '
    .repeat(5)
    .slice(0, n)
    .trim();

describe('texto al pie y observaciones largas', () => {
  it('NZ004_26 con un texto al pie de 120, 250 o 480 caracteres sigue en una pagina', async () => {
    const pesoSinPie = buscar(await textos(datosNz()), 'PESO BRUTO(kg)')!.y;
    for (const n of [120, 250, 480]) {
      const ts = await textos(datosNz({ textoPie: pie(n) }));
      expect([n, Math.max(...ts.map((t) => t.pagina))]).toEqual([n, 1]);
      expect(ts.some((t) => t.texto.startsWith('Página'))).toBe(false);
      expect(Math.max(...ts.map(fondo))).toBeLessThanOrEqual(825);
      // Con 120 caracteres, los huecos de la muestra; con mas, la cola sube un poco (huecos apretados).
      if (n === 120) expect(buscar(ts, 'PESO BRUTO(kg)')!.y).toBeCloseTo(pesoSinPie, 1);
      else expect(buscar(ts, 'PESO BRUTO(kg)')!.y).toBeGreaterThan(pesoSinPie);
      expect(ts.some((t) => t.texto.includes('facturas@ejemplo.test') && t.tam < 7)).toBe(n > 150);
    }
  });

  it('observaciones de 4.000 caracteres: el resumen y los totales con el ultimo articulo y el resto en «OBSERVACIONES (continuación)», sin salirse ni pisar el numero de pagina', async () => {
    const frase = 'Entrega en el muelle 3 de 8:00 a 14:00; la mercancía va paletizada y con film retráctil, y los portes son pagados hasta destino. ';
    const observaciones = frase.repeat(40).slice(0, 4000).trim();
    const registro = { ...datosNz().emisor!, datosRegistrales: 'Tomo 1234, Libro 567, Folio 89, Sección 8, Hoja CS-12345, Inscripción 1.ª, con todos los datos registrales escritos sin abreviar' };
    const ts = await textos(datosNz({ observaciones, textoPie: pie(480), emisor: registro }));
    const paginas = Math.max(...ts.map((t) => t.pagina));
    expect(paginas).toBeGreaterThan(1);
    const ultimoArticulo = ts.filter((t) => t.texto === LINEAS_NZ004[6].descripcion).pop()!;
    expect(buscar(ts, 'Subtotal')!.pagina).toBe(ultimoArticulo.pagina);
    expect(buscar(ts, 'OBSERVACIONES (continuación):')).toBeDefined();
    expect(ts.filter((t) => t.texto.startsWith('DATOS BANCARIOS'))).toHaveLength(1);
    // Todas las lineas de las observaciones, una vez y en orden.
    const lineasObs = ts.filter((t) => t.x > 320 && t.tam > 7 && t.tam < 8 && !t.texto.startsWith('OBSERVACIONES') && !t.texto.startsWith('Página ')).map((t) => t.texto);
    expect(lineasObs.join(' ').replace(/\s+/g, ' ')).toBe(observaciones.replace(/\s+/g, ' '));
    // Registro y texto al pie, al final; numero en cada pagina, y nada lo pisa ni pasa del margen.
    expect(ts.filter((t) => t.texto.startsWith('Inscrita en el Registro Mercantil')).map((t) => t.pagina)).toEqual([paginas]);
    for (let p = 1; p <= paginas; p++) expect(ts.some((t) => t.pagina === p && t.texto === `Página ${p} de ${paginas}`)).toBe(true);
    const contenido = ts.filter((t) => !t.texto.startsWith('Página '));
    expect(Math.max(...contenido.map(fondo))).toBeLessThanOrEqual(820);
  });
});

describe('cliente y documento', () => {
  it('CIF para la empresa y el cliente espanol que es sociedad; NIF para la persona fisica (DNI o NIE); RNC, NIF-IVA (VAT) o EIN para el de fuera', async () => {
    const con = async (cliente: Partial<DatosFacturaPdf['cliente']>) =>
      (await textos(datosNz({ cliente: { ...datosNz().cliente, ...cliente } }))).map((t) => t.texto);
    const conDni = await con({});
    expect(conDni).toContain('NIF: 00000000T');
    expect(conDni).toContain('CIF. B12345674');
    expect(await con({ nifCif: 'X1234567L' })).toContain('NIF: X1234567L');
    expect(await con({ nifCif: 'B00000000' })).toContain('CIF: B00000000');
    expect(await con({ pais: 'DO', nifCif: '101123456', cp: '10101', municipio: 'Santo Domingo', provincia: null })).toContain('RNC: 101123456');
    expect(await con({ pais: 'FR', nifCif: 'FR40303265045', cp: '75009', municipio: 'Paris', provincia: null })).toContain('NIF-IVA (VAT): FR40303265045');
    const us = await con({ pais: 'US', nifCif: '12-3456789', cp: '33131', municipio: 'Miami', provincia: 'FL' });
    expect(us).toContain('EIN: 12-3456789');
    expect(us).toContain('ESTADOS UNIDOS');
  });

  it('borrador: marca de agua y sin numero', async () => {
    const t = (await textos(datosNz({ estadoDocumento: 'BORRADOR', numeroCompleto: null }))).map((x) => x.texto);
    expect(t).toContain('BORRADOR');
    expect(t).toContain('Borrador (sin número)');
  });

  it('proforma: su titulo y el aviso', async () => {
    const t = (await textos(datosNz({ estadoDocumento: 'PROFORMA', numeroCompleto: 'P-3' }))).map((x) => x.texto);
    expect(t).toEqual(expect.arrayContaining(['FACTURA PROFORMA', 'Nº PROFORMA:', 'P-3', 'Documento sin validez fiscal. No es una factura.']));
  });

  it('rectificativa: el bloque bajo el CLIENTE y antes de la tabla', async () => {
    const ts = await textos(
      datosNz({
        tipoFactura: 'R1',
        esRectificativa: true,
        tipoRectificativa: 'I',
        numeroCompleto: 'R-1',
        motivoRectificacion: 'Devuelven un pack',
        causaRectificacion: 'DEVOLUCION',
        rectificadas: [{ numero: 'A-1', fecha: '2026-03-04' }],
      }),
    );
    const bloque = buscar(ts, 'RECTIFICA:')!;
    expect(bloque.y).toBeLessThan(buscar(ts, 'CLIENTE:')!.y);
    expect(bloque.y).toBeGreaterThan(buscar(ts, 'CONCEPTO')!.y);
    expect(buscar(ts, 'Rectifica la factura A-1, de 04/03/2026, por diferencias (R1).')).toBeDefined();
    expect(buscar(ts, 'Motivo: Devolución de mercancías o envases. Devuelven un pack')).toBeDefined();
    expect(buscar(ts, 'FACTURA RECTIFICATIVA')).toBeDefined();
  });

  it('varios tipos de IVA: una fila Base y otra I.V.A. por tipo, y el tipo en el concepto', async () => {
    const base = datosNz();
    const lineas = base.lineas.map((l, i) => (i === 0 ? { ...l, tipoIva: 10, ivaImporte: 54.41 } : l));
    const ts = await textos({ ...base, lineas, ivaTotal: 1442.21, totalFactura: 8594.84 });
    const valor = (etq: string) => fila(ts, buscar(ts, etq)!).find((t) => t.x > 511)!.texto;
    expect(valor('Base (21%)')).toBe('6.608,58 €');
    expect(valor('I.V.A. (21%)')).toBe('1.387,80 €');
    expect(valor('Base (10%)')).toBe('544,05 €');
    expect(valor('I.V.A. (10%)')).toBe('54,41 €');
    expect(valor('Total')).toBe('8.594,84 €');
    expect(buscar(ts, 'Subtotal')).toBeUndefined();
    expect(buscar(ts, 'LIMON 6% FREEWAY 2,0L P P4 MP (IVA 10%)')).toBeDefined();
  });

  it('otra moneda: los importes con su codigo y la frase de la divisa en OBSERVACIONES', async () => {
    const ts = await textos(datosNz({ moneda: 'USD', tipoCambio: 1.1, fuenteTipoCambio: 'MANUAL', contravalor: { base: 6502.39, iva: 1365.5, retencion: 0, total: 7867.89, desglose: [] } }));
    expect(fila(ts, buscar(ts, 'Total')!).find((t) => t.x > 511)!.texto).toBe('8.654,68 USD');
    expect(buscar(ts, 'Factura expresada en', true)).toBeDefined();
    expect(buscar(ts, 'Contravalor en EUR', true)).toBeDefined();
  });

  it('exenta o intracomunitaria: la mencion legal en OBSERVACIONES, antes de las observaciones', async () => {
    const ts = await textos(
      datosNz({
        tipoOperacion: 'INTRACOMUNITARIA',
        observaciones: 'Entrega en almacén',
        cliente: { nombreFiscal: 'CLIENT FICTIF SARL', nifCif: 'FR40303265045', direccion: null, cp: '75009', municipio: 'Paris', provincia: null, pais: 'FR' },
      }),
    );
    const obs = buscar(ts, 'OBSERVACIONES:')!;
    const debajo = ts.filter((t) => t.pagina === obs.pagina && t.x > 320 && t.y < obs.y).sort((a, b) => b.y - a.y).map((t) => t.texto);
    expect(debajo[0]).toMatch(/intracomunitaria|art\. 25/i);
    expect(debajo[debajo.length - 1]).toBe('Entrega en almacén');
  });
});

describe('renderizarFactura elige el diseno por la plantilla', () => {
  const tieneColumnasA = async (f: DatosFacturaPdf) => (await textosDePdf(await renderizarFactura(f))).some((t) => t.texto === 'KG.Plast');
  it('la A con su diseno; la de siempre, la B, la C y el lector, el de siempre', async () => {
    expect(await tieneColumnasA(datosNz())).toBe(true);
    expect(await tieneColumnasA(datosNz({ plantilla: 'default' }))).toBe(false);
    expect(await tieneColumnasA(datosNz({ plantilla: 'B' }))).toBe(false);
    expect(await tieneColumnasA(datosNz({ plantilla: 'C' }))).toBe(false);
    expect(await tieneColumnasA(datosNz({ plantilla: undefined }))).toBe(false);
    expect(await tieneColumnasA(datosNz({ registroLector: true }))).toBe(false);
  });
});
