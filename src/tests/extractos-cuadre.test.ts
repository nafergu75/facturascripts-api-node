import { exportarExtractoCSV } from '../services/extractos.service';
import { ExtractoBancario } from '../domain/extractos.model';
import { obtenerCierreConfig, actualizarCierreConfig } from '../services/cierreConfig.service';

describe('Extractos bancarios - export CSV', () => {
  const extracto: ExtractoBancario = {
    cuentaBancariaId: 'c1',
    iban: 'ES1234',
    subcuentaCodigo: '572000',
    saldoInicial: 100,
    saldoFinal: 150,
    totalCargos: 50,
    totalAbonos: 100,
    numMovimientos: 2,
    lineas: [
      { fecha: '2026-01-05', concepto: 'Cobro cliente', cargo: 0, abono: 100, importe: 100, saldoAcumulado: 200, conciliado: true },
      { fecha: '2026-01-10', concepto: 'Pago; proveedor', cargo: 50, abono: 0, importe: -50, saldoAcumulado: 150, conciliado: false },
    ],
  };

  it('genera cabecera + filas con saldo acumulado', () => {
    const csv = exportarExtractoCSV(extracto);
    const lineas = csv.trim().split('\r\n');
    expect(lineas[0]).toBe('fecha;concepto;referencia;cargo;abono;saldo');
    expect(lineas).toHaveLength(3);
    expect(lineas[1]).toContain('2026-01-05;Cobro cliente;;0.00;100.00;200.00');
  });

  it('escapa separadores con comillas', () => {
    const csv = exportarExtractoCSV(extracto);
    expect(csv).toContain('"Pago; proveedor"');
  });
});

describe('Configuracion de cierre por empresa', () => {
  it('por defecto exige cuadre de bancos', async () => {
    const cfg = await obtenerCierreConfig('empresa-nueva-x-test');
    expect(cfg.exigirCuadreBancos).toBe(true);
    expect(cfg.toleranciaCuadre).toBe(0.01);
  });

  it('permite actualizar y persiste en BD', async () => {
    await actualizarCierreConfig('empresa-y-test', { exigirCuadreBancos: false, toleranciaCuadre: 1 });
    const cfg = await obtenerCierreConfig('empresa-y-test');
    expect(cfg.exigirCuadreBancos).toBe(false);
    expect(cfg.toleranciaCuadre).toBe(1);
  });
});
