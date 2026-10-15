/**
 * Cliente SOAP de VERI*FACTU (services/verifactu/cliente-aeat.ts) contra un
 * servidor HTTPS LOCAL que pide certificado de cliente, con certificados
 * generados aqui. Nunca se llama a la AEAT (prewww1, www1...).
 */
import https from 'https';
import type { AddressInfo } from 'net';
import { enviarSoap, exigirUrlPermitida, fijarDestinoParaTests, urlServicio, URL_SERVICIO } from '../services/verifactu/cliente-aeat';
import { clasificar } from '../services/verifactu/respuestas';
import { cuerpoConsulta, sobreSoap } from '../services/verifactu/xml';
import { crearCa, crearCertificado, pkcs12, sujetoRepresentante, type CertificadoPrueba } from './ayuda-certificados';

jest.setTimeout(120_000);

const NS = 'https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/';
const SIN_DATOS =
  `<?xml version="1.0" encoding="UTF-8"?><env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body>` +
  `<tikLRRC:RespuestaConsultaFactuSistemaFacturacion xmlns:tikLRRC="${NS}RespuestaConsultaLR.xsd"><tikLRRC:IndicadorPaginacion>N</tikLRRC:IndicadorPaginacion><tikLRRC:ResultadoConsulta>SinDatos</tikLRRC:ResultadoConsulta></tikLRRC:RespuestaConsultaFactuSistemaFacturacion>` +
  `</env:Body></env:Envelope>`;
const CON_DATOS = SIN_DATOS.replace('SinDatos</tikLRRC:ResultadoConsulta>', 'ConDatos</tikLRRC:ResultadoConsulta><tikLRRC:RegistroRespuestaConsultaFactuSistemaFacturacion><tikLRRC:EstadoRegistro><tikLRRC:EstadoRegistro>Correcta</tikLRRC:EstadoRegistro></tikLRRC:EstadoRegistro></tikLRRC:RegistroRespuestaConsultaFactuSistemaFacturacion>');
const fault = (tipo: string, texto: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body><env:Fault><faultcode>env:${tipo}</faultcode><faultstring>${texto}</faultstring></env:Fault></env:Body></env:Envelope>`;

const CLAVE = 'clave-de-prueba';
let ca: CertificadoPrueba;
let servidorCert: CertificadoPrueba;
let cliente: Buffer;
let clienteOtraCa: Buffer;
let servidor: https.Server;
let url = '';
/** Lo que contesta el servidor en cada prueba. */
let responder: (res: import('http').ServerResponse) => void = (res) => res.end(SIN_DATOS);
const cabecerasVistas: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  ca = crearCa();
  servidorCert = crearCertificado({ sujeto: [{ name: 'commonName', value: 'localhost' }], firmante: ca, dns: ['localhost'], ips: ['127.0.0.1'] });
  cliente = pkcs12({ cert: crearCertificado({ sujeto: sujetoRepresentante('A10952364', 'IFBIOSOLUCIONES SA'), firmante: ca }), contrasena: CLAVE });
  const otraCa = crearCa('OTRA AC');
  clienteOtraCa = pkcs12({ cert: crearCertificado({ sujeto: sujetoRepresentante('A10952364', 'IFBIOSOLUCIONES SA'), firmante: otraCa }), contrasena: CLAVE });
  servidor = https.createServer({ key: servidorCert.clavePem, cert: servidorCert.certPem, ca: ca.certPem, requestCert: true, rejectUnauthorized: true }, (req, res) => {
    cabecerasVistas.push({ ...req.headers });
    let cuerpo = '';
    req.on('data', (c) => (cuerpo += c));
    req.on('end', () => {
      if (req.headers.soapaction !== '""' || req.headers['content-type'] !== 'text/xml; charset=utf-8' || !cuerpo.includes('ConsultaFactuSistemaFacturacion')) {
        res.statusCode = 400;
        res.end('peticion mal formada');
        return;
      }
      responder(res);
    });
  });
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', () => ok()));
  url = `https://localhost:${(servidor.address() as AddressInfo).port}/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP`;
});

afterAll(async () => {
  fijarDestinoParaTests(null);
  await new Promise<void>((ok) => servidor.close(() => ok()));
});

beforeEach(() => {
  fijarDestinoParaTests({ url, ca: ca.certPem });
  responder = (res) => res.end(SIN_DATOS);
});

const sobre = sobreSoap(cuerpoConsulta({ obligado: { nombre: 'IFBIOSOLUCIONES SA', nif: 'A10952364' }, ejercicio: '2026', periodo: '10' }));
/** Llama al servidor local y clasifica el resultado como lo hace «Probar conexión». */
async function probar(o: { pfx?: Buffer; timeoutMs?: number } = {}) {
  try {
    const r = await enviarSoap({ url: URL_SERVICIO.PRUEBAS.normal, pfx: o.pfx ?? cliente, passphrase: CLAVE, sobre, timeoutMs: o.timeoutMs ?? 5000 });
    return clasificar({ respuesta: r }, 'PRUEBAS');
  } catch (e) {
    return clasificar({ error: e }, 'PRUEBAS');
  }
}

describe('cliente SOAP contra un servidor local con certificado de cliente', () => {
  it('SinDatos y ConDatos: CORRECTO; el servidor ve SOAPAction "" y text/xml; charset=utf-8', async () => {
    expect(await probar()).toMatchObject({ ok: true, tipo: 'CORRECTO', httpStatus: 200 });
    expect(cabecerasVistas.at(-1)).toMatchObject({ soapaction: '""', 'content-type': 'text/xml; charset=utf-8' });
    responder = (res) => res.end(CON_DATOS);
    expect(await probar()).toMatchObject({ ok: true, tipo: 'CORRECTO' });
  });

  it.each([
    [4104, 'DATOS_OBLIGADO'],
    [4112, 'SIN_PERMISO'],
    [4140, 'SIN_PERMISO'],
  ])('Fault Client %i con HTTP 500: %s', async (codigo, tipo) => {
    responder = (res) => {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/xml; charset=utf-8');
      res.end(fault('Client', `Codigo[${codigo}].Error de prueba`));
    };
    expect(await probar()).toMatchObject({ ok: false, tipo, codigoAeat: codigo, httpStatus: 500 });
  });

  it('Fault Server: ERROR_AEAT; HTML 403: certificado rechazado; HTML 503: ERROR_AEAT', async () => {
    responder = (res) => {
      res.statusCode = 500;
      res.end(fault('Server', 'Error interno'));
    };
    expect((await probar()).tipo).toBe('ERROR_AEAT');
    responder = (res) => {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><body>Forbidden</body></html>');
    };
    expect((await probar()).tipo).toBe('CERTIFICADO_RECHAZADO');
    responder = (res) => {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><body>Mantenimiento</body></html>');
    };
    expect((await probar()).tipo).toBe('ERROR_AEAT');
  });

  it('un servidor que no contesta: TIEMPO_AGOTADO', async () => {
    responder = () => undefined;
    const r = await probar({ timeoutMs: 500 });
    expect(r).toMatchObject({ ok: false, tipo: 'TIEMPO_AGOTADO' });
  });

  it('una respuesta de mas de 5 MB: RESPUESTA_INESPERADA', async () => {
    responder = (res) => res.end('x'.repeat(6 * 1024 * 1024));
    expect((await probar()).tipo).toBe('RESPUESTA_INESPERADA');
  });

  it('puerto cerrado: RED', async () => {
    const cerrado = https.createServer();
    await new Promise<void>((ok) => cerrado.listen(0, '127.0.0.1', () => ok()));
    const puerto = (cerrado.address() as AddressInfo).port;
    await new Promise<void>((ok) => cerrado.close(() => ok()));
    fijarDestinoParaTests({ url: `https://127.0.0.1:${puerto}/`, ca: ca.certPem });
    expect((await probar()).tipo).toBe('RED');
  });

  it('certificado de cliente de otra CA: el servidor lo rechaza (TLS_CORTADO o CERTIFICADO_RECHAZADO, segun TLS 1.2 o 1.3)', async () => {
    const r = await probar({ pfx: clienteOtraCa });
    expect(r.ok).toBe(false);
    expect(['TLS_CORTADO', 'CERTIFICADO_RECHAZADO']).toContain(r.tipo);
  });

  it('sin la CA del servidor: SERVIDOR_NO_FIABLE (el servidor siempre se comprueba)', async () => {
    fijarDestinoParaTests({ url });
    expect((await probar()).tipo).toBe('SERVIDOR_NO_FIABLE');
  });

  it('no se llama a la AEAT dentro de una transaccion', async () => {
    const { enCallbackDeTransaccion } = await import('../config/guardaTransaccion');
    await expect(enCallbackDeTransaccion(() => enviarSoap({ url, pfx: cliente, passphrase: CLAVE, sobre, timeoutMs: 1000 }))).rejects.toThrow(/transacción/);
  });
});

describe('doble candado y destino de los tests', () => {
  it('PRODUCCION sin el candado abierto: error, nunca la URL de www', () => {
    expect(() => urlServicio('PRODUCCION', { sello: false }, { produccion: false })).toThrow(/bloqueado/);
    expect(urlServicio('PRODUCCION', { sello: false }, { produccion: true })).toBe('https://www1.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP');
    expect(urlServicio('PRODUCCION', { sello: true }, { produccion: true })).toBe('https://www10.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP');
    expect(urlServicio('PRUEBAS', { sello: false }, { produccion: false })).toBe('https://prewww1.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP');
    // En los tests el candado esta cerrado.
    expect(() => urlServicio('PRODUCCION', { sello: false })).toThrow();
  });

  it('enviarSoap tampoco envia a www1/www10 con el candado cerrado, ni a una URL que no es del WSDL (antes de conectar)', async () => {
    const vistas = cabecerasVistas.length;
    const enviar = (u: string, produccion: boolean) => enviarSoap({ url: u, pfx: cliente, passphrase: CLAVE, sobre, timeoutMs: 1000 }, { produccion });
    await expect(enviar(URL_SERVICIO.PRODUCCION.normal, false)).rejects.toMatchObject({ code: 'VERIFACTU_PRODUCCION_BLOQUEADA' });
    await expect(enviar(URL_SERVICIO.PRODUCCION.sello, false)).rejects.toMatchObject({ code: 'VERIFACTU_PRODUCCION_BLOQUEADA' });
    // Con el candado por defecto (cerrado en los tests), igual.
    await expect(enviarSoap({ url: URL_SERVICIO.PRODUCCION.normal, pfx: cliente, passphrase: CLAVE, sobre, timeoutMs: 1000 })).rejects.toMatchObject({
      code: 'VERIFACTU_PRODUCCION_BLOQUEADA',
    });
    await expect(enviar('https://www1.agenciatributaria.gob.es/otra/ruta', true)).rejects.toThrow(/WSDL/);
    await expect(enviar(url, false)).rejects.toThrow(/WSDL/);
    // Nada ha llegado al servidor local (que es a donde iria todo en los tests).
    expect(cabecerasVistas.length).toBe(vistas);
    expect(() => exigirUrlPermitida(URL_SERVICIO.PRUEBAS.normal, { produccion: false })).not.toThrow();
    expect(() => exigirUrlPermitida(URL_SERVICIO.PRUEBAS.sello, { produccion: false })).not.toThrow();
    expect(() => exigirUrlPermitida(URL_SERVICIO.PRODUCCION.normal, { produccion: true })).not.toThrow();
  });

  it('fijarDestinoParaTests solo funciona con NODE_ENV=test', () => {
    const antes = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => fijarDestinoParaTests({ url: 'https://localhost' })).toThrow();
    } finally {
      process.env.NODE_ENV = antes;
    }
  });
});
