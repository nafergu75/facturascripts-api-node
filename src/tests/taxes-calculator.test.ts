/**
 * Pruebas del calculo de modelos AEAT desde facturas (escenario del enunciado):
 * un trimestre con ventas a 21/10/4%, gastos con IVA (uno NO deducible) y
 * retenciones (nominas + profesional). Verifica matematicamente las casillas
 * oficiales del 303 y del 111.
 */
// Modelo 111 (retenciones a profesionales) lee facturas de gasto de Prisma
// `expenseInvoice` (ADR-002 Paso 3, camino de facturas migrado): PRO1 con
// retención 150 sobre base 1000; PRO2 sin retención no entra (filtro > 0).
jest.mock('../config/database', () => ({
  prisma: {
    incomeInvoice: { findMany: jest.fn(async () => []) },
    expenseInvoice: {
      findMany: jest.fn(async () => [{ supplierId: 'PRO1', retencionTotal: 150, baseTotal: 1000 }]),
    },
  },
  connectDatabase: jest.fn(),
  disconnectDatabase: jest.fn(),
}));
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
jest.mock('../services/nominas.service', () => ({
  listarResumenesNominas: jest.fn().mockResolvedValue([
    { mes: 4, totalBruto: 2000, totalIRPF: 300 },
    { mes: 5, totalBruto: 2000, totalIRPF: 300 },
    { mes: 12, totalBruto: 9999, totalIRPF: 999 }, // fuera del 2T: no debe sumar
  ]),
}));

import { agregar303, calcularModelo111 } from '../services/impuestosCalculo.service';
import { generarFicheroModelo303 } from '../services/impuestosExport.service';
import { FacturaFiscal, PeriodoFiscal } from '../domain/impuestos.model';

const periodo2T: PeriodoFiscal = {
  ejercicio: 2026,
  periodo: '2T',
  tipo: 'trimestral',
  fechaInicio: '2026-04-01',
  fechaFin: '2026-06-30',
};

// --- Escenario: 2T con varios tipos de IVA y un gasto no deducible ---
const facturas: FacturaFiscal[] = [
  // Ventas: 1000@21 + 500@10 + 200@4
  { idFactura: 'V1', tipo: 'venta', cifnif: 'B1', nombreTercero: 'Cli A', fecha: '2026-04-10', operacion: 'interior', lineas: [{ tipoIva: 21, base: 1000, cuota: 210 }] },
  { idFactura: 'V2', tipo: 'venta', cifnif: 'B2', nombreTercero: 'Cli B', fecha: '2026-05-15', operacion: 'interior', lineas: [{ tipoIva: 10, base: 500, cuota: 50 }, { tipoIva: 4, base: 200, cuota: 8 }] },
  // Gastos: 300@21 deducible + 100@21 NO deducible (no debe entrar)
  { idFactura: 'G1', tipo: 'compra', cifnif: 'B3', nombreTercero: 'Prov A', fecha: '2026-04-20', operacion: 'interior', lineas: [{ tipoIva: 21, base: 300, cuota: 63 }] },
  { idFactura: 'G2', tipo: 'compra', cifnif: 'B4', nombreTercero: 'Prov B', fecha: '2026-05-02', operacion: 'interior', deducible: false, categoria: 'atenciones', lineas: [{ tipoIva: 21, base: 100, cuota: 21 }] },
  // Fuera de periodo: no debe sumar
  { idFactura: 'V9', tipo: 'venta', cifnif: 'B9', nombreTercero: 'Cli X', fecha: '2026-09-01', operacion: 'interior', lineas: [{ tipoIva: 21, base: 9999, cuota: 2099.79 }] },
];

describe('Modelo 303 — casillas oficiales por tipo de IVA', () => {
  const d = agregar303(facturas, periodo2T);

  it('desglosa el devengado en las 3 filas [01-09] (21/10/4)', () => {
    expect(d.casillas['01_base_devengada_21']).toBe(1000);
    expect(d.casillas['02_tipo']).toBe(21);
    expect(d.casillas['03_cuota_devengada_21']).toBe(210);
    expect(d.casillas['04_base_devengada_10']).toBe(500);
    expect(d.casillas['05_tipo']).toBe(10);
    expect(d.casillas['06_cuota_devengada_10']).toBe(50);
    expect(d.casillas['07_base_devengada_4']).toBe(200);
    expect(d.casillas['08_tipo']).toBe(4);
    expect(d.casillas['09_cuota_devengada_4']).toBe(8);
  });

  it('totales: [27] devengado, [28]/[29] deducible (excluye NO deducible), [45]/[46]/[71]', () => {
    expect(d.casillas['27_total_devengado']).toBe(268); // 210+50+8
    expect(d.casillas['28_base_deducible']).toBe(300); // G2 (no deducible) fuera
    expect(d.casillas['29_cuota_deducible']).toBe(63);
    expect(d.casillas['45_total_deducir']).toBe(63);
    expect(d.casillas['46_resultado_regimen_general']).toBe(205); // 268-63
    expect(d.casillas['71_resultado']).toBe(205);
  });

  it('el TXT BOE escribe las 3 filas en sus posiciones oficiales', () => {
    const reg = generarFicheroModelo303('B12345678', periodo2T, d).replace(/\r\n$/, '');
    expect(reg).toHaveLength(1581);
    // fila 1 (21%): [01]@209 [02]@226 [03]@231
    expect(reg.slice(208, 225)).toBe('00000000000100000'); // 1000.00
    expect(reg.slice(225, 230)).toBe('02100'); // 21.00%
    expect(reg.slice(230, 247)).toBe('00000000000021000'); // 210.00
    // fila 2 (10%): [04]@287 [05]@304 [06]@309
    expect(reg.slice(286, 303)).toBe('00000000000050000'); // 500.00
    expect(reg.slice(303, 308)).toBe('01000'); // 10.00%
    expect(reg.slice(308, 325)).toBe('00000000000005000'); // 50.00
    // fila 3 (4%): [07]@326 [08]@343 [09]@348
    expect(reg.slice(325, 342)).toBe('00000000000020000'); // 200.00
    expect(reg.slice(342, 347)).toBe('00400'); // 4.00%
    expect(reg.slice(347, 364)).toBe('00000000000000800'); // 8.00
    // [27]@696 total devengado
    expect(reg.slice(695, 712)).toBe('00000000000026800'); // 268.00
  });
});

describe('Modelo 111 — trabajo + profesionales', () => {
  it('suma nominas del trimestre y facturas de profesionales con IRPF', async () => {
    // Profesional: base 1000, retencion 15% -> 150 (cabecera FS totalirpf/neto)
    fsClientMock.listWithMeta.mockResolvedValueOnce({
      items: [
        { codproveedor: 'PRO1', neto: 1000, totalirpf: 150, fecha: '15-05-2026' },
        { codproveedor: 'PRO2', neto: 400, totalirpf: 0, fecha: '20-05-2026' }, // sin retencion: no cuenta
      ],
      total: 2,
    });

    const d = await calcularModelo111('co-111', periodo2T);
    // Trabajo (nominas abril+mayo): [01] 2 perceptores, [02] 4000, [03] 600
    expect(d.nPerceptoresTrabajo).toBe(2);
    expect(d.percepcionesTrabajo).toBe(4000);
    expect(d.retencionesTrabajo).toBe(600);
    // Profesionales: [07] 1 perceptor, [08] 1000, [09] 150
    expect(d.nPerceptoresActividades).toBe(1);
    expect(d.percepcionesActividades).toBe(1000);
    expect(d.retencionesActividades).toBe(150);
    // [28] total y [30] resultado
    expect(d.totalRetenciones).toBe(750);
    expect(d.resultadoIngresar).toBe(750);
  });
});
