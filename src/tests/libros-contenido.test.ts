jest.mock('../config/database', () => ({ prisma: {} }));
jest.mock('../services/cuentasAnuales.service', () => ({
  generarLibroDiario: jest.fn(),
  generarLibroInventarios: jest.fn(),
  generarCuentasAnuales: jest.fn(),
}));

import { contenidoLibro } from '../services/booksService';
import { generarLibroDiario, generarLibroInventarios, generarCuentasAnuales } from '../services/cuentasAnuales.service';

const fy = { companyId: '1', label: '2026', closingDate: '2026-12-31', fechaFin: '2026-12-31' };

describe('booksService.contenidoLibro (contenido real)', () => {
  afterEach(() => jest.clearAllMocks());

  it('DIARIO: vuelca asientos, apuntes y totales reales', async () => {
    (generarLibroDiario as jest.Mock).mockResolvedValue({
      ejercicio: 2026,
      asientos: [
        {
          numero: 1,
          fecha: '2026-03-01',
          concepto: 'Venta F2026A1',
          lineas: [
            { subcuenta: '4300000000', debe: 363, haber: 0 },
            { subcuenta: '7000000000', debe: 0, haber: 300 },
            { subcuenta: '4770000000', debe: 0, haber: 63 },
          ],
        },
      ],
      totalDebe: 363,
      totalHaber: 363,
    });

    const txt = (await contenidoLibro('DIARIO', fy)).join('\n');
    expect(txt).toContain('Ejercicio: 2026');
    expect(txt).toContain('Asiento 1');
    expect(txt).toContain('Venta F2026A1');
    expect(txt).toContain('4300000000');
    expect(txt).toContain('TOTALES');
    expect(txt).toContain('363,00');
    expect(generarLibroDiario).toHaveBeenCalledWith('1', 2026);
  });

  it('DIARIO sin asientos: nota explícita, no rompe', async () => {
    (generarLibroDiario as jest.Mock).mockResolvedValue({ ejercicio: 2026, asientos: [], totalDebe: 0, totalHaber: 0 });
    const txt = (await contenidoLibro('DIARIO', fy)).join('\n');
    expect(txt).toContain('Sin asientos contabilizados');
  });

  it('INVENTARIOS_CUENTAS_ANUALES: balances + resumen de cuentas anuales', async () => {
    (generarLibroInventarios as jest.Mock).mockResolvedValue({
      ejercicio: 2026,
      balanceApertura: [],
      balanceCierre: [{ codigo: '5720000000', descripcion: 'Subcuenta 5720000000', importe: 1500 }],
    });
    (generarCuentasAnuales as jest.Mock).mockResolvedValue({
      sociedad: { denominacion: 'ACME SL', nif: 'B12345678' },
      aplicacionResultado: { resultadoEjercicio: 600, aReservas: 600, aDividendos: 0 },
    });

    const txt = (await contenidoLibro('INVENTARIOS_CUENTAS_ANUALES', fy)).join('\n');
    expect(txt).toContain('BALANCE DE CIERRE');
    expect(txt).toContain('5720000000');
    expect(txt).toContain('ACME SL');
    expect(txt).toContain('Resultado del ejercicio: 600,00');
  });

  it('libro societario (ACTAS): libro válido con nota de "sin módulo de datos"', async () => {
    const txt = (await contenidoLibro('ACTAS', fy)).join('\n');
    expect(txt).toContain('no tiene un módulo de datos integrado');
    expect(generarLibroDiario).not.toHaveBeenCalled();
  });

  it('degrada a cabecera + motivo si la carga de datos falla (no aborta)', async () => {
    (generarLibroDiario as jest.Mock).mockRejectedValue(new Error('BD no disponible'));
    const txt = (await contenidoLibro('DIARIO', fy)).join('\n');
    expect(txt).toContain('No se pudo cargar el contenido del libro');
    expect(txt).toContain('BD no disponible');
  });
});
