/**
 * Tests para SupplierContact Service
 * Cubre CRUD de contactos de proveedores
 */

import {
  createContact,
  updateContact,
  deleteContact,
  listContactsBySupplier,
} from './supplierContact.service';
import { prisma } from '../../config/database';

// Mock de Prisma
jest.mock('../../config/database');

describe('SupplierContact Service', () => {
  const mockSupplierId = 'supplier-123';
  const mockContactId = 'contact-456';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createContact', () => {
    it('should create a contact with required fields', async () => {
      const inputData = {
        nombre: 'Juan García',
        apellido: 'López',
        email: 'juan@example.com',
        telefono: '+34 600 123 456',
        rol: 'Gerente',
        esPrincipal: false,
      };

      const mockCreatedContact = {
        id: mockContactId,
        supplierId: mockSupplierId,
        ...inputData,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      (prisma.supplier.findUnique as jest.Mock).mockResolvedValue({ id: mockSupplierId });
      (prisma.supplierContact.create as jest.Mock).mockResolvedValue(mockCreatedContact);

      const result = await createContact(mockSupplierId, inputData);

      expect(result).toEqual(mockCreatedContact);
      expect(prisma.supplierContact.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          nombre: 'Juan García',
          supplierId: mockSupplierId,
        }),
      });
    });

    it('should throw error if nombre is empty', async () => {
      const invalidData = {
        nombre: '',
        apellido: 'López',
        email: 'juan@example.com',
        telefono: undefined,
        rol: 'Contacto',
        esPrincipal: false,
      };

      (prisma.supplier.findUnique as jest.Mock).mockResolvedValue({ id: mockSupplierId });

      await expect(createContact(mockSupplierId, invalidData)).rejects.toThrow();
    });

    it('should auto-demote previous principal when creating new principal', async () => {
      const inputData = {
        nombre: 'María',
        apellido: 'García',
        email: 'maria@example.com',
        telefono: '+34 600 987 654',
        rol: 'Jefa',
        esPrincipal: true,
      };

      (prisma.supplier.findUnique as jest.Mock).mockResolvedValue({ id: mockSupplierId });
      (prisma.supplierContact.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.supplierContact.create as jest.Mock).mockResolvedValue({
        id: mockContactId,
        supplierId: mockSupplierId,
        ...inputData,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await createContact(mockSupplierId, inputData);

      expect(prisma.supplierContact.updateMany).toHaveBeenCalledWith({
        where: {
          supplierId: mockSupplierId,
          esPrincipal: true,
        },
        data: { esPrincipal: false },
      });
    });

    it('should throw error if supplier does not exist', async () => {
      const inputData = {
        nombre: 'Juan',
        apellido: 'García',
        email: 'juan@example.com',
        telefono: undefined,
        rol: 'Contacto',
        esPrincipal: false,
      };

      (prisma.supplier.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(createContact(mockSupplierId, inputData)).rejects.toThrow('Proveedor no encontrado');
    });
  });

  describe('updateContact', () => {
    it('should update contact with partial data', async () => {
      const existingContact = {
        id: mockContactId,
        supplierId: mockSupplierId,
        nombre: 'Juan',
        apellido: 'García',
        email: 'juan@old.com',
        telefono: '+34 600 111 111',
        rol: 'Contacto',
        esPrincipal: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const updateData = {
        nombre: 'Juan',
        email: 'juan@new.com',
        telefono: '+34 600 222 222',
      };

      (prisma.supplierContact.findFirst as jest.Mock).mockResolvedValue(existingContact);
      (prisma.supplierContact.update as jest.Mock).mockResolvedValue({
        ...existingContact,
        ...updateData,
      });

      const result = await updateContact(mockSupplierId, mockContactId, updateData);

      expect(result.email).toBe('juan@new.com');
      expect(result.telefono).toBe('+34 600 222 222');
    });

    it('should demote other contacts when setting as principal', async () => {
      const existingContact = {
        id: mockContactId,
        supplierId: mockSupplierId,
        nombre: 'Juan',
        esPrincipal: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      (prisma.supplierContact.findFirst as jest.Mock).mockResolvedValue(existingContact);
      (prisma.supplierContact.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.supplierContact.update as jest.Mock).mockResolvedValue({
        ...existingContact,
        esPrincipal: true,
      });

      await updateContact(mockSupplierId, mockContactId, { nombre: 'Juan', esPrincipal: true });

      expect(prisma.supplierContact.updateMany).toHaveBeenCalled();
    });

    it('should throw error if contact not found', async () => {
      (prisma.supplierContact.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        updateContact(mockSupplierId, mockContactId, { nombre: 'Nueva' })
      ).rejects.toThrow('Contacto no encontrado');
    });
  });

  describe('deleteContact', () => {
    it('should delete a contact', async () => {
      const existingContact = {
        id: mockContactId,
        supplierId: mockSupplierId,
        nombre: 'Juan',
      };

      (prisma.supplierContact.findFirst as jest.Mock).mockResolvedValue(existingContact);
      (prisma.supplierContact.delete as jest.Mock).mockResolvedValue(existingContact);

      const result = await deleteContact(mockSupplierId, mockContactId);

      expect(result).toEqual(existingContact);
      expect(prisma.supplierContact.delete).toHaveBeenCalledWith({
        where: { id: mockContactId },
      });
    });

    it('should throw error if contact not found', async () => {
      (prisma.supplierContact.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(deleteContact(mockSupplierId, mockContactId)).rejects.toThrow(
        'Contacto no encontrado'
      );
    });
  });

  describe('listContactsBySupplier', () => {
    it('should return contacts ordered by principal and creation date', async () => {
      const mockContacts = [
        {
          id: 'c1',
          nombre: 'María',
          esPrincipal: true,
          createdAt: new Date('2026-01-15'),
        },
        {
          id: 'c2',
          nombre: 'Juan',
          esPrincipal: false,
          createdAt: new Date('2026-01-10'),
        },
        {
          id: 'c3',
          nombre: 'Pedro',
          esPrincipal: false,
          createdAt: new Date('2026-01-20'),
        },
      ];

      (prisma.supplierContact.findMany as jest.Mock).mockResolvedValue(mockContacts);

      const result = await listContactsBySupplier(mockSupplierId);

      expect(result).toHaveLength(3);
      expect(result[0].esPrincipal).toBe(true); // Principal first
      expect(prisma.supplierContact.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { supplierId: mockSupplierId },
          orderBy: expect.any(Array),
        })
      );
    });

    it('should return empty array if no contacts', async () => {
      (prisma.supplierContact.findMany as jest.Mock).mockResolvedValue([]);

      const result = await listContactsBySupplier(mockSupplierId);

      expect(result).toEqual([]);
    });
  });
});
