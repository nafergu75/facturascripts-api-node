// Arreglos previos a VERI*FACTU en el lector de ventas (spec verifactu, apartado 8):
// - P4: sin numero leido no se registra (antes la app numeraba la factura en
//   una serie del año y gastaba numeros de sus series).
// - P6: sin fecha leida, la fecha es la de hoy en Madrid, no la del dia UTC.
let parsedData: Record<string, unknown> = {};
jest.mock('../config/database', () => ({
  prisma: {
    incomeReaderDocument: {
      findFirst: jest.fn(async () => ({
        id: 'doc-1',
        companyId: 'c1',
        status: 'READY_FOR_VERIFICATION',
        expiresAt: null,
        originalFileName: 'f.pdf',
        parsedData,
      })),
      update: jest.fn(async () => ({})),
    },
    customer: {
      findFirst: jest.fn(async () => ({ id: 'cli-1' })),
      create: jest.fn(),
    },
  },
}));
const crearIngreso = jest.fn(async (_dto: unknown, _op?: unknown) => ({ id: 'fac-1' }));
jest.mock('../services/income-invoices.service', () => ({
  incomeInvoicesService: { crearIngreso: (d: never, o: never) => crearIngreso(d, o) },
}));

import { incomeReaderService } from '../services/income-reader.service';

const base = {
  nifReceptor: 'B22222222',
  nombreReceptor: 'Cliente SL',
  lineas: [{ descripcion: 'Servicio', cantidad: 1, precioUnitario: 100, tipoIva: 21 }],
};

beforeEach(() => crearIngreso.mockClear());
afterEach(() => jest.useRealTimers());

describe('P4: el lector no deja que la app numere', () => {
  it('sin número leído: 400 y no se crea la factura', async () => {
    parsedData = { ...base, fecha: '2026-09-15' };
    await expect(incomeReaderService.verificarYCrearFactura('c1', 'doc-1')).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/Falta el número/),
    });
    expect(crearIngreso).not.toHaveBeenCalled();
  });

  it('con número: serie y número leídos, origen lector', async () => {
    parsedData = { ...base, fecha: '2026-09-15', numero: 'F-2026-0007' };
    await incomeReaderService.verificarYCrearFactura('c1', 'doc-1').catch(() => undefined);
    expect(crearIngreso).toHaveBeenCalledWith(expect.objectContaining({ serie: 'F-2026', numero: 7 }), { origen: 'lector', numeroLeido: 'F-2026-0007' });
  });
});

describe('P6: fecha por defecto en hora de Madrid', () => {
  it('a las 00:30 del 1-1-2027 en Madrid (23:30 UTC del 31-12) la fecha es 2027-01-01', async () => {
    jest.useFakeTimers({ now: new Date('2026-12-31T23:30:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
    parsedData = { ...base, numero: '15' };
    await incomeReaderService.verificarYCrearFactura('c1', 'doc-1').catch(() => undefined);
    // Sin prefijo, la serie es el año de la fecha.
    expect(crearIngreso).toHaveBeenCalledWith(expect.objectContaining({ fechaEmision: '2027-01-01', serie: '2027', numero: 15 }), {
      origen: 'lector',
      numeroLeido: '15',
    });
  });
});
