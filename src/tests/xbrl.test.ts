// XBRL del balance y la PyG (taxonomia PGC2007 v1.6.0) para importar en D2.
//
// La validacion completa contra la taxonomia (elementos, tipo de periodo y las
// 42 reglas de calculo) se hizo con el paquete oficial del ICAC, que no esta en
// el repositorio. Aqui se fijan los nombres de los elementos y que los totales
// salen de sus desgloses.
import { AsientoSimple, saldosDelEjercicio } from '../services/contabilidadDatos.service';
import { generarXbrl, hechosXbrl } from '../services/xbrl.service';
import { limpiarLegalConfig } from '../services/legalConfig.service';

let k = 0;
const a = (fecha: string, l: Array<[string, number, number]>): AsientoSimple => ({
  numero: ++k,
  fecha,
  concepto: '',
  tipo: 'NORMAL',
  lineas: l.map(([subcuenta, debe, haber]) => ({ subcuenta, debe, haber })),
});

const ASIENTOS = [
  a('2025-01-10', [['5720001', 2500, 0], ['1030000', 500, 0], ['1000000', 0, 3000]]),
  a('2026-01-15', [['5720001', 10000, 0], ['1700000', 0, 8000], ['5200000', 0, 2000]]),
  a('2026-02-01', [['4300001', 2420, 0], ['7050000', 0, 2000], ['4770000', 0, 420]]),
  a('2026-03-02', [['2180000', 3000, 0], ['1740000', 0, 2400], ['5240000', 0, 600]]),
  a('2026-04-01', [['5720002', 0, 350.75], ['6230000', 350.75, 0]]),
  a('2026-05-10', [['5720001', 5000, 0], ['1300000', 0, 5000]]),
  a('2026-06-01', [['5800000', 700, 0], ['5720001', 0, 700]]),
  a('2026-07-01', [['6620000', 120.4, 0], ['5720001', 0, 120.4]]),
  a('2026-12-31', [['6300000', 75, 0], ['4752000', 0, 75]]),
];
const saldos = saldosDelEjercicio(ASIENTOS, 2026);
const BS = 'pgc-07-c-bs:';

describe('XBRL PGC2007', () => {
  const { balance, pyg } = hechosXbrl(saldos, 'ABREVIADO');
  const v = (m: Map<string, number>, el: string) => m.get(el.includes(':') ? el : BS + el) ?? NaN;

  it('desglosa capital, deudas con bancos, arrendamiento financiero y descubiertos', () => {
    expect(v(balance, 'PatrimonioNetoFondosPropiosCapitalEscriturado')).toBe(3000);
    expect(v(balance, 'PatrimonioNetoFondosPropiosCapitalNoExigido')).toBe(-500);
    expect(v(balance, 'PatrimonioNetoFondosPropiosCapital')).toBe(2500);
    expect(v(balance, 'PasivoNoCorrienteDeudasLargoPlazoDeudasEntidadesCredito')).toBe(8000);
    expect(v(balance, 'PasivoNoCorrienteDeudasLargoPlazoAcreedoresArrendamientoFinanciero')).toBe(2400);
    // 520 + banco 5720002 en descubierto
    expect(v(balance, 'PasivoCorrienteDeudasCortoPlazoDeudasEntidadesCredito')).toBe(2350.75);
    expect(v(balance, 'PasivoCorrienteDeudasCortoPlazoAcreedoresArrendamientoFinanciero')).toBe(600);
  });

  it('los totales salen de sus desgloses y el balance cuadra', () => {
    const suma = (...els: string[]) => Math.round(els.reduce((t, e) => t + v(balance, e), 0) * 100) / 100;
    expect(v(balance, 'PasivoNoCorrienteDeudasLargoPlazo')).toBe(
      suma('PasivoNoCorrienteDeudasLargoPlazoDeudasEntidadesCredito', 'PasivoNoCorrienteDeudasLargoPlazoAcreedoresArrendamientoFinanciero', 'pgc-07-c-ap:PasivoNoCorrienteDeudasLargoPlazoOtrasDeudas'),
    );
    expect(v(balance, 'PatrimonioNeto')).toBe(
      suma('PatrimonioNetoFondosPropios', 'PatrimonioNetoAjustesCambioValor', 'PatrimonioNetoSubvencionesDonacionesLegadosRecibidos'),
    );
    expect(v(balance, 'TotalActivo')).toBe(v(balance, 'PatrimonioNetoPasivoTotal'));
    expect(v(balance, 'BalanceSituacionVariable')).toBe(0);
  });

  it('gastos en negativo, como en los modelos del Registro', () => {
    expect(v(pyg, 'PerdidasGananciasOperacionesContinuadasOtrosGastosExplotacion')).toBe(-350.75);
    expect(v(pyg, 'PerdidasGananciasOperacionesContinuadasGastosFinancieros')).toBe(-120.4);
    expect(v(pyg, 'PerdidasGananciasOperacionesContinuadasImpuestosSobreBeneficios')).toBe(-75);
    expect(v(pyg, 'PerdidasGananciasResultadoEjercicio')).toBe(1453.85);
  });

  it('abreviado: activos mantenidos para la venta en su partida; PYMES: con inversiones a corto, avisando', () => {
    expect(balance.get('pgc-07-c-na:ActivoCorrienteActivosNoCorrientesMantenidosParaVenta')).toBe(700);
    const pymes = hechosXbrl(saldos, 'PYME');
    expect([...pymes.balance.keys()].some((e) => e.startsWith('pgc-07-c-na:'))).toBe(false);
    expect(pymes.balance.get(`${BS}ActivoCorrienteInversionesFinancierasCortoPlazo`)).toBe(700);
    expect(pymes.avisos[0]).toMatch(/mantenidos para la venta/);
  });

  it('instancia con el esquema oficial, contextos N y N-1, NIF escapado', () => {
    const { xml } = generarXbrl({ modelo: 'PYME', ejercicio: 2026, nif: 'B1<2>', saldos, saldosAnterior: saldosDelEjercicio(ASIENTOS, 2025) });
    expect(xml).toContain('xlink:href="https://www.icac.gob.es/sites/default/files/pgc2007/v160/pgc07-pymes-completo.xsd"');
    expect(xml).toContain('<xbrli:instant>2025-12-31</xbrli:instant>');
    expect(xml).toContain('<xbrli:startDate>2026-01-01</xbrli:startDate>');
    expect(xml).toContain('B1&lt;2&gt;');
    expect(xml).toMatch(/<pgc-07-c-bs:TotalActivo decimals="2" contextRef="Y2026_Balance" unitRef="euro">[\d.]+<\/pgc-07-c-bs:TotalActivo>/);
  });
});

describe('CNAE-2025', () => {
  it('admite 2 a 4 cifras, con o sin punto, y lo guarda sin punto', () => {
    expect(limpiarLegalConfig({ cnae: '47.11' }).cnae).toBe('4711');
    expect(() => limpiarLegalConfig({ cnae: 'comercio' })).toThrow(/CNAE-2025/);
  });
});
