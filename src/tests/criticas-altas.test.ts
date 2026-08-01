const fsClientMock = {
  listWithMeta: jest.fn(),
  getOne: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
};
jest.mock('../services/facturascripts-client', () => ({
  getFsClientForCompany: jest.fn().mockResolvedValue(fsClientMock),
}));

import { clasificarOperacion, agregar303 } from '../services/impuestosCalculo.service';
import { generarPaginaModelo303_03 } from '../services/impuestosExport.service';
import { parsearFacturaeXML } from '../services/income-reader.service';
import { crearCuentaBancaria, importarMovimientosDesdeCSV } from '../services/bancos.service';
import { conciliarMovimientoConCuenta } from '../services/conciliacionConfirmar.service';
import { prisma } from '../config/database';
import { PeriodoFiscal, FacturaFiscal } from '../domain/impuestos.model';

const periodo: PeriodoFiscal = { ejercicio: 2026, periodo: '2T', tipo: 'trimestral', fechaInicio: '2026-04-01', fechaFin: '2026-06-30' };

describe('Critica 3 - clasificarOperacion', () => {
  it('por codpais de la ficha FS', () => {
    expect(clasificarOperacion('ESP')).toBe('interior');
    expect(clasificarOperacion('DEU')).toBe('intracomunitaria');
    expect(clasificarOperacion('USA')).toBe('exportacion');
  });
  it('fallback por prefijo de NIF-IVA', () => {
    expect(clasificarOperacion(undefined, 'DE123456789')).toBe('intracomunitaria');
    expect(clasificarOperacion(undefined, 'B12345678')).toBe('interior');
    expect(clasificarOperacion('', 'FR99999999999')).toBe('intracomunitaria');
  });
});

describe('303 con a compensar (Quipu) + desglose intracom/export', () => {
  const facturas: FacturaFiscal[] = [
    { idFactura: '1', tipo: 'venta', cifnif: 'B1', nombreTercero: 'A', fecha: '2026-05-01', operacion: 'interior', lineas: [{ tipoIva: 21, base: 1000, cuota: 210 }] },
    { idFactura: '2', tipo: 'venta', cifnif: 'DE1', nombreTercero: 'B', fecha: '2026-05-02', operacion: 'intracomunitaria', lineas: [{ tipoIva: 0, base: 500, cuota: 0 }] },
    { idFactura: '3', tipo: 'venta', cifnif: 'US1', nombreTercero: 'C', fecha: '2026-05-03', operacion: 'exportacion', lineas: [{ tipoIva: 0, base: 300, cuota: 0 }] },
  ];

  it('resta cuotas a compensar [78] y expone [71] final', () => {
    const d = agregar303(facturas, periodo, 60);
    expect(d.resultado).toBe(210);
    expect(d.cuotasACompensarAnteriores).toBe(60);
    expect(d.resultadoFinal).toBe(150);
    expect(d.casillas['71_resultado']).toBe(150);
  });

  it('separa entregas intracomunitarias [59] y exportaciones [60]', () => {
    const d = agregar303(facturas, periodo);
    expect(d.entregasIntracomunitarias).toBe(500);
    expect(d.exportaciones).toBe(300);
    expect(d.totalBaseDevengada).toBe(1000); // solo interiores devengan
  });

  it('genera la pagina 3 oficial (1017 chars, [71]@408, cierre@1006)', () => {
    const d = agregar303(facturas, periodo, 60);
    const p = generarPaginaModelo303_03(d);
    expect(p).toHaveLength(1017);
    expect(p.slice(0, 11)).toBe('<T30303000>');
    expect(p.slice(11, 28)).toBe('00000000000050000'); // [59] 500.00
    expect(p.slice(271, 288)).toBe('00000000000006000'); // [78] 60.00
    expect(p.slice(407, 424)).toBe('00000000000015000'); // [71] 150.00
    expect(p.slice(1005)).toBe('</T30303000>');
  });
});

describe('Facturae XML (Media 10)', () => {
  it('no confunde InvoiceTotal con InvoiceTotals', () => {
    const r = parsearFacturaeXML('<Invoice><InvoiceTotals><InvoiceTotal>121.00</InvoiceTotal></InvoiceTotals></Invoice>');
    expect(r.total).toBe(121);
  });
});

describe('Conciliacion con cuenta 555 (Quipu)', () => {
  it('crea asiento banco<->555 (Prisma) y marca el movimiento conciliado', async () => {
    const cuenta = await crearCuentaBancaria('co555', { iban: 'ES00', subcuentaCodigo: '572000', activa: true });
    const [mov] = await importarMovimientosDesdeCSV('co555', cuenta.id, '2026-05-01;-90.00;Comision bancaria');

    const r = await conciliarMovimientoConCuenta('co555', mov.id, '5550000000');
    expect(r.movimientoConciliado).toBe(true);
    // El asiento ahora vive en Prisma (JournalEntryLine), no en FacturaScripts.
    const entryId = String((r.asiento as Record<string, unknown>).idasiento);
    const lineas = await prisma.journalEntryLine.findMany({ where: { entryId } });
    // cargo de 90: 555 al debe, banco 572 al haber
    expect(lineas.find((l) => l.accountCode.startsWith('555'))!.debe).toBe(90);
    expect(lineas.find((l) => l.accountCode.startsWith('572'))!.haber).toBe(90);
    // segundo intento sobre el mismo movimiento -> rechazado
    await expect(conciliarMovimientoConCuenta('co555', mov.id)).rejects.toThrow(/ya esta conciliado/);
  });
});
