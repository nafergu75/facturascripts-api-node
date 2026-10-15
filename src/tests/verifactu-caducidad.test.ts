/**
 * Aviso de caducidad del certificado de VERI*FACTU (certificado.service:
 * avisoCaducidad y textoAvisoCaducidad), sin BD: los dias se cuentan
 * naturales y en hora de Madrid, para que «hoy» y «mañana» casen con la fecha
 * que va al lado, y el texto solo dice lo que pasa (la salida la pone cada
 * pantalla segun quien la ve).
 */
import { avisoCaducidad, textoAvisoCaducidad } from '../services/verifactu/certificado.service';

/** Instante a una hora de Madrid en octubre de 2026 (horario de verano, UTC+2). */
const madrid = (dia: string, hora: string) => new Date(`2026-10-${dia}T${hora}:00+02:00`);

describe('aviso de caducidad del certificado', () => {
  it('caduca mañana a las 9 y son las 12: «mañana», no «hoy»', () => {
    const ahora = madrid('15', '12:00');
    expect(avisoCaducidad(madrid('16', '09:00'), ahora)).toEqual({ dias: 1, aviso: 'CADUCA_7' });
    expect(textoAvisoCaducidad(madrid('16', '09:00'), ahora)).toEqual({ nivel: 'urgente', texto: 'El certificado de VERI*FACTU caduca mañana (16-10-2026).' });
  });

  it('con 47 horas de margen es pasado mañana: «en 2 días», con su fecha', () => {
    expect(textoAvisoCaducidad(madrid('17', '09:00'), madrid('15', '10:00'))?.texto).toBe('El certificado de VERI*FACTU caduca en 2 días (17-10-2026).');
  });

  it('hoy mas tarde: «hoy»; pasado el instante: caducado', () => {
    expect(textoAvisoCaducidad(madrid('15', '23:30'), madrid('15', '00:10'))?.texto).toBe('El certificado de VERI*FACTU caduca hoy (15-10-2026).');
    expect(textoAvisoCaducidad(madrid('15', '09:00'), madrid('15', '09:00'))).toEqual({ nivel: 'caducado', texto: 'El certificado de VERI*FACTU caducó el 15-10-2026.' });
  });

  it('a medianoche de Madrid (22:30 UTC del dia anterior) cuenta el dia de Madrid', () => {
    // 15-10 a las 00:30 de Madrid son las 22:30 UTC del 14-10.
    expect(avisoCaducidad(madrid('16', '00:30'), madrid('15', '00:30')).dias).toBe(1);
    expect(avisoCaducidad(madrid('15', '23:59'), madrid('15', '00:01')).dias).toBe(0);
  });

  it('niveles: 30 dias o menos, aviso; 7 o menos, urgente; mas de 30, nada', () => {
    const ahora = madrid('01', '12:00');
    expect(avisoCaducidad(new Date('2026-11-01T08:00:00+01:00'), ahora)).toEqual({ dias: 31, aviso: null });
    expect(avisoCaducidad(madrid('31', '08:00'), ahora)).toEqual({ dias: 30, aviso: 'CADUCA_30' });
    expect(avisoCaducidad(madrid('08', '23:00'), ahora)).toEqual({ dias: 7, aviso: 'CADUCA_7' });
    expect(avisoCaducidad(madrid('09', '00:30'), ahora)).toEqual({ dias: 8, aviso: 'CADUCA_30' });
  });

  it('el texto no manda a ninguna pantalla: eso lo pone cada una segun quien la ve', () => {
    for (const ahora of [madrid('01', '12:00'), madrid('14', '12:00'), madrid('20', '12:00')]) {
      expect(textoAvisoCaducidad(madrid('15', '12:00'), ahora)?.texto).not.toMatch(/Configuración|Sube|Renuévalo/);
    }
  });
});
