/**
 * Lector de gastos sin la clave de la IA en el servidor: el usuario ve que
 * hacer (503 con el alta manual), no «falta ANTHROPIC_API_KEY». No llama a
 * Anthropic: el modulo se carga sin la clave.
 */
import { describe, it, expect, jest } from '@jest/globals';

describe('lector de gastos sin clave de IA', () => {
  it('503 con un mensaje para el usuario y el enlace al alta manual', async () => {
    const antes = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      let servicio!: typeof import('../services/gastos-extractor.service');
      jest.isolateModules(() => {
        servicio = jest.requireActual('../services/gastos-extractor.service');
      });
      const archivo = { buffer: Buffer.from('%PDF-1.4 prueba'), originalname: 'factura.pdf', mimetype: 'application/pdf' };
      await expect(servicio.gastosExtractorService.extraer(archivo)).rejects.toMatchObject({
        statusCode: 503,
        message: 'La lectura con IA no está activada en esta instalación. Registra la factura con Compras → Nueva factura de gasto.',
        details: { codigo: 'LECTOR_SIN_IA', alternativa: '/dashboard/compras/nueva' },
      });
    } finally {
      if (antes !== undefined) process.env.ANTHROPIC_API_KEY = antes;
    }
  });
});
