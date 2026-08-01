import { agregar303, agregar347, agregar349 } from '../services/impuestosCalculo.service';
import { FacturaFiscal, PeriodoFiscal } from '../domain/impuestos.model';

const segundoTrimestre: PeriodoFiscal = {
  ejercicio: 2026,
  periodo: '2T',
  tipo: 'trimestral',
  fechaInicio: '2026-04-01',
  fechaFin: '2026-06-30',
};

const facturas: FacturaFiscal[] = [
  { idFactura: 'V1', tipo: 'venta', cifnif: 'A11111111', nombreTercero: 'Cliente Uno', fecha: '2026-06-10', operacion: 'interior', lineas: [{ tipoIva: 21, base: 1000, cuota: 210 }] },
  { idFactura: 'C1', tipo: 'compra', cifnif: 'B22222222', nombreTercero: 'Prov Uno', fecha: '2026-05-01', operacion: 'interior', lineas: [{ tipoIva: 21, base: 400, cuota: 84 }] },
  { idFactura: 'V2', tipo: 'venta', cifnif: 'A11111111', nombreTercero: 'Cliente Uno', fecha: '2026-01-10', operacion: 'interior', lineas: [{ tipoIva: 21, base: 5000, cuota: 1050 }] },
  { idFactura: 'V3', tipo: 'venta', cifnif: 'FR33333333', nombreTercero: 'Client FR', fecha: '2026-05-20', operacion: 'intracomunitaria', lineas: [{ tipoIva: 0, base: 2000, cuota: 0 }] },
];

describe('Modelo 303 (IVA trimestral)', () => {
  it('devengado (ventas interiores 2T) - deducible (compras 2T) = resultado', () => {
    const m = agregar303(facturas, segundoTrimestre);
    expect(m.totalCuotaDevengada).toBe(210); // V1 (V2 es de enero -> fuera; V3 intracom -> no interior)
    expect(m.totalCuotaDeducible).toBe(84); // C1
    expect(m.resultado).toBe(126);
    expect(m.casillas['71_resultado']).toBe(126);
  });
});

describe('Modelo 347 (operaciones con terceros > 3.005,06 anual)', () => {
  it('incluye al cliente que supera el umbral y excluye al que no', () => {
    const m = agregar347(facturas, 2026);
    // Cliente A1: 1000 + 5000 + ... = 6000 (>3005). Proveedor B2: 400 (<3005, excluido).
    const cliente = m.operaciones.find((o) => o.cifnif === 'A11111111');
    expect(cliente?.baseAnual).toBe(6000);
    expect(m.operaciones.find((o) => o.cifnif === 'B22222222')).toBeUndefined();
  });
});

describe('Modelo 349 (operaciones intracomunitarias)', () => {
  it('recoge la entrega intracomunitaria del periodo', () => {
    const m = agregar349(facturas, segundoTrimestre);
    expect(m.operaciones).toHaveLength(1);
    expect(m.operaciones[0]).toMatchObject({ cifnif: 'FR33333333', clave: 'E', base: 2000 });
    expect(m.totalBase).toBe(2000);
  });
});
