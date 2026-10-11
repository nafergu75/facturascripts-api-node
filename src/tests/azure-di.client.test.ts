/**
 * Cliente REST de Azure Document Intelligence, con fetch simulado y las
 * respuestas oficiales de Microsoft (prebuilt-invoice, 2024-11-30). Ningun test
 * llama a Azure.
 */
import { logger } from '../config/logger';
import {
  _reiniciarPausa,
  analizar,
  azurePausado,
  borrarResultado,
  consultarResultado,
  extraerResultId,
  leerRetryAfter,
  TIEMPO_POST_MS,
} from '../services/lectura/azure-di.client';
import { aceptado, CLAVE, ENDPOINT, error, fixtureAzure, respuesta, resultado, RESULT_ID } from './fixtures/azure-di';

const cfg = { endpoint: ENDPOINT, clave: CLAVE };
const PDF = Buffer.from('%PDF-1.4 factura de prueba');
const sinEsperar = jest.fn(async () => undefined);

let fetchMock: jest.SpyInstance;
beforeEach(() => {
  _reiniciarPausa();
  fetchMock = jest.spyOn(global, 'fetch');
});
afterEach(() => fetchMock.mockRestore());

const llamada = (i = 0) => {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string> };
};

describe('POST :analyze', () => {
  it('va a la URL exacta, con la clave en la cabecera y el archivo en base64Source', async () => {
    fetchMock.mockResolvedValueOnce(aceptado());
    const r = await analizar(cfg, PDF, { locale: 'es-ES' });
    expect(r).toEqual({ tipo: 'aceptado', resultId: RESULT_ID, retryAfterS: 2 });
    const { url, init, headers } = llamada();
    expect(url).toBe(
      'https://prueba.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-invoice:analyze?_overload=analyzeDocument&api-version=2024-11-30&features=barcodes&locale=es-ES',
    );
    expect(init.method).toBe('POST');
    expect(headers['Ocp-Apim-Subscription-Key']).toBe(CLAVE);
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({ base64Source: PDF.toString('base64') });
  });

  it('empresa extranjera: sin locale', async () => {
    fetchMock.mockResolvedValueOnce(aceptado());
    await analizar(cfg, PDF, {});
    expect(llamada().url).not.toContain('locale');
    expect(llamada().url).toContain('features=barcodes');
  });

  it('un Operation-Location sin resultId es una respuesta rara', async () => {
    fetchMock.mockResolvedValueOnce(respuesta(null, 202, { 'Operation-Location': 'https://prueba.cognitiveservices.azure.com/otra/cosa' }));
    expect(await analizar(cfg, PDF)).toMatchObject({ tipo: 'fallo', codigo: 'AZURE_RESPUESTA_RARA', reintentable: false });
  });

  it.each([
    ['error-400-invalid-content', 400, 'AZURE_ARCHIVO'],
    ['error-400-invalid-argument', 400, 'AZURE_PETICION'],
    ['error-401', 401, 'AZURE_CLAVE'],
    ['error-403-cuota', 403, 'AZURE_CUOTA'],
  ])('%s (%i) da %s, sin reintentar', async (fixture, status, codigo) => {
    fetchMock.mockResolvedValueOnce(error(fixture, status));
    expect(await analizar(cfg, PDF, { esperar: sinEsperar })).toMatchObject({ tipo: 'fallo', codigo, reintentable: false, http: status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('401 o 403: una hora sin llamar a Azure (cortocircuito)', async () => {
    fetchMock.mockResolvedValueOnce(error('error-403-cuota', 403));
    await analizar(cfg, PDF);
    expect(azurePausado()).toBe('AZURE_CUOTA');
    expect(azurePausado(Date.now() + 61 * 60 * 1000)).toBeNull();
    _reiniciarPausa();
    fetchMock.mockResolvedValueOnce(error('error-401', 401));
    await analizar(cfg, PDF);
    expect(azurePausado()).toBe('AZURE_CLAVE');
  });

  it('429: espera Retry-After (3 s como mucho) y reintenta una vez; si vuelve a fallar, AZURE_OCUPADO', async () => {
    fetchMock.mockResolvedValueOnce(error('error-429', 429)).mockResolvedValueOnce(error('error-429', 429));
    const esperar = jest.fn(async () => undefined);
    expect(await analizar(cfg, PDF, { esperar })).toMatchObject({ tipo: 'fallo', codigo: 'AZURE_OCUPADO' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(esperar).toHaveBeenCalledWith(1000);
  });

  it('429 y luego 202: aceptado al segundo intento', async () => {
    fetchMock.mockResolvedValueOnce(error('error-429', 429)).mockResolvedValueOnce(aceptado());
    expect(await analizar(cfg, PDF, { esperar: sinEsperar })).toMatchObject({ tipo: 'aceptado', resultId: RESULT_ID });
  });

  it('503: un reintento a los 2 s y despues AZURE_SERVICIO', async () => {
    fetchMock.mockResolvedValueOnce(error('error-503', 503)).mockResolvedValueOnce(error('error-503', 503));
    const esperar = jest.fn(async () => undefined);
    expect(await analizar(cfg, PDF, { esperar })).toMatchObject({ tipo: 'fallo', codigo: 'AZURE_SERVICIO', reintentable: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(esperar).toHaveBeenCalledWith(2000);
  });

  it('AbortError o TimeoutError: AZURE_TIEMPO sin reintentar (el primer POST pudo llegar)', async () => {
    for (const name of ['AbortError', 'TimeoutError']) {
      fetchMock.mockReset();
      fetchMock.mockRejectedValueOnce(Object.assign(new Error('x'), { name }));
      expect(await analizar(cfg, PDF, { esperar: sinEsperar })).toEqual({ tipo: 'fallo', codigo: 'AZURE_TIEMPO', reintentable: false });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('un fallo de red en el POST tampoco se reintenta', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await analizar(cfg, PDF, { esperar: sinEsperar })).toMatchObject({ tipo: 'fallo', codigo: 'AZURE_SERVICIO', reintentable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('el POST espera 10 s como mucho y ninguna llamada sigue redirecciones', async () => {
    expect(TIEMPO_POST_MS).toBe(10_000);
    fetchMock.mockResolvedValueOnce(aceptado()).mockResolvedValueOnce(resultado('resultado-running')).mockResolvedValueOnce(respuesta(null, 204));
    await analizar(cfg, PDF);
    await consultarResultado(cfg, RESULT_ID);
    await borrarResultado(cfg, RESULT_ID);
    for (let i = 0; i < 3; i++) expect(llamada(i).init.redirect).toBe('error');
  });

  it('una redireccion: AZURE_RESPUESTA_RARA, sin reintentar', async () => {
    const redireccion = () => Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') });
    fetchMock.mockRejectedValueOnce(redireccion());
    expect(await analizar(cfg, PDF, { esperar: sinEsperar })).toMatchObject({ codigo: 'AZURE_RESPUESTA_RARA', reintentable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRejectedValueOnce(redireccion());
    expect(await consultarResultado(cfg, RESULT_ID)).toMatchObject({ codigo: 'AZURE_RESPUESTA_RARA', reintentable: false });
  });
});

describe('resultId y Retry-After', () => {
  it('del Operation-Location solo se toma el resultId', () => {
    const ajeno = fixtureAzure<{ headers: Record<string, string> }>('analizar-202-host-ajeno').headers['Operation-Location'];
    expect(extraerResultId(ajeno)).toBe(RESULT_ID);
    expect(extraerResultId('https://x/analyzeResults/no-es-un-uuid')).toBeNull();
    expect(extraerResultId(null)).toBeNull();
  });

  it('con un Operation-Location de otro host, la consulta va al endpoint configurado', async () => {
    fetchMock.mockResolvedValueOnce(aceptado('analizar-202-host-ajeno')).mockResolvedValueOnce(resultado('resultado-running'));
    const r = await analizar(cfg, PDF);
    if (r.tipo !== 'aceptado') throw new Error('se esperaba aceptado');
    await consultarResultado(cfg, r.resultId);
    const { url, headers } = llamada(1);
    expect(url).toBe(`${ENDPOINT}/documentintelligence/documentModels/prebuilt-invoice/analyzeResults/${RESULT_ID}?api-version=2024-11-30`);
    expect(url).not.toContain('example.com');
    expect(headers['Ocp-Apim-Subscription-Key']).toBe(CLAVE);
  });

  it('Retry-After: sin el, 2 s; 0 da 1 s; 60 da 10 s', () => {
    expect(leerRetryAfter(null)).toBe(2);
    expect(leerRetryAfter('abc')).toBe(2);
    expect(leerRetryAfter('0')).toBe(1);
    expect(leerRetryAfter('60')).toBe(10);
    expect(leerRetryAfter('5')).toBe(5);
  });
});

describe('GET analyzeResults', () => {
  it('running es pendiente; con Retry-After lo devuelve', async () => {
    fetchMock.mockResolvedValueOnce(resultado('resultado-running'));
    expect(await consultarResultado(cfg, RESULT_ID)).toEqual({ tipo: 'pendiente', retryAfterS: null });
    fetchMock.mockResolvedValueOnce(respuesta(fixtureAzure('resultado-running'), 200, { 'Retry-After': '3' }));
    expect(await consultarResultado(cfg, RESULT_ID)).toEqual({ tipo: 'pendiente', retryAfterS: 3 });
    fetchMock.mockResolvedValueOnce(respuesta({ status: 'notStarted' }, 200));
    expect((await consultarResultado(cfg, RESULT_ID)).tipo).toBe('pendiente');
  });

  it('succeeded es hecho, con el analyzeResult', async () => {
    fetchMock.mockResolvedValueOnce(resultado('resultado-simple'));
    const r = await consultarResultado(cfg, RESULT_ID);
    expect(r.tipo).toBe('hecho');
    if (r.tipo === 'hecho') expect(r.analyzeResult.modelId).toBe('prebuilt-invoice');
  });

  it('failed, canceled y skipped: AZURE_ANALISIS con los codigos al log', async () => {
    const aviso = jest.spyOn(logger, 'warn');
    fetchMock.mockResolvedValueOnce(resultado('resultado-failed'));
    expect(await consultarResultado(cfg, RESULT_ID)).toMatchObject({ tipo: 'fallo', codigo: 'AZURE_ANALISIS', reintentable: false });
    expect(JSON.stringify(aviso.mock.calls)).toContain('InvalidContentDimensions');
    for (const status of ['canceled', 'skipped']) {
      fetchMock.mockResolvedValueOnce(respuesta({ status }, 200));
      expect(await consultarResultado(cfg, RESULT_ID)).toMatchObject({ tipo: 'fallo', codigo: 'AZURE_ANALISIS' });
    }
    aviso.mockRestore();
  });

  it('404 OperationNotFound: AZURE_RESULTADO_PERDIDO; 429 y 503 reintentables', async () => {
    fetchMock.mockResolvedValueOnce(error('error-404-operation', 404));
    expect(await consultarResultado(cfg, RESULT_ID)).toMatchObject({ codigo: 'AZURE_RESULTADO_PERDIDO', reintentable: false });
    fetchMock.mockResolvedValueOnce(error('error-429', 429));
    expect(await consultarResultado(cfg, RESULT_ID)).toMatchObject({ codigo: 'AZURE_OCUPADO', reintentable: true });
    fetchMock.mockResolvedValueOnce(error('error-503', 503));
    expect(await consultarResultado(cfg, RESULT_ID)).toMatchObject({ codigo: 'AZURE_SERVICIO', reintentable: true });
    expect(fetchMock).toHaveBeenCalledTimes(3); // el GET no reintenta dentro
  });

  it('sin respuesta: AZURE_TIEMPO', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'TimeoutError' }));
    expect(await consultarResultado(cfg, RESULT_ID)).toMatchObject({ codigo: 'AZURE_TIEMPO', reintentable: true });
  });
});

describe('DELETE analyzeResults', () => {
  it('204 es correcto y usa el endpoint configurado', async () => {
    fetchMock.mockResolvedValueOnce(respuesta(null, 204));
    await expect(borrarResultado(cfg, RESULT_ID)).resolves.toBeUndefined();
    expect(llamada().init.method).toBe('DELETE');
    expect(llamada().url).toBe(`${ENDPOINT}/documentintelligence/documentModels/prebuilt-invoice/analyzeResults/${RESULT_ID}?api-version=2024-11-30`);
  });

  it('un 500 o un fallo de red no lanzan error', async () => {
    fetchMock.mockResolvedValueOnce(error('error-503', 500));
    await expect(borrarResultado(cfg, RESULT_ID)).resolves.toBeUndefined();
    fetchMock.mockRejectedValueOnce(new Error('red caida'));
    await expect(borrarResultado(cfg, RESULT_ID)).resolves.toBeUndefined();
  });
});

describe('privacidad', () => {
  it('la clave no aparece en ningun log ni en ningun resultado', async () => {
    const espias = [jest.spyOn(logger, 'warn'), jest.spyOn(logger, 'error'), jest.spyOn(logger, 'info'), jest.spyOn(console, 'error'), jest.spyOn(console, 'warn'), jest.spyOn(console, 'log')];
    const resultados: unknown[] = [];
    for (const [f, s] of [['error-400-invalid-content', 400], ['error-400-invalid-argument', 400], ['error-401', 401], ['error-403-cuota', 403], ['error-503', 503]] as const) {
      _reiniciarPausa();
      fetchMock.mockResolvedValueOnce(error(f, s));
      if (s === 503) fetchMock.mockResolvedValueOnce(error(f, s));
      resultados.push(await analizar(cfg, PDF, { esperar: sinEsperar }));
    }
    fetchMock.mockRejectedValueOnce(new Error(`fallo hacia ${ENDPOINT} con ${CLAVE}`));
    resultados.push(await consultarResultado(cfg, RESULT_ID));
    fetchMock.mockResolvedValueOnce(resultado('resultado-failed'));
    resultados.push(await consultarResultado(cfg, RESULT_ID));
    fetchMock.mockResolvedValueOnce(resultado('resultado-simple'));
    await consultarResultado(cfg, RESULT_ID);

    const registrado = JSON.stringify(espias.map((e) => e.mock.calls)) + JSON.stringify(resultados);
    expect(registrado).not.toContain(CLAVE);
    expect(registrado).not.toContain('cognitiveservices');
    // Ni los valores de la factura ni los mensajes de Azure.
    expect(registrado).not.toContain('B12345674');
    expect(registrado).not.toContain('IMPRENTA');
    expect(registrado).not.toContain('corrupted');
    espias.forEach((e) => e.mockRestore());
  });
});
