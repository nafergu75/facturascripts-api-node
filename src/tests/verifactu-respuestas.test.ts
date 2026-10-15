/**
 * Lectura de las respuestas de la AEAT (services/verifactu/respuestas.ts) y
 * clasificacion del resultado de «Probar conexión», con respuestas y errores
 * sinteticos (los codigos y mensajes que da Node).
 */
import { clasificar, estadoRegistro, leerFault, leerRespuestaConsulta, limpiarTextoAeat, MAX_MENSAJE, MENSAJES_CONEXION, type RespuestaHttp } from '../services/verifactu/respuestas';

const NS = 'https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/';
const sobre = (cuerpo: string, prefijo = 'env') =>
  `<?xml version="1.0" encoding="UTF-8"?><${prefijo}:Envelope xmlns:${prefijo}="http://schemas.xmlsoap.org/soap/envelope/"><${prefijo}:Header/><${prefijo}:Body>${cuerpo}</${prefijo}:Body></${prefijo}:Envelope>`;
const fault = (codigo: string, texto: string, prefijo = 'env') =>
  sobre(`<${prefijo}:Fault><faultcode>${prefijo}:${codigo}</faultcode><faultstring>${texto}</faultstring></${prefijo}:Fault>`, prefijo);

const SIN_DATOS = sobre(
  `<tikLRRC:RespuestaConsultaFactuSistemaFacturacion xmlns:tikLRRC="${NS}RespuestaConsultaLR.xsd" xmlns:tik="${NS}SuministroInformacion.xsd">` +
    '<tikLRRC:Cabecera><tik:IDVersion>1.0</tik:IDVersion><tik:ObligadoEmision><tik:NombreRazon>EMPRESA</tik:NombreRazon><tik:NIF>89890001K</tik:NIF></tik:ObligadoEmision></tikLRRC:Cabecera>' +
    '<tikLRRC:PeriodoImputacion><tikLRRC:Ejercicio>2026</tikLRRC:Ejercicio><tikLRRC:Periodo>10</tikLRRC:Periodo></tikLRRC:PeriodoImputacion>' +
    '<tikLRRC:IndicadorPaginacion>N</tikLRRC:IndicadorPaginacion><tikLRRC:ResultadoConsulta>SinDatos</tikLRRC:ResultadoConsulta>' +
    '</tikLRRC:RespuestaConsultaFactuSistemaFacturacion>',
);

/** El ejemplo oficial (con «Correcta»), dos veces: una «Anulada». */
const fila = (estado: string, num: string) =>
  `<tikLRRC:RegistroRespuestaConsultaFactuSistemaFacturacion><tikLRRC:IDFactura><tik:IDEmisorFactura>XXXXXXXXX</tik:IDEmisorFactura><tik:NumSerieFactura>${num}</tik:NumSerieFactura><tik:FechaExpedicionFactura>27-11-2024</tik:FechaExpedicionFactura></tikLRRC:IDFactura>` +
  `<tikLRRC:DatosRegistroFacturacion><tikLRRC:TipoFactura>F1</tikLRRC:TipoFactura><tikLRRC:Desglose><tik:DetalleDesglose><tik:Impuesto>01</tik:Impuesto></tik:DetalleDesglose></tikLRRC:Desglose></tikLRRC:DatosRegistroFacturacion>` +
  `<tikLRRC:EstadoRegistro><tikLRRC:TimestampUltimaModificacion>2024-11-27T11:54:10+01:00</tikLRRC:TimestampUltimaModificacion><tikLRRC:EstadoRegistro>${estado}</tikLRRC:EstadoRegistro></tikLRRC:EstadoRegistro></tikLRRC:RegistroRespuestaConsultaFactuSistemaFacturacion>`;
const CON_DATOS = (filas: string, paginacion = 'S') =>
  sobre(
    `<tikLRRC:RespuestaConsultaFactuSistemaFacturacion xmlns:tikLRRC="${NS}RespuestaConsultaLR.xsd" xmlns:tik="${NS}SuministroInformacion.xsd">` +
      `<tikLRRC:IndicadorPaginacion>${paginacion}</tikLRRC:IndicadorPaginacion><tikLRRC:ResultadoConsulta>ConDatos</tikLRRC:ResultadoConsulta>${filas}</tikLRRC:RespuestaConsultaFactuSistemaFacturacion>`,
  );

const http = (status: number, cuerpo: string, tipoContenido: string | null = 'text/xml; charset=utf-8'): { respuesta: RespuestaHttp } => ({
  respuesta: { status, cuerpo, tipoContenido },
});
const errorNode = (code: string, message = 'fallo', extra: Record<string, unknown> = {}) => ({ error: Object.assign(new Error(message), { code, ...extra }) });

describe('leer respuestas de la AEAT', () => {
  it('consulta SinDatos', () => {
    expect(leerRespuestaConsulta(SIN_DATOS)).toEqual({ resultado: 'SinDatos', paginacion: 'N', registros: 0, estados: [] });
  });

  it('consulta ConDatos con «Correcta» y «Anulada» (el ejemplo oficial no cumple el XSD y se lee igual)', () => {
    expect(leerRespuestaConsulta(CON_DATOS(fila('Correcta', '88') + fila('Anulada', '89')))).toEqual({
      resultado: 'ConDatos',
      paginacion: 'S',
      registros: 2,
      estados: ['Correcto', 'Anulado'],
    });
    // Una sola fila tambien es una lista.
    expect(leerRespuestaConsulta(CON_DATOS(fila('Correcto', '88'), 'N'))?.registros).toBe(1);
  });

  it('estados en las dos formas que usa la AEAT', () => {
    expect(['Correcto', 'Correcta', 'AceptadoConErrores', 'AceptadaConErrores', 'Incorrecto', 'Anulado', 'Anulada', 'X'].map(estadoRegistro)).toEqual([
      'Correcto',
      'Correcto',
      'AceptadoConErrores',
      'AceptadoConErrores',
      'Incorrecto',
      'Anulado',
      'Anulado',
      null,
    ]);
  });

  it('Fault Client con su codigo, Fault Server y sin Fault', () => {
    expect(leerFault(fault('Client', 'Codigo[4104].El NIF no está identificado. NIF:89890001K'))).toEqual({
      tipo: 'Client',
      codigo: 4104,
      texto: 'Codigo[4104].El NIF no está identificado. NIF:89890001K',
    });
    expect(leerFault(fault('Server', 'Error interno', 'soapenv'))).toEqual({ tipo: 'Server', codigo: null, texto: 'Error interno' });
    expect(leerFault(SIN_DATOS)).toBeNull();
  });

  it('con DOCTYPE o ENTITY no se lee (ni se expanden entidades)', () => {
    const malo = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "boom">]>${SIN_DATOS.replace('<?xml version="1.0" encoding="UTF-8"?>', '')}`;
    expect(leerRespuestaConsulta(malo)).toBeNull();
    expect(leerFault(`<!DOCTYPE x>${fault('Client', 'Codigo[4104].x')}`)).toBeNull();
    expect(leerRespuestaConsulta('esto no es xml')).toBeNull();
    expect(leerRespuestaConsulta('')).toBeNull();
  });

  it('el texto de la AEAT, sin etiquetas, sin entidades y como mucho 300 caracteres', () => {
    expect(limpiarTextoAeat('<b>Codigo[4104]</b> &amp; NIF &lt;x&gt;')).toBe('Codigo[4104] & NIF <x>');
    expect(Array.from(limpiarTextoAeat('x'.repeat(400)))).toHaveLength(300);
  });
});

describe('clasificar el resultado de «Probar conexión»', () => {
  it('respuesta de la consulta (con o sin datos): CORRECTO', () => {
    expect(clasificar(http(200, SIN_DATOS), 'PRUEBAS')).toEqual({ ok: true, tipo: 'CORRECTO', mensaje: 'Conexión correcta con la AEAT (entorno de pruebas). Ha aceptado el certificado.', httpStatus: 200 });
    expect(clasificar(http(200, CON_DATOS(fila('Correcta', '1'))), 'PRUEBAS').tipo).toBe('CORRECTO');
  });

  it.each([
    [4112, 'SIN_PERMISO'],
    [4140, 'SIN_PERMISO'],
    [4132, 'SIN_PERMISO'],
    [4104, 'DATOS_OBLIGADO'],
    [4107, 'DATOS_OBLIGADO'],
    [4109, 'DATOS_OBLIGADO'],
    [4115, 'DATOS_OBLIGADO'],
    [4116, 'DATOS_OBLIGADO'],
    [4105, 'REPRESENTANTE'],
    [4117, 'REPRESENTANTE'],
    [4123, 'REPRESENTANTE'],
    [4124, 'REPRESENTANTE'],
    [4108, 'ERROR_AEAT'],
    [4110, 'ERROR_AEAT'],
    [4111, 'ERROR_AEAT'],
    [4128, 'ERROR_AEAT'],
    [4102, 'XML'],
    [4103, 'XML'],
    [4113, 'XML'],
    [4114, 'XML'],
    [4118, 'XML'],
    [4119, 'XML'],
    [4136, 'XML'],
    [4137, 'XML'],
    [4138, 'XML'],
    [4134, 'SERVICIO'],
    [4139, 'SERVICIO'],
    [4141, 'SERVICIO'],
    [4999, 'RESPUESTA_INESPERADA'],
  ])('Fault Client %i (HTTP 500): %s, con el codigo', (codigo, tipo) => {
    const r = clasificar(http(500, fault('Client', `Codigo[${codigo}].Texto de la AEAT`)), 'PRUEBAS');
    expect(r).toMatchObject({ ok: false, tipo, codigoAeat: codigo, httpStatus: 500 });
    if (tipo !== 'ERROR_AEAT') expect(r.mensaje).toContain(String(codigo));
  });

  it('los datos del obligado y los desconocidos llevan el texto de la AEAT', () => {
    expect(clasificar(http(500, fault('Client', 'Codigo[4104].El NIF no está identificado')), 'PRUEBAS').mensaje).toContain('El NIF no está identificado');
    expect(clasificar(http(500, fault('Client', 'Codigo[4999].Algo nuevo')), 'PRUEBAS').mensaje).toContain('Algo nuevo');
  });

  it('Fault Server: ERROR_AEAT', () => {
    expect(clasificar(http(500, fault('Server', 'Error interno')), 'PRUEBAS')).toMatchObject({ ok: false, tipo: 'ERROR_AEAT', httpStatus: 500 });
  });

  it('HTML: 401 y 403, certificado rechazado; 5xx, error de la AEAT; otro, inesperada', () => {
    const html = '<!DOCTYPE html><html><body>Forbidden</body></html>';
    expect(clasificar(http(403, html, 'text/html'), 'PRUEBAS').tipo).toBe('CERTIFICADO_RECHAZADO');
    expect(clasificar(http(401, html, null), 'PRUEBAS').tipo).toBe('CERTIFICADO_RECHAZADO');
    expect(clasificar(http(503, html, 'text/html'), 'PRUEBAS').tipo).toBe('ERROR_AEAT');
    expect(clasificar(http(200, html, 'text/html'), 'PRUEBAS')).toMatchObject({ tipo: 'RESPUESTA_INESPERADA', httpStatus: 200 });
  });

  it('XML desconocido, DOCTYPE, 2xx sin XML o 5xx sin Fault', () => {
    expect(clasificar(http(200, '<otra>cosa</otra>'), 'PRUEBAS').tipo).toBe('RESPUESTA_INESPERADA');
    expect(clasificar(http(200, `<!DOCTYPE x>${SIN_DATOS}`), 'PRUEBAS').tipo).toBe('RESPUESTA_INESPERADA');
    expect(clasificar(http(204, ''), 'PRUEBAS').mensaje).toContain('HTTP 204');
    expect(clasificar(http(502, 'Bad gateway', 'text/plain'), 'PRUEBAS').tipo).toBe('ERROR_AEAT');
  });

  it.each([
    ['ENOTFOUND', 'RED'],
    ['EAI_AGAIN', 'RED'],
    ['ECONNREFUSED', 'RED'],
    ['ENETUNREACH', 'RED'],
    ['ETIMEDOUT', 'TIEMPO_AGOTADO'],
    ['ECONNABORTED', 'TIEMPO_AGOTADO'],
    ['ERR_CANCELED', 'TIEMPO_AGOTADO'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SERVIDOR_NO_FIABLE'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'SERVIDOR_NO_FIABLE'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SERVIDOR_NO_FIABLE'],
    ['CERT_HAS_EXPIRED', 'SERVIDOR_NO_FIABLE'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'SERVIDOR_NO_FIABLE'],
    ['EPROTO', 'CERTIFICADO_RECHAZADO'],
    ['ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED', 'CERTIFICADO_RECHAZADO'],
    ['ECONNRESET', 'TLS_CORTADO'],
    ['ALGO_RARO', 'RESPUESTA_INESPERADA'],
  ])('error de Node %s: %s', (code, tipo) => {
    expect(clasificar(errorNode(code), 'PRUEBAS')).toMatchObject({ ok: false, tipo });
  });

  it('el aborto por tiempo (AbortSignal.timeout) y el «socket hang up» antes del TLS', () => {
    const abort = new Error('This operation was aborted');
    abort.name = 'AbortError';
    expect(clasificar({ error: abort }, 'PRUEBAS').tipo).toBe('TIEMPO_AGOTADO');
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    expect(clasificar({ error: timeout }, 'PRUEBAS').tipo).toBe('TIEMPO_AGOTADO');
    expect(clasificar({ error: new Error('Client network socket disconnected before secure TLS connection was established') }, 'PRUEBAS').tipo).toBe('TLS_CORTADO');
    expect(clasificar(errorNode('ERR_BAD_RESPONSE', 'maxContentLength size of 5242880 exceeded'), 'PRUEBAS').tipo).toBe('RESPUESTA_INESPERADA');
    expect(clasificar({ error: Object.assign(new Error('x'), { cause: { code: 'ENOTFOUND' } }) }, 'PRUEBAS').tipo).toBe('RED');
  });

  it('el mensaje nunca pasa de 1000 caracteres', () => {
    const r = clasificar(http(500, fault('Client', `Codigo[4104].${'x'.repeat(5000)}`)), 'PRUEBAS');
    expect(Array.from(r.mensaje).length).toBeLessThanOrEqual(MAX_MENSAJE);
  });

  it('ningun mensaje manda «avisar al administrador»: quien prueba la conexion ya lo es', () => {
    const textos = Object.values(MENSAJES_CONEXION).map((m) => (typeof m === 'function' ? (m as (...a: unknown[]) => string)(4102, 'texto', 'PRUEBAS') : m));
    for (const m of textos) expect(m).not.toMatch(/administrador/i);
    expect(MENSAJES_CONEXION.servidorNoFiable).toContain('avisa al soporte de Conta API');
    expect(MENSAJES_CONEXION.xml(4102)).toContain('no de tu certificado');
  });
});
