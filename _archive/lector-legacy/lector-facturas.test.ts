// Mock FS factoria.
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
jest.mock('../config/database', () => ({ prisma: {}, connectDatabase: jest.fn(), disconnectDatabase: jest.fn() }));

// Mock del camino canonico de contabilizacion (verificamos que se invoca).
const contabilizarMock = jest.fn().mockResolvedValue({ asiento: { idasiento: 99 }, resumen: { numApuntes: 3 } });
jest.mock('../services/asientos.service', () => ({
  crearAsientoEnFacturascriptsDesdeFactura: (...args: unknown[]) => contabilizarMock(...args),
}));

import {
  procesarFacturaSubida,
  obtenerFacturaLeida,
  actualizarFacturaLeida,
  listarFacturasLeidas,
} from '../services/lectorFacturas.service';
import { crearFacturaDesdeFacturaLeida } from '../services/facturas.service';

describe('Lector de facturas', () => {
  beforeEach(() => {
    fsClientMock.listWithMeta.mockReset();
    fsClientMock.create.mockReset();
    contabilizarMock.mockClear();
  });

  it('procesarFacturaSubida guarda y devuelve un borrador pendiente_revision', async () => {
    fsClientMock.listWithMeta.mockResolvedValue({ items: [], total: 0 }); // empresas (detectarTipo)
    const fl = await procesarFacturaSubida('co1', { buffer: Buffer.from('%PDF-1.4 fake'), originalname: 'fra.pdf', mimetype: 'application/pdf' });
    expect(fl.estado).toBe('pendiente_revision');
    expect(fl.tipoDetectado).toBe('desconocido');
    expect(fl.nombreArchivo).toBe('fra.pdf');
    const lista = await listarFacturasLeidas('co1');
    expect(lista.some((x) => x.id === fl.id)).toBe(true);
    expect((await obtenerFacturaLeida('co1', fl.id)).id).toBe(fl.id);
  });

  it('crear-factura (compra) resuelve proveedor por NIF y contabiliza por el camino canonico', async () => {
    fsClientMock.listWithMeta.mockResolvedValue({ items: [], total: 0 });
    const fl = await procesarFacturaSubida('co2', { buffer: Buffer.from('x'), originalname: 'g.pdf', mimetype: 'application/pdf' });
    // Simula correccion manual tras OCR: NIF emisor (proveedor) + linea.
    await actualizarFacturaLeida('co2', fl.id, {
      nifEmisor: 'B99999999',
      fecha: '2026-05-10',
      lineas: [{ descripcion: 'Material', cantidad: 1, baseImponible: 100, tipoIva: 21 }],
    });

    fsClientMock.listWithMeta.mockResolvedValueOnce({ items: [{ codproveedor: 'PROV1', cifnif: 'B99999999' }], total: 1 }); // proveedores
    fsClientMock.create.mockResolvedValueOnce({ idfactura: 555, codigo: 'FC555' }); // facturaproveedores

    const r = await crearFacturaDesdeFacturaLeida('co2', fl.id, 'compra');

    expect(fsClientMock.create).toHaveBeenCalledWith('facturaproveedores', expect.objectContaining({ codproveedor: 'PROV1' }));
    // El asiento sale del camino canonico, NO de logica paralela:
    expect(contabilizarMock).toHaveBeenCalledWith('co2', '555', 'compra');
    expect(r.facturaLeida.estado).toBe('confirmada');
    expect(r.facturaLeida.facturaId).toBe('555');
  });

  it('crear-factura da de ALTA AUTOMATICA el tercero si no existe (Media 9)', async () => {
    fsClientMock.listWithMeta.mockResolvedValue({ items: [], total: 0 });
    const fl = await procesarFacturaSubida('co3', { buffer: Buffer.from('x'), originalname: 'g.pdf', mimetype: 'application/pdf' });
    await actualizarFacturaLeida('co3', fl.id, { nifEmisor: 'B00000000', nombreEmisor: 'Proveedor Nuevo SL', fecha: '2026-05-10', lineas: [] });
    fsClientMock.listWithMeta.mockResolvedValueOnce({ items: [], total: 0 }); // proveedores: no encontrado
    fsClientMock.create
      .mockResolvedValueOnce({ codproveedor: 'PNEW' }) // alta automatica del proveedor
      .mockResolvedValueOnce({ idfactura: 777 }); // factura de compra

    const r = await crearFacturaDesdeFacturaLeida('co3', fl.id, 'compra');
    expect(fsClientMock.create).toHaveBeenCalledWith(
      'proveedores',
      expect.objectContaining({ cifnif: 'B00000000', nombre: 'Proveedor Nuevo SL' }),
    );
    expect(contabilizarMock).toHaveBeenCalledWith('co3', '777', 'compra');
    expect(r.facturaLeida.facturaId).toBe('777');
  });

  it('parsea XML Facturae al subirlo (Media 10)', async () => {
    fsClientMock.listWithMeta.mockResolvedValue({ items: [{ cifnif: 'B11111111' }], total: 1 }); // empresa = receptor
    const xml = `<?xml version="1.0"?><fe:Facturae><Parties><SellerParty><TaxIdentification><TaxIdentificationNumber>ESB99999999</TaxIdentificationNumber></TaxIdentification><LegalEntity><CorporateName>Proveedor XML SL</CorporateName></LegalEntity></SellerParty><BuyerParty><TaxIdentification><TaxIdentificationNumber>ESB11111111</TaxIdentificationNumber></TaxIdentification><LegalEntity><CorporateName>Mi Empresa</CorporateName></LegalEntity></BuyerParty></Parties><Invoices><Invoice><InvoiceHeader><InvoiceSeriesCode>A</InvoiceSeriesCode><InvoiceNumber>123</InvoiceNumber></InvoiceHeader><InvoiceIssueData><IssueDate>2026-05-01</IssueDate></InvoiceIssueData><TaxesOutputs><Tax><TaxRate>21.00</TaxRate><TaxableBase><TotalAmount>100.00</TotalAmount></TaxableBase><TaxAmount><TotalAmount>21.00</TotalAmount></TaxAmount></Tax></TaxesOutputs><InvoiceTotals><TotalGrossAmountBeforeTaxes>100.00</TotalGrossAmountBeforeTaxes><TotalTaxOutputs>21.00</TotalTaxOutputs><InvoiceTotal>121.00</InvoiceTotal></InvoiceTotals></Invoice></Invoices></fe:Facturae>`;
    const fl = await procesarFacturaSubida('co4', { buffer: Buffer.from(xml), originalname: 'fra.xml', mimetype: 'application/xml' });
    expect(fl.numero).toBe('A-123');
    expect(fl.fecha).toBe('2026-05-01');
    expect(fl.nifEmisor).toBe('B99999999');
    expect(fl.totalFactura).toBe(121);
    expect(fl.lineas[0]).toMatchObject({ baseImponible: 100, tipoIva: 21, importeIva: 21 });
    expect(fl.tipoDetectado).toBe('compra'); // la empresa (B11111111) es el receptor
  });
});
