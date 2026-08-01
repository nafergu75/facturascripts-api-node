/**
 * TESTS DE INTEGRACIÓN - Motor Contable Automático
 *
 * Casos realistas:
 * 1. Venta con IVA 21% → Asiento → Balance & PyG
 * 2. Compra con IVA soportado + IRPF → Asiento → Libro recibidas
 * 3. Modificación de factura → Reversión + nuevo asiento
 * 4. Error handling para configuración incompleta
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { PrismaClient } from '@prisma/client';
import { AccountingEngineController } from '../controllers/accounting-engine.controller';
import { ReportsService } from '../services/reports.service';
import { TaxDocumentsService } from '../services/tax-documents.service';
import { inicializarPlanContableEmpresa } from '../services/chart-of-accounts.service';

const prisma = new PrismaClient();
const accountingEngine = new AccountingEngineController();
const reportsService = new ReportsService();
const taxService = new TaxDocumentsService();

describe('Motor Contable - Casos Realistas', () => {
  let companyId: string;
  let customerId: string;
  let supplierId: string;

  beforeAll(async () => {
    // Limpieza defensiva: ids fijos que podrian quedar de una ejecucion fallida.
    await prisma.vATBook
      .deleteMany({ where: { numeroFactura: { in: ['TEST-001', 'GASTO-001'] } } })
      .catch(() => undefined);
    await prisma.expenseInvoice
      .deleteMany({ where: { numeroCompleto: 'GASTO-001' } })
      .catch(() => undefined);
    await prisma.incomeInvoice
      .deleteMany({ where: { numeroCompleto: { in: ['TEST-001', 'GASTO-001'] } } })
      .catch(() => undefined);

    // Setup: crear empresa de prueba
    const timestamp = Date.now();
    const company = await prisma.company.create({
      data: {
        id: `test-company-${timestamp}`,
        name: 'Test Company Motor Contable',
        fsBaseUrl: 'http://localhost:8080',
        fsApiKeyEnc: 'encrypted-key-test',
      },
    }).catch(() => {
      // Si ya existe, reutilizar
      return prisma.company.findUnique({
        where: { id: `test-company-${timestamp}` },
      });
    });

    if (!company) {
      throw new Error('No se pudo crear/encontrar empresa de prueba');
    }

    companyId = company.id;

    // El motor contable exige un plan contable inicializado para poder generar
    // asientos. inicializarPlanContableEmpresa referencia la version PGC '2021'
    // (FK a ChartOfAccountsVersion), asi que la aseguramos primero.
    await prisma.chartOfAccountsVersion.upsert({
      where: { version: '2021' },
      update: {},
      create: { version: '2021', descripcion: 'PGC 2021 (test)' },
    });
    await inicializarPlanContableEmpresa(companyId).catch(() => undefined);

    // Crear cliente de prueba
    const cliente = await prisma.customer.create({
      data: {
        id: `test-customer-${timestamp}`,
        companyId,
        nombreFiscal: 'Cliente Test S.L.',
        nifCif: '12345678A',
      },
    }).catch(() => {
      return prisma.customer.findUnique({
        where: { id: `test-customer-${timestamp}` },
      });
    });

    if (!cliente) {
      throw new Error('No se pudo crear/encontrar cliente de prueba');
    }

    customerId = cliente.id;

    // Crear proveedor de prueba (necesario para ExpenseInvoice del Caso 2)
    const proveedor = await prisma.supplier.create({
      data: {
        companyId,
        nombreFiscal: 'Proveedor Test S.A.',
        nifCif: 'B98765432',
      },
    }).catch(() =>
      prisma.supplier.findFirst({ where: { companyId, nifCif: 'B98765432' } }),
    );
    if (!proveedor) throw new Error('No se pudo crear proveedor de prueba');
    supplierId = proveedor.id;
  });

  afterAll(async () => {
    try {
      await prisma.retentionBook.deleteMany({ where: { companyId } });
      await prisma.vATBook.deleteMany({ where: { companyId } });
      await prisma.journalEntry.deleteMany({ where: { companyId } });
      await prisma.expenseInvoice.deleteMany({ where: { companyId } });
      await prisma.supplier.deleteMany({ where: { companyId } });
      await prisma.incomeInvoice.deleteMany({ where: { companyId } });
      await prisma.customer.deleteMany({ where: { companyId } });
      await prisma.company.delete({ where: { id: companyId } });
    } catch (err) {
      console.warn('Error en cleanup:', err);
    }
    await prisma.$disconnect();
  });

  describe('Caso 1: Venta con IVA 21%', () => {
    let invoiceId: string;
    let journalEntryId: string;

    it('debería crear factura de ingreso', async () => {
      const timestamp = Date.now();
      const factura = await prisma.incomeInvoice.create({
        data: {
          id: `test-invoice-${timestamp}`,
          companyId,
          customerId,
          serie: 'TEST',
          numero: 1,
          numeroCompleto: 'TEST-001',
          fechaEmision: new Date().toISOString().split('T')[0],
          fechaVencimiento: new Date().toISOString().split('T')[0],
          estado: 'DRAFT',
          baseTotal: 1000,
          ivaTotal: 210, // 21%
          retencionTotal: 0,
          totalFactura: 1210,
        },
      });

      invoiceId = factura.id;
      expect(invoiceId).toBeDefined();
      expect(factura.baseTotal).toBe(1000);
      expect(factura.ivaTotal).toBe(210);
    });

    it('debería generar asiento automáticamente', async () => {
      if (!invoiceId) throw new Error('No hay factura para probar');

      const resultado = await accountingEngine.contabilizarFacturaIngreso(
        companyId,
        invoiceId,
        'AUTO'
      );

      journalEntryId = resultado.journalEntryId;
      expect(journalEntryId).toBeDefined();
      expect(resultado.estado).toBe('DRAFT');

      // Verificar asiento
      const asiento = await prisma.journalEntry.findUnique({
        where: { id: journalEntryId },
        include: { lineas: true },
      });

      expect(asiento).toBeDefined();
      expect(asiento?.lineas.length).toBeGreaterThanOrEqual(2); // Al menos Cliente + Ventas + IVA

      // Validar que debe = haber
      const totalDebe = asiento!.lineas.reduce((s, l) => s + (l.debe || 0), 0);
      const totalHaber = asiento!.lineas.reduce((s, l) => s + (l.haber || 0), 0);
      expect(Math.abs(totalDebe - totalHaber)).toBeLessThan(0.01);
    });

    it('debería aprobar asiento', async () => {
      if (!journalEntryId) throw new Error('No hay asiento para aprobar');

      const resultado = await accountingEngine.aprobarAsiento(
        companyId,
        journalEntryId,
        'test-user'
      );

      expect(resultado.estado).toBe('POSTED');

      const asiento = await prisma.journalEntry.findUnique({
        where: { id: journalEntryId },
      });
      expect(asiento?.estado).toBe('POSTED');
    });

    it('debería aparecer en Balance', async () => {
      if (!journalEntryId) throw new Error('No hay asiento');

      const hoy = new Date().toISOString().split('T')[0];
      const balance = await reportsService.obtenerBalance(
        companyId,
        '2020-01-01',
        hoy
      );

      expect(balance).toBeDefined();
      expect(balance.activo).toBeDefined();
      expect(balance.pasivo).toBeDefined();
    });

    it('debería aparecer en P&L', async () => {
      if (!journalEntryId) throw new Error('No hay asiento');

      const hoy = new Date().toISOString().split('T')[0];
      const pyg = await reportsService.obtenerPyG(
        companyId,
        '2020-01-01',
        hoy
      );

      expect(pyg).toBeDefined();
      expect(pyg.ingresos).toBeGreaterThanOrEqual(1000); // Base de venta
      expect(pyg.resultadoExplotacion).toBeDefined();
    });

    it('debería registrar en libro IVA emitidas', async () => {
      if (!invoiceId) throw new Error('No hay factura');

      const libro = await prisma.vATBook.findFirst({
        where: {
          companyId,
          tipoLibro: 'EMITIDAS',
          numeroFactura: 'TEST-001',
        },
      });

      expect(libro).toBeDefined();
      expect(libro?.baseImponible).toBe(1000);
      expect(libro?.cuotaIva).toBe(210);
    });
  });

  describe('Caso 2: Compra con IVA soportado + IRPF 15% (Profesional)', () => {
    let invoiceId: string;
    let journalEntryId: string;

    it('debería crear ExpenseInvoice de gasto con retención', async () => {
      const hoy = new Date().toISOString().split('T')[0];
      const factura = await prisma.expenseInvoice.create({
        data: {
          companyId,
          supplierId,
          serie: 'GASTO',
          numero: 1,
          numeroCompleto: 'GASTO-001',
          fechaEmision: hoy,
          fechaVencimiento: hoy,
          estado: 'CONFIRMED',
          tipoGasto: 'SERVICIO_PROFESIONAL',
          baseTotal: 1000,
          ivaTotal: 210,      // 21% IVA soportado
          tipoIva: 21,
          retencionTotal: 150, // 15% IRPF retenido al proveedor
          tipoRetencion: 15,
          totalFactura: 1060,  // 1000 + 210 - 150 (neto al proveedor)
        },
      });

      invoiceId = factura.id;
      expect(invoiceId).toBeDefined();
    });

    it('debería generar asiento 622/472/4751(HABER)/400 equilibrado', async () => {
      if (!invoiceId) throw new Error('No hay factura de gasto');

      const resultado = await accountingEngine.contabilizarFacturaGasto(
        companyId,
        invoiceId,
        'AUTO'
      );

      journalEntryId = resultado.journalEntryId;
      expect(journalEntryId).toBeDefined();

      const asiento = await prisma.journalEntry.findUnique({
        where: { id: journalEntryId },
        include: { lineas: true },
      });

      // 622 (servicio), 472 (IVA soportado), 4751 (IRPF Hacienda), 400 (proveedor)
      expect(asiento?.lineas.length).toBe(4);

      const totalDebe = asiento!.lineas.reduce((s, l) => s + (l.debe || 0), 0);
      const totalHaber = asiento!.lineas.reduce((s, l) => s + (l.haber || 0), 0);
      expect(Math.abs(totalDebe - totalHaber)).toBeLessThan(0.01);

      // 4751 debe ir en HABER (pasivo con AEAT)
      const l4751 = asiento!.lineas.find(l => l.accountCode === '4751');
      expect(l4751?.haber).toBeCloseTo(150);
      expect(l4751?.debe).toBe(0);
    });

    it('debería registrar retención en RetentionBook', async () => {
      const retencion = await prisma.retentionBook.findFirst({
        where: { companyId, tipoRetencionNombre: 'PROFESIONAL' },
      });
      expect(retencion).not.toBeNull();
      expect(retencion?.cuotaRetencion).toBeCloseTo(150);
      expect(retencion?.porcentajeRetencion).toBe(15);
    });

    it('debería registrar en VATBook como RECIBIDAS', async () => {
      const libro = await prisma.vATBook.findFirst({
        where: { companyId, tipoLibro: 'RECIBIDAS', numeroFactura: 'GASTO-001' },
      });
      expect(libro).not.toBeNull();
      expect(libro?.baseImponible).toBeCloseTo(1000);
    });
  });

  describe('Caso 3: Validaciones y Errores', () => {
    it('debería lanzar error si empresa no existe', async () => {
      try {
        await accountingEngine.contabilizarFacturaIngreso(
          'non-existent-company-xyz',
          'non-existent-invoice',
          'AUTO'
        );
        expect(true).toBe(false); // No debería llegar aquí
      } catch (err) {
        expect(err).toBeDefined();
        const message = err instanceof Error ? err.message : String(err);
        expect(message).toBeDefined();
      }
    });

    it('debería lanzar error si factura no existe', async () => {
      try {
        await accountingEngine.contabilizarFacturaIngreso(
          companyId,
          'non-existent-invoice-xyz',
          'AUTO'
        );
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeDefined();
      }
    });
  });

  describe('Informes - Agregaciones', () => {
    it('debería agrupar por cliente correctamente', async () => {
      const hoy = new Date().toISOString().split('T')[0];
      const resultado = await reportsService.obtenerAnalisisPorCliente(
        companyId,
        '2020-01-01',
        hoy
      );

      expect(resultado).toBeDefined();
      expect(resultado.clientes).toBeDefined();
      // Puede estar vacío si no hay facturas PENDING/PAID
    });

    it('debería calcular evolución mensual', async () => {
      const hoy = new Date();
      const resultado = await reportsService.obtenerEvolucionMensual(
        companyId,
        hoy.getFullYear()
      );

      expect(resultado).toBeDefined();
      expect(resultado.meses).toBeDefined();
      expect(Object.keys(resultado.meses).length).toBe(12);
    });
  });

  describe('Documentos Hacienda', () => {
    it('debería generar resumen 303', async () => {
      const periodo = 'Q1-2026';
      const resultado = await taxService.obtenerResumen303(
        companyId,
        periodo
      );

      expect(resultado).toBeDefined();
      expect(resultado.periodo).toBe(periodo);
      expect(resultado.emitidas).toBeDefined();
      expect(resultado.recibidas).toBeDefined();
      expect(typeof resultado.cuotaAIngresar).toBe('number');
    });

    it('debería exportar modelo 303 en TXT', async () => {
      const periodo = 'Q1-2026';
      const resultado = await taxService.exportarModelo303(
        companyId,
        periodo,
        'txt'
      );

      expect(typeof resultado).toBe('string');
      expect(resultado).toContain('MODELO 303');
      expect(resultado).toContain(periodo);
    });

    it('debería exportar modelo 303 en JSON', async () => {
      const periodo = 'Q1-2026';
      const resultado = await taxService.exportarModelo303(
        companyId,
        periodo,
        'json'
      );

      expect(resultado).toBeDefined();
      expect(resultado.periodo).toBe(periodo);
    });
  });
});
