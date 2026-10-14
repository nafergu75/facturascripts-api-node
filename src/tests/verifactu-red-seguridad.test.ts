// Red de seguridad de VERI*FACTU (spec verifactu, apartado 9): la regla pura.
// Desde el 1-1-2027, hora de Madrid, una empresa española sin VERI*FACTU activo
// no emite facturas. La prueba con la base de datos y las rutas esta en
// verifactu-red-seguridad.db.test.ts.
import { describe, it, expect } from '@jest/globals';
import {
  certificadoVigenteEn,
  evaluarRedSeguridad,
  inicioRedSeguridad,
  verifactuActivo,
  validarReferenciaBoe,
  type DatosRedSeguridad,
} from '../services/verifactu/redSeguridad';

// 31-12-2026 23:59:59 en Madrid (invierno, +01:00) y el 1-1-2027 a las 00:00.
const ULTIMO_SEGUNDO_2026 = new Date('2026-12-31T22:59:59Z');
const PRIMER_INSTANTE_2027 = new Date('2026-12-31T23:00:00Z');

const base: DatosRedSeguridad = {
  espanola: true,
  tipoSociedad: 'SL',
  sii: false,
  config: null,
  redActiva: true,
  certificadoVigente: false,
};
const con = (cambios: Partial<DatosRedSeguridad>): DatosRedSeguridad => ({ ...base, ...cambios });
const activo = (activaDesde: Date, entorno = 'PRODUCCION') => ({ estado: 'ACTIVO', entorno, activaDesde, motivoExclusion: null });

describe('red de seguridad: fecha por hora de Madrid', () => {
  it('31-12-2026 a las 23:59:59 en Madrid todavía se emite', () => {
    expect(evaluarRedSeguridad(base, ULTIMO_SEGUNDO_2026)).toEqual({ ok: true });
  });

  it('el 1-1-2027 a las 00:00 en Madrid (23:00 UTC del 31) ya bloquea, con un motivo que se entiende', () => {
    const r = evaluarRedSeguridad(base, PRIMER_INSTANTE_2027);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toMatch(/VERI\*FACTU/);
    // La fecha escrita entera: «1-1-2027» se partia en dos lineas en el aviso.
    expect(r.motivo).toMatch(/1 de enero de 2027/);
    expect(r.motivo).not.toMatch(/1-1-2027/);
  });

  it('sin configuración de VERI*FACTU se trata como «no activo»', () => {
    expect(evaluarRedSeguridad(con({ config: null }), PRIMER_INSTANTE_2027).ok).toBe(false);
  });
});

describe('red de seguridad: exclusiones', () => {
  it('empresa extranjera (EE. UU., Hong Kong): nunca bloquea', () => {
    expect(evaluarRedSeguridad(con({ espanola: false }), PRIMER_INSTANTE_2027)).toEqual({ ok: true });
  });

  it('marcar el SII en los ajustes fiscales no abre la red: hace falta la exclusión aprobada por un administrador', () => {
    expect(evaluarRedSeguridad(con({ sii: true }), PRIMER_INSTANTE_2027).ok).toBe(false);
    expect(evaluarRedSeguridad(con({ sii: true, config: null }), PRIMER_INSTANTE_2027).ok).toBe(false);
  });

  it('exclusión SII aprobada y con el SII marcado en los ajustes fiscales: no bloquea', () => {
    const config = { estado: 'DESACTIVADO', entorno: 'PRUEBAS', activaDesde: null, motivoExclusion: 'SII' };
    expect(evaluarRedSeguridad(con({ sii: true, config }), PRIMER_INSTANTE_2027)).toEqual({ ok: true });
  });

  it('exclusión SII aprobada pero con el SII desmarcado después en los ajustes fiscales: vuelve a bloquear', () => {
    const config = { estado: 'DESACTIVADO', entorno: 'PRUEBAS', activaDesde: null, motivoExclusion: 'SII' };
    expect(evaluarRedSeguridad(con({ sii: false, config }), PRIMER_INSTANTE_2027).ok).toBe(false);
  });

  it('exclusión FORAL aprobada: no bloquea', () => {
    const config = { estado: 'DESACTIVADO', entorno: 'PRUEBAS', activaDesde: null, motivoExclusion: 'FORAL' };
    expect(evaluarRedSeguridad(con({ config }), PRIMER_INSTANTE_2027)).toEqual({ ok: true });
  });

  it('una exclusión con un valor desconocido no cuenta: sigue bloqueando', () => {
    const config = { estado: 'DESACTIVADO', entorno: 'PRUEBAS', activaDesde: null, motivoExclusion: 'OTRO' };
    expect(evaluarRedSeguridad(con({ config }), PRIMER_INSTANTE_2027).ok).toBe(false);
  });

  it('red desactivada por el administrador global: no bloquea', () => {
    expect(evaluarRedSeguridad(con({ redActiva: false }), PRIMER_INSTANTE_2027)).toEqual({ ok: true });
  });
});

describe('red de seguridad: VERI*FACTU activo', () => {
  it('ACTIVO en producción, desde antes y con certificado vigente: se emite', () => {
    const config = activo(new Date('2026-12-31T23:00:00Z'));
    expect(evaluarRedSeguridad(con({ config, certificadoVigente: true }), PRIMER_INSTANTE_2027)).toEqual({ ok: true });
  });

  it('ACTIVO con activaDesde en el futuro: bloquea', () => {
    const config = activo(new Date('2027-01-02T00:00:00+01:00'));
    expect(evaluarRedSeguridad(con({ config, certificadoVigente: true }), PRIMER_INSTANTE_2027).ok).toBe(false);
  });

  it('certificado caducado (o sin certificado): bloquea', () => {
    const config = activo(new Date('2026-12-01T00:00:00Z'));
    expect(evaluarRedSeguridad(con({ config, certificadoVigente: false }), PRIMER_INSTANTE_2027).ok).toBe(false);
  });

  it('ACTIVO pero en el entorno de pruebas: bloquea (las pruebas no valen para facturas reales)', () => {
    const config = activo(new Date('2026-12-01T00:00:00Z'), 'PRUEBAS');
    expect(evaluarRedSeguridad(con({ config, certificadoVigente: true }), PRIMER_INSTANTE_2027).ok).toBe(false);
  });

  it('verifactuActivo: estado ACTIVO, con fecha y ya alcanzada', () => {
    const ahora = PRIMER_INSTANTE_2027;
    expect(verifactuActivo(null, ahora)).toBe(false);
    expect(verifactuActivo({ estado: 'ACTIVO', activaDesde: null }, ahora)).toBe(false);
    expect(verifactuActivo({ estado: 'PRUEBAS', activaDesde: new Date('2026-01-01T00:00:00Z') }, ahora)).toBe(false);
    expect(verifactuActivo({ estado: 'ACTIVO', activaDesde: ahora }, ahora)).toBe(true);
    expect(verifactuActivo({ estado: 'ACTIVO', activaDesde: new Date(ahora.getTime() + 1000) }, ahora)).toBe(false);
  });
});

describe('red de seguridad: autónomos', () => {
  it('una sociedad empieza el 1-1-2027 y un autónomo el 1-7-2027', () => {
    expect(inicioRedSeguridad('SA')).toBe('2027-01-01');
    expect(inicioRedSeguridad('SL')).toBe('2027-01-01');
    expect(inicioRedSeguridad(null)).toBe('2027-01-01');
    expect(inicioRedSeguridad('AUTONOMO')).toBe('2027-07-01');
  });

  it('un autónomo no se bloquea en enero de 2027 y sí desde el 1-7-2027 en Madrid', () => {
    const autonomo = con({ tipoSociedad: 'AUTONOMO' });
    expect(evaluarRedSeguridad(autonomo, PRIMER_INSTANTE_2027)).toEqual({ ok: true });
    expect(evaluarRedSeguridad(autonomo, new Date('2027-06-30T21:59:59Z')).ok).toBe(true);
    const r = evaluarRedSeguridad(autonomo, new Date('2027-06-30T22:00:00Z'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toMatch(/1 de julio de 2027/);
  });
});

describe('referencia del BOE para desactivar la red', () => {
  it('admite BOE-A-AAAA-NNNNN (con espacios o en minúsculas) y la deja normalizada', () => {
    expect(validarReferenciaBoe('BOE-A-2026-24840')).toBe('BOE-A-2026-24840');
    expect(validarReferenciaBoe('  boe-a-2027-1234 ')).toBe('BOE-A-2027-1234');
  });

  it('rechaza lo que no es una referencia del BOE', () => {
    for (const mal of ['', 'BOE-2026-24840', 'BOE-A-26-24840', 'BOE-A-2026-', 'RD 1007/2023', 'BOE-A-2026-24840x']) {
      expect(() => validarReferenciaBoe(mal)).toThrow(/BOE-A-/);
    }
  });
});

describe('red de seguridad: fase F2 (certificado y empresas de pruebas)', () => {
  it('el certificado vale entre su fecha de inicio y la de caducidad', () => {
    const cert = { validoDesde: new Date('2026-10-01T00:00:00Z'), caducaEn: new Date('2027-10-01T00:00:00Z') };
    expect(certificadoVigenteEn(cert, PRIMER_INSTANTE_2027)).toBe(true);
    expect(certificadoVigenteEn(cert, new Date('2026-09-30T23:59:59Z'))).toBe(false);
    expect(certificadoVigenteEn(cert, new Date('2027-10-01T00:00:00Z'))).toBe(false);
    expect(certificadoVigenteEn(null, PRIMER_INSTANTE_2027)).toBe(false);
  });

  it('activo en producción con certificado vigente deja emitir; sin él, no', () => {
    expect(evaluarRedSeguridad(con({ config: activo(new Date('2026-12-31T23:00:00Z')), certificadoVigente: true }), PRIMER_INSTANTE_2027)).toEqual({ ok: true });
    expect(evaluarRedSeguridad(con({ config: activo(new Date('2026-12-31T23:00:00Z')), certificadoVigente: false }), PRIMER_INSTANTE_2027).ok).toBe(false);
  });

  it('una empresa de pruebas en PRUEBAS emite después del 1-1-2027; una real en PRUEBAS, no', () => {
    const pruebas = { estado: 'PRUEBAS', entorno: 'PRUEBAS', activaDesde: null, motivoExclusion: null };
    expect(evaluarRedSeguridad(con({ config: pruebas, empresaPruebas: true }), PRIMER_INSTANTE_2027)).toEqual({ ok: true });
    expect(evaluarRedSeguridad(con({ config: pruebas, empresaPruebas: false }), PRIMER_INSTANTE_2027).ok).toBe(false);
    expect(evaluarRedSeguridad(con({ config: { ...pruebas, estado: 'DESACTIVADO' }, empresaPruebas: true }), PRIMER_INSTANTE_2027).ok).toBe(false);
  });
});
