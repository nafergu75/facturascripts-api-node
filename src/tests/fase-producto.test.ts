// El esbozo antiguo de huellas de Veri*Factu (verifactu.service.ts) se retiro:
// lo sustituye services/verifactu/ (spec verifactu, P12).
import { crearCuentaBancaria, importarMovimientosDesdeCSV } from '../services/bancos.service';
import { sugerirSubcuentaParaTercero } from '../services/sugerenciasContables.service';

describe('Bancos (importacion CSV)', () => {
  it('parsea movimientos de un CSV simple', async () => {
    const cuenta = await crearCuentaBancaria('cB', { iban: 'ES00', subcuentaCodigo: '5720000000', activa: true });
    const csv = 'fecha;importe;concepto;referencia\n2026-06-10;363;Cobro factura;REF1\n2026-06-11;-50;Comision;REF2';
    const movs = await importarMovimientosDesdeCSV('cB', cuenta.id, csv);
    expect(movs).toHaveLength(2);
    expect(movs[0].importe).toBe(363);
    expect(movs[1].importe).toBe(-50);
    expect(movs[0].origen).toBe('csv');
  });
});

describe('Sugerencias contables', () => {
  // La que recibira al darlo de alta: la primera libre con la longitud de la empresa (8 sin plan previo).
  it('propone subcuenta de cliente sobre la cuenta base 430', async () => {
    const s = await sugerirSubcuentaParaTercero(`cSug-${Date.now()}`, { tipo: 'cliente', nombre: 'Cliente Nuevo', nif: 'B9' });
    expect(s.cuentaBaseCodigo).toBe('430');
    expect(s.codigoPropuesto).toBe('43000001');
  });
  it('propone subcuenta de proveedor sobre la 400', async () => {
    const s = await sugerirSubcuentaParaTercero(`cSug2-${Date.now()}`, { tipo: 'proveedor', nombre: 'Prov Nuevo', nif: 'B8' });
    expect(s.cuentaBaseCodigo).toBe('400');
    expect(s.codigoPropuesto).toBe('40000001');
  });
});
