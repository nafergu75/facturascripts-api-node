// Huella de los registros de VERI*FACTU con los ejemplos OFICIALES de la AEAT:
// «Detalle de las especificaciones técnicas para generación de la huella o hash
// de los registros de facturación», v0.1.2 de 27/08/2024, apartado 6 (casos 1,
// 2 y 3). Puro, sin BD.
import { describe, it, expect } from '@jest/globals';
import { cadenaAlta, cadenaAnulacion, esHuella, huella } from '../services/verifactu/huella';
import { centimos, formatearImporte } from '../services/verifactu/formato';

const CASO_1 = 'IDEmisorFactura=89890001K&NumSerieFactura=12345678/G33&FechaExpedicionFactura=01-01-2024&TipoFactura=F1&CuotaTotal=12.35&ImporteTotal=123.45&Huella=&FechaHoraHusoGenRegistro=2024-01-01T19:20:30+01:00';
const HUELLA_1 = '3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60';
const CASO_2 =
  'IDEmisorFactura=89890001K&NumSerieFactura=12345679/G34&FechaExpedicionFactura=01-01-2024&TipoFactura=F1&CuotaTotal=12.35&ImporteTotal=123.45&Huella=3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60&FechaHoraHusoGenRegistro=2024-01-01T19:20:35+01:00';
const HUELLA_2 = 'F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97';
const CASO_3 =
  'IDEmisorFacturaAnulada=89890001K&NumSerieFacturaAnulada=12345679/G34&FechaExpedicionFacturaAnulada=01-01-2024&Huella=F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97&FechaHoraHusoGenRegistro=2024-01-01T19:20:40+01:00';
const HUELLA_3 = '177547C0D57AC74748561D054A9CEC14B4C4EA23D1BEFD6F2E69E3A388F90C68';

const alta1 = {
  idEmisor: '89890001K',
  numSerie: '12345678/G33',
  fecha: '01-01-2024',
  tipoFactura: 'F1',
  cuotaTotal: '12.35',
  importeTotal: '123.45',
  huellaAnterior: '',
  fechaHoraHuso: '2024-01-01T19:20:30+01:00',
};

describe('Ejemplos oficiales (huella v0.1.2, apartado 6)', () => {
  it('6.1 alta, primer registro: cadena y huella', () => {
    const c = cadenaAlta(alta1);
    expect(c).toBe(CASO_1);
    expect(huella(c)).toBe(HUELLA_1);
  });

  it('6.2 alta encadenada a la anterior', () => {
    const c = cadenaAlta({ ...alta1, numSerie: '12345679/G34', huellaAnterior: HUELLA_1, fechaHoraHuso: '2024-01-01T19:20:35+01:00' });
    expect(c).toBe(CASO_2);
    expect(huella(c)).toBe(HUELLA_2);
  });

  it('6.3 anulación encadenada', () => {
    const c = cadenaAnulacion({ idEmisor: '89890001K', numSerie: '12345679/G34', fecha: '01-01-2024', huellaAnterior: HUELLA_2, fechaHoraHuso: '2024-01-01T19:20:40+01:00' });
    expect(c).toBe(CASO_3);
    expect(huella(c)).toBe(HUELLA_3);
  });
});

describe('Reglas de la cadena', () => {
  it('se quitan los espacios del principio y del final; los de en medio se quedan', () => {
    const con = cadenaAlta({ ...alta1, numSerie: '  12345678 / G33 ' });
    const sin = cadenaAlta({ ...alta1, numSerie: '12345678 / G33' });
    expect(con).toBe(sin);
    expect(con).toContain('NumSerieFactura=12345678 / G33&');
    expect(huella(con)).toBe(huella(sin));
  });

  it('un campo vacío o ausente queda como «nombre=»', () => {
    expect(cadenaAlta(alta1)).toContain('&Huella=&FechaHoraHusoGenRegistro=');
    expect(cadenaAlta({ ...alta1, cuotaTotal: null as unknown as string })).toContain('&CuotaTotal=&ImporteTotal=');
  });

  it('la huella tiene 64 caracteres, todos en [0-9A-F]', () => {
    for (const h of [HUELLA_1, huella(''), huella('ñandú €'), huella(CASO_2)]) {
      expect(h).toHaveLength(64);
      expect(esHuella(h)).toBe(true);
    }
    expect(esHuella(HUELLA_1.toLowerCase())).toBe(false);
    expect(esHuella(HUELLA_1.slice(1))).toBe(false);
  });

  it('«123.1» y «123.10» dan huellas distintas: por eso el importe sale siempre de formatearImporte', () => {
    const a = huella(cadenaAlta({ ...alta1, importeTotal: '123.1' }));
    const b = huella(cadenaAlta({ ...alta1, importeTotal: '123.10' }));
    expect(a).not.toBe(b);
    expect(formatearImporte(centimos(123.1))).toBe('123.10');
  });

  it('UTF-8: un carácter no ASCII cambia la huella respecto a su equivalente ASCII', () => {
    expect(huella(cadenaAlta({ ...alta1, numSerie: 'Ñ-1' }))).not.toBe(huella(cadenaAlta({ ...alta1, numSerie: 'N-1' })));
  });
});
