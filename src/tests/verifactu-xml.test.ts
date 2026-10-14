/**
 * XML de VERI*FACTU (services/verifactu/xml.ts) validado contra los esquemas
 * oficiales de la AEAT (xsd/) con xmllint-wasm, y la huella recalculada con
 * los textos leidos del XML (los vectores oficiales 6.1, 6.2 y 6.3 de la
 * especificacion de la huella v0.1.2).
 */
import { XMLParser } from 'fast-xml-parser';
import { cadenaAlta, cadenaAnulacion, huella } from '../services/verifactu/huella';
import {
  campoHuella,
  cuerpoConsulta,
  cuerpoRegFactu,
  sobreSoap,
  textoXml,
  xmlDeRegistro,
  xmlRegistroAlta,
  xmlRegistroAnulacion,
  type ColumnasAlta,
} from '../services/verifactu/xml';
import { sistemaInformatico } from '../services/verifactu/sistema';
import type { RegistroContenido, RegistroContenidoAnulacion } from '../services/verifactu/tipos';
import { validarXsd } from './ayuda-xsd';

jest.setTimeout(120_000);

const H61 = '3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60';
const H62 = 'F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97';
const H63 = '177547C0D57AC74748561D054A9CEC14B4C4EA23D1BEFD6F2E69E3A388F90C68';

const SISTEMA = sistemaInformatico({ numeroInstalacion: 'CONTA-clxyz0000000000000000000-20270101000000', multiplesOT: true });

const COL_61: ColumnasAlta = {
  idEmisor: '89890001K',
  numSerie: '12345678/G33',
  fechaExpedicion: '01-01-2024',
  tipoFactura: 'F1',
  cuotaTotal: '12.35',
  importeTotal: '123.45',
  fechaHoraHuso: '2024-01-01T19:20:30+01:00',
  huella: H61,
};

const contenido = (extra: Partial<RegistroContenido> = {}): RegistroContenido => ({
  version: 1,
  idVersion: '1.0',
  tipoHuella: '01',
  refExterna: 'clxyz0000000000000000000',
  nombreEmisor: 'EMPRESA PRUEBA SA',
  descripcionOperacion: 'Venta de cerámica',
  destinatarios: [{ nombre: 'CLIENTE ES SL', nif: 'B00000000' }],
  desglose: [
    { impuesto: '01', claveRegimen: '01', calificacionOperacion: 'S1', tipoImpositivo: '21.00', baseImponible: '58.81', cuotaRepercutida: '12.35' },
    { impuesto: '01', claveRegimen: '01', operacionExenta: 'E1', baseImponible: '52.29' },
  ],
  encadenamiento: { primerRegistro: true },
  sistemaInformatico: SISTEMA,
  ...extra,
});

const parser = new XMLParser({ removeNSPrefix: true, parseTagValue: false, ignoreAttributes: true, isArray: (n) => n === 'DetalleDesglose' || n === 'RegistroFactura' });

/** Huella de un alta recalculada con los textos LEIDOS del XML. */
function huellaDelAltaLeida(fragmento: string): { calculada: string; enXml: string } {
  const a = parser.parse(fragmento).RegistroAlta;
  const anterior = a.Encadenamiento.RegistroAnterior?.Huella ?? '';
  return {
    calculada: huella(
      cadenaAlta({
        idEmisor: a.IDFactura.IDEmisorFactura,
        numSerie: a.IDFactura.NumSerieFactura,
        fecha: a.IDFactura.FechaExpedicionFactura,
        tipoFactura: a.TipoFactura,
        cuotaTotal: a.CuotaTotal,
        importeTotal: a.ImporteTotal,
        huellaAnterior: anterior,
        fechaHoraHuso: a.FechaHoraHusoGenRegistro,
      }),
    ),
    enXml: a.Huella,
  };
}

async function esperarValido(xml: string, esquema: Parameters<typeof validarXsd>[1]) {
  const r = await validarXsd(xml, esquema);
  if (!r.valido) throw new Error(`No valida contra ${esquema}:\n${r.errores.slice(0, 5).join('\n')}\n\n${xml.slice(0, 2000)}`);
}

describe('XML del registro de alta', () => {
  it('6.1: primer registro, valido solo y dentro del envio, y la huella leida del XML es la oficial', async () => {
    const x = xmlRegistroAlta(COL_61, contenido());
    expect(x.startsWith('<sf:RegistroAlta xmlns:sf="https://www2.agenciatributaria.gob.es/')).toBe(true);
    expect(x).not.toContain('\n');
    await esperarValido(x, 'SuministroInformacion.xsd');
    await esperarValido(cuerpoRegFactu({ obligado: { nombre: 'EMPRESA PRUEBA SA', nif: '89890001K' }, registros: [x] }), 'SuministroLR.xsd');
    expect(huellaDelAltaLeida(x)).toEqual({ calculada: H61, enXml: H61 });
    expect(x).toContain('<sf:PrimerRegistro>S</sf:PrimerRegistro>');
  });

  it('6.2: alta encadenada, valida y con la huella oficial', async () => {
    const x = xmlRegistroAlta(
      { ...COL_61, numSerie: '12345679/G34', fechaHoraHuso: '2024-01-01T19:20:35+01:00', huella: H62 },
      contenido({ encadenamiento: { registroAnterior: { idEmisor: '89890001K', numSerie: '12345678/G33', fecha: '01-01-2024', huella: H61 } } }),
    );
    await esperarValido(x, 'SuministroInformacion.xsd');
    expect(huellaDelAltaLeida(x)).toEqual({ calculada: H62, enXml: H62 });
  });

  const variantes: Array<[string, Partial<RegistroContenido>, Partial<ColumnasAlta>]> = [
    [
      'S1 al 21 y al 10',
      {
        desglose: [
          { impuesto: '01', claveRegimen: '01', calificacionOperacion: 'S1', tipoImpositivo: '21.00', baseImponible: '100.00', cuotaRepercutida: '21.00' },
          { impuesto: '01', claveRegimen: '01', calificacionOperacion: 'S1', tipoImpositivo: '10.00', baseImponible: '50.00', cuotaRepercutida: '5.00' },
        ],
      },
      {},
    ],
    ['S2 (inversion del sujeto pasivo)', { desglose: [{ impuesto: '01', claveRegimen: '01', calificacionOperacion: 'S2', tipoImpositivo: '0.00', baseImponible: '100.00', cuotaRepercutida: '0.00' }] }, {}],
    [
      'exentas E1-E6 con las claves 01 y 02',
      {
        desglose: (['E1', 'E2', 'E3', 'E4', 'E5', 'E6'] as const).map((e) => ({
          impuesto: '01' as const,
          claveRegimen: e === 'E2' || e === 'E3' ? ('02' as const) : ('01' as const),
          operacionExenta: e,
          baseImponible: '10.00',
        })),
      },
      {},
    ],
    ['N2 (servicios fuera del territorio)', { desglose: [{ impuesto: '01', claveRegimen: '01', calificacionOperacion: 'N2', baseImponible: '100.00' }] }, {}],
    [
      'claves 07 y 08',
      {
        desglose: [
          { impuesto: '01', claveRegimen: '07', calificacionOperacion: 'S1', tipoImpositivo: '21.00', baseImponible: '100.00', cuotaRepercutida: '21.00' },
          { impuesto: '01', claveRegimen: '08', calificacionOperacion: 'N2', baseImponible: '10.00' },
        ],
      },
      {},
    ],
    [
      'IDOtro con y sin CodigoPais',
      {
        destinatarios: [
          { nombre: 'CLIENT FR SARL', idOtro: { codigoPais: 'FR', idType: '02', id: 'FR12345678901' } },
          { nombre: 'CLIENTE IT SRL', idOtro: { idType: '02', id: 'IT12345678901' } },
          { nombre: 'CUSTOMER INC', idOtro: { codigoPais: 'US', idType: '04', id: '12-3456789' } },
        ],
      },
      {},
    ],
    [
      'R1 por sustitucion con ImporteRectificacion',
      {
        tipoRectificativa: 'S',
        facturasRectificadas: [{ idEmisor: '89890001K', numSerie: 'A-1', fecha: '01-12-2023' }],
        importeRectificacion: { base: '100.00', cuota: '21.00' },
      },
      { tipoFactura: 'R1' },
    ],
    [
      'R1 por diferencias con importes negativos',
      {
        tipoRectificativa: 'I',
        facturasRectificadas: [{ idEmisor: '89890001K', numSerie: 'A-1', fecha: '01-12-2023' }],
        desglose: [{ impuesto: '01', claveRegimen: '01', calificacionOperacion: 'S1', tipoImpositivo: '21.00', baseImponible: '-10.00', cuotaRepercutida: '-2.10' }],
      },
      { tipoFactura: 'R1', cuotaTotal: '-2.10', importeTotal: '-12.10' },
    ],
    ['F2 sin destinatarios', { destinatarios: undefined }, { tipoFactura: 'F2' }],
    ['Macrodato y FechaOperacion', { macrodato: 'S', fechaOperacion: '31-12-2023' }, { importeTotal: '100000000.00' }],
    ['Subsanacion con RechazoPrevio X', {}, { subsanacion: true, rechazoPrevio: 'X' }],
  ];

  it.each(variantes)('%s: valido contra el esquema', async (_n, c, col) => {
    const x = xmlRegistroAlta({ ...COL_61, ...col }, contenido(c));
    await esperarValido(x, 'SuministroInformacion.xsd');
    expect(huellaDelAltaLeida(x).calculada).toBe(
      huella(cadenaAlta({ idEmisor: '89890001K', numSerie: col.numSerie ?? '12345678/G33', fecha: '01-01-2024', tipoFactura: col.tipoFactura ?? 'F1', cuotaTotal: col.cuotaTotal ?? '12.35', importeTotal: col.importeTotal ?? '123.45', huellaAnterior: '', fechaHoraHuso: COL_61.fechaHoraHuso })),
    );
  });

  it('subsanacion: Subsanacion y RechazoPrevio en su sitio; sin ellos, no salen', () => {
    const con = xmlRegistroAlta({ ...COL_61, subsanacion: true, rechazoPrevio: 'X' }, contenido());
    expect(con).toMatch(/<\/sf:NombreRazonEmisor><sf:Subsanacion>S<\/sf:Subsanacion><sf:RechazoPrevio>X<\/sf:RechazoPrevio><sf:TipoFactura>/);
    const sin = xmlRegistroAlta(COL_61, contenido());
    expect(sin).not.toContain('Subsanacion');
    expect(sin).not.toContain('RechazoPrevio');
  });

  it('nunca escribe campos que la app no usa', () => {
    const x = xmlRegistroAlta(COL_61, contenido({ avisos: ['no va al XML'] }));
    for (const n of ['FacturasSustituidas', 'FacturaSimplificadaArt7273', 'FacturaSinIdentifDestinatarioArt61d', 'EmitidaPorTerceroODestinatario', 'Tercero', 'Cupon', 'NumRegistroAcuerdoFacturacion', 'IdAcuerdoSistemaInformatico', 'Signature', 'no va al XML']) {
      expect(x).not.toContain(n);
    }
  });

  it('escapa & < > " \' en los textos libres y quita lo que XML no admite; sigue siendo valido', async () => {
    const nombre = 'López & Hijos <"Cerámica"> l\'Horta\x01';
    const x = xmlRegistroAlta(COL_61, contenido({ nombreEmisor: nombre, descripcionOperacion: 'Tejas & ladrillos > 10 < 20' }));
    expect(x).toContain('López &amp; Hijos &lt;&quot;Cerámica&quot;&gt; l&apos;Horta</sf:NombreRazonEmisor>');
    await esperarValido(x, 'SuministroInformacion.xsd');
    const leido = new XMLParser({ removeNSPrefix: true, parseTagValue: false, ignoreAttributes: true }).parse(x).RegistroAlta;
    expect(leido.NombreRazonEmisor).toBe('López & Hijos <"Cerámica"> l\'Horta');
    expect(leido.DescripcionOperacion).toBe('Tejas & ladrillos > 10 < 20');
    expect(textoXml('a\x00b￾c\uD800')).toBe('abc');
  });

  it('un caracter que XML no admite en un campo de la huella es un error, no se quita en silencio', () => {
    expect(() => xmlRegistroAlta({ ...COL_61, numSerie: 'A-1\x01' }, contenido())).toThrow(/NumSerieFactura/);
    expect(campoHuella('  A-1 ')).toBe('A-1');
  });

  it('el validador detecta el orden mal (TipoFactura antes que NombreRazonEmisor)', async () => {
    const x = xmlRegistroAlta(COL_61, contenido());
    const mal = x.replace('<sf:NombreRazonEmisor>EMPRESA PRUEBA SA</sf:NombreRazonEmisor><sf:TipoFactura>F1</sf:TipoFactura>', '<sf:TipoFactura>F1</sf:TipoFactura><sf:NombreRazonEmisor>EMPRESA PRUEBA SA</sf:NombreRazonEmisor>');
    expect(mal).not.toBe(x);
    expect((await validarXsd(mal, 'SuministroInformacion.xsd')).valido).toBe(false);
  });

  it('contenido de otra version: error', () => {
    expect(() => xmlRegistroAlta(COL_61, { ...contenido(), version: 2 } as unknown as RegistroContenido)).toThrow(/versión/);
  });
});

describe('XML del registro de anulacion', () => {
  const c: RegistroContenidoAnulacion = {
    version: 1,
    idVersion: '1.0',
    tipoHuella: '01',
    refExterna: 'clxyz0000000000000000000',
    encadenamiento: { registroAnterior: { idEmisor: '89890001K', numSerie: '12345679/G34', fecha: '01-01-2024', huella: H62 } },
    sistemaInformatico: SISTEMA,
  };
  const col = { idEmisor: '89890001K', numSerie: '12345679/G34', fechaExpedicion: '01-01-2024', fechaHoraHuso: '2024-01-01T19:20:40+01:00', huella: H63 };

  it('6.3: anulacion encadenada valida y con la huella oficial leida del XML', async () => {
    const x = xmlRegistroAnulacion(col, c);
    await esperarValido(x, 'SuministroInformacion.xsd');
    const a = parser.parse(x).RegistroAnulacion;
    const calculada = huella(
      cadenaAnulacion({
        idEmisor: a.IDFactura.IDEmisorFacturaAnulada,
        numSerie: a.IDFactura.NumSerieFacturaAnulada,
        fecha: a.IDFactura.FechaExpedicionFacturaAnulada,
        huellaAnterior: a.Encadenamiento.RegistroAnterior.Huella,
        fechaHoraHuso: a.FechaHoraHusoGenRegistro,
      }),
    );
    expect(calculada).toBe(H63);
    expect(a.Huella).toBe(H63);
  });

  it('con SinRegistroPrevio, RechazoPrevio y GeneradoPor sigue siendo valida', async () => {
    const x = xmlRegistroAnulacion({ ...col, sinRegistroPrevio: true, rechazoPrevio: 'S' }, { ...c, generadoPor: 'E' });
    expect(x).toMatch(/<sf:RefExterna>[^<]+<\/sf:RefExterna><sf:SinRegistroPrevio>S<\/sf:SinRegistroPrevio><sf:RechazoPrevio>S<\/sf:RechazoPrevio><sf:GeneradoPor>E<\/sf:GeneradoPor>/);
    await esperarValido(x, 'SuministroInformacion.xsd');
  });
});

describe('envio, consulta y sobre', () => {
  const obligado = { nombre: 'EMPRESA PRUEBA SA', nif: '89890001K' };

  it('un envio con alta y anulacion, Incidencia=S y FechaFinVeriFactu, valido', async () => {
    const alta = xmlRegistroAlta(COL_61, contenido());
    const anulacion = xmlRegistroAnulacion(
      { idEmisor: '89890001K', numSerie: '12345678/G33', fechaExpedicion: '01-01-2024', fechaHoraHuso: '2024-01-01T19:20:40+01:00', huella: H63 },
      { version: 1, idVersion: '1.0', tipoHuella: '01', encadenamiento: { registroAnterior: { idEmisor: '89890001K', numSerie: '12345678/G33', fecha: '01-01-2024', huella: H61 } }, sistemaInformatico: SISTEMA },
    );
    const x = cuerpoRegFactu({ obligado, remisionVoluntaria: { incidencia: true, fechaFinVerifactu: '31-12-2027' }, registros: [alta, anulacion] });
    expect(x).toContain('<sf:RemisionVoluntaria><sf:FechaFinVeriFactu>31-12-2027</sf:FechaFinVeriFactu><sf:Incidencia>S</sf:Incidencia></sf:RemisionVoluntaria>');
    expect(x).not.toContain('Representante');
    expect(x).not.toContain('RemisionRequerimiento');
    await esperarValido(x, 'SuministroLR.xsd');
    // Dentro del sobre SOAP sigue saliendo el mismo cuerpo.
    const sobre = sobreSoap(x);
    expect(sobre.startsWith('<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header/><soapenv:Body>')).toBe(true);
    expect(sobre).toContain(x);
  });

  it('sin RemisionVoluntaria si no hay incidencia ni renuncia', () => {
    expect(cuerpoRegFactu({ obligado, remisionVoluntaria: {}, registros: [xmlRegistroAlta(COL_61, contenido())] })).not.toContain('RemisionVoluntaria');
  });

  it('1000 registros valen; 0 o 1001, error; la fecha de fin tiene que ser 31-12-AAAA', async () => {
    const uno = xmlRegistroAlta(COL_61, contenido());
    await esperarValido(cuerpoRegFactu({ obligado, registros: Array(1000).fill(uno) }), 'SuministroLR.xsd');
    expect(() => cuerpoRegFactu({ obligado, registros: [] })).toThrow();
    expect(() => cuerpoRegFactu({ obligado, registros: Array(1001).fill(uno) })).toThrow();
    expect(() => cuerpoRegFactu({ obligado, remisionVoluntaria: { fechaFinVerifactu: '30-12-2027' }, registros: [uno] })).toThrow(/31-12-AAAA/);
  });

  it('la consulta de un periodo es valida contra ConsultaLR.xsd', async () => {
    const x = cuerpoConsulta({ obligado, ejercicio: '2026', periodo: '10' });
    await esperarValido(x, 'ConsultaLR.xsd');
    expect(() => cuerpoConsulta({ obligado, ejercicio: '26', periodo: '10' })).toThrow();
    expect(() => cuerpoConsulta({ obligado, ejercicio: '2026', periodo: '13' })).toThrow();
  });
});

describe('xmlDeRegistro', () => {
  const base = {
    tipo: 'ALTA',
    idEmisor: COL_61.idEmisor,
    numSerie: COL_61.numSerie,
    fechaExpedicion: COL_61.fechaExpedicion,
    tipoFactura: COL_61.tipoFactura,
    cuotaTotal: COL_61.cuotaTotal,
    importeTotal: COL_61.importeTotal,
    fechaHoraHuso: COL_61.fechaHoraHuso,
    huella: H61,
    subsanacion: false,
    rechazoPrevio: null,
    sinRegistroPrevio: false,
    contenido: contenido(),
  };

  it('sin XML guardado (registros de F1) monta el mismo que se habria guardado', () => {
    const guardado = xmlRegistroAlta(COL_61, contenido());
    expect(xmlDeRegistro({ ...base, xml: null })).toBe(guardado);
    expect(xmlDeRegistro({ ...base, xml: guardado })).toBe(guardado);
    expect(xmlDeRegistro({ ...base, xml: '<guardado/>' })).toBe('<guardado/>');
  });

  it('tipo desconocido o alta sin importes: error', () => {
    expect(() => xmlDeRegistro({ ...base, xml: null, tipo: 'OTRO' })).toThrow();
    expect(() => xmlDeRegistro({ ...base, xml: null, cuotaTotal: null })).toThrow();
  });
});
