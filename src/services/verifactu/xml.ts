/**
 * XML de VERI*FACTU (spec verifactu, 3.3, 6.1 y 6.2). Funciones puras: no leen
 * la base de datos ni la red.
 *
 * Esquemas: tikeV1.0 de la AEAT (copias en ./xsd, que solo usan los tests).
 *  - xmlRegistroAlta / xmlRegistroAnulacion: el fragmento <sf:RegistroAlta> o
 *    <sf:RegistroAnulacion> de un registro, con su propia declaracion de
 *    espacio de nombres: se valida suelto contra SuministroInformacion.xsd y
 *    se guarda tal cual en VerifactuRegistro.xml.
 *  - cuerpoRegFactu: el envio (Cabecera y de 1 a 1000 registros).
 *  - cuerpoConsulta: la consulta de un periodo (la usa «Probar conexión»).
 *  - sobreSoap: el sobre SOAP 1.1 de cualquiera de los dos.
 *
 * Prefijos fijos (soapenv, sfLR, sf y con): las respuestas se leen sin mirar
 * prefijos (respuestas.ts). Nunca se escriben Representante,
 * RemisionRequerimiento, FacturasSustituidas, FacturaSimplificadaArt7273,
 * FacturaSinIdentifDestinatarioArt61d, EmitidaPorTerceroODestinatario,
 * Tercero, Cupon, NumRegistroAcuerdoFacturacion, IdAcuerdoSistemaInformatico
 * ni ds:Signature (no es obligatoria en VERI*FACTU).
 *
 * Los campos que entran en la huella (IDEmisorFactura, NumSerieFactura,
 * fechas, importes, FechaHoraHusoGenRegistro y Huella) se escriben con el
 * mismo recorte de espacios que huella.ts y, si llevan algo que el XML no
 * admite, es un error interno: un dato de la huella nunca se toca en silencio.
 */
import type {
  DetalleDesglose,
  Destinatario,
  Encadenamiento,
  RegistroContenido,
  RegistroContenidoAnulacion,
  SistemaInformatico,
} from './tipos';

const BASE_NS = 'https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/';
export const NS_SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
export const NS_SF = `${BASE_NS}SuministroInformacion.xsd`;
export const NS_SFLR = `${BASE_NS}SuministroLR.xsd`;
export const NS_CON = `${BASE_NS}ConsultaLR.xsd`;

/** Maximo de registros de un envio (SuministroLR.xsd, RegistroFactura maxOccurs). */
export const MAX_REGISTROS_ENVIO = 1000;

/** Caracteres que XML 1.0 no admite: controles (salvo tab, salto y retorno), U+FFFE, U+FFFF y suplentes sueltos. */
const NO_XML = /[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const escapar = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Texto libre para el XML: quita lo que XML 1.0 no admite y escapa & < > " '. */
export function textoXml(v: string | null | undefined): string {
  return escapar(String(v ?? '').replace(NO_XML, ''));
}

/**
 * Un campo de la huella para el XML: el mismo trim() que huella.ts y escapado.
 * Si lleva caracteres que el XML no admite, error interno (la huella se
 * calculo con ellos y el XML no puede llevarlos).
 */
export function campoHuella(v: string | null | undefined, nombre = 'campo'): string {
  const t = String(v ?? '').trim();
  if (t.replace(NO_XML, '') !== t) {
    throw new Error(`VERI*FACTU: el campo ${nombre} lleva caracteres que el XML no admite: no se puede generar el XML del registro.`);
  }
  return escapar(t);
}

/** Elemento con prefijo: <p:nombre>contenido</p:nombre> (el contenido ya va escapado). */
const el = (p: string, nombre: string, contenido: string) => `<${p}:${nombre}>${contenido}</${p}:${nombre}>`;
const sf = (nombre: string, contenido: string) => el('sf', nombre, contenido);

/** Columnas de un registro de alta que van al XML (las de la huella, la huella y los indicadores). */
export interface ColumnasAlta {
  idEmisor: string;
  numSerie: string;
  fechaExpedicion: string;
  tipoFactura: string;
  cuotaTotal: string;
  importeTotal: string;
  fechaHoraHuso: string;
  huella: string;
  subsanacion?: boolean;
  /** null | N | S | X */
  rechazoPrevio?: string | null;
}

/** Columnas de un registro de anulacion que van al XML. */
export interface ColumnasAnulacion {
  idEmisor: string;
  numSerie: string;
  fechaExpedicion: string;
  fechaHoraHuso: string;
  huella: string;
  sinRegistroPrevio?: boolean;
  /** null | N | S */
  rechazoPrevio?: string | null;
}

function encadenamientoXml(e: Encadenamiento): string {
  if ('primerRegistro' in e) return sf('Encadenamiento', sf('PrimerRegistro', 'S'));
  const a = e.registroAnterior;
  return sf(
    'Encadenamiento',
    sf(
      'RegistroAnterior',
      sf('IDEmisorFactura', campoHuella(a.idEmisor, 'IDEmisorFactura')) +
        sf('NumSerieFactura', campoHuella(a.numSerie, 'NumSerieFactura')) +
        sf('FechaExpedicionFactura', campoHuella(a.fecha, 'FechaExpedicionFactura')) +
        sf('Huella', campoHuella(a.huella, 'Huella')),
    ),
  );
}

function sistemaXml(s: SistemaInformatico): string {
  return sf(
    'SistemaInformatico',
    sf('NombreRazon', textoXml(s.nombreRazon)) +
      sf('NIF', textoXml(s.nif)) +
      sf('NombreSistemaInformatico', textoXml(s.nombreSistemaInformatico)) +
      sf('IdSistemaInformatico', textoXml(s.idSistemaInformatico)) +
      sf('Version', textoXml(s.version)) +
      sf('NumeroInstalacion', textoXml(s.numeroInstalacion)) +
      sf('TipoUsoPosibleSoloVerifactu', textoXml(s.tipoUsoPosibleSoloVerifactu)) +
      sf('TipoUsoPosibleMultiOT', textoXml(s.tipoUsoPosibleMultiOT)) +
      sf('IndicadorMultiplesOT', textoXml(s.indicadorMultiplesOT)),
  );
}

function destinatarioXml(d: Destinatario): string {
  const id =
    'nif' in d
      ? sf('NIF', textoXml(d.nif))
      : sf(
          'IDOtro',
          (d.idOtro.codigoPais ? sf('CodigoPais', textoXml(d.idOtro.codigoPais)) : '') +
            sf('IDType', textoXml(d.idOtro.idType)) +
            sf('ID', textoXml(d.idOtro.id)),
        );
  return sf('IDDestinatario', sf('NombreRazon', textoXml(d.nombre)) + id);
}

function detalleXml(d: DetalleDesglose): string {
  const calificacion = d.calificacionOperacion ? sf('CalificacionOperacion', textoXml(d.calificacionOperacion)) : '';
  const exenta = !d.calificacionOperacion && d.operacionExenta ? sf('OperacionExenta', textoXml(d.operacionExenta)) : '';
  return sf(
    'DetalleDesglose',
    sf('Impuesto', textoXml(d.impuesto)) +
      sf('ClaveRegimen', textoXml(d.claveRegimen)) +
      calificacion +
      exenta +
      (d.tipoImpositivo !== undefined ? sf('TipoImpositivo', textoXml(d.tipoImpositivo)) : '') +
      sf('BaseImponibleOimporteNoSujeto', textoXml(d.baseImponible)) +
      (d.cuotaRepercutida !== undefined ? sf('CuotaRepercutida', textoXml(d.cuotaRepercutida)) : ''),
  );
}

/**
 * <sf:RegistroAlta> de un registro, en el orden de RegistroFacturacionAltaType.
 * `r`: las columnas del registro; `c`: su contenido congelado (version 1).
 */
export function xmlRegistroAlta(r: ColumnasAlta, c: RegistroContenido): string {
  if (!c || c.version !== 1) throw new Error('VERI*FACTU: contenido del registro de alta con una versión desconocida.');
  const partes: string[] = [];
  partes.push(sf('IDVersion', textoXml(c.idVersion)));
  partes.push(
    sf(
      'IDFactura',
      sf('IDEmisorFactura', campoHuella(r.idEmisor, 'IDEmisorFactura')) +
        sf('NumSerieFactura', campoHuella(r.numSerie, 'NumSerieFactura')) +
        sf('FechaExpedicionFactura', campoHuella(r.fechaExpedicion, 'FechaExpedicionFactura')),
    ),
  );
  if (c.refExterna) partes.push(sf('RefExterna', textoXml(c.refExterna)));
  partes.push(sf('NombreRazonEmisor', textoXml(c.nombreEmisor)));
  if (r.subsanacion) partes.push(sf('Subsanacion', 'S'));
  if (r.rechazoPrevio) partes.push(sf('RechazoPrevio', textoXml(r.rechazoPrevio)));
  partes.push(sf('TipoFactura', campoHuella(r.tipoFactura, 'TipoFactura')));
  if (c.tipoRectificativa) partes.push(sf('TipoRectificativa', textoXml(c.tipoRectificativa)));
  if (c.facturasRectificadas?.length) {
    partes.push(
      sf(
        'FacturasRectificadas',
        c.facturasRectificadas
          .map((f) =>
            sf(
              'IDFacturaRectificada',
              sf('IDEmisorFactura', textoXml(f.idEmisor)) + sf('NumSerieFactura', textoXml(f.numSerie)) + sf('FechaExpedicionFactura', textoXml(f.fecha)),
            ),
          )
          .join(''),
      ),
    );
  }
  if (c.importeRectificacion) {
    const i = c.importeRectificacion;
    partes.push(
      sf(
        'ImporteRectificacion',
        sf('BaseRectificada', textoXml(i.base)) +
          sf('CuotaRectificada', textoXml(i.cuota)) +
          (i.cuotaRecargo !== undefined ? sf('CuotaRecargoRectificado', textoXml(i.cuotaRecargo)) : ''),
      ),
    );
  }
  if (c.fechaOperacion) partes.push(sf('FechaOperacion', textoXml(c.fechaOperacion)));
  partes.push(sf('DescripcionOperacion', textoXml(c.descripcionOperacion)));
  if (c.macrodato) partes.push(sf('Macrodato', textoXml(c.macrodato)));
  if (c.destinatarios?.length) partes.push(sf('Destinatarios', c.destinatarios.map(destinatarioXml).join('')));
  partes.push(sf('Desglose', c.desglose.map(detalleXml).join('')));
  partes.push(sf('CuotaTotal', campoHuella(r.cuotaTotal, 'CuotaTotal')));
  partes.push(sf('ImporteTotal', campoHuella(r.importeTotal, 'ImporteTotal')));
  partes.push(encadenamientoXml(c.encadenamiento));
  partes.push(sistemaXml(c.sistemaInformatico));
  partes.push(sf('FechaHoraHusoGenRegistro', campoHuella(r.fechaHoraHuso, 'FechaHoraHusoGenRegistro')));
  partes.push(sf('TipoHuella', textoXml(c.tipoHuella)));
  partes.push(sf('Huella', campoHuella(r.huella, 'Huella')));
  return `<sf:RegistroAlta xmlns:sf="${NS_SF}">${partes.join('')}</sf:RegistroAlta>`;
}

/** <sf:RegistroAnulacion> de un registro, en el orden de RegistroFacturacionAnulacionType. */
export function xmlRegistroAnulacion(r: ColumnasAnulacion, c: RegistroContenidoAnulacion): string {
  if (!c || c.version !== 1) throw new Error('VERI*FACTU: contenido del registro de anulación con una versión desconocida.');
  const partes: string[] = [];
  partes.push(sf('IDVersion', textoXml(c.idVersion)));
  partes.push(
    sf(
      'IDFactura',
      sf('IDEmisorFacturaAnulada', campoHuella(r.idEmisor, 'IDEmisorFacturaAnulada')) +
        sf('NumSerieFacturaAnulada', campoHuella(r.numSerie, 'NumSerieFacturaAnulada')) +
        sf('FechaExpedicionFacturaAnulada', campoHuella(r.fechaExpedicion, 'FechaExpedicionFacturaAnulada')),
    ),
  );
  if (c.refExterna) partes.push(sf('RefExterna', textoXml(c.refExterna)));
  if (r.sinRegistroPrevio) partes.push(sf('SinRegistroPrevio', 'S'));
  if (r.rechazoPrevio) partes.push(sf('RechazoPrevio', textoXml(r.rechazoPrevio)));
  partes.push(encadenamientoXml(c.encadenamiento));
  partes.push(sistemaXml(c.sistemaInformatico));
  partes.push(sf('FechaHoraHusoGenRegistro', campoHuella(r.fechaHoraHuso, 'FechaHoraHusoGenRegistro')));
  partes.push(sf('TipoHuella', textoXml(c.tipoHuella)));
  partes.push(sf('Huella', campoHuella(r.huella, 'Huella')));
  return `<sf:RegistroAnulacion xmlns:sf="${NS_SF}">${partes.join('')}</sf:RegistroAnulacion>`;
}

/** Obligado tributario de la cabecera (ObligadoEmision). */
export interface ObligadoXml {
  nombre: string;
  nif: string;
}

const obligadoXml = (o: ObligadoXml) => sf('ObligadoEmision', sf('NombreRazon', textoXml(o.nombre)) + sf('NIF', textoXml(o.nif)));

const FECHA_FIN_RE = /^31-12-\d{4}$/;

/**
 * Envio RegFactuSistemaFacturacion: Cabecera (obligado y, si hace falta,
 * RemisionVoluntaria) y de 1 a 1000 registros (los fragmentos de
 * xmlRegistroAlta/xmlRegistroAnulacion, todos del mismo obligado).
 * RemisionVoluntaria solo con `incidencia` (envio tras un fallo tecnico) o con
 * `fechaFinVerifactu` (renuncia, «31-12-AAAA»).
 */
export function cuerpoRegFactu(d: {
  obligado: ObligadoXml;
  remisionVoluntaria?: { incidencia?: true; fechaFinVerifactu?: string };
  registros: string[];
}): string {
  const n = d.registros.length;
  if (n < 1 || n > MAX_REGISTROS_ENVIO) throw new Error(`VERI*FACTU: un envío lleva de 1 a ${MAX_REGISTROS_ENVIO} registros (llegan ${n}).`);
  const rv = d.remisionVoluntaria;
  if (rv?.fechaFinVerifactu !== undefined && !FECHA_FIN_RE.test(rv.fechaFinVerifactu)) {
    throw new Error(`VERI*FACTU: FechaFinVeriFactu tiene que ser 31-12-AAAA (llega ${rv.fechaFinVerifactu}).`);
  }
  const remision =
    rv && (rv.incidencia || rv.fechaFinVerifactu)
      ? sf(
          'RemisionVoluntaria',
          (rv.fechaFinVerifactu ? sf('FechaFinVeriFactu', rv.fechaFinVerifactu) : '') + (rv.incidencia ? sf('Incidencia', 'S') : ''),
        )
      : '';
  const cabecera = el('sfLR', 'Cabecera', obligadoXml(d.obligado) + remision);
  const registros = d.registros.map((x) => el('sfLR', 'RegistroFactura', x)).join('');
  return `<sfLR:RegFactuSistemaFacturacion xmlns:sfLR="${NS_SFLR}" xmlns:sf="${NS_SF}">${cabecera}${registros}</sfLR:RegFactuSistemaFacturacion>`;
}

/**
 * Consulta ConsultaFactuSistemaFacturacion de un periodo (ejercicio «AAAA» y
 * periodo «MM»). Solo lee: no genera registros (la usa «Probar conexión»).
 */
export function cuerpoConsulta(d: { obligado: ObligadoXml; ejercicio: string; periodo: string }): string {
  if (!/^\d{4}$/.test(d.ejercicio)) throw new Error(`VERI*FACTU: ejercicio no válido: ${d.ejercicio}`);
  if (!/^(0[1-9]|1[0-2])$/.test(d.periodo)) throw new Error(`VERI*FACTU: periodo no válido: ${d.periodo}`);
  const cabecera = el('con', 'Cabecera', sf('IDVersion', '1.0') + obligadoXml(d.obligado));
  const filtro = el('con', 'FiltroConsulta', el('con', 'PeriodoImputacion', sf('Ejercicio', d.ejercicio) + sf('Periodo', d.periodo)));
  return `<con:ConsultaFactuSistemaFacturacion xmlns:con="${NS_CON}" xmlns:sf="${NS_SF}">${cabecera}${filtro}</con:ConsultaFactuSistemaFacturacion>`;
}

/** Sobre SOAP 1.1 (document/literal) con el cuerpo dentro. */
export function sobreSoap(cuerpo: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="${NS_SOAP}"><soapenv:Header/><soapenv:Body>${cuerpo}</soapenv:Body></soapenv:Envelope>`;
}

/** Lo que hace falta de un VerifactuRegistro para su XML. */
export interface RegistroParaXml {
  tipo: string;
  xml: string | null;
  idEmisor: string;
  numSerie: string;
  fechaExpedicion: string;
  tipoFactura: string | null;
  cuotaTotal: string | null;
  importeTotal: string | null;
  fechaHoraHuso: string;
  huella: string;
  subsanacion: boolean;
  rechazoPrevio: string | null;
  sinRegistroPrevio: boolean;
  contenido: unknown;
}

/**
 * XML de un registro: el guardado o, si no lo tiene (los generados en la fase
 * F1, antes del XML), el montado ahora con sus columnas y su contenido. No
 * escribe nada: la inmutabilidad no deja rellenar `xml` despues.
 */
export function xmlDeRegistro(r: RegistroParaXml): string {
  if (r.xml) return r.xml;
  if (r.tipo === 'ALTA') {
    if (!r.tipoFactura || r.cuotaTotal === null || r.importeTotal === null) {
      throw new Error('VERI*FACTU: al registro de alta le faltan el tipo de factura o los importes.');
    }
    return xmlRegistroAlta(
      {
        idEmisor: r.idEmisor,
        numSerie: r.numSerie,
        fechaExpedicion: r.fechaExpedicion,
        tipoFactura: r.tipoFactura,
        cuotaTotal: r.cuotaTotal,
        importeTotal: r.importeTotal,
        fechaHoraHuso: r.fechaHoraHuso,
        huella: r.huella,
        subsanacion: r.subsanacion,
        rechazoPrevio: r.rechazoPrevio,
      },
      r.contenido as RegistroContenido,
    );
  }
  if (r.tipo === 'ANULACION') {
    return xmlRegistroAnulacion(
      {
        idEmisor: r.idEmisor,
        numSerie: r.numSerie,
        fechaExpedicion: r.fechaExpedicion,
        fechaHoraHuso: r.fechaHoraHuso,
        huella: r.huella,
        sinRegistroPrevio: r.sinRegistroPrevio,
        rechazoPrevio: r.rechazoPrevio,
      },
      r.contenido as RegistroContenidoAnulacion,
    );
  }
  throw new Error(`VERI*FACTU: tipo de registro desconocido: ${r.tipo}`);
}
