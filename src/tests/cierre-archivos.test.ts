// Subida de archivos de cierre contable.
//
// Regresiones:
// - Se escribia con fs en process.cwd()/storage: en Vercel (solo lectura) falla.
// - El nombre venia del cliente (?nombre=) y entraba sin limpiar en la ruta:
//   "../../../x" podia escribir fuera de la carpeta prevista.
const creados: Array<Record<string, unknown>> = [];
jest.mock('../config/database', () => ({
  prisma: {
    accountingClosure: { findFirst: jest.fn(async () => ({ id: 'cierre-1' })) },
    accountingClosureFile: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        creados.push(data);
        return { id: 'f1', ...data };
      }),
    },
  },
}));
const putObject = jest.fn(async (key: string) => `ref://${key}`);
jest.mock('../utils/storage', () => ({ putObject: (...a: unknown[]) => putObject(...(a as [string])) }));

import { subirArchivoCierre, nombreSeguro } from '../services/accounting-closure.service';

beforeEach(() => {
  creados.length = 0;
  putObject.mockClear();
});

describe('nombreSeguro', () => {
  it('quita rutas y caracteres peligrosos', () => {
    expect(nombreSeguro('../../../etc/passwd')).toBe('passwd');
    expect(nombreSeguro('..\\..\\windows\\win.ini')).toBe('win.ini');
    expect(nombreSeguro('Balance 2025 (final).pdf')).toBe('Balance_2025__final_.pdf');
    expect(nombreSeguro('')).toBe('archivo');
  });
});

describe('subirArchivoCierre', () => {
  it('guarda con putObject, en una ruta por empresa y con nombre limpio', async () => {
    await subirArchivoCierre(
      'empresa-1',
      2025,
      { buffer: Buffer.from('pdf'), originalname: '../../../evil.pdf', mimetype: 'application/pdf' },
      'BALANCE_GENERAL',
    );

    expect(putObject).toHaveBeenCalledTimes(1);
    const [key] = putObject.mock.calls[0];
    expect(key).toMatch(/^accounting-closures\/empresa-1\/2025\/[0-9a-f-]+-evil\.pdf$/);
    expect(key).not.toContain('..');
    expect(creados[0]).toMatchObject({ storagePath: `ref://${key}`, nombre: 'evil.pdf', tipoArchivo: 'PDF' });
  });
});

// El archivo documental tenia el mismo fallo: nombre del cliente sin limpiar y
// la clave construida con path.join (barras invertidas en Windows).
describe('crearDocumentoArchivo', () => {
  it('limpia el nombre y usa "/" en la clave', async () => {
    const { prisma } = jest.requireMock('../config/database') as { prisma: Record<string, unknown> };
    prisma.documentoArchivo = { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'd1', createdAt: new Date(), ...data })) };
    const { crearDocumentoArchivo } = await import('../services/documentoArchivo.service');

    await crearDocumentoArchivo('empresa-1', {
      tipo: 'gasto',
      fecha: '2026-03-15',
      numeroFactura: 'F/2026/../../001',
      emisor: '..\\..\\Proveedor',
      archivoNombre: '..\\..\\..\\factura proveedor.pdf',
      archivoTipo: 'application/pdf',
      archivoBuffer: Buffer.from('pdf'),
    }).catch(() => undefined); // solo interesa la clave usada al guardar

    const [key] = putObject.mock.calls[0];
    // Va a la carpeta del trimestre de su fecha, con un nombre sin rutas.
    expect(key).toMatch(/^archivo\/empresa-1\/2026\/1T\/gastos\/2026-03-15_F-2026-\.\.-\.\.-001_\.\.-\.\.-Proveedor\.pdf$/);
    expect(key.split('/')).toHaveLength(6);
    expect(key.split('/')).not.toContain('..');
    expect(key).not.toContain('\\');
  });
});
