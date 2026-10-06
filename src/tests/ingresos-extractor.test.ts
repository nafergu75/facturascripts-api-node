// Lector de facturas de INGRESO.
//
// La pantalla llamaba a /ingresos/extraer-ia y /ingresos/confirmar, que no
// existian. Ahora: extraer con invoice-extractor y, al confirmar, crear la
// factura de ingreso con los datos GUARDADOS (cliente = receptor, numero
// original, una linea por tipo de IVA, totales comprobados al centimo).
const docs = new Map<string, Record<string, unknown>>();
const actualizaciones: Array<Record<string, unknown>> = [];
jest.mock('../config/database', () => ({
  prisma: {
    incomeReaderDocument: {
      findFirst: jest.fn(async ({ where }: { where: { id: string; companyId: string } }) => {
        const d = docs.get(where.id);
        return d && d.companyId === where.companyId ? d : null;
      }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => actualizaciones.push(data)),
    },
    customer: { findFirst: jest.fn(async () => null) },
  },
}));
const crearIngreso = jest.fn(async (dto: Record<string, unknown>) => ({ id: 'fac-1', numeroCompleto: `${dto.serie}-${dto.numero}`, totalFactura: 1196 }));
jest.mock('../services/income-invoices.service', () => ({ incomeInvoicesService: { crearIngreso: (d: never) => crearIngreso(d) } }));
const archivar = jest.fn(async () => ({}));
jest.mock('../services/invoice-extractor.service', () => ({
  invoiceExtractorService: { confirmar: () => archivar(), extraer: jest.fn() },
}));

import type { InvoiceExtraction } from '../services/invoice-extractor.service';
import { aIngresoExtraido, comprobarTotales, ingresosExtractorService, lineasDesdeExtraccion, separarNumero } from '../services/ingresos-extractor.service';
import { leerFacturaSubida } from '../utils/archivo-subido';

function extraccion(cambios: Partial<InvoiceExtraction['amounts']> = {}): InvoiceExtraction {
  return {
    document_type: 'invoice',
    direction: 'income',
    confidence: 0.9,
    vendor: { name: 'Mi Empresa SL', tax_id: 'B11111111', address: null, country: 'ES' },
    customer: { name: 'Cliente SL', tax_id: 'ES-B22.222.222', address: 'Calle 1', country: 'ES' },
    invoice: { number: '0042', series: 'A-2025', issue_date: '2025-11-03', due_date: null, original_number: null },
    amounts: {
      currency: 'EUR',
      bases: [
        { tax_rate: 21, base_amount: 1000, tax_amount: 210 },
        { tax_rate: 10, base_amount: 100, tax_amount: 10 },
      ],
      withholdings: [{ type: 'IRPF', rate: 15, amount: 165 }],
      subtotal: 1100,
      tax_total: 220,
      withholding_total: 165,
      total_gross: 1320,
      total_net: 1155,
      ...cambios,
    },
    payment: { method: null, terms: null, iban: null },
    lines: [{ description: 'Consultoria', quantity: 1, unit_price: 1100, line_total: 1100, tax_rate: 21 }],
    raw_text: null,
    meta: { source_file_name: 'f.pdf', source_mime_type: 'application/pdf', pages: 1 },
    validation: {
      checks: { total_matches_bases_and_taxes: true, tax_id_vendor_valid: true, tax_id_customer_valid: true, withholding_consistent: true },
      errors: [],
    },
  };
}

beforeEach(() => {
  docs.clear();
  actualizaciones.length = 0;
  jest.clearAllMocks();
});

describe('aIngresoExtraido', () => {
  it('el cliente es el RECEPTOR, con el NIF limpio', () => {
    const r = aIngresoExtraido('d1', extraccion());
    expect(r).toMatchObject({ cliente: 'Cliente SL', nifCliente: 'B22222222', numeroFactura: 'A-2025-0042', total: 1155, errores: [] });
  });

  it('sin NIF de cliente no se puede registrar', () => {
    const e = extraccion();
    e.customer.tax_id = null;
    expect(aIngresoExtraido('d1', e).errores.join(' ')).toMatch(/NIF del cliente/);
  });
});

describe('separarNumero', () => {
  it('conserva serie y numero originales', () => {
    expect(separarNumero('A-2025', '0042', '2025-11-03')).toEqual({ serie: 'A-2025', numero: 42 });
    expect(separarNumero(null, 'F/2025/17', null)).toEqual({ serie: 'F/2025', numero: 17 });
  });
  it('sin prefijo usa el ano de emision como serie', () => {
    expect(separarNumero(null, '153', '2025-06-30')).toEqual({ serie: '2025', numero: 153 });
  });
  it('rechaza lo que no tiene numero', () => {
    expect(() => separarNumero(null, 'SIN NUMERO', null)).toThrow(/interpretar/);
  });
});

describe('lineas y totales', () => {
  it('una linea por tipo de IVA, con la retencion en todas', () => {
    const lineas = lineasDesdeExtraccion(extraccion(), 'Consultoria');
    expect(lineas.map((l) => [l.precioUnitario, l.tipoIva, l.tipoRetencion])).toEqual([
      [1000, 21, 15],
      [100, 10, 15],
    ]);
    expect(() => comprobarTotales(lineas, extraccion())).not.toThrow();
  });

  it('si los importes leidos no cuadran al centimo, no se registra', () => {
    const e = extraccion({ total_net: 1155.01 });
    expect(() => comprobarTotales(lineasDesdeExtraccion(e, null), e)).toThrow(/no cuadran/);
  });
});

describe('confirmar', () => {
  it('crea la factura con los datos guardados y enlaza el documento', async () => {
    docs.set('d1', { id: 'd1', companyId: 'c1', status: 'READY_FOR_VERIFICATION', originalFileName: 'f.pdf', parsedData: extraccion() });

    const r = await ingresosExtractorService.confirmar('c1', 'd1');

    expect(crearIngreso).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'c1',
        serie: 'A-2025',
        numero: 42,
        fechaEmision: '2025-11-03',
        customer: { nuevo: expect.objectContaining({ nifCif: 'B22222222', nombreFiscal: 'Cliente SL' }) },
      }),
    );
    expect(archivar).toHaveBeenCalled();
    expect(actualizaciones[0]).toMatchObject({ status: 'VERIFIED', linkedInvoiceId: 'fac-1' });
    expect(r.numeroCompleto).toBe('A-2025-42');
  });

  it('no deja confirmar el documento de otra empresa', async () => {
    docs.set('d1', { id: 'd1', companyId: 'otra', status: 'READY_FOR_VERIFICATION', parsedData: extraccion() });
    await expect(ingresosExtractorService.confirmar('c1', 'd1')).rejects.toThrow(/no encontrado/);
    expect(crearIngreso).not.toHaveBeenCalled();
  });

  it('no confirma dos veces', async () => {
    docs.set('d1', { id: 'd1', companyId: 'c1', status: 'VERIFIED', parsedData: extraccion() });
    await expect(ingresosExtractorService.confirmar('c1', 'd1')).rejects.toThrow(/ya no se puede confirmar/);
  });
});

describe('leerFacturaSubida', () => {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(20)]);
  const req = (body: Record<string, unknown>) => ({ body }) as never;

  it('acepta un PDF en base64 y usa el tipo detectado', () => {
    const a = leerFacturaSubida(req({ archivoBase64: pdf.toString('base64'), nombre: 'f.pdf', mimeType: 'image/png' }));
    expect(a.mimetype).toBe('application/pdf');
  });

  it('rechaza lo que no es PDF ni imagen aunque diga serlo', () => {
    const exe = Buffer.from('MZ\x90\x00 esto no es un pdf');
    expect(() => leerFacturaSubida(req({ archivoBase64: exe.toString('base64'), mimeType: 'application/pdf' }))).toThrow(/PDF o imagen/);
  });
});
