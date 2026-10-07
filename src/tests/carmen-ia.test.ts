/**
 * Carmen, capa de IA: topes, coste con `usage`, depuración de datos, validador
 * de cifras y la petición que se hace a la API (cliente simulado: NUNCA se
 * llama a la API real).
 */
const mockPrisma = {
  carmenContador: { createMany: jest.fn(), findMany: jest.fn() },
  $executeRaw: jest.fn(),
  $transaction: jest.fn(),
};
jest.mock('../config/database', () => ({ prisma: mockPrisma }));

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/env';
import { costeUsd, reservaUsd } from '../services/carmen/precios';
import { clavesContador, devolver, liquidar, motivoSinIA, reservar } from '../services/carmen/presupuesto.service';
import { AVISO_RECORTADA, construirMensajes, fijarClienteIA, hastaUltimaFrase, preguntarIA, type PeticionIA } from '../services/carmen/llm';
import { depurarParaIA } from '../services/carmen/depurar';
import { validarCifras, extraerCifras } from '../services/carmen/validarCifras';
import { systemPrompt } from '../services/carmen/llm-prompt';
import { tokensNombre, type Tercero } from '../services/carmen/terceros';
import { FICHAS } from '../services/carmen/faq/faq.data';

const HOY = '2026-10-07';
const crear = jest.fn();
const cfg = config as unknown as { anthropicApiKey?: string; carmen: { llmActivo: boolean; modelo: string; maxTokensSalida: number; topeMensualEur: number } };

/** Texto de todas las sentencias SQL ejecutadas con $executeRaw (plantilla + valores). */
const sqlEjecutado = () =>
  mockPrisma.$executeRaw.mock.calls.map(([partes, ...valores]: [TemplateStringsArray, ...unknown[]]) => ({ sql: partes.join('?'), valores: valores.map(String) }));

beforeEach(() => {
  mockPrisma.carmenContador.createMany.mockResolvedValue({ count: 4 });
  mockPrisma.$executeRaw.mockReset();
  mockPrisma.$executeRaw.mockResolvedValue(1);
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(mockPrisma));
  crear.mockReset();
  fijarClienteIA({ messages: { create: crear } } as never);
});
afterAll(() => fijarClienteIA(null));

describe('precios y topes', () => {
  it('la configuración por defecto: Haiku 4.5, 500 tokens, 5 € al mes, 100/15 preguntas al día, apagada', () => {
    expect(cfg.carmen.modelo).toBe('claude-haiku-4-5-20251001');
    expect(cfg.carmen.maxTokensSalida).toBe(500);
    expect(cfg.carmen.topeMensualEur).toBe(5);
    expect(config.carmen.topeEmpresaDia).toBe(100);
    expect(config.carmen.topeUsuarioDia).toBe(15);
    expect(config.carmen.llmActivo).toBe(false);
  });

  it('CARMEN_MODELO solo admite Haiku 4.5: otro modelo (o una errata) no arranca', () => {
    const antes = process.env.CARMEN_MODELO;
    const errores = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (const modelo of ['claude-sonnet-4-5', 'claude-haiku-4-5-2025100', 'cualquiera']) {
        process.env.CARMEN_MODELO = modelo;
        expect(() => jest.isolateModules(() => require('../config/env'))).toThrow(/entorno/);
      }
      process.env.CARMEN_MODELO = 'claude-haiku-4-5';
      jest.isolateModules(() => {
        const { config: otra } = require('../config/env') as typeof import('../config/env');
        expect(otra.carmen.modelo).toBe('claude-haiku-4-5');
      });
    } finally {
      if (antes === undefined) delete process.env.CARMEN_MODELO;
      else process.env.CARMEN_MODELO = antes;
      errores.mockRestore();
    }
  });

  it('la reserva es el peor caso (3.500 de entrada y 500 de salida = 0,006 $)', () => {
    expect(reservaUsd('claude-haiku-4-5-20251001', 500)).toBeCloseTo(0.006, 6);
    // Un modelo desconocido se reserva al precio más caro.
    expect(reservaUsd('modelo-nuevo', 500)).toBeGreaterThan(0.05);
  });

  it('el coste sale de usage: entrada 1 $, salida 5 $, caché 1,25/2/0,10 $ por millón', () => {
    expect(costeUsd('claude-haiku-4-5-20251001', { input_tokens: 1_000_000, output_tokens: 0 })).toBe(1);
    expect(costeUsd('claude-haiku-4-5-20251001', { input_tokens: 0, output_tokens: 1_000_000 })).toBe(5);
    expect(
      costeUsd('claude-haiku-4-5-20251001', {
        input_tokens: 2000,
        output_tokens: 300,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 4000,
        cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 400 },
      }),
    ).toBeCloseTo((2000 * 1 + 300 * 5 + 600 * 1.25 + 400 * 2 + 4000 * 0.1) / 1e6, 6);
  });

  it('claves de los contadores: mes global, día de empresa y de usuario', () => {
    expect(clavesContador('E1', 'U1', HOY)).toEqual({
      global: 'global:2026-10',
      empresaDia: 'empresa:E1:2026-10-07',
      usuarioDia: 'usuario:U1:2026-10-07',
      empresaMes: 'empresa:E1:2026-10',
    });
  });

  it('reservar: UPDATE condicionales en una transacción; si uno no afecta a ninguna fila, no hay IA', async () => {
    expect(await reservar('E1', 'U1', HOY, 100)).toMatchObject({ ok: true, reserva: { usd: 0.006 } });
    const sql = sqlEjecutado();
    expect(sql[0].sql).toMatch(/costeUsd` \+ \? <= \?/);
    expect(sql[0].valores).toContain('global:2026-10');
    expect(sql[1].sql).toMatch(/consultasIA` < \?/);
    expect(sql[1].valores).toContain('100');
    expect(sql[2].valores).toContain('15');

    mockPrisma.$executeRaw.mockReset();
    mockPrisma.$executeRaw.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    expect(await reservar('E1', 'U1', HOY, 100)).toEqual({ ok: false, motivo: 'tope_empresa' });
    mockPrisma.$executeRaw.mockReset();
    mockPrisma.$executeRaw.mockResolvedValueOnce(0);
    expect(await reservar('E1', 'U1', HOY, 100)).toEqual({ ok: false, motivo: 'tope_mensual' });
  });

  it('devolver deshace la reserva en las cuatro claves, una a una y en el orden de reservar', async () => {
    await devolver({ claves: clavesContador('E1', 'U1', HOY), usd: 0.006 });
    const sql = sqlEjecutado();
    expect(sql).toHaveLength(4);
    // Cada sentencia bloquea una sola fila, en el mismo orden que reservar: sin interbloqueos.
    expect(sql.map((s) => s.valores[s.valores.length - 1])).toEqual(['global:2026-10', 'empresa:E1:2026-10-07', 'usuario:U1:2026-10-07', 'empresa:E1:2026-10']);
    for (const s of sql) expect(s.sql).not.toMatch(/\bIN\b/);
    expect(sql[0].sql).toMatch(/costeUsd` - \?/);
    expect(sql[3].sql).toMatch(/costeUsd` - \?/);
  });

  it('liquidar ajusta global y después la empresa, cada una en su sentencia', async () => {
    await liquidar({ claves: clavesContador('E1', 'U1', HOY), usd: 0.006 }, 0.0025);
    const sql = sqlEjecutado();
    expect(sql.map((s) => s.valores[s.valores.length - 1])).toEqual(['global:2026-10', 'empresa:E1:2026-10']);
    for (const s of sql) expect(s.sql).not.toMatch(/\bIN\b/);
  });

  it('motivo real cuando no hay IA, en orden', () => {
    const uso = { gastoMesEur: 0, consultasEmpresaHoy: 0, topeEmpresaDia: 100, consultasUsuarioHoy: 0, topeUsuarioDia: 15 };
    expect(motivoSinIA({ iaActivaEmpresa: true }, uso)).toBe('apagada');
    const antes = { clave: cfg.anthropicApiKey, llm: cfg.carmen.llmActivo };
    cfg.carmen.llmActivo = true;
    cfg.anthropicApiKey = undefined;
    expect(motivoSinIA({ iaActivaEmpresa: true }, uso)).toBe('sin_clave');
    cfg.anthropicApiKey = 'clave-de-prueba-no-real';
    expect(motivoSinIA({ iaActivaEmpresa: false }, uso)).toBe('desactivada_empresa');
    expect(motivoSinIA({ iaActivaEmpresa: true }, { ...uso, gastoMesEur: 4.996 })).toBe('tope_mensual');
    expect(motivoSinIA({ iaActivaEmpresa: true }, { ...uso, consultasEmpresaHoy: 100 })).toBe('tope_empresa');
    expect(motivoSinIA({ iaActivaEmpresa: true }, { ...uso, consultasUsuarioHoy: 15 })).toBe('tope_usuario');
    expect(motivoSinIA({ iaActivaEmpresa: true }, uso)).toBeNull();
    cfg.anthropicApiKey = antes.clave;
    cfg.carmen.llmActivo = antes.llm;
  });
});

describe('lo que se envía a la IA', () => {
  const terceros: Tercero[] = [
    { id: 'c1', rol: 'cliente', nombre: 'CONSTRUCCIONES PÉREZ SL', tokens: tokensNombre('CONSTRUCCIONES PÉREZ SL'), nif: 'B11111111' },
    { id: 'p1', rol: 'proveedor', nombre: 'Iberdrola Clientes SAU', tokens: tokensNombre('Iberdrola Clientes SAU') },
  ];

  it('depura NIF, IBAN, correos, teléfonos y nombres de terceros; los importes se quedan', () => {
    const t = depurarParaIA(
      'Construcciones Perez (B11111111, ES91 2100 0418 4502 0005 1332, pagos@perez.es, 612 345 678) me debe 1.500 € e Iberdrola clientes me cobra',
      terceros,
    );
    expect(t).not.toMatch(/perez|B11111111|ES91|2100 0418|@|612 345 678|iberdrola/i);
    expect(t).toContain('un cliente');
    expect(t).toContain('un proveedor');
    expect(t).toContain('[NIF]');
    expect(t).toContain('[IBAN]');
    expect(t).toContain('[EMAIL]');
    expect(t).toContain('[TELÉFONO]');
    expect(t).toContain('1.500 €');
  });

  it('también tapa los nombres a medias: «Pérez Martínez» o «Fernández Ruiz» sin el resto del nombre', () => {
    const conPartes: Tercero[] = [
      ...terceros,
      { id: 'c2', rol: 'cliente', nombre: 'Construcciones Pérez Martínez SL', tokens: tokensNombre('Construcciones Pérez Martínez SL') },
      { id: 'c3', rol: 'cliente', nombre: 'María José Fernández Ruiz', tokens: tokensNombre('María José Fernández Ruiz') },
    ];
    const a = depurarParaIA('¿Qué es el concurso de acreedores y cómo afecta si Pérez Martínez entra en él?', conPartes);
    expect(a).toBe('¿Qué es el concurso de acreedores y cómo afecta si un cliente entra en él?');
    const b = depurarParaIA('¿Qué es la prorrata del IVA en el caso de Fernández Ruiz que es autónoma?', conPartes);
    expect(b).not.toMatch(/fern[aá]ndez|ruiz/i);
    expect(b).toContain('un cliente');
    // Las palabras del vocabulario contable no se tocan aunque estén en un nombre («clientes» de Iberdrola Clientes).
    expect(depurarParaIA('¿Cómo cobro a mis clientes por adelantado?', conPartes)).toBe('¿Cómo cobro a mis clientes por adelantado?');
  });

  it('el system prompt lleva los menús reales y las reglas, sin fecha ni datos de la empresa', () => {
    const s = systemPrompt();
    expect(s).toContain('Ventas → Facturas de ingreso');
    expect(s).toContain('Fiscalidad → Modelos Fiscales → Modelo 303');
    expect(s).toMatch(/No des, calcules ni inventes cifras de la empresa/);
    expect(s).toMatch(/asesor/);
    expect(s).toMatch(/120 palabras/);
    expect(s).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
    expect(s).not.toMatch(/emoji[^s]/i);
  });

  it('recorta para no pasar de 3.500 tokens: primero los turnos, luego las fichas', () => {
    const largo = 'x'.repeat(4000);
    const { messages, fichasUsadas } = construirMensajes({
      hoy: HOY,
      pregunta: '¿Qué es el criterio de caja?',
      fichas: FICHAS.slice(0, 3),
      turnos: [
        { pregunta: largo, respuesta: largo },
        { pregunta: 'hola', respuesta: 'hola' },
      ],
    });
    const total = [systemPrompt(), ...messages.map((m) => String(m.content))].join('').length / 3;
    expect(total).toBeLessThanOrEqual(3500);
    expect(messages.some((m) => String(m.content).includes(largo))).toBe(false);
    expect(fichasUsadas.length).toBeGreaterThan(0);
  });
});

describe('preguntarIA', () => {
  const peticion: PeticionIA = {
    companyId: 'E1',
    userId: 'U1',
    hoy: HOY,
    topeEmpresa: 100,
    pregunta: '¿Qué es el criterio de caja?',
    fichas: FICHAS.filter((f) => f.id === 'cont-iva-repercutido-soportado'),
    turnos: [],
  };
  const respuesta = (texto: string, usage = { input_tokens: 1500, output_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }) => ({
    content: [{ type: 'text', text: texto }],
    usage,
    stop_reason: 'end_turn',
  });

  it('una sola llamada a Haiku, sin thinking ni herramientas, con max_tokens ≤ 500 y sin datos de la empresa', async () => {
    crear.mockResolvedValue(respuesta('El criterio de caja retrasa el IVA hasta el cobro. Consúltalo con tu asesor.'));
    const r = await preguntarIA(peticion);
    expect(r.tipo).toBe('ok');
    expect(crear).toHaveBeenCalledTimes(1);
    const body = crear.mock.calls[0][0];
    expect(body.model).toBe('claude-haiku-4-5-20251001');
    expect(body.max_tokens).toBeLessThanOrEqual(500);
    expect(body.temperature).toBe(0.2);
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('tools');
    expect(JSON.stringify(body)).toContain('07/10/2026');
  });

  it('liquida con el coste real de usage (la reserva se ajusta a la baja)', async () => {
    crear.mockResolvedValue(respuesta('Texto sin cifras.', { input_tokens: 2000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }));
    const r = await preguntarIA(peticion);
    expect(r.auditoria).toMatchObject({ estado: 'ok', tokensEntrada: 2000, tokensSalida: 100, costeUsd: 0.0025, reservaUsd: 0.006 });
    const ajuste = sqlEjecutado().find((x) => /GREATEST\(`costeUsd` \+ \?/.test(x.sql));
    expect(ajuste?.valores[0]).toBe('-0.0035');
  });

  it('con un error de la API devuelve la reserva y el motivo no menciona la clave', async () => {
    crear.mockRejectedValue(new Anthropic.APIError(529, { type: 'error' }, 'Overloaded', new Headers()));
    const r = await preguntarIA(peticion);
    expect(r.tipo).toBe('error');
    expect(r.auditoria.motivo).toBe('api_529');
    expect(sqlEjecutado().some((x) => /costeUsd` - \?/.test(x.sql))).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/ANTHROPIC_API_KEY|clave/i);
  });

  it('una sobrecarga (529) se reintenta una vez con la misma reserva, sin reservar ni devolver nada más', async () => {
    crear.mockRejectedValueOnce(new Anthropic.APIError(529, { type: 'error' }, 'Overloaded', new Headers()));
    crear.mockResolvedValueOnce(respuesta('Texto sin cifras.'));
    const r = await preguntarIA(peticion);
    expect(r.tipo).toBe('ok');
    expect(crear).toHaveBeenCalledTimes(2);
    expect(sqlEjecutado().filter((x) => /costeUsd` \+ \? <= \?/.test(x.sql))).toHaveLength(1);
    expect(sqlEjecutado().some((x) => /costeUsd` - \?/.test(x.sql))).toBe(false);
  });

  it('con el tiempo agotado no devuelve la reserva (puede haberse cobrado) ni reintenta', async () => {
    crear.mockRejectedValue(new Anthropic.APIConnectionTimeoutError({ message: 'Request timed out.' }));
    const r = await preguntarIA(peticion);
    expect(r.tipo).toBe('error');
    expect(crear).toHaveBeenCalledTimes(1);
    expect(r.auditoria).toMatchObject({ estado: 'error', motivo: 'tiempo_agotado', costeUsd: 0.006 });
    // Nada de devolver: ni el gasto ni las preguntas del día.
    expect(sqlEjecutado().some((x) => /GREATEST\(`costeUsd` - \?|GREATEST\(`consultasIA` - 1/.test(x.sql))).toBe(false);
  });

  it('una conexión cortada tampoco devuelve la reserva', async () => {
    crear.mockRejectedValue(new Anthropic.APIConnectionError({ message: 'Connection error.' }));
    const r = await preguntarIA(peticion);
    expect(r.auditoria).toMatchObject({ estado: 'error', motivo: 'conexion', costeUsd: 0.006 });
    expect(sqlEjecutado().some((x) => /consultasIA` - 1/.test(x.sql))).toBe(false);
  });

  it('el cliente de la API no reintenta por su cuenta (maxRetries 0)', async () => {
    fijarClienteIA(null);
    const cfgClave = cfg.anthropicApiKey;
    cfg.anthropicApiKey = 'clave-de-prueba-no-real-para-el-constructor';
    // Nunca se llama a la API real: el método del SDK está simulado.
    const espia = jest.spyOn(Anthropic.Messages.prototype, 'create').mockRejectedValue(new Anthropic.APIError(400, { type: 'error' }, 'Bad request', new Headers()) as never);
    try {
      const r = await preguntarIA(peticion);
      expect(r.tipo).toBe('error');
      expect(espia).toHaveBeenCalledTimes(1);
      const recurso = espia.mock.contexts[0] as unknown as { _client: { maxRetries: number; timeout: number } };
      expect(recurso._client.maxRetries).toBe(0);
      expect(recurso._client.timeout).toBe(15_000);
    } finally {
      espia.mockRestore();
      cfg.anthropicApiKey = cfgClave;
      fijarClienteIA({ messages: { create: crear } } as never);
    }
  });

  it('una respuesta cortada en los 500 tokens se deja hasta la última frase completa, con aviso', async () => {
    crear.mockResolvedValue({
      ...respuesta('El recargo de equivalencia es un régimen especial del IVA para comerciantes minoristas. El proveedor te cobra un recargo además del IVA y además deberás'),
      stop_reason: 'max_tokens',
    });
    const r = await preguntarIA(peticion);
    expect(r.tipo).toBe('ok');
    if (r.tipo !== 'ok') return;
    expect(r.texto).toBe(`El recargo de equivalencia es un régimen especial del IVA para comerciantes minoristas.\n\n${AVISO_RECORTADA}`);
    expect(r.auditoria.motivo).toBe('recortada');
    expect(hastaUltimaFrase('Sin ninguna frase acabada y además deberás')).toBeNull();
    crear.mockResolvedValue({ ...respuesta('Una frase corta. y además deberás'), stop_reason: 'max_tokens' });
    expect(await preguntarIA(peticion)).toMatchObject({ tipo: 'descartada', auditoria: { motivo: 'truncada' } });
  });

  it('si falla la liquidación, la respuesta (ya pagada) se entrega igual', async () => {
    crear.mockResolvedValue(respuesta('Texto sin cifras.'));
    // Reserva (4 sentencias) bien; la primera de la liquidación falla.
    mockPrisma.$executeRaw
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('Deadlock found when trying to get lock'));
    const r = await preguntarIA(peticion);
    expect(r.tipo).toBe('ok');
  });

  it('sin tope disponible no llama a la API', async () => {
    mockPrisma.$executeRaw.mockResolvedValueOnce(0);
    const r = await preguntarIA(peticion);
    expect(r).toMatchObject({ tipo: 'sin_tope', motivo: 'tope_mensual' });
    expect(crear).not.toHaveBeenCalled();
  });

  it('descarta (sin regenerar) una respuesta con cifras sin respaldo', async () => {
    crear.mockResolvedValue(respuesta('El tipo general del IVA es el 21 % y el reducido el 10 %. El límite es de 3.005,06 €.'));
    const r = await preguntarIA(peticion);
    expect(r.tipo).toBe('descartada');
    expect(crear).toHaveBeenCalledTimes(1);
  });
});

describe('validador de cifras', () => {
  it('saca importes, porcentajes, fechas y números de 3 o más cifras', () => {
    const c = extraerCifras('El 303 vence el 20/10/2026; son 1.234,56 € al 21 % y 450 operaciones; el 30 de enero.');
    expect(c.map((x) => x.tipo).sort()).toEqual(['fecha', 'fecha', 'importe', 'numero', 'numero', 'porcentaje'].sort());
  });

  it('valen las cifras de la pregunta o de las fichas, los modelos, los años 2024-2028 y los trimestres', () => {
    expect(validarCifras('El modelo 303 del 3T de 2026.', []).ok).toBe(true);
    expect(validarCifras('Son 1.210 € con el IVA.', ['Una venta de 1.000 € más 210 € de IVA: 1.210 €.']).ok).toBe(true);
    expect(validarCifras('Se presenta hasta el 20 de octubre.', ['Hoy es 07/10/2026.']).ok).toBe(false);
    expect(validarCifras('Un 15 % de retención.', ['¿Qué retención llevo?']).ok).toBe(false);
    expect(validarCifras('En 2031 cambiará.', []).ok).toBe(false);
  });

  it('la fecha de hoy solo vale como fecha: su día y su mes no respaldan un porcentaje ni un importe', () => {
    // En octubre, «10 %» no puede salir de «Hoy es 07/10/2026».
    expect(validarCifras('El corte de pelo lleva el 10 % de IVA.', ['¿Qué IVA lleva el corte de pelo en una peluquería?'], { fechas: [HOY] }).ok).toBe(false);
    expect(validarCifras('Hoy, 7 de octubre, todavía estás en plazo.', ['¿Llego a tiempo?'], { fechas: [HOY] }).ok).toBe(true);
    expect(validarCifras('Son 7 €.', ['¿Cuánto es?'], { fechas: [HOY] }).ok).toBe(false);
  });

  it('detecta los importes con «mil» o «millones» y los escritos con palabras', () => {
    expect(validarCifras('El límite son 2 millones de euros.', ['¿Hay un límite?']).ok).toBe(false);
    expect(validarCifras('Te saldrán unos tres mil euros a pagar.', ['¿Cuánto pagaré?']).ok).toBe(false);
    expect(validarCifras('Se aplica el veintiuno por ciento.', ['¿Qué tipo se aplica?']).ok).toBe(false);
    expect(validarCifras('El límite es de un millón de euros.', ['El límite es de 1.000.000 € al año.']).ok).toBe(true);
    expect(validarCifras('Hasta 6 millones de euros.', ['Con un volumen de operaciones de hasta 6.000.000 €.']).ok).toBe(true);
    expect(validarCifras('Lo hacen dos o tres personas.', ['¿Quién lo hace?']).ok).toBe(true);
    expect(extraerCifras('unos tres mil quinientos euros').map((c) => c.valor)).toEqual(['3500']);
  });
});
