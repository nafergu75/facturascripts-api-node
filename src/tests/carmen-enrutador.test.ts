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
      deudaConProveedores: ejecutor('INT-06'),
      facturadoEnPeriodo: ejecutor('INT-09'),
      buscarFactura: ejecutor('INT-13'),
      cuentaDeResultados: ejecutor('INT-18'),
      ivaDelTrimestre: ejecutor('INT-28'),
    },
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

/** Más frases por intención: faltas, abreviaturas, coloquialismos y fechas en lenguaje natural. */
const MAS_DATOS: Record<string, string[]> = {
  'INT-01': [
    'cuanto me debe hermanos ruiz a dia de hoy',
    'q me debe talleres martinez',
    'construcciones perez me debe algo?',
    'tiene facturas sin pagar hermanos ruiz',
    'cuanto me adeuda construcciones perez',
    'hermanos ruiz ya me pago la fra?',
    'deuda pendiente de const perez',
    'saldo de talleres martinez',
  ],
  'INT-02': [
    'cuanto me deben los clientes a dia de hoy',
    'que hay pendiente de cobro',
    'importe total por cobrar',
    'quien me debe pasta',
    'lista de clientes que me deben',
    'cuanto queda por cobrar',
    'deudores de la empresa',
    'clientes con facturas pendientes de cobro',
  ],
  'INT-03': [
    'clientes morosos',
    'facturas vencidas de clientes',
    'que clientes van con retraso',
    'impagados',
    'facturas con mas de 90 dias de retraso',
    'cuanto hay vencido sin cobrar',
    'facturas de clientes atrasadas',
  ],
  'INT-05': [
    'cuanto he cobrado hoy',
    'cobros de la semana pasada',
    'cuanto pague el trimestre pasado',
    'total de pagos de septiembre',
    'cuanto hemos ingresado este mes',
    'cuanto se ha cobrado este año',
    'cobros del 3t',
  ],
  'INT-06': [
    'que debo a mis proveedores',
    'cuanto le debo a iberdrola',
    'pagos pendientes a proveedores',
    'que facturas de proveedores tengo sin pagar',
    'que tengo que pagar la semana que viene',
    'facturas de compra vencidas',
    'cuanto le debo a repsol',
    'deuda con proveedores a dia de hoy',
    'q le debo a iberdrola',
  ],
  'INT-09': [
    'cuanto he facturado en septiembre',
    'facturacion del trimestre pasado',
    'cuanto he vendido este año',
    'gastos del trimestre',
    'cuanto llevo gastado este año',
    'ventas del 3t',
    'cuanto facture el año pasado',
    'cuanto he facturado este mes comparado con el año pasado',
  ],
  'INT-13': [
    'busca la fra A-12',
    'esta pagada la factura F-2026-15',
    'estado de la factura 2026-45',
    'buscar la factura B-007',
    'la factura A-3 esta cobrada?',
    'en que estado esta la factura 2025-120',
    'encuentrame la factura numero A-55',
  ],
  'INT-18': [
    'cuanto he ganado este año',
    'beneficios del año pasado',
    'resultado de 2025',
    'estoy en perdidas?',
    'cuanto gano',
    'beneficio del primer trimestre',
    'perdidas y ganancias de este año',
  ],
  'INT-23': [
    'asientos pendientes de aprobar',
    'hay asientos por revisar',
    'asientos sin revisar',
    'tengo asientos en borrador',
    'quedan asientos pendientes',
    'cuantos asientos hay sin aprobar',
  ],
  'INT-24': [
    'cuanto hay en el banco',
    'saldo de la cuenta del sabadell',
    'dinero en las cuentas bancarias',
    'saldo bancario',
    'cuanto tengo en la cuenta acabada en 1234',
    'liquidez disponible en bancos',
  ],
  'INT-25': [
    'ultimos movimientos del sabadell',
    'que me han cargado esta semana',
    'movimientos de ayer',
    'cargos de iberdrola',
    'que ha entrado en el banco este mes',
    'ultimos recibos cargados',
    'movimientos del banco de septiembre',
  ],
  'INT-28': [
    'cuanto me sale el 303 este trimestre',
    'iva a pagar del 3t',
    'cuanto iva pague el trimestre pasado',
    'resultado del iva del segundo trimestre',
    'cuanto pago de iva',
    'me toca pagar iva este trimestre',
    'el 303 sale a devolver',
  ],
  'INT-30': [
    'que impuestos me tocan',
    'tengo algun impuesto pendiente',
    'proximos modelos a presentar',
    'que tengo que presentar a hacienda',
    'impuestos caducados',
    'que declaraciones tengo pendientes',
  ],
  'INT-39': ['resumen de la empresa', 'que tal va la empresa', 'como estamos', 'dame la situacion de hoy', 'resumen general'],
};
for (const [id, frases] of Object.entries(MAS_DATOS)) DATOS[id].push(...frases);

/**
 * Preguntas genéricas que no tienen ficha: no disparan ninguna intención ni
 * se tratan como datos. Con la IA activa van a la IA o, si se parecen a alguna
 * ficha, se ofrecen las fichas con el botón de preguntar a la IA.
 */
const GENERICAS = [
  '¿Cuánto cuesta contratar a un abogado?',
  '¿Qué diferencia hay entre autónomo y sociedad limitada?',
  '¿Cómo se calcula la cuota de autónomos?',
  '¿Qué es un ERTE?',
  '¿Cuánto cuesta constituir una sociedad limitada?',
  '¿Qué capital mínimo necesita una sociedad limitada?',
  '¿Qué es la tarifa plana de autónomos?',
  '¿Cómo se hace un contrato de trabajo?',
  '¿Qué es el epígrafe del IAE?',
  '¿Cómo se registra una marca comercial?',
  '¿Qué seguro necesita un negocio pequeño?',
  '¿Qué pide la ley de protección de datos a las empresas?',
  '¿Cómo se pide un préstamo ICO?',
  '¿Qué es el capital social de una empresa?',
  '¿Qué es un administrador único?',
  '¿Cuánto suele costar una gestoría?',
  '¿Para qué sirve el Registro Mercantil?',
  '¿Cómo funciona el leasing?',
  '¿Qué es el factoring?',
  '¿Qué es el confirming?',
  '¿Cómo se calcula el punto de equilibrio?',
  '¿Qué es el fondo de maniobra?',
  '¿Qué es el EBITDA?',
  '¿Cuánto es el salario mínimo interprofesional?',
  '¿Qué es un finiquito?',
  '¿Cómo se calcula una indemnización por despido?',
  '¿Qué es el impuesto sobre transmisiones patrimoniales?',
  '¿Quién paga el IBI de un local alquilado?',
  '¿Cómo se pide el certificado digital de la empresa?',
  '¿Qué es la firma electrónica cualificada?',
  '¿Qué es una sociedad cooperativa?',
  '¿Qué es una comunidad de bienes?',
  '¿Cuántos socios necesita una sociedad limitada?',
  '¿Qué es un pacto de socios?',
  '¿Qué significa responsabilidad limitada?',
  '¿Cómo se disuelve una sociedad?',
  '¿Qué es un concurso de acreedores?',
  '¿Cómo se hace un plan de negocio?',
  '¿Qué es el cash flow?',
  '¿Qué es la rentabilidad económica?',
  '¿Qué es el apalancamiento financiero?',
  '¿Qué es una subvención a fondo perdido?',
  '¿Qué es el kit digital?',
  '¿Qué dice la ley del teletrabajo?',
  '¿Cuántos días de vacaciones tiene un trabajador?',
  '¿Qué es un convenio colectivo?',
  '¿Cómo se da de alta a un trabajador?',
  '¿Qué es la prevención de riesgos laborales?',
  '¿Qué es el compliance penal?',
  '¿Qué es la ley de segunda oportunidad?',
  '¿Cómo calculo el precio de venta de un producto?',
  '¿Qué es un inventario permanente?',
  '¿Qué es el método FIFO?',
  '¿Qué es una sociedad holding?',
  '¿Qué es el capital riesgo?',
  '¿Qué diferencia hay entre un socio y un administrador?',
  '¿Qué es una junta general de socios?',
  '¿Qué es un poder notarial para la empresa?',
  '¿Qué es la economía circular?',
  '¿Qué gastos puedo deducir siendo autónomo?',
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
  // Fiscales (antes iban a la IA; ahora tienen ficha verificada).
  ['¿Qué es el criterio de caja?', 'iva-criterio-caja'],
  ['¿Puedo deducirme el IVA del coche?', 'iva-coche'],
  ['¿Qué tipo de IVA lleva la fruta?', 'iva-tipos'],
  ['¿Cómo se amortiza un ordenador?', 'is-amortizacion'],
  ['¿Qué es el recargo de equivalencia?', 'iva-recargo-equivalencia'],
  ['¿Qué es la inversión del sujeto pasivo?', 'iva-isp'],
  ['¿Cómo funciona Verifactu en las facturas?', 'fact-verifactu'],
  ['¿Qué es una factura simplificada?', 'fact-simplificada'],
  ['¿Qué documentos debo guardar y durante cuántos años?', 'fact-conservacion'],
  ['¿Cuándo será obligatoria la factura electrónica?', 'fact-electronica-b2b'],
  ['¿Le pongo IVA a un cliente de Francia?', 'iva-intracomunitarias'],
  ['¿Qué retención de IRPF pongo en mis facturas?', 'irpf-retencion-profesionales'],
  ['Trabajo desde casa, ¿puedo deducir la luz?', 'irpf-suministros-casa'],
  ['¿A qué tipo tributa una SL en el impuesto de sociedades?', 'is-tipos'],
  ['¿Son deducibles las cestas de Navidad para clientes?', 'is-atenciones-clientes'],
  ['¿Qué recargo hay si presento el IVA tarde?', 'lgt-recargos'],
  ['¿Puedo aplazar el pago del IVA?', 'lgt-aplazamientos'],
  ['¿Cuándo prescribe un impuesto?', 'lgt-prescripcion'],
  ['¿Cuánto tiempo tengo para emitir una factura?', 'fact-plazo-emision'],
  ['¿Qué es el modelo 347?', 'modelo-347-que-es'],
  ['¿Para qué sirve el modelo 111?', 'modelo-111-que-es'],
  ['¿Qué es el modelo 303 y qué reviso antes de presentarlo?', 'modelo-303-que-es'],
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
  it(`ninguna de las ${GENERICAS.length} preguntas genéricas dispara una intención ni se trata como datos`, async () => {
    const malas: string[] = [];
    let aLaIA = 0;
    for (const frase of GENERICAS) {
      const r = await preguntar(frase);
      if (r.cuerpo.intencion || ['datos', 'sistema'].includes(r.cuerpo.origen)) malas.push(`«${frase}» → ${r.cuerpo.origen} ${r.cuerpo.intencion ?? ''}`);
      if (r.cuerpo.origen === 'ia') {
        aLaIA++;
        expect(r.cuerpo.etiquetaIA).toMatch(/orientativa/);
      }
      // Si se parece a alguna ficha, se ofrecen las fichas y el botón de la IA (no una aclaración de datos).
      if (r.cuerpo.origen === 'aclaracion' && !r.cuerpo.botones?.some((b) => b.accion.tipo === 'ia')) malas.push(`«${frase}» → aclaración sin botón de IA: ${r.cuerpo.texto}`);
    }
    expect(malas).toEqual([]);
    // La mayoría no se parece a ninguna ficha y va directa a la IA.
    expect(aLaIA / GENERICAS.length).toBeGreaterThanOrEqual(0.8);
  });

  it('las preguntas con ficha no llegan a la IA aunque esté activa', async () => {
    for (const [frase] of FAQ) await preguntar(frase);
    expect(crearMensaje).not.toHaveBeenCalled();
  });

  it('con la IA desactivada en la empresa no se llama y se sugieren consultas', async () => {
    const r = await preguntar('¿Qué diferencia hay entre autónomo y sociedad limitada?', {}, admin, { ...iaActiva, iaActiva: false });
    expect(r.cuerpo.origen).toBe('aclaracion');
    expect(r.cuerpo.texto).toMatch(/asesor/);
    expect(r.cuerpo.botones?.length).toBeGreaterThan(0);
    expect(crearMensaje).not.toHaveBeenCalled();
  });

  it('con el interruptor general apagado no se llama', async () => {
    cfg.carmen.llmActivo = false;
    try {
      const r = await preguntar('¿Qué diferencia hay entre autónomo y sociedad limitada?');
      expect(r.cuerpo.origen).toBe('aclaracion');
      expect(crearMensaje).not.toHaveBeenCalled();
    } finally {
      cfg.carmen.llmActivo = true;
    }
  });

  it('con el tope del usuario agotado no se llama y se dice el motivo real', async () => {
    mockPrisma.carmenContador.findMany.mockResolvedValue([{ clave: `usuario:U1:${HOY}`, consultasIA: 15, costeUsd: 0, mensajes: 20 }]);
    const r = await preguntar('¿Qué diferencia hay entre autónomo y sociedad limitada?');
    expect(r.cuerpo.origen).toBe('aclaracion');
    expect(r.cuerpo.avisos?.[0]).toMatch(/tus preguntas a la IA/);
    expect(crearMensaje).not.toHaveBeenCalled();
  });

  it('si la reserva del tope falla (otra instancia lo agotó), no se llama', async () => {
    mockPrisma.$executeRaw.mockResolvedValueOnce(0);
    const r = await preguntar('¿Qué diferencia hay entre autónomo y sociedad limitada?');
    expect(r.cuerpo.origen).toBe('aclaracion');
    expect(r.auditoria?.estado).toBe('sin_tope');
    expect(crearMensaje).not.toHaveBeenCalled();
  });

  it('frases de menos de 4 palabras no van a la IA', async () => {
    const r = await preguntar('tarifa plana');
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

describe('huecos de las intenciones nuevas', () => {
  const { EJECUTORES } = jest.requireMock('../services/carmen/intenciones/datos') as { EJECUTORES: Record<string, jest.Mock> };
  const ultimos = (nombre: string) => EJECUTORES[nombre].mock.calls.at(-1)?.[1];

  it('INT-13 recibe el número de factura tal cual y lo guarda en los huecos', async () => {
    const r = await preguntar('¿está cobrada la factura A-0012?');
    expect(r.cuerpo).toMatchObject({ intencion: 'INT-13', huecos: { numeroFactura: 'A-0012' } });
    expect(ultimos('buscarFactura')).toMatchObject({ numeroFactura: 'A-0012' });
  });

  it('INT-06: «la semana que viene» es de lunes a domingo de la semana siguiente', async () => {
    await preguntar('¿qué tengo que pagar la semana que viene?');
    expect(ultimos('deudaConProveedores').periodo).toMatchObject({ desde: '2026-10-12', hasta: '2026-10-18', codigo: 'semana-que-viene' });
  });

  it('INT-06: «vencidas» se queda solo con lo vencido', async () => {
    await preguntar('facturas de proveedores vencidas');
    expect(ultimos('deudaConProveedores')).toMatchObject({ soloVencidas: true });
  });

  it('INT-09: el foco sale del verbo (facturar o gastar) y el periodo por defecto es este trimestre', async () => {
    await preguntar('¿cuánto he gastado en septiembre?');
    expect(ultimos('facturadoEnPeriodo')).toMatchObject({ foco: 'gastos', periodo: { desde: '2026-09-01', hasta: '2026-09-30' } });
    await preguntar('¿cuánto llevo facturado?');
    expect(ultimos('facturadoEnPeriodo')).toMatchObject({ foco: 'ventas', periodo: { codigo: 'este-trimestre' } });
  });

  it('INT-18 y INT-28: «el trimestre pasado», «2025» y «el 3T»', async () => {
    await preguntar('¿cuánto gané en 2025?');
    expect(ultimos('cuentaDeResultados').periodo).toMatchObject({ desde: '2025-01-01', hasta: '2025-12-31' });
    await preguntar('el 303 del trimestre pasado');
    expect(ultimos('ivaDelTrimestre').periodo).toMatchObject({ desde: '2026-07-01', hasta: '2026-09-30' });
    await preguntar('¿cuánto iva pagué en el 2T?');
    expect(ultimos('ivaDelTrimestre').periodo).toMatchObject({ desde: '2026-04-01', hasta: '2026-06-30' });
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

  it('«solo las vencidas» tras lo que debo a proveedores pide solo lo vencido', async () => {
    const r = await responder(admin, { message: 'solo las vencidas' }, contexto('INT-06'), iaActiva);
    expect(r.cuerpo.intencion).toBe('INT-06');
    expect(r.cuerpo.huecos).toMatchObject({ soloVencidas: true });
  });

  it('«¿y los gastos?» tras lo facturado cambia el foco', async () => {
    const r = await responder(admin, { message: '¿y los gastos?' }, contexto('INT-09', { periodo: 'este-trimestre', foco: 'ventas' }), iaActiva);
    expect(r.cuerpo.intencion).toBe('INT-09');
    expect(r.cuerpo.huecos).toMatchObject({ periodo: 'este-trimestre', foco: 'gastos' });
  });

  it('un contexto de hace más de 30 minutos no cuenta', async () => {
    const viejo = { id: 's1', titulo: null, updatedAt: new Date(), contexto: { intencion: 'INT-05', huecos: {}, en: new Date(Date.now() - 31 * 60_000).toISOString() } };
    const r = await responder(admin, { message: '¿y el mes pasado?' }, viejo, { ...iaActiva, iaActiva: false });
    expect(r.cuerpo.intencion).not.toBe('INT-05');
  });
});
