/**
 * Servicio de exportación de datos de proveedores (SupplierExport).
 * Exporta datos del proveedor + facturas asociadas en CSV o JSON.
 */

import { prisma } from '../../config/database';
import { notFound } from '../../utils/http-errors';

export interface ExportOptions {
  formato: 'csv' | 'json'; // Formato de exportación
  fechaDesde?: string; // YYYY-MM-DD (opcional, para facturas)
  fechaHasta?: string; // YYYY-MM-DD (opcional, para facturas)
  incluirFacturas?: boolean; // Incluir lista de facturas asociadas
  incluirContactos?: boolean; // Incluir contactos
  incluirCuentasBancarias?: boolean; // Incluir cuentas bancarias
}

export interface SupplierExportData {
  supplier: any;
  facturas?: any[];
  contactos?: any[];
  cuentasBancarias?: any[];
  totales?: {
    totalFacturas: number;
    sumaBase: number;
    sumaIva: number;
    sumaTotal: number;
  };
}

/**
 * Exportar datos del proveedor y facturas asociadas.
 * Retorna string (CSV) o JSON.
 */
export async function exportSupplierData(
  companyId: string,
  supplierId: string,
  options: ExportOptions,
): Promise<string> {
  // Verificar que el proveedor existe
  const supplier = await prisma.supplier.findFirst({
    where: { id: String(supplierId), companyId: String(companyId) },
    include: {
      contacts: options.incluirContactos || false,
      bankAccounts: options.incluirCuentasBancarias || false,
    },
  });
  if (!supplier) throw notFound('Proveedor no encontrado.');

  // Obtener facturas asociadas (filtradas por rango de fechas si se proporciona)
  let facturas: any[] = [];
  if (options.incluirFacturas !== false) {
    const where: any = {
      companyId: String(companyId),
      supplierId: String(supplierId),
    };

    if (options.fechaDesde || options.fechaHasta) {
      where.fechaEmision = {};
      if (options.fechaDesde) where.fechaEmision.gte = options.fechaDesde;
      if (options.fechaHasta) where.fechaEmision.lte = options.fechaHasta;
    }

    facturas = await prisma.expenseInvoice.findMany({
      where,
      include: { lineas: true },
      orderBy: { fechaEmision: 'desc' },
    });
  }

  // Calcular totales
  const totales = {
    totalFacturas: facturas.length,
    sumaBase: facturas.reduce((sum: number, f: any) => sum + (f.baseTotal || 0), 0),
    sumaIva: facturas.reduce((sum: number, f: any) => sum + (f.ivaTotal || 0), 0),
    sumaTotal: facturas.reduce((sum: number, f: any) => sum + (f.totalFactura || 0), 0),
  };

  const data: SupplierExportData = {
    supplier,
    ...(options.incluirFacturas !== false ? { facturas } : {}),
    ...(options.incluirContactos ? { contactos: supplier.contacts } : {}),
    ...(options.incluirCuentasBancarias ? { cuentasBancarias: supplier.bankAccounts } : {}),
    totales,
  };

  // Exportar según formato
  if (options.formato === 'json') {
    return JSON.stringify(data, null, 2);
  } else {
    return exportToCSV(data, supplier);
  }
}

/**
 * Convertir datos a CSV.
 */
function exportToCSV(data: SupplierExportData, supplier: any): string {
  const lines: string[] = [];

  // Header con info del proveedor
  lines.push('EXPORTACIÓN DE PROVEEDOR');
  lines.push(`Fecha de exportación: ${new Date().toISOString()}`);
  lines.push('');

  // Datos del proveedor
  lines.push('=== DATOS DEL PROVEEDOR ===');
  lines.push(`Nombre: ${supplier.nombreFiscal}`);
  lines.push(`NIF/CIF: ${supplier.nifCif}`);
  lines.push(`Email: ${supplier.email || '-'}`);
  lines.push(`Teléfono: ${supplier.telefono || '-'}`);
  lines.push(`Dirección: ${supplier.direccion || '-'}`);
  lines.push(`Provincia: ${supplier.provincia || '-'}`);
  lines.push(`País: ${supplier.pais}`);
  lines.push(`Activo: ${supplier.activo ? 'Sí' : 'No'}`);
  lines.push('');

  // Contactos
  if (data.contactos && data.contactos.length > 0) {
    lines.push('=== CONTACTOS ===');
    lines.push('Nombre,Apellido,Email,Teléfono,Rol,Principal');
    data.contactos.forEach((c: any) => {
      lines.push(`"${c.nombre}","${c.apellido || ''}","${c.email || ''}","${c.telefono || ''}","${c.rol}","${c.esPrincipal ? 'Sí' : 'No'}"`);
    });
    lines.push('');
  }

  // Cuentas bancarias
  if (data.cuentasBancarias && data.cuentasBancarias.length > 0) {
    lines.push('=== CUENTAS BANCARIAS ===');
    lines.push('IBAN,BIC,Banco,Alias,Forma de Pago,Principal');
    data.cuentasBancarias.forEach((c: any) => {
      lines.push(`"${c.iban}","${c.bic || ''}","${c.banco || ''}","${c.alias}","${c.formaPagoPorDefecto}","${c.esPrincipal ? 'Sí' : 'No'}"`);
    });
    lines.push('');
  }

  // Facturas
  if (data.facturas && data.facturas.length > 0) {
    lines.push('=== FACTURAS ASOCIADAS ===');
    lines.push(`Total: ${data.totales?.totalFacturas || 0} facturas`);
    lines.push(`Suma Base: €${(data.totales?.sumaBase || 0).toFixed(2)}`);
    lines.push(`Suma IVA: €${(data.totales?.sumaIva || 0).toFixed(2)}`);
    lines.push(`Suma Total: €${(data.totales?.sumaTotal || 0).toFixed(2)}`);
    lines.push('');

    lines.push('Nº Factura,Fecha,Base,IVA,Total,Tipo,Estado');
    data.facturas.forEach((f: any) => {
      lines.push(
        `"${f.numeroCompleto}","${f.fechaEmision}","€${(f.baseTotal || 0).toFixed(2)}","€${(f.ivaTotal || 0).toFixed(2)}","€${(f.totalFactura || 0).toFixed(2)}","${f.tipoGasto}","${f.estado}"`,
      );
    });
  }

  return lines.join('\n');
}

/**
 * Obtener nombre seguro para archivo (sin caracteres especiales).
 */
export function getSafeFileName(nombreFiscal: string, nifCif: string, formato: 'csv' | 'json'): string {
  const clean = `${nombreFiscal}_${nifCif}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  const timestamp = new Date().toISOString().split('T')[0];
  return `proveedor_${clean}_${timestamp}.${formato}`;
}
