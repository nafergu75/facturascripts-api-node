// Memoria PYMES: lo que sale de la contabilidad se calcula; lo que no, se marca
// como pendiente (nunca se inventa).
import { AsientoSimple, saldosDelEjercicio } from '../services/contabilidadDatos.service';
import { calcularEstadosDesdeSaldos } from '../services/impuestoSociedadesCalculo.service';
import { proponerAplicacion } from '../services/cuentasAnuales.service';
import { generarMemoria, limpiarNotasMemoria, NotasMemoria, PENDIENTE } from '../services/memoria.service';
import { limpiarLegalConfig } from '../services/legalConfig.service';
import type { CuentasAnualesRM } from '../domain/cuentas-anuales.model';

let n = 0;
const asiento = (fecha: string, lineas: Array<[string, number, number]>): AsientoSimple => ({
  numero: ++n,
  fecha,
  concepto: '',
  tipo: 'NORMAL',
  lineas: lineas.map(([subcuenta, debe, haber]) => ({ subcuenta, debe, haber })),
});

const ASIENTOS = [
  asiento('2025-01-10', [['5720001', 3000, 0], ['1000000', 0, 3000]]),
  asiento('2025-06-01', [['2170000', 1000, 0], ['5720001', 0, 1000]]),
  asiento('2025-12-31', [['6810000', 200, 0], ['2817000', 0, 200]]),
  asiento('2026-03-01', [['2170000', 1500, 0], ['5720001', 0, 1500]]),
  asiento('2026-05-01', [['6400000', 1000, 0], ['6420000', 300, 0], ['4650000', 0, 1300]]),
  asiento('2026-06-01', [['6280000', 120, 0], ['6230000', 80, 0], ['4000001', 0, 200]]),
  asiento('2026-12-31', [['6810000', 500, 0], ['2817000', 0, 500]]),
];

function entrada(notas: NotasMemoria = {}, sociedad = {}) {
  const saldos = saldosDelEjercicio(ASIENTOS, 2026);
  const saldosAnterior = saldosDelEjercicio(ASIENTOS, 2025);
  const est = calcularEstadosDesdeSaldos(saldos, saldosAnterior);
  const cuentas = {
    sociedad: { denominacion: 'Ejemplo SL', nif: 'B12345678', domicilio: '', ejercicio: 2026, formaJuridica: 'Sociedad de Responsabilidad Limitada' },
    ...est,
    aplicacionResultado: proponerAplicacion(est.pyg.resultadoEjercicio, est.ecpn.capital, 0),
    notasMemoria: '',
  } as CuentasAnualesRM;
  return {
    ejercicio: 2026,
    cuentas,
    sociedad: { denominacion: 'Ejemplo SL', nif: 'B12345678', formaJuridica: 'Sociedad de Responsabilidad Limitada', ...sociedad },
    notas,
    saldos,
    saldosAnterior,
    asientos: ASIENTOS.filter((a) => a.fecha.startsWith('2026')),
  };
}

const notaN = (m: ReturnType<typeof generarMemoria>, numero: string) => m.notas.find((x) => x.numero === numero)!;

describe('memoria', () => {
  it('tiene las 12 notas del modelo PYMES', () => {
    const m = generarMemoria(entrada());
    expect(m.notas.map((x) => x.numero)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
  });

  it('marca como pendiente lo que no esta en la contabilidad, sin inventarlo', () => {
    const m = generarMemoria(entrada());
    expect(m.pendientes).toEqual(
      expect.arrayContaining([
        'domicilio social',
        'actividad principal',
        'número medio de personas empleadas en el ejercicio',
        'periodo medio de pago a proveedores',
      ]),
    );
    expect(notaN(m, '12').parrafos[0]).toContain(PENDIENTE);
  });

  it('con los datos completos ya no queda nada pendiente de esos apartados', () => {
    const m = generarMemoria(
      entrada(
        {
          plantillaMedia: 2,
          periodoMedioPago: 35,
          remuneracionAdministradores: 'no han percibido remuneración.',
          partesVinculadas: 'No hay operaciones con partes vinculadas.',
          hechosPosteriores: 'no se han producido.',
        },
        {
          domicilioSocial: 'Calle Mayor 1',
          codigoPostal: '46001',
          municipio: 'Valencia',
          provincia: 'Valencia',
          actividad: 'la fabricación de muebles',
          cnae: '3109',
          registroMercantilProvincia: 'Valencia',
          datosRegistrales: 'tomo 1, folio 2, hoja V-3',
          fechaConstitucion: '2025-01-10',
        },
      ),
    );
    expect(m.pendientes).toEqual(['número y valor nominal de las acciones o participaciones']);
    expect(notaN(m, '1').parrafos[0]).toContain('Calle Mayor 1, 46001 Valencia, (Valencia)');
    expect(notaN(m, '12').parrafos[0]).toBe('La plantilla media del ejercicio ha sido de 2 personas.');
  });

  it('nota 4: movimiento del inmovilizado material con su amortizacion', () => {
    const t = notaN(generarMemoria(entrada()), '4').tablas[0];
    const fila = (texto: string) => t.filas.find((f) => f.texto === texto)!.valores[0];
    expect(fila('Coste: saldo inicial')).toBe(1000);
    expect(fila('(+) Entradas')).toBe(1500);
    expect(fila('Coste: saldo final')).toBe(2500);
    expect(fila('Amortización y deterioro acumulados: saldo inicial')).toBe(200);
    expect(fila('(+) Dotaciones')).toBe(500);
    expect(fila('Valor neto contable')).toBe(1800);
  });

  it('nota 9: desglose de personal y servicios exteriores', () => {
    const t = notaN(generarMemoria(entrada()), '9').tablas[0];
    const fila = (texto: string) => t.filas.find((f) => f.texto === texto)?.valores[0];
    expect(fila('Sueldos y salarios')).toBe(1000);
    expect(fila('Cargas sociales')).toBe(300);
    expect(fila('Suministros')).toBe(120);
    expect(fila('Servicios de profesionales independientes')).toBe(80);
  });

  it('un texto propio sustituye la nota automatica', () => {
    const m = generarMemoria(entrada({ textos: { '3': 'Primer párrafo.\n\nSegundo párrafo.' } }));
    expect(notaN(m, '3').parrafos).toEqual(['Primer párrafo.', 'Segundo párrafo.']);
  });
});

describe('limpieza de entradas', () => {
  it('notas de la memoria: solo campos conocidos y numeros validos', () => {
    const r = limpiarNotasMemoria({ plantillaMedia: '3', periodoMedioPago: -5, hackeo: 'x', textos: { '3': 'ok', '99': 'no' } } as never);
    expect(r.plantillaMedia).toBe(3);
    expect(r.periodoMedioPago).toBeNull();
    expect(r).not.toHaveProperty('hackeo');
    expect(r.textos).toEqual({ '3': 'ok' });
  });

  it('configuracion legal: no deja tocar companyId ni id y valida formatos', () => {
    const r = limpiarLegalConfig({ companyId: 'otra', id: 'x', nif: 'b-12 345 678', domicilioSocial: '  Calle Mayor 1 ', tipoSociedad: 'sl' });
    expect(r).toEqual({ nif: 'B12345678', domicilioSocial: 'Calle Mayor 1', tipoSociedad: 'SL' });
    expect(() => limpiarLegalConfig({ tipoSociedad: 'XX' })).toThrow(/tipoSociedad/);
    expect(() => limpiarLegalConfig({ fechaConstitucion: '10/01/2025' })).toThrow(/AAAA-MM-DD/);
  });
});
