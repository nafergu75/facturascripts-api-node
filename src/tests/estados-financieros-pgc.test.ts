// Balance, PyG, ECPN y EFE segun los modelos del PGC de PYMES.
//
// Regresiones:
// - El balance solo sumaba los asientos del año: sin asiento de apertura, se
//   perdian los saldos de años anteriores (bancos, capital, prestamos...).
// - Tras cerrar el ejercicio, la regularizacion y el cierre (guardados como
//   AJUSTE_MANUAL) dejaban la PyG y el balance a cero.
// - El 630 (impuesto sobre beneficios) contaba dos veces.
// - Cuentas sin bloque (13, 14, 465, 678...) descuadraban el balance.
// - El EFE empezaba siempre con efectivo 0 y contaba la apertura como cobro.
import { AsientoSimple, saldosDelEjercicio, tipoAsiento } from '../services/contabilidadDatos.service';
import { calcularEstadosDesdeSaldos } from '../services/impuestoSociedadesCalculo.service';
import { calcularEFEDesdeAsientos, proponerAplicacion } from '../services/cuentasAnuales.service';
import { partidaBalance, partidaPyG } from '../domain/modelos-cuentas-anuales';

let n = 0;
function asiento(fecha: string, lineas: Array<[string, number, number]>, tipo: AsientoSimple['tipo'] = 'NORMAL'): AsientoSimple {
  return { numero: ++n, fecha, concepto: '', tipo, lineas: lineas.map(([subcuenta, debe, haber]) => ({ subcuenta, debe, haber })) };
}

const partida = (lista: Array<{ codigo?: string; importe: number }> | undefined, codigo: string) =>
  lista?.find((p) => p.codigo === codigo)?.importe ?? 0;

// 2025: constitucion con 3.000 de capital, venta de 1.000 cobrada, gasto de 400 pagado.
const A2025 = [
  asiento('2025-01-10', [['5720001', 3000, 0], ['1000000', 0, 3000]]),
  asiento('2025-03-01', [['5720001', 1210, 0], ['7000000', 0, 1000], ['4770000', 0, 210]]),
  asiento('2025-04-01', [['6290000', 400, 0], ['5720001', 0, 400]]),
];
// 2026: venta de 2.000 a credito y el impuesto de sociedades (630) de 150.
const A2026 = [
  asiento('2026-02-01', [['4300001', 2420, 0], ['7000000', 0, 2000], ['4770000', 0, 420]]),
  asiento('2026-12-31', [['6300000', 150, 0], ['4752000', 0, 150]]),
];

function estados(asientos: AsientoSimple[], ejercicio: number) {
  return calcularEstadosDesdeSaldos(saldosDelEjercicio(asientos, ejercicio), saldosDelEjercicio(asientos, ejercicio - 1));
}

describe('tipo de asiento', () => {
  it('reconoce los del cierre aunque se guardaran como ajuste manual', () => {
    expect(tipoAsiento('AJUSTE_MANUAL', 'Regularizacion ejercicio 2025')).toBe('REGULARIZACION');
    expect(tipoAsiento('AJUSTE_MANUAL', 'Cierre ejercicio 2025')).toBe('CIERRE');
    expect(tipoAsiento('AJUSTE_MANUAL', 'Apertura ejercicio 2026')).toBe('APERTURA');
    expect(tipoAsiento('CIERRE_AUTOMATICO', 'CIERRE CONTABLE - Período ...')).toBe('CIERRE');
    expect(tipoAsiento('FACTURA_INGRESO', 'Factura 1')).toBe('NORMAL');
  });
});

describe('PyG', () => {
  it('el 630 va a impuestos y no a otros gastos (antes contaba dos veces)', () => {
    const { pyg } = estados([...A2025, ...A2026], 2026);
    expect(partida(pyg.partidas, '1')).toBe(2000);
    expect(partida(pyg.partidas, '7')).toBe(0);
    expect(partida(pyg.partidas, '18')).toBe(-150);
    expect(pyg.resultadoAntesImpuestos).toBe(2000);
    expect(pyg.resultadoEjercicio).toBe(1850);
  });

  it('clasifica por el prefijo mas largo', () => {
    expect(partidaPyG('6310000')).toBe('7'); // otros tributos
    expect(partidaPyG('6300000')).toBe('18'); // impuesto sobre beneficios
    expect(partidaPyG('6680000')).toBe('16'); // diferencias de cambio
    expect(partidaPyG('7460000')).toBe('9'); // subvenciones de capital traspasadas
    expect(partidaPyG('6780000')).toBe('12'); // gastos excepcionales
  });
});

describe('balance', () => {
  it('arrastra los saldos de años anteriores sin asiento de apertura y cuadra', () => {
    const { balance } = estados([...A2025, ...A2026], 2026);
    expect(partida(balance.activoCorriente, 'B.VII')).toBe(3810); // 3.000 + 1.210 - 400
    expect(partida(balance.activoCorriente, 'B.III.1')).toBe(2420);
    expect(partida(balance.patrimonioNeto, 'A1.I')).toBe(3000);
    expect(partida(balance.patrimonioNeto, 'A1.V')).toBe(600); // beneficio 2025 sin repartir
    expect(partida(balance.patrimonioNeto, 'A1.VII')).toBe(1850);
    expect(balance.totalActivo).toBe(6230);
    expect(balance.descuadre).toBe(0);
  });

  it('un ejercicio ya cerrado da las mismas cifras que antes de cerrarlo', () => {
    const antes = estados([...A2025], 2025);
    const cierre2025 = [
      asiento('2025-12-31', [['7000000', 1000, 0], ['6290000', 0, 400], ['1290000', 0, 600]], 'REGULARIZACION'),
      asiento('2025-12-31', [['1000000', 3000, 0], ['4770000', 210, 0], ['1290000', 600, 0], ['5720001', 0, 3810]], 'CIERRE'),
    ];
    const despues = estados([...A2025, ...cierre2025], 2025);
    expect(despues.pyg.resultadoEjercicio).toBe(600);
    expect(despues.balance.totalActivo).toBe(antes.balance.totalActivo);
    expect(despues.balance.descuadre).toBe(0);
  });

  it('con asiento de apertura parte de el y da lo mismo que acumulando', () => {
    const apertura = asiento(
      '2026-01-01',
      [['5720001', 3810, 0], ['1000000', 0, 3000], ['4770000', 0, 210], ['1290000', 0, 600]],
      'APERTURA',
    );
    const conApertura = estados([...A2025, apertura, ...A2026], 2026);
    const sinApertura = estados([...A2025, ...A2026], 2026);
    expect(conApertura.balance.totalActivo).toBe(sinApertura.balance.totalActivo);
    expect(partida(conApertura.balance.patrimonioNeto, 'A1.V')).toBe(600);
    expect(conApertura.balance.descuadre).toBe(0);
  });

  it('un banco en descubierto es deuda, no efectivo negativo', () => {
    expect(partidaBalance('5720002', -500)).toEqual({ partida: 'D.II', importe: 500 });
    expect(partidaBalance('4000001', 300)).toEqual({ partida: 'B.III.3', importe: 300 }); // proveedor con saldo deudor
  });

  it('cuentas que antes se quedaban fuera no lo descuadran', () => {
    const raros = [
      asiento('2026-03-01', [['5720001', 5000, 0], ['1300000', 0, 5000]]), // subvencion
      asiento('2026-03-02', [['6780000', 200, 0], ['1420000', 0, 200]]), // provision
      asiento('2026-03-03', [['6400000', 1000, 0], ['4650000', 0, 1000]]), // nomina pendiente
    ];
    const { balance } = estados([...A2025, ...A2026, ...raros], 2026);
    expect(partida(balance.patrimonioNeto, 'A2')).toBe(5000);
    expect(partida(balance.pasivoNoCorriente, 'C.I')).toBe(200);
    expect(partida(balance.pasivoCorriente, 'D.IV.2')).toBe(1000 + 630 + 150); // 465 + IVA 477 + 4752
    expect(balance.descuadre).toBe(0);
  });
});

describe('ECPN', () => {
  it('cada componente cuadra: inicial + movimientos = final', () => {
    const { ecpn } = estados([...A2025, ...A2026], 2026);
    for (const c of ecpn.componentes ?? []) {
      const suma = c.saldoInicial + c.resultadoEjercicio + c.ingresosGastosReconocidos + c.operacionesSocios + c.otrasVariaciones;
      expect(Math.round(suma * 100) / 100).toBe(c.saldoFinal);
    }
    const resultado = ecpn.componentes?.find((c) => c.codigo === 'A1.VII');
    expect(resultado).toMatchObject({ saldoInicial: 600, resultadoEjercicio: 1850, saldoFinal: 1850 });
  });
});

describe('EFE', () => {
  it('parte del efectivo del año anterior y no cuenta la apertura como cobro', () => {
    const apertura = asiento('2026-01-01', [['5720001', 3810, 0], ['1000000', 0, 3810]], 'APERTURA');
    const cobro = asiento('2026-05-01', [['5720001', 2420, 0], ['4300001', 0, 2420]]);
    const efe = calcularEFEDesdeAsientos([apertura, cobro], 3810);
    expect(efe.efectivoInicial).toBe(3810);
    expect(efe.variacionNetaEfectivo).toBe(2420);
    expect(efe.efectivoFinal).toBe(6230);
  });
});

describe('aplicacion del resultado', () => {
  it('10% a reserva legal hasta el 20% del capital', () => {
    expect(proponerAplicacion(1850, 3000, 0)).toMatchObject({ aReservaLegal: 185, aReservasVoluntarias: 1665 });
    expect(proponerAplicacion(1850, 3000, 550)).toMatchObject({ aReservaLegal: 50, aReservasVoluntarias: 1800 });
    expect(proponerAplicacion(1850, 3000, 600)).toMatchObject({ aReservaLegal: 0 });
  });

  it('las perdidas van a resultados negativos', () => {
    expect(proponerAplicacion(-400, 3000, 0)).toMatchObject({ aReservas: 0, aCompensacionPerdidas: 400 });
  });
});

describe('formato de importes del PDF', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { importe } = require('../services/cuentasAnualesPdf') as typeof import('../services/cuentasAnualesPdf');
  it('punto de miles tambien con 4 cifras y negativos entre parentesis', () => {
    expect(importe(1200)).toBe('1.200,00');
    expect(importe(1234567.891)).toBe('1.234.567,89');
    expect(importe(-75)).toBe('(75,00)');
    expect(importe(-0.001)).toBe('0,00');
  });
});
