/**
 * Lo pendiente de 2026 en las respuestas de Carmen sobre cobros y pagos
 * (INT-01, INT-02 e INT-06): las facturas que la gestoria tenia pendientes a
 * 31-12-2026 (partidas de «Traer la contabilidad de 2026») no son facturas de
 * la app, asi que los listados de facturas no las ven. Se suman aparte, con
 * una frase y un indicador: «De 2026 (lo que dejó pendiente la gestoría)
 * quedan 3 facturas por 4.250,00 €».
 *
 * SOLO LECTURA, y solo si la respuesta de origen tenia permiso y cifras.
 */
import { prisma } from '../../../config/database';
import { hoyEspana } from '../../../utils/fechas';
import { ENLACE_ARRANQUE } from '../../periodos.service';
import { pendientePorPartida } from '../../arranque/partidas.service';
import { eur, plural, sumar } from '../plantillas';
import type { CarmenCtx, HuecosResueltos, RespuestaDatos } from '../tipos';

type Ejecutor = (ctx: CarmenCtx, h: HuecosResueltos) => Promise<RespuestaDatos>;

export const ENLACE_PENDIENTE_2026 = `${ENLACE_ARRANQUE}?vista=pendientes`;

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Partidas abiertas de un tipo (de un tercero, vencidas o de un periodo de vencimiento), con lo que queda de cada una. */
export async function pendiente2026(
  companyId: string,
  tipo: 'COBRO' | 'PAGO',
  filtro: { terceroId?: string; soloVencidas?: boolean; vencenDesde?: string; vencenHasta?: string; hoy?: string } = {},
): Promise<{ numero: number; importe: number }> {
  const hoy = filtro.hoy ?? hoyEspana();
  const filas = await prisma.partidaPendiente.findMany({
    where: {
      companyId,
      tipo,
      estado: { in: ['PENDIENTE', 'PARCIAL'] },
      ...(filtro.terceroId ? (tipo === 'COBRO' ? { customerId: filtro.terceroId } : { supplierId: filtro.terceroId }) : {}),
      ...(filtro.soloVencidas ? { fechaVencimiento: { lt: hoy } } : {}),
      ...(filtro.vencenDesde && filtro.vencenHasta ? { fechaVencimiento: { gte: filtro.vencenDesde, lte: filtro.vencenHasta } } : {}),
    },
    select: { id: true, importePendiente: true },
  });
  if (!filas.length) return { numero: 0, importe: 0 };
  // Lo que queda de cada una: sin lo pagado ni lo descontado con abonos del proveedor.
  const pendiente = await pendientePorPartida(prisma, companyId, filas.map((f) => f.id));
  return { numero: filas.length, importe: r2(sumar(filas.map((f) => pendiente.get(f.id) ?? Number(f.importePendiente)))) };
}

/** Frase para el texto de la respuesta. */
export function frase2026(tipo: 'COBRO' | 'PAGO', p: { numero: number; importe: number }): string {
  return `De 2026 (lo que dejó pendiente la gestoría a 31-12) ${p.numero === 1 ? 'queda 1 factura' : `quedan ${p.numero} facturas`} ${tipo === 'COBRO' ? 'por cobrar' : 'por pagar'} por ${eur(p.importe)}.`;
}

/**
 * Envuelve el ejecutor de INT-01/02 (cobros) o INT-06 (pagos) para sumar lo
 * pendiente de 2026 con los mismos filtros (tercero, solo vencidas, periodo).
 */
export function conPendiente2026(tipo: 'COBRO' | 'PAGO', ejecutor: Ejecutor): Ejecutor {
  return async (ctx, h) => {
    const r = await ejecutor(ctx, h);
    if (r.sinPermiso || r.sinCifras) return r;
    const p = await pendiente2026(ctx.companyId, tipo, {
      terceroId: h.terceroId,
      soloVencidas: h.soloVencidas,
      vencenDesde: h.periodo?.desde,
      vencenHasta: h.periodo?.hasta,
      hoy: ctx.hoy,
    });
    if (!p.numero) return r;
    return {
      ...r,
      texto: `${r.texto} ${frase2026(tipo, p)}`,
      kpis: [...(r.kpis ?? []), { etiqueta: 'Pendiente de 2026', valor: eur(p.importe), detalle: plural(p.numero, 'factura') }],
      enlaces: [...(r.enlaces ?? []), { texto: 'Ver lo pendiente de 2026', href: ENLACE_PENDIENTE_2026 }],
    };
  };
}
