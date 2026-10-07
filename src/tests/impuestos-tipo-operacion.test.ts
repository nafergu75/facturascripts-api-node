/**
 * Modelos de IVA (303, 390, 347 y 349) con el tipo de operacion de cada venta
 * (puro, sin BD): cada tipo va a su casilla, y las facturas anteriores (sin
 * tipo, solo `operacion`) dan EXACTAMENTE lo mismo que antes.
 */
import { agregar303, agregar347, agregar349, agregar390, casillaAdicional303 } from '../services/impuestosCalculo.service';
import type { FacturaFiscal, PeriodoFiscal } from '../domain/impuestos.model';
import { agregar303Anterior, agregar347Anterior, agregar349Anterior, agregar390Anterior } from './agregadores-anteriores';

const T3: PeriodoFiscal = { ejercicio: 2026, periodo: '3T', tipo: 'trimestral', fechaInicio: '2026-07-01', fechaFin: '2026-09-30' };

const venta = (id: string, extra: Partial<FacturaFiscal>, base: number, tipoIva = 0): FacturaFiscal => ({
  idFactura: id,
  tipo: 'venta',
  cifnif: 'B11111111',
  nombreTercero: `Cliente ${id}`,
  fecha: '2026-08-10',
  operacion: 'interior',
  lineas: [{ tipoIva, base, cuota: Math.round(base * tipoIva) / 100 }],
  ...extra,
});

describe('303 por tipo de operacion', () => {
  it('exportacion de 10.000 USD a 1 USD = 0,90 EUR: 9.000 € en [60], sin IVA devengado', () => {
    // La factura guarda las columnas de cuenta en euros (10.000 / 1,11111111 = 9.000,00).
    const f = venta('E1', { tipoOperacion: 'EXPORTACION', operacion: 'exportacion', cifnif: '12-3456789', paisTercero: 'US', residente: false }, 9000);
    const m = agregar303([f], T3);
    expect(m.exportaciones).toBe(9000);
    expect(m.entregasIntracomunitarias).toBe(0);
    expect(m.totalCuotaDevengada).toBe(0);
    expect(m.ivaDevengado).toEqual([]);
    expect(casillaAdicional303(f)).toBe('60');
  });

  it('cada tipo a su casilla: [59] intracomunitaria y servicios UE, [60] exportacion y E3/E4, [120] no sujetas, [122] ISP', () => {
    const facturas = [
      venta('N', { tipoOperacion: 'NACIONAL' }, 1000, 21),
      venta('NF', { tipoOperacion: 'NACIONAL', cifnif: 'X', paisTercero: 'FR', residente: false }, 100, 21), // particular UE con IVA
      venta('I', { tipoOperacion: 'INTRACOMUNITARIA', operacion: 'intracomunitaria', cifnif: 'FR12345678901', paisTercero: 'FR', clave349: 'E' }, 2000),
      venta('S', { tipoOperacion: 'SERVICIOS_EXTRANJERO', cifnif: 'DE123456789', paisTercero: 'DE', clave349: 'S' }, 300),
      venta('SU', { tipoOperacion: 'SERVICIOS_EXTRANJERO', cifnif: '12-3456789', paisTercero: 'US', clave349: null }, 400),
      venta('X', { tipoOperacion: 'EXPORTACION', cifnif: '12-3456789', paisTercero: 'US' }, 500),
      venta('E3', { tipoOperacion: 'EXENTA', causaExencion: 'E3' }, 60),
      venta('E1', { tipoOperacion: 'EXENTA', causaExencion: 'E1' }, 70),
      venta('ISP', { tipoOperacion: 'ISP_NACIONAL' }, 800),
    ];
    const m = agregar303(facturas, T3);
    // Devengado: solo NACIONAL, sea cual sea el pais del cliente.
    expect(m.ivaDevengado).toEqual([{ tipo: 21, base: 1100, cuota: 231 }]);
    expect(m.entregasIntracomunitarias).toBe(2300);
    expect(m.exportaciones).toBe(560);
    expect(m.noSujetasLocalizacion).toBe(400);
    expect(m.inversionSujetoPasivo).toBe(800);
    expect(m.exentasSinDeduccion).toBe(70);
    expect(m.casillas['120_no_sujetas_localizacion']).toBe(400);
    expect(m.casillas['122_inversion_sujeto_pasivo']).toBe(800);
    expect(m.advertencias?.some((a) => /prorrata/.test(a))).toBe(true);
  });

  it('la empresa extranjera no deberia llegar aqui, pero si llega no suma en ninguna casilla', () => {
    const m = agregar303([venta('EX', { tipoOperacion: 'EMPRESA_EXTRANJERA' }, 1000)], T3);
    expect([m.totalBaseDevengada, m.entregasIntracomunitarias, m.exportaciones]).toEqual([0, 0, 0]);
  });
});

describe('facturas anteriores (sin tipo): exactamente lo de siempre', () => {
  const antiguas: FacturaFiscal[] = [
    venta('A1', { operacion: 'interior' }, 1000, 21),
    venta('A2', { operacion: 'interior' }, 200, 10),
    venta('A3', { operacion: 'intracomunitaria', cifnif: 'FR33333333' }, 2000),
    venta('A4', { operacion: 'exportacion', cifnif: 'US1' }, 700),
    // Una exportacion antigua con IVA: como siempre, fuera del devengado.
    venta('A5', { operacion: 'exportacion', cifnif: 'US2' }, 100, 21),
    { idFactura: 'C1', tipo: 'compra', cifnif: 'B22222222', nombreTercero: 'Prov', fecha: '2026-07-05', operacion: 'interior', lineas: [{ tipoIva: 21, base: 400, cuota: 84 }] },
    { idFactura: 'C2', tipo: 'compra', cifnif: 'DE999', nombreTercero: 'Prov DE', fecha: '2026-07-06', operacion: 'intracomunitaria', lineas: [{ tipoIva: 0, base: 50, cuota: 0 }] },
  ];

  it('303: mismas casillas, mismo devengado y la misma informacion adicional', () => {
    const m = agregar303(antiguas, T3);
    expect(m.ivaDevengado).toEqual([
      { tipo: 21, base: 1000, cuota: 210 },
      { tipo: 10, base: 200, cuota: 20 },
    ]);
    expect(m.totalCuotaDevengada).toBe(230);
    expect(m.totalCuotaDeducible).toBe(84);
    expect(m.resultado).toBe(146);
    expect(m.entregasIntracomunitarias).toBe(2000);
    expect(m.exportaciones).toBe(800);
    // Nada nuevo: ni [120], ni [122], ni avisos.
    expect(m).not.toHaveProperty('noSujetasLocalizacion');
    expect(m).not.toHaveProperty('inversionSujetoPasivo');
    expect(m).not.toHaveProperty('advertencias');
    expect(Object.keys(m.casillas).sort()).toEqual(
      [
        '04_base_devengada_10',
        '05_tipo',
        '06_cuota_devengada_10',
        '07_base_devengada_21',
        '08_tipo',
        '09_cuota_devengada_21',
        '27_total_devengado',
        '28_base_deducible',
        '29_cuota_deducible',
        '45_total_deducir',
        '46_resultado_regimen_general',
        '110_cuotas_pendientes_anteriores',
        '78_cuotas_a_compensar',
        '87_pendientes_periodos_posteriores',
        '71_resultado',
      ].sort(),
    );
  });

  it('390: mismo devengado y [99]; el volumen nuevo solo con ventas con tipo, y se avisa de las anteriores', () => {
    const m = agregar390(antiguas, 2026);
    expect(m.volumenOperaciones).toBe(1200);
    expect(m.resultadoAnual).toBe(146);
    expect(m.volumen).toMatchObject({ regimenGeneral: 1200, intracomunitarias: 0, exportacionesYExentasConDeduccion: 0, total: 1200 });
    expect(m.advertencias?.[0]).toMatch(/2000\.00 €.*800\.00 €/);
  });

  it('347 y 349: los de siempre', () => {
    const anuales = antiguas.map((f) => ({ ...f, lineas: f.lineas.map((l) => ({ ...l, base: l.base * 10, cuota: l.cuota * 10 })) }));
    expect(agregar347(anuales, 2026).operaciones.map((o) => [o.cifnif, o.baseAnual])).toEqual([
      ['B11111111', 14300],
      ['B22222222', 4840],
    ]);
    const m349 = agregar349(antiguas, T3);
    expect(m349.operaciones).toEqual([
      { cifnif: 'FR33333333', nombre: 'Cliente A3', clave: 'E', base: 2000 },
      { cifnif: 'DE999', nombre: 'Prov DE', clave: 'A', base: 50 },
    ]);
    expect(m349.totalBase).toBe(2050);
  });
});

describe('facturas anteriores al azar: igual que la copia congelada de los agregadores de antes', () => {
  // Generador determinista (sin dependencias): mismas facturas en cada ejecucion.
  let semilla = 20261007;
  const azar = () => ((semilla = (semilla * 1103515245 + 12345) % 2147483648) / 2147483648);
  const elegir = <T,>(xs: readonly T[]): T => xs[Math.floor(azar() * xs.length)];
  const OPERACIONES = ['interior', 'interior', 'interior', 'intracomunitaria', 'exportacion'] as const;
  const TIPOS = [0, 4, 10, 21, 21, 5];
  const NIFS = ['B11111111', 'B22222222', 'FR123', 'DE456', 'US789', 'B33333333'];

  function facturasAlAzar(n: number): FacturaFiscal[] {
    return Array.from({ length: n }, (_, i) => {
      const lineas = Array.from({ length: 1 + Math.floor(azar() * 3) }, () => {
        const tipoIva = elegir(TIPOS);
        const base = Math.round((azar() * 5000 - 500) * 100) / 100;
        return { tipoIva, base, cuota: Math.round(base * tipoIva) / 100 };
      });
      const mes = String(1 + Math.floor(azar() * 12)).padStart(2, '0');
      return {
        idFactura: `F${i}`,
        tipo: azar() < 0.7 ? ('venta' as const) : ('compra' as const),
        cifnif: elegir(NIFS),
        nombreTercero: 'Tercero',
        fecha: `2026-${mes}-15`,
        operacion: elegir(OPERACIONES),
        ...(azar() < 0.2 ? { deducible: false } : {}),
        lineas,
      };
    });
  }

  it('303, 347 y 390 dan lo mismo; el 349, los mismos importes agrupados por operador y clave', () => {
    for (let vuelta = 0; vuelta < 40; vuelta++) {
      const fs = facturasAlAzar(25);
      for (const periodo of [T3, { ...T3, periodo: '1T', fechaInicio: '2026-01-01', fechaFin: '2026-03-31' }]) {
        const compensar = vuelta % 3 === 0 ? 150 : 0;
        expect(agregar303(fs, periodo, compensar)).toEqual(agregar303Anterior(fs, periodo, compensar));

        const antes349 = agregar349Anterior(fs, periodo);
        const ahora349 = agregar349(fs, periodo);
        const agrupado = new Map<string, number>();
        for (const o of antes349.operaciones) agrupado.set(`${o.cifnif}|${o.clave}`, Math.round(((agrupado.get(`${o.cifnif}|${o.clave}`) ?? 0) + o.base) * 100) / 100);
        expect(new Map(ahora349.operaciones.map((o) => [`${o.cifnif}|${o.clave}`, o.base]))).toEqual(new Map([...agrupado].filter(([, b]) => b !== 0)));
        expect(ahora349.totalBase).toBeCloseTo(antes349.totalBase, 2);
      }
      expect(agregar347(fs, 2026)).toEqual(agregar347Anterior(fs, 2026));
      const { volumen: _v, advertencias: _a, ...a390 } = agregar390(fs, 2026);
      expect(a390).toEqual(agregar390Anterior(fs, 2026));
      // Sin ventas con tipo, [108] es [99], como antes.
      expect(_v?.total).toBe(a390.volumenOperaciones);
    }
  });
});

describe('390 con tipos de operacion', () => {
  it('volumen por grupos y [108] como suma real', () => {
    const m = agregar390(
      [
        venta('N', { tipoOperacion: 'NACIONAL' }, 1000, 21),
        venta('I', { tipoOperacion: 'INTRACOMUNITARIA', cifnif: 'FR12345678901', paisTercero: 'FR', clave349: 'E' }, 2000),
        venta('X', { tipoOperacion: 'EXPORTACION', paisTercero: 'US' }, 300),
        venta('E4', { tipoOperacion: 'EXENTA', causaExencion: 'E4' }, 40),
        venta('E6', { tipoOperacion: 'EXENTA', causaExencion: 'E6' }, 50),
        venta('SU', { tipoOperacion: 'SERVICIOS_EXTRANJERO', cifnif: '1', paisTercero: 'US', clave349: null }, 60),
        venta('ISP', { tipoOperacion: 'ISP_NACIONAL' }, 70),
      ],
      2026,
    );
    expect(m.volumen).toEqual({
      regimenGeneral: 1000,
      intracomunitarias: 2000,
      exportacionesYExentasConDeduccion: 340,
      exentasSinDeduccion: 50,
      noSujetas: 60,
      isp: 70,
      total: 3520,
    });
    expect(m.totalCuotaDevengada).toBe(210);
  });
});

describe('347 con tipos de operacion', () => {
  it('sin exportaciones, intracomunitarias, servicios a extranjeros ni clientes no residentes; en euros', () => {
    const f = (id: string, extra: Partial<FacturaFiscal>, base: number) => venta(id, { cifnif: id, ...extra }, base, 21);
    const m = agregar347(
      [
        f('ES1', { tipoOperacion: 'NACIONAL', residente: true }, 3000), // 3.630 con IVA: se declara
        f('ES2', { tipoOperacion: 'NACIONAL', residente: true }, 2000), // 2.420: por debajo del umbral
        f('UE1', { tipoOperacion: 'NACIONAL', residente: false, paisTercero: 'FR' }, 9000), // no residente
        venta('X1', { tipoOperacion: 'EXPORTACION', cifnif: 'X1', residente: false }, 50000),
        venta('EXE', { tipoOperacion: 'EXENTA', causaExencion: 'E1', cifnif: 'EXE', residente: true }, 4000),
      ],
      2026,
    );
    expect(m.operaciones.map((o) => [o.cifnif, o.baseAnual])).toEqual([
      ['EXE', 4000],
      ['ES1', 3630],
    ]);
  });
});

describe('349 con tipos de operacion', () => {
  it('E para entregas, S para servicios a empresarios UE, nada para lo demas; agrupado por operador y clave y neto', () => {
    const m = agregar349(
      [
        venta('I1', { tipoOperacion: 'INTRACOMUNITARIA', cifnif: 'FR12345678901', paisTercero: 'FR', clave349: 'E' }, 1000),
        venta('I2', { tipoOperacion: 'INTRACOMUNITARIA', cifnif: 'FR 123 456 789 01', paisTercero: 'FR', clave349: 'E' }, 500),
        venta('R1', { tipoOperacion: 'INTRACOMUNITARIA', cifnif: 'FR12345678901', paisTercero: 'FR', clave349: 'E' }, -200), // rectificativa
        venta('S1', { tipoOperacion: 'SERVICIOS_EXTRANJERO', cifnif: 'DE123456789', paisTercero: 'DE' }, 300), // sin clave349: se deduce
        venta('SU', { tipoOperacion: 'SERVICIOS_EXTRANJERO', cifnif: '12-3456789', paisTercero: 'US' }, 900),
        venta('X', { tipoOperacion: 'EXPORTACION', cifnif: 'X', paisTercero: 'US' }, 10000),
      ],
      T3,
    );
    expect(m.operaciones).toEqual([
      { cifnif: 'FR12345678901', nombre: 'Cliente I1', clave: 'E', base: 1300 },
      { cifnif: 'DE123456789', nombre: 'Cliente S1', clave: 'S', base: 300 },
    ]);
    expect(m.totalBase).toBe(1600);
    expect(m).not.toHaveProperty('advertencias');
  });

  it('un operador que queda en negativo se avisa', () => {
    const m = agregar349([venta('R', { tipoOperacion: 'INTRACOMUNITARIA', cifnif: 'IT12345678901', paisTercero: 'IT', clave349: 'E' }, -50)], T3);
    expect(m.operaciones[0].base).toBe(-50);
    expect(m.advertencias?.[0]).toMatch(/negativo/);
  });
});
