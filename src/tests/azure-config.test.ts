/**
 * Configuracion de Azure Document Intelligence: se lee aparte de envSchema
 * (una errata no tumba la API), el endpoint tiene que ser de Azure y /health
 * solo dice si existe, nunca el valor.
 */
import request from 'supertest';
import { estadoOcr, leerAzure, modoLector } from '../config/azure';
import { logger } from '../config/logger';

const CLAVE = 'clave-secreta-de-prueba-0123456789abcdef';

describe('leerAzure', () => {
  it('quita la barra final del endpoint', () => {
    expect(leerAzure({ AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: 'https://conta.cognitiveservices.azure.com/', AZURE_DOCUMENT_INTELLIGENCE_KEY: CLAVE })).toEqual({
      endpoint: 'https://conta.cognitiveservices.azure.com',
      clave: CLAVE,
    });
    expect(leerAzure({ AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: 'https://westeurope.api.cognitive.microsoft.com', AZURE_DOCUMENT_INTELLIGENCE_KEY: CLAVE })?.endpoint).toBe(
      'https://westeurope.api.cognitive.microsoft.com',
    );
  });

  it('sin endpoint o sin clave: no configurado', () => {
    expect(leerAzure({})).toBeNull();
    expect(leerAzure({ AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: 'https://conta.cognitiveservices.azure.com' })).toBeNull();
    expect(leerAzure({ AZURE_DOCUMENT_INTELLIGENCE_KEY: CLAVE })).toBeNull();
    expect(leerAzure({ AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: ' ', AZURE_DOCUMENT_INTELLIGENCE_KEY: ' ' })).toBeNull();
  });

  it('un host que no es de Azure o sin https: no configurado, con un aviso que no lleva el valor', () => {
    const aviso = jest.spyOn(logger, 'warn');
    for (const endpoint of ['https://otro.example.com', 'http://conta.cognitiveservices.azure.com', 'no es una url', 'https://conta.cognitiveservices.azure.com.example.com']) {
      expect(leerAzure({ AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: endpoint, AZURE_DOCUMENT_INTELLIGENCE_KEY: CLAVE })).toBeNull();
    }
    const registrado = JSON.stringify(aviso.mock.calls);
    expect(registrado).not.toContain('otro.example.com');
    expect(registrado).not.toContain(CLAVE);
    aviso.mockRestore();
  });

  it('OCR_LECTOR=claude fuerza el respaldo; cualquier otro valor es auto', () => {
    expect(modoLector({ OCR_LECTOR: 'claude' })).toBe('claude');
    expect(modoLector({ OCR_LECTOR: ' Claude ' })).toBe('claude');
    expect(modoLector({})).toBe('auto');
    expect(modoLector({ OCR_LECTOR: 'otro' })).toBe('auto');
    expect(estadoOcr({ OCR_LECTOR: 'claude' })).toEqual({ azureConfigurado: false, lector: 'claude' });
  });
});

describe('/health', () => {
  const antes = { ...process.env };
  afterEach(() => {
    process.env = { ...antes };
  });

  it('dice si Azure esta configurado y que lector se usa, sin valores', async () => {
    process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT = 'https://conta.cognitiveservices.azure.com/';
    process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY = CLAVE;
    const { app } = await import('../app');
    const r = await request(app).get('/health');
    expect(r.status).toBe(200);
    expect(r.body.ocr).toEqual({ azureConfigurado: true, lector: 'auto' });
    expect(JSON.stringify(r.body)).not.toContain(CLAVE);
    expect(JSON.stringify(r.body)).not.toContain('cognitiveservices');
  });
});
