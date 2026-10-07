/**
 * Periodos mensuales en el modulo Impuestos ('01'..'12'). periodoFiscalDe solo
 * entendia '0A' y los trimestres: una fila de 303 mensual (REDEME, SII) rompia
 * el detalle del modelo con un 500. Se arregla antes de ofrecer la periodicidad
 * mensual en Configuracion.
 */
const fsClientMock = {
  listWithMeta: jest.fn().mockResolvedValue({ items: [], total: 0 }),
  getOne: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
};
jest.mock('../services/facturascripts-client', () => ({
  getFsClientForCompany: jest.fn().mockResolvedValue(fsClientMock),
}));

import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { autorrellenarModelo, fechaVencimientoModelo, generarTxtModelo, obtenerDetalleModelo, periodoFiscalDe } from '../services/impuestosModulo.service';
import { mesesDePeriodo } from '../services/impuestosCalculo.service';

const COMPANY_ID = `imp-mensual-${Date.now()}`;

beforeAll(async () => {
  await prisma.company.create({ data: { id: COMPANY_ID, name: 'Mensual SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: COMPANY_ID, denominacion: 'Mensual SL', nif: 'B13000000' } });
});

describe('periodoFiscalDe', () => {
  it('meses: del dia 1 al ultimo del mes (febrero bisiesto incluido)', () => {
    expect(periodoFiscalDe({ ejercicio: 2026, periodo: '05' })).toEqual({
      ejercicio: 2026,
      periodo: '05',
      tipo: 'mensual',
      fechaInicio: '2026-05-01',
      fechaFin: '2026-05-31',
    });
    expect(periodoFiscalDe({ ejercicio: 2028, periodo: '02' }).fechaFin).toBe('2028-02-29');
    expect(periodoFiscalDe({ ejercicio: 2026, periodo: '02' }).fechaFin).toBe('2026-02-28');
    expect(periodoFiscalDe({ ejercicio: 2026, periodo: '12' }).fechaFin).toBe('2026-12-31');
    expect(mesesDePeriodo(periodoFiscalDe({ ejercicio: 2026, periodo: '05' }))).toEqual([5]);
  });

  it('trimestres y anual como siempre', () => {
    expect(periodoFiscalDe({ ejercicio: 2026, periodo: '2T' })).toMatchObject({ tipo: 'trimestral', fechaInicio: '2026-04-01', fechaFin: '2026-06-30' });
    expect(periodoFiscalDe({ ejercicio: 2026, periodo: '0A' })).toMatchObject({ tipo: 'anual', fechaInicio: '2026-01-01', fechaFin: '2026-12-31' });
  });

  it('un periodo desconocido es un 400 claro, no un 500', () => {
    for (const periodo of ['13', '5T', '00', '', '5']) {
      expect(() => periodoFiscalDe({ ejercicio: 2026, periodo })).toThrow(/Periodo no válido/);
    }
  });
});

describe('plazos de los periodos mensuales', () => {
  it('303: dia 20 del mes siguiente; diciembre, 30 de enero', () => {
    expect(fechaVencimientoModelo('303', 2026, '05')).toBe('2026-06-20');
    expect(fechaVencimientoModelo('303', 2026, '11')).toBe('2026-12-20');
    expect(fechaVencimientoModelo('303', 2026, '12')).toBe('2027-01-30');
  });

  it('111 y 115 mensuales: diciembre, 20 de enero', () => {
    expect(fechaVencimientoModelo('111', 2026, '01')).toBe('2026-02-20');
    expect(fechaVencimientoModelo('115', 2026, '12')).toBe('2027-01-20');
  });
});

describe('detalle y fichero de un 303 mensual', () => {
  it('el detalle del 303 de mayo se calcula sin error', async () => {
    const fila = await prisma.modeloImpuesto.create({ data: { companyId: COMPANY_ID, codigo: '303', ejercicio: 2026, periodo: '05' } });
    const detalle = await obtenerDetalleModelo(COMPANY_ID, fila.id);
    expect(detalle.resumen).toMatchObject({
      codigo: '303',
      periodo: '05',
      ejercicio: 2026,
      periodoEtiqueta: '2026-05',
      descripcion: 'IVA — autoliquidacion mensual',
      fechaVencimiento: '2026-06-20',
    });
    const calculado = await autorrellenarModelo(COMPANY_ID, fila.id);
    expect(calculado.resumen.tieneBorrador).toBe(true);
    const txt = await generarTxtModelo(COMPANY_ID, fila.id);
    expect(txt.nombre).toBe('303_2026_05.txt');
    expect(txt.contenido).toContain('202605');
  });
});
