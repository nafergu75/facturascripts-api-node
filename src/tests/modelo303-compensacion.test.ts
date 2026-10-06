// Compensacion de cuotas de periodos anteriores en el 303, y coherencia 303/390.
//
// Regresiones:
// - Se restaba TODO lo pendiente aunque el resultado del periodo fuese negativo
//   (resultado -500 con 1.000 pendientes daba -1.500). La AEAT solo deja aplicar
//   [78] hasta dejar el resultado en cero; el resto pasa a [87].
// - El fichero AEAT escribia lo pendiente en [110] y tambien en [78], con [87]=0.
// - El 390 sumaba compras NO deducibles que el 303 excluye: la suma de los 303
//   del ano no cuadraba con el 390.
import { agregar303, agregar390 } from '../services/impuestosCalculo.service';
import { generarPaginaModelo303_03, importe } from '../services/impuestosExport.service';
import { FacturaFiscal, PeriodoFiscal } from '../domain/impuestos.model';

const T2: PeriodoFiscal = { ejercicio: 2026, periodo: '2T', tipo: 'trimestral', fechaInicio: '2026-04-01', fechaFin: '2026-06-30' };

const venta = (id: string, fecha: string, base: number, cuota: number): FacturaFiscal => ({
  idFactura: id, tipo: 'venta', cifnif: 'B1', nombreTercero: 'Cliente', fecha, operacion: 'interior',
  lineas: [{ tipoIva: 21, base, cuota }],
});
const compra = (id: string, fecha: string, base: number, cuota: number, deducible = true): FacturaFiscal => ({
  idFactura: id, tipo: 'compra', cifnif: 'B2', nombreTercero: 'Proveedor', fecha, operacion: 'interior', deducible,
  lineas: [{ tipoIva: 21, base, cuota }],
});

/** Lee una casilla del registro de la pagina 3 (posicion 1-based, 17 caracteres). */
const casilla = (pagina: string, pos: number) => pagina.slice(pos - 1, pos - 1 + 17);

describe('303: cuotas a compensar de periodos anteriores', () => {
  it('con resultado negativo no aplica nada y todo pasa a periodos posteriores', () => {
    // Devengado 210, deducible 710 -> resultado -500.
    const d = agregar303([venta('V1', '2026-05-01', 1000, 210), compra('C1', '2026-05-02', 3380.95, 710)], T2, 1000);
    expect(d.resultado).toBe(-500);
    expect(d.cuotasACompensarAnteriores).toBe(1000); // [110]
    expect(d.cuotasAplicadas).toBe(0); // [78]
    expect(d.cuotasPendientesPosteriores).toBe(1000); // [87]
    expect(d.resultadoFinal).toBe(-500); // [71]
  });

  it('aplica solo hasta dejar el resultado en cero', () => {
    const d = agregar303([venta('V1', '2026-05-01', 1000, 210)], T2, 300);
    expect(d.resultado).toBe(210);
    expect(d.cuotasAplicadas).toBe(210);
    expect(d.cuotasPendientesPosteriores).toBe(90);
    expect(d.resultadoFinal).toBe(0);
    expect(d.casillas['78_cuotas_a_compensar']).toBe(210);
    expect(d.casillas['71_resultado']).toBe(0);
  });

  it('el fichero AEAT separa pendientes [110], aplicadas [78] y restantes [87]', () => {
    const d = agregar303([venta('V1', '2026-05-01', 1000, 210)], T2, 300);
    const p = generarPaginaModelo303_03(d);
    expect(casilla(p, 255)).toBe(importe(300, 17)); // [110]
    expect(casilla(p, 272)).toBe(importe(210, 17)); // [78]
    expect(casilla(p, 289)).toBe(importe(90, 17)); // [87]
    expect(casilla(p, 408)).toBe(importe(0, 17)); // [71]
  });
});

describe('390 coherente con los 303 del ano', () => {
  const facturas = [
    venta('V1', '2026-02-10', 1000, 210),
    venta('V2', '2026-08-10', 2000, 420),
    compra('C1', '2026-03-01', 500, 105),
    compra('C2', '2026-09-01', 100, 21, false), // NO deducible: fuera del 303 y del 390
  ];

  it('excluye las compras no deducibles', () => {
    expect(agregar390(facturas, 2026).totalCuotaDeducible).toBe(105);
  });

  it('el resultado anual es la suma de los resultados trimestrales', () => {
    const trimestres: PeriodoFiscal[] = [
      { ejercicio: 2026, periodo: '1T', tipo: 'trimestral', fechaInicio: '2026-01-01', fechaFin: '2026-03-31' },
      { ejercicio: 2026, periodo: '2T', tipo: 'trimestral', fechaInicio: '2026-04-01', fechaFin: '2026-06-30' },
      { ejercicio: 2026, periodo: '3T', tipo: 'trimestral', fechaInicio: '2026-07-01', fechaFin: '2026-09-30' },
      { ejercicio: 2026, periodo: '4T', tipo: 'trimestral', fechaInicio: '2026-10-01', fechaFin: '2026-12-31' },
    ];
    const sumaTrimestres = trimestres.reduce((acc, t) => acc + agregar303(facturas, t).resultado, 0);
    expect(agregar390(facturas, 2026).resultadoAnual).toBe(Math.round(sumaTrimestres * 100) / 100);
  });
});
