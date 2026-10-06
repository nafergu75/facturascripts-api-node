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
    // Cliente A1: 6.000 de base + 21 % de IVA = 7.260 (el 347 va con IVA
    // incluido; antes se declaraba solo la base). Proveedor B2: 400 (excluido).
    const cliente = m.operaciones.find((o) => o.cifnif === 'A11111111');
    expect(cliente?.baseAnual).toBe(7260);
    expect(m.operaciones.find((o) => o.cifnif === 'B22222222')).toBeUndefined();
  });

  it('suma todas las facturas del año del mismo tercero y solo declara lo que SUPERA 3.005,06', () => {
    const f = (id: string, cifnif: string, base: number, operacion: 'interior' | 'intracomunitaria' = 'interior') => ({
      idFactura: id, tipo: 'venta' as const, cifnif, nombreTercero: cifnif, fecha: '2026-03-01', operacion,
      lineas: [{ tipoIva: 21, base, cuota: Math.round(base * 21) / 100 }],
    });
    const m = agregar347(
      [
        // Tres facturas de 2.000 € con IVA: ninguna supera el umbral, la suma si.
        f('1', 'B1', 1652.89), f('2', 'B1', 1652.89), f('3', 'B1', 1652.89),
        // Justo 3.005,06 con IVA: no se declara.
        f('4', 'B2', 2483.52),
        // Cliente de otro pais de la UE: va en el 349, no en el 347.
        f('5', 'FR1', 10000, 'intracomunitaria'),
      ],
      2026,
    );
    expect(m.operaciones.map((o) => [o.cifnif, o.baseAnual])).toEqual([['B1', 6000]]);
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
