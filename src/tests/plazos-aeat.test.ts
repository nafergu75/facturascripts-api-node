import { esDiaHabilAeat, festivosNacionales, plazoAeat, ultimoDiaFebrero } from '../domain/plazosAeat';

describe('plazoAeat: último día real de un plazo de la AEAT', () => {
  it('un día laborable se queda igual', () => {
    expect(plazoAeat('2027-01-20')).toBe('2027-01-20'); // miércoles
    expect(plazoAeat('2026-10-20')).toBe('2026-10-20'); // martes
  });

  it('sábado y domingo pasan al lunes', () => {
    expect(plazoAeat('2027-01-30')).toBe('2027-02-01'); // sábado
    expect(plazoAeat('2027-01-31')).toBe('2027-02-01'); // domingo
    expect(plazoAeat('2027-07-25')).toBe('2027-07-26'); // domingo (200 de 2026)
  });

  it('las fiestas nacionales no son hábiles', () => {
    expect(plazoAeat('2026-12-08')).toBe('2026-12-09'); // Inmaculada, martes
    expect(plazoAeat('2026-01-06')).toBe('2026-01-07'); // Reyes, martes
    expect(esDiaHabilAeat('2026-10-12')).toBe(false); // Fiesta Nacional, lunes
    expect(esDiaHabilAeat('2026-10-13')).toBe(true);
  });

  it('el Viernes Santo, que cambia cada año, tampoco', () => {
    // Pascua 2027: 28 de marzo; Viernes Santo, 26 de marzo.
    expect(festivosNacionales(2027).has('2027-03-26')).toBe(true);
    expect(plazoAeat('2027-03-26')).toBe('2027-03-29');
    // Pascua 2028: 16 de abril; Viernes Santo, 14 de abril.
    expect(esDiaHabilAeat('2028-04-14')).toBe(false);
    expect(esDiaHabilAeat('2028-04-13')).toBe(true); // Jueves Santo no es fiesta nacional
  });

  it('encadena festivo y fin de semana', () => {
    // 1-5-2027 es sábado: 3-5 lunes.
    expect(plazoAeat('2027-05-01')).toBe('2027-05-03');
    // Viernes 25-12-2026 + fin de semana: lunes 28.
    expect(plazoAeat('2026-12-25')).toBe('2026-12-28');
  });

  it('último día de febrero, también en bisiesto', () => {
    expect(ultimoDiaFebrero(2027)).toBe('2027-02-28');
    expect(ultimoDiaFebrero(2028)).toBe('2028-02-29');
  });
});
