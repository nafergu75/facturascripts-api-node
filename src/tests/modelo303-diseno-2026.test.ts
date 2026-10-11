/**
 * Test "dorado" del modelo 303 contra el diseño de registro OFICIAL de la AEAT
 * para 2026 (versión 1.01, DR303e26v101.xlsx, transcrito en
 * src/domain/aeat/dr303-2026.json).
 *
 * El validador de este fichero es independiente del generador: trocea el
 * fichero generado y comprueba campo a campo, con la tabla oficial, la
 * posición, la longitud, el tipo (A, An, Num, N), las constantes, los
 * reservados en blanco y los valores admitidos de cada indicador. Después
 * comprueba las casillas de varios casos de liquidación, y que la pantalla
 * enseña exactamente lo mismo que va al fichero.
 */
import diseno from '../domain/aeat/dr303-2026.json';
import { agregar303 } from '../services/impuestosCalculo.service';
import { casillasPantalla303, ContextoEmpresa303, ficheroBorrador303, montarBorrador303 } from '../services/modelo303.service';
import type { FacturaFiscal, PeriodoFiscal } from '../domain/impuestos.model';

interface Campo {
  n: number;
  pos: number | null;
  lon: number | null;
  tipo: string;
  descripcion: string;
  contenido: string;
  casilla?: string;
  constante?: string;
  reservado?: boolean;
}
type Pagina = { longitud: number | null; campos: Campo[] };
const PAGINAS = (diseno as unknown as { paginas: Record<string, Pagina> }).paginas;

// ---------------------------------------------------------------------------
// Validador independiente del diseño
// ---------------------------------------------------------------------------

/** Valores admitidos de los campos de 1 posición que remiten a una nota (página 1). */
const NOTAS_PAGINA_1: Record<number, string[]> = {
  6: ['C', 'D', 'G', 'I', 'N', 'V', 'U', 'X'], // Nota 1: tipo de declaración
  17: ['1', '2', ' '], // Nota 6: blanco fuera del último periodo
  18: ['1', '2', ' '],
  23: ['0', '1', '2'], // Nota 4
  24: ['0', '1', '2'], // Nota 3
  25: ['0', '1', '2'], // Nota 8: "0" en los trimestres y en el mes 01
};

/** Valores admitidos de un campo de una posición según su contenido ("1" SI, "2" NO / X o blanco). */
function admitidos(pagina: string, c: Campo): string[] | null {
  if (pagina === '01' && NOTAS_PAGINA_1[c.n]) return NOTAS_PAGINA_1[c.n];
  if (c.lon !== 1) return null;
  if (/X o blanco/.test(c.contenido)) return ['X', ' '];
  const literales = [...c.contenido.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (!literales.length) return null;
  return /blanco/i.test(c.contenido) ? [...literales, ' '] : literales;
}

/** Errores de una página frente a su hoja del diseño (vacío = cumple el diseño). */
function erroresPagina(pagina: string, texto: string): string[] {
  const p = PAGINAS[pagina];
  const errores: string[] = [];
  if (texto.length !== p.longitud) errores.push(`longitud ${texto.length} y el diseño pide ${p.longitud}`);
  for (const c of p.campos) {
    if (c.pos === null || c.lon === null) continue;
    const s = texto.substr(c.pos - 1, c.lon);
    const id = `pág. ${pagina} campo ${c.n}${c.casilla ? ` [${c.casilla}]` : ''} @${c.pos}: "${s}"`;
    if (c.constante !== undefined) {
      if (s !== c.constante) errores.push(`${id} debería ser la constante "${c.constante}"`);
      continue;
    }
    if (c.reservado) {
      if (s.trim()) errores.push(`${id} es reservado y va en blanco`);
      continue;
    }
    const ok = admitidos(pagina, c);
    if (ok && !ok.includes(s)) {
      errores.push(`${id} no es ninguno de ${ok.map((v) => `"${v}"`).join(', ')}`);
      continue;
    }
    const alineadoIzq = !s.trim() || !s.startsWith(' ');
    switch (c.tipo) {
      case 'A':
        if (!/^[A-ZÑÇ ]*$/.test(s) || !alineadoIzq) errores.push(`${id} no es A (letras, a la izquierda)`);
        break;
      case 'An':
        if (!/^[A-Z0-9ÑÇ ]*$/.test(s) || !alineadoIzq) errores.push(`${id} no es An (letras, números y blancos, a la izquierda)`);
        break;
      case 'Num':
        if (!/^\d+$/.test(s) && !(ok?.includes(' ') && s === ' ')) errores.push(`${id} no es Num (solo dígitos)`);
        break;
      case 'N':
        if (!/^(\d+|N\d+)$/.test(s)) errores.push(`${id} no es N (dígitos, con N delante si es negativo)`);
        break;
      default:
        errores.push(`${id}: tipo ${c.tipo} desconocido`);
    }
  }
  return errores;
}

/** Trocea un fichero completo: cabecera, páginas por su etiqueta y cierre. */
function trocear(fichero: string, ejercicio: number, periodo: string): Record<string, string> {
  const cab = fichero.slice(0, 328);
  // La cabecera tiene longitud variable en el diseño (incluye el contenido): se validan sus 328 primeras posiciones.
  expect(erroresPagina('cabecera', cab).filter((e) => !e.startsWith('longitud'))).toEqual([]);
  expect(cab.slice(0, 17)).toBe(`<T3030${ejercicio}${periodo}0000>`);
  expect(cab.slice(17, 22)).toBe('<AUX>');
  expect(cab.slice(322, 328)).toBe('</AUX>');
  const cierre = `</T3030${ejercicio}${periodo}0000>`;
  expect(fichero.endsWith(cierre)).toBe(true); // sin salto de línea detrás
  const paginas: Record<string, string> = {};
  let resto = fichero.slice(328, fichero.length - cierre.length);
  while (resto.length) {
    const m = /^<T303(01000|02000|03000|04000|05000|DID00)>/.exec(resto);
    if (!m) throw new Error(`Página desconocida: ${resto.slice(0, 12)}`);
    const clave = m[1] === 'DID00' ? 'DID' : m[1].slice(0, 2);
    const lon = PAGINAS[clave].longitud as number;
    paginas[clave] = resto.slice(0, lon);
    resto = resto.slice(lon);
  }
  return paginas;
}

/** Importe (euros) de una casilla leída del texto de su página. */
function leer(paginas: Record<string, string>, casilla: string): number {
  for (const [clave, texto] of Object.entries(paginas)) {
    const c = PAGINAS[clave].campos.find((x) => x.casilla === casilla);
    if (!c) continue;
    const s = texto.substr((c.pos as number) - 1, c.lon as number);
    const n = s.startsWith('N') ? -Number(s.slice(1)) : Number(s);
    return n / 100;
  }
  throw new Error(`Casilla [${casilla}] no encontrada`);
}

const campo = (texto: string, pos: number, lon: number) => texto.substr(pos - 1, lon);

// ---------------------------------------------------------------------------
// Casos
// ---------------------------------------------------------------------------

const P2T: PeriodoFiscal = { ejercicio: 2026, periodo: '2T', tipo: 'trimestral', fechaInicio: '2026-04-01', fechaFin: '2026-06-30' };
const P4T: PeriodoFiscal = { ejercicio: 2026, periodo: '4T', tipo: 'trimestral', fechaInicio: '2026-10-01', fechaFin: '2026-12-31' };
const P05: PeriodoFiscal = { ejercicio: 2026, periodo: '05', tipo: 'mensual', fechaInicio: '2026-05-01', fechaFin: '2026-05-31' };

const EMPRESA: ContextoEmpresa303 = { nif: 'B12345678', razonSocial: 'Ejemplo, S.L.', redeme: false, sii: false, criterioCaja: false, iban: 'ES9121000418450200051332' };

let id = 0;
const venta = (base: number, tipoIva: number, extra: Partial<FacturaFiscal> = {}, fecha = '2026-05-10'): FacturaFiscal => ({
  idFactura: `V${++id}`,
  tipo: 'venta',
  cifnif: 'B11111111',
  nombreTercero: 'Cliente',
  fecha,
  operacion: 'interior',
  lineas: [{ tipoIva, base, cuota: Math.round(base * tipoIva) / 100 }],
  ...extra,
});
const compra = (base: number, tipoIva: number, extra: Partial<FacturaFiscal> = {}, fecha = '2026-05-12', inversion = false): FacturaFiscal => ({
  idFactura: `C${++id}`,
  tipo: 'compra',
  cifnif: 'B22222222',
  nombreTercero: 'Proveedor',
  fecha,
  operacion: 'interior',
  lineas: [{ tipoIva, base, cuota: Math.round(base * tipoIva) / 100, ...(inversion ? { inversion: true } : {}) }],
  ...extra,
});

/** Genera el fichero, lo valida entero contra el diseño y devuelve sus páginas. */
function generar(facturas: FacturaFiscal[], periodo: PeriodoFiscal, opciones: { aCompensar?: number; tipo?: string; ctx?: Partial<ContextoEmpresa303> } = {}) {
  const datos = agregar303(facturas, periodo, opciones.aCompensar ?? 0);
  const borrador = montarBorrador303(datos, { ...EMPRESA, ...opciones.ctx }, opciones.tipo);
  const fichero = ficheroBorrador303(borrador, { versionPrograma: '0100', nifEmpresaDesarrollo: '' });
  const paginas = trocear(fichero, periodo.ejercicio, periodo.periodo);
  for (const [clave, texto] of Object.entries(paginas)) expect({ pagina: clave, errores: erroresPagina(clave, texto) }).toEqual({ pagina: clave, errores: [] });
  // La pantalla enseña exactamente lo que va al fichero.
  for (const c of casillasPantalla303(borrador)) {
    expect({ casilla: c.numero, valor: c.valor }).toEqual({ casilla: c.numero, valor: leer(paginas, c.numero) });
  }
  return { datos, borrador, fichero, paginas, p1: paginas['01'], p3: paginas['03'] };
}

describe('Tabla del diseño oficial 303 (2026, v1.01)', () => {
  it('cada hoja es continua y suma la longitud total del diseño', () => {
    for (const [clave, p] of Object.entries(PAGINAS)) {
      let pos = 1;
      for (const c of p.campos) {
        if (c.pos === null) continue;
        expect({ clave, n: c.n, pos: c.pos }).toEqual({ clave, n: c.n, pos });
        pos += c.lon as number;
      }
      if (p.longitud !== null) expect({ clave, total: pos - 1 }).toEqual({ clave, total: p.longitud });
    }
    expect(PAGINAS['01'].longitud).toBe(1581);
    expect(PAGINAS['03'].longitud).toBe(1017);
    expect(PAGINAS.DID.longitud).toBe(823);
  });

  it('posiciones de referencia del Excel de la AEAT', () => {
    const pos = (p: string, casilla: string) => PAGINAS[p].campos.find((c) => c.casilla === casilla)?.pos;
    expect([pos('01', '01'), pos('01', '07'), pos('01', '10'), pos('01', '27'), pos('01', '28'), pos('01', '45'), pos('01', '46')]).toEqual([209, 326, 365, 696, 713, 1002, 1019]);
    expect([pos('03', '59'), pos('03', '64'), pos('03', '65'), pos('03', '110'), pos('03', '78'), pos('03', '87'), pos('03', '69'), pos('03', '112'), pos('03', '71')]).toEqual([
      12, 199, 216, 255, 272, 289, 340, 391, 408,
    ]);
    expect(PAGINAS.DID.campos.find((c) => c.n === 6)).toMatchObject({ pos: 23, lon: 34, tipo: 'An' });
  });
});

describe('Fichero del 303 contra el diseño oficial 2026', () => {
  it('régimen general al 21, 10 y 4 %, con un bien de inversión: casillas y constantes', () => {
    const { p1, p3, fichero, borrador } = generar(
      [venta(1000, 21), venta(500, 10), venta(200, 4), compra(400, 21), compra(100, 21, {}, '2026-05-13', true)],
      P2T,
    );
    const l = (c: string) => leer({ '01': p1, '03': p3 }, c);
    expect([l('01'), l('03'), l('04'), l('06'), l('07'), l('09')]).toEqual([200, 8, 500, 50, 1000, 210]);
    expect([campo(p1, 226, 5), campo(p1, 304, 5), campo(p1, 343, 5)]).toEqual(['00400', '01000', '02100']);
    expect([l('27'), l('28'), l('29'), l('30'), l('31'), l('45'), l('46')]).toEqual([268, 400, 84, 100, 21, 105, 163]);
    expect([l('64'), l('65'), l('66'), l('69'), l('71')]).toEqual([163, 100, 163, 163, 163]);
    // Identificación
    expect(campo(p1, 13, 1)).toBe('I'); // a ingresar
    expect(campo(p1, 14, 9)).toBe('B12345678');
    expect(campo(p1, 23, 80).trimEnd()).toBe('EJEMPLO SL');
    expect(campo(p1, 103, 4) + campo(p1, 107, 2)).toBe('20262T');
    expect(campo(p1, 109, 9)).toBe('223222  2'); // foral, REDEME, solo RG, conjunta, caja x2, prorrata en blanco, concurso
    expect(campo(p1, 118, 9)).toBe('         '); // fecha y tipo de concurso en blanco
    expect(campo(p1, 127, 4)).toBe('2000'); // SII, exonerado 390, volumen, carburantes
    // Recargo de equivalencia: importes a cero y sus tipos fijos
    expect([campo(p1, 484, 5), campo(p1, 523, 5), campo(p1, 601, 5), campo(p1, 640, 5)]).toEqual(['00175', '00050', '00140', '00520']);
    expect(campo(p3, 425, 1)).toBe(' '); // con actividad
    expect(fichero.length).toBe(328 + 1581 + 1017 + 18); // sin DID: no se domicilia
    expect(borrador.tiposDeclaracion).toEqual(['I', 'U']);
  });

  it('adquisiciones intracomunitarias: autodevengo [10]/[11] y deducción [36]/[37]; entregas en [59]', () => {
    const { p1, p3, datos } = generar(
      [
        venta(100, 21),
        venta(2000, 0, { operacion: 'intracomunitaria', cifnif: 'FR12345678901', tipoOperacion: 'INTRACOMUNITARIA', paisTercero: 'FR', clave349: 'E' }),
        compra(1000, 21, { operacion: 'intracomunitaria', cifnif: 'DE123456789' }),
        compra(300, 21, { operacion: 'intracomunitaria', cifnif: 'IT12345678901' }, '2026-05-14', true),
      ],
      P2T,
    );
    const l = (c: string) => leer({ '01': p1, '03': p3 }, c);
    expect([l('10'), l('11'), l('36'), l('37'), l('38'), l('39')]).toEqual([1300, 273, 1000, 210, 300, 63]);
    expect([l('27'), l('45'), l('46'), l('71')]).toEqual([294, 273, 21, 21]);
    expect(l('59')).toBe(2000);
    expect(l('28')).toBe(0);
    expect(datos.advertencias ?? []).toEqual([]);
  });

  it('una compra intracomunitaria sin IVA va en [10] con aviso para autoliquidar la cuota', () => {
    const { p1, datos } = generar([compra(500, 0, { operacion: 'intracomunitaria', cifnif: 'DE999' })], P2T);
    expect(leer({ '01': p1 }, '10')).toBe(500);
    expect(leer({ '01': p1 }, '11')).toBe(0);
    expect(datos.advertencias?.some((a) => /\[10\]\/\[11\]/.test(a))).toBe(true);
  });

  it('inversión del sujeto pasivo: ventas en [122]; compras con ISP en [12]/[13] y [28]/[29]; resultado cero es N', () => {
    const { p1, p3 } = generar([venta(800, 0, { tipoOperacion: 'ISP_NACIONAL' }), compra(500, 21, { isp: true })], P2T);
    const l = (c: string) => leer({ '01': p1, '03': p3 }, c);
    expect([l('12'), l('13'), l('28'), l('29'), l('27'), l('45'), l('46')]).toEqual([500, 105, 500, 105, 105, 105, 0]);
    expect(l('122')).toBe(800);
    expect(campo(p1, 13, 1)).toBe('N');
    expect(campo(p3, 425, 1)).toBe(' '); // resultado cero, pero con actividad
  });

  it('a compensar: [110] pendiente, [78] aplicado hasta dejar el resultado en cero y [87] lo que queda', () => {
    const { p1, p3 } = generar([venta(1000, 21)], P2T, { aCompensar: 300 });
    const l = (c: string) => leer({ '01': p1, '03': p3 }, c);
    expect([l('46'), l('66'), l('110'), l('78'), l('87'), l('69'), l('71')]).toEqual([210, 210, 300, 210, 90, 0, 0]);
    expect(campo(p1, 13, 1)).toBe('N');
  });

  it('a devolver en el 2T: solo se puede compensar (C); la devolución es un 400', () => {
    const { p1, p3, borrador } = generar([venta(1000, 21), compra(2000, 21)], P2T, { aCompensar: 50 });
    const l = (c: string) => leer({ '01': p1, '03': p3 }, c);
    expect([l('46'), l('110'), l('78'), l('87'), l('71')]).toEqual([-210, 50, 0, 50, -210]);
    expect(campo(p3, 408, 17)).toBe('N0000000000021000');
    expect(campo(p1, 13, 1)).toBe('C');
    expect(borrador.tiposDeclaracion).toEqual(['C']);
    expect(() => generar([venta(1000, 21), compra(2000, 21)], P2T, { tipo: 'D' })).toThrow(/puede ser C/);
  });

  it('a devolver en el 4T con devolución: página DID con el IBAN y la marca SEPA de cuenta española', () => {
    const facturas = [venta(1000, 21, {}, '2026-11-02'), compra(2000, 21, {}, '2026-11-03')];
    const { p1, paginas, fichero } = generar(facturas, P4T, { tipo: 'D' });
    expect(campo(p1, 13, 1)).toBe('D');
    expect(campo(p1, 115, 2)).toBe('22'); // prorrata especial: "2" en el último periodo
    expect(campo(p1, 128, 2)).toBe('20'); // no exonerado del 390 (lo presenta) y volumen "0"
    const did = paginas.DID;
    expect(campo(did, 1, 11)).toBe('<T303DID00>');
    expect(campo(did, 23, 34).trimEnd()).toBe('ES9121000418450200051332');
    expect(campo(did, 194, 1)).toBe('1');
    expect(campo(did, 812, 12)).toBe('</T303DID00>');
    expect(fichero.length).toBe(328 + 1581 + 1017 + 823 + 18);
    // Por defecto se compensa, sin página DID
    const compensa = generar(facturas, P4T);
    expect(campo(compensa.p1, 13, 1)).toBe('C');
    expect(compensa.paginas.DID).toBeUndefined();
    // Sin cuenta bancaria no se genera la devolución
    expect(() => generar(facturas, P4T, { tipo: 'D', ctx: { iban: null } })).toThrow(/cuenta bancaria/);
  });

  it('domiciliación del ingreso (U): página DID', () => {
    const { p1, paginas } = generar([venta(1000, 21)], P2T, { tipo: 'U' });
    expect(campo(p1, 13, 1)).toBe('U');
    expect(campo(paginas.DID, 23, 24)).toBe('ES9121000418450200051332');
  });

  it('sin actividad: "X" en la página 3, tipo N y todo a cero salvo las constantes', () => {
    const { p1, p3 } = generar([], P2T);
    expect(campo(p1, 13, 1)).toBe('N');
    expect(campo(p3, 425, 1)).toBe('X');
    expect(campo(p3, 426, 15)).toBe(' '.repeat(15)); // rectificativa, justificante y baja de domiciliación en blanco
    expect(campo(p3, 458, 2)).toBe('  ');
    for (const c of ['01', '03', '27', '45', '46', '64', '66', '69', '71']) expect(leer({ '01': p1, '03': p3 }, c)).toBe(0);
    expect(leer({ '03': p3 }, '65')).toBe(100);
  });

  it('rectificativas: ventas en [14]/[15] y compras anuladas en [40]/[41], con signo', () => {
    const { p1 } = generar(
      [venta(1000, 21), venta(-100, 21, { rectificativa: true }), compra(400, 21), compra(-50, 21, { rectificativa: true })],
      P2T,
    );
    const l = (c: string) => leer({ '01': p1 }, c);
    expect([l('07'), l('09'), l('14'), l('15'), l('27')]).toEqual([1000, 210, -100, -21, 189]);
    expect([l('28'), l('29'), l('40'), l('41'), l('45'), l('46')]).toEqual([400, 84, -50, -10.5, 73.5, 115.5]);
    expect(campo(p1, 433, 17)).toBe('N0000000000010000');
  });

  it('una fila del régimen general que queda en negativo pasa a modificaciones (el campo Num no admite signo)', () => {
    const { p1 } = generar([venta(100, 10), venta(-300, 10)], P2T);
    const l = (c: string) => leer({ '01': p1 }, c);
    expect([l('04'), l('06'), l('14'), l('15'), l('27')]).toEqual([0, 0, -200, -20, -20]);
  });

  it('IVA mensual con REDEME y SII (mes 05): indicadores y devolución posible', () => {
    const { p1, borrador } = generar([venta(100, 21, {}, '2026-05-03'), compra(1000, 21, {}, '2026-05-04')], P05, {
      ctx: { redeme: true, sii: true },
      tipo: 'D',
    });
    expect(campo(p1, 107, 2)).toBe('05');
    expect(campo(p1, 110, 1)).toBe('1'); // REDEME
    expect(campo(p1, 127, 4)).toBe('1002'); // SII; 390 y volumen "0" fuera del último periodo; carburantes "2" desde el 02
    expect(borrador.tiposDeclaracion).toEqual(['C', 'D']);
  });

  it('razón social de más de 80 caracteres: van las 80 primeras, con aviso (antes era un 500)', () => {
    const larga = 'Sociedad de Servicios Integrales de Mantenimiento y Limpieza Industrial del Mediterráneo, S.L.';
    const { p1, borrador } = generar([venta(100, 21)], P2T, { ctx: { razonSocial: larga } });
    const esperada = 'SOCIEDAD DE SERVICIOS INTEGRALES DE MANTENIMIENTO Y LIMPIEZA INDUSTRIAL DEL MEDI';
    expect(esperada).toHaveLength(80);
    expect(campo(p1, 23, 80)).toBe(esperada);
    expect(borrador.razonSocial).toBe(esperada);
    expect(borrador.advertencias.join(' ')).toMatch(/más de 80 caracteres/);
    // Si el corte cae en un blanco, no se deja al final.
    const conBlanco = generar([venta(100, 21)], P2T, { ctx: { razonSocial: `${'A'.repeat(79)} BCD` } });
    expect(campo(conBlanco.p1, 23, 80)).toBe('A'.repeat(79) + ' ');
    expect(conBlanco.borrador.razonSocial).toBe('A'.repeat(79));
  });

  it('NIF y razón social en An: mayúsculas, sin signos ni tildes (la Ñ se queda)', () => {
    const { p1 } = generar([venta(100, 21)], P2T, { ctx: { nif: 'b-1234567.8', razonSocial: 'Ñandú & Cía., S.L.' } });
    expect(campo(p1, 14, 9)).toBe('B12345678');
    expect(campo(p1, 23, 80).trimEnd()).toBe('ÑANDU CIA SL');
  });

  it('el validador detecta los fallos del fichero anterior (indicadores a "0", tipo en blanco, "0" en campos X o blanco)', () => {
    const { p1, p3 } = generar([venta(100, 21)], P2T);
    const poner = (t: string, pos: number, v: string) => t.slice(0, pos - 1) + v + t.slice(pos - 1 + v.length);
    const malo1 = poner(poner(poner(p1, 13, ' '), 109, '000000000'), 226, '00000');
    expect(erroresPagina('01', malo1).map((e) => e.split(':')[0])).toEqual([
      'pág. 01 campo 6 @13',
      'pág. 01 campo 11 @109',
      'pág. 01 campo 12 @110',
      'pág. 01 campo 13 @111',
      'pág. 01 campo 14 @112',
      'pág. 01 campo 15 @113',
      'pág. 01 campo 16 @114',
      'pág. 01 campo 17 @115',
      'pág. 01 campo 18 @116',
      'pág. 01 campo 19 @117',
      'pág. 01 campo 33 [02] @226',
    ]);
    const malo3 = poner(p3, 425, '0'.repeat(35));
    expect(erroresPagina('03', malo3).map((e) => e.split(':')[0])).toEqual([
      'pág. 03 campo 30 @425',
      'pág. 03 campo 31 @426',
      'pág. 03 campo 33 @440',
      'pág. 03 campo 35 @458',
      'pág. 03 campo 36 @459',
    ]);
  });

  it('sin NIF, o con una venta a un tipo sin fila, no se genera el fichero y se dice por qué', () => {
    const d = agregar303([venta(100, 21)], P2T);
    expect(() => ficheroBorrador303(montarBorrador303(d, { ...EMPRESA, nif: '' }))).toThrow(/Falta el NIF/);
    const d5 = agregar303([venta(100, 5)], P2T);
    expect(() => ficheroBorrador303(montarBorrador303(d5, EMPRESA))).toThrow(/ventas al 5 %/);
  });
});

// Instrucciones 2026 del 303 (sede, G414), casilla 71: "Si opta por solicitar
// devolución, se consignará la totalidad del saldo a su favor, que deberá
// incluir el importe total de la casilla (110)". Antes la devolución solo
// devolvía [46] y [110] se quedaba en [87], pendiente para el año siguiente.
describe('303 con devolución: el saldo a devolver incluye todo [110]', () => {
  const l = (r: { p1: string; p3: string }, c: string) => leer({ '01': r.p1, '03': r.p3 }, c);
  const cinco = (r: { p1: string; p3: string }) => [l(r, '110'), l(r, '78'), l(r, '87'), l(r, '69'), l(r, '71')];
  const facturas4T = () => [venta(1000, 21, {}, '2026-11-02'), compra(2000, 21, {}, '2026-11-03')];

  it('agregar303 con devolucion: [78] = [110], [87] = 0 y [71] = [66] - [110]', () => {
    const compensa = agregar303(facturas4T(), P4T, 300);
    expect([compensa.cuotasAplicadas, compensa.cuotasPendientesPosteriores, compensa.resultadoFinal]).toEqual([0, 300, -210]);
    const devuelve = agregar303(facturas4T(), P4T, 300, { devolucion: true });
    expect([devuelve.cuotasAplicadas, devuelve.cuotasPendientesPosteriores, devuelve.resultadoFinal]).toEqual([300, 0, -510]);
    expect(devuelve.casillasOficiales).toMatchObject({ '110': 300, '78': 300, '87': 0, '69': -510, '71': -510 });
    expect(devuelve.casillas).toMatchObject({ '78_cuotas_a_compensar': 300, '87_pendientes_periodos_posteriores': 0, '71_resultado': -510 });
  });

  it('4T a devolver con cuotas pendientes: con D se devuelve [46] más todo [110]; compensando, [110] pasa a [87]', () => {
    const compensa = generar(facturas4T(), P4T, { aCompensar: 300 });
    expect(compensa.borrador.tiposDeclaracion).toEqual(['C', 'D']);
    expect(campo(compensa.p1, 13, 1)).toBe('C');
    expect(cinco(compensa)).toEqual([300, 0, 300, -210, -210]);

    const devuelve = generar(facturas4T(), P4T, { aCompensar: 300, tipo: 'D' });
    expect(campo(devuelve.p1, 13, 1)).toBe('D');
    expect(cinco(devuelve)).toEqual([300, 300, 0, -510, -510]);
    expect(campo(devuelve.p3, 408, 17)).toBe('N0000000000051000');
    expect(devuelve.paginas.DID).toBeDefined();
    // Lo que se guarda (y lee el periodo siguiente) es lo del tipo elegido.
    expect(devuelve.borrador.datos).toMatchObject({ cuotasAplicadas: 300, cuotasPendientesPosteriores: 0, resultadoFinal: -510 });
    expect(devuelve.borrador.datos.casillas['87_pendientes_periodos_posteriores']).toBe(0);
  });

  it('4T con el resultado a cero tras compensar: se puede pedir la devolución de lo que queda en [110]', () => {
    const cero = generar([venta(1000, 21, {}, '2026-11-02')], P4T, { aCompensar: 300 });
    expect(cero.borrador.tiposDeclaracion).toEqual(['N', 'D']);
    expect(campo(cero.p1, 13, 1)).toBe('N');
    expect(cinco(cero)).toEqual([300, 210, 90, 0, 0]);

    const devuelve = generar([venta(1000, 21, {}, '2026-11-02')], P4T, { aCompensar: 300, tipo: 'D' });
    expect(cinco(devuelve)).toEqual([300, 300, 0, -90, -90]);
  });

  it('4T a ingresar aunque se aplique todo [110]: no hay devolución', () => {
    const r = generar([venta(1000, 21, {}, '2026-11-02')], P4T, { aCompensar: 100 });
    expect(r.borrador.tiposDeclaracion).toEqual(['I', 'U']);
    expect(cinco(r)).toEqual([100, 100, 0, 110, 110]);
    expect(() => generar([venta(1000, 21, {}, '2026-11-02')], P4T, { aCompensar: 100, tipo: 'D' })).toThrow(/puede ser I/);
  });

  it('mes 05 con REDEME: la devolución también incluye [110]; sin REDEME, en el 2T solo se compensa', () => {
    const facturas = [venta(100, 21, {}, '2026-05-03'), compra(1000, 21, {}, '2026-05-04')];
    const redeme = generar(facturas, P05, { aCompensar: 100, tipo: 'D', ctx: { redeme: true } });
    expect(cinco(redeme)).toEqual([100, 100, 0, -289, -289]);
    const trimestre = generar(facturas, P2T, { aCompensar: 100 });
    expect(trimestre.borrador.tiposDeclaracion).toEqual(['C']);
    expect(cinco(trimestre)).toEqual([100, 0, 100, -189, -189]);
  });

  it('montar el borrador es idempotente: con los datos ya calculados para devolver, compensar vuelve a dejar [110] en [87]', () => {
    const datos = agregar303(facturas4T(), P4T, 300, { devolucion: true });
    const compensa = montarBorrador303(datos, EMPRESA, 'C');
    expect(compensa.casillas).toMatchObject({ '78': 0, '87': 300, '71': -210 });
    const devuelve = montarBorrador303(datos, EMPRESA, 'D');
    expect(devuelve.casillas).toMatchObject({ '78': 300, '87': 0, '71': -510 });
  });

  it('como se presentó: las casillas guardadas van tal cual y el tipo es el presentado', () => {
    const datos = agregar303(facturas4T(), P4T, 300, { devolucion: true });
    const b = montarBorrador303(datos, EMPRESA, 'D', { comoSePresento: true });
    expect(b.tipoDeclaracion).toBe('D');
    expect(b.casillas).toEqual(datos.casillasOficiales);
  });
});
