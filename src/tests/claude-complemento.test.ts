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

import { mapearFacturaAzure } from '../services/lectura/azure-factura.mapper';
import type { AnalyzeResult } from '../services/lectura/azure-di.client';
import { AVISO_SIN_COMPLEMENTO, completarConClaude, decidirComplemento, mensajeParaClaude, prepararTexto } from '../services/lectura/claude-complemento';
import type { LecturaHecha, LecturaNormalizada } from '../services/lectura/tipos';
import type { ContextoValidacion } from '../services/lectura/validaciones';
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
  process.env.ANTHROPIC_API_KEY = 'sk-ant-prueba';
  crear.mockReset();
});
afterAll(() => {
  if (antes === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = antes;
});

describe('cuando se llama', () => {
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

  it('si Azure dudaba, se toma el dato de la IA', async () => {
    crear.mockResolvedValueOnce(fixtureClaude('complemento-contradice'));
    const { lectura, texto } = leer('resultado-confianza-baja');
    const r = await completarConClaude(lectura, texto, decidirComplemento(lectura, texto, 'GASTO'), ctx);
    if (r.tipo !== 'completada') throw new Error(r.tipo);
    expect(r.lectura.numero).toEqual({ valor: 'F2026/0021', confianza: null, fuente: 'claude' });
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
