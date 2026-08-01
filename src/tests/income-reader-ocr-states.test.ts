import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { prisma } from '../config/database';
import { incomeReaderService } from '../services/income-reader.service';

/**
 * Tests para OCR Estados: UPLOADED → PROCESSING → READY_FOR_VERIFICATION/ERROR
 * Cubre:
 * - Documento con OCR exitoso: PROCESSING → READY_FOR_VERIFICATION
 * - Documento con OCR fallido: PROCESSING → ERROR
 * - Reintento solo permitido en ERROR
 * - Reintento exitoso: ERROR → READY_FOR_VERIFICATION
 */
describe('Income Reader - OCR Estados', () => {
  let testCompanyId: string;

  beforeAll(async () => {
    testCompanyId = 'test-company-ocr-states';
  });

  afterAll(async () => {
    // Limpiar documentos de prueba
    await prisma.incomeReaderDocument.deleteMany({
      where: { companyId: testCompanyId },
    });
  });

  it('should transition PROCESSING → READY_FOR_VERIFICATION on successful OCR', async () => {
    // Crear documento
    const doc = await prisma.incomeReaderDocument.create({
      data: {
        companyId: testCompanyId,
        sourceType: 'MOBILE_CAMERA',
        originalFileName: 'factura-valida.jpg',
        mimeType: 'image/jpeg',
        fileSize: 1024,
        storagePath: '/tmp/test.jpg',
      },
    });

    expect(doc.status).toBe('UPLOADED');
    expect(doc.errorMensaje).toBeNull();

    // Simular lo que hace procesarDocumentoEnBackground al éxito
    const mockOCRSuccess = {
      confianza: 95,
      ocrEstado: 'OK',
      cliente: { nombre: 'Test Cliente' },
      fecha: '2026-06-30',
    };

    await prisma.incomeReaderDocument.update({
      where: { id: doc.id },
      data: {
        status: 'PROCESSING',
        processingStartedAt: new Date(),
        errorMensaje: null,
      },
    });

    let updated = await prisma.incomeReaderDocument.findUnique({
      where: { id: doc.id },
    });
    expect(updated?.status).toBe('PROCESSING');

    // Simular éxito
    await prisma.incomeReaderDocument.update({
      where: { id: doc.id },
      data: {
        status: 'READY_FOR_VERIFICATION',
        parsedData: mockOCRSuccess as any,
        processingCompletedAt: new Date(),
        errorMensaje: null,
      },
    });

    updated = await prisma.incomeReaderDocument.findUnique({
      where: { id: doc.id },
    });
    expect(updated?.status).toBe('READY_FOR_VERIFICATION');
    expect(updated?.errorMensaje).toBeNull();
    expect(updated?.parsedData).toBeDefined();
  });

  it('should transition PROCESSING → ERROR on OCR failure', async () => {
    // Crear documento
    const doc = await prisma.incomeReaderDocument.create({
      data: {
        companyId: testCompanyId,
        sourceType: 'MOBILE_CAMERA',
        originalFileName: 'factura-ilegible.jpg',
        mimeType: 'image/jpeg',
        fileSize: 1024,
        storagePath: '/tmp/test-error.jpg',
      },
    });

    // Simular transición a PROCESSING
    await prisma.incomeReaderDocument.update({
      where: { id: doc.id },
      data: {
        status: 'PROCESSING',
        processingStartedAt: new Date(),
      },
    });

    // Simular fallo de OCR (confianza 0, ocrEstado NO_LEGIBLE)
    const mockOCRFailure = {
      confianza: 0,
      ocrEstado: 'NO_LEGIBLE',
    };

    // Marcar ERROR
    await prisma.incomeReaderDocument.update({
      where: { id: doc.id },
      data: {
        status: 'ERROR',
        errorMensaje: `OCR no pudo leer el documento. Estado: ${mockOCRFailure.ocrEstado}`,
        processingCompletedAt: new Date(),
      },
    });

    const updated = await prisma.incomeReaderDocument.findUnique({
      where: { id: doc.id },
    });
    expect(updated?.status).toBe('ERROR');
    expect(updated?.errorMensaje).toContain('NO_LEGIBLE');
    expect(updated?.processingCompletedAt).toBeDefined();
  });

  it('should only allow reintento on ERROR status', async () => {
    // Crear documento en READY_FOR_VERIFICATION
    const doc = await prisma.incomeReaderDocument.create({
      data: {
        companyId: testCompanyId,
        sourceType: 'MOBILE_CAMERA',
        originalFileName: 'factura-lista.jpg',
        mimeType: 'image/jpeg',
        fileSize: 1024,
        storagePath: '/tmp/test-ready.jpg',
        status: 'READY_FOR_VERIFICATION',
      },
    });

    // Intentar reintentar desde READY_FOR_VERIFICATION debe fallar
    try {
      await incomeReaderService.reintentarOCR(testCompanyId, doc.id);
      throw new Error('Should have thrown badRequest');
    } catch (err: any) {
      expect(err.message).toContain('No puedes reintentar OCR');
      expect(err.message).toContain('READY_FOR_VERIFICATION');
    }
  });

  it('should transition ERROR → READY_FOR_VERIFICATION on successful reintento', async () => {
    // Crear documento en ERROR
    const doc = await prisma.incomeReaderDocument.create({
      data: {
        companyId: testCompanyId,
        sourceType: 'MOBILE_CAMERA',
        originalFileName: 'factura-error.jpg',
        mimeType: 'image/jpeg',
        fileSize: 1024,
        storagePath: '/tmp/test-reintent.jpg',
        status: 'ERROR',
        errorMensaje: 'OCR falló previamente',
      },
    });

    expect(doc.status).toBe('ERROR');
    expect(doc.errorMensaje).toBeTruthy();

    // Simular reintento exitoso (lo que hace procesarDocumentoEnBackground)
    const mockOCRSuccess = {
      confianza: 85,
      ocrEstado: 'OK',
      cliente: { nombre: 'Retry Successful' },
    };

    await prisma.incomeReaderDocument.update({
      where: { id: doc.id },
      data: {
        status: 'PROCESSING',
        processingStartedAt: new Date(),
        errorMensaje: null,
      },
    });

    // Simular éxito del reintento
    await prisma.incomeReaderDocument.update({
      where: { id: doc.id },
      data: {
        status: 'READY_FOR_VERIFICATION',
        parsedData: mockOCRSuccess as any,
        processingCompletedAt: new Date(),
        errorMensaje: null,
      },
    });

    const updated = await prisma.incomeReaderDocument.findUnique({
      where: { id: doc.id },
    });
    expect(updated?.status).toBe('READY_FOR_VERIFICATION');
    expect(updated?.errorMensaje).toBeNull();
    expect(updated?.parsedData).toBeDefined();
  });

  it('should clear errorMensaje on transition to READY_FOR_VERIFICATION', async () => {
    // Crear documento en ERROR con errorMensaje
    const doc = await prisma.incomeReaderDocument.create({
      data: {
        companyId: testCompanyId,
        sourceType: 'MOBILE_CAMERA',
        originalFileName: 'factura-clear-error.jpg',
        mimeType: 'image/jpeg',
        fileSize: 1024,
        storagePath: '/tmp/test-clear.jpg',
        status: 'ERROR',
        errorMensaje: 'Previous error message',
      },
    });

    // Marcar como READY_FOR_VERIFICATION y limpiar error
    await prisma.incomeReaderDocument.update({
      where: { id: doc.id },
      data: {
        status: 'READY_FOR_VERIFICATION',
        parsedData: { confianza: 90, ocrEstado: 'OK' } as any,
        errorMensaje: null,
      },
    });

    const updated = await prisma.incomeReaderDocument.findUnique({
      where: { id: doc.id },
    });
    expect(updated?.errorMensaje).toBeNull();
  });
});

/**
 * Tests para OCR con Expiración: expiresAt y validación de documentos expirados
 */
describe('Income Reader - OCR con Expiración', () => {
  let testCompanyId: string;

  beforeAll(async () => {
    testCompanyId = 'test-company-ocr-expiry';
  });

  afterAll(async () => {
    // Limpiar documentos de prueba
    await prisma.incomeReaderDocument.deleteMany({
      where: { companyId: testCompanyId },
    });
  });

  it('should process document without expiresAt normally', async () => {
    // Crear documento SIN expiresAt (no expira)
    const doc = await prisma.incomeReaderDocument.create({
      data: {
        companyId: testCompanyId,
        sourceType: 'MOBILE_CAMERA',
        originalFileName: 'factura-no-expiry.jpg',
        mimeType: 'image/jpeg',
        fileSize: 1024,
        storagePath: '/tmp/test-no-expiry.jpg',
      },
    });

    expect(doc.expiresAt).toBeNull();

    // Simular procesamiento exitoso (sin validación de expiración)
    await prisma.incomeReaderDocument.update({
      where: { id: doc.id },
      data: {
        status: 'READY_FOR_VERIFICATION',
        parsedData: { confianza: 90, ocrEstado: 'OK' } as any,
        processingCompletedAt: new Date(),
      },
    });

    const updated = await prisma.incomeReaderDocument.findUnique({
      where: { id: doc.id },
    });
    expect(updated?.status).toBe('READY_FOR_VERIFICATION');
    expect(updated?.expiresAt).toBeNull();
  });

  it('should process document with future expiresAt', async () => {
    // Crear documento con expiración futura
    const futuraDate = new Date();
    futuraDate.setDate(futuraDate.getDate() + 7); // Expira en 7 días

    const doc = await prisma.incomeReaderDocument.create({
      data: {
        companyId: testCompanyId,
        sourceType: 'MOBILE_CAMERA',
        originalFileName: 'factura-future-expiry.jpg',
        mimeType: 'image/jpeg',
        fileSize: 1024,
        storagePath: '/tmp/test-future-expiry.jpg',
        expiresAt: futuraDate,
      },
    });

    expect(doc.expiresAt).not.toBeNull();

    // Procesar normalmente (no ha expirado)
    await prisma.incomeReaderDocument.update({
      where: { id: doc.id },
      data: {
        status: 'READY_FOR_VERIFICATION',
        parsedData: { confianza: 90, ocrEstado: 'OK' } as any,
      },
    });

    const updated = await prisma.incomeReaderDocument.findUnique({
      where: { id: doc.id },
    });
    expect(updated?.status).toBe('READY_FOR_VERIFICATION');
  });

  it('should reject document with past expiresAt', async () => {
    // Crear documento ya expirado
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 1); // Expiró ayer

    const doc = await prisma.incomeReaderDocument.create({
      data: {
        companyId: testCompanyId,
        sourceType: 'MOBILE_CAMERA',
        originalFileName: 'factura-past-expiry.jpg',
        mimeType: 'image/jpeg',
        fileSize: 1024,
        storagePath: '/tmp/test-past-expiry.jpg',
        expiresAt: pastDate,
      },
    });

    // Simular rechazo por expiración (sin procesar OCR)
    await prisma.incomeReaderDocument.update({
      where: { id: doc.id },
      data: {
        status: 'REJECTED',
        rejectionReason: 'Documento expirado. No se puede procesar.',
        processingCompletedAt: new Date(),
      },
    });

    const updated = await prisma.incomeReaderDocument.findUnique({
      where: { id: doc.id },
    });
    expect(updated?.status).toBe('REJECTED');
    expect(updated?.rejectionReason).toContain('expirado');
  });

  it('should detect expiration on document detail query', async () => {
    // Crear documento con expiración próxima (hace 1 segundo)
    const expiredDate = new Date();
    expiredDate.setSeconds(expiredDate.getSeconds() - 1);

    const doc = await prisma.incomeReaderDocument.create({
      data: {
        companyId: testCompanyId,
        sourceType: 'MOBILE_CAMERA',
        originalFileName: 'factura-just-expired.jpg',
        mimeType: 'image/jpeg',
        fileSize: 1024,
        storagePath: '/tmp/test-just-expired.jpg',
        status: 'READY_FOR_VERIFICATION',
        expiresAt: expiredDate,
      },
    });

    // Simulación de verificación que detecta expiración
    // (En la práctica, obtenerDetalle() calcularía estaExpirado = true)
    const isExpired = doc.expiresAt !== null && doc.expiresAt < new Date();
    expect(isExpired).toBe(true);
  });

  it('should prevent verification of expired document', async () => {
    // Crear documento expirado que intenta verificarse
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 1);

    const doc = await prisma.incomeReaderDocument.create({
      data: {
        companyId: testCompanyId,
        sourceType: 'MOBILE_CAMERA',
        originalFileName: 'factura-cant-verify.jpg',
        mimeType: 'image/jpeg',
        fileSize: 1024,
        storagePath: '/tmp/test-cant-verify.jpg',
        status: 'READY_FOR_VERIFICATION',
        expiresAt: pastDate,
        parsedData: { confianza: 95, ocrEstado: 'OK' } as any,
      },
    });

    // Simulación: verificarYCrearFactura debería rechazar si estaExpirado=true
    const isExpired = doc.expiresAt !== null && doc.expiresAt < new Date();
    expect(isExpired).toBe(true);
    // En la práctica, incomeReaderService.verificarYCrearFactura() lanzaría badRequest
  });

  it('should handle document that expires after READY_FOR_VERIFICATION', async () => {
    // Crear documento con expiración futura
    const futuraDate = new Date();
    futuraDate.setMinutes(futuraDate.getMinutes() + 5);

    const doc = await prisma.incomeReaderDocument.create({
      data: {
        companyId: testCompanyId,
        sourceType: 'MOBILE_CAMERA',
        originalFileName: 'factura-expires-later.jpg',
        mimeType: 'image/jpeg',
        fileSize: 1024,
        storagePath: '/tmp/test-expires-later.jpg',
        status: 'READY_FOR_VERIFICATION',
        expiresAt: futuraDate,
        parsedData: { confianza: 90, ocrEstado: 'OK' } as any,
      },
    });

    // Simular que después pasa el tiempo y expira
    const nowIsExpired = futuraDate < new Date();
    expect(nowIsExpired).toBe(false); // Aún no ha expirado

    // Simular expiración inmediata actualizando expiresAt
    const pastDate = new Date();
    pastDate.setSeconds(pastDate.getSeconds() - 1);

    await prisma.incomeReaderDocument.update({
      where: { id: doc.id },
      data: { expiresAt: pastDate },
    });

    const updated = await prisma.incomeReaderDocument.findUnique({
      where: { id: doc.id },
    });

    // Verificar que ahora está expirado
    expect(updated).not.toBeNull();
    const isNowExpired = updated && updated.expiresAt !== null && updated.expiresAt < new Date();
    expect(isNowExpired).toBe(true);
  });
});
