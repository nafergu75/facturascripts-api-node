import { calcularHashFactura, generarCadenaOriginalFactura, registrarHuellaFactura } from '../services/verifactu.service';
import { crearCuentaBancaria, importarMovimientosDesdeCSV } from '../services/bancos.service';
import { sugerirSubcuentaParaTercero } from '../services/sugerenciasContables.service';

describe('Veri*Factu (huellas)', () => {
  it('hash SHA-256 determinista (64 hex)', () => {
    const cadena = generarCadenaOriginalFactura({ cifnif: 'B1', codigo: 'F1', fecha: '2026-06-10', total: 121 });
    const h1 = calcularHashFactura(cadena);
    const h2 = calcularHashFactura(cadena);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('encadena la huella con la anterior (inalterabilidad)', async () => {
    const empresa = 'cVF';
    const h1 = await registrarHuellaFactura(empresa, { idfactura: 1, codigo: 'F1', cifnif: 'B1', fecha: '2026-06-10', total: 100 });
    const h2 = await registrarHuellaFactura(empresa, { idfactura: 2, codigo: 'F2', cifnif: 'B1', fecha: '2026-06-11', total: 200 });
    expect(h2.hashAnterior).toBe(h1.hash);
    expect(h1.algoritmo).toBe('SHA256');
  });
});

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
  it('propone subcuenta de cliente sobre la cuenta base 430', async () => {
    const s = await sugerirSubcuentaParaTercero('cSug', { tipo: 'cliente', nombre: 'Cliente Nuevo', nif: 'B9' });
    expect(s.cuentaBaseCodigo).toBe('430');
    expect(s.codigoPropuesto).toBe('4300000001');
  });
  it('propone subcuenta de proveedor sobre la 400', async () => {
    const s = await sugerirSubcuentaParaTercero('cSug2', { tipo: 'proveedor', nombre: 'Prov Nuevo', nif: 'B8' });
    expect(s.cuentaBaseCodigo).toBe('400');
    expect(s.codigoPropuesto).toBe('4000000001');
  });
});
