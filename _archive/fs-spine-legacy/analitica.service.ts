import { FilaMargen, ReporteMargen } from '../domain/reportes.model';
import { getFsClientForCompany } from './facturascripts-client';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

function filaMargen(clave: string, nombre: string, ventas: number, coste: number): FilaMargen {
  const margen = round2(ventas - coste);
  return { clave, nombre, ventas: round2(ventas), coste: round2(coste), margen, margenPorcentaje: ventas ? round2((margen / ventas) * 100) : 0 };
}

/**
 * Margen por cliente: ventas (neto de facturaclientes) agrupadas por cliente.
 * TODO: el coste de ventas real requiere enlazar con compras/escandallos; de
 * momento coste=0 (margen = ventas). Ampliable con centros de coste/canales.
 */
export async function calcularMargenPorCliente(companyId: string, ejercicio: number): Promise<ReporteMargen> {
  const fs = await getFsClientForCompany(companyId);
  const { items } = await fs.listWithMeta('facturaclientes', {
    'filter[fecha_gte]': `${ejercicio}-01-01`,
    'filter[fecha_lte]': `${ejercicio}-12-31`,
    limit: 5000,
  });

  const porCliente = new Map<string, { nombre: string; ventas: number }>();
  for (const f of items as Array<Record<string, unknown>>) {
    const clave = String(f.codcliente ?? '');
    const nombre = String(f.nombrecliente ?? clave);
    const prev = porCliente.get(clave) ?? { nombre, ventas: 0 };
    prev.ventas = round2(prev.ventas + Number(f.neto ?? 0));
    porCliente.set(clave, prev);
  }

  const filas = [...porCliente.entries()]
    .map(([clave, v]) => filaMargen(clave, v.nombre, v.ventas, 0))
    .sort((a, b) => b.ventas - a.ventas);

  return { companyId, ejercicio, criterio: 'cliente', filas };
}
