/**
 * Test "dorado" del 390: el fichero se compara campo a campo con la tabla del
 * diseño de registro OFICIAL vers. 1.02 (src/domain/aeat/dr390-v102.json,
 * copiada de dr390e2025.xlsx). Caso real: un año completo de una S.L. con
 * ventas al 21 %, 10 % y 4 %, una entrega intracomunitaria, adquisiciones
 * intracomunitarias de bienes y de servicios, un gasto con IVA no deducible,
 * cuotas a compensar del año anterior y el 4T a compensar.
 */
import dr390 from '../domain/aeat/dr390-v102.json';
import { construirModelo390, DISENO_390, liquidaciones390 } from '../aeat/oficial/modelo390';
import { validarRegistro, type PaginaOficial } from '../aeat/oficial/diseno';
import { entrada390Desde } from '../services/borradoresAeat.service';
import type { FacturaFiscal } from '../domain/impuestos.model';

const PAGINAS = (dr390 as any).paginas as Record<string, PaginaOficial>;
const campo = (linea: string, pos: number, len: number) => linea.slice(pos - 1, pos - 1 + len);
const imp17 = (euros: number) => String(Math.round(Math.abs(euros) * 100)).padStart(17, '0');

let n = 0;
const venta = (fecha: string, lineas: FacturaFiscal['lineas'], extra: Partial<FacturaFiscal> = {}): FacturaFiscal => ({
  idFactura: `V${++n}`,
  tipo: 'venta',
  cifnif: 'B12345674',
  nombreTercero: 'Cliente',
  fecha,
  operacion: 'interior',
  tipoOperacion: 'NACIONAL',
  lineas,
  ...extra,
});
const compra = (fecha: string, lineas: FacturaFiscal['lineas'], extra: Partial<FacturaFiscal> = {}): FacturaFiscal => ({
  idFactura: `C${++n}`,
  tipo: 'compra',
  cifnif: 'A11111119',
  nombreTercero: 'Proveedor',
  fecha,
  operacion: 'interior',
  tipoGasto: 'COMPRA',
  lineas,
  ...extra,
});

const FACTURAS: FacturaFiscal[] = [
  // Ventas del régimen general: 21 %, 10 % y 4 %.
  venta('2025-02-15', [{ tipoIva: 21, base: 10000, cuota: 2100 }]),
  venta('2025-05-10', [{ tipoIva: 21, base: 8000, cuota: 1680 }]),
  venta('2025-06-01', [{ tipoIva: 10, base: 3000, cuota: 300 }]),
  venta('2025-08-20', [
    { tipoIva: 21, base: 5000, cuota: 1050 },
    { tipoIva: 4, base: 1000, cuota: 40 },
  ]),
  venta('2025-11-10', [{ tipoIva: 21, base: 2000, cuota: 420 }]),
  // Entrega intracomunitaria (exenta, [103]).
  venta('2025-09-01', [{ tipoIva: 0, base: 4000, cuota: 0 }], { tipoOperacion: 'INTRACOMUNITARIA', operacion: 'intracomunitaria', cifnif: 'FR12345678901', paisTercero: 'FR' }),
  // Compras interiores deducibles: 21 % y 10 %.
  compra('2025-01-20', [
    { tipoIva: 21, base: 4000, cuota: 840 },
    { tipoIva: 10, base: 1000, cuota: 100 },
  ]),
  compra('2025-04-15', [{ tipoIva: 21, base: 3000, cuota: 630 }]),
  compra('2025-07-15', [{ tipoIva: 21, base: 2000, cuota: 420 }]),
  compra('2025-12-01', [{ tipoIva: 21, base: 9000, cuota: 1890 }]),
  // Adquisiciones intracomunitarias sin IVA en la factura: se autoliquidan al 21 %.
  compra('2025-05-20', [{ tipoIva: 21, base: 2000, cuota: 0 }], { operacion: 'intracomunitaria', cifnif: 'DE123456789' }),
  compra('2025-09-10', [{ tipoIva: 21, base: 500, cuota: 0 }], { operacion: 'intracomunitaria', tipoGasto: 'SUMINISTROS', cifnif: 'IE1234567X' }),
  // Gasto con IVA no deducible: fuera del 303, a la casilla [232].
  compra('2025-03-01', [{ tipoIva: 21, base: 300, cuota: 63 }], { deducible: false }),
];

const ID = { nif: 'b98765431', razonSocial: 'Ifbiosoluciones, S.L.', actividad: 'Comercio al por mayor', presenta347: true };

describe('390 dorado: diseño oficial vers. 1.02 (ejercicio 2025)', () => {
  it('la tabla del diseño cubre cada página sin huecos y con su longitud', () => {
    for (const [codigo, p] of Object.entries(PAGINAS)) {
      let pos = 1;
      for (const c of p.campos) {
        expect([codigo, c.pos]).toEqual([codigo, pos]);
        pos += c.len;
      }
      expect([codigo, pos - 1]).toEqual([codigo, p.longitud]);
    }
  });

  const { entrada } = entrada390Desde(FACTURAS, 2025, ID, { compensarEjercicioAnterior: 200, ultimoPeriodo: 'compensar', programa: { versionPrograma: 'CA01', nifEmpresaDesarrollo: 'B11111119' } });
  const decl = construirModelo390(entrada);
  const f = decl.fichero;

  it('resultados de los 303 del año', () => {
    expect(entrada.resultadosTrimestrales).toEqual([1160, 1350, 670, -1470]);
    expect(decl.liquidaciones).toMatchObject({ casilla85: 200, casilla95: 2980, casilla97: 1470, casilla98: 0, casilla662: 0 });
  });

  it('fichero: cabecera <AUX>, páginas seguidas sin separadores en el orden del diseño y cierre', () => {
    expect(decl.errores).toEqual([]);
    expect(f).not.toMatch(/[\r\n]/);
    const cab = f.slice(0, 328);
    expect(campo(cab, 1, 17)).toBe('<T390020250A0000>');
    expect(campo(cab, 18, 5)).toBe('<AUX>');
    expect(campo(cab, 23, 70).trim()).toBe('');
    expect(campo(cab, 93, 4)).toBe('CA01');
    expect(campo(cab, 97, 4)).toBe('    ');
    expect(campo(cab, 101, 9)).toBe('B11111119');
    expect(campo(cab, 110, 213).trim()).toBe('');
    expect(campo(cab, 323, 6)).toBe('</AUX>');
    expect(f.slice(-18)).toBe('</T390020250A0000>');

    // Páginas: cada una con su longitud, su etiqueta y su cierre, validada contra su diseño.
    let resto = f.slice(328, -18);
    const orden: string[] = [];
    while (resto.length) {
      const codigo = resto.slice(5, 10);
      const p = PAGINAS[codigo];
      expect(p).toBeDefined();
      const linea = resto.slice(0, p.longitud);
      expect(linea.startsWith(`<T390${codigo}>`)).toBe(true);
      expect(linea.endsWith(`</T390${codigo}>`)).toBe(true);
      expect([codigo, validarRegistro(p, linea)]).toEqual([codigo, []]);
      expect(campo(linea, 12, 1)).toBe(' '); // indicador de complementaria en blanco
      orden.push(codigo);
      resto = resto.slice(p.longitud);
    }
    expect(orden).toEqual(['01000', '02000', '02B00', '03000', '04000', '06000', '07000']);
    expect(orden).toEqual(DISENO_390.orden.filter((c) => orden.includes(c)));
  });

  const pagina = (codigo: string) => decl.paginas.find((p) => p.codigo === codigo)!.linea;

  it('página 1: sujeto pasivo, devengo y datos estadísticos', () => {
    const p = pagina('01000');
    expect(campo(p, 13, 1)).toBe(' ');
    expect(campo(p, 14, 9)).toBe('B98765431');
    expect(campo(p, 23, 60)).toBe('IFBIOSOLUCIONES SL'.padEnd(60));
    expect(campo(p, 83, 20)).toBe(' '.repeat(20));
    expect(campo(p, 103, 4)).toBe('2025');
    expect(campo(p, 107, 2)).toBe('  ');
    expect(campo(p, 109, 2)).toBe('00'); // devolución mensual y grupo de entidades: No
    expect(campo(p, 118, 3)).toBe('000');
    expect(campo(p, 130, 3)).toBe('222'); // concurso, criterio de caja y destinatario: No
    expect(campo(p, 133, 2)).toBe('00'); // no sustitutiva (campos Num: a ceros)
    expect(campo(p, 148, 40)).toBe('COMERCIO AL POR MAYOR'.padEnd(40));
    expect(campo(p, 430, 1)).toBe('1'); // presenta el 347
  });

  it('página 2: IVA devengado por tipos, adquisiciones intracomunitarias y totales [33]/[34]', () => {
    const p = pagina('02000');
    const c = decl.casillas;
    expect([c['01'], c['02'], c['03'], c['04'], c['05'], c['06']]).toEqual([1000, 40, 3000, 300, 25000, 5250]);
    expect([c['25'], c['26'], c['551'], c['552']]).toEqual([2000, 420, 500, 105]);
    expect(campo(p, 81, 17)).toBe(imp17(1000)); // [01]
    expect(campo(p, 217, 17)).toBe(imp17(25000)); // [05]
    expect(campo(p, 234, 17)).toBe(imp17(5250)); // [06]
    expect(campo(p, 13, 17)).toBe(imp17(0)); // [700] al 0 %: a ceros (Nota 2)
    expect(campo(p, 1203, 17)).toBe(imp17(2000)); // [25]
    expect(campo(p, 1458, 17)).toBe(imp17(105)); // [552]
    expect(campo(p, 1611, 17)).toBe(imp17(31500)); // [33]
    expect(campo(p, 1628, 17)).toBe(imp17(6115)); // [34]
    expect(campo(p, 1645, 150).trim()).toBe('');
  });

  it('página 2 bis: [47] = [34] sin recargo de equivalencia', () => {
    const p = pagina('02B00');
    expect(campo(p, 353, 17)).toBe(imp17(6115));
    expect(campo(p, 370, 150).trim()).toBe('');
  });

  it('páginas 3 y 4: deducible y resultado del régimen general [65] = [47] - [64]', () => {
    const p3 = pagina('03000');
    const p4 = pagina('04000');
    expect(campo(p3, 183, 17)).toBe(imp17(18000)); // [605]
    expect(campo(p3, 200, 17)).toBe(imp17(3780)); // [606]
    expect(campo(p3, 149, 17)).toBe(imp17(1000)); // [603]
    expect(campo(p3, 234, 17)).toBe(imp17(3880)); // [49]
    expect(campo(p3, 1662, 17)).toBe(imp17(420)); // [57]
    expect(campo(p4, 472, 17)).toBe(imp17(105)); // [598]
    expect(campo(p4, 659, 17)).toBe(imp17(4405)); // [64]
    expect(campo(p4, 676, 17)).toBe(imp17(1710)); // [65]
    expect(campo(p4, 693, 150).trim()).toBe('');
  });

  it('página 6: resultado anual, territorio, liquidaciones del año y volumen', () => {
    const p = pagina('06000');
    expect(campo(p, 30, 17)).toBe(imp17(1710)); // [84]
    expect(campo(p, 64, 17)).toBe(imp17(200)); // [85]
    expect(campo(p, 81, 17)).toBe(imp17(1510)); // [86] = [84] - [659] - [85]
    expect(campo(p, 98, 5)).toBe('10000'); // [87] territorio común 100 %
    expect(campo(p, 208, 17)).toBe(imp17(1510)); // [94]
    expect(campo(p, 225, 17)).toBe(imp17(2980)); // [95]
    expect(campo(p, 276, 17)).toBe(imp17(1470)); // [97] último periodo a compensar
    expect(campo(p, 293, 17)).toBe(imp17(0)); // [98]
    expect(campo(p, 361, 17)).toBe(imp17(29000)); // [99]
    expect(campo(p, 395, 17)).toBe(imp17(4000)); // [103]
    expect(campo(p, 650, 17)).toBe(imp17(33000)); // [108]
    expect(campo(p, 667, 150).trim()).toBe('');
    // El resultado cuadra con los 303: no hay aviso de descuadre.
    expect(decl.advertencias.join(' ')).not.toMatch(/no cuadra/);
  });

  it('página 7: base del IVA soportado no deducible [232], sin prorrata', () => {
    const p = pagina('07000');
    expect(campo(p, 64, 17)).toBe(imp17(300));
    expect(campo(p, 200, 40).trim()).toBe('');
    expect(campo(p, 277, 1)).toBe(' ');
  });

  it('la pantalla enseña las mismas casillas que el fichero', () => {
    for (const pg of decl.paginas) {
      const diseno = PAGINAS[pg.codigo];
      for (const [cas, valor] of Object.entries(pg.casillas)) {
        if (typeof valor !== 'number') continue;
        const c = diseno.campos.find((x) => x.casilla !== undefined && Number(x.casilla) === Number(cas))!;
        const txt = campo(pg.linea, c.pos, c.len);
        const leido = (txt.startsWith('N') ? -1 : 1) * Number(txt.replace('N', ''));
        expect([pg.codigo, cas, leido]).toEqual([pg.codigo, cas, c.len === 5 ? valor : Math.round(valor * 100)]);
      }
    }
  });

  it('negativos con N en los campos N; un campo Num no admite negativos', () => {
    const neg = construirModelo390({ ...entrada, resultadosTrimestrales: [-100, -50, -25, -1525], compensarEjercicioAnterior: 0, ultimoPeriodo: 'devolver', devengado: [], deducibleInterior: [{ tipo: 21, base: 8000, cuota: 1700 }], adquisicionesIntraBienes: [], adquisicionesIntraServicios: [], deducibleIntraBienes: [], deducibleIntraServicios: [] });
    const p4 = neg.paginas.find((p) => p.codigo === '04000')!.linea;
    expect(campo(p4, 676, 17)).toBe('N' + '170000'.padStart(16, '0')); // [65]
    const p6 = neg.paginas.find((p) => p.codigo === '06000')!.linea;
    expect(campo(p6, 293, 17)).toBe(imp17(1525)); // [98] a devolver, sin signo
    expect(campo(p6, 310, 17)).toBe(imp17(175)); // [662] pendientes del año
  });

  it('cuotas a compensar: se aplican de la más antigua a la más nueva', () => {
    expect(liquidaciones390([-500, 300, 100, -50])).toMatchObject({ casilla95: 0, casilla97: 50, casilla662: 100, finales: [-500, 0, 0, -50] });
  });

  it('sin NIF ni razón social no se puede descargar', () => {
    const malo = construirModelo390({ ...entrada, identificacion: { nif: '', razonSocial: '' } });
    expect(malo.errores.join(' ')).toMatch(/NIF/);
    expect(malo.errores.join(' ')).toMatch(/razón social/);
  });

  it('un tipo de IVA sin casilla en el diseño es un error', () => {
    const malo = construirModelo390({ ...entrada, devengado: [{ tipo: 5, base: 100, cuota: 5 }] });
    expect(malo.errores.join(' ')).toMatch(/5 %/);
  });
});

describe('390: remates (marcas de la página 1, [117] y prorrata, intracomunitarias no deducibles)', () => {
  const base = entrada390Desde(FACTURAS, 2025, ID, { compensarEjercicioAnterior: 200 }).entrada;

  it('las marcas de la página 1 salen en la pantalla con su significado, las mismas que el fichero', () => {
    const d = construirModelo390({ ...base, identificacion: { ...base.identificacion, redeme: true, criterioCaja: false, presenta347: true } });
    const p1 = d.paginas.find((p) => p.codigo === '01000')!.linea;
    expect(d.marcasPagina1.map((m) => [m.pos, m.valor, m.texto])).toEqual([
      [109, '1', 'Sí'],
      [110, '0', 'No'],
      [130, '2', 'No'],
      [131, '2', 'No'],
      [132, '2', 'No'],
      [133, '0', 'No'],
      [430, '1', 'Sí'],
    ]);
    for (const m of d.marcasPagina1) expect(campo(p1, m.pos, 1)).toBe(m.valor);
  });

  it('con exentas sin derecho a deducción: [117] = G en la pantalla y error claro (la página 3 va al 100 %)', () => {
    const d = construirModelo390({ ...base, volumen: { ...base.volumen, exentasSinDeduccion: 1000 } });
    const p7 = d.paginas.find((p) => p.codigo === '07000')!;
    expect(p7.casillas['117']).toBe('G');
    expect(campo(p7.linea, 277, 1)).toBe('G');
    expect(d.errores).toEqual([expect.stringMatching(/habría que aplicar la prorrata.*no casaría con la prorrata de la página 7/)]);
  });

  it('una adquisición intracomunitaria con IVA no deducible se autoliquida en el devengado, pero no se deduce', () => {
    const facturas: FacturaFiscal[] = [
      venta('2025-02-15', [{ tipoIva: 21, base: 10000, cuota: 2100 }]),
      compra('2025-05-20', [{ tipoIva: 21, base: 1000, cuota: 0 }], { operacion: 'intracomunitaria', cifnif: 'DE123456789', deducible: false }),
    ];
    const d = construirModelo390(entrada390Desde(facturas, 2025, ID).entrada);
    expect(d.casillas['25']).toBe(1000); // devengado: base intracomunitaria al 21 %
    expect(d.casillas['26']).toBe(210);
    expect(d.casillas['629'] ?? 0).toBe(0); // no se deduce
    expect(d.casillas['65']).toBe(2310); // 2.100 + 210 - 0
  });
});


describe('390: compra con una parte exenta (al 0 %, sin cuota)', () => {
  it('la parte exenta no entra en el deducible interior: [605]/[606] y [48]/[49] solo llevan la parte con IVA', () => {
    const facturas = [
      venta('2025-02-15', [{ tipoIva: 21, base: 10000, cuota: 2100 }]),
      compra('2025-03-10', [
        { tipoIva: 21, base: 100, cuota: 21 },
        { tipoIva: 0, base: 400, cuota: 0 },
      ]),
    ];
    const d = construirModelo390(entrada390Desde(facturas, 2025, ID).entrada);
    expect(d.errores).toEqual([]);
    expect(d.casillas['605']).toBe(100);
    expect(d.casillas['606']).toBe(21);
    expect(d.casillas['48']).toBe(100);
    expect(d.casillas['49']).toBe(21);
  });
});
