/**
 * Test "dorado" del 347: el fichero se compara campo a campo con la tabla del
 * diseño de registro OFICIAL (src/domain/aeat/dr347-2025.json, copiada del
 * 347.pdf "Ejercicio 2025 y siguientes"). Caso real: clientes y proveedores
 * por encima de 3.005,06 € con desglose trimestral, sin arrendadores ni
 * profesionales con retención (esos no van al 347).
 */
import dr347 from '../domain/aeat/dr347-2025.json';
import { agregar347 } from '../services/impuestosCalculo.service';
import { construirModelo347, declarados347Desde, DISENO_347, provincia347 } from '../aeat/oficial/modelo347';
import { validarRegistro, type PaginaOficial } from '../aeat/oficial/diseno';
import type { FacturaFiscal } from '../domain/impuestos.model';

const reg = (r: '1' | '2D' | '2I'): PaginaOficial => ({ hoja: r, longitud: 500, campos: (dr347 as any).registros[r].campos });
const campo = (linea: string, desde: number, hasta: number) => linea.slice(desde - 1, hasta);

const venta = (cifnif: string, nombre: string, fecha: string, base: number, cuota: number, extra: Partial<FacturaFiscal> = {}): FacturaFiscal => ({
  idFactura: `${cifnif}-${fecha}`,
  tipo: 'venta',
  cifnif,
  nombreTercero: nombre,
  fecha,
  operacion: 'interior',
  tipoOperacion: 'NACIONAL',
  residente: true,
  paisTercero: 'ES',
  lineas: [{ tipoIva: 21, base, cuota }],
  ...extra,
});
const compra = (cifnif: string, nombre: string, fecha: string, base: number, cuota: number, extra: Partial<FacturaFiscal> = {}): FacturaFiscal => ({
  idFactura: `${cifnif}-${fecha}`,
  tipo: 'compra',
  cifnif,
  nombreTercero: nombre,
  fecha,
  operacion: 'interior',
  lineas: [{ tipoIva: 21, base, cuota }],
  ...extra,
});

const FACTURAS: FacturaFiscal[] = [
  // Cliente con ventas en tres trimestres: 2.420 + 1.815 + 0 + 1.210 = 5.445 €.
  venta('B12345678', 'Distribuciones Turia, S.L.', '2025-02-10', 2000, 420, { cpTercero: '46001' }),
  venta('B12345678', 'Distribuciones Turia, S.L.', '2025-05-20', 1500, 315, { cpTercero: '46001' }),
  venta('B12345678', 'Distribuciones Turia, S.L.', '2025-11-03', 1000, 210, { cpTercero: '46001' }),
  // El mismo cliente con el NIF escrito de dos formas: cuenta como uno (3.630 €).
  venta('b-87654321', 'Peña y Cía, S.L.', '2025-01-15', 1500, 315, { provinciaTercero: 'Madrid' }),
  venta('B87654321', 'Peña y Cía, S.L.', '2025-03-15', 1500, 315, { provinciaTercero: 'Madrid' }),
  // Por debajo del umbral: no se declara.
  venta('B11223344', 'Pequeño Cliente SL', '2025-06-01', 2000, 420, { cpTercero: '03001' }),
  // Proveedor con una compra anulada en el 4T de otra del 3T: 3.025 €, con el 4T en negativo.
  compra('A11111111', 'Cerámicas del Mijares, S.A.', '2025-03-01', 2500, 525, { cpTercero: '12001' }),
  compra('A11111111', 'Cerámicas del Mijares, S.A.', '2025-08-01', 500, 105, { cpTercero: '12001' }),
  compra('A11111111', 'Cerámicas del Mijares, S.A.', '2025-10-05', -500, -105, { cpTercero: '12001' }),
  // Profesional con retención: va al 190, no al 347.
  {
    ...compra('12345678Z', 'Asesor Fiscal', '2025-04-01', 6000, 1260, { cpTercero: '46002' }),
    lineas: [{ tipoIva: 21, base: 6000, cuota: 1260, conRetencion: true }],
  },
];

const DECLARANTE = { nif: 'B98765432', razonSocial: 'Ifbiosoluciones, S.L.', telefono: '+34 961 23 45 67', contacto: 'García Pérez Ana', numeroIdentificativo: '3470000000001' };

describe('347 dorado: diseño oficial "Ejercicio 2025 y siguientes"', () => {
  it('la tabla del diseño cubre las 500 posiciones de cada registro sin huecos', () => {
    for (const r of ['1', '2D', '2I'] as const) {
      let pos = 1;
      for (const c of DISENO_347.registros[r].campos) {
        expect(c.pos).toBe(pos);
        pos += c.len;
      }
      expect(pos - 1).toBe(500);
    }
  });

  const datos = agregar347(FACTURAS, 2025);
  const decl = construirModelo347(2025, DECLARANTE, declarados347Desde(datos));
  const lineas = decl.fichero.split('\r\n');

  it('agrupa por NIF limpio, aplica el umbral y deja fuera al profesional con retención', () => {
    expect(datos.operaciones.map((o) => [o.cifnif, o.tipo, o.baseAnual])).toEqual([
      ['B12345678', 'cliente', 5445],
      ['B87654321', 'cliente', 3630],
      ['A11111111', 'proveedor', 3025],
    ]);
    expect(datos.operaciones[0].trimestres).toEqual([2420, 1815, 0, 1210]);
    expect(datos.operaciones[2].trimestres).toEqual([3025, 0, 605, -605]);
  });

  it('fichero: registros de 500 en CRLF, sin errores ni campos fuera del diseño', () => {
    expect(decl.errores).toEqual([]);
    expect(lineas.pop()).toBe(''); // termina en CRLF
    expect(lineas).toHaveLength(4);
    for (const l of lineas) expect(l).toHaveLength(500);
    expect(validarRegistro(reg('1'), lineas[0])).toEqual([]);
    for (const l of lineas.slice(1)) expect(validarRegistro(reg('2D'), l)).toEqual([]);
  });

  it('registro de declarante (tipo 1)', () => {
    const t1 = lineas[0];
    expect(campo(t1, 1, 1)).toBe('1');
    expect(campo(t1, 2, 4)).toBe('347');
    expect(campo(t1, 5, 8)).toBe('2025');
    expect(campo(t1, 9, 17)).toBe('B98765432');
    expect(campo(t1, 18, 57)).toBe('IFBIOSOLUCIONES SL'.padEnd(40));
    expect(campo(t1, 58, 58)).toBe('T');
    expect(campo(t1, 59, 67)).toBe('961234567');
    expect(campo(t1, 68, 107)).toBe('GARCIA PEREZ ANA'.padEnd(40));
    expect(campo(t1, 108, 120)).toBe('3470000000001');
    expect(campo(t1, 121, 122)).toBe('  ');
    expect(campo(t1, 123, 135)).toBe('0'.repeat(13)); // sin declaración anterior: CEROS
    expect(campo(t1, 136, 144)).toBe('000000003');
    expect(campo(t1, 145, 160)).toBe(' 000000001210000'); // 5.445 + 3.630 + 3.025 = 12.100,00
    expect(campo(t1, 161, 169)).toBe('000000000');
    expect(campo(t1, 170, 185)).toBe(' ' + '0'.repeat(15));
    expect(campo(t1, 186, 500).trim()).toBe('');
  });

  it('registros de declarado (tipo 2 D) con provincia y trimestres que suman el anual', () => {
    const [prov, cli1, cli2] = lineas.slice(1);
    // Ordenados por clave (A antes que B) y por importe.
    expect(campo(prov, 82, 82)).toBe('A');
    expect(campo(cli1, 82, 82)).toBe('B');
    expect(campo(cli1, 18, 26)).toBe('B12345678');
    expect(campo(cli1, 27, 35)).toBe(' '.repeat(9));
    expect(campo(cli1, 36, 75)).toBe('DISTRIBUCIONES TURIA SL'.padEnd(40));
    expect(campo(cli1, 76, 76)).toBe('D');
    expect(campo(cli1, 77, 80)).toBe('46  ');
    expect(campo(cli1, 81, 81)).toBe(' ');
    expect(campo(cli1, 83, 98)).toBe(' 000000000544500');
    expect(campo(cli1, 99, 100)).toBe('  ');
    expect(campo(cli1, 101, 115)).toBe('0'.repeat(15));
    expect(campo(cli1, 116, 131)).toBe(' ' + '0'.repeat(15));
    expect(campo(cli1, 132, 135)).toBe('0000');
    expect(campo(cli1, 136, 151)).toBe(' 000000000242000');
    expect(campo(cli1, 152, 167)).toBe(' ' + '0'.repeat(15));
    expect(campo(cli1, 168, 183)).toBe(' 000000000181500');
    expect(campo(cli1, 200, 215)).toBe(' 000000000000000');
    expect(campo(cli1, 232, 247)).toBe(' 000000000121000');
    expect(campo(cli1, 264, 283)).toBe(' '.repeat(20));
    expect(campo(cli1, 284, 299)).toBe(' ' + '0'.repeat(15));
    expect(campo(cli1, 300, 305)).toBe('000000');
    expect(campo(cli1, 306, 500).trim()).toBe('');

    // Ñ conservada; NIF normalizado; provincia por el nombre (Madrid = 28).
    expect(campo(cli2, 18, 26)).toBe('B87654321');
    expect(campo(cli2, 36, 75)).toBe('PEÑA Y CIA SL'.padEnd(40));
    expect(campo(cli2, 77, 78)).toBe('28');
    expect(Buffer.from(cli2, 'latin1')[35 + 2]).toBe(0xd1); // 'Ñ' en ISO-8859-1

    // Proveedor con el 4T en negativo: signo 'N'.
    expect(campo(prov, 77, 78)).toBe('12');
    expect(campo(prov, 83, 98)).toBe(' 000000000302500');
    expect(campo(prov, 136, 151)).toBe(' 000000000302500');
    expect(campo(prov, 200, 215)).toBe(' 000000000060500');
    expect(campo(prov, 232, 247)).toBe('N000000000060500');

    for (const l of [cli1, cli2, prov]) {
      const anual = Number(campo(l, 84, 98)) * (campo(l, 83, 83) === 'N' ? -1 : 1);
      const trimestres = [136, 168, 200, 232].map((p) => Number(campo(l, p + 1, p + 15)) * (campo(l, p, p) === 'N' ? -1 : 1));
      expect(trimestres.reduce((a, b) => a + b, 0)).toBe(anual);
      expect(campo(l, 9, 17)).toBe('B98765432');
    }
  });

  it('la pantalla enseña los mismos importes que el fichero', () => {
    expect(decl.resumen).toEqual({ numeroDeclarados: 3, importeTotal: 12100, numeroInmuebles: 0, importeArrendamientos: 0 });
    expect(decl.declarados.map((d) => [d.nifFichero, d.clave, d.provincia, d.importeAnual, d.trimestres])).toEqual([
      ['A11111111', 'A', '12', 3025, [3025, 0, 605, -605]],
      ['B12345678', 'B', '46', 5445, [2420, 1815, 0, 1210]],
      ['B87654321', 'B', '28', 3630, [3630, 0, 0, 0]],
    ]);
  });

  it('bloquea el fichero si falta el NIF de la empresa o de un declarado, o su provincia', () => {
    const malo = construirModelo347(2025, { nif: '', razonSocial: '' }, [
      { nif: '', nombre: 'Sin NIF', clave: 'B', provincia: null, importeAnual: 4000, trimestres: [4000, 0, 0, 0] },
    ]);
    expect(malo.errores.join(' ')).toMatch(/NIF de la empresa/);
    expect(malo.errores.join(' ')).toMatch(/razón social/);
    expect(malo.errores.join(' ')).toMatch(/Sin NIF/);
    expect(malo.errores.join(' ')).toMatch(/provincia/);
  });

  it('La Palma va con Santa Cruz de Tenerife (38) y un código que no existe se rechaza', () => {
    expect(provincia347('53')).toBe('38');
    expect(provincia347('46')).toBe('46');
    expect(provincia347('60')).toBeNull();
  });

  it('declaración sustitutiva: S en la 122 y número anterior en 123-135', () => {
    const s = construirModelo347(2025, { ...DECLARANTE, complementaria: { tipo: 'S', numeroAnterior: '3470000000001' } }, []);
    const t1 = s.registros[0];
    expect(campo(t1, 121, 122)).toBe(' S');
    expect(campo(t1, 123, 135)).toBe('3470000000001');
    expect(validarRegistro(reg('1'), t1)).toEqual([]);
  });
});
