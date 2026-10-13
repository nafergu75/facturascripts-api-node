/**
 * De donde es el tercero de una factura leida (el cliente en ventas, el
 * proveedor en gastos) y como cambia eso la validacion de su NIF. Sin BD: el
 * contexto llega ya cargado (lector-extranjeros.db.test lo prueba de punta a
 * punta).
 *
 * Queja del usuario del 13-10-2026: con un cliente intracomunitario o de un
 * pais tercero, la falta de NIF (o un RNC, un EIN...) impedia registrar la factura.
 */
import { mapearFacturaAzure } from '../services/lectura/azure-factura.mapper';
import type { AnalyzeResult } from '../services/lectura/azure-di.client';
import {
  contradiccionOrigen,
  detectarOrigenTercero,
  infoTercero,
  leerEleccionOrigen,
  origenAutomatico,
  type EleccionOrigenTercero,
} from '../services/lectura/origen-tercero';
import type { LecturaNormalizada, ResultadoValidacion } from '../services/lectura/tipos';
import { compararQr } from '../services/lectura/verifactu-qr';
import { MENSAJE_FALTA_NIF_CLIENTE as FALTA_NIF, MENSAJE_SIMPLIFICADA_SIN_NIF, validarLectura, type ContextoValidacion } from '../services/lectura/validaciones';
import { HttpError } from '../utils/http-errors';
import { fixtureAzure, NIF_EMISOR, NIF_EMPRESA } from './fixtures/azure-di';

function deFixture(): LecturaNormalizada {
  const r = mapearFacturaAzure(fixtureAzure<{ analyzeResult: AnalyzeResult }>('resultado-simple').analyzeResult);
  if (r.tipo !== 'hecho') throw new Error('x');
  return compararQr(r.qr ?? null, r.lectura);
}

const base = (extra: Partial<ContextoValidacion> = {}): ContextoValidacion => ({
  lector: 'VENTA',
  // En ventas la empresa es la emisora de resultado-simple.
  nifEmpresa: NIF_EMISOR,
  empresaEspanola: true,
  monedaCuenta: 'EUR',
  hoy: '2026-10-13',
  periodoAbierto: async () => true,
  duplicado: { factura: null, archivo: null },
  ...extra,
});
const gasto = (extra: Partial<ContextoValidacion> = {}) => base({ lector: 'GASTO', nifEmpresa: NIF_EMPRESA, ...extra });

const ES: EleccionOrigenTercero = { origen: 'ES', pais: 'ES' };
const UE = (pais: string | null = null): EleccionOrigenTercero => ({ origen: 'UE', pais });
const FUERA = (pais: string | null = null): EleccionOrigenTercero => ({ origen: 'FUERA', pais });

const direccion = (pais: string) => ({ valor: { calle: 'Calle 1', pais }, confianza: 0.9, fuente: 'azure' as const });

/** La venta simple con el NIF del cliente cambiado y, si se da, el pais de su direccion. */
function cliente(nif: string | null, pais?: string): LecturaNormalizada {
  const l = deFixture();
  l.receptor.nif = { valor: nif, confianza: 0.9, fuente: 'azure' };
  if (pais) l.receptor.direccion = direccion(pais);
  return l;
}

/** El gasto simple con el NIF del proveedor cambiado y el pais de su direccion (sin pais: sin direccion). */
function proveedor(nif: string | null, pais?: string): LecturaNormalizada {
  const l = deFixture();
  l.emisor.nif = { valor: nif, confianza: 0.9, fuente: 'azure' };
  l.emisor.direccion = pais ? direccion(pais) : { valor: null, confianza: null, fuente: 'azure' };
  return l;
}

async function del(l: LecturaNormalizada, c: ContextoValidacion, codigo: string): Promise<ResultadoValidacion[]> {
  return (await validarLectura(l, c)).validaciones.filter((v) => v.codigo === codigo);
}

describe('de donde es el tercero', () => {
  it('sin eleccion, por este orden: ficha, prefijo con su forma, direccion, prefijo y forma de NIF espanol', () => {
    expect(origenAutomatico({ paisFicha: 'MA', nif: 'FR40303265045', paisDireccion: 'FR' })).toEqual({ origen: 'FUERA', pais: 'MA', por: 'ficha' });
    expect(origenAutomatico({ nif: 'FR40303265045', paisDireccion: 'ESP' })).toEqual({ origen: 'UE', pais: 'FR', por: 'prefijo' });
    expect(origenAutomatico({ nif: '131123456', paisDireccion: 'República Dominicana' })).toEqual({ origen: 'FUERA', pais: 'DO', por: 'direccion' });
    // Un RFC mexicano que empieza por DE no es un NIF-IVA aleman si la direccion dice Mexico.
    expect(origenAutomatico({ nif: 'DEMA800101AB1', paisDireccion: 'MEX' })).toEqual({ origen: 'FUERA', pais: 'MX', por: 'direccion' });
    expect(origenAutomatico({ nif: 'FR4030326504' })).toEqual({ origen: 'UE', pais: 'FR', por: 'prefijo' });
    expect(origenAutomatico({ nif: NIF_EMPRESA })).toEqual({ origen: 'ES', pais: 'ES', por: 'forma' });
    expect(origenAutomatico({ nif: '12-3456789' })).toEqual({ origen: null, pais: null, por: null });
    expect(origenAutomatico({})).toEqual({ origen: null, pais: null, por: null });
  });

  it('la eleccion manda; su pais, el elegido o, si no se eligio, el de la factura si es del mismo lado', () => {
    expect(detectarOrigenTercero({ eleccion: ES, nif: 'FR40303265045' })).toEqual({ origen: 'ES', pais: 'ES', por: 'eleccion' });
    expect(detectarOrigenTercero({ eleccion: UE(), nif: 'FR40303265045' })).toEqual({ origen: 'UE', pais: 'FR', por: 'eleccion' });
    expect(detectarOrigenTercero({ eleccion: UE('IT'), nif: 'FR40303265045' })).toEqual({ origen: 'UE', pais: 'IT', por: 'eleccion' });
    expect(detectarOrigenTercero({ eleccion: FUERA(), paisDireccion: 'FR' })).toEqual({ origen: 'FUERA', pais: null, por: 'eleccion' });
  });

  it('contradiccion: De España con un NIF-IVA FR o una direccion en Francia, o al reves', () => {
    expect(contradiccionOrigen({ eleccion: ES, nif: 'FR40303265045' }, 'cliente')).toMatchObject({ origen: 'UE', pais: 'FR', mensaje: expect.stringMatching(/NIF-IVA de Francia y has dicho que el cliente es de España/) });
    expect(contradiccionOrigen({ eleccion: ES, nif: null, paisDireccion: 'FR' }, 'cliente')).toMatchObject({ origen: 'UE', pais: 'FR', mensaje: expect.stringMatching(/^Su dirección está en Francia/) });
    expect(contradiccionOrigen({ eleccion: UE('FR'), nif: NIF_EMPRESA }, 'proveedor')).toMatchObject({ origen: 'ES', mensaje: expect.stringMatching(/es un NIF español y has dicho que el proveedor es de Francia/) });
    expect(contradiccionOrigen({ eleccion: FUERA('US'), paisDireccion: 'MX' }, 'cliente')).toMatchObject({ origen: 'FUERA', pais: 'MX' });
    // Sin contradiccion: lo mismo, sin eleccion, o un numero con forma de NIF espanol que no lo es (control malo).
    expect(contradiccionOrigen({ eleccion: UE('FR'), nif: 'FR40303265045' }, 'cliente')).toBeNull();
    expect(contradiccionOrigen({ nif: 'FR40303265045' }, 'cliente')).toBeNull();
    expect(contradiccionOrigen({ eleccion: FUERA(), nif: 'B12345670' }, 'cliente')).toBeNull();
  });

  it('lo que llega de la pantalla: ES, UE o FUERA y, si se da, un pais de ese lado (400 si no)', () => {
    expect(leerEleccionOrigen(undefined, undefined)).toBeNull();
    expect(leerEleccionOrigen('', 'FR')).toBeNull();
    expect(leerEleccionOrigen('es', 'FR')).toEqual({ origen: 'ES', pais: 'ES' });
    expect(leerEleccionOrigen('UE', '')).toEqual({ origen: 'UE', pais: null });
    expect(leerEleccionOrigen('UE', 'FRA')).toEqual({ origen: 'UE', pais: 'FR' });
    expect(leerEleccionOrigen('FUERA', 'do')).toEqual({ origen: 'FUERA', pais: 'DO' });
    for (const [o, p] of [['EXTRANJERO', null], ['UE', 'US'], ['FUERA', 'FR'], ['UE', 'ES'], ['FUERA', 'ZZ']]) {
      expect(() => leerEleccionOrigen(o, p)).toThrow(HttpError);
    }
  });

  it('la pantalla recibe el nombre del numero fiscal y el NIF-IVA con su prefijo', () => {
    expect(infoTercero('VENTA', { nif: '131123456', paisDireccion: 'DO' })).toMatchObject({ tipo: 'cliente', origen: 'FUERA', pais: 'DO', numeroFiscal: 'RNC', nifPropuesto: null });
    expect(infoTercero('VENTA', { nif: '40303265045', paisDireccion: 'FR' })).toMatchObject({ origen: 'UE', numeroFiscal: 'NIF-IVA (VAT)', nifPropuesto: 'FR40303265045' });
    expect(infoTercero('GASTO', { eleccion: FUERA() })).toMatchObject({ tipo: 'proveedor', numeroFiscal: 'Número fiscal (Tax ID)' });
    expect(infoTercero('GASTO', { nif: NIF_EMISOR })).toMatchObject({ origen: 'ES', numeroFiscal: 'NIF', contradiccion: null });
  });
});

describe('lector de ventas: el NIF del cliente segun de donde es', () => {
  it('cliente frances con NIF-IVA (con prefijo, o con espacios): bien, sin nada que revisar', async () => {
    for (const nif of ['FR40303265045', 'FR 403 032 650 45']) {
      const r = await validarLectura(cliente(nif), base());
      expect(r.validaciones.filter((v) => ['NIF_RECEPTOR', 'ORIGEN_TERCERO'].includes(v.codigo))).toEqual([]);
    }
  });

  it('cliente frances con el NIF-IVA sin prefijo y la direccion en Francia: revisar, proponiendolo con FR', async () => {
    const r = await validarLectura(cliente('40303265045', 'FR'), base());
    expect(r.validaciones.find((v) => v.codigo === 'NIF_RECEPTOR')).toMatchObject({ nivel: 'revisar', sugerencia: 'FR40303265045' });
    expect(r.campos['receptor.nif']).toMatchObject({ estado: 'revisar', sugerencia: 'FR40303265045' });
    expect(r.estado).toBe('revisar');
  });

  it('cliente de la Republica Dominicana con su RNC: se acepta tal cual', async () => {
    expect(await del(cliente('131123456', 'DO'), base(), 'NIF_RECEPTOR')).toEqual([]);
    // Elegido «De fuera de la UE» aunque no se lea la direccion: tambien.
    expect(await del(cliente('131123456'), base({ origenTercero: FUERA('DO') }), 'NIF_RECEPTOR')).toEqual([]);
    // Sin decir de donde es ni direccion: no parece un NIF espanol, se pide el pais (no bloquea).
    expect((await del(cliente('131123456'), base(), 'NIF_RECEPTOR'))[0]).toMatchObject({ nivel: 'revisar', mensaje: expect.stringMatching(/no parece un NIF español.*¿De dónde es el cliente\?/) });
  });

  it('cliente de EE. UU. sin numero: revisar (no error), diciendo cuando es obligatorio', async () => {
    const r = await del(cliente(null, 'US'), base(), 'NIF_RECEPTOR');
    expect(r).toEqual([expect.objectContaining({ nivel: 'revisar', mensaje: expect.stringMatching(/^La factura no lleva el EIN del cliente\..*art\. 6\.1\.d/) })]);
    const elegido = await del(cliente(null), base({ origenTercero: FUERA() }), 'NIF_RECEPTOR');
    expect(elegido[0]).toMatchObject({ nivel: 'revisar', mensaje: expect.stringMatching(/número fiscal \(Tax ID\) del cliente/) });
  });

  it('cliente de la UE sin NIF-IVA: revisar, avisando de que no puede ir como entrega intracomunitaria exenta', async () => {
    const r = await del(cliente(null), base({ origenTercero: UE('IT') }), 'NIF_RECEPTOR');
    expect(r[0]).toMatchObject({ nivel: 'revisar', mensaje: expect.stringMatching(/Falta el NIF-IVA \(VAT\) del cliente\. Sin él, la venta no puede ir como entrega intracomunitaria exenta \(art\. 25/) });
  });

  it('cliente espanol sin NIF: sigue siendo error', async () => {
    expect((await del(cliente(null), base(), 'NIF_RECEPTOR'))[0]).toMatchObject({ nivel: 'error', mensaje: 'Falta el NIF del cliente: es obligatorio en una factura de ingreso.' });
    expect((await del(cliente(null, 'ES'), base(), 'NIF_RECEPTOR'))[0].nivel).toBe('error');
    // Dicho «De España»: el mismo error, con como salir si no lo es.
    expect((await del(cliente(null), base({ origenTercero: ES }), 'NIF_RECEPTOR'))[0]).toMatchObject({
      nivel: 'error',
      mensaje: 'Falta el NIF del cliente: es obligatorio en una factura de ingreso. Si el cliente es de otro país, cámbialo en «¿De dónde es el cliente?».',
    });
  });

  it('la eleccion manda sobre lo leido: De España con un NIF-IVA FR es error, con el aviso que propone cambiarla', async () => {
    const vs = (await validarLectura(cliente('FR40303265045'), base({ origenTercero: ES }))).validaciones;
    expect(vs.find((v) => v.codigo === 'NIF_RECEPTOR')?.nivel).toBe('error');
    expect(vs.find((v) => v.codigo === 'ORIGEN_TERCERO')).toMatchObject({ nivel: 'revisar', campos: ['receptor.nif'] });
    // Y al reves: «De fuera de la UE» con un NIF-IVA FR no es error, pero queda para revisar.
    const fuera = (await validarLectura(cliente('FR40303265045'), base({ origenTercero: FUERA() }))).validaciones;
    expect(fuera.find((v) => v.codigo === 'NIF_RECEPTOR')).toBeUndefined();
    expect(fuera.find((v) => v.codigo === 'ORIGEN_TERCERO')?.nivel).toBe('revisar');
  });

  it('un NIF espanol mal escrito sigue siendo error; un NIF-IVA mal formado tambien', async () => {
    expect((await del(cliente('B12345670'), base(), 'NIF_RECEPTOR'))[0].nivel).toBe('error');
    expect((await del(cliente('FR1'), base({ origenTercero: UE() }), 'NIF_RECEPTOR'))[0].nivel).toBe('error');
  });

  it('el cliente ya dado de alta dice de donde es (su ficha)', async () => {
    expect(await del(cliente('001234567000089'), base({ paisTerceroFicha: 'MA' }), 'NIF_RECEPTOR')).toEqual([]);
  });
});

describe('lector de gastos: el NIF del proveedor segun de donde es', () => {
  it('proveedor de un pais tercero sin NIF: revisar, no error', async () => {
    const r = await del(proveedor(null, 'US'), gasto(), 'NIF_EMISOR');
    expect(r).toEqual([expect.objectContaining({ nivel: 'revisar', mensaje: expect.stringMatching(/^No se ha podido leer el EIN del proveedor\. Un proveedor de fuera de la UE puede no tenerlo/) })]);
    expect((await del(proveedor(null), gasto({ origenTercero: FUERA() }), 'NIF_EMISOR'))[0].nivel).toBe('revisar');
  });

  it('proveedor espanol sin NIF: error, como siempre', async () => {
    expect((await del(proveedor(null), gasto(), 'NIF_EMISOR'))[0]).toMatchObject({ nivel: 'error', mensaje: 'No se ha podido leer el NIF del proveedor.' });
    expect((await del(proveedor(null, 'ES'), gasto(), 'NIF_EMISOR'))[0].nivel).toBe('error');
  });

  it('proveedor de fuera con su identificacion: se acepta tal cual; elegido De España, no', async () => {
    expect(await del(proveedor('12-3456789', 'US'), gasto(), 'NIF_EMISOR')).toEqual([]);
    const es = await del(proveedor('12-3456789'), gasto({ origenTercero: ES }), 'NIF_EMISOR');
    expect(es[0]).toMatchObject({ nivel: 'error', mensaje: expect.stringMatching(/Si el proveedor es de otro país, cámbialo en «¿De dónde es el proveedor\?»\.$/) });
  });
});

// ---------------------------------------------------------------------------
// Revisión técnica y normativa (13-10-2026)
// ---------------------------------------------------------------------------

describe('casos limite de de donde es el tercero', () => {
  it('un NIF-IVA de Irlanda o de Chipre sin prefijo tiene forma de DNI, pero con su pais se propone con el prefijo', async () => {
    const ie = await del(proveedor('6388047V', 'IE'), gasto({ origenTercero: UE('IE') }), 'NIF_EMISOR');
    expect(ie).toEqual([expect.objectContaining({ nivel: 'revisar', sugerencia: 'IE6388047V' })]);
    const cy = await del(cliente('10259033P', 'CY'), base({ origenTercero: UE('CY') }), 'NIF_RECEPTOR');
    expect(cy).toEqual([expect.objectContaining({ nivel: 'revisar', sugerencia: 'CY10259033P' })]);
    // Sin pais: no se dice que sea un NIF español (su control no cuadra), se pide de que pais es.
    const sinPais = await del(proveedor('6388047V'), gasto({ origenTercero: UE() }), 'NIF_EMISOR');
    expect(sinPais[0].mensaje).not.toMatch(/es un NIF español/);
    expect(sinPais[0].mensaje).toMatch(/sin el prefijo del país/);
  });

  it('ES delante de un NIF español valido es de España aunque la direccion este fuera', () => {
    expect(origenAutomatico({ nif: `ES${NIF_EMPRESA}`, paisDireccion: 'FR' })).toEqual({ origen: 'ES', pais: 'ES', por: 'prefijo' });
    // Con un NIF mal escrito detras del ES, la direccion manda (como antes).
    expect(origenAutomatico({ nif: 'ESB12345670', paisDireccion: 'FR' })).toMatchObject({ origen: 'UE', por: 'direccion' });
  });

  it('Canarias, Ceuta y Melilla en la direccion son España', () => {
    for (const p of ['Islas Canarias', 'Canary Islands', 'Ceuta', 'Melilla']) {
      expect(origenAutomatico({ nif: NIF_EMPRESA, paisDireccion: p })).toEqual({ origen: 'ES', pais: 'ES', por: 'direccion' });
    }
  });

  it('De fuera de la UE: un RFC que empieza por DE no se toma por un NIF-IVA aleman; con De España, si se avisa', () => {
    expect(contradiccionOrigen({ eleccion: FUERA('MX'), nif: 'DEL850101AB1' }, 'cliente')).toBeNull();
    expect(contradiccionOrigen({ eleccion: ES, nif: 'DEL850101AB1' }, 'cliente')).toMatchObject({ origen: 'UE', pais: 'DE' });
  });

  it('un NIF-IVA XI (Irlanda del Norte) con la direccion en el Reino Unido y De otro pais de la UE: sin aviso', async () => {
    expect(contradiccionOrigen({ eleccion: UE(), nif: 'XI123456789', paisDireccion: 'GB' }, 'cliente')).toBeNull();
    const vs = (await validarLectura(cliente('XI123456789', 'GB'), base({ origenTercero: UE() }))).validaciones;
    expect(vs.filter((v) => ['NIF_RECEPTOR', 'ORIGEN_TERCERO'].includes(v.codigo))).toEqual([]);
  });

  it('un tercero ya dado de alta: su ficha manda sobre lo elegido para validar su numero; queda el aviso', async () => {
    expect(detectarOrigenTercero({ eleccion: ES, paisFicha: 'IE', nif: 'IE6388047V' })).toEqual({ origen: 'UE', pais: 'IE', por: 'ficha' });
    const vs = (await validarLectura(proveedor('IE6388047V'), gasto({ origenTercero: ES, paisTerceroFicha: 'IE' }))).validaciones;
    expect(vs.filter((v) => v.codigo === 'NIF_EMISOR')).toEqual([]);
    expect(vs.find((v) => v.codigo === 'ORIGEN_TERCERO')).toMatchObject({ nivel: 'revisar', mensaje: expect.stringMatching(/^Lo tienes dado de alta como proveedor de Irlanda/) });
    // Y la pantalla recibe el nombre de su numero (el de la ficha).
    expect(infoTercero('GASTO', { eleccion: ES, paisFicha: 'US', nif: '987654321' })).toMatchObject({
      origen: 'FUERA',
      pais: 'US',
      numeroFiscal: 'EIN',
      contradiccion: { origen: 'FUERA', pais: 'US' },
    });
  });

  it('De fuera de la UE sin pais y un numero con forma de NIF español: revisar (mal leido o de España)', async () => {
    const mal = await del(cliente('12345678A'), base({ origenTercero: FUERA() }), 'NIF_RECEPTOR');
    expect(mal).toEqual([expect.objectContaining({ nivel: 'revisar', mensaje: expect.stringMatching(/parece un NIF español, pero su letra o cifra de control no cuadra/) })]);
    // Con el pais (elegido o leido), su identificacion se acepta tal cual.
    expect(await del(cliente('12345678A', 'CL'), base({ origenTercero: FUERA() }), 'NIF_RECEPTOR')).toEqual([]);
    expect(await del(cliente('12345678A'), base({ origenTercero: FUERA('CL') }), 'NIF_RECEPTOR')).toEqual([]);
  });

  it('dicho de otro pais pero con la direccion en España: sin NIF sigue siendo error', async () => {
    for (const eleccion of [FUERA(), UE()]) {
      const vs = (await validarLectura(cliente(null, 'ES'), base({ origenTercero: eleccion }))).validaciones;
      expect(vs.find((v) => v.codigo === 'NIF_RECEPTOR')).toMatchObject({ nivel: 'error', mensaje: FALTA_NIF });
      expect(vs.find((v) => v.codigo === 'ORIGEN_TERCERO')?.nivel).toBe('revisar');
    }
    expect((await del(proveedor(null, 'ES'), gasto({ origenTercero: FUERA() }), 'NIF_EMISOR'))[0].nivel).toBe('error');
  });

  it('factura simplificada de venta sin NIF del cliente: revisar (el art. 7 no lo pide), no error', async () => {
    const l = cliente(null);
    l.tipoDocumento = { valor: 'simplificada', confianza: 0.9, fuente: 'azure' };
    expect(await del(l, base({ origenTercero: ES }), 'NIF_RECEPTOR')).toEqual([expect.objectContaining({ nivel: 'revisar', mensaje: MENSAJE_SIMPLIFICADA_SIN_NIF })]);
  });

  it('textos: fuera de la UE habla de la exportacion; la UE, de los servicios', async () => {
    expect((await del(cliente(null, 'US'), base(), 'NIF_RECEPTOR'))[0].mensaje).toMatch(/exportación de bienes al 0 %.*arts\. 69 y 70/);
    expect((await del(cliente(null), base({ origenTercero: UE('IT') }), 'NIF_RECEPTOR'))[0].mensaje).toMatch(/servicio a una empresa.*art\. 69/);
  });

  it('un NIF-IVA con prefijo y una composicion imposible para su Estado es error (el 349 lo rechazaria); el de la ficha, revisar', async () => {
    const leido = await del(cliente('FR123'), base({ origenTercero: UE() }), 'NIF_RECEPTOR');
    expect(leido[0]).toMatchObject({ nivel: 'error', mensaje: expect.stringMatching(/^El NIF-IVA FR123 no es válido: en Francia el NIF-IVA lleva 11 letras o cifras detrás de FR/) });
    const deFicha = await del(proveedor('FR123'), gasto({ paisTerceroFicha: 'FR' }), 'NIF_EMISOR');
    expect(deFicha[0]).toMatchObject({ nivel: 'revisar', mensaje: expect.stringMatching(/^El NIF-IVA de la ficha del proveedor no es válido/) });
  });

  it('el NIF-IVA propuesto para el alta sigue a la factura cuando contradice lo elegido', () => {
    expect(infoTercero('VENTA', { eleccion: ES, nif: '40303265045', paisDireccion: 'FR' })).toMatchObject({
      origen: 'ES',
      contradiccion: { origen: 'UE', pais: 'FR' },
      nifPropuesto: 'FR40303265045',
    });
  });

  it('una eleccion que no casa con su pais dice que opcion elegir', () => {
    expect(() => leerEleccionOrigen('FUERA', 'ES')).toThrow(/elige «De España»/);
    expect(() => leerEleccionOrigen('UE', 'US')).toThrow(/no es de la UE: elige «De fuera de la UE»/);
    expect(() => leerEleccionOrigen('FUERA', 'FR')).toThrow(/es de la UE: elige «De otro país de la UE»/);
  });
});
