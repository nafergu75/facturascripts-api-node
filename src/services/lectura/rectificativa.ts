/**
 * Lector de gastos con una rectificativa o un abono (sección 12 de la
 * especificación de abonos): lo que la pantalla necesita para abrir el
 * formulario como abono.
 *
 *  - La factura que rectifica: la misma búsqueda que GET /originales, con el
 *    proveedor (por el NIF leído) y el número de la rectificada. Sin proveedor
 *    en la app no hay propuesta: la original será «de fuera» con el número leído.
 *  - Por diferencias o por sustitución: con importes en negativo, por
 *    diferencias y «Reduce el importe». En positivo no se propone nada (hay
 *    que elegir), salvo que el total leído pase del 50 % del de la original
 *    propuesta: entonces parece la factura corregida entera, por sustitución.
 *  - La causa, si el motivo leído la deja clara.
 *
 * Se calcula al responder la lectura (no se guarda), como la de duplicados.
 */
import type { Causa, TipoRectificativa } from '../../domain/rectificativa-gasto.model';
import { aCentimos } from '../../utils/money';
import { buscarOriginales } from '../rectificativasGasto.service';
import { proveedorPorNif } from './contexto';
import { importesNegativos } from './validaciones';
import type { LecturaNormalizada } from './tipos';

/** Por encima de esta parte del total de la original, una rectificativa en positivo se propone por sustitución. */
export const UMBRAL_SUSTITUCION = 0.5;

export interface CandidataOriginal {
  id: string;
  numeroCompleto: string;
  numero: string | null;
  fecha: string;
  total: number;
  exacta: boolean;
}

export interface RectificativaLeida {
  /** Número de la factura que rectifica, tal como se leyó. */
  numeroRectificada: string | null;
  motivo: string | null;
  /** Causa que sale del motivo leído; null: hay que elegirla. */
  causaPropuesta: Causa | null;
  importesNegativos: boolean;
  /** I con importes en negativo; S si en positivo pasa del 50 % de la original; null: hay que elegir. */
  tipoPropuesto: TipoRectificativa | null;
  /** 'REDUCE' con importes en negativo; null: hay que elegir «Reduce el importe | Lo aumenta». */
  sentido: 'REDUCE' | null;
  /** null sin proveedor en la app (la original irá «de fuera», con el número leído). */
  propuesta: {
    coincidencia: 'EXACTA' | 'PARECIDA' | 'NINGUNA';
    /** La original propuesta: la que coincide (o la única parecida). */
    original: CandidataOriginal | null;
    candidatas: CandidataOriginal[];
  } | null;
}

/** Causa por el motivo leído: devolución, rappel, pronto pago, descuento o error de IVA. */
export function causaDeMotivo(motivo: string | null | undefined): Causa | null {
  const m = (motivo ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  if (!m.trim()) return null;
  if (/devoluci|devuelt/.test(m)) return 'DEVOLUCION';
  if (/rappel/.test(m)) return 'RAPPEL';
  if (/pronto pago/.test(m)) return 'PRONTO_PAGO';
  if (/descuento|bonificaci/.test(m)) return 'DESCUENTO';
  if (/\biva\b|tipo impositivo/.test(m)) return 'ERROR_IVA';
  return null;
}

/** Por diferencias o por sustitución, con lo leído y la original propuesta (sección 12). */
export function tipoPropuesto(p: { negativos: boolean; totalLeido: number | null; totalOriginal: number | null }): TipoRectificativa | null {
  if (p.negativos) return 'I';
  if (p.totalLeido === null || p.totalOriginal === null || aCentimos(p.totalOriginal) <= 0) return null;
  return Math.abs(aCentimos(p.totalLeido)) > aCentimos(p.totalOriginal) * UMBRAL_SUSTITUCION ? 'S' : null;
}

/** Datos de rectificativa de una lectura de gasto, o null si no es una rectificativa ni un abono. */
export async function rectificativaLeida(companyId: string, l: LecturaNormalizada): Promise<RectificativaLeida | null> {
  const negativos = importesNegativos(l);
  if (l.tipoDocumento.valor !== 'rectificativa' && !negativos) return null;
  const numeroRectificada = l.rectificativa?.numeroRectificada.valor ?? null;
  const motivo = l.rectificativa?.motivo.valor ?? null;
  const prov = await proveedorPorNif(companyId, l.emisor.nif.valor);
  let propuesta: RectificativaLeida['propuesta'] = null;
  if (prov) {
    const r = await buscarOriginales(companyId, { supplierId: prov.id, numero: numeroRectificada });
    const candidatas = r.candidatas.map((c) => ({ ...c, total: Number(c.total) }));
    const original = numeroRectificada ? (candidatas.find((c) => c.exacta) ?? (candidatas.length === 1 ? candidatas[0] : null)) : null;
    propuesta = { coincidencia: numeroRectificada ? r.coincidencia : 'NINGUNA', original, candidatas: numeroRectificada ? candidatas : [] };
  }
  const totalLeido = l.totales.totalFactura.valor ?? l.totales.totalAPagar.valor ?? null;
  return {
    numeroRectificada,
    motivo,
    causaPropuesta: causaDeMotivo(motivo),
    importesNegativos: negativos,
    tipoPropuesto: tipoPropuesto({ negativos, totalLeido, totalOriginal: propuesta?.original?.total ?? null }),
    sentido: negativos ? 'REDUCE' : null,
    propuesta,
  };
}
