/**
 * Adaptadores: la lectura normalizada vuelve a las formas de hoy
 * (GastoExtraido e InvoiceExtraction), y el respaldo con Claude con vision
 * (Anthropic simulado) se convierte a la lectura normalizada.
 */
process.env.ANTHROPIC_API_KEY = 'sk-ant-prueba-0123456789abcdefghijklmnopqrstuv';
const crear = jest.fn();
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { create: crear } })),
}));

import { _construirGastoExtraido } from '../services/gastos-extractor.service';
import { comprobarTotales, lineasDesdeExtraccion, aIngresoExtraido } from '../services/ingresos-extractor.service';
import { aGastoExtraido, aInvoiceExtraction, tramosGasto } from '../services/lectura/adaptadores';
import { mapearFacturaAzure } from '../services/lectura/azure-factura.mapper';
import type { AnalyzeResult } from '../services/lectura/azure-di.client';
import { claudeVisionExtractor } from '../services/lectura/claude-vision.adapter';
import type { LecturaNormalizada } from '../services/lectura/tipos';
import { validarLectura, type ContextoValidacion } from '../services/lectura/validaciones';
import { fixtureAzure, fixtureClaude, NIF_EMPRESA } from './fixtures/azure-di';

function leer(nombre: string): LecturaNormalizada {
  const r = mapearFacturaAzure(fixtureAzure<{ analyzeResult: AnalyzeResult }>(nombre).analyzeResult);
  if (r.tipo !== 'hecho') throw new Error('x');
  return r.lectura;
}
const ctx = (extra: Partial<ContextoValidacion> = {}): ContextoValidacion => ({
  lector: 'GASTO',
  nifEmpresa: NIF_EMPRESA,
  empresaEspanola: true,
  monedaCuenta: 'EUR',
  hoy: '2026-10-11',
  periodoAbierto: async () => true,
  duplicado: { factura: null, archivo: null },
  ...extra,
});
const archivo = { buffer: Buffer.from('%PDF-1.4 x'), nombre: 'f.pdf', mime: 'application/pdf', hash: 'h' };

describe('aGastoExtraido', () => {
  it('la misma forma que el GastoExtraido de hoy (todas las claves)', async () => {
    const l = leer('resultado-simple');
    const g = aGastoExtraido(l, (await validarLectura(l, ctx())).validaciones, 0.91);
    const hoy = _construirGastoExtraido({ numero: 'F', fecha: '2026-03-04', proveedor: 'P', nif_proveedor: null, concepto: 'x', base: 1, iva_porcentaje: 21, iva_cantidad: 0.21, total: 1.21, raw_text: null });
    expect(Object.keys(g).sort()).toEqual(Object.keys(hoy).sort());
    expect(g).toMatchObject({
      numeroFactura: 'F2026/0012',
      proveedor: 'IMPRENTA LEVANTE SL',
      nifProveedor: 'B12345674',
      fecha: '2026-03-04',
      base: 200,
      iva: 42,
      total: 242,
      tipoIva: 21,
      retencion: 0,
      tipoRetencion: null,
      moneda: 'EUR',
      confianza: 0.91,
      errores: [],
      tipoDocumento: 'factura',
    });
  });

  it('con IRPF: retencion y tipo; los avisos de revisar y error van en errores', async () => {
    const l = leer('resultado-irpf');
    l.fechaEmision.valor = '2026-10-12';
    const g = aGastoExtraido(l, (await validarLectura(l, ctx())).validaciones, 0.5);
    expect(g).toMatchObject({ base: 1000, iva: 210, total: 1060, retencion: 150, tipoRetencion: 15 });
    expect(g.errores).toContain('La fecha de la factura es posterior a hoy.');
  });

  it('una nomina: sin cuenta y con el aviso de hoy el primero', async () => {
    const l = leer('resultado-simple');
    l.tipoDocumento = { valor: 'nomina', confianza: null, fuente: 'claude' };
    const g = aGastoExtraido(l, (await validarLectura(l, ctx())).validaciones, null);
    expect(g.cuentaContableBase).toBeNull();
    expect(g.errores[0]).toMatch(/^Es una nómina/);
    expect(g.errores.filter((e) => /^Es una nómina/.test(e))).toHaveLength(1);
  });
});

describe('aInvoiceExtraction', () => {
  const venta = ctx({ lector: 'VENTA', nifEmpresa: 'B12345674' });

  it('en validation.errors solo los de nivel error', async () => {
    const l = leer('resultado-confianza-baja');
    l.fechaVencimiento.valor = '2026-01-01'; // V12: revisar
    const { validaciones } = await validarLectura(l, venta);
    expect(validaciones.some((v) => v.nivel === 'revisar')).toBe(true);
    const e = aInvoiceExtraction(l, validaciones, { confianza: 0.42, nombreArchivo: 'f.pdf', mime: 'application/pdf' });
    expect(e.validation.errors).toEqual([]);
    expect(e.confidence).toBe(0.42);

    const rect = leer('resultado-simple');
    rect.tipoDocumento = { valor: 'rectificativa', confianza: null, fuente: 'claude' };
    const r = aInvoiceExtraction(rect, (await validarLectura(rect, venta)).validaciones, { confianza: 1, nombreArchivo: null, mime: null });
    expect(r.document_type).toBe('credit_note');
    expect(r.validation.errors).toEqual(['Es una factura rectificativa. Todavía no se puede registrar con el lector.']);
  });

  it('gastos con dos tipos de IVA: un tramo por tipo, se pide revisar y el panel sabe el tipo de cada base', async () => {
    const l = leer('resultado-iva-multiple');
    expect(tramosGasto(l)).toEqual([
      { tipoIva: 21, base: 200, cuota: 42, descripcion: 'Folletos A5 y carteles A3' },
      { tipoIva: 10, base: 50, cuota: 5, descripcion: 'Libros' },
    ]);
    const r = await validarLectura(l, ctx());
    expect(r.validaciones.find((x) => x.codigo === 'VARIOS_TIPOS_IVA')).toMatchObject({
      nivel: 'revisar',
      campos: ['desglose.0.base', 'desglose.1.base'],
      mensaje: 'La factura lleva IVA del 21 % y del 10 %: comprueba que hay una línea por cada tipo, con su base.',
    });
    expect(r.estado).toBe('revisar');
    expect(r.campos['desglose.1.base']).toMatchObject({ estado: 'revisar', tipoIva: 10 });
    expect(r.campos['desglose.0.cuota']).toMatchObject({ tipoIva: 21 });
    // En ventas no: las lineas salen ya por tipo.
    expect((await validarLectura(l, venta)).validaciones.map((x) => x.codigo)).not.toContain('VARIOS_TIPOS_IVA');
  });

  describe('descripcion de cada tramo', () => {
    const linea = (descripcion: string | null, tipoIva: number | null) => ({ descripcion, cantidad: 1, precioUnitario: null, importe: null, tipoIva, confianza: null });

    it('con las partidas de su tipo: sin repetir, la segunda en minuscula salvo siglas, y con muchas, cuantas mas', () => {
      const l = leer('resultado-iva-multiple');
      l.lineas = [linea('Libros', 10), linea('Revistas', 10), linea('libros', 10), linea('Tóner', 21), linea('PVC rígido', 21), linea('  ', 21)];
      expect(tramosGasto(l).map((t) => t.descripcion)).toEqual(['Tóner y PVC rígido', 'Libros y revistas']);
      l.lineas = ['Folletos', 'Carteles', 'Sobres', 'Tarjetas', 'Lonas'].map((d) => linea(d, 21));
      expect(tramosGasto(l)[0].descripcion).toBe('Folletos, carteles y 3 partidas más');
      l.lineas = ['Folletos', 'Carteles', 'Sobres'].map((d) => linea(d, 21));
      expect(tramosGasto(l)[0].descripcion).toBe('Folletos, carteles y sobres');
    });

    it('sin partidas de ese tipo: un texto neutro; al 0 %, "Base exenta"', () => {
      const l = leer('resultado-iva-multiple');
      l.lineas = [linea('Tóner', 21), linea('Sin tipo', null)];
      l.desglose[1].tipoIva = 0;
      l.desglose[1].cuota.valor = 0;
      expect(tramosGasto(l).map((t) => t.descripcion)).toEqual(['Tóner', 'Base exenta']);
      l.lineas = [];
      l.desglose[1].tipoIva = 10;
      expect(tramosGasto(l).map((t) => t.descripcion)).toEqual(['Base al 21 %', 'Base al 10 %']);
    });

    it('con un solo tipo, todas las partidas aunque no traigan el tipo', () => {
      const l = leer('resultado-simple');
      l.lineas = [linea('Tóner', null), linea('Papel', 21)];
      expect(tramosGasto(l)).toEqual([{ tipoIva: 21, base: 200, cuota: 42, descripcion: 'Tóner y papel' }]);
    });

    it('con un solo tipo y sin partidas: el concepto si lo hay (no "Base al 21 %"); con varios tipos, el texto neutro', () => {
      const l = leer('resultado-simple');
      l.lineas = [linea(null, 21), linea('   ', null)];
      l.concepto = { valor: null, confianza: null, fuente: 'azure' };
      expect(tramosGasto(l)[0].descripcion).toBe('Base al 21 %');
      // El concepto que completa la IA.
      l.concepto = { valor: '  Servicio de   mantenimiento ', confianza: null, fuente: 'claude' };
      expect(tramosGasto(l)[0].descripcion).toBe('Servicio de mantenimiento');
      l.concepto.valor = 'y'.repeat(400);
      expect(tramosGasto(l)[0].descripcion).toHaveLength(150);
      const varios = leer('resultado-iva-multiple');
      varios.lineas = [];
      varios.concepto = { valor: 'Material de imprenta', confianza: null, fuente: 'claude' };
      expect(tramosGasto(varios).map((t) => t.descripcion)).toEqual(['Base al 21 %', 'Base al 10 %']);
    });

    it('no pasa de 150 caracteres', () => {
      const l = leer('resultado-simple');
      l.lineas = [linea('x'.repeat(400), 21)];
      const d = tramosGasto(l)[0].descripcion;
      expect(d).toHaveLength(150);
      expect(d.endsWith('…')).toBe(true);
    });
  });

  it('una parte exenta no se llama "IVA del 0 %" en los avisos', async () => {
    const l = leer('resultado-iva-multiple');
    l.desglose[1].tipoIva = 0;
    l.desglose[1].cuota.valor = 5;
    const r = await validarLectura(l, ctx());
    expect(r.validaciones.find((x) => x.codigo === 'VARIOS_TIPOS_IVA')?.mensaje).toBe('La factura lleva IVA del 21 % y una parte exenta: comprueba que hay una línea por cada tipo, con su base.');
    expect(r.validaciones.find((x) => x.codigo === 'CUOTA_TIPO')?.mensaje).toBe('La base exenta no lleva IVA y pone 5,00 €.');
    expect(JSON.stringify(r)).not.toContain('0 %');
  });

  it('con dos tipos de IVA, comprobarTotales de ingresos-extractor pasa', async () => {
    const l = leer('resultado-iva-multiple');
    const e = aInvoiceExtraction(l, (await validarLectura(l, venta)).validaciones, { confianza: 0.9, nombreArchivo: null, mime: null });
    expect(e.amounts).toMatchObject({ subtotal: 250, tax_total: 47, total_gross: 297, total_net: 297 });
    expect(() => comprobarTotales(lineasDesdeExtraccion(e, 'Folletos'), e)).not.toThrow();
    expect(aIngresoExtraido('doc', e)).toMatchObject({ numeroFactura: 'F2026/0012', nifCliente: 'B87654323', base: 250, iva: 47, total: 297, errores: [] });
  });

  it('con IRPF, la retencion va en withholdings y el total neto cuadra', async () => {
    const l = leer('resultado-irpf');
    const e = aInvoiceExtraction(l, [], { confianza: 0.9, nombreArchivo: null, mime: null });
    expect(e.amounts.withholdings).toEqual([{ type: 'IRPF', rate: 15, amount: 150 }]);
    expect(() => comprobarTotales(lineasDesdeExtraccion(e, null), e)).not.toThrow();
  });
});

describe('respaldo con Claude con vision', () => {
  beforeEach(() => crear.mockReset());

  it('gastos: la lectura de hoy, normalizada, con la confianza heuristica de hoy', async () => {
    crear.mockResolvedValueOnce(fixtureClaude('vision-gasto'));
    const r = await claudeVisionExtractor('GASTO').iniciar(archivo, { companyId: 'e', lector: 'GASTO', empresaEspanola: true });
    if (r.tipo !== 'hecho') throw new Error(r.tipo);
    expect(r.lectura.numero).toEqual({ valor: 'F2026/0012', confianza: null, fuente: 'claude' });
    expect(r.lectura.desglose).toEqual([{ tipoIva: 21, base: { valor: 200, confianza: null, fuente: 'claude' }, cuota: { valor: 42, confianza: null, fuente: 'claude' }, tipoRecargo: null, cuotaRecargo: null }]);
    expect(r.lectura.totales.totalAPagar.valor).toBe(242);
    // La IA no saca partidas: la linea del formulario lleva el concepto, no "Base al 21 %".
    expect(tramosGasto(r.lectura)).toEqual([{ tipoIva: 21, base: 200, cuota: 42, descripcion: 'material de imprenta' }]);
    expect(r.confianzaLector).toBe(0.85);
    expect(r.qr).toBeNull();
    // Con tiempo maximo y sin los reintentos del SDK.
    expect(crear.mock.calls[0][1]).toEqual({ timeout: 55_000, maxRetries: 0 });
    // Se manda el documento, como hoy.
    expect(crear.mock.calls[0][0].messages[0].content[0].type).toBe('document');
    const v = await validarLectura(r.lectura, ctx());
    expect(v.estado).toBe('ok');
  });

  it('ventas: serie y numero, cliente y desglose', async () => {
    crear.mockResolvedValueOnce(fixtureClaude('vision-venta'));
    const r = await claudeVisionExtractor('VENTA').iniciar(archivo, { companyId: 'e', lector: 'VENTA', empresaEspanola: true });
    if (r.tipo !== 'hecho') throw new Error(r.tipo);
    expect(r.lectura.numero.valor).toBe('F2026-0012');
    expect(r.lectura.receptor.nif.valor).toBe('B87654323');
    expect(r.lectura.totales.totalFactura.valor).toBe(242);
    expect(typeof r.confianzaLector).toBe('number');
  });

  it('ventas de una empresa que lleva sus cuentas en USD: la moneda es la de la contabilidad y V17 no bloquea', async () => {
    crear.mockResolvedValueOnce(fixtureClaude('vision-venta'));
    const r = await claudeVisionExtractor('VENTA').iniciar(archivo, { companyId: 'e', lector: 'VENTA', empresaEspanola: false, monedaCuenta: 'USD' });
    if (r.tipo !== 'hecho') throw new Error(r.tipo);
    expect(r.lectura.moneda).toEqual({ valor: 'USD', confianza: null, fuente: 'calculado' });
    const val = await validarLectura(r.lectura, ctx({ lector: 'VENTA', empresaEspanola: false, monedaCuenta: 'USD', nifEmpresa: null }));
    expect(val.validaciones.map((x) => x.codigo)).not.toContain('MONEDA');
  });

  it('sin clave o con un error de Anthropic: fallo, sin el texto del error', async () => {
    crear.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
    expect(await claudeVisionExtractor('GASTO').iniciar(archivo, { companyId: 'e', lector: 'GASTO', empresaEspanola: true })).toEqual({ tipo: 'fallo', codigo: 'CLAUDE_ERROR', reintentable: false });
    const clave = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    expect(await claudeVisionExtractor('VENTA').iniciar(archivo, { companyId: 'e', lector: 'VENTA', empresaEspanola: true })).toEqual({ tipo: 'fallo', codigo: 'CLAUDE_SIN_CLAVE', reintentable: false });
    process.env.ANTHROPIC_API_KEY = clave;
  });
});
