/**
 * Test dorado del modelo 115: el fichero que se importa en la sede, campo a
 * campo, contra la tabla del diseño oficial (DR115e15v13.xls, transcrito en
 * src/domain/aeat/dr115-v13.json). Caso real: dos alquileres de local (dos
 * arrendadores) en el trimestre, con la retencion del 19 %.
 */
import { describe, it, expect } from '@jest/globals';
import { generarFicheroModelo115 } from '../services/impuestosExport.service';
import { generarFichero115Validado } from '../aeat';
import { CAMPOS_115_DR11501 } from '../aeat/modelo115/modelo115.diseno';
import { casillasAGuardadas, casillasDeGuardadas, construirDeclaracion, ficheroDeclaracion, formularioDeclaracion, opcionesDeGuardadas } from '../services/aeatRetenciones/declaracion';
import { DR115, registroDr } from '../services/aeatRetenciones/diseno';
import type { DatosModelo115, PeriodoFiscal } from '../domain/impuestos.model';
import { cents, comprobarRegistro, comprobarTablaDiseno } from './aeat-dorado';

const CAB = registroDr(DR115, 'cabecera');
const PAG = registroDr(DR115, 'DR11501');
const CIE = registroDr(DR115, 'cierre');
const partes = (f: string) => ({ cab: f.slice(0, 328), pag: f.slice(328, 828), cie: f.slice(828) });
const EMPRESA = 'B12345674';
const periodo: PeriodoFiscal = { ejercicio: 2027, periodo: '1T', tipo: 'trimestral', fechaInicio: '2027-01-01', fechaFin: '2027-03-31' };

/** 1T de 2027: local (1.250 €/mes) y almacen (480 €/mes), retencion del 19 %. */
function datosReales(): DatosModelo115 {
  const meses = 3;
  const local = { base: 1250 * meses, retencion: 237.5 * meses };
  const almacen = { base: 480 * meses, retencion: 91.2 * meses };
  const c = (v: number) => Math.round(v * 100);
  const base = (c(local.base) + c(almacen.base)) / 100;
  const ret = (c(local.retencion) + c(almacen.retencion)) / 100;
  return { periodo, nPerceptores: 2, baseRetenciones: base, retenciones: ret, resultadoAnteriores: 0, resultadoIngresar: ret };
}

describe('115: tabla del diseño oficial (DR115e15v13.xls)', () => {
  it('cabecera 328 + pagina DR11501 500 + cierre 18, 22 campos en la pagina', () => {
    comprobarTablaDiseno(DR115);
    expect(PAG.campos).toHaveLength(22);
    const pos = Object.fromEntries(PAG.campos.filter((c) => c.casilla).map((c) => [c.casilla, [c.pos, c.lon]]));
    expect(pos).toEqual({ '01': [109, 15], '02': [124, 17], '03': [141, 17], '04': [158, 17], '05': [175, 17] });
  });

  it('la capa src/aeat documenta las mismas posiciones (denominacion de 60 y nombre de 20)', () => {
    for (const c of CAMPOS_115_DR11501) {
      const oficial = PAG.campos.find((x) => x.pos === c.posicionInicio);
      expect({ campo: c.nombre, lon: oficial?.lon }).toEqual({ campo: c.nombre, lon: c.longitud });
    }
  });

  it('el comprobador detecta un campo fuera de su sitio', () => {
    const f = generarFicheroModelo115(EMPRESA, periodo, datosReales(), { razonSocial: 'Ifbiosoluciones SL' });
    const movido = partes(f).pag.slice(0, 108) + ' ' + partes(f).pag.slice(108, 499);
    expect(() => comprobarRegistro(movido, PAG)).toThrow();
  });
});

describe('115: alquileres del trimestre (caso real)', () => {
  const datos = datosReales();

  it('cada campo en su posicion, con su tipo y su valor', () => {
    const f = generarFicheroModelo115(EMPRESA, periodo, datos, { razonSocial: 'Ifbiosoluciones, S.L.' });
    expect(f).toHaveLength(846);
    const { cab, pag, cie } = partes(f);
    comprobarRegistro(cab, CAB, { ejercicio: '2027', periodo: '1T', versionPrograma: '0101' });
    comprobarRegistro(pag, PAG, {
      tipoDeclaracion: 'I',
      nif: EMPRESA,
      apellidosODenominacion: 'IFBIOSOLUCIONES S L'.padEnd(60, ' '),
      nombre: ' '.repeat(20),
      ejercicio: '2027',
      periodo: '1T',
      '01': '000000000000002',
      '02': cents(5190, 17),
      '03': cents(986.1, 17),
      '04': '0'.repeat(17),
      '05': cents(986.1, 17),
      complementaria: ' ',
      justificanteAnterior: ' '.repeat(13),
      iban: ' '.repeat(34),
    });
    comprobarRegistro(cie, CIE, { ejercicio: '2027', periodo: '1T' });
    expect(cie).toBe('</T115020271T0000>');
  });

  it('mensual (gran empresa): periodo 01 a 12', () => {
    const f = generarFicheroModelo115(EMPRESA, { ...periodo, periodo: '03', tipo: 'mensual' }, datos, { razonSocial: 'Ifbiosoluciones SL' });
    comprobarRegistro(partes(f).pag, PAG, { periodo: '03' });
  });

  it('sin alquileres: declaracion negativa (N)', () => {
    const vacio: DatosModelo115 = { periodo, nPerceptores: 0, baseRetenciones: 0, retenciones: 0, resultadoAnteriores: 0, resultadoIngresar: 0 };
    comprobarRegistro(partes(generarFicheroModelo115(EMPRESA, periodo, vacio, { razonSocial: 'X SL' })).pag, PAG, { tipoDeclaracion: 'N', '05': '0'.repeat(17) });
  });

  it('casillas editadas a mano: el fichero lleva lo que se ve en pantalla', () => {
    const guardadas = { ...casillasAGuardadas('115', { '01': 2, '02': 5190, '03': 990, '04': 0, '05': 990 }), config_nif: EMPRESA, config_razon_social: 'Ifbiosoluciones SL', config_iban: 'ES9121000418450200051332', opcion_forma_pago: 'U' };
    const decl = construirDeclaracion('115', { nif: EMPRESA, denominacion: 'Ifbiosoluciones SL', ejercicio: 2027, periodo: '1T', casillas: casillasDeGuardadas('115', guardadas), opciones: opcionesDeGuardadas(guardadas) });
    comprobarRegistro(partes(ficheroDeclaracion(decl)).pag, PAG, { '03': cents(990, 17), '05': cents(990, 17), tipoDeclaracion: 'U', iban: 'ES9121000418450200051332'.padEnd(34, ' ') });
    const form = formularioDeclaracion(decl);
    expect(form.bloques[0].filas.map((f) => f.casillas[0].numero)).toEqual(['01', '02', '03']);
    expect(form.total.map((t) => [t.numero, t.valor])).toEqual([
      ['04', 0],
      ['05', 990],
    ]);
    expect(form.liquidacion).toMatchObject({ tipoDeclaracion: 'U', iban: 'ES9121000418450200051332' });
  });

  it('complementaria: X en la 192, justificante en la 193 y [05] = [03] - [04]', () => {
    const decl = construirDeclaracion('115', {
      nif: EMPRESA,
      denominacion: 'Ifbiosoluciones SL',
      ejercicio: 2027,
      periodo: '1T',
      casillas: { '01': 2, '02': 5190, '03': 986.1, '04': 900, '05': 86.1 },
      opciones: { complementaria: true, justificanteAnterior: '1151234567890' },
    });
    comprobarRegistro(partes(ficheroDeclaracion(decl)).pag, PAG, { complementaria: 'X', justificanteAnterior: '1151234567890', '04': cents(900, 17), '05': cents(86.1, 17) });
  });

  it('periodo anual o importes negativos: no se genera', () => {
    expect(() => generarFicheroModelo115(EMPRESA, { ...periodo, periodo: '0A' }, datos, { razonSocial: 'X SL' })).toThrow(/periodo "0A" no es válido/);
    const neg: DatosModelo115 = { periodo, nPerceptores: 0, baseRetenciones: -1000, retenciones: -190, resultadoAnteriores: 0, resultadoIngresar: -190 };
    expect(() => generarFicheroModelo115(EMPRESA, periodo, neg, { razonSocial: 'X SL' })).toThrow(/^El 115 sale con importes negativos/);
  });

  it('capa validada (Zod): mismo fichero y rechaza el periodo anual', () => {
    const entrada = { nif: EMPRESA, razonSocial: 'Ifbiosoluciones SL', datos };
    expect(generarFichero115Validado(entrada)).toBe(generarFicheroModelo115(EMPRESA, periodo, datos, { razonSocial: 'Ifbiosoluciones SL' }));
    expect(() => generarFichero115Validado({ ...entrada, datos: { ...datos, periodo: { ...periodo, periodo: '0A' } } })).toThrow();
  });
});
