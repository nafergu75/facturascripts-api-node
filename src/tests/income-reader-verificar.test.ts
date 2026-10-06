// income-reader: verificar un documento crea la factura de ingreso.
//
// Regresiones:
// - El cliente se tomaba del EMISOR. En una factura de ingreso el emisor es la
//   propia empresa: se daba de alta a si misma como cliente.
// - El numero de factura era Math.random(): sin correlatividad y repetible.
const creados: Array<Record<string, unknown>> = [];
jest.mock('../config/database', () => ({
  prisma: {
    incomeReaderDocument: {
      findFirst: jest.fn(async () => ({
        id: 'doc-1',
        companyId: 'c1',
        status: 'READY_FOR_VERIFICATION',
        expiresAt: null,
        originalFileName: 'f.pdf',
        parsedData: {
          numero: 'F-2025-0007',
          fecha: '2025-09-15',
          nifEmisor: 'B11111111',
          nombreEmisor: 'Mi Empresa SL',
          nifReceptor: 'B22222222',
          nombreReceptor: 'Cliente SL',
          lineas: [{ descripcion: 'Servicio', cantidad: 1, precioUnitario: 100, tipoIva: 21 }],
        },
      })),
      update: jest.fn(async () => ({})),
    },
    customer: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        creados.push(data);
        return { id: 'cli-1', ...data };
      }),
    },
  },
}));
const crearIngreso = jest.fn(async (_dto: unknown) => ({ id: 'fac-1' }));
jest.mock('../services/income-invoices.service', () => ({ incomeInvoicesService: { crearIngreso: (d: never) => crearIngreso(d) } }));

import { incomeReaderService } from '../services/income-reader.service';

describe('income-reader: verificar y crear factura', () => {
  it('el cliente es el receptor y se conserva el numero leido', async () => {
    // obtenerDetalle al final puede fallar con el doble de BD: solo interesa lo creado antes.
    await incomeReaderService.verificarYCrearFactura('c1', 'doc-1').catch(() => undefined);

    expect(creados[0]).toMatchObject({ nifCif: 'B22222222', nombreFiscal: 'Cliente SL' });
    expect(crearIngreso).toHaveBeenCalledWith(expect.objectContaining({ customer: { id: 'cli-1' }, serie: 'F-2025', numero: 7 }));
  });
});
