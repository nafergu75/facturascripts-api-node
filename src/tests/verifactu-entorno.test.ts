// Que emisiones llevan registro de VERI*FACTU y en que entorno (tabla de
// verdad de entornoDeRegistro), la comprobacion de la cadena y la lectura de la
// instantanea de la emision. Puro, sin BD.
import { describe, it, expect } from '@jest/globals';
import { entornoDeRegistro, type DatosEntornoRegistro } from '../services/verifactu/registro.service';
import { comprobarCadena, type RegistroCadena } from '../services/verifactu/cadena';
import { cadenaAlta, cadenaAnulacion, huella } from '../services/verifactu/huella';
import { leerInstantanea } from '../services/verifactu/instantanea';

const AHORA = new Date('2027-01-04T10:00:00Z');
const PRUEBAS = { estado: 'PRUEBAS', entorno: 'PRUEBAS', activaDesde: null, motivoExclusion: null };
const base: DatosEntornoRegistro = { espanola: true, sii: false, config: PRUEBAS, origen: 'pantalla', tipoOperacion: 'NACIONAL', estadoDocumento: 'FINAL' };
const e = (cambios: Partial<DatosEntornoRegistro>) => entornoDeRegistro({ ...base, ...cambios }, AHORA);

describe('entornoDeRegistro', () => {
  it('PRUEBAS: siempre en el entorno de pruebas (desde activaDesde si la hay)', () => {
    expect(e({})).toBe('PRUEBAS');
    expect(e({ config: { ...PRUEBAS, entorno: 'PRODUCCION' } })).toBe('PRUEBAS');
    expect(e({ config: { ...PRUEBAS, activaDesde: new Date('2027-01-01T00:00:00Z') } })).toBe('PRUEBAS');
    expect(e({ config: { ...PRUEBAS, activaDesde: new Date('2027-02-01T00:00:00Z') } })).toBeNull();
  });

  it('ACTIVO: en su entorno, solo desde activaDesde', () => {
    const activo = { estado: 'ACTIVO', entorno: 'PRODUCCION', activaDesde: new Date('2026-12-31T23:00:00Z'), motivoExclusion: null };
    expect(e({ config: activo })).toBe('PRODUCCION');
    expect(e({ config: { ...activo, entorno: 'PRUEBAS' } })).toBe('PRUEBAS');
    expect(e({ config: { ...activo, activaDesde: new Date('2027-02-01T00:00:00Z') } })).toBeNull();
    expect(e({ config: { ...activo, activaDesde: null } })).toBeNull();
    expect(e({ config: { ...activo, entorno: 'OTRO' } })).toBeNull();
  });

  it('sin configuración o DESACTIVADO: no', () => {
    expect(e({ config: null })).toBeNull();
    expect(e({ config: { ...PRUEBAS, estado: 'DESACTIVADO' } })).toBeNull();
  });

  it('empresa extranjera, SII aprobado o foral: no', () => {
    expect(e({ espanola: false })).toBeNull();
    expect(e({ config: { ...PRUEBAS, motivoExclusion: 'FORAL' } })).toBeNull();
    expect(e({ sii: true, config: { ...PRUEBAS, motivoExclusion: 'SII' } })).toBeNull();
    // El SII marcado sin la exclusion aprobada (o la exclusion sin el SII) no deja fuera.
    expect(e({ sii: true })).toBe('PRUEBAS');
    expect(e({ config: { ...PRUEBAS, motivoExclusion: 'SII' } })).toBe('PRUEBAS');
  });

  it('solo las facturas FINAL que expide la app (pantalla, api, copia)', () => {
    expect(e({ origen: 'api' })).toBe('PRUEBAS');
    expect(e({ origen: 'copia' })).toBe('PRUEBAS');
    expect(e({ origen: 'lector' })).toBeNull();
    expect(e({ origen: null })).toBeNull();
    expect(e({ estadoDocumento: 'BORRADOR' })).toBeNull();
    expect(e({ estadoDocumento: 'PROFORMA' })).toBeNull();
    expect(e({ tipoOperacion: 'EMPRESA_EXTRANJERA' })).toBeNull();
  });
});

function cadenaDe(n: number): RegistroCadena[] {
  const out: RegistroCadena[] = [];
  for (let i = 1; i <= n; i++) {
    const anterior = out[i - 2] ?? null;
    const r = {
      id: `r${i}`,
      numeroEnCadena: i,
      registroAnteriorId: anterior?.id ?? null,
      tipo: i === n && n > 2 ? 'ANULACION' : 'ALTA',
      idEmisor: 'A10952364',
      numSerie: `A-${i}`,
      fechaExpedicion: '04-01-2027',
      tipoFactura: 'F1',
      cuotaTotal: '21.00',
      importeTotal: '121.00',
      fechaHoraHuso: `2027-01-04T11:00:0${i}+01:00`,
      huellaAnterior: anterior?.huella ?? null,
      huella: '',
    };
    r.huella = huella(
      r.tipo === 'ANULACION'
        ? cadenaAnulacion({ idEmisor: r.idEmisor, numSerie: r.numSerie, fecha: r.fechaExpedicion, huellaAnterior: r.huellaAnterior ?? '', fechaHoraHuso: r.fechaHoraHuso })
        : cadenaAlta({ ...r, fecha: r.fechaExpedicion, huellaAnterior: r.huellaAnterior ?? '', tipoFactura: 'F1', cuotaTotal: '21.00', importeTotal: '121.00' }),
    );
    out.push(r);
  }
  return out;
}

describe('comprobarCadena', () => {
  it('una cadena bien hecha (con una anulación al final) no tiene problemas', () => {
    expect(comprobarCadena(cadenaDe(4))).toEqual([]);
    expect(comprobarCadena([])).toEqual([]);
  });

  it('detecta huecos, enlaces rotos, huellas cambiadas y horas que van hacia atrás', () => {
    const c = cadenaDe(3);
    expect(comprobarCadena([c[0], c[2]])).toEqual(expect.arrayContaining([expect.stringMatching(/Hueco/)]));
    expect(comprobarCadena([c[0], { ...c[1], huellaAnterior: c[2].huella }, c[2]])).toEqual(expect.arrayContaining([expect.stringMatching(/huella anterior/)]));
    expect(comprobarCadena([c[0], { ...c[1], importeTotal: '122.00' }, c[2]])).toEqual(expect.arrayContaining([expect.stringMatching(/no coincide/)]));
    expect(comprobarCadena([c[0], { ...c[1], registroAnteriorId: 'otro' }, c[2]])).toEqual(expect.arrayContaining([expect.stringMatching(/no apunta/)]));
    const atras = cadenaDe(2);
    atras[1] = { ...atras[1], fechaHoraHuso: '2027-01-04T10:59:59+01:00' };
    expect(comprobarCadena(atras)).toEqual(expect.arrayContaining([expect.stringMatching(/anterior a la/)]));
  });
});

describe('leerInstantanea', () => {
  const buena = {
    v: 1,
    emisor: { denominacion: 'Mi Empresa SL', nif: 'B12345674', domicilioSocial: null, codigoPostal: '46001', municipio: 'Valencia', provincia: 'Valencia', pais: 'ES', telefono: null, email: null, web: null, inscripcion: null },
    cliente: { nombreFiscal: 'Cliente SL', nifCif: 'B12345674', direccion: 'Calle 1', cp: '46001', municipio: null, provincia: null, pais: 'ES' },
  };

  it('la válida se devuelve tal cual; lo que no tiene la forma, null', () => {
    expect(leerInstantanea(buena)).toEqual(buena);
    expect(leerInstantanea(null)).toBeNull();
    expect(leerInstantanea({ ...buena, v: 2 })).toBeNull();
    expect(leerInstantanea({ ...buena, cliente: { ...buena.cliente, nombreFiscal: 3 } })).toBeNull();
    expect(leerInstantanea({ ...buena, emisor: null })).toBeNull();
    expect(leerInstantanea([buena])).toBeNull();
  });
});
