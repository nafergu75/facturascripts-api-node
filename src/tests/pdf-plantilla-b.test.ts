/**
 * PDF de la plantilla B (ceramica), sin BD: con las lineas de la muestra
 * NZ013_2026, un cliente y un IBAN ficticios (el repo es publico).
 *
 *  - Las etiquetas en el orden de la muestra y cada cifra bajo su columna.
 *  - El cargo de palets va en el pie (no en la tabla), con los pesos neto y
 *    bruto y los totales de palets, cajas, m2 y piezas.
 *  - TOTAL BRUTO, IVA 21% y TOTAL FACTURA; con varios tipos, BASE e IVA de cada uno.
 *  - Las observaciones en su recuadro; obra, borrador, proforma y rectificativa.
 *  - Muchas lineas en varias paginas: cabecera de la tabla repetida, el pie
 *    solo en la ultima y «Página i de n», sin pasar del margen de abajo.
 *  - renderizarFactura solo usa este diseno con la plantilla B (no en el lector).
 */
import { describe, it, expect } from '@jest/globals';
import { renderizarFactura, type DatosFacturaPdf } from '../services/facturaPdf.service';
import { COLUMNAS_B, formatosB, renderizarFacturaPlantillaB } from '../services/facturaPdfPlantillaB';
import { lineasDePdf, textosDePdf, type TextoPdf } from './texto-pdf';
import { LINEAS_NZ013, TOTALES_NZ013 } from './muestra-nz013';

const IVA_LINEAS = [12.97, 111.3, 1.89];

const datosNz = (extra: Partial<DatosFacturaPdf> = {}): DatosFacturaPdf => ({
  id: 'f1',
  numeroCompleto: 'B-13',
  estadoDocumento: 'FINAL',
  tipoFactura: 'F1',
  formaPago: 'TRANSFERENCIA',
  tipoRectificativa: null,
  motivoRectificacion: null,
  esRectificativa: false,
  fechaEmision: '2026-07-10',
  fechaVencimiento: '2026-08-09',
  baseTotal: TOTALES_NZ013.base,
  ivaTotal: TOTALES_NZ013.iva,
  retencionTotal: 0,
  totalFactura: TOTALES_NZ013.total,
  observaciones: TOTALES_NZ013.observaciones,
  plantilla: 'B',
  pesoNetoKg: TOTALES_NZ013.pesoNetoKg,
  pesoBrutoKg: TOTALES_NZ013.pesoBrutoKg,
  lineas: LINEAS_NZ013.map((l, i) => ({
    descripcion: l.descripcion,
    textoAdicional: l.textoAdicional,
    cantidad: l.cantidad,
    precioUnitario: l.precioUnitario,
    descuentoPorcentaje: 0,
    tipoIva: 21,
    ivaImporte: IVA_LINEAS[i],
    baseLine: l.importe,
    tipoRetencion: 0,
    unidadPrecio: l.unidadPrecio,
    ...(l.cargoPalets
      ? { cargoPalets: true }
      : { palets: l.palets, cajas: l.cajas, metros2: l.metros2, piezas: l.piezas, formato: l.formato, calidad: l.calidad }),
  })),
  cliente: { nombreFiscal: 'CLIENTE FICTICIO OBRAS SL', nifCif: 'B00000000', direccion: 'CALLE FALSA, 1\nPLANTA 2', cp: '46960', municipio: 'ALDAIA', provincia: 'VALENCIA', pais: 'ES' },
  emisor: {
    denominacion: 'CERAMICA DE PRUEBA S.L.',
    nif: 'B12345674',
    domicilioSocial: 'CALLE INVENTADA, 2',
    codigoPostal: '12200',
    municipio: 'ONDA',
    provincia: 'CASTELLON',
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

const textos = async (f: DatosFacturaPdf) => textosDePdf(await renderizarFacturaPlantillaB(f));
const buscar = (ts: TextoPdf[], s: string, parcial = false) => ts.find((t) => (parcial ? t.texto.includes(s) : t.texto === s));
const fila = (ts: TextoPdf[], de: TextoPdf) => ts.filter((t) => t.pagina === de.pagina && Math.abs(t.y - de.y) < 0.5);
const cerca = (a: number, b: number) => Math.abs(a - b) < 0.6;
const ALTO = 841.89;

describe('PDF de la plantilla B con NZ013_2026', () => {
  it('las etiquetas de la muestra, en su orden', async () => {
    const ts = await textos(datosNz());
    const orden = lineasDePdf(ts).flat().map((t) => t.texto);
    // Exacto y, si no, el que empieza asi («TOTAL BRUTO....»).
    const pos = (s: string) => (orden.includes(s) ? orden.indexOf(s) : orden.findIndex((t) => t.trim().startsWith(s)));
    const etiquetas = [
      'CERAMICA DE PRUEBA S.L.',
      'CLIENTE',
      'CLIENTE FICTICIO OBRAS SL',
      'CIF: B12345674',
      'NIF: B00000000',
      'CALLE FALSA, 1',
      'PLANTA 2',
      '46960 ALDAIA - (VALENCIA)',
      'FACTURA:',
      'B-13',
      'FECHA:',
      '10/07/2026',
      'OBRA:',
      'PALETS',
      'DESCRIPCION',
      'CAL',
      'PESO (Kg)',
      'PRECIO €',
      'IMPORTE €',
      'MOGAN NATURAL',
      'PORCELANICO RECTIFICADO',
      'PELDAÑO MULTIESTEP',
      'PESO NETO (kg)',
      'PESO BRUTO (kg)',
      'PALETS DE MADERA TRATADA',
      'TOTAL BRUTO',
      'IVA 21%',
      'TOTAL FACTURA:',
      'ESTE PRESUPUESTO NO INCLUYE EL TRANSPORTE',
      'FORMA DE PAGO',
      'Inscrita en el Registro Mercantil',
    ];
    const posiciones = etiquetas.map(pos);
    expect(etiquetas.filter((_, i) => posiciones[i] < 0)).toEqual([]);
    expect([...posiciones].sort((a, b) => a - b)).toEqual(posiciones);
    expect(orden).toContain('TRANSFERENCIA BANCARIA: ');
    expect(orden).toContain('ES91 2100 0418 4502 0005 1332');
    expect(orden).toContain('BANCO DE PRUEBAS: CAIXESBBXXX');
    expect(orden).toContain('Inscrita en el Registro Mercantil de Castellón, T 1, L 2, F 3, S 8, H CS 4, I/A 1, con CIF: B12345674');
    // Una sola pagina, sin numero de pagina.
    expect(new Set(ts.map((t) => t.pagina))).toEqual(new Set([1]));
    expect(buscar(ts, 'Página', true)).toBeUndefined();
  });

  it('cada cifra bajo su columna; el cargo de palets no esta en la tabla sino en el pie', async () => {
    const ts = await textos(datosNz());
    const F = formatosB();
    LINEAS_NZ013.filter((l) => !l.cargoPalets).forEach((l) => {
      const f = fila(ts, buscar(ts, l.descripcion)!);
      const en = (s: string, col: keyof typeof COLUMNAS_B) => {
        const t = f.find((x) => x.texto === s && cerca(x.derecha, COLUMNAS_B[col]));
        expect([s, col, !!t]).toEqual([s, col, true]);
      };
      en(String(l.palets), 'palets');
      en(String(l.cajas), 'cajas');
      en(F.m2(l.metros2!), 'm2');
      en(String(l.piezas), 'piezas');
      en(l.calidad!, 'cal');
      en(F.precio(l.precioUnitario), 'precio');
      en(F.importe(l.importe), 'importe');
      // El formato, centrado en su columna.
      const formato = f.find((x) => x.texto === l.formato)!;
      expect(Math.abs((formato.x + formato.derecha) / 2 - 207.85)).toBeLessThan(1);
    });
    expect(ts.filter((t) => t.texto === 'PALETS DE MADERA TRATADA')).toHaveLength(1);
    const cargo = fila(ts, buscar(ts, 'PALETS DE MADERA TRATADA')!);
    expect(cargo.map((t) => t.texto)).toEqual(['PALETS DE MADERA TRATADA', '1', '9,00 €', '9,00 €']);
    expect(cerca(cargo[3].derecha, COLUMNAS_B.pie)).toBe(true);
    // Debajo de PESO BRUTO, como en la muestra.
    expect(cargo[0].y).toBeLessThan(buscar(ts, 'PESO BRUTO (kg)')!.y);
  });

  it('totales del pie (palets 1, cajas 13, m2 12,94, piezas 38), pesos a mano y TOTAL BRUTO, IVA y TOTAL FACTURA', async () => {
    const ts = await textos(datosNz());
    const neto = fila(ts, buscar(ts, 'PESO NETO (kg)')!);
    expect(neto.map((t) => t.texto)).toEqual(['1', '13', '12,94', '38', 'PESO NETO (kg)', '353']);
    expect(cerca(neto[5].derecha, COLUMNAS_B.peso)).toBe(true);
    expect(fila(ts, buscar(ts, 'PESO BRUTO (kg)')!).map((t) => t.texto)).toEqual(['PESO BRUTO (kg)', '373']);
    const valor = (etq: string) => fila(ts, buscar(ts, etq, true)!).find((t) => t.x > 500)!;
    expect(valor('TOTAL BRUTO').texto).toBe('600,74 €');
    expect(valor('IVA 21%').texto).toBe('126,16 €');
    expect(valor('TOTAL FACTURA:').texto).toBe('726,90 €');
    expect(cerca(valor('TOTAL FACTURA:').derecha, COLUMNAS_B.pie)).toBe(true);
  });

  it('obra, observaciones (la primera linea en negrita) y sin pesos ni cargo si no los hay', async () => {
    const ts = await textos(datosNz({ obra: 'REFORMA VIVIENDA C/ FALSA 1', pesoNetoKg: null, pesoBrutoKg: null, lineas: datosNz().lineas.slice(0, 2), baseTotal: 591.74, ivaTotal: 124.27, totalFactura: 716.01 }));
    const obra = buscar(ts, 'REFORMA VIVIENDA C/ FALSA 1')!;
    expect(cerca(obra.y, buscar(ts, 'OBRA:')!.y + 1.7)).toBe(true);
    expect(buscar(ts, 'PALETS DE MADERA TRATADA')).toBeUndefined();
    expect(fila(ts, buscar(ts, 'PESO BRUTO (kg)')!).map((t) => t.texto)).toEqual(['PESO BRUTO (kg)']);
    const obs = ts.filter((t) => t.x > 229 && t.x < 231 && t.y < 160).map((t) => t.texto);
    expect(obs).toEqual(['ESTE PRESUPUESTO NO INCLUYE EL TRANSPORTE', 'EL TRANSPORTE SE FACTURARA APARTE EN FUNCION DE LAS', 'NECESIDADES DE SUMINISTRO DEL MATERIAL QUE NOS INDIQUE EL CLIENTE']);
  });

  it('varios tipos de IVA: el tipo en cada concepto y la BASE y el IVA de cada uno', async () => {
    const lineas = datosNz().lineas.map((l, i) => (i === 1 ? { ...l, tipoIva: 10, ivaImporte: 53 } : l));
    const ts = await textos(datosNz({ lineas, ivaTotal: 67.86, totalFactura: 668.6 }));
    expect(buscar(ts, 'PELDAÑO MULTIESTEP (IVA 10%)')).toBeDefined();
    const valor = (etq: string) => fila(ts, ts.find((t) => t.texto.trim().startsWith(etq))!).find((t) => t.x > 500)!.texto;
    expect([valor('BASE 21%'), valor('IVA 21%'), valor('BASE 10%'), valor('IVA 10%'), valor('TOTAL FACTURA:')]).toEqual(['70,74 €', '14,86 €', '530,00 €', '53,00 €', '668,60 €']);
  });

  it('borrador, proforma y rectificativa', async () => {
    const borrador = await textos(datosNz({ estadoDocumento: 'BORRADOR', numeroCompleto: null }));
    expect(buscar(borrador, 'Borrador (sin número)')).toBeDefined();
    expect(buscar(borrador, 'BORRADOR')).toBeDefined();
    const proforma = await textos(datosNz({ estadoDocumento: 'PROFORMA', numeroCompleto: 'P-4' }));
    expect(buscar(proforma, 'PROFORMA:')).toBeDefined();
    expect(buscar(proforma, 'Documento sin validez fiscal. No es una factura.')).toBeDefined();
    const negativas = datosNz().lineas.map((l) => ({
      ...l,
      cantidad: -l.cantidad,
      baseLine: -l.baseLine,
      ivaImporte: -l.ivaImporte,
      ...(l.cargoPalets ? {} : { palets: l.palets ? -l.palets : 0, cajas: -(l.cajas ?? 0), metros2: -(l.metros2 ?? 0), piezas: -(l.piezas ?? 0) }),
    }));
    const rect = await textos(
      datosNz({
        esRectificativa: true,
        tipoFactura: 'R1',
        tipoRectificativa: 'I',
        motivoRectificacion: 'Devolución de toda la mercancía',
        numeroCompleto: 'R-1',
        original: { numeroCompleto: 'B-13', fechaEmision: '2026-07-10' },
        observaciones: null,
        lineas: negativas,
        baseTotal: -600.74,
        ivaTotal: -126.16,
        totalFactura: -726.9,
      }),
    );
    expect(buscar(rect, 'RECTIFICATIVA:')).toBeDefined();
    expect(buscar(rect, 'Rectifica la factura B-13', true)).toBeDefined();
    expect(fila(rect, buscar(rect, 'PESO NETO (kg)')!).map((t) => t.texto)).toEqual(['-1', '-13', '-12,94', '-38', 'PESO NETO (kg)', '353']);
    expect(fila(rect, buscar(rect, 'TOTAL FACTURA:')!).find((t) => t.x > 500)!.texto).toBe('-726,90 €');
  });

  it('45 lineas: dos paginas, la cabecera de la tabla en las dos, el pie solo en la ultima y nada por debajo del margen', async () => {
    const base = datosNz().lineas;
    const muchas = Array.from({ length: 45 }, (_, i) => ({ ...base[i % 2], descripcion: `${base[i % 2].descripcion} ${i + 1}` }));
    const ts = await textos(datosNz({ lineas: [...muchas, base[2]] }));
    expect(Math.max(...ts.map((t) => t.pagina))).toBe(2);
    expect(ts.filter((t) => t.texto === 'DESCRIPCION').map((t) => t.pagina)).toEqual([1, 2]);
    expect(ts.filter((t) => t.texto === 'TOTAL FACTURA:').map((t) => t.pagina)).toEqual([2]);
    expect(buscar(ts, 'Página 1 de 2')).toBeDefined();
    expect(buscar(ts, 'Página 2 de 2')).toBeDefined();
    expect(buscar(ts, 'MOGAN NATURAL 45')).toBeDefined();
    // Nada baja de 820 pt (desde arriba) salvo el numero de pagina.
    const bajo = ts.filter((t) => !t.texto.startsWith('Página') && ALTO - t.y > 820);
    expect(bajo).toEqual([]);
  });

  it('con imagenes dañadas sale igual (sin ellas)', async () => {
    const rota = { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' };
    const ts = await textos(datosNz({ logo: rota, logoMarca: rota, sello: { ...rota, mime: 'image/jpeg' } }));
    expect(buscar(ts, 'TOTAL FACTURA:')).toBeDefined();
  });

  it('renderizarFactura usa este diseno con la plantilla B; con la C y en las del lector, el de siempre', async () => {
    const b = await textosDePdf(await renderizarFactura(datosNz()));
    expect(buscar(b, 'OBRA:')).toBeDefined();
    const c = await textosDePdf(await renderizarFactura(datosNz({ plantilla: 'C' })));
    expect(buscar(c, 'OBRA:')).toBeUndefined();
    const lector = await textosDePdf(await renderizarFactura(datosNz({ registroLector: true })));
    expect(buscar(lector, 'OBRA:')).toBeUndefined();
  });
});

describe('pie alto: nada se sale de la hoja', () => {
  const frase = 'EL TRANSPORTE SE FACTURARA APARTE EN FUNCION DE LAS NECESIDADES DE SUMINISTRO. ';
  /** Observaciones de `n` caracteres. */
  const largas = (n: number) => frase.repeat(Math.ceil(n / frase.length)).slice(0, n).trim();
  /** Linea base desde arriba. */
  const arriba = (t: TextoPdf) => ALTO - t.y;
  /** Lo que (salvo «Página n de m») baja de `limite` puntos desde arriba o se sale por abajo. */
  const fuera = (ts: TextoPdf[], limite: number) => ts.filter((t) => !t.texto.startsWith('Página') && (arriba(t) > limite || t.y < 0)).map((t) => [t.pagina, Math.round(arriba(t)), t.texto]);
  /** Las lineas de las observaciones `texto`, en su orden y unidas: tienen que salir enteras. */
  const observacionesDe = (ts: TextoPdf[], texto: string) =>
    ts
      .filter((t) => t.x > 229 && t.x < 231.5 && t.texto.trim() && texto.includes(t.texto.trim()))
      .sort((a, b) => a.pagina - b.pagina || b.y - a.y)
      .map((t) => t.texto.trim())
      .join(' ');
  /** El orden de arriba abajo (pagina y altura) de unos textos. */
  const enOrden = (...ts: TextoPdf[]) => ts.every((t, i) => i === 0 || ts[i - 1].pagina < t.pagina || (ts[i - 1].pagina === t.pagina && ts[i - 1].y > t.y));

  it('900 caracteres de observaciones: una pagina; el pie sube lo justo y la forma de pago, el IBAN y el registro caben', async () => {
    const obs = largas(900);
    const ts = await textos(datosNz({ observaciones: obs }));
    expect(Math.max(...ts.map((t) => t.pagina))).toBe(1);
    expect(fuera(ts, 832)).toEqual([]);
    expect(observacionesDe(ts, obs)).toBe(obs);
    expect(buscar(ts, 'ES91 2100 0418 4502 0005 1332')).toBeDefined();
    const [total, pago, banco, registro] = [buscar(ts, 'TOTAL FACTURA:')!, buscar(ts, 'FORMA DE PAGO')!, buscar(ts, 'BANCO DE PRUEBAS: CAIXESBBXXX')!, buscar(ts, 'Inscrita', true)!];
    expect(enOrden(total, pago, banco, registro)).toBe(true);
    // La fila de totales ya no va donde la muestra (PESO NETO a 630,9): sube.
    expect(arriba(buscar(ts, 'PESO NETO (kg)')!)).toBeLessThan(630);
    // Y nunca por encima de la ultima linea de la tabla.
    expect(arriba(buscar(ts, 'PALETS', false)!)).toBeLessThan(arriba(buscar(ts, 'PESO NETO (kg)')!));
  });

  it('4.000 caracteres: las que no caben siguen en «OBSERVACIONES (continuación)», y detras la forma de pago y el registro; nada pisa «Página n de m»', async () => {
    const obs = largas(4000);
    const ts = await textos(datosNz({ observaciones: obs }));
    expect(Math.max(...ts.map((t) => t.pagina))).toBe(2);
    expect(fuera(ts, 820)).toEqual([]);
    expect(observacionesDe(ts, obs)).toBe(obs);
    const [total, sigue, pago, registro] = [buscar(ts, 'TOTAL FACTURA:')!, buscar(ts, 'OBSERVACIONES (continuación)')!, buscar(ts, 'FORMA DE PAGO')!, buscar(ts, 'Inscrita', true)!];
    expect([total.pagina, sigue.pagina, pago.pagina, registro.pagina]).toEqual([1, 2, 2, 2]);
    expect(enOrden(total, sigue, pago, registro)).toBe(true);
    expect(buscar(ts, 'Página 2 de 2')).toBeDefined();
  });

  it('2.000 caracteres (el maximo de las de la serie), texto al pie de 480 y 45 lineas: todo dentro de la hoja y en su orden', async () => {
    const obs = largas(2000);
    const base = datosNz().lineas;
    const muchas = Array.from({ length: 45 }, (_, i) => ({ ...base[i % 2], descripcion: `${base[i % 2].descripcion} ${i + 1}` }));
    const pie = 'Texto al pie largo. '.repeat(24).trim();
    const ts = await textos(datosNz({ observaciones: obs, textoPie: pie, lineas: [...muchas, base[2]] }));
    const paginas = Math.max(...ts.map((t) => t.pagina));
    expect(paginas).toBeGreaterThanOrEqual(2);
    expect(fuera(ts, 820)).toEqual([]);
    expect(observacionesDe(ts, obs)).toBe(obs);
    const ultimaPie = ts.filter((t) => t.texto.startsWith('Texto al pie')).pop()!;
    expect(enOrden(buscar(ts, 'MOGAN NATURAL 45')!, buscar(ts, 'TOTAL FACTURA:')!, buscar(ts, 'FORMA DE PAGO')!, buscar(ts, 'Inscrita', true)!, ultimaPie)).toBe(true);
    expect(buscar(ts, `Página ${paginas} de ${paginas}`)).toBeDefined();
  });

  it('rectificativa por sustitucion con IVA al 21, 10 y 4 %, las observaciones de la muestra y texto al pie: una pagina con todo', async () => {
    const linea = (descripcion: string, tipoIva: number, base: number, cuota: number) => ({
      descripcion,
      cantidad: 1,
      precioUnitario: base,
      descuentoPorcentaje: 0,
      tipoIva,
      ivaImporte: cuota,
      baseLine: base,
      tipoRetencion: 0,
      unidadPrecio: 'UNIDAD',
      piezas: 1,
    });
    const pie = 'Protección de datos: sus datos se tratan para la gestión de la relación comercial. Puede ejercer sus derechos escribiendo a la empresa.';
    const ts = await textos(
      datosNz({
        numeroCompleto: 'R-7',
        tipoFactura: 'R1',
        tipoRectificativa: 'S',
        causaRectificacion: 'ERROR_DATOS',
        motivoRectificacion: 'Se facturó el peldaño con el formato equivocado y el precio de la tarifa anterior.',
        esRectificativa: true,
        rectificadas: [
          { numero: 'B-13', fecha: '2026-07-10' },
          { numero: 'B-14', fecha: '2026-07-11' },
        ],
        importeRectificacion: { base: -50, cuota: -10.5, retencion: 0, total: -60.5 },
        baseTotal: 309,
        ivaTotal: 36.89,
        totalFactura: 345.89,
        lineas: [linea('AZULEJO', 21, 100, 21), linea('PELDAÑO', 10, 100, 10), linea('LIBRO TÉCNICO', 4, 100, 4), { ...linea('PALETS DE MADERA TRATADA', 21, 9, 1.89), piezas: undefined, cargoPalets: true }],
        textoPie: pie,
      }),
    );
    expect(Math.max(...ts.map((t) => t.pagina))).toBe(1);
    expect(fuera(ts, 832)).toEqual([]);
    const ultimaPie = ts.filter((t) => pie.includes(t.texto.trim()) && t.texto.trim()).pop()!;
    expect(enOrden(buscar(ts, 'TOTAL FACTURA:')!, buscar(ts, 'ESTE PRESUPUESTO NO INCLUYE EL TRANSPORTE')!, buscar(ts, 'FORMA DE PAGO')!, buscar(ts, 'BANCO DE PRUEBAS: CAIXESBBXXX')!, buscar(ts, 'Inscrita', true)!, ultimaPie)).toBe(true);
  });

  it('la rectificativa no repite en las observaciones el «Rectifica la factura…» que escribe «Rectificar»; las que se cambian, si salen', async () => {
    const rect = (observaciones: string) =>
      datosNz({
        esRectificativa: true,
        tipoFactura: 'R1',
        tipoRectificativa: 'I',
        motivoRectificacion: 'Anulación',
        numeroCompleto: 'R-1',
        original: { numeroCompleto: 'B-13', fechaEmision: '2026-07-10' },
        observaciones,
      });
    const auto = await textos(rect('Rectifica la factura B-13 de 2026-07-10. Motivo: Anulación'));
    expect(auto.filter((t) => t.texto.includes('Rectifica la factura')).map((t) => t.texto)).toEqual(['Rectifica la factura B-13, de 10/07/2026, por diferencias (R1).']);
    const cambiadas = await textos(rect('Rectifica la factura B-13 de 2026-07-10. Motivo: Anulación. Portes a cargo del cliente'));
    expect(cambiadas.filter((t) => t.texto.includes('Rectifica la factura'))).toHaveLength(2);
  });
});
