/**
 * Rutas /companies/:companyId/ocr/* (y /analytics/*) sobre la app entera y BD
 * real: cada empresa ve y toca solo sus sesiones OCR.
 *
 * Antes, los routers de OCR no tenian mergeParams y los controladores leian
 * req.params.companyId, que llegaba undefined: Prisma ignora un filtro
 * undefined, asi que el listado, el detalle, las estadisticas y el reintento
 * abarcaban todas las empresas, y la subida daba 500 con el mensaje interno de
 * Prisma en details.message.
 *
 * Tambien el confirmar del lector de gastos: ya no finge un alta («Gasto
 * registrado») sin guardar nada; responde 501 y no crea nada.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests). Crea
 * usuarios, asi que solo corre en CI o contra una BD local.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from '@jest/globals';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import request from 'supertest';
import { app } from '../app';
import { prisma } from '../config/database';
import { authService } from '../services/auth.service';
import { hashPassword } from '../utils/password';
import OCRPersistenceService from '../services/ocr-persistence.service';
import ILovePDFService from '../services/ilovepdf.service';
import ILovePDFConfig from '../config/ilovepdf.config';
import * as pdfTextExtractor from '../utils/pdfTextExtractor';

function hostDeLaBd(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? '').hostname;
  } catch {
    return '';
  }
}
const BD_DE_PRUEBAS = process.env.CI === 'true' || ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostDeLaBd());
const describeBd = BD_DE_PRUEBAS ? describe : describe.skip;

const SUFIJO = `${Date.now()}${randomBytes(3).toString('hex')}`;
const EMPRESA_A = `ocr-a-${SUFIJO}`;
const EMPRESA_B = `ocr-b-${SUFIJO}`;
const TEXTO_B = `TEXTO SECRETO DE LA EMPRESA B ${SUFIJO}`;
// Lo que guardaba antes una sesion fallida en errorMessage (las filas ya guardadas lo conservan).
const MENSAJE_INTERNO = "Error: Cannot find module 'pdf-parse'\nRequire stack:\n- C:\\servidor\\dist\\utils\\pdfTextExtractor.js";
// Nada de esto puede salir por la API: mensajes internos ni rutas del servidor.
const DATO_INTERNO = /pdf-parse|Require stack|prisma|ECONNREFUSED|[A-Z]:\\|\/tmp\/|uploads|node_modules|originalFilePath|ocrPdfPath|errorMessage/i;

const usuarios: Record<'a' | 'b' | 'adminA', { id: string; token: string }> = {} as never;
const ses: Record<'aOk' | 'aFallo' | 'bOk' | 'bFallo', string> = {} as never;

async function crearUsuario(nombre: string, companyId: string, role: 'contable' | 'admin') {
  const email = `${nombre}-${SUFIJO}@test.local`;
  const u = await prisma.user.create({ data: { email, passwordHash: hashPassword(randomBytes(18).toString('base64url')) } });
  await prisma.membership.create({ data: { userId: u.id, companyId, role } });
  return { id: u.id, token: authService.generateToken({ userId: u.id, email, roles: [], companies: [] }) };
}

const crearSesion = (companyId: string, status: string, texto?: string) =>
  prisma.oCRSession.create({
    data: {
      companyId,
      originalFileName: `f-${companyId}-${status}.pdf`,
      originalFilePath: '/tmp/ocr/uploads/x.pdf',
      originalFileSize: 100,
      originalMimeType: 'application/pdf',
      status,
      ocrTextExtracted: texto,
      processingTimeSeconds: status === 'COMPLETED' ? 4 : null,
      errorCode: status === 'FAILED' ? 'UNKNOWN_ERROR' : null,
      errorMessage: status === 'FAILED' ? MENSAJE_INTERNO : null,
      ocrPdfPath: status === 'COMPLETED' ? '/tmp/ocr/processed/x_ocr.pdf' : null,
    },
  });

const como = (quien: 'a' | 'b' | 'adminA') => ({
  get: (ruta: string) => request(app).get(ruta).set('Authorization', `Bearer ${usuarios[quien].token}`),
  post: (ruta: string, body: object = {}) => request(app).post(ruta).set('Authorization', `Bearer ${usuarios[quien].token}`).send(body),
});

describeBd('OCR por empresa (app entera, BD real)', () => {
  beforeAll(async () => {
    for (const id of [EMPRESA_A, EMPRESA_B]) {
      await prisma.company.create({ data: { id, name: `Empresa ${id}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    }
    usuarios.a = await crearUsuario('ocr-a', EMPRESA_A, 'contable');
    usuarios.b = await crearUsuario('ocr-b', EMPRESA_B, 'contable');
    usuarios.adminA = await crearUsuario('ocr-admin-a', EMPRESA_A, 'admin');

    ses.aOk = (await crearSesion(EMPRESA_A, 'COMPLETED', 'texto de A')).id;
    ses.aFallo = (await crearSesion(EMPRESA_A, 'FAILED')).id;
    ses.bOk = (await crearSesion(EMPRESA_B, 'COMPLETED', TEXTO_B)).id;
    ses.bFallo = (await crearSesion(EMPRESA_B, 'FAILED')).id;
    await prisma.oCRDocument.create({ data: { companyId: EMPRESA_B, sessionId: ses.bOk, extractedData: { ocrText: TEXTO_B } } });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    const empresas = [EMPRESA_A, EMPRESA_B];
    await prisma.oCRDocument.deleteMany({ where: { companyId: { in: empresas } } });
    await prisma.oCRSession.deleteMany({ where: { companyId: { in: empresas } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: `-${SUFIJO}@test.local` } } }); // accesos en cascada
    await prisma.company.deleteMany({ where: { id: { in: empresas } } });
  });

  it('listado: solo las sesiones de la empresa de la ruta', async () => {
    const res = await como('a').get(`/companies/${EMPRESA_A}/ocr/sessions`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((s: { id: string }) => s.id).sort()).toEqual([ses.aOk, ses.aFallo].sort());
    expect(res.body.data.every((s: { companyId: string }) => s.companyId === EMPRESA_A)).toBe(true);
    expect(res.body.pagination.total).toBe(2);
    expect(JSON.stringify(res.body)).not.toContain(TEXTO_B);
  });

  it('detalle: la sesion propia se ve; la de otra empresa da 404 sin su texto', async () => {
    const propia = await como('a').get(`/companies/${EMPRESA_A}/ocr/sessions/${ses.aOk}`);
    expect(propia.status).toBe(200);
    expect(propia.body.data).toMatchObject({ id: ses.aOk, companyId: EMPRESA_A, ocrTextExtracted: 'texto de A' });

    const ajena = await como('a').get(`/companies/${EMPRESA_A}/ocr/sessions/${ses.bOk}`);
    expect(ajena.status).toBe(404);
    expect(JSON.stringify(ajena.body)).not.toContain(TEXTO_B);
  });

  it('listado y detalle: sin el mensaje interno del error ni rutas del servidor', async () => {
    const lista = await como('a').get(`/companies/${EMPRESA_A}/ocr/sessions`);
    expect(lista.status).toBe(200);
    expect(lista.body.data).toHaveLength(2);
    expect(JSON.stringify(lista.body)).not.toMatch(DATO_INTERNO);
    expect(lista.body.data.find((s: { id: string }) => s.id === ses.aFallo).errorCode).toBe('UNKNOWN_ERROR');

    for (const id of [ses.aOk, ses.aFallo]) {
      const detalle = await como('a').get(`/companies/${EMPRESA_A}/ocr/sessions/${id}`);
      expect(detalle.status).toBe(200);
      expect(JSON.stringify(detalle.body)).not.toMatch(DATO_INTERNO);
    }
  });

  it('la empresa B por URL: 403 para un usuario sin acceso a ella', async () => {
    expect((await como('a').get(`/companies/${EMPRESA_B}/ocr/sessions`)).status).toBe(403);
    expect((await como('a').get(`/companies/${EMPRESA_B}/ocr/sessions/${ses.bOk}`)).status).toBe(403);
    expect((await como('a').post(`/companies/${EMPRESA_B}/ocr/sessions/${ses.bFallo}/retry`)).status).toBe(403);
  });

  it('estadisticas: cuentan solo la empresa de la ruta', async () => {
    const res = await como('a').get(`/companies/${EMPRESA_A}/ocr/stats`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ total: 2, completed: 1, failed: 1, pending: 0 });
  });

  it('estado del servicio: estadisticas e historial solo de la empresa de la ruta', async () => {
    jest.spyOn(ILovePDFConfig, 'validate').mockImplementation(() => undefined);
    jest.spyOn(ILovePDFService, 'getAccountInfo').mockResolvedValue({});
    const res = await como('a').get(`/companies/${EMPRESA_A}/ocr/status`);
    expect(res.status).toBe(200);
    expect(res.body.data.companyId).toBe(EMPRESA_A);
    expect(res.body.data.stats.total).toBe(2);
    expect(res.body.data.recentSessions.map((s: { id: string }) => s.id).sort()).toEqual([ses.aOk, ses.aFallo].sort());
  });

  it('analytics: KPIs, distribucion y evolucion solo de la empresa de la ruta', async () => {
    const kpis = await como('a').get(`/companies/${EMPRESA_A}/analytics/kpis?days=30`);
    expect(kpis.status).toBe(200);
    expect(kpis.body.data).toMatchObject({ totalProcessed: 2, completedCount: 1, failedCount: 1 });

    const dist = await como('a').get(`/companies/${EMPRESA_A}/analytics/distribution?days=30`);
    expect(dist.status).toBe(200);
    expect(dist.body.data.total).toBe(2);

    const tl = await como('a').get(`/companies/${EMPRESA_A}/analytics/timeline?days=30`);
    expect(tl.status).toBe(200);
    expect(tl.body.data.reduce((s: number, d: { count: number }) => s + d.count, 0)).toBe(2);
  });

  it('analytics global: solo para el administrador de la plataforma', async () => {
    expect((await como('adminA').get(`/companies/${EMPRESA_A}/analytics/global`)).status).toBe(403);
  });

  it('reintento: no toca la sesion de otra empresa (404) y si la propia', async () => {
    const ajena = await como('a').post(`/companies/${EMPRESA_A}/ocr/sessions/${ses.bFallo}/retry`);
    expect(ajena.status).toBe(404);
    expect((await prisma.oCRSession.findUniqueOrThrow({ where: { id: ses.bFallo } })).status).toBe('FAILED');

    const propia = await como('a').post(`/companies/${EMPRESA_A}/ocr/sessions/${ses.aFallo}/retry`);
    expect(propia.status).toBe(200);
    expect(JSON.stringify(propia.body)).not.toMatch(DATO_INTERNO);
    expect((await prisma.oCRSession.findUniqueOrThrow({ where: { id: ses.aFallo } })).status).toBe('PENDING');
  });

  it('enviar al lector: la sesion de otra empresa da 404', async () => {
    const res = await como('a').post(`/companies/${EMPRESA_A}/ocr/sessions/${ses.bOk}/send-to-reader`, { readerType: 'expense' });
    expect(res.status).toBe(404);
  });

  it('subida: la sesion se guarda en la empresa de la ruta y con el usuario que sube', async () => {
    const nombre = `subida-${SUFIJO}.pdf`;
    const res = await request(app)
      .post(`/companies/${EMPRESA_A}/ocr/invoices`)
      .set('Authorization', `Bearer ${usuarios.a.token}`)
      .attach('file', Buffer.from('%PDF-1.4\n%%EOF\n'), nombre);
    // Sin pdf-parse ni claves de iLovePDF no llega a leer el PDF, pero la sesion
    // ya no falla al crearse por falta de companyId.
    expect(res.status).toBeGreaterThanOrEqual(400);
    const creada = await prisma.oCRSession.findFirstOrThrow({ where: { originalFileName: nombre } });
    expect(creada).toMatchObject({ companyId: EMPRESA_A, userId: usuarios.a.id, status: 'FAILED' });
    // Ni rutas del servidor ni trazas en la respuesta.
    expect(res.body.details).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(DATO_INTERNO);
    // Ni en la sesion guardada, ni al pedirla despues por el listado o el detalle.
    expect(creada.errorMessage ?? '').not.toMatch(DATO_INTERNO);
    const lista = await como('a').get(`/companies/${EMPRESA_A}/ocr/sessions`);
    expect(JSON.stringify(lista.body)).not.toMatch(DATO_INTERNO);
    const detalle = await como('a').get(`/companies/${EMPRESA_A}/ocr/sessions/${creada.id}`);
    expect(detalle.status).toBe(200);
    expect(JSON.stringify(detalle.body)).not.toMatch(DATO_INTERNO);
    // Y el PDF subido no se queda en el servidor.
    expect(fs.existsSync(creada.originalFilePath)).toBe(false);
  });

  it('un fallo despues de crear la sesion: ni la respuesta ni la sesion llevan el mensaje interno', async () => {
    const nombre = `tras-sesion-${SUFIJO}.pdf`;
    jest.spyOn(pdfTextExtractor, 'validatePdfFile').mockResolvedValue({ isValid: true, pages: 1 });
    jest
      .spyOn(ILovePDFService, 'ocrInvoicePdf')
      .mockRejectedValueOnce(new Error('Invalid `prisma.x.update()` invocation in /var/task/dist/services/ocr.js:12 connect ECONNREFUSED 10.0.3.7:3306'));
    const res = await request(app)
      .post(`/companies/${EMPRESA_A}/ocr/invoices`)
      .set('Authorization', `Bearer ${usuarios.a.token}`)
      .attach('file', Buffer.from('%PDF-1.4\n%%EOF\n'), nombre);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(DATO_INTERNO);

    const creada = await prisma.oCRSession.findFirstOrThrow({ where: { originalFileName: nombre } });
    expect(creada).toMatchObject({ id: res.body.sessionId, status: 'FAILED', errorCode: 'UNKNOWN_ERROR' });
    expect(creada.errorMessage ?? '').not.toMatch(DATO_INTERNO);
    const detalle = await como('a').get(`/companies/${EMPRESA_A}/ocr/sessions/${creada.id}`);
    expect(detalle.status).toBe(200);
    expect(JSON.stringify(detalle.body)).not.toMatch(DATO_INTERNO);
    expect(fs.existsSync(creada.originalFilePath)).toBe(false);
  });

  it('un 500 en la subida no devuelve el mensaje interno', async () => {
    jest
      .spyOn(OCRPersistenceService, 'createSession')
      .mockRejectedValueOnce(new Error('Invalid `prisma.oCRSession.create()` invocation in C:\\ruta\\interna\\ocr.controller.ts: Argument companyId is missing.'));
    const res = await request(app)
      .post(`/companies/${EMPRESA_A}/ocr/invoices`)
      .set('Authorization', `Bearer ${usuarios.a.token}`)
      .attach('file', Buffer.from('%PDF-1.4\n%%EOF\n'), `fallo-${SUFIJO}.pdf`);
    expect(res.status).toBe(500);
    expect(res.body.details).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/prisma|ruta|interna|companyId is missing/i);
  });

  it('limpieza de temporales: es de toda la plataforma, no la lanza el administrador de una empresa', async () => {
    const res = await como('adminA').post(`/companies/${EMPRESA_A}/ocr/cleanup`, { daysOld: 36500 });
    expect(res.status).toBe(403);
  });

  it('lector de gastos: confirmar responde 501 y no crea nada', async () => {
    const contar = async () => ({
      facturas: await prisma.expenseInvoice.count({ where: { companyId: EMPRESA_A } }),
      proveedores: await prisma.supplier.count({ where: { companyId: EMPRESA_A } }),
      asientos: await prisma.journalEntry.count({ where: { companyId: EMPRESA_A } }),
    });
    const antes = await contar();
    const res = await como('a').post(`/companies/${EMPRESA_A}/gastos-extractor/confirmar`, {
      numeroFactura: 'F-1',
      proveedor: 'Proveedor SL',
      nifProveedor: 'B12345678',
      fecha: '2026-10-01',
      conceptoGasto: 'Material',
      base: 100,
      iva: 21,
      total: 121,
    });
    expect(res.status).toBe(501);
    expect(res.body.message).toBe('El registro desde el lector de gastos aún no está disponible: da de alta la factura en Compras');
    expect(JSON.stringify(res.body)).not.toMatch(/gastoId|CONFIRMADO/);
    expect(await contar()).toEqual(antes);
  });
});
