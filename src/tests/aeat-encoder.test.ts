import { formatearCampo, construirLineaDesdeCampos, CampoDiseno } from '../aeat/common/aeat-encoder';

describe('AEAT encoder - formatearCampo', () => {
  const campoN: CampoDiseno = { nombre: 'IMPORTE', posicionInicio: 1, longitud: 10, tipo: 'N', decimales: 2 };
  const campoA: CampoDiseno = { nombre: 'NIF', posicionInicio: 1, longitud: 9, tipo: 'A' };

  it('numerico con decimales: sin separadores, ceros a la izquierda', () => {
    expect(formatearCampo(123.45, campoN)).toBe('0000012345');
    expect(formatearCampo(123.45, campoN)).toHaveLength(10);
  });
  it('numerico negativo: N en la primera posicion', () => {
    expect(formatearCampo(-12.5, campoN)).toBe('N000001250');
  });
  it('texto: blancos a la derecha y truncado si excede', () => {
    expect(formatearCampo('ABCDEFGHIJK', campoA)).toBe('ABCDEFGHI');
    expect(formatearCampo('B12', campoA)).toBe('B12      ');
  });
  it('null/undefined: ceros en numerico, blancos en texto', () => {
    expect(formatearCampo(null, campoN)).toBe('0000000000');
    expect(formatearCampo(undefined, campoA)).toBe('         ');
  });
});

describe('AEAT encoder - construirLineaDesdeCampos', () => {
  it('coloca cada campo en su posicion y respeta la longitud', () => {
    const linea = construirLineaDesdeCampos([
      { diseno: { nombre: 'CAMPO1', posicionInicio: 1, longitud: 3, tipo: 'A' }, valor: 'ABC' },
      { diseno: { nombre: 'CAMPO2', posicionInicio: 4, longitud: 2, tipo: 'N' }, valor: 5 },
    ]);
    expect(linea).toHaveLength(5);
    expect(linea).toBe('ABC05');
  });

  it('deja blancos en los huecos entre campos no contiguos', () => {
    const linea = construirLineaDesdeCampos([
      { diseno: { nombre: 'A', posicionInicio: 1, longitud: 2, tipo: 'A' }, valor: 'XY' },
      { diseno: { nombre: 'B', posicionInicio: 5, longitud: 2, tipo: 'N' }, valor: 7 },
    ]);
    expect(linea).toBe('XY  07'); // posiciones 3-4 en blanco
  });
});
