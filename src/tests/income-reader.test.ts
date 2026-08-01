/**
 * Tests para el lector de facturas (income-reader)
 * Cubre: parsearFacturaeXML, procesarOCR, flujo de verificación
 */

jest.mock('../config/database', () => ({
  prisma: {
    incomeReaderDocument: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    chatMessage: {
      findMany: jest.fn(),
    },
  },
  connectDatabase: jest.fn(),
}));

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: {
      create: jest.fn(),
    },
  })),
}));

import { parsearFacturaeXML, procesarOCR, ParsedInvoiceData } from '../services/income-reader.service';

describe('Income Reader Service', () => {
  describe('parsearFacturaeXML', () => {
    it('debería parsear XML válido de Facturae (formato esperado)', () => {
      const xmlFacturae = `<?xml version="1.0"?>
<Invoice>
  <InvoiceNumber>INV-2024-001</InvoiceNumber>
  <InvoiceSeriesCode>A</InvoiceSeriesCode>
  <IssueDate>2024-06-15</IssueDate>
  <SellerParty>
    <TaxIdentificationNumber>B12345678</TaxIdentificationNumber>
    <CorporateName>Acme Corp</CorporateName>
  </SellerParty>
  <BuyerParty>
    <TaxIdentificationNumber>B87654321</TaxIdentificationNumber>
    <CorporateName>Cliente SA</CorporateName>
  </BuyerParty>
  <InvoiceTotal>1210.00</InvoiceTotal>
</Invoice>`;

      const result = parsearFacturaeXML(xmlFacturae);

      expect(result).toBeDefined();
      expect(result.nifEmisor).toBe('B12345678');
      expect(result.nombreEmisor).toBe('Acme Corp');
      expect(result.nifReceptor).toBe('B87654321');
      expect(result.nombreReceptor).toBe('Cliente SA');
      expect(result.numero).toBe('A-INV-2024-001');
      expect(result.fecha).toBe('2024-06-15');
      expect(result.total).toBe(1210.00);
      expect(result.ocrEstado).toBe('OK');
    });

    it('debería manejar XML malformado (retorna OK pero sin datos)', () => {
      const xmlMalformado = `<invalid>xml</notclosed>`;

      const result = parsearFacturaeXML(xmlMalformado);

      expect(result).toBeDefined();
      expect(result.ocrEstado).toBe('OK');
      // Sin XML válido, no hay datos extraídos
      expect(result.numero).toBeUndefined();
      expect(result.nifEmisor).toBeUndefined();
    });

    it('debería manejar XML vacío (retorna OK pero sin datos)', () => {
      const result = parsearFacturaeXML('');

      expect(result).toBeDefined();
      expect(result.ocrEstado).toBe('OK');
      // XML vacío no tiene datos
      expect(result.numero).toBeUndefined();
    });

    it('debería extraer líneas de detalle si existen (TaxesOutputs)', () => {
      const xmlConLineas = `<?xml version="1.0"?>
<Invoice>
  <InvoiceNumber>INV-001</InvoiceNumber>
  <IssueDate>2024-06-15</IssueDate>
  <TaxesOutputs>
    <Tax>
      <TaxableBase>
        <TotalAmount>1000.00</TotalAmount>
      </TaxableBase>
      <TaxRate>21</TaxRate>
    </Tax>
  </TaxesOutputs>
</Invoice>`;

      const result = parsearFacturaeXML(xmlConLineas);

      expect(result).toBeDefined();
      expect(result.lineas).toBeDefined();
      expect(Array.isArray(result.lineas)).toBe(true);
      expect(result.lineas?.length).toBeGreaterThan(0);
    });
  });

  describe('procesarOCR', () => {
    it('debería retornar NO_LEGIBLE si no hay ANTHROPIC_API_KEY', async () => {
      const buffer = Buffer.from('test content');
      const result = await procesarOCR(buffer, 'application/pdf');

      expect(result.ocrEstado).toBe('NO_LEGIBLE');
      expect(result.confianza).toBe(0);
    });

    it('debería rechazar formato no soportado', async () => {
      const buffer = Buffer.from('test');
      const result = await procesarOCR(buffer, 'application/zip');

      expect(result.ocrEstado).toBe('FORMATO_NO_SOPORTADO');
      expect(result.confianza).toBe(0);
    });

    it('debería aceptar PDF como formato válido', async () => {
      const buffer = Buffer.from('%PDF-1.4 mock pdf');
      const result = await procesarOCR(buffer, 'application/pdf');

      // Sin API key, intenta Claude pero falla con NO_LEGIBLE
      expect(['NO_LEGIBLE', 'OK']).toContain(result.ocrEstado);
      expect(result.confianza).toBeDefined();
    });

    it('debería aceptar imagen como formato válido', async () => {
      const buffer = Buffer.from('mock image data');
      const result = await procesarOCR(buffer, 'image/png');

      expect(['NO_LEGIBLE', 'OK']).toContain(result.ocrEstado);
    });

    it('debería procesar XML Facturae como formato válido', async () => {
      const xml = '<?xml version="1.0"?><Invoice><InvoiceNumber>INV-001</InvoiceNumber></Invoice>';
      const buffer = Buffer.from(xml);
      const result = await procesarOCR(buffer, 'application/xml');

      // XML se detecta y procesa
      expect(['OK', 'NO_LEGIBLE']).toContain(result.ocrEstado);
    });
  });

  describe('Integración procesarOCR con Facturae', () => {
    it('debería detectar y procesar XML Facturae en procesarOCR', async () => {
      const xmlFacturae = `<?xml version="1.0"?>
<Invoice>
  <InvoiceNumber>FAC-2024-500</InvoiceNumber>
  <SellerParty>
    <TaxIdentificationNumber>B99999999</TaxIdentificationNumber>
    <CorporateName>Proveedor XYZ</CorporateName>
  </SellerParty>
  <BuyerParty>
    <TaxIdentificationNumber>B88888888</TaxIdentificationNumber>
    <CorporateName>Empresa ABC</CorporateName>
  </BuyerParty>
  <IssueDate>2024-06-20</IssueDate>
  <InvoiceTotal>500.00</InvoiceTotal>
</Invoice>`;

      const buffer = Buffer.from(xmlFacturae);
      const result = await procesarOCR(buffer, 'application/xml');

      expect(result.ocrEstado).toBe('OK');
      expect(result.nifEmisor).toBe('B99999999');
      expect(result.nombreEmisor).toBe('Proveedor XYZ');
      expect(result.numero).toBe('FAC-2024-500');
      expect(result.total).toBe(500.00);
    });

    it('debería rechazar PDF sin ANTHROPIC_API_KEY', async () => {
      const pdfMock = Buffer.from('%PDF-1.4 mock content');
      const result = await procesarOCR(pdfMock, 'application/pdf');

      expect(result.ocrEstado).toBe('NO_LEGIBLE');
      expect(result.confianza).toBe(0);
    });

    it('debería rechazar formato desconocido', async () => {
      const buffer = Buffer.from('random binary content');
      const result = await procesarOCR(buffer, 'application/octet-stream');

      expect(result.ocrEstado).toBe('FORMATO_NO_SOPORTADO');
      expect(result.confianza).toBe(0);
    });
  });

  describe('Flujo completo', () => {
    it('debería procesar XML → ParsedInvoiceData → estructura válida', () => {
      const xml = `<?xml version="1.0"?>
<Facturae xmlns="http://www.facturae.es/Facturae/2014/v3.2/Facturae">
  <FileHeader>
    <Issuer>
      <TaxIdentificationNumber>
        <TaxIdentificationNumber>B12345678</TaxIdentificationNumber>
      </TaxIdentificationNumber>
    </Issuer>
  </FileHeader>
  <Invoices>
    <Invoice>
      <InvoiceHeader>
        <InvoiceNumber>FAC-2024-100</InvoiceNumber>
        <InvoiceIssueDate>2024-06-20</InvoiceIssueDate>
      </InvoiceHeader>
      <Parties>
        <Issuer>
          <Party>
            <PartyIdentification>
              <PartyIdentificationNumber>B11111111</PartyIdentificationNumber>
            </PartyIdentification>
            <PartyName><Name>Proveedor ABC</Name></PartyName>
          </Party>
        </Issuer>
      </Parties>
      <InvoiceTotals>
        <TotalGrossAmount>600.00</TotalGrossAmount>
        <InvoiceTotal>600.00</InvoiceTotal>
      </InvoiceTotals>
    </Invoice>
  </Invoices>
</Facturae>`;

      const result: ParsedInvoiceData = parsearFacturaeXML(xml);

      // Verificar estructura completa
      expect(result).toHaveProperty('nifEmisor');
      expect(result).toHaveProperty('nombreEmisor');
      expect(result).toHaveProperty('numero');
      expect(result).toHaveProperty('fecha');
      expect(result).toHaveProperty('total');
      expect(result).toHaveProperty('confianza');
      expect(result).toHaveProperty('ocrEstado');

      // Tipos correctos
      expect(typeof result.total).toBe('number');
      expect(typeof result.confianza).toBe('number');
      expect(['OK', 'NO_LEGIBLE', 'SIN_CLAVE', 'FORMATO_NO_SOPORTADO']).toContain(result.ocrEstado);
    });
  });
});
