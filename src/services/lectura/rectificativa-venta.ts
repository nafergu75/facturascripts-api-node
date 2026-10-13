/**
 * Lector de ventas con una rectificativa o un abono (seccion «Lector de
 * ventas» de la especificacion de rectificativas de venta): lo que la pantalla
 * necesita para registrarla como rectificativa.
 *
 *  - La factura que rectifica: se busca por el numero leido en TODAS las
 *    facturas emitidas de la empresa (tambien las registradas con el lector),
 *    no solo en las del cliente del NIF leido, porque la original es la que
 *    decide el cliente.
 *  - Las partidas de cobro de 2026 que trajo la gestoria, del cliente leido.
 *  - El motivo, si el texto leido lo deja claro.
 *  - Con importes en negativo, por diferencias. Con importes en positivo y
 *    tipo rectificativa no se propone nada: hay que decir si restan, suman o
 *    es la factura corregida entera (pideSigno).
 *
 * Se calcula al responder la lectura (no se guarda), como la de compras.
 */
import { motivoDeTexto, type MotivoVenta } from '../../domain/rectificativa-venta.model';
import { normalizarNif } from '../../utils/nif';
import { buscarOriginalesVenta, partidasFueraCobro, type CandidataOriginalVenta, type PartidaFueraVenta } from '../rectificativasVenta.service';
import { clientePorNif } from './terceros-lector';
import { importesNegativos } from './validaciones';
import type { LecturaNormalizada } from './tipos';

export interface RectificativaVentaLeida {
  /** Numero de la factura que rectifica, tal como se leyo. */
  numeroRectificada: string | null;
  /** Motivo tal como se leyo. */
  motivoLeido: string | null;
  /** Motivo que sale del texto leido; null: hay que elegirlo. */
  motivoPropuesto: MotivoVenta | null;
  importesNegativos: boolean;
  /** Es una rectificativa y trae los importes en positivo: hay que decir si restan, suman o es una sustitucion. */
  pideSigno: boolean;
  /** I con importes en negativo; con importes en positivo no se propone. */
  formaPropuesta: 'I' | null;
  propuesta: {
    coincidencia: 'EXACTA' | 'PARECIDA' | 'NINGUNA';
    /** La que coincide con el numero leido (o la unica parecida). */
    original: CandidataOriginalVenta | null;
    candidatas: CandidataOriginalVenta[];
  };
  /** Cobros de 2026 pendientes del cliente resuelto por el NIF leido (sin factura en la app). */
  partidasFuera: PartidaFueraVenta[];
  clienteDeLaOriginal: { id: string; nombreFiscal: string; nifCif: string | null } | null;
  /** El NIF leido no es el del cliente de la original propuesta. */
  clienteDistinto: boolean;
}

/** Datos de rectificativa de una lectura de venta, o null si no es una rectificativa ni un abono. */
export async function rectificativaVentaLeida(companyId: string, l: LecturaNormalizada): Promise<RectificativaVentaLeida | null> {
  const negativos = importesNegativos(l);
  const esRectificativa = l.tipoDocumento.valor === 'rectificativa';
  if (!esRectificativa && !negativos) return null;
  const numeroRectificada = l.rectificativa?.numeroRectificada.valor?.trim() || null;
  const motivoLeido = l.rectificativa?.motivo.valor?.trim() || null;

  const [busqueda, cliente] = await Promise.all([
    numeroRectificada ? buscarOriginalesVenta(companyId, { numero: numeroRectificada, take: 10 }) : Promise.resolve(null),
    clientePorNif(companyId, l.receptor.nif.valor),
  ]);
  const candidatas = busqueda?.candidatas ?? [];
  const original = candidatas.find((c) => c.exacta) ?? (candidatas.length === 1 ? candidatas[0] : null);
  const nifLeido = normalizarNif(l.receptor.nif.valor ?? '') || null;
  const nifOriginal = original?.nifCliente ? normalizarNif(original.nifCliente) || null : null;

  return {
    numeroRectificada,
    motivoLeido,
    motivoPropuesto: motivoDeTexto(motivoLeido),
    importesNegativos: negativos,
    pideSigno: esRectificativa && !negativos,
    formaPropuesta: negativos ? 'I' : null,
    propuesta: { coincidencia: busqueda?.coincidencia ?? 'NINGUNA', original, candidatas },
    partidasFuera: cliente ? await partidasFueraCobro(companyId, cliente.id, numeroRectificada) : [],
    clienteDeLaOriginal: original ? { id: original.customerId, nombreFiscal: original.cliente, nifCif: original.nifCliente } : null,
    clienteDistinto: !!original && !!nifLeido && nifLeido !== nifOriginal,
  };
}
