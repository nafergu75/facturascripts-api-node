/**
 * Validaciones automaticas de una lectura (V01-V22): cada una con un caso que
 * pasa y otro que no, sin BD (el contexto llega ya cargado).
 */
import { mapearFacturaAzure } from '../services/lectura/azure-factura.mapper';
import type { AnalyzeResult } from '../services/lectura/azure-di.client';
import { lecturaVacia, type LecturaNormalizada, type ResultadoValidacion } from '../services/lectura/tipos';
import { compararQr, interpretarValorQr } from '../services/lectura/verifactu-qr';
import { estadoPorConfianza, validarLectura, type ContextoValidacion } from '../services/lectura/validaciones';
import { controlCif, letraDni } from '../utils/nif';
import { fixtureAzure, NIF_EMPRESA } from './fixtures/azure-di';

function deFixture(nombre: string): LecturaNormalizada {
  const r = mapearFacturaAzure(fixtureAzure<{ analyzeResult: AnalyzeResult }>(nombre).analyzeResult);
  if (r.tipo !== 'hecho') throw new Error('x');
  return compararQr(r.qr ?? null, r.lectura);
}

const ctx = (extra: Partial<ContextoValidacion> = {}): ContextoValidacion => ({
  lector: 'GASTO',
  nifEmpresa: NIF_EMPRESA,
  empresaEspanola: true,
  monedaCuenta: 'EUR',
  hoy: '2026-10-11',
  periodoAbierto: async () => true,
  duplicado: { factura: null, archivo: null },
  ...extra,
});

/** La lectura simple con un cambio. */
function con(cambio: (l: LecturaNormalizada) => void, nombre = 'resultado-simple'): LecturaNormalizada {
  const l = deFixture(nombre);
  cambio(l);
  return l;
}

async function codigos(l: LecturaNormalizada, c = ctx()): Promise<ResultadoValidacion[]> {
  return (await validarLectura(l, c)).validaciones;
}
const de = (vs: ResultadoValidacion[], codigo: string) => vs.filter((x) => x.codigo === codigo);

describe('la factura simple pasa todas', () => {
  it('sin validaciones, todo en ok', async () => {
    const r = await validarLectura(deFixture('resultado-simple'), ctx());
    expect(r.validaciones).toEqual([]);
    expect(r.estado).toBe('ok');
    expect(r.campos['emisor.nif']).toMatchObject({ estado: 'ok', confianza: 0.93, fuente: 'azure', valorLeido: 'B12345674', motivos: [] });
  });
});

describe('V01 cuadre', () => {
  it('2 centimos de diferencia: revisar; 3: error', async () => {
    const dos = de(await codigos(con((l) => (l.totales.totalAPagar.valor = 242.02))), 'CUADRE');
    expect(dos).toEqual([expect.objectContaining({ nivel: 'revisar', campos: ['totales.totalAPagar'] })]);
    const tres = de(await codigos(con((l) => (l.totales.totalAPagar.valor = 242.03))), 'CUADRE');
    expect(tres[0].nivel).toBe('error');
    expect(tres[0].mensaje).toBe('Los importes no cuadran: base 200,00 € + IVA 42,00 € + recargo 0,00 € − retención 0,00 € = 242,00 €, y la factura dice 242,03 €.');
  });

  it('con la retencion y con el recargo cuadra', async () => {
    expect(de(await codigos(deFixture('resultado-irpf')), 'CUADRE')).toEqual([]);
    expect(de(await codigos(deFixture('resultado-recargo')), 'CUADRE')).toEqual([]);
  });
});

describe('V02-V06 importes por tipo', () => {
  it('V02 la cuota no corresponde a la base', async () => {
    expect(de(await codigos(deFixture('resultado-iva-multiple')), 'CUOTA_TIPO')).toEqual([]);
    const r = de(await codigos(con((l) => (l.desglose[0].cuota.valor = 45))), 'CUOTA_TIPO');
    expect(r[0]).toMatchObject({ nivel: 'revisar', campos: ['desglose.0.cuota'], mensaje: 'El IVA del 21 % no corresponde a su base (sale 42,00 € y pone 45,00 €).' });
  });

  it('V03 tipos de IVA: 7 % no existe; 5 % a revisar; empresa extranjera sin mirar', async () => {
    expect((await codigos(con((l) => (l.desglose[0].tipoIva = 7)))).find((x) => x.codigo === 'TIPO_IVA')).toMatchObject({ nivel: 'error', mensaje: 'El tipo de IVA 7 % no existe en España.' });
    expect(de(await codigos(con((l) => (l.desglose[0].tipoIva = 5))), 'TIPO_IVA')[0].nivel).toBe('revisar');
    expect(de(await codigos(con((l) => (l.desglose[0].tipoIva = 7)), ctx({ empresaEspanola: false })), 'TIPO_IVA')).toEqual([]);
  });

  it('V04 recargo: pareja buena; 5,2 con el 10 % es error', async () => {
    expect(de(await codigos(deFixture('resultado-recargo')), 'RECARGO')).toEqual([]);
    const r = de(await codigos(con((l) => (l.desglose[0].tipoRecargo = 1.4), 'resultado-recargo')), 'RECARGO');
    expect(r[0]).toMatchObject({ nivel: 'error', mensaje: 'El recargo del 1,4 % no corresponde al IVA del 21 %.' });
    const cuota = de(await codigos(con((l) => (l.desglose[0].cuotaRecargo!.valor = 11), 'resultado-recargo')), 'RECARGO');
    expect(cuota[0].nivel).toBe('error');
  });

  it('V05 recargo no soportado: en gastos revisar; en ventas error', async () => {
    const l = deFixture('resultado-recargo');
    expect(de(await codigos(l), 'RECARGO_NO_SOPORTADO')[0].nivel).toBe('revisar');
    expect(de(await codigos(l, ctx({ lector: 'VENTA', nifEmpresa: 'B12345674' })), 'RECARGO_NO_SOPORTADO')[0]).toMatchObject({
      nivel: 'error',
      mensaje: 'Las facturas con recargo de equivalencia aún no se pueden registrar con el lector.',
    });
    expect(de(await codigos(deFixture('resultado-simple')), 'RECARGO_NO_SOPORTADO')).toEqual([]);
  });

  it('V06 IRPF: 15 % de 1.000 es 150; 150 al 7 % no', async () => {
    expect(de(await codigos(deFixture('resultado-irpf')), 'IRPF')).toEqual([]);
    const r = de(await codigos(con((l) => (l.retencion!.tipo.valor = 7), 'resultado-irpf')), 'IRPF');
    expect(r[0]).toMatchObject({ nivel: 'revisar', mensaje: 'La retención del 7 % no corresponde a la base.' });
  });
});

describe('V07-V09 NIF y empresa', () => {
  const dni = `12345678${letraDni('12345678')}`;
  const nie = `X1234567${letraDni('01234567')}`;
  const cif = `A5881850${controlCif('5881850').cifra}`;

  it.each([dni, nie, cif, 'FR12345678901'])('NIF del proveedor %s valido', async (nif) => {
    expect(de(await codigos(con((l) => (l.emisor.nif.valor = nif))), 'NIF_EMISOR')).toEqual([]);
  });

  it.each(['12345678A', 'X1234567A', 'B12345670', '1234'])('NIF del proveedor %s no valido: error', async (nif) => {
    expect(de(await codigos(con((l) => (l.emisor.nif.valor = nif))), 'NIF_EMISOR')[0].nivel).toBe('error');
  });

  it('sin NIF del proveedor: error en gastos; en ventas no se pide', async () => {
    expect(de(await codigos(con((l) => (l.emisor.nif.valor = null))), 'NIF_EMISOR')[0].nivel).toBe('error');
    expect(de(await codigos(con((l) => (l.emisor.nif.valor = null)), ctx({ lector: 'VENTA', nifEmpresa: null })), 'NIF_EMISOR')).toEqual([]);
  });

  it('V08 sin NIF del cliente: error en ventas, revisar en gastos', async () => {
    const l = con((x) => (x.receptor.nif.valor = null));
    expect(de(await codigos(l, ctx({ lector: 'VENTA', nifEmpresa: 'B12345674' })), 'NIF_RECEPTOR')[0]).toMatchObject({
      nivel: 'error',
      mensaje: 'Falta el NIF del cliente: es obligatorio en una factura de ingreso.',
    });
    expect(de(await codigos(l), 'NIF_RECEPTOR')[0].nivel).toBe('revisar');
  });

  it('V09 la empresa como emisora en gastos: error; otro cliente: revisar', async () => {
    const emisora = de(await codigos(con((l) => (l.emisor.nif.valor = NIF_EMPRESA))), 'EMPRESA');
    expect(emisora[0]).toMatchObject({ nivel: 'error', mensaje: 'Parece una factura emitida por la empresa: léela en el lector de ventas.' });
    const otra = de(await codigos(deFixture('resultado-simple'), ctx({ nifEmpresa: `A5881850${controlCif('5881850').cifra}` })), 'EMPRESA');
    expect(otra[0]).toMatchObject({ nivel: 'revisar', mensaje: `La factura no va a nombre de la empresa (NIF del cliente: ${NIF_EMPRESA}).` });
  });
});

describe('V10-V13 fechas', () => {
  it('2026-02-30 no existe; una futura tampoco vale', async () => {
    expect(de(await codigos(con((l) => (l.fechaEmision.valor = '2026-02-30'))), 'FECHA')[0].mensaje).toBe('La fecha de la factura no existe.');
    expect(de(await codigos(con((l) => (l.fechaEmision.valor = '2026-10-12'))), 'FECHA')[0].mensaje).toBe('La fecha de la factura es posterior a hoy.');
  });

  it('V11 mas de cuatro anos: revisar', async () => {
    expect(de(await codigos(con((l) => (l.fechaEmision.valor = '2022-10-10'))), 'FECHA_ANTIGUA')[0].nivel).toBe('revisar');
    expect(de(await codigos(con((l) => (l.fechaEmision.valor = '2022-10-12'))), 'FECHA_ANTIGUA')).toEqual([]);
  });

  it('V12 vencimiento anterior a la fecha', async () => {
    expect(de(await codigos(con((l) => (l.fechaVencimiento.valor = '2026-03-01'))), 'VENCIMIENTO')[0].campos).toEqual(['fechaVencimiento']);
  });

  it('V13 periodo cerrado (simulado)', async () => {
    const periodo = jest.fn(async () => false);
    expect(de(await codigos(deFixture('resultado-simple'), ctx({ periodoAbierto: periodo })), 'PERIODO')[0].nivel).toBe('revisar');
    expect(periodo).toHaveBeenCalledWith('2026-03-04');
  });
});

describe('V14-V22', () => {
  it('V14 duplicada y V15 archivo repetido', async () => {
    const r = await validarLectura(deFixture('resultado-simple'), ctx({ duplicado: { factura: { numeroCompleto: 'G-7' }, archivo: { fecha: '2026-05-02' } } }));
    expect(de(r.validaciones, 'DUPLICADA')[0]).toMatchObject({ nivel: 'error', mensaje: 'Ya registraste esta factura (G-7).' });
    expect(de(r.validaciones, 'ARCHIVO_REPETIDO')[0]).toMatchObject({ nivel: 'revisar', campos: [], mensaje: 'Este mismo archivo ya se registró el 02/05/2026.' });
    expect(r.estado).toBe('error');
  });

  it('V16 obligatorios', async () => {
    const vacia = lecturaVacia();
    const r = de(await codigos(vacia), 'OBLIGATORIOS').map((x) => x.mensaje);
    expect(r).toEqual([
      'No se ha podido leer el número de la factura.',
      'No se ha podido leer la fecha de la factura.',
      'No se ha podido leer ninguna base imponible.',
      'No se ha podido leer el total de la factura.',
    ]);
  });

  it('V17 moneda: USD en gastos es error; en ventas, solo en la moneda de la contabilidad', async () => {
    const usd = deFixture('resultado-usd');
    expect(de(await codigos(usd), 'MONEDA')[0].mensaje).toBe(
      'La factura está en USD: las facturas de gasto en otra moneda aún no se pueden registrar. Pasa los importes a euros antes de confirmar.',
    );
    const venta = ctx({ lector: 'VENTA', nifEmpresa: 'B12345674' });
    expect(de(await codigos(usd, { ...venta, monedaCuenta: 'USD' }), 'MONEDA')).toEqual([]);
    expect(de(await codigos(usd, venta), 'MONEDA')[0].nivel).toBe('error');
    expect(de(await codigos(con((l) => (l.moneda.valor = 'GBP')), venta), 'MONEDA')[0].nivel).toBe('error');
  });

  it('V18 QR: el importe no coincide (error, con sugerencia) y coincide (campos en ok aunque Azure dudara)', async () => {
    const mal = await validarLectura(deFixture('resultado-qr-no-coincide'), ctx());
    expect(de(mal.validaciones, 'QR')[0]).toMatchObject({ nivel: 'error', mensaje: 'El QR VERI*FACTU no coincide con la factura en el importe (QR 224,00 €; leído 242,00 €).' });
    expect(mal.campos['totales.totalFactura']).toMatchObject({ estado: 'error', sugerencia: 'El QR dice 224,00 €' });

    const bien = await validarLectura(deFixture('resultado-qr-ok'), ctx());
    expect(bien.campos.numero).toMatchObject({ estado: 'ok', fuente: 'qr', confianza: 1 }); // Azure lo leyo al 55 %
    expect(bien.estado).toBe('ok');

    const sinSerie = await validarLectura(compararQr(interpretarValorQr('https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR?nif=B12345674&numserie=F2026%2F0012&fecha=04-03-2026&importe=242.00'), con((l) => (l.numero.valor = '0012'))), ctx());
    expect(sinSerie.campos.numero).toMatchObject({ estado: 'revisar', sugerencia: 'El QR dice F2026/0012' });

    const pruebas = await validarLectura(deFixture('resultado-qr-pruebas'), ctx());
    expect(de(pruebas.validaciones, 'QR')[0]).toMatchObject({ nivel: 'revisar', campos: [] });
    expect(pruebas.estado).toBe('revisar');
  });

  it('V19 rectificativa y V20 nomina', async () => {
    const rect = con((l) => {
      l.tipoDocumento = { valor: 'rectificativa', confianza: null, fuente: 'claude' };
      l.rectificativa = { numeroRectificada: { valor: 'A-12', confianza: null, fuente: 'claude' }, motivo: { valor: null, confianza: null, fuente: 'claude' } };
    });
    expect(de(await codigos(rect), 'RECTIFICATIVA')[0]).toMatchObject({ nivel: 'error', mensaje: 'Es una factura rectificativa (rectifica a la A-12). Todavía no se puede registrar con el lector.' });
    const nomina = de(await codigos(con((l) => (l.tipoDocumento = { valor: 'nomina', confianza: null, fuente: 'claude' }))), 'NO_FACTURA');
    expect(nomina[0].nivel).toBe('revisar');
    expect(nomina[0].mensaje).toMatch(/Es una nómina/);
  });

  it('V21 paginas sin leer y V22 descuento y saldo anterior', async () => {
    const l = con((x) => {
      x.paginas = { archivo: 3, leidas: 2 };
      x.senales = { descuento: 10, saldoAnterior: 50 };
    });
    const vs = await codigos(l);
    expect(de(vs, 'PAGINAS_SIN_LEER')[0].mensaje).toBe('Solo se han leído las 2 primeras páginas. Comprueba que los totales son los de la factura completa.');
    expect(de(vs, 'DESCUENTO')[0].campos).toEqual(['totales.base']);
    expect(de(vs, 'SALDO_ANTERIOR')[0].campos).toEqual(['totales.totalAPagar']);
  });
});

describe('estado por confianza', () => {
  it('umbrales 0,80 y 0,50; sin confianza de Azure, revisar; de Claude, ok', () => {
    expect(estadoPorConfianza({ valor: 'x', confianza: 0.81, fuente: 'azure' }).nivel).toBe('ok');
    expect(estadoPorConfianza({ valor: 'x', confianza: 0.61, fuente: 'azure' })).toEqual({ nivel: 'revisar', motivo: 'Azure lo ha leído con poca seguridad (61 %).' });
    expect(estadoPorConfianza({ valor: 'x', confianza: 0.42, fuente: 'azure' })).toEqual({ nivel: 'revisar', motivo: 'No se ha podido leer bien.' });
    expect(estadoPorConfianza({ valor: 'x', confianza: null, fuente: 'azure' }).nivel).toBe('revisar');
    expect(estadoPorConfianza({ valor: 'x', confianza: null, fuente: 'claude' }).nivel).toBe('ok');
    expect(estadoPorConfianza({ valor: 'x', confianza: 0.3, fuente: 'qr' }).nivel).toBe('ok');
  });

  it('confianza baja en el fixture: numero, fecha y NIF a revisar', async () => {
    const r = await validarLectura(deFixture('resultado-confianza-baja'), ctx());
    expect(r.campos.numero?.estado).toBe('revisar');
    expect(r.campos.fechaEmision?.motivos).toEqual(['Azure lo ha leído con poca seguridad (55 %).']);
    expect(r.campos['emisor.nif']?.estado).toBe('revisar');
    expect(r.estado).toBe('revisar');
  });
});
