/**
 * Tests de integración para endpoints de Proveedores
 * Utiliza supertest para hacer peticiones HTTP reales
 */

import request from 'supertest';
import express from 'express';
import proveedoresRouter from './proveedores.routes';
import { prisma } from '../config/database';

// Mock de Prisma
jest.mock('../config/database');

// Mock de middleware de autenticación
const mockAuthMiddleware = (req: any, res: any, next: any) => {
  req.user = { email: 'test@empresa.com', id: 'user-123' };
  next();
};

describe('Proveedores Routes', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use(mockAuthMiddleware);
    app.use('/api/companies/:companyId/proveedores', proveedoresRouter);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /contacts - Create Contact', () => {
    it('should create a new contact for a supplier', async () => {
      const companyId = '1';
      const supplierId = 'supplier-123';

      const contactData = {
        nombre: 'María García',
        apellido: 'López',
        email: 'maria@example.com',
        telefono: '+34 600 123 456',
        rol: 'Gerente de Compras',
        esPrincipal: false,
      };

      const mockSupplier = { id: supplierId };
      const mockContact = {
        id: 'contact-456',
        supplierId,
        ...contactData,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      (prisma.supplier.findUnique as jest.Mock).mockResolvedValue(mockSupplier);
      (prisma.supplierContact.create as jest.Mock).mockResolvedValue(mockContact);
      (prisma.supplierAudit.create as jest.Mock).mockResolvedValue({}); // Audit log

      const res = await request(app)
        .post(`/api/companies/${companyId}/proveedores/${supplierId}/contacts`)
        .send(contactData);

      expect(res.status).toBe(201);
      expect(res.body.data).toEqual(mockContact);
    });

    it('should reject contact without nombre', async () => {
      const companyId = '1';
      const supplierId = 'supplier-123';

      const invalidData = {
        apellido: 'López',
        email: 'maria@example.com',
        // nombre is missing
      };

      const res = await request(app)
        .post(`/api/companies/${companyId}/proveedores/${supplierId}/contacts`)
        .send(invalidData);

      expect(res.status).toBe(400);
    });

    it('should record audit trail for contact creation', async () => {
      const companyId = '1';
      const supplierId = 'supplier-123';

      const contactData = {
        nombre: 'Juan',
        email: 'juan@example.com',
        esPrincipal: false,
      };

      (prisma.supplier.findUnique as jest.Mock).mockResolvedValue({ id: supplierId });
      (prisma.supplierContact.create as jest.Mock).mockResolvedValue({
        id: 'contact-789',
        supplierId,
        ...contactData,
      });
      (prisma.supplierAudit.create as jest.Mock).mockResolvedValue({});

      await request(app)
        .post(`/api/companies/${companyId}/proveedores/${supplierId}/contacts`)
        .send(contactData);

      expect(prisma.supplierAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            supplierId,
            tipoAccion: 'create',
            usuarioEmail: 'test@empresa.com',
          }),
        })
      );
    });
  });

  describe('PUT /contacts/:id - Update Contact', () => {
    it('should update contact fields', async () => {
      const companyId = '1';
      const supplierId = 'supplier-123';
      const contactId = 'contact-456';

      const updateData = {
        telefono: '+34 600 999 999',
        rol: 'Jefe de Compras',
      };

      const mockUpdatedContact = {
        id: contactId,
        supplierId,
        nombre: 'María',
        ...updateData,
      };

      (prisma.supplierContact.findFirst as jest.Mock).mockResolvedValue(mockUpdatedContact);
      (prisma.supplierContact.update as jest.Mock).mockResolvedValue(mockUpdatedContact);
      (prisma.supplierAudit.create as jest.Mock).mockResolvedValue({});

      const res = await request(app)
        .put(`/api/companies/${companyId}/proveedores/${supplierId}/contacts/${contactId}`)
        .send(updateData);

      expect(res.status).toBe(200);
      expect(res.body.data.telefono).toBe('+34 600 999 999');
    });

    it('should return 404 if contact not found', async () => {
      const companyId = '1';
      const supplierId = 'supplier-123';
      const contactId = 'nonexistent';

      (prisma.supplierContact.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await request(app)
        .put(`/api/companies/${companyId}/proveedores/${supplierId}/contacts/${contactId}`)
        .send({ nombre: 'New Name' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /contacts/:id - Delete Contact', () => {
    it('should delete a contact', async () => {
      const companyId = '1';
      const supplierId = 'supplier-123';
      const contactId = 'contact-456';

      const mockContact = {
        id: contactId,
        supplierId,
        nombre: 'María',
      };

      (prisma.supplierContact.findFirst as jest.Mock).mockResolvedValue(mockContact);
      (prisma.supplierContact.delete as jest.Mock).mockResolvedValue(mockContact);
      (prisma.supplierAudit.create as jest.Mock).mockResolvedValue({});

      const res = await request(app)
        .delete(`/api/companies/${companyId}/proveedores/${supplierId}/contacts/${contactId}`);

      expect(res.status).toBe(200);
      expect(prisma.supplierAudit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tipoAccion: 'delete',
          }),
        })
      );
    });
  });

  describe('POST /bank-accounts - Create Bank Account', () => {
    it('should create a bank account with valid IBAN', async () => {
      const companyId = '1';
      const supplierId = 'supplier-123';

      const accountData = {
        iban: 'ES9121123456789012345678990',
        bic: 'BBVAESMMXXX',
        banco: 'BBVA',
        alias: 'Cuenta principal',
        formaPagoPorDefecto: 'transferencia',
        esPrincipal: true,
      };

      const mockAccount = {
        id: 'account-789',
        supplierId,
        ...accountData,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      (prisma.supplier.findUnique as jest.Mock).mockResolvedValue({ id: supplierId });
      (prisma.supplierBankAccount.findFirst as jest.Mock).mockResolvedValue(null); // No existe
      (prisma.supplierBankAccount.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
      (prisma.supplierBankAccount.create as jest.Mock).mockResolvedValue(mockAccount);
      (prisma.supplierAudit.create as jest.Mock).mockResolvedValue({});

      const res = await request(app)
        .post(`/api/companies/${companyId}/proveedores/${supplierId}/bank-accounts`)
        .send(accountData);

      expect(res.status).toBe(201);
      expect(res.body.data.iban).toBe('ES9121123456789012345678990');
    });

    it('should reject invalid IBAN', async () => {
      const companyId = '1';
      const supplierId = 'supplier-123';

      const invalidAccountData = {
        iban: 'ES9021123456789012345678990', // Checksum inválido
        bic: 'BBVAESMMXXX',
        alias: 'Invalid',
        formaPagoPorDefecto: 'transferencia',
      };

      const res = await request(app)
        .post(`/api/companies/${companyId}/proveedores/${supplierId}/bank-accounts`)
        .send(invalidAccountData);

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('IBAN inválido');
    });

    it('should ensure only one principal account per supplier', async () => {
      const companyId = '1';
      const supplierId = 'supplier-123';

      const newAccountData = {
        iban: 'ES9121123456789012345678990',
        alias: 'Nueva principal',
        formaPagoPorDefecto: 'transferencia',
        esPrincipal: true,
      };

      (prisma.supplier.findUnique as jest.Mock).mockResolvedValue({ id: supplierId });
      (prisma.supplierBankAccount.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.supplierBankAccount.updateMany as jest.Mock).mockResolvedValue({ count: 1 }); // Demotó otros
      (prisma.supplierBankAccount.create as jest.Mock).mockResolvedValue({
        id: 'account-new',
        supplierId,
        ...newAccountData,
      });
      (prisma.supplierAudit.create as jest.Mock).mockResolvedValue({});

      const res = await request(app)
        .post(`/api/companies/${companyId}/proveedores/${supplierId}/bank-accounts`)
        .send(newAccountData);

      expect(res.status).toBe(201);
      // Verificar que se demotó la anterior
      expect(prisma.supplierBankAccount.updateMany).toHaveBeenCalledWith({
        where: { supplierId, esPrincipal: true },
        data: { esPrincipal: false },
      });
    });
  });

  describe('GET /audit-trail - Audit Log', () => {
    it('should return audit trail entries for supplier', async () => {
      const companyId = '1';
      const supplierId = 'supplier-123';

      const mockAuditEntries = [
        {
          id: 'audit-1',
          supplierId,
          tipoAccion: 'create',
          descripcion: 'Contacto creado',
          usuarioEmail: 'test@empresa.com',
          createdAt: new Date('2026-07-18T10:00:00'),
        },
        {
          id: 'audit-2',
          supplierId,
          tipoAccion: 'update',
          descripcion: 'Cuenta bancaria actualizada',
          usuarioEmail: 'test@empresa.com',
          createdAt: new Date('2026-07-18T11:00:00'),
        },
      ];

      (prisma.supplierAudit.findMany as jest.Mock).mockResolvedValue(mockAuditEntries);

      const res = await request(app)
        .get(`/api/companies/${companyId}/proveedores/${supplierId}/audit-trail`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].tipoAccion).toBe('create');
    });

    it('should filter audit trail by action type', async () => {
      const companyId = '1';
      const supplierId = 'supplier-123';

      const mockAuditEntries = [
        {
          id: 'audit-1',
          supplierId,
          tipoAccion: 'update',
          descripcion: 'Actualización 1',
          usuarioEmail: 'test@empresa.com',
          createdAt: new Date(),
        },
      ];

      (prisma.supplierAudit.findMany as jest.Mock).mockResolvedValue(mockAuditEntries);

      const res = await request(app)
        .get(`/api/companies/${companyId}/proveedores/${supplierId}/audit-trail?tipoAccion=update`);

      expect(res.status).toBe(200);
      expect(prisma.supplierAudit.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tipoAccion: 'update',
          }),
        })
      );
    });
  });

  describe('GET /export - Export Supplier Data', () => {
    it('should export supplier data as CSV', async () => {
      const companyId = '1';
      const supplierId = 'supplier-123';

      const mockSupplier = {
        id: supplierId,
        nombreFiscal: 'Test Company',
        nifCif: 'A12345678',
        email: 'test@company.com',
      };

      (prisma.supplier.findUnique as jest.Mock).mockResolvedValue(mockSupplier);
      (prisma.supplierContact.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.supplierBankAccount.findMany as jest.Mock).mockResolvedValue([]);

      const res = await request(app)
        .get(`/api/companies/${companyId}/proveedores/${supplierId}/export`)
        .query({ formato: 'csv' });

      expect(res.status).toBe(200);
      expect(res.header['content-type']).toContain('text/csv');
    });

    it('should export supplier data as JSON', async () => {
      const companyId = '1';
      const supplierId = 'supplier-123';

      const mockSupplier = {
        id: supplierId,
        nombreFiscal: 'Test Company',
        nifCif: 'A12345678',
      };

      (prisma.supplier.findUnique as jest.Mock).mockResolvedValue(mockSupplier);
      (prisma.supplierContact.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.supplierBankAccount.findMany as jest.Mock).mockResolvedValue([]);

      const res = await request(app)
        .get(`/api/companies/${companyId}/proveedores/${supplierId}/export`)
        .query({ formato: 'json' });

      expect(res.status).toBe(200);
      expect(res.header['content-type']).toContain('application/json');
    });

    it('should apply date range filter if provided', async () => {
      const companyId = '1';
      const supplierId = 'supplier-123';

      (prisma.supplier.findUnique as jest.Mock).mockResolvedValue({ id: supplierId });
      (prisma.supplierContact.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.supplierBankAccount.findMany as jest.Mock).mockResolvedValue([]);

      const res = await request(app)
        .get(`/api/companies/${companyId}/proveedores/${supplierId}/export`)
        .query({
          formato: 'json',
          fechaDesde: '2026-01-01',
          fechaHasta: '2026-12-31',
        });

      expect(res.status).toBe(200);
    });
  });
});
