// Moneda de cuenta y perfil de la empresa (sin BD), y que todos los importes
// Decimal nuevos se lean como number (si falta alguno, `a + b` concatena).
import { readFileSync } from 'fs';
import { join } from 'path';
import { Prisma } from '@prisma/client';
import { decidirMonedaCuenta, limpiarLegalConfig, monedaCuentaPorPais } from '../services/legalConfig.service';
import { perfilDesdeConfig } from '../services/perfilEmpresa.service';
import { CAMPOS_DECIMALES } from '../config/decimales';
import { MONEDAS_FACTURA_ACTIVAS } from '../domain/divisas';

describe('moneda de cuenta', () => {
  const base = { paisAnterior: 'ES', paisNuevo: 'ES', monedaActual: 'EUR', tieneDocumentos: false };

  it('por defecto: euros en Espana y la UE; dolares en EE. UU., Hong Kong y el resto', () => {
    expect(monedaCuentaPorPais('ES')).toBe('EUR');
    expect(monedaCuentaPorPais('FR')).toBe('EUR');
    expect(monedaCuentaPorPais('US')).toBe('USD');
    expect(monedaCuentaPorPais('HK')).toBe('USD');
  });

  it('una empresa espanola lleva la contabilidad en euros', () => {
    expect(() => decidirMonedaCuenta({ ...base, indicada: 'USD' })).toThrow(/euros/);
    expect(() => limpiarLegalConfig({ monedaCuenta: 'USD' }, 'ES')).toThrow(/euros/);
    expect(limpiarLegalConfig({ monedaCuenta: 'usd', pais: 'us' }, 'ES').monedaCuenta).toBe('USD');
    expect(() => limpiarLegalConfig({ monedaCuenta: 'GBP', pais: 'GB' }, 'ES')).toThrow(/habilitada/);
  });

  it('al pasar a EE. UU. sin facturas ni asientos, USD; con documentos no se sale de Espana', () => {
    expect(decidirMonedaCuenta({ ...base, paisNuevo: 'US' })).toBe('USD');
    // Con facturas o asientos, Espana <-> otro pais no se cambia: el PDF, el IVA y los modelos de lo emitido dependen de ello.
    expect(() => decidirMonedaCuenta({ ...base, paisNuevo: 'US', tieneDocumentos: true })).toThrow(/ya tiene facturas/);
    expect(() => decidirMonedaCuenta({ ...base, paisNuevo: 'FR', tieneDocumentos: true })).toThrow(/ya tiene facturas/);
    expect(() => decidirMonedaCuenta({ ...base, paisNuevo: 'US', indicada: 'USD', tieneDocumentos: true })).toThrow(/ya tiene facturas/);
    // Volver a Espana desde una empresa en USD con documentos: no se puede.
    expect(() => decidirMonedaCuenta({ ...base, paisAnterior: 'US', monedaActual: 'USD', tieneDocumentos: true })).toThrow();
    // La misma moneda siempre vale.
    expect(decidirMonedaCuenta({ ...base, indicada: 'EUR', tieneDocumentos: true })).toBe('EUR');
  });

  it('EE. UU. y Hong Kong solo en USD; la UE solo en EUR; cambios entre paises extranjeros', () => {
    const us = { paisAnterior: 'US', paisNuevo: 'US', monedaActual: 'USD', tieneDocumentos: false };
    expect(() => decidirMonedaCuenta({ ...us, indicada: 'EUR' })).toThrow(/dólares/);
    expect(decidirMonedaCuenta({ ...us, paisNuevo: 'HK', tieneDocumentos: true })).toBe('USD');
    // De EE. UU. (USD, con documentos) a un pais de la UE (EUR): la moneda no puede cambiar.
    expect(() => decidirMonedaCuenta({ ...us, paisNuevo: 'FR', tieneDocumentos: true })).toThrow(/otra moneda/);
    expect(decidirMonedaCuenta({ ...us, paisNuevo: 'FR' })).toBe('EUR');
    // Una empresa antigua de EE. UU. que se quedo en EUR con documentos puede seguir guardando sus datos.
    expect(decidirMonedaCuenta({ ...us, monedaActual: 'EUR', tieneDocumentos: true })).toBe('EUR');
    // Sin documentos, en cuanto toca la moneda tiene que ser USD.
    expect(() => decidirMonedaCuenta({ ...us, monedaActual: 'EUR', indicada: 'EUR', paisAnterior: 'ES' })).toThrow(/dólares/);
  });

  it('perfil: sin configuracion, espanola y en euros; extranjera, en ingles y solo su moneda', () => {
    expect(perfilDesdeConfig(null)).toMatchObject({ pais: 'ES', espanola: true, monedaCuenta: 'EUR', regimenIva: 'ES', idioma: 'es' });
    expect(perfilDesdeConfig(null).monedasFactura).toEqual(MONEDAS_FACTURA_ACTIVAS);
    const us = perfilDesdeConfig({ pais: 'US', monedaCuenta: 'USD' });
    expect(us).toMatchObject({ espanola: false, regimenIva: 'NINGUNO', idioma: 'en', monedasFactura: ['USD'] });
    expect(us.formato.fecha).toBe('MDA');
    expect(perfilDesdeConfig({ pais: 'HK', monedaCuenta: 'USD' }).formato.fecha).toBe('DMA');
  });
});

describe('Decimal nuevos leidos como number', () => {
  const modelos = ['IncomeInvoice', 'IncomeInvoiceLine', 'InvoicePayment', 'TipoCambioBce'];
  const decimales = (modelo: string) =>
    Prisma.dmmf.datamodel.models.find((m) => m.name === modelo)!.fields.filter((f) => f.type === 'Decimal').map((f) => f.name);

  it('cada Decimal de facturas, lineas, cobros y tipos del BCE esta en CAMPOS_DECIMALES', () => {
    for (const m of modelos) for (const campo of decimales(m)) expect([m, CAMPOS_DECIMALES.has(campo)]).toEqual([m, true]);
  });

  it('y en la extension de resultado de su modelo', () => {
    const fuente = readFileSync(join(__dirname, '..', 'config', 'decimales.ts'), 'utf-8');
    for (const m of modelos) {
      const clave = m.charAt(0).toLowerCase() + m.slice(1);
      const inicio = fuente.indexOf(`    ${clave}: {`);
      expect([m, inicio >= 0]).toEqual([m, true]);
      const bloque = fuente.slice(inicio, fuente.indexOf('\n    },', inicio));
      for (const campo of decimales(m)) expect([m, campo, bloque.includes(`${campo}: { needs: { ${campo}: true }`)]).toEqual([m, campo, true]);
    }
  });
});
