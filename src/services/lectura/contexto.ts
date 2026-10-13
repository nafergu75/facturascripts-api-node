/**
 * Lo que las validaciones necesitan de la BD, cargado antes de validar: NIF,
 * nombres y perfil de la empresa, periodos abiertos y duplicados (factura y archivo).
 */
import { prisma } from '../../config/database';
import { normalizarNumeroProveedor } from '../../domain/factura-gasto.model';
import { limpiarNif } from '../../domain/tipo-operacion.model';
import { hoyEspana } from '../../utils/fechas';
import { normalizarNif } from '../../utils/nif';
import { numeroCompletoLeido } from '../income-invoices.service';
import { separarNumero } from '../ingresos-extractor.service';
import { perfilEmpresa } from '../perfilEmpresa.service';
import { comprobarFechaAbierta } from '../periodos.service';
import { datosEmpresaValidacion } from './datosEmpresa';
import type { Lector, LecturaNormalizada } from './tipos';
import type { ContextoValidacion } from './validaciones';

/** Proveedor de la empresa con ese NIF (con o sin prefijo y separadores), o null. */
export async function proveedorPorNif(companyId: string, nif: string | null): Promise<{ id: string; nombreFiscal: string; nifCif: string } | null> {
  if (!nif) return null;
  const nifs = [...new Set([normalizarNif(nif), limpiarNif(nif)].filter(Boolean))];
  return prisma.supplier.findFirst({ where: { companyId, nifCif: { in: nifs } }, select: { id: true, nombreFiscal: true, nifCif: true } });
}

/** La factura de gasto ya registrada de ese proveedor con ese numero, o null (la consulta de hoy del lector). */
export async function gastoDuplicado(companyId: string, supplierId: string, numero: string | null): Promise<{ facturaId: string; numeroCompleto: string } | null> {
  if (!numero) return null;
  const f = await prisma.expenseInvoice.findFirst({
    where: { companyId, supplierId, numeroProveedorActivo: normalizarNumeroProveedor(numero) },
    select: { id: true, numeroCompleto: true },
  });
  return f ? { facturaId: f.id, numeroCompleto: f.numeroCompleto } : null;
}

async function facturaDuplicada(companyId: string, lector: Lector, l: LecturaNormalizada): Promise<{ numeroCompleto: string } | null> {
  if (!l.numero.valor) return null;
  if (lector === 'GASTO') {
    const prov = await proveedorPorNif(companyId, l.emisor.nif.valor);
    return prov ? gastoDuplicado(companyId, prov.id, l.numero.valor) : null;
  }
  // Repetida si coincide la serie y el numero (sin ceros ni separador) o el numero tal como se leyo.
  let clave: { serie: string; numero: number };
  try {
    clave = separarNumero(null, l.numero.valor, l.fechaEmision.valor);
  } catch {
    return null;
  }
  const tal = numeroCompletoLeido(l.numero.valor, clave.serie);
  const f = await prisma.incomeInvoice.findFirst({
    where: { companyId, OR: [clave, ...(tal ? [{ numeroCompleto: tal }] : [])] },
    select: { numeroCompleto: true },
  });
  return f?.numeroCompleto ? { numeroCompleto: f.numeroCompleto } : null;
}

async function archivoRepetido(companyId: string, archivoHash: string | null, lecturaId: string | null): Promise<{ fecha: string } | null> {
  if (!archivoHash) return null;
  const otra = await prisma.lecturaDocumento.findFirst({
    where: { companyId, archivoHash, estado: 'CONFIRMADA', ...(lecturaId ? { NOT: { id: lecturaId } } : {}) },
    select: { confirmadaEn: true, updatedAt: true },
    orderBy: { confirmadaEn: 'desc' },
  });
  return otra ? { fecha: hoyEspana(otra.confirmadaEn ?? otra.updatedAt) } : null;
}

export async function contextoValidacion(
  companyId: string,
  lector: Lector,
  l: LecturaNormalizada,
  opciones: { archivoHash?: string | null; lecturaId?: string | null } = {},
): Promise<ContextoValidacion> {
  const [empresa, perfil, factura, archivo] = await Promise.all([
    datosEmpresaValidacion(companyId),
    perfilEmpresa(companyId),
    facturaDuplicada(companyId, lector, l),
    archivoRepetido(companyId, opciones.archivoHash ?? null, opciones.lecturaId ?? null),
  ]);
  return {
    lector,
    nifEmpresa: empresa.nifEmpresa,
    nombresEmpresa: empresa.nombresEmpresa,
    empresaEspanola: perfil.espanola,
    monedaCuenta: perfil.monedaCuenta,
    hoy: hoyEspana(),
    periodoAbierto: async (fecha) => {
      try {
        await comprobarFechaAbierta(companyId, fecha);
        return true;
      } catch {
        return false;
      }
    },
    duplicado: { factura, archivo },
  };
}
