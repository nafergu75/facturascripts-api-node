/**
 * Carmen: enrutador de 3 capas (datos → fichas → IA) con frases etiquetadas.
 *
 * Objetivos (especificación, sección 10.5):
 *  - ≥ 90 % de acierto de intención en las preguntas de datos;
 *  - 0 preguntas de datos en la capa de IA (el cliente simulado no se llama);
 *  - las preguntas genéricas no disparan ninguna intención.
 * Sin BD ni API real: Prisma, los ejecutores de datos y Anthropic simulados.
 */
const mockPrisma = {
  customer: { findMany: jest.fn() },
  supplier: { findMany: jest.fn() },
  bankAccount: { findMany: jest.fn() },
  carmenContador: { createMany: jest.fn(), findMany: jest.fn() },
  modeloImpuesto: { findUnique: jest.fn() },
  chatMessage: { findMany: jest.fn() },
  $executeRaw: jest.fn(),
  $transaction: jest.fn(),
};
jest.mock('../config/database', () => ({ prisma: mockPrisma }));

jest.mock('../services/carmen/intenciones/datos', () => {
  const ejecutor = (id: string) => jest.fn(async () => ({ entendido: id, texto: `Cifras de ${id}`, permisoRequerido: 'x' }));
  return {
    EJECUTORES: {
      deudaDeCliente: ejecutor('INT-01'),
      pendienteDeCobro: ejecutor('INT-02'),
      facturasVencidas: ejecutor('INT-03'),
      cobradoEnPeriodo: ejecutor('INT-05'),
      asientosPendientes: ejecutor('INT-23'),
      saldoBancos: ejecutor('INT-24'),
      ultimosMovimientos: ejecutor('INT-25'),
      proximosImpuestos: ejecutor('INT-30'),
      resumenEmpresa: ejecutor('INT-39'),
    },
    soloPantalla: (_permisos: string[], _area: string, titulo: string) => jest.fn(async () => ({ entendido: titulo, texto: 'Lo tienes en su pantalla.', sinCifras: true })),
  };
});

import { config } from '../config/env';
import { responder, type EntradaCarmen } from '../services/carmen/enrutador';
import { fijarClienteIA } from '../services/carmen/llm';
import { olvidarIndices } from '../services/carmen/terceros';
import type { CarmenCtx } from '../services/carmen/tipos';
import type { AjustesCarmen } from '../services/carmen/ajustes.service';

const HOY = '2026-10-07';
const admin: CarmenCtx = { companyId: 'E1', userId: 'U1', permisos: new Set(['*']), esAdminGlobal: false, esAdminEmpresa: true, puedeNominas: true, hoy: HOY };
const iaActiva: AjustesCarmen = { iaActiva: true, topeConsultasDia: null, conservarDias: 90 };
const crearMensaje = jest.fn();
const cfg = config as unknown as { anthropicApiKey?: string; carmen: { llmActivo: boolean } };
const original = { clave: cfg.anthropicApiKey, llm: cfg.carmen.llmActivo };

beforeAll(() => {
  cfg.anthropicApiKey = 'clave-de-prueba-no-real';
  cfg.carmen.llmActivo = true;
  fijarClienteIA({ messages: { create: crearMensaje } } as never);
});
afterAll(() => {
  cfg.anthropicApiKey = original.clave;
  cfg.carmen.llmActivo = original.llm;
  fijarClienteIA(null);
});

beforeEach(() => {
  olvidarIndices();
  mockPrisma.customer.findMany.mockResolvedValue([
    { id: 'c1', nombreFiscal: 'CONSTRUCCIONES PÉREZ SL', nifCif: 'B11111111' },
    { id: 'c2', nombreFiscal: 'Talleres Martínez SA', nifCif: 'A22222222' },
    { id: 'c3', nombreFiscal: 'HERMANOS RUIZ SL', nifCif: 'B33333333' },
  ]);
  mockPrisma.supplier.findMany.mockResolvedValue([
    { id: 'p1', nombreFiscal: 'IBERDROLA CLIENTES SAU', nifCif: 'A44444444' },
    { id: 'p2', nombreFiscal: 'REPSOL COMERCIAL SA', nifCif: 'A55555555' },
  ]);
  mockPrisma.bankAccount.findMany.mockResolvedValue([{ id: 'b1', bancoNombre: 'Banco Sabadell', iban: 'ES0000000000000000001234' }]);
  mockPrisma.carmenContador.findMany.mockResolvedValue([]);
  mockPrisma.carmenContador.createMany.mockResolvedValue({ count: 4 });
  mockPrisma.$executeRaw.mockResolvedValue(1);
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(mockPrisma));
  mockPrisma.modeloImpuesto.findUnique.mockResolvedValue(null);
  crearMensaje.mockReset();
  crearMensaje.mockResolvedValue({
    content: [{ type: 'text', text: 'Respuesta general de prueba.' }],
    usage: { input_tokens: 1200, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    stop_reason: 'end_turn',
  });
});

const preguntar = (message: string, extra: Partial<EntradaCarmen> = {}, ctx = admin, ajustes = iaActiva) => responder(ctx, { message, ...extra }, null, ajustes);

// ---------------- Frases etiquetadas ----------------

const DATOS: Record<string, string[]> = {
  'INT-01': [
    '¿cuánto me debe Construcciones Pérez?',
    'lo q me deve talleres martinez',
    '¿Hermanos Ruiz me ha pagado ya?',
    'que facturas tiene pendientes construcciones perez',
    'deuda de talleres martinez',
    'cuanto nos debe hermanos ruiz',
    '¿me debe algo const perez?',
    'saldo pendiente de talleres martinez',
  ],
  'INT-02': [
    '¿quién me debe dinero?',
    'cuanto tengo por cobrar',
    'facturas pendientes de cobro',
    'que me deben los clientes',
    'cuánto me deben en total',
    'facturas sin cobrar',
    'cobros pendientes',
    'qué tengo que cobrar',
    'cuanto dinero me deben',
    'lo pendiente de cobro',
  ],
  'INT-03': [
    '¿qué facturas están vencidas?',
    'morosos',
    'facturas con más de 60 días de retraso',
    'clientes que no me han pagado',
    'facturas vencidas sin cobrar',
    'facturas impagadas',
    'cuanto tengo vencido',
    'quien va atrasado en los pagos',
    'listado de morosos',
    'facturas bencidas',
  ],
  'INT-05': [
    '¿cuánto he cobrado este mes?',
    'cobros del trimestre',
    '¿cuánto he pagado en septiembre?',
    'total cobrado este año',
    'cuanto hemos cobrado el mes pasado',
    'pagos de este mes',
    'que he cobrado esta semana',
    'cobros de octubre',
    'total pagado el año pasado',
    'cuanto cobre en agosto',
  ],
  'INT-06': [
    '¿qué le debo a Iberdrola?',
    '¿qué tengo que pagar esta semana?',
    'facturas de proveedores vencidas',
    'cuanto debo a proveedores',
    'pagos pendientes',
    'proximos pagos a proveedores',
    'facturas de compra sin pagar',
    'que facturas tengo por pagar',
    'deudas con proveedores',
  ],
  'INT-09': [
    '¿cuánto he facturado este trimestre?',
    'ventas de septiembre',
    '¿cuánto he gastado este año?',
    'total facturado el año pasado',
    'cuanto llevo facturado',
    'gastos del mes',
    'cuanto hemos vendido este mes',
    'total de compras del trimestre',
    'cuanto factire el mes pasado',
    'facturacion de 2025',
  ],
  'INT-13': ['busca la factura 2026-0045', '¿está cobrada la A-12?', 'estado de la factura A-77', 'se ha pagado la factura 2026-0102', 'encuentra la factura B-3'],
  'INT-18': [
    '¿cuánto gano este año?',
    '¿voy en beneficios?',
    'PyG de 2025',
    'resultado del ejercicio',
    'estoy ganando o perdiendo dinero',
    'beneficio del trimestre',
    'que margen tengo',
    'tengo perdidas',
    'cuenta de resultados de este año',
  ],
  'INT-23': ['¿tengo asientos sin contabilizar?', 'asientos por revisar', 'cuantos asientos pendientes hay', 'asientos en borrador', 'quedan asientos por aprobar', 'hay asientos sin aprobar'],
  'INT-24': [
    '¿cuánto dinero tengo en el banco?',
    'saldo del sabadell',
    'saldo de la cuenta acabada en 1234',
    'cuánto hay en las cuentas',
    'saldo de bancos',
    'que saldo tengo en el banco',
    'cuanto dinero hay en caja',
  ],
  'INT-25': [
    'últimos movimientos',
    '¿qué ha entrado hoy?',
    'cargos de repsol',
    'movimientos de más de 1.000 €',
    'que ha salido del banco esta semana',
    'ultimos cargos del banco',
    'movimientos del banco de este mes',
    'transferencias recibidas',
  ],
  'INT-28': [
    '¿cuánto IVA pago este trimestre?',
    'el 303 del 3T',
    '¿me sale a devolver el iva?',
    'cuanto me sale el iva',
    'resultado del 303',
    'iva a pagar del trimestre',
    'cuanto tengo que pagar de iva',
    'liquidacion del iva',
  ],
  'INT-30': ['¿qué impuestos tengo que presentar?', '¿tengo algo caducado?', 'proximos impuestos', 'que declaraciones me tocan este trimestre', 'que tengo pendiente con hacienda', 'que modelos hay que presentar este mes'],
  'INT-39': ['dame un resumen', 'buenos días, ¿qué tengo hoy?', 'como va la empresa', 'como vamos', 'resumen de la situacion'],
};

/** Preguntas genéricas: ninguna intención, y con la IA activa van a la IA. */
const GENERICAS = [
  '¿Qué es el criterio de caja?',
  '¿Puedo deducirme el IVA del coche?',
  '¿Qué tipo de IVA lleva la fruta?',
  '¿Cómo se amortiza un ordenador?',
  '¿Qué gastos puedo deducir siendo autónomo?',
  '¿Cuánto cuesta contratar a un abogado?',
  '¿Qué es el recargo de equivalencia?',
  '¿Qué es la inversión del sujeto pasivo?',
  '¿Qué diferencia hay entre autónomo y sociedad limitada?',
  '¿Cómo funciona Verifactu en las facturas?',
  '¿Qué es una factura simplificada?',
  '¿Qué documentos debo guardar y durante cuántos años?',
];

/** Preguntas de uso de la app o de conceptos: ficha verificada. */
const FAQ: Array<[string, string]> = [
  ['¿Cómo hago una factura?', 'app-factura-nueva'],
  ['¿Dónde veo el balance?', 'app-informes'],
  ['¿Cómo apruebo los asientos?', 'app-aprobar-asientos'],
  ['¿Qué es el IVA repercutido?', 'cont-iva-repercutido-soportado'],
  ['¿Cómo importo el extracto del banco?', 'app-importar-extracto'],
  ['Me he equivocado en una factura', 'app-rectificativa'],
  ['¿Cómo cierro el año?', 'app-cierre'],
  ['Quiero cambiar el logo de la factura', 'app-datos-empresa'],
  ['¿Qué significa pendiente de revisión?', 'cont-estados-asiento'],
  ['¿Cómo subo las facturas de proveedores?', 'app-registrar-gasto'],
];

describe('capa 1: preguntas de datos', () => {
  const casos = Object.entries(DATOS).flatMap(([id, frases]) => frases.map((f) => [id, f] as const));

  it(`acierta la intención en al menos el 90 % de ${casos.length} frases y ninguna llega a la IA`, async () => {
    const fallos: string[] = [];
    const aLaIA: string[] = [];
    for (const [id, frase] of casos) {
      const r = await preguntar(frase);
      if (r.cuerpo.origen === 'ia') aLaIA.push(frase);
      if (r.cuerpo.intencion !== id || !['datos', 'sistema'].includes(r.cuerpo.origen)) fallos.push(`${id} «${frase}» → ${r.cuerpo.origen} ${r.cuerpo.intencion ?? ''}`);
    }
    if (fallos.length) console.info(`Carmen: ${fallos.length} de ${casos.length} sin acertar:\n${fallos.join('\n')}`);
    expect(aLaIA).toEqual([]);
    expect(crearMensaje).not.toHaveBeenCalled();
    const acierto = 1 - fallos.length / casos.length;
    if (acierto < 1) console.info(`Carmen: ${fallos.length} de ${casos.length} sin acertar:\n${fallos.join('\n')}`);
    expect(acierto).toBeGreaterThanOrEqual(0.9);
  });

  it('una pregunta de datos nunca va a la IA, aunque se pulse «preguntar a la IA»', async () => {
    const r = await responder(admin, { message: '¿cuánto me debe Construcciones Pérez?', accion: { tipo: 'ia' } }, null, iaActiva);
    expect(r.cuerpo.origen).toBe('aclaracion');
    expect(crearMensaje).not.toHaveBeenCalled();
  });

  it('los nombres de terceros también frenan la IA aunque no haya intención clara', async () => {
    const r = await preguntar('¿Es buena idea hacer un descuento a Talleres Martínez por pronto pago?');
    expect(r.cuerpo.origen).not.toBe('ia');
    expect(crearMensaje).not.toHaveBeenCalled();
  });
});

describe('capa 2: fichas y plazos', () => {
  it.each(FAQ)('«%s» → ficha %s con su fuente', async (frase, id) => {
    const r = await preguntar(frase);
    expect(r.cuerpo.origen).toBe('faq');
    expect(r.cuerpo.fuente?.verificadaEl).toBe('2026-10-07');
    expect(r.cuerpo.texto).toBe(require('../services/carmen/faq/faq.data').FICHAS.find((f: { id: string }) => f.id === id).respuesta);
    expect(crearMensaje).not.toHaveBeenCalled();
  });

  it('«¿cuándo vence el 303?» sale de la tabla de plazos con el aviso de festivos', async () => {
    const r = await preguntar('¿Cuándo vence el 303?');
    expect(r.cuerpo.origen).toBe('faq');
    expect(r.cuerpo.texto).toContain('20/10/2026');
    expect(r.cuerpo.avisos?.[0]).toMatch(/festivo/);
    expect(r.cuerpo.texto).toContain('todavía no consta como presentado');
    const ventas: CarmenCtx = { ...admin, permisos: new Set(['ventas:read']), esAdminEmpresa: false };
    const sinPermiso = await preguntar('¿hasta cuándo tengo para presentar el IVA?', {}, ventas);
    expect(sinPermiso.cuerpo.texto).toContain('20/10/2026');
    expect(sinPermiso.cuerpo.texto).not.toContain('consta');
  });
});

describe('capa 3: IA', () => {
  it.each(GENERICAS)('«%s» no dispara ninguna intención y, con la IA activa, va a la IA', async (frase) => {
    const r = await preguntar(frase);
    expect(r.cuerpo.intencion).toBeUndefined();
    expect(r.cuerpo.origen).toBe('ia');
    expect(r.cuerpo.etiquetaIA).toMatch(/orientativa/);
  });

  it('con la IA desactivada en la empresa no se llama y se sugieren consultas', async () => {
    const r = await preguntar('¿Qué es el criterio de caja?', {}, admin, { ...iaActiva, iaActiva: false });
    expect(r.cuerpo.origen).toBe('aclaracion');
    expect(r.cuerpo.texto).toMatch(/asesor/);
    expect(r.cuerpo.botones?.length).toBeGreaterThan(0);
    expect(crearMensaje).not.toHaveBeenCalled();
  });

  it('con el interruptor general apagado no se llama', async () => {
    cfg.carmen.llmActivo = false;
    try {
      const r = await preguntar('¿Qué es el criterio de caja?');
      expect(r.cuerpo.origen).toBe('aclaracion');
      expect(crearMensaje).not.toHaveBeenCalled();
    } finally {
      cfg.carmen.llmActivo = true;
    }
  });

  it('con el tope del usuario agotado no se llama y se dice el motivo real', async () => {
    mockPrisma.carmenContador.findMany.mockResolvedValue([{ clave: `usuario:U1:${HOY}`, consultasIA: 15, costeUsd: 0, mensajes: 20 }]);
    const r = await preguntar('¿Qué es el criterio de caja?');
    expect(r.cuerpo.origen).toBe('aclaracion');
    expect(r.cuerpo.avisos?.[0]).toMatch(/tus preguntas a la IA/);
    expect(crearMensaje).not.toHaveBeenCalled();
  });

  it('si la reserva del tope falla (otra instancia lo agotó), no se llama', async () => {
    mockPrisma.$executeRaw.mockResolvedValueOnce(0);
    const r = await preguntar('¿Qué es el criterio de caja?');
    expect(r.cuerpo.origen).toBe('aclaracion');
    expect(r.auditoria?.estado).toBe('sin_tope');
    expect(crearMensaje).not.toHaveBeenCalled();
  });

  it('frases de menos de 4 palabras no van a la IA', async () => {
    const r = await preguntar('verifactu');
    expect(r.cuerpo.origen).toBe('aclaracion');
    expect(crearMensaje).not.toHaveBeenCalled();
  });
});

describe('paso 3: charla y peticiones de acción', () => {
  it('saludo, gracias y «qué sabes hacer» sin IA', async () => {
    expect((await preguntar('Hola')).cuerpo.origen).toBe('sistema');
    expect((await preguntar('gracias')).cuerpo.texto).toMatch(/De nada/);
    const ayuda = await preguntar('¿qué sabes hacer?');
    expect(ayuda.cuerpo.botones?.length).toBe(14);
  });

  it('una petición de acción dice dónde se hace y no hace nada', async () => {
    const r = await preguntar('créame una factura para Hermanos Ruiz');
    expect(r.cuerpo.origen).toBe('sistema');
    expect(r.cuerpo.texto).toMatch(/no lo hago yo/);
    expect(r.cuerpo.enlaces).toEqual([{ texto: 'Ir a Facturas de ingreso', href: '/dashboard/facturas' }]);
  });
});

describe('permisos y botones', () => {
  const ventas: CarmenCtx = { ...admin, permisos: new Set(['ventas:read', 'ventas:write', 'contabilidad:read']), esAdminEmpresa: false, puedeNominas: false };

  it('sin permiso para la intención: aviso sin cifras ni IA', async () => {
    const r = await preguntar('¿cuánto dinero tengo en el banco?', {}, ventas);
    expect(r.cuerpo.origen).toBe('sistema');
    expect(r.cuerpo.texto).toMatch(/permiso de Tesorería/);
    expect(r.cuerpo.texto).not.toMatch(/Cifras/);
    expect(crearMensaje).not.toHaveBeenCalled();
  });

  it('el catálogo solo enseña intenciones permitidas', async () => {
    const r = await preguntar('¿qué sabes hacer?', {}, ventas);
    const ids = r.cuerpo.botones!.map((b) => (b.accion.tipo === 'intencion' ? b.accion.id : ''));
    expect(ids).not.toContain('INT-24');
    expect(ids).not.toContain('INT-28');
    expect(ids).toContain('INT-02');
  });

  it('una acción con una intención inexistente responde con aclaración, no con error', async () => {
    const r = await responder(admin, { accion: { tipo: 'intencion', id: 'INT-99' } }, null, iaActiva);
    expect(r.cuerpo.origen).toBe('aclaracion');
  });

  it('una acción sin permiso no ejecuta nada', async () => {
    const r = await responder(ventas, { accion: { tipo: 'intencion', id: 'INT-24' } }, null, iaActiva);
    expect(r.cuerpo.texto).toMatch(/permiso/);
  });

  it('INT-01 sin cliente pregunta de cuál y deja la intención pendiente', async () => {
    const r = await responder(admin, { accion: { tipo: 'intencion', id: 'INT-01' } }, null, iaActiva);
    expect(r.cuerpo.texto).toMatch(/¿De qué cliente\?/);
    expect(r.contexto).toMatchObject({ pendiente: 'INT-01' });
  });

  it('un tercero de otra empresa en un botón no se acepta', async () => {
    const r = await responder(admin, { accion: { tipo: 'tercero', terceroId: 'cX', rol: 'cliente', intencion: 'INT-01' } }, null, iaActiva);
    expect(r.cuerpo.origen).toBe('aclaracion');
    expect(r.cuerpo.texto).toMatch(/No encuentro/);
  });
});

describe('terceros en la pregunta', () => {
  it('«cargos de repsol» busca el nombre en el concepto de los movimientos', async () => {
    const r = await preguntar('cargos de repsol');
    expect(r.cuerpo.intencion).toBe('INT-25');
    const { EJECUTORES } = jest.requireMock('../services/carmen/intenciones/datos') as { EJECUTORES: Record<string, jest.Mock> };
    expect(EJECUTORES.ultimosMovimientos.mock.calls.at(-1)?.[1]).toMatchObject({ texto: 'repsol' });
  });

  it('mismo nombre como cliente y como proveedor: decide el verbo', async () => {
    mockPrisma.supplier.findMany.mockResolvedValue([{ id: 'p9', nombreFiscal: 'HERMANOS RUIZ SL', nifCif: 'B33333333' }]);
    const meDebe = await preguntar('¿cuánto me debe Hermanos Ruiz?');
    expect(meDebe.cuerpo).toMatchObject({ intencion: 'INT-01', huecos: { terceroId: 'c3', rol: 'cliente' } });
    const leDebo = await preguntar('¿qué le debo a Hermanos Ruiz?');
    expect(leDebo.cuerpo.intencion).toBe('INT-06');
  });

  it('dos clientes parecidos: botones para elegir, y la intención queda pendiente', async () => {
    mockPrisma.customer.findMany.mockResolvedValue([
      { id: 'c1', nombreFiscal: 'CONSTRUCCIONES PÉREZ SL', nifCif: 'B11111111' },
      { id: 'c4', nombreFiscal: 'PÉREZ GARCÍA JUAN', nifCif: '12345678Z' },
    ]);
    const r = await preguntar('¿cuánto me debe Pérez?');
    expect(r.cuerpo.texto).toBe('¿A qué cliente te refieres?');
    expect(r.cuerpo.botones?.map((b) => (b.accion.tipo === 'tercero' ? b.accion.terceroId : '')).sort()).toEqual(['c1', 'c4']);
    expect(r.contexto).toMatchObject({ pendiente: 'INT-01' });
  });
});

describe('paso 4: seguimiento', () => {
  const contexto = (intencion: string, huecos = {}) => ({ id: 's1', titulo: null, updatedAt: new Date(), contexto: { intencion, huecos, en: new Date().toISOString() } });

  it('«¿y el mes pasado?» repite la intención con el nuevo periodo', async () => {
    const r = await responder(admin, { message: '¿y el mes pasado?' }, contexto('INT-05', { periodo: 'este-mes', sentido: 'cobros' }), iaActiva);
    expect(r.cuerpo.intencion).toBe('INT-05');
    expect(r.cuerpo.huecos).toMatchObject({ periodo: 'mes-pasado', sentido: 'cobros' });
  });

  it('«solo las vencidas» pasa de lo pendiente a lo vencido', async () => {
    const r = await responder(admin, { message: 'solo las vencidas' }, contexto('INT-02'), iaActiva);
    expect(r.cuerpo.intencion).toBe('INT-03');
  });

  it('«¿y a Hermanos Ruiz?» cambia de cliente', async () => {
    const r = await responder(admin, { message: '¿y a Hermanos Ruiz?' }, contexto('INT-01', { terceroId: 'c1', rol: 'cliente' }), iaActiva);
    expect(r.cuerpo.intencion).toBe('INT-01');
    expect(r.cuerpo.huecos).toMatchObject({ terceroId: 'c3' });
  });

  it('un contexto de hace más de 30 minutos no cuenta', async () => {
    const viejo = { id: 's1', titulo: null, updatedAt: new Date(), contexto: { intencion: 'INT-05', huecos: {}, en: new Date(Date.now() - 31 * 60_000).toISOString() } };
    const r = await responder(admin, { message: '¿y el mes pasado?' }, viejo, { ...iaActiva, iaActiva: false });
    expect(r.cuerpo.intencion).not.toBe('INT-05');
  });
});
