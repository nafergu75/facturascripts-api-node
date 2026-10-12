/**
 * Importes en los avisos y errores que lee la persona: «-2.000,00 €», con punto
 * de miles también en cuatro cifras y coma decimal (como la pantalla).
 */
import { describe, it, expect } from '@jest/globals';
import { importeTexto } from '../utils/money';
import { construirModelo390 } from '../aeat/oficial/modelo390';
import { entrada390Desde } from '../services/borradoresAeat.service';

describe('importeTexto', () => {
  it('miles con punto, decimales con coma y signo', () => {
    expect(importeTexto(-2000)).toBe('-2.000,00 €');
    expect(importeTexto(1234.5)).toBe('1.234,50 €');
    expect(importeTexto(999.999)).toBe('1.000,00 €');
    expect(importeTexto(1234567.891)).toBe('1.234.567,89 €');
    expect(importeTexto(0)).toBe('0,00 €');
    expect(importeTexto(-0.001)).toBe('0,00 €');
  });

  it('los avisos del 390 no escriben importes en formato inglés', () => {
    const d = construirModelo390(
      entrada390Desde(
        [{ idFactura: 'V1', tipo: 'venta', cifnif: 'B12345674', nombreTercero: 'Cliente', fecha: '2025-02-15', operacion: 'interior', tipoOperacion: 'NACIONAL', lineas: [{ tipoIva: 5, base: 1234.5, cuota: 61.73 }] }],
        2025,
        { nif: 'B98765431', razonSocial: 'Prueba, S.L.' },
        { resultados303: { periodos: ['1T', '2T', '3T', '4T'], resultados: [100, 0, 0, 0], avisos: [] } },
      ).entrada,
    );
    const textos = [...d.errores, ...d.advertencias].join(' ');
    expect(textos).toMatch(/1\.234,50 €/);
    expect(textos).not.toMatch(/\d\.\d{2} €/);
  });
});
