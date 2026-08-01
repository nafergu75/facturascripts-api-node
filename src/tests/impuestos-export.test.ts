import { texto, numero, importe, fecha, generarFicheroModelo111, generarFicheroModelo115, generarFicheroModelo200, generarFicheroModelo303, generarFicheroModelo347, generarFicheroModelo349, generarFicheroModelo390, envolverFichero } from '../services/impuestosExport.service';
import { DatosModelo111, DatosModelo115, DatosModelo303, DatosModelo347, DatosModelo349, DatosModelo390, PeriodoFiscal } from '../domain/impuestos.model';

describe('Helpers de formato BOE', () => {
  it('texto alinea a la izquierda y rellena/trunca', () => {
    expect(texto('ABC', 5)).toBe('ABC  ');
    expect(texto('ABCDEF', 3)).toBe('ABC');
  });
  it('numero alinea a la derecha con ceros', () => {
    expect(numero(42, 5)).toBe('00042');
  });
  it('importe en centimos (positivo todo digitos, negativo con N)', () => {
    expect(importe(363, 10)).toBe('0000036300'); // 363,00 -> 36300 centimos
    expect(importe(-12.5, 8)).toBe('N0001250'); // 12,50 -> 1250 centimos, negativo
  });
  it('fecha yyyy-mm-dd -> ddmmyyyy', () => {
    expect(fecha('2026-06-10')).toBe('10062026');
  });
});

describe('generarFicheroModelo303', () => {
  it('produce el registro de pagina 01 (1581 chars) con tag y casillas en su posicion', () => {
    const periodo: PeriodoFiscal = { ejercicio: 2026, periodo: '2T', tipo: 'trimestral', fechaInicio: '2026-04-01', fechaFin: '2026-06-30' };
    const datos: DatosModelo303 = {
      periodo,
      ivaDevengado: [{ tipo: 21, base: 300, cuota: 63 }], totalBaseDevengada: 300, totalCuotaDevengada: 63,
      ivaDeducible: [], totalBaseDeducible: 0, totalCuotaDeducible: 0,
      resultado: 63, casillas: {},
    };
    const fichero = generarFicheroModelo303('B12345678', periodo, datos);
    expect(fichero.length).toBe(1581 + 2); // registro + CRLF
    expect(fichero.startsWith('<T303')).toBe(true);
    expect(fichero.endsWith('</T30301000>\r\n')).toBe(true);
    // NIF en posicion 14 (len 9)
    expect(fichero.slice(13, 22)).toBe('B12345678');
    // Ejercicio (pos 103) y periodo (pos 107)
    expect(fichero.slice(102, 106)).toBe('2026');
    expect(fichero.slice(106, 108)).toBe('2T');
    // [01] base (pos 209), [02] tipo% (pos 226), [03] cuota (pos 231)
    expect(fichero.slice(208, 225)).toBe('00000000000030000'); // 300,00 €
    expect(fichero.slice(225, 230)).toBe('02100'); // 21,00 %
    expect(fichero.slice(230, 247)).toBe('00000000000006300'); // 63,00 €
    // [27] total cuota devengada (pos 696)
    expect(fichero.slice(695, 712)).toBe('00000000000006300');
  });
});

describe('generarFicheroModelo347', () => {
  it('tipo 1 declarante + tipo 2 por tercero, registros de 500 chars', () => {
    const datos: DatosModelo347 = {
      ejercicio: 2026,
      umbral: 3005.06,
      operaciones: [
        { cifnif: 'B11111111', nombre: 'Cliente Uno', tipo: 'cliente', baseAnual: 5000 },
        { cifnif: 'A22222222', nombre: 'Prov Dos', tipo: 'proveedor', baseAnual: 4000 },
      ],
    };
    const f = generarFicheroModelo347('B12345678', 2026, datos, 'MI EMPRESA SL');
    const regs = f.split('\r\n').filter((r) => r.length);
    expect(regs).toHaveLength(3);
    expect(regs.every((r) => r.length === 500)).toBe(true);
    expect(regs[0].startsWith('1347')).toBe(true);
    expect(regs[0].slice(135, 144)).toBe('000000002'); // nº personas (pos 136, len 9)
    expect(regs[1].startsWith('2347')).toBe(true);
    expect(regs[1].slice(17, 26)).toBe('B11111111'); // NIF declarado (pos 18)
    expect(regs[1].slice(81, 82)).toBe('B'); // clave operacion cliente (pos 82)
    expect(regs[1].slice(82, 98)).toBe(' 000000000500000'); // importe 5000 (pos 83, signo+15)
    expect(regs[2].slice(81, 82)).toBe('A'); // proveedor
  });
});

describe('envolverFichero (cabecera + paginas + cierre)', () => {
  it('cabecera 328 + contenido + cierre 18, con tag/ejercicio/periodo', () => {
    const f = envolverFichero('303', 2026, '2T', 'PAGINAS', { versionPrograma: '0101' });
    expect(f.startsWith('<T303')).toBe(true);
    expect(f.slice(6, 10)).toBe('2026'); // ejercicio pos 7
    expect(f.slice(10, 12)).toBe('2T'); // periodo pos 11
    expect(f.slice(92, 96)).toBe('0101'); // version programa pos 93
    expect(f.includes('PAGINAS')).toBe(true);
    const sinCrlf = f.replace(/\r\n$/, '');
    expect(sinCrlf.length).toBe(328 + 'PAGINAS'.length + 18);
    expect(sinCrlf.slice(-18).startsWith('</T303')).toBe(true);
  });
});

describe('generarFicheroModelo111', () => {
  it('cabecera <AUX> + pagina M11101 (1000), casillas en su posicion', () => {
    const periodo: PeriodoFiscal = { ejercicio: 2026, periodo: '2T', tipo: 'trimestral', fechaInicio: '2026-04-01', fechaFin: '2026-06-30' };
    const datos: DatosModelo111 = {
      periodo, nPerceptoresTrabajo: 3, percepcionesTrabajo: 9000,
      retencionesTrabajo: 1350, totalRetenciones: 1350, resultadoIngresar: 1350,
    };
    const f = generarFicheroModelo111('B12345678', periodo, datos, { denominacion: 'MI EMPRESA SL' });
    const sinCrlf = f.replace(/\r\n$/, '');
    expect(sinCrlf.length).toBe(328 + 1000 + 18);
    expect(sinCrlf.startsWith('<T1110')).toBe(true); // cabecera <T+111+0
    expect(sinCrlf.slice(6, 10)).toBe('2026'); // ejercicio (cabecera pos 7)
    expect(sinCrlf.slice(17, 22)).toBe('<AUX>'); // pos 18
    expect(sinCrlf.slice(-18)).toBe('</T1110' + '2026' + '2T' + '0000>'); // cierre

    const pagina = sinCrlf.slice(328, 328 + 1000);
    expect(pagina.startsWith('<T11101000>')).toBe(true);
    expect(pagina.slice(13, 22)).toBe('B12345678'); // NIF (pos 14)
    expect(pagina.slice(108, 116)).toBe('00000003'); // nº perceptores (pos 109, len 8)
    expect(pagina.slice(116, 133)).toBe('00000000000900000'); // percepciones 9000 (pos 117)
    expect(pagina.slice(133, 150)).toBe('00000000000135000'); // retenciones 1350 (pos 134)
    expect(pagina.slice(520, 537)).toBe('00000000000135000'); // resultado a ingresar (pos 521)
    expect(pagina.slice(988, 1000)).toBe('</T11101000>'); // cierre pagina (pos 989)
  });
});

describe('generarFicheroModelo200', () => {
  it('cabecera <AUX> + pagina identificacion DP200001 (627)', () => {
    const f = generarFicheroModelo200('B12345678', 2026, { razonSocial: 'MI EMPRESA SL' });
    const sinCrlf = f.replace(/\r\n$/, '');
    expect(sinCrlf.length).toBe(328 + 627 + 18);
    expect(sinCrlf.startsWith('<T200020260A0000>')).toBe(true); // tag cabecera (17)
    expect(sinCrlf.slice(17, 22)).toBe('<AUX>');
    expect(sinCrlf.slice(-18)).toBe('</T200020260A0000>');
    const pagina = sinCrlf.slice(328, 328 + 627);
    expect(pagina.startsWith('<T20001000>')).toBe(true);
    expect(pagina.slice(13, 22)).toBe('B12345678'); // NIF @14
    expect(pagina.slice(102, 106)).toBe('2026'); // ejercicio @103
    expect(pagina.slice(106, 108)).toBe('0A'); // periodo @107
    expect(pagina.slice(615, 627)).toBe('</T20001000>'); // cierre @616
  });
});

describe('generarFicheroModelo115', () => {
  it('cabecera <AUX> + pagina (500) = 846, casillas en su posicion', () => {
    const periodo: PeriodoFiscal = { ejercicio: 2026, periodo: '2T', tipo: 'trimestral', fechaInicio: '2026-04-01', fechaFin: '2026-06-30' };
    const datos: DatosModelo115 = { periodo, nPerceptores: 2, baseRetenciones: 5000, retenciones: 950, resultadoAnteriores: 0, resultadoIngresar: 950 };
    const f = generarFicheroModelo115('B12345678', periodo, datos, { razonSocial: 'MI EMPRESA SL' });
    const sinCrlf = f.replace(/\r\n$/, '');
    expect(sinCrlf.length).toBe(328 + 500 + 18);
    expect(sinCrlf.startsWith('<T1150')).toBe(true);
    expect(sinCrlf.slice(-18)).toBe('</T1150' + '2026' + '2T' + '0000>');
    const pagina = sinCrlf.slice(328, 328 + 500);
    expect(pagina.startsWith('<T11501000>')).toBe(true);
    expect(pagina.slice(13, 22)).toBe('B12345678'); // NIF @14
    expect(pagina.slice(108, 123)).toBe('000000000000002'); // [01] perceptores @109 (15)
    expect(pagina.slice(123, 140)).toBe('00000000000500000'); // [02] base 5000 @124
    expect(pagina.slice(140, 157)).toBe('00000000000095000'); // [03] retenciones 950 @141
    expect(pagina.slice(174, 191)).toBe('00000000000095000'); // [05] a ingresar 950 @175
    expect(pagina.slice(488, 500)).toBe('</T11501000>'); // cierre @489
  });
});

describe('generarFicheroModelo349', () => {
  it('tipo 1 declarante + tipo 2 por operador intracomunitario (500 chars)', () => {
    const periodo: PeriodoFiscal = { ejercicio: 2026, periodo: '2T', tipo: 'trimestral', fechaInicio: '2026-04-01', fechaFin: '2026-06-30' };
    const datos: DatosModelo349 = {
      periodo,
      operaciones: [{ cifnif: 'FR12345678901', nombre: 'Client FR', clave: 'E', base: 2000 }],
      totalBase: 2000,
    };
    const f = generarFicheroModelo349('B12345678', periodo, datos, 'MI EMPRESA SL');
    const regs = f.split('\r\n').filter((r) => r.length);
    expect(regs).toHaveLength(2);
    expect(regs.every((r) => r.length === 500)).toBe(true);
    expect(regs[0].startsWith('1349')).toBe(true);
    expect(regs[0].slice(135, 137)).toBe('2T'); // periodo (pos 136)
    expect(regs[0].slice(137, 146)).toBe('000000001'); // nº operadores (pos 138)
    expect(regs[0].slice(146, 161)).toBe('000000000200000'); // importe operaciones (pos 147, len 15)
    expect(regs[1].startsWith('2349')).toBe(true);
    expect(regs[1].slice(75, 92)).toBe('FR12345678901    '); // NIF operador (pos 76, len 17)
    expect(regs[1].slice(132, 133)).toBe('E'); // clave (pos 133)
    expect(regs[1].slice(133, 146)).toBe('0000000200000'); // base imponible (pos 134, len 13)
  });
});

describe('generarFicheroModelo390', () => {
  it('paginas 01000/04000/06000 con longitudes y casillas oficiales', () => {
    const datos: DatosModelo390 = {
      ejercicio: 2026,
      resumenDevengado: [], resumenDeducible: [],
      totalCuotaDevengada: 63, totalCuotaDeducible: 0,
      resultadoAnual: 63, volumenOperaciones: 300,
    };
    const f = generarFicheroModelo390('B12345678', 2026, datos);
    const regs = f.split('\r\n').filter((r) => r.length);
    expect(regs).toHaveLength(3);
    expect(regs[0].length).toBe(1187);
    expect(regs[0].startsWith('<T39001000>')).toBe(true);
    expect(regs[0].slice(13, 22)).toBe('B12345678'); // NIF (pos 14)
    expect(regs[1].length).toBe(854);
    expect(regs[1].slice(675, 692)).toBe('00000000000006300'); // [65] resultado (pos 676)
    expect(regs[2].length).toBe(828);
    expect(regs[2].slice(649, 666)).toBe('00000000000030000'); // [108] total volumen (pos 650)
  });
});
