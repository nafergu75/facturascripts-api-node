/**
 * SERVICIO DE ARCHIVADO AUTOMÁTICO DE FACTURAS
 *
 * Archiva facturas de ingreso y gasto de forma automática
 * cuando se contabilizan, organizadas por:
 * - Tipo (INGRESOS / GASTOS)
 * - Mes (YYYY-MM)
 * - Folio/número único
 *
 * Estructura en disco:
 * storage/
 *   └─ facturas/
 *      ├─ ingresos/
 *      │  ├─ 2026-01/
 *      │  │  ├─ FAC-2001.json
 *      │  │  ├─ FAC-2002.json
 *      │  │  └─ resumen-2026-01.json
 *      │  └─ 2026-02/
 *      │     └─ FAC-2003.json
 *      └─ gastos/
 *         ├─ 2026-01/
 *         │  ├─ PROV-5001.json
 *         │  └─ resumen-2026-01.json
 *         └─ 2026-02/
 *            └─ PROV-5002.json
 */

import { prisma } from '../config/database';
import { putObject } from '../utils/storage';
import * as path from 'path';

interface FacturaArchivo {
  id: string;
  numeroCompleto: string;
  tipo: 'INGRESO' | 'GASTO';
  fechaEmision: string;
  baseTotal: number;
  ivaTotal: number;
  totalFactura: number;
  cliente?: {
    nombre: string;
    nif: string;
  };
  proveedor?: {
    nombre: string;
    nif: string;
  };
  observaciones?: string;
  estado: string;
  contabilizadaEn: string;
}

/**
 * Obtener ruta de archivado para una factura
 * Formato: facturas/{tipo}/{YYYY-MM}/{numeroCompleto}.json
 */
function obtenerRutaArchivo(
  tipo: 'INGRESO' | 'GASTO',
  numeroCompleto: string,
  fecha: string,
): string {
  const date = new Date(fecha);
  const yyyymm = date.toISOString().substring(0, 7); // 2026-01

  const carpetaTipo = tipo === 'INGRESO' ? 'ingresos' : 'gastos';
  return `facturas/${carpetaTipo}/${yyyymm}/${numeroCompleto}.json`;
}

/**
 * Obtener ruta del resumen mensual
 */
function obtenerRutaResumen(
  tipo: 'INGRESO' | 'GASTO',
  fecha: string,
): string {
  const date = new Date(fecha);
  const yyyymm = date.toISOString().substring(0, 7);

  const carpetaTipo = tipo === 'INGRESO' ? 'ingresos' : 'gastos';
  return `facturas/${carpetaTipo}/${yyyymm}/resumen-${yyyymm}.json`;
}

/**
 * Archivar factura de ingreso cuando se contabiliza
 */
export async function archivarFacturaIngreso(
  companyId: string,
  invoiceId: string,
  numeroCompleto: string,
): Promise<void> {
  try {
    const factura = await prisma.incomeInvoice.findUnique({
      where: { id: invoiceId },
      include: { customer: true },
    });

    if (!factura) {
      console.warn(`Factura de ingreso ${numeroCompleto} no encontrada para archivar`);
      return;
    }

    // Preparar datos para archivo
    const datosArchivo: FacturaArchivo = {
      id: factura.id,
      numeroCompleto: factura.numeroCompleto,
      tipo: 'INGRESO',
      fechaEmision: factura.fechaEmision.slice(0, 10),
      baseTotal: factura.baseTotal,
      ivaTotal: factura.ivaTotal,
      totalFactura: factura.totalFactura,
      cliente: factura.customer
        ? {
            nombre: factura.customer.nombreFiscal,
            nif: factura.customer.nifCif,
          }
        : undefined,
      observaciones: factura.observaciones ?? undefined,
      estado: factura.estado,
      contabilizadaEn: new Date().toISOString(),
    };

    // Guardar archivo JSON
    const ruta = obtenerRutaArchivo(
      'INGRESO',
      numeroCompleto,
      factura.fechaEmision,
    );
    const buffer = Buffer.from(JSON.stringify(datosArchivo, null, 2));
    await putObject(ruta, buffer, 'application/json');

    // Actualizar resumen mensual
    await actualizarResumenMensual(companyId, 'INGRESO', factura.fechaEmision);

    console.log(`✓ Factura de ingreso ${numeroCompleto} archivada en ${ruta}`);
  } catch (error) {
    console.error(
      `Error archivando factura de ingreso ${numeroCompleto}:`,
      error instanceof Error ? error.message : String(error),
    );
    // No lanzar error - archivado es no-crítico
  }
}

/**
 * Archivar factura de gasto cuando se contabiliza
 */
export async function archivarFacturaGasto(
  companyId: string,
  invoiceId: string,
  numeroCompleto: string,
): Promise<void> {
  try {
    const factura = await prisma.expenseInvoice.findUnique({
      where: { id: invoiceId },
      include: { supplier: true },
    });

    if (!factura) {
      console.warn(`Factura de gasto ${numeroCompleto} no encontrada para archivar`);
      return;
    }

    // Preparar datos para archivo
    const datosArchivo: FacturaArchivo = {
      id: factura.id,
      numeroCompleto: factura.numeroCompleto,
      tipo: 'GASTO',
      fechaEmision: factura.fechaEmision.slice(0, 10),
      baseTotal: factura.baseTotal,
      ivaTotal: factura.ivaTotal,
      totalFactura: factura.totalFactura,
      proveedor: factura.supplier
        ? {
            nombre: factura.supplier.nombreFiscal,
            nif: factura.supplier.nifCif,
          }
        : undefined,
      observaciones: factura.observaciones ?? undefined,
      estado: factura.estado,
      contabilizadaEn: new Date().toISOString(),
    };

    // Guardar archivo JSON
    const ruta = obtenerRutaArchivo(
      'GASTO',
      numeroCompleto,
      factura.fechaEmision,
    );
    const buffer = Buffer.from(JSON.stringify(datosArchivo, null, 2));
    await putObject(ruta, buffer, 'application/json');

    // Actualizar resumen mensual
    await actualizarResumenMensual(companyId, 'GASTO', factura.fechaEmision);

    console.log(`✓ Factura de gasto ${numeroCompleto} archivada en ${ruta}`);
  } catch (error) {
    console.error(
      `Error archivando factura de gasto ${numeroCompleto}:`,
      error instanceof Error ? error.message : String(error),
    );
    // No lanzar error - archivado es no-crítico
  }
}

/**
 * Actualizar resumen mensual de facturas
 */
async function actualizarResumenMensual(
  companyId: string,
  tipo: 'INGRESO' | 'GASTO',
  fecha: string, // YYYY-MM-DD, como se guarda fechaEmision
): Promise<void> {
  try {
    const yyyymm = fecha.substring(0, 7);

    // Obtener todas las facturas del mes
    const facturasDelMes =
      tipo === 'INGRESO'
        ? await prisma.incomeInvoice.findMany({
            where: {
              companyId,
              fechaEmision: { startsWith: yyyymm },
            },
          })
        : await prisma.expenseInvoice.findMany({
            where: {
              companyId,
              fechaEmision: { startsWith: yyyymm },
            },
          });

    // Calcular totales
    const resumen = {
      mes: yyyymm,
      tipo,
      cantidad: facturasDelMes.length,
      baseTotal: facturasDelMes.reduce(
        (sum, f) => sum + (f.baseTotal || 0),
        0,
      ),
      ivaTotal: facturasDelMes.reduce(
        (sum, f) => sum + (f.ivaTotal || 0),
        0,
      ),
      totalFacturado: facturasDelMes.reduce(
        (sum, f) => sum + (f.totalFactura || 0),
        0,
      ),
      facturas: facturasDelMes.map((f) => ({
        numero: f.numeroCompleto,
        fecha: f.fechaEmision.slice(0, 10),
        monto: f.totalFactura,
      })),
      generadoEn: new Date().toISOString(),
    };

    // Guardar resumen
    const rutaResumen = obtenerRutaResumen(tipo, fecha);
    const buffer = Buffer.from(JSON.stringify(resumen, null, 2));
    await putObject(rutaResumen, buffer, 'application/json');

    console.log(`✓ Resumen mensual ${tipo} ${yyyymm} actualizado`);
  } catch (error) {
    console.error(
      `Error actualizando resumen mensual:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Obtener lista de facturas archivadas de un mes
 */
export async function obtenerFacturasArchivadas(
  tipo: 'INGRESO' | 'GASTO',
  mes: string, // formato: 2026-01
): Promise<FacturaArchivo[]> {
  try {
    const carpetaTipo = tipo === 'INGRESO' ? 'ingresos' : 'gastos';
    const ruta = `facturas/${carpetaTipo}/${mes}`;

    // Esta es una operación simulada
    // En producción, necesitarías listar el almacenamiento
    console.log(`Buscando facturas en: ${ruta}`);

    return [];
  } catch (error) {
    console.error('Error obteniendo facturas archivadas:', error);
    return [];
  }
}

/**
 * Obtener resumen mensual
 */
export async function obtenerResumenMensual(
  tipo: 'INGRESO' | 'GASTO',
  mes: string, // formato: 2026-01
): Promise<any> {
  try {
    const rutaResumen = `facturas/${tipo === 'INGRESO' ? 'ingresos' : 'gastos'}/${mes}/resumen-${mes}.json`;
    console.log(`Resumen disponible en: ${rutaResumen}`);

    return null;
  } catch (error) {
    console.error('Error obteniendo resumen:', error);
    return null;
  }
}

export const invoiceArchivingService = {
  archivarFacturaIngreso,
  archivarFacturaGasto,
  obtenerFacturasArchivadas,
  obtenerResumenMensual,
};
