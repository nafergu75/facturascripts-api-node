/**
 * Carmen sobre BD real (MySQL/MariaDB de pruebas):
 *  - tope concurrente: 20 reservas a la vez con cupo para 10 → 10, y sin
 *    residuo al devolverlas;
 *  - freno de mensajes diarios;
 *  - conversaciones aisladas por empresa y usuario, borrado y purga de lo caducado;
 *  - ajustes (IA apagada por defecto);
 *  - de punta a punta: pregunta de datos con cifras de la BD y llamada a la IA
 *    simulada con su auditoría (sin el texto de la pregunta).
 *
 * La API de Anthropic NUNCA se llama: el cliente está simulado.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { prisma } from '../config/database';
import { config } from '../config/env';
import { incomeInvoicesService } from '../services/income-invoices.service';
import { facturasPorCobrar, resumenCobrosClientes } from '../services/cobrosClientes.service';
import { clavesContador, contarMensaje, devolver, liquidar, reservar, type Reserva } from '../services/carmen/presupuesto.service';
import { atender } from '../services/carmen/enrutador';
import { construirContexto } from '../services/carmen/contexto';
import { borrarSesion, listarSesiones, mensajesDeSesion, purgarCaducadas, purgarTodas } from '../services/carmen/sesiones';
import { guardarAjustes, leerAjustes, topeEmpresaDia } from '../services/carmen/ajustes.service';
import { fijarClienteIA } from '../services/carmen/llm';
import { olvidarIndices } from '../services/carmen/terceros';
import type { AuthUser } from '../types/express';

const SUF = Date.now();
const EMPRESA = `carmen-test-${SUF}`;
const OTRA = `carmen-otra-${SUF}`;
const HOY = '2026-10-07';
const cfg = config as unknown as {
  anthropicApiKey?: string;
  carmen: { llmActivo: boolean; topeMensualEur: number; topeUsuarioDia: number; mensajesUsuarioDia: number };
};
const original = { ...cfg.carmen, clave: cfg.anthropicApiKey };

const usuario = (userId: string, roles: Record<string, string[]>): AuthUser => ({
  userId,
  roles: Object.values(roles).flat(),
  rolesPorEmpresa: roles,
  companies: Object.keys(roles),
});
const ANA = usuario(`ana-${SUF}`, { [EMPRESA]: ['admin'], [OTRA]: ['admin'] });
const BEA = usuario(`bea-${SUF}`, { [EMPRESA]: ['admin'] });

beforeAll(async () => {
  for (const [id, nif] of [[EMPRESA, 'B61000000'], [OTRA, 'B62000000']]) {
    await prisma.company.create({ data: { id, name: `Carmen ${id}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    await prisma.legalConfig.create({ data: { companyId: id, denominacion: `Carmen ${id}`, nif } });
  }
  const cliente = await prisma.customer.create({ data: { companyId: EMPRESA, nombreFiscal: 'Talleres Carmencita SL', nifCif: 'B63000000' } });
  const linea = { descripcion: 'Servicio', cantidad: 1, precioUnitario: 1000, tipoIva: 21 };
  await incomeInvoicesService.crearIngreso({ companyId: EMPRESA, customer: { id: cliente.id }, fechaEmision: '2026-06-01', fechaVencimiento: '2026-07-01', lineas: [linea] });
  await incomeInvoicesService.crearIngreso({ companyId: EMPRESA, customer: { id: cliente.id }, fechaEmision: '2026-09-01', fechaVencimiento: '2099-12-31', lineas: [{ ...linea, precioUnitario: 500 }] });
  olvidarIndices();
});

afterAll(async () => {
  Object.assign(cfg.carmen, { llmActivo: original.llmActivo, topeMensualEur: original.topeMensualEur, topeUsuarioDia: original.topeUsuarioDia, mensajesUsuarioDia: original.mensajesUsuarioDia });
  cfg.anthropicApiKey = original.clave;
  fijarClienteIA(null);
});

describe('tope concurrente', () => {
  it('20 reservas a la vez con cupo para 10: como mucho 10, y sin residuo al devolverlas', async () => {
    // Día propio para no chocar con otros tests; cupo de 10 reservas de 0,006 $.
    const dia = `2099-01-${String(SUF % 28 + 1).padStart(2, '0')}`;
    const claves = clavesContador(EMPRESA, ANA.userId, dia);
    await prisma.carmenContador.deleteMany({ where: { clave: { in: Object.values(claves) } } });
    cfg.carmen.topeMensualEur = 0.06;
    cfg.carmen.topeUsuarioDia = 1000;
    try {
      const resultados = await Promise.all(Array.from({ length: 20 }, () => reservar(EMPRESA, ANA.userId, dia, 1000)));
      const ok = resultados.filter((r): r is { ok: true; reserva: Reserva } => r.ok);
      expect(ok).toHaveLength(10);
      expect(resultados.filter((r) => !r.ok).every((r) => !r.ok && r.motivo === 'tope_mensual')).toBe(true);
      const global = await prisma.carmenContador.findUniqueOrThrow({ where: { clave: claves.global } });
      expect(Number(global.costeUsd)).toBeCloseTo(0.06, 6);
      expect(global.consultasIA).toBe(10);

      await Promise.all(ok.map((r) => devolver(r.reserva)));
      const filas = await prisma.carmenContador.findMany({ where: { clave: { in: Object.values(claves) } } });
      for (const f of filas) {
        expect({ clave: f.clave, coste: Number(f.costeUsd), consultas: f.consultasIA }).toEqual({ clave: f.clave, coste: 0, consultas: 0 });
      }
    } finally {
      cfg.carmen.topeMensualEur = original.topeMensualEur;
      cfg.carmen.topeUsuarioDia = original.topeUsuarioDia;
    }
  });

  it('reservas y liquidaciones de la misma empresa a la vez: sin interbloqueos y con las cuentas exactas', async () => {
    const dia = `2099-05-${String((SUF % 28) + 1).padStart(2, '0')}`;
    const claves = clavesContador(EMPRESA, ANA.userId, dia);
    await prisma.carmenContador.deleteMany({ where: { clave: { in: Object.values(claves) } } });
    cfg.carmen.topeMensualEur = 1;
    cfg.carmen.topeUsuarioDia = 1000;
    try {
      const primeras: Reserva[] = [];
      for (let i = 0; i < 10; i++) {
        const r = await reservar(EMPRESA, ANA.userId, dia, 1000);
        if (r.ok) primeras.push(r.reserva);
      }
      expect(primeras).toHaveLength(10);
      // A la vez: 10 liquidaciones (0,001 $ cada una) y 10 reservas nuevas de la misma empresa.
      const todo = await Promise.allSettled([
        ...primeras.map((r) => liquidar(r, 0.001)),
        ...Array.from({ length: 10 }, () => reservar(EMPRESA, ANA.userId, dia, 1000)),
      ]);
      expect(todo.filter((t) => t.status === 'rejected')).toEqual([]);
      const nuevas = todo.slice(10).map((t) => (t as PromiseFulfilledResult<Awaited<ReturnType<typeof reservar>>>).value);
      expect(nuevas.every((r) => r.ok)).toBe(true);
      const global = await prisma.carmenContador.findUniqueOrThrow({ where: { clave: claves.global } });
      // 10 × 0,001 liquidado + 10 × 0,006 reservado.
      expect(Number(global.costeUsd)).toBeCloseTo(0.07, 6);
      expect(global.consultasIA).toBe(20);
      const empresaMes = await prisma.carmenContador.findUniqueOrThrow({ where: { clave: claves.empresaMes } });
      expect(Number(empresaMes.costeUsd)).toBeCloseTo(0.07, 6);
      for (const r of nuevas) if (r.ok) await devolver(r.reserva);
      expect(Number((await prisma.carmenContador.findUniqueOrThrow({ where: { clave: claves.global } })).costeUsd)).toBeCloseTo(0.01, 6);
    } finally {
      cfg.carmen.topeMensualEur = original.topeMensualEur;
      cfg.carmen.topeUsuarioDia = original.topeUsuarioDia;
    }
  });

  it('el tope diario de la empresa (100 o el suyo, si es menor) también corta', async () => {
    const dia = '2099-02-01';
    const claves = clavesContador(OTRA, BEA.userId, dia);
    await prisma.carmenContador.deleteMany({ where: { clave: { in: Object.values(claves) } } });
    const resultados = await Promise.all(Array.from({ length: 5 }, () => reservar(OTRA, BEA.userId, dia, 3)));
    expect(resultados.filter((r) => r.ok)).toHaveLength(3);
    expect(resultados.filter((r) => !r.ok && r.motivo === 'tope_empresa')).toHaveLength(2);
    for (const r of resultados) if (r.ok) await devolver(r.reserva);
  });

  it('freno de mensajes diarios por usuario', async () => {
    cfg.carmen.mensajesUsuarioDia = 3;
    try {
      const dia = '2099-03-01';
      await prisma.carmenContador.deleteMany({ where: { clave: `usuario:${BEA.userId}:${dia}` } });
      const r = [];
      for (let i = 0; i < 4; i++) r.push(await contarMensaje(BEA.userId, dia));
      expect(r).toEqual([true, true, true, false]);
    } finally {
      cfg.carmen.mensajesUsuarioDia = original.mensajesUsuarioDia;
    }
  });
});

describe('conversaciones', () => {
  it('cada usuario ve, escribe y borra solo las suyas en cada empresa', async () => {
    const ana = construirContexto(ANA, EMPRESA, HOY);
    const r = await atender(ana, { message: '¿Cómo hago una factura?' });
    expect(r.origen).toBe('faq');

    // Otra persona de la misma empresa, o la misma en otra empresa: 404.
    const bea = construirContexto(BEA, EMPRESA, HOY);
    const anaEnOtra = construirContexto(ANA, OTRA, HOY);
    for (const ctx of [bea, anaEnOtra]) {
      await expect(atender(ctx, { message: 'hola', sessionId: r.sessionId })).rejects.toMatchObject({ statusCode: 404 });
      await expect(mensajesDeSesion(ctx, r.sessionId)).rejects.toMatchObject({ statusCode: 404 });
      await expect(borrarSesion(ctx, r.sessionId)).rejects.toMatchObject({ statusCode: 404 });
    }
    // Un id inventado no se crea.
    await expect(atender(ana, { message: 'hola', sessionId: 'inventado123' })).rejects.toMatchObject({ statusCode: 404 });
    expect(await prisma.chatSession.findUnique({ where: { id: 'inventado123' } })).toBeNull();

    const propia = await mensajesDeSesion(ana, r.sessionId);
    expect(propia.mensajes.map((m) => m.role)).toEqual(['user', 'assistant']);
    await borrarSesion(ana, r.sessionId);
    expect(await prisma.chatSession.findUnique({ where: { id: r.sessionId } })).toBeNull();
    expect(await prisma.chatMessage.count({ where: { sessionId: r.sessionId } })).toBe(0);
  });

  it('purga lo que pasa de los días que se conservan', async () => {
    const vieja = await prisma.chatSession.create({ data: { companyId: OTRA, userId: BEA.userId, titulo: 'vieja', updatedAt: new Date('2026-05-01T10:00:00Z') } });
    const nueva = await prisma.chatSession.create({ data: { companyId: OTRA, userId: BEA.userId, titulo: 'nueva' } });
    const base = { companyId: OTRA, userId: BEA.userId, role: 'user', content: 'x' };
    await prisma.chatMessage.create({ data: { ...base, sessionId: vieja.id, createdAt: new Date('2026-05-01T10:00:00Z') } });
    await prisma.chatMessage.create({ data: { ...base, sessionId: nueva.id, createdAt: new Date('2026-05-01T10:00:00Z') } });
    await prisma.chatMessage.create({ data: { ...base, sessionId: nueva.id } });

    await purgarCaducadas(OTRA, 90, new Date('2026-10-07T10:00:00Z'));
    expect(await prisma.chatSession.findUnique({ where: { id: vieja.id } })).toBeNull();
    expect(await prisma.chatSession.findUnique({ where: { id: nueva.id } })).not.toBeNull();
    expect(await prisma.chatMessage.count({ where: { sessionId: nueva.id } })).toBe(1);
  });
});

describe('caducidad de las conversaciones', () => {
  it('lo de más de 90 días no se lista ni se lee aunque siga en la BD, y la purga diaria lo borra en todas las empresas', async () => {
    const ctx = construirContexto(BEA, OTRA, HOY);
    const hace = (dias: number) => new Date(Date.now() - dias * 86_400_000);
    const vieja = await prisma.chatSession.create({ data: { companyId: OTRA, userId: BEA.userId, titulo: 'de hace 100 días', updatedAt: hace(100) } });
    await prisma.chatMessage.create({ data: { sessionId: vieja.id, companyId: OTRA, userId: BEA.userId, role: 'assistant', content: 'Saldo 1.000,00 €', origen: 'datos', createdAt: hace(100) } });
    const reciente = await prisma.chatSession.create({ data: { companyId: OTRA, userId: BEA.userId, titulo: 'de esta semana' } });

    const lista = await listarSesiones(ctx, 1, 90);
    expect(lista.sesiones.map((x) => x.id)).toContain(reciente.id);
    expect(lista.sesiones.map((x) => x.id)).not.toContain(vieja.id);
    await expect(mensajesDeSesion(ctx, vieja.id, 90)).rejects.toMatchObject({ statusCode: 404 });
    await expect(atender(ctx, { message: 'hola', sessionId: vieja.id })).rejects.toMatchObject({ statusCode: 404 });
    // Sigue en la BD hasta la purga...
    expect(await prisma.chatSession.findUnique({ where: { id: vieja.id } })).not.toBeNull();
    // ...que no depende de que alguien de la empresa vuelva a preguntar.
    await purgarTodas();
    expect(await prisma.chatSession.findUnique({ where: { id: vieja.id } })).toBeNull();
    expect(await prisma.chatMessage.count({ where: { sessionId: vieja.id } })).toBe(0);
    expect(await prisma.chatSession.findUnique({ where: { id: reciente.id } })).not.toBeNull();
  });
});

describe('ajustes', () => {
  it('la IA está desactivada por defecto; el tope propio solo puede bajar el general', async () => {
    expect(await leerAjustes(OTRA)).toMatchObject({ iaActiva: false, topeConsultasDia: null, conservarDias: 90 });
    const a = await guardarAjustes(OTRA, ANA.userId, { iaActiva: true, topeConsultasDia: 20 });
    expect(a).toMatchObject({ iaActiva: true, topeConsultasDia: 20, actualizadoPor: ANA.userId });
    expect(topeEmpresaDia(a)).toBe(20);
    await expect(guardarAjustes(OTRA, ANA.userId, { topeConsultasDia: 500 })).rejects.toMatchObject({ statusCode: 400 });
    await guardarAjustes(OTRA, ANA.userId, { iaActiva: false });
    expect((await leerAjustes(OTRA)).iaActiva).toBe(false);
  });
});

describe('de punta a punta', () => {
  it('facturasPorCobrar da los mismos totales que el resumen del panel', async () => {
    const lista = await facturasPorCobrar(EMPRESA, HOY);
    const panel = await resumenCobrosClientes(EMPRESA, 2026, HOY);
    expect(lista.pendientes).toEqual(panel.pendientes);
    expect(lista.vencidas).toEqual(panel.vencidas);
    expect(lista.facturas).toHaveLength(2);
    expect(lista.facturas.every((f) => !!f.customerId)).toBe(true);
    // El panel no cambia: sus facturas no llevan el id del cliente.
    expect(panel.proximas.every((f) => f.customerId === undefined)).toBe(true);
  });

  it('una pregunta de datos se responde con las cifras de la BD y se guarda con ellas', async () => {
    const ctx = construirContexto(ANA, EMPRESA, HOY);
    const r = await atender(ctx, { message: '¿Cuánto me debe Talleres Carmencita?' });
    expect(r).toMatchObject({ origen: 'datos', intencion: 'INT-01' });
    expect(r.texto).toMatch(/^Talleres Carmencita SL te debe 1\.815,00 € en 2 facturas\. 1 está vencida \(1\.210,00 €\)\./);
    const guardado = await prisma.chatMessage.findUniqueOrThrow({ where: { id: r.mensajeId } });
    expect(guardado).toMatchObject({ origen: 'datos', intencion: 'INT-01', permisoRequerido: 'ventas:read|contabilidad:read' });
    expect((guardado.datos as { kpis: unknown[] }).kpis).toHaveLength(2);
    expect(guardado.huecos).toEqual({ terceroId: expect.any(String), rol: 'cliente' });
    // Seguimiento: «solo las vencidas».
    const seguimiento = await atender(ctx, { message: 'solo las vencidas', sessionId: r.sessionId });
    expect(seguimiento.intencion).toBe('INT-03');
  });

  it('una pregunta genérica con la IA activa: una llamada simulada, coste liquidado y auditoría sin el texto', async () => {
    const crear = jest.fn(async () => ({
      content: [{ type: 'text', text: 'En una sociedad limitada respondes con el capital de la sociedad; como autónomo, con tu patrimonio. Consúltalo con tu asesor.' }],
      usage: { input_tokens: 1800, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      stop_reason: 'end_turn',
    }));
    fijarClienteIA({ messages: { create: crear } } as never);
    cfg.carmen.llmActivo = true;
    cfg.anthropicApiKey = 'clave-de-prueba-no-real';
    await guardarAjustes(EMPRESA, ANA.userId, { iaActiva: true });
    const dia = '2099-04-01';
    await prisma.carmenContador.deleteMany({ where: { clave: { in: Object.values(clavesContador(EMPRESA, ANA.userId, dia)) } } });
    try {
      const ctx = construirContexto(ANA, EMPRESA, dia);
      const r = await atender(ctx, { message: '¿Qué diferencia hay entre ser autónomo y tener una sociedad limitada?' });
      expect(r.origen).toBe('ia');
      expect(crear).toHaveBeenCalledTimes(1);
      const llamada = await prisma.carmenLlamadaIA.findFirstOrThrow({ where: { mensajeId: r.mensajeId } });
      expect(llamada).toMatchObject({ companyId: EMPRESA, estado: 'ok', tokensEntrada: 1800, tokensSalida: 60, modelo: 'claude-haiku-4-5-20251001' });
      expect(Number(llamada.costeUsd)).toBeCloseTo(0.0021, 6);
      expect(JSON.stringify(llamada)).not.toMatch(/sociedad limitada/i);
      const global = await prisma.carmenContador.findUniqueOrThrow({ where: { clave: 'global:2099-04' } });
      expect(Number(global.costeUsd)).toBeCloseTo(0.0021, 6);
      const usuarioHoy = await prisma.carmenContador.findUniqueOrThrow({ where: { clave: `usuario:${ANA.userId}:${dia}` } });
      expect(usuarioHoy).toMatchObject({ consultasIA: 1, mensajes: 1 });
    } finally {
      cfg.carmen.llmActivo = original.llmActivo;
      cfg.anthropicApiKey = original.clave;
      fijarClienteIA(null);
    }
  });
});
