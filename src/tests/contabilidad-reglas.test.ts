import {
  generarAsientoVentaDesdeFactura,
  generarAsientoCompraDesdeFactura,
} from '../services/contabilidadReglas.service';
import { reglasPorDefecto } from '../domain/reglas-contables.model';
import { FacturaContable } from '../domain/factura.model';

const reglas = reglasPorDefecto();

describe('Motor contable: asiento de venta', () => {
  // Ejemplo: base 1000 @ 21% (IVA 210) + base 500 @ 10% (IVA 50). Total 1760.
  const factura: FacturaContable = {
    idFactura: 'F2026A1',
    tipo: 'venta',
    codigoTercero: 'C0001',
    fecha: '2026-06-10',
    formaPago: 'CONTADO',
    totalBase: 1500,
    totalIva: 260,
    totalFactura: 1760,
    lineas: [
      { descripcion: 'Servicio A', cantidad: 1, precioUnitario: 1000, tipoIva: 21, baseImponible: 1000, importeIva: 210 },
      { descripcion: 'Servicio B', cantidad: 1, precioUnitario: 500, tipoIva: 10, baseImponible: 500, importeIva: 50 },
    ],
  };

  it('cuadra (debe = haber = total factura)', () => {
    const a = generarAsientoVentaDesdeFactura(factura, reglas);
    expect(a.debeTotal).toBe(1760);
    expect(a.haberTotal).toBe(1760);
    expect(a.debeTotal).toBe(a.haberTotal);
  });

  it('carga al cliente el total y abona ventas + IVA por tipo', () => {
    const a = generarAsientoVentaDesdeFactura(factura, reglas);

    // cliente C0001 -> subcuenta por tercero (430 + digitos del codigo)
    const cliente = a.lineas.find((l) => l.subcuenta === '4300000001');
    expect(cliente?.debe).toBe(1760);

    const ventas = a.lineas.find((l) => l.subcuenta === '700000');
    expect(ventas?.haber).toBe(1500); // 1000 + 500 (misma familia por defecto)

    const iva21 = a.lineas.find((l) => l.subcuenta === '477000');
    const iva10 = a.lineas.find((l) => l.subcuenta === '477001');
    expect(iva21?.haber).toBe(210);
    expect(iva10?.haber).toBe(50);
  });

  it('usa subcuenta de ventas por familia cuando hay mapeo', () => {
    const reglasFam = { ...reglas, cuentasVentasPorFamilia: { SERVICIOS: '705000' } };
    const facturaFam: FacturaContable = {
      ...factura,
      lineas: [{ ...factura.lineas[0], familiaProducto: 'SERVICIOS' }, factura.lineas[1]],
    };
    const a = generarAsientoVentaDesdeFactura(facturaFam, reglasFam);
    expect(a.lineas.find((l) => l.subcuenta === '705000')?.haber).toBe(1000);
    expect(a.lineas.find((l) => l.subcuenta === '700000')?.haber).toBe(500);
  });
});

describe('Motor contable: asiento de compra', () => {
  const factura: FacturaContable = {
    idFactura: 'FC1',
    tipo: 'compra',
    codigoTercero: 'P0001',
    fecha: '2026-06-10',
    formaPago: 'TRANSFERENCIA',
    totalBase: 1000,
    totalIva: 210,
    totalFactura: 1210,
    lineas: [
      { descripcion: 'Mercaderia', cantidad: 1, precioUnitario: 1000, tipoIva: 21, baseImponible: 1000, importeIva: 210 },
    ],
  };

  it('carga compras + IVA soportado y abona al proveedor (cuadra)', () => {
    const a = generarAsientoCompraDesdeFactura(factura, reglas);
    expect(a.debeTotal).toBe(1210);
    expect(a.haberTotal).toBe(1210);
    expect(a.lineas.find((l) => l.subcuenta === '600000')?.debe).toBe(1000);
    expect(a.lineas.find((l) => l.subcuenta === '472000')?.debe).toBe(210);
    // proveedor P0001 -> subcuenta por tercero (400 + digitos del codigo)
    expect(a.lineas.find((l) => l.subcuenta === '4000000001')?.haber).toBe(1210);
  });
});
