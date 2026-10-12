/**
 * Complemento con Claude de una lectura de Azure (Anthropic simulado): cuando
 * se llama, que se le manda (solo texto, datos tapados, sin nombres) y como se
 * mezcla lo que responde.
 */
const crear = jest.fn();
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { create: crear } })),
}));

import Anthropic from '@anthropic-ai/sdk';
import { mapearFacturaAzure } from '../services/lectura/azure-factura.mapper';
import type { AnalyzeResult } from '../services/lectura/azure-di.client';
import { AVISO_SIN_COMPLEMENTO, completarConClaude, decidirComplemento, mensajeParaClaude, MOTIVO_TOTAL_SIN_RETENCION_VENTA, prepararTexto } from '../services/lectura/claude-complemento';
import { aGastoExtraido } from '../services/lectura/adaptadores';
import type { LecturaHecha, LecturaNormalizada } from '../services/lectura/tipos';
import { validarLectura, type ContextoValidacion } from '../services/lectura/validaciones';
import { compararQr } from '../services/lectura/verifactu-qr';
import { logger } from '../config/logger';
import { fixtureAzure, fixtureClaude, NIF_EMPRESA } from './fixtures/azure-di';

function leer(nombre: string): LecturaHecha {
  const r = mapearFacturaAzure(fixtureAzure<{ analyzeResult: AnalyzeResult }>(nombre).analyzeResult);
  if (r.tipo !== 'hecho') throw new Error('x');
  return r;
}
const ctx: ContextoValidacion = {
  lector: 'GASTO',
  nifEmpresa: NIF_EMPRESA,
  empresaEspanola: true,
  monedaCuenta: 'EUR',
  hoy: '2026-10-11',
  periodoAbierto: async () => true,
  duplicado: { factura: null, archivo: null },
};
const disparadores = (nombre: string) => decidirComplemento(leer(nombre).lectura, leer(nombre).texto, 'GASTO').map((p) => p.disparador);

const antes = process.env.ANTHROPIC_API_KEY;
beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-prueba-0123456789abcdefghijklmnopqrstuv';
  crear.mockReset();
});
afterAll(() => {
  if (antes === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = antes;
});

describe('cuando se llama', () => {
  /** El fixture sin InvoiceTotal ni AmountDue (ningun total impreso). */
  function sinTotales(nombre: string): LecturaHecha {
    const a = fixtureAzure<{ analyzeResult: AnalyzeResult }>(nombre).analyzeResult;
    const f = a.documents![0].fields as Record<string, unknown>;
    delete f.InvoiceTotal;
    delete f.AmountDue;
    const r = mapearFacturaAzure(a);
    if (r.tipo !== 'hecho') throw new Error('x');
    return r;
  }

  it('sin InvoiceTotal ni AmountDue y sin QR se pregunta el total a pagar (C6): el total sumado con las bases no se ha cotejado con nada', () => {
    const r = sinTotales('resultado-simple');
    expect(r.lectura.totales.totalFactura).toMatchObject({ valor: 242, fuente: 'calculado' });
    expect(decidirComplemento(r.lectura, r.texto, 'GASTO')).toEqual([{ disparador: 'C6', texto: 'No se ha leído el total a pagar: búscalo. Contesta en total_a_pagar.' }]);
  });

  it('sin InvoiceTotal ni AmountDue, con un QR que confirma el total de la factura, no se pregunta', () => {
    const { lectura, texto, qr } = sinTotales('resultado-qr-ok');
    const l = compararQr(qr ?? null, lectura);
    expect(l.totales.totalFactura).toMatchObject({ valor: 242, fuente: 'qr', confianza: 1 });
    expect(decidirComplemento(l, texto, 'GASTO')).toEqual([]);
    // Un QR que no coincide con ese total no lo confirma: se pregunta.
    const otro = compararQr({ estado: 'VALIDO', verifactu: true, datos: { ...qr!.datos!, importe: 250 } }, lectura);
    expect(decidirComplemento(otro, texto, 'GASTO').map((p) => p.texto)).toContain('No se ha leído el total a pagar: búscalo. Contesta en total_a_pagar.');
  });

  it('la factura simple no necesita a Claude', () => {
    expect(disparadores('resultado-simple')).toEqual([]);
  });

  it('IRPF (C1), recargo (C2), rectificativa (C5) y confianza baja (C6)', () => {
    expect(disparadores('resultado-irpf')).toContain('C1');
    expect(disparadores('resultado-recargo')).toContain('C2');
    expect(disparadores('resultado-rectificativa')).toContain('C5');
    expect(disparadores('resultado-confianza-baja').filter((d) => d === 'C6')).toHaveLength(3);
  });

  it('el numero leido con poca seguridad se pregunta, salvo que el QR ya lo confirme', () => {
    expect(disparadores('resultado-qr-ok')).toEqual(['C6']);
    const { lectura, texto, qr } = leer('resultado-qr-ok');
    expect(decidirComplemento(compararQr(qr ?? null, lectura), texto, 'GASTO')).toEqual([]);
  });

  it('una nota de abono en ingles o con importes negativos pregunta el tipo de documento (C5)', () => {
    const l = leer('resultado-simple').lectura;
    expect(decidirComplemento(l, 'CREDIT NOTE 12', 'VENTA').map((p) => p.disparador)).toContain('C5');
    l.totales.totalAPagar.valor = -242;
    l.totales.totalFactura.valor = -242;
    l.desglose[0].base.valor = -200;
    l.desglose[0].cuota.valor = -42;
    expect(decidirComplemento(l, 'INVOICE', 'VENTA').map((p) => p.disparador)).toContain('C5');
  });

  it('cuadre fallido (C3) y base dudosa o sin desglose (C4)', () => {
    const l = leer('resultado-simple').lectura;
    l.totales.totalAPagar.valor = 250;
    expect(decidirComplemento(l, 'texto', 'GASTO').map((p) => p.disparador)).toContain('C3');
    l.desglose = [];
    expect(decidirComplemento(l, 'texto', 'GASTO').map((p) => p.disparador)).toContain('C4');
  });
});

describe('que se manda', () => {
  it('el texto tapa IBAN, correos y telefonos y quita las marcas de codigos', () => {
    const t = prepararTexto(leer('resultado-simple').texto!);
    expect(t).toContain('IBAN [IBAN]');
    expect(t).toContain('[CORREO]');
    expect(t).toContain('Tel [TELÉFONO]');
    expect(t).not.toContain('ES91');
    expect(t).not.toContain('963 123 456');
    expect(t).not.toContain(':barcode:');
  });

  it.each([
    ['IBAN con guiones', 'IBAN: ES91-2100-0418-4502-0005-1332 Total'],
    ['IBAN con puntos', 'Pago a ES91.2100.0418.4502.0005.1332'],
    ['IBAN en minusculas y con dobles espacios', 'iban es91  2100  0418  4502  0005  1332'],
    ['IBAN seguido de una palabra', 'ES9121000418450200051332TOTAL 1.210,00'],
    ['IBAN mal leido detras de "IBAN"', 'IBAN ES91 2100 0418 4502 0005 1333'],
  ])('tapa el %s', (_caso, texto) => {
    const t = prepararTexto(texto);
    expect(t).toContain('[IBAN]');
    expect(t).not.toMatch(/2100.?0418/);
  });

  it('tapa la cuenta CCC de 20 cifras y los telefonos con Tfno, T. o prefijo internacional', () => {
    const t = prepararTexto('Cuenta 2100 0418 45 0200051332. Tfno: 963 123 456. T. 961 234 567. Móvil del comercial +34 600 123 456.');
    expect(t).toContain('[CUENTA]');
    expect(t).not.toContain('0200051332');
    for (const tel of ['963 123 456', '961 234 567', '600 123 456']) expect(t).not.toContain(tel);
  });

  it('no tapa numeros de factura que parecen un IBAN ni importes', () => {
    const t = prepararTexto('Factura FV2026000000123 y FA20240001234. Total 1.210,00 €');
    expect(t).toContain('FV2026000000123');
    expect(t).toContain('FA20240001234');
    expect(t).toContain('1.210,00');
  });

  it('tapa antes de cortar: un IBAN partido por el corte no queda a la vista', () => {
    const relleno = 'x'.repeat(15_000 - 10);
    const t = prepararTexto(`${relleno} IBAN ES91 2100 0418 4502 0005 1332`);
    expect(t).not.toMatch(/ES91 ?21/);
    expect(t.length).toBeLessThanOrEqual(15_000);
  });

  it('sin documento ni imagen, con [IBAN] y sin los nombres en los datos del lector', async () => {
    crear.mockResolvedValueOnce(fixtureClaude('complemento-irpf'));
    const { lectura, texto } = leer('resultado-irpf');
    await completarConClaude(lectura, texto, decidirComplemento(lectura, texto, 'GASTO'), ctx);
    const peticion = crear.mock.calls[0][0];
    const bloques = peticion.messages[0].content as Array<{ type: string; text?: string }>;
    expect(bloques.map((b) => b.type)).toEqual(['text']);
    expect(peticion.tool_choice).toEqual({ type: 'tool', name: 'completar_factura' });
    const enviado = bloques[0].text!;
    expect(enviado).toContain('[IBAN]');
    const datos = enviado.split('DATOS DEL LECTOR:')[1].split('PREGUNTAS:')[0];
    expect(datos).not.toContain('IMPRENTA');
    expect(datos).not.toContain('COMERCIAL');
    expect(datos).not.toContain('Calle Mayor');
    expect(JSON.stringify(peticion)).not.toMatch(/"type":"(document|image)"/);
  });

  it('el cliente tiene tiempo maximo y no reintenta (el SDK reintenta 2 veces y espera 10 min por defecto)', async () => {
    crear.mockResolvedValueOnce(fixtureClaude('complemento-irpf'));
    const { lectura, texto } = leer('resultado-irpf');
    (Anthropic as unknown as jest.Mock).mockClear();
    await completarConClaude(lectura, texto, decidirComplemento(lectura, texto, 'GASTO'), ctx);
    expect((Anthropic as unknown as jest.Mock).mock.calls[0][0]).toMatchObject({ timeout: 30_000, maxRetries: 0 });
  });

  it('con menos de 40 caracteres de texto no se llama: hay que leer con vision', async () => {
    const { lectura } = leer('resultado-irpf');
    expect(await completarConClaude(lectura, 'Factura :barcode:', [{ disparador: 'C1', texto: 'x' }], ctx)).toEqual({ tipo: 'sin_texto' });
    expect(crear).not.toHaveBeenCalled();
  });
});

describe('como se mezcla', () => {
  async function completar(nombre: string, respuesta: string): Promise<LecturaNormalizada> {
    crear.mockResolvedValueOnce(fixtureClaude(respuesta));
    const { lectura, texto } = leer(nombre);
    const r = await completarConClaude(lectura, texto, decidirComplemento(lectura, texto, 'GASTO'), ctx);
    if (r.tipo !== 'completada') throw new Error(r.tipo);
    return r.lectura;
  }

  it('IRPF: la retencion de la IA', async () => {
    const l = await completar('resultado-irpf', 'complemento-irpf');
    expect(l.retencion?.tipo).toEqual({ valor: 15, confianza: null, fuente: 'claude' });
    expect(l.retencion?.importe.valor).toBe(150);
    expect(l.totales.totalAPagar).toMatchObject({ valor: 1060, fuente: 'azure' }); // coinciden
  });

  it('recargo: el desglose de la IA cuadra y sustituye al de Azure', async () => {
    const l = await completar('resultado-recargo', 'complemento-recargo');
    expect(l.desglose).toHaveLength(1);
    expect(l.desglose[0]).toMatchObject({ tipoIva: 21, tipoRecargo: 5.2, base: { valor: 200, fuente: 'claude' }, cuotaRecargo: { valor: 10.4 } });
    expect(l.totales.cuotaIva.valor).toBe(42);
  });

  it('rectificativa: tipo de documento y la factura que rectifica', async () => {
    const l = await completar('resultado-rectificativa', 'complemento-rectificativa');
    expect(l.tipoDocumento).toEqual({ valor: 'rectificativa', confianza: null, fuente: 'claude' });
    expect(l.rectificativa?.numeroRectificada.valor).toBe('A-12');
  });

  it('la IA contradice un dato que Azure leyo seguro: se queda el de Azure, para revisar', async () => {
    const l = await completar('resultado-irpf', 'complemento-contradice');
    expect(l.numero.valor).toBe('F2026/0012');
    expect(l.numero.fuente).toBe('azure');
    expect(l.numero.motivo).toBe('Azure y la IA no coinciden (Azure: F2026/0012; IA: F2026/0021).');
  });

  it('si Azure dudaba y la IA lee otra cosa, se toma el de la IA pero queda para revisar', async () => {
    crear.mockResolvedValueOnce(fixtureClaude('complemento-contradice'));
    const { lectura, texto } = leer('resultado-confianza-baja');
    const azure = lectura.numero.valor;
    const r = await completarConClaude(lectura, texto, decidirComplemento(lectura, texto, 'GASTO'), ctx);
    if (r.tipo !== 'completada') throw new Error(r.tipo);
    expect(r.lectura.numero).toEqual({ valor: 'F2026/0021', confianza: null, fuente: 'claude', motivo: `Azure leyó «${azure}» con poca seguridad y la IA lee «F2026/0021»: compruébalo.` });
    const val = await validarLectura(r.lectura, ctx);
    expect(val.campos.numero?.estado).toBe('revisar');
  });

  it('si Azure no lo leyo, el de la IA sin mas', async () => {
    crear.mockResolvedValueOnce(fixtureClaude('complemento-contradice'));
    const { lectura, texto } = leer('resultado-confianza-baja');
    lectura.numero = { valor: null, confianza: null, fuente: 'azure' };
    const r = await completarConClaude(lectura, texto, decidirComplemento(lectura, texto, 'GASTO'), ctx);
    if (r.tipo !== 'completada') throw new Error(r.tipo);
    expect(r.lectura.numero).toEqual({ valor: 'F2026/0021', confianza: null, fuente: 'claude' });
  });

  it('un numero sacado del QR que la IA lee distinto: se queda el del QR, para revisar', async () => {
    crear.mockResolvedValueOnce(fixtureClaude('complemento-contradice'));
    const { lectura, texto, qr } = leer('resultado-irpf');
    lectura.numero = { valor: null, confianza: null, fuente: 'azure' };
    const l = compararQr(qr ?? { estado: 'VALIDO', verifactu: true, datos: { nif: 'B12345674', numserie: 'F2026/0012', fecha: '2026-03-04', importe: 1210 } }, lectura);
    expect(l.numero).toMatchObject({ valor: 'F2026/0012', fuente: 'qr', confianza: null });
    const r = await completarConClaude(l, texto, decidirComplemento(l, texto, 'GASTO'), ctx);
    if (r.tipo !== 'completada') throw new Error(r.tipo);
    expect(r.lectura.numero).toEqual({ valor: 'F2026/0012', confianza: null, fuente: 'qr', motivo: 'Se ha sacado del QR (F2026/0012) y la IA lee «F2026/0021» en la factura: compruébalo con el documento.' });
    // Y la segunda comparacion con el QR lo deja como sacado del QR, con ese motivo.
    const otra = compararQr(qr ?? { estado: 'VALIDO', verifactu: true, datos: { nif: 'B12345674', numserie: 'F2026/0012', fecha: '2026-03-04', importe: 1210 } }, r.lectura);
    expect(otra.qr?.completados).toContain('numero');
    expect(otra.numero.motivo).toMatch(/^Se ha sacado del QR \(F2026\/0012\) y la IA lee/);
  });

  /** Respuesta de la herramienta con este input. */
  const respuestaIa = (input: Record<string, unknown>) => ({ ...fixtureClaude('complemento-irpf'), content: [{ type: 'tool_use', id: 't', name: 'completar_factura', input }] });
  const ventas: ContextoValidacion = { ...ctx, lector: 'VENTA', nifEmpresa: 'B12345674' };

  it('ventas: el NIF del cliente dudoso se pregunta en nif_cliente y la respuesta va al cliente, no al emisor', async () => {
    const { lectura, texto } = leer('resultado-simple');
    lectura.receptor.nif = { valor: 'B8765432', confianza: 0.4, fuente: 'azure' };
    const preguntas = decidirComplemento(lectura, texto, 'VENTA');
    expect(preguntas.find((p) => p.disparador === 'C6')?.texto).toBe('Se leyó el NIF del cliente con poca seguridad (B8765432): confírmalo o corrígelo. Contesta en nif_cliente.');
    expect(JSON.stringify(mensajeParaClaude(lectura, texto!, preguntas))).toContain('\\"nif_cliente\\":\\"B8765432\\"');
    crear.mockResolvedValueOnce(respuestaIa({ nif_cliente: 'ES-B87654323' }));
    const r = await completarConClaude(lectura, texto, preguntas, ventas);
    if (r.tipo !== 'completada') throw new Error(r.tipo);
    expect(r.lectura.receptor.nif).toMatchObject({ valor: 'B87654323', fuente: 'claude' });
    expect(r.lectura.emisor.nif).toMatchObject({ valor: 'B12345674', fuente: 'azure' });
  });

  it('una fecha de la IA que no es AAAA-MM-DD no pisa la de Azure; la retencion con signo se toma en positivo', async () => {
    const { lectura, texto } = leer('resultado-irpf');
    lectura.fechaEmision = { valor: '2026-03-04', confianza: 0.6, fuente: 'azure' };
    crear.mockResolvedValueOnce(respuestaIa({ fecha: '04/03/2026', retencion: { porcentaje: -15, importe: -150 } }));
    const r = await completarConClaude(lectura, texto, decidirComplemento(lectura, texto, 'GASTO'), ctx);
    if (r.tipo !== 'completada') throw new Error(r.tipo);
    expect(r.lectura.fechaEmision).toEqual({ valor: '2026-03-04', confianza: 0.6, fuente: 'azure' });
    expect(r.lectura.retencion?.importe.valor).toBe(150);
    expect(r.lectura.retencion?.tipo.valor).toBe(15);
    expect((await validarLectura(r.lectura, ctx)).validaciones.map((x) => x.codigo)).not.toContain('CUADRE');
  });

  describe('IRPF con un solo total impreso', () => {
    /** resultado-irpf con los totales cambiados. */
    function irpf(cambio: (f: Record<string, any>) => void): LecturaHecha {
      const ar = fixtureAzure<{ analyzeResult: AnalyzeResult }>('resultado-irpf').analyzeResult;
      cambio(ar.documents![0].fields as Record<string, any>);
      const r = mapearFacturaAzure(ar);
      if (r.tipo !== 'hecho') throw new Error('x');
      return r;
    }
    async function completarCon(h: LecturaHecha): Promise<LecturaNormalizada> {
      crear.mockResolvedValueOnce(fixtureClaude('complemento-irpf'));
      const r = await completarConClaude(h.lectura, h.texto, decidirComplemento(h.lectura, h.texto, 'VENTA'), { ...ctx, lector: 'VENTA', nifEmpresa: 'B12345674' });
      if (r.tipo !== 'completada') throw new Error(r.tipo);
      return r.lectura;
    }

    it('el unico total es el total a pagar (1.060): el total de la factura se calcula y cuadra', async () => {
      const l = await completarCon(irpf((f) => (f.InvoiceTotal.valueCurrency.amount = 1060)));
      expect(l.totales.totalAPagar.valor).toBe(1060);
      // En ventas, con el nombre de la tarjeta: «total a cobrar».
      expect(l.totales.totalFactura).toMatchObject({ valor: 1210, fuente: 'calculado', motivo: MOTIVO_TOTAL_SIN_RETENCION_VENTA });
      expect(MOTIVO_TOTAL_SIN_RETENCION_VENTA).toMatch(/total a cobrar/);
      const val = await validarLectura(l, { ...ctx, lector: 'VENTA', nifEmpresa: 'B12345674' });
      expect(val.validaciones.map((x) => x.codigo)).not.toContain('CUADRE');
    });

    it('sin AmountDue, el total a pagar copiado del total no gana a la IA', async () => {
      const l = await completarCon(irpf((f) => delete f.AmountDue));
      expect(l.totales.totalFactura.valor).toBe(1210);
      expect(l.totales.totalAPagar).toMatchObject({ valor: 1060, fuente: 'claude' });
      const val = await validarLectura(l, ctx);
      expect(val.validaciones.map((x) => x.codigo)).not.toContain('CUADRE');
      expect(aGastoExtraido(l, val.validaciones, 0.9).total).toBe(1060);
    });
  });

  it('un desglose de la IA que no cuadra no sustituye al de Azure', async () => {
    crear.mockResolvedValueOnce({ ...fixtureClaude('complemento-recargo'), content: [{ type: 'tool_use', id: 't', name: 'completar_factura', input: { desglose: [{ tipo_iva: 21, base: 300, cuota: 63 }] } }] });
    const { lectura, texto } = leer('resultado-recargo');
    const r = await completarConClaude(lectura, texto, decidirComplemento(lectura, texto, 'GASTO'), ctx);
    if (r.tipo !== 'completada') throw new Error(r.tipo);
    expect(r.lectura.desglose[0].base.valor).toBe(200);
    expect(r.lectura.desglose[0].base.motivo).toMatch(/desglose/);
  });
});

describe('sin Claude', () => {
  it('sin clave: lo de Azure con el aviso, y lo afectado a revisar, sin llamar', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { lectura, texto } = leer('resultado-irpf');
    const r = await completarConClaude(lectura, texto, decidirComplemento(lectura, texto, 'GASTO'), ctx);
    expect(r.tipo).toBe('sin_complemento');
    if (r.tipo !== 'sin_complemento') return;
    expect(r.lectura.avisos).toContain(AVISO_SIN_COMPLEMENTO);
    expect(r.lectura.retencion?.tipo.motivo).toBeDefined();
    expect(crear).not.toHaveBeenCalled();
  });

  it('un 401 de Anthropic: igual, y al log solo el estado y el tipo de error', async () => {
    crear.mockRejectedValueOnce(Object.assign(new Error('invalid x-api-key IMPRENTA LEVANTE'), { status: 401, error: { error: { type: 'authentication_error', message: 'invalid x-api-key' } } }));
    const aviso = jest.spyOn(logger, 'warn');
    const { lectura, texto } = leer('resultado-irpf');
    const r = await completarConClaude(lectura, texto, decidirComplemento(lectura, texto, 'GASTO'), ctx);
    expect(r.tipo).toBe('sin_complemento');
    expect(aviso).toHaveBeenCalledWith('[ocr-claude] El complemento con Claude ha fallado', { http: 401, tipo: 'authentication_error' });
    expect(JSON.stringify(aviso.mock.calls)).not.toContain('IMPRENTA');
    aviso.mockRestore();
  });

  it('el mensaje se arma igual para ventas', () => {
    const { lectura, texto } = leer('resultado-simple');
    expect((mensajeParaClaude(lectura, texto!, [{ disparador: 'C5', texto: 'Tipo' }]).content as Array<{ text: string }>)[0].text).toContain('1. Tipo');
  });
});
