/**
 * Carmen por HTTP: aislamiento de conversaciones (empresa + usuario), entrada
 * validada, ajustes solo para administradores y estado de la IA.
 * Prisma simulado; la API de Anthropic no se usa (la IA está apagada).
 */
const mockPrisma = {
  chatSession: { findFirst: jest.fn(), create: jest.fn(), updateMany: jest.fn(), findMany: jest.fn(), count: jest.fn(), deleteMany: jest.fn() },
  chatMessage: { create: jest.fn(), findMany: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() },
  carmenContador: { createMany: jest.fn(), findMany: jest.fn() },
  carmenAjustes: { findUnique: jest.fn(), upsert: jest.fn() },
  carmenLlamadaIA: { create: jest.fn() },
  customer: { findMany: jest.fn() },
  supplier: { findMany: jest.fn() },
  bankAccount: { findMany: jest.fn() },
  modeloImpuesto: { findUnique: jest.fn() },
  $executeRaw: jest.fn(),
  $transaction: jest.fn(),
};
jest.mock('../config/database', () => ({ prisma: mockPrisma }));

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';
import { createApp } from '../app';
import { olvidarPurgas } from '../services/carmen/sesiones';

const app = createApp();
const token = (roles: Record<string, string[]>, userId = 'U1') =>
  `Bearer ${jwt.sign({ sub: userId, roles: Object.values(roles).flat(), companies: Object.keys(roles), rolesPorEmpresa: roles }, config.jwtSecret, { expiresIn: '1h' })}`;
// U1 es de ventas en E1 y administrador en E2.
const U1 = token({ E1: ['ventas'], E2: ['admin'] });
const ruta = (empresa = 'E1') => `/companies/${empresa}/chat-assistant`;

beforeEach(() => {
  jest.clearAllMocks();
  olvidarPurgas();
  mockPrisma.chatSession.findFirst.mockResolvedValue(null);
  mockPrisma.chatSession.create.mockImplementation(async ({ data }: { data: { titulo: string } }) => ({ id: 'sesion-nueva', titulo: data.titulo, contexto: null, updatedAt: new Date() }));
  mockPrisma.chatSession.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.chatSession.findMany.mockResolvedValue([]);
  mockPrisma.chatSession.count.mockResolvedValue(0);
  mockPrisma.chatSession.deleteMany.mockResolvedValue({ count: 1 });
  mockPrisma.chatMessage.create.mockImplementation(async () => ({ id: 'msg-1' }));
  mockPrisma.chatMessage.findMany.mockResolvedValue([]);
  mockPrisma.chatMessage.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.chatMessage.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.carmenContador.createMany.mockResolvedValue({ count: 1 });
  mockPrisma.carmenContador.findMany.mockResolvedValue([]);
  mockPrisma.carmenAjustes.findUnique.mockResolvedValue(null);
  mockPrisma.carmenAjustes.upsert.mockResolvedValue({});
  mockPrisma.customer.findMany.mockResolvedValue([]);
  mockPrisma.supplier.findMany.mockResolvedValue([]);
  mockPrisma.bankAccount.findMany.mockResolvedValue([]);
  mockPrisma.modeloImpuesto.findUnique.mockResolvedValue(null);
  mockPrisma.$executeRaw.mockResolvedValue(1);
});

describe('aislamiento de conversaciones', () => {
  it('POST con una conversación ajena (o inventada): 404 sin leer ni guardar nada', async () => {
    const res = await request(app).post(ruta()).set('Authorization', U1).send({ message: '¿Cómo hago una factura?', sessionId: 'de-otro-usuario' });
    expect(res.status).toBe(404);
    expect(mockPrisma.chatSession.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'de-otro-usuario', companyId: 'E1', userId: 'U1' } }));
    expect(mockPrisma.chatMessage.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.chatMessage.create).not.toHaveBeenCalled();
    expect(mockPrisma.chatSession.create).not.toHaveBeenCalled();
  });

  it('GET de los mensajes de una conversación ajena: 404 sin leerlos', async () => {
    const res = await request(app).get(`${ruta()}/de-otro-usuario/messages`).set('Authorization', U1);
    expect(res.status).toBe(404);
    expect(mockPrisma.chatMessage.findMany).not.toHaveBeenCalled();
  });

  it('DELETE de una conversación ajena: 404 sin borrar nada', async () => {
    const res = await request(app).delete(`${ruta()}/de-otro-usuario`).set('Authorization', U1);
    expect(res.status).toBe(404);
    expect(mockPrisma.chatMessage.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.chatSession.deleteMany).not.toHaveBeenCalled();
  });

  it('sin sessionId, el servidor crea la conversación (con su propio id) para esa empresa y ese usuario', async () => {
    const res = await request(app).post(ruta()).set('Authorization', U1).send({ message: '¿Cómo hago una factura?' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ sessionId: 'sesion-nueva', mensajeId: 'msg-1', origen: 'faq' });
    const datos = mockPrisma.chatSession.create.mock.calls[0][0].data;
    expect(datos).toEqual({ companyId: 'E1', userId: 'U1', titulo: '¿Cómo hago una factura?' });
    for (const [arg] of mockPrisma.chatMessage.create.mock.calls) expect(arg.data).toMatchObject({ sessionId: 'sesion-nueva', companyId: 'E1', userId: 'U1' });
    expect(mockPrisma.chatSession.updateMany.mock.calls[0][0].where).toEqual({ id: 'sesion-nueva', companyId: 'E1', userId: 'U1' });
    // La respuesta no lleva lo que solo usa el servidor.
    expect(res.body.data).not.toHaveProperty('permisoRequerido');
    expect(res.body.data).not.toHaveProperty('validacion');
  });

  it('la conversación propia se lee filtrando por empresa y usuario, y oculta lo que ya no puede ver', async () => {
    mockPrisma.chatSession.findFirst.mockResolvedValue({ id: 's1', titulo: 'Saldo', contexto: null, updatedAt: new Date() });
    mockPrisma.chatMessage.findMany.mockResolvedValue([
      { id: 'm1', role: 'user', content: '¿cuánto tengo en el banco?', origen: 'datos', intencion: null, datos: null, permisoRequerido: null, calculadoEn: null, valoracion: null, createdAt: new Date() },
      { id: 'm2', role: 'assistant', content: 'El saldo es 1.000,00 €', origen: 'datos', intencion: 'INT-24', datos: { kpis: [] }, permisoRequerido: 'tesoreria:read', calculadoEn: new Date(), valoracion: null, createdAt: new Date() },
    ]);
    const res = await request(app).get(`${ruta()}/s1/messages`).set('Authorization', U1);
    expect(res.status).toBe(200);
    expect(mockPrisma.chatMessage.findMany.mock.calls[0][0].where).toEqual({ sessionId: 's1', companyId: 'E1', userId: 'U1' });
    const [pregunta, respuesta] = res.body.data.mensajes;
    expect(pregunta.oculto).toBe(false);
    expect(respuesta).toMatchObject({ oculto: true, datos: null, content: 'Respuesta oculta: ya no tienes acceso a este dato.' });
    expect(JSON.stringify(res.body)).not.toContain('1.000,00');
  });

  it('el listado de conversaciones es solo del usuario en esa empresa', async () => {
    const res = await request(app).get(`${ruta()}/sesiones?pagina=2`).set('Authorization', U1);
    expect(res.status).toBe(200);
    expect(mockPrisma.chatSession.findMany.mock.calls[0][0]).toMatchObject({ where: { companyId: 'E1', userId: 'U1' }, skip: 20, take: 20 });
  });

  it('valorar una respuesta ajena: 404', async () => {
    mockPrisma.chatMessage.updateMany.mockResolvedValue({ count: 0 });
    const res = await request(app).post(`${ruta()}/mensajes/m-ajeno/valoracion`).set('Authorization', U1).send({ util: true });
    expect(res.status).toBe(404);
    expect(mockPrisma.chatMessage.updateMany.mock.calls[0][0].where).toMatchObject({ id: 'm-ajeno', companyId: 'E1', userId: 'U1' });
  });

  it('una empresa que no es del usuario: 403', async () => {
    const res = await request(app).post(ruta('E3')).set('Authorization', U1).send({ message: 'hola' });
    expect(res.status).toBe(403);
  });
});

describe('entrada', () => {
  it('501 caracteres: 400', async () => {
    const res = await request(app).post(ruta()).set('Authorization', U1).send({ message: 'a'.repeat(501) });
    expect(res.status).toBe(400);
    expect(mockPrisma.chatSession.create).not.toHaveBeenCalled();
  });

  it('500 caracteres sí se aceptan', async () => {
    const res = await request(app).post(ruta()).set('Authorization', U1).send({ message: `${'factura '.repeat(62)}abcd` });
    expect(res.status).toBe(200);
  });

  it('sin message ni accion, o con un mensaje en blanco: 400', async () => {
    expect((await request(app).post(ruta()).set('Authorization', U1).send({})).status).toBe(400);
    expect((await request(app).post(ruta()).set('Authorization', U1).send({ message: '   ' })).status).toBe(400);
    expect((await request(app).post(ruta()).set('Authorization', U1).send({ accion: { tipo: 'borrar-todo' } })).status).toBe(400);
    expect((await request(app).post(ruta()).set('Authorization', U1).send({ message: 'hola', currentPage: 'x'.repeat(201) })).status).toBe(400);
  });

  it('un cuerpo de más de 16 KB: 413; un JSON roto: 400', async () => {
    const grande = await request(app).post(ruta()).set('Authorization', U1).set('Content-Type', 'application/json').send(JSON.stringify({ message: 'a', relleno: 'x'.repeat(17_000) }));
    expect(grande.status).toBe(413);
    const roto = await request(app).post(ruta()).set('Authorization', U1).set('Content-Type', 'application/json').send('{"message":');
    expect(roto.status).toBe(400);
  });

  it('el freno de mensajes diarios devuelve 429 sin responder', async () => {
    mockPrisma.$executeRaw.mockResolvedValueOnce(0);
    const res = await request(app).post(ruta()).set('Authorization', U1).send({ message: 'hola' });
    expect(res.status).toBe(429);
    expect(mockPrisma.chatMessage.create).not.toHaveBeenCalled();
  });

  it('un botón con una intención inexistente responde con aclaración, no con un 500', async () => {
    const res = await request(app).post(ruta()).set('Authorization', U1).send({ accion: { tipo: 'intencion', id: 'INT-99' } });
    expect(res.status).toBe(200);
    expect(res.body.data.origen).toBe('aclaracion');
  });
});

describe('ajustes y estado de la IA', () => {
  it('solo el administrador de la empresa cambia los ajustes', async () => {
    const noAdmin = await request(app).put(`${ruta('E1')}/ajustes`).set('Authorization', U1).send({ iaActiva: true });
    expect(noAdmin.status).toBe(403);
    expect(mockPrisma.carmenAjustes.upsert).not.toHaveBeenCalled();
    expect((await request(app).get(`${ruta('E1')}/uso`).set('Authorization', U1)).status).toBe(403);

    mockPrisma.carmenAjustes.findUnique.mockResolvedValue({ companyId: 'E2', iaActiva: true, topeConsultasDia: null, conservarDias: 90, actualizadoPor: 'U1', actualizadoEn: new Date() });
    const admin = await request(app).put(`${ruta('E2')}/ajustes`).set('Authorization', U1).send({ iaActiva: true });
    expect(admin.status).toBe(200);
    expect(mockPrisma.carmenAjustes.upsert.mock.calls[0][0]).toMatchObject({ where: { companyId: 'E2' }, update: { iaActiva: true, actualizadoPor: 'U1' } });
  });

  it('los ajustes no aceptan campos raros ni un tope mayor que el general', async () => {
    expect((await request(app).put(`${ruta('E2')}/ajustes`).set('Authorization', U1).send({ iaActiva: 'si' })).status).toBe(400);
    expect((await request(app).put(`${ruta('E2')}/ajustes`).set('Authorization', U1).send({ topeConsultasDia: 1000 })).status).toBe(400);
    expect((await request(app).put(`${ruta('E2')}/ajustes`).set('Authorization', U1).send({ conservarDias: 365 })).status).toBe(400);
    expect((await request(app).put(`${ruta('E2')}/ajustes`).set('Authorization', U1).send({ otro: 1 })).status).toBe(400);
  });

  it('la IA viene desactivada por defecto en cada empresa', async () => {
    const res = await request(app).get(`${ruta('E2')}/ajustes`).set('Authorization', U1);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ iaActiva: false, conservarDias: 90, topeGeneralDia: 100 });
  });

  it('estado: el motivo real; el uso solo para el administrador', async () => {
    const ventas = await request(app).get(`${ruta('E1')}/estado`).set('Authorization', U1);
    expect(ventas.body.data).toEqual({ iaDisponible: false, iaActivaEmpresa: false, motivo: 'apagada', textoMotivo: expect.any(String) });
    const admin = await request(app).get(`${ruta('E2')}/estado`).set('Authorization', U1);
    expect(admin.body.data.usoMes).toMatchObject({ gastoMesEur: 0, topeMesEur: 5, topeEmpresaDia: 100 });
  });

  it('catálogo: solo las intenciones permitidas, chips de la página y fichas destacadas', async () => {
    const res = await request(app).get(`${ruta('E1')}/catalogo?pagina=/dashboard/facturas`).set('Authorization', U1);
    expect(res.status).toBe(200);
    const ids = res.body.data.areas.flatMap((a: { intenciones: Array<{ id: string }> }) => a.intenciones.map((i) => i.id));
    expect(ids).toContain('INT-02');
    expect(ids).not.toContain('INT-24');
    expect(ids).not.toContain('INT-28');
    expect(res.body.data.chips[0].accion).toMatchObject({ tipo: 'intencion' });
    expect(res.body.data.chips.length).toBeLessThanOrEqual(4);
    expect(res.body.data.fichas.map((f: { id: string }) => f.id)).toContain('app-factura-nueva');
  });

  it('/health dice si la IA de Carmen está encendida, sin importes', async () => {
    const res = await request(app).get('/health');
    expect(Object.keys(res.body.carmen).sort()).toEqual(['llmActivo', 'topeAgotado']);
    expect(res.body.carmen.llmActivo).toBe(false);
    expect([true, false, null]).toContain(res.body.carmen.topeAgotado);
    expect(JSON.stringify(res.body.carmen)).not.toMatch(/€|usd|eur/i);
  });
});
