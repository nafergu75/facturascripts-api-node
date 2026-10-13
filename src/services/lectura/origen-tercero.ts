/**
 * De donde es el tercero de una factura leida: el cliente en el lector de
 * ventas y el proveedor en el de gastos.
 *
 * La persona lo dice antes de subir la factura («¿De dónde es el cliente?»:
 * de España, de otro país de la UE o de fuera de la UE, con el pais si lo
 * sabe) y esa eleccion manda en las validaciones, salvo con un tercero ya dado
 * de alta: entonces manda su ficha (ver detectarOrigenTercero). Sin eleccion,
 * se deduce, por este orden:
 *   1. el pais del tercero ya dado de alta con ese NIF (su ficha);
 *   2. el prefijo de NIF-IVA de la UE, si el numero tiene la forma de los de
 *      ese Estado (FR + 11 caracteres...; ES con un NIF espanol valido);
 *   3. el pais leido en su direccion;
 *   4. el prefijo de NIF-IVA aunque el numero no tenga la forma de su Estado
 *      (un RFC mexicano puede empezar por DE...: por eso va detras de la direccion);
 *   5. la forma del numero: si parece un NIF espanol, de Espana. Si no, no se
 *      sabe (las validaciones lo dejan en «revisar» y piden el pais).
 *
 * La eleccion se guarda con la lectura (LecturaDocumento.resultado.origenTercero,
 * un campo JSON que ya existia) y se puede cambiar despues de leer: se vuelve a
 * validar sin leer otra vez la factura.
 */
import { esPaisUe, limpiarNif, normalizarPais, prefijoNifIvaUe } from '../../domain/tipo-operacion.model';
import {
  NUMERO_FISCAL_ESPANA,
  NUMERO_FISCAL_GENERICO,
  NUMERO_FISCAL_UE,
  nombreNumeroFiscal,
  nombrePaisEs,
  pareceNifEspanol,
  prefijoNifIvaDePais,
  tieneFormaNifIvaUe,
} from '../../domain/numero-fiscal';
import { badRequest } from '../../utils/http-errors';
import { esCodigoPais } from '../../utils/geografia';
import { validarNifEspanol } from '../../utils/nif';
import { paisIsoLeido } from './pais-leido';
import type { Lector, LecturaNormalizada } from './tipos';

export const ORIGENES_TERCERO = ['ES', 'UE', 'FUERA'] as const;
export type OrigenTercero = (typeof ORIGENES_TERCERO)[number];

/** Lo que ha dicho la persona. pais: ISO-2, o null si no lo ha elegido (en ES siempre 'ES'). */
export interface EleccionOrigenTercero {
  origen: OrigenTercero;
  pais: string | null;
}

/** De donde sale lo que se sabe del tercero. */
export type FuenteOrigen = 'eleccion' | 'ficha' | 'prefijo' | 'direccion' | 'forma';

export interface OrigenDetectado {
  /** null: no se sabe (sin eleccion, ficha, prefijo ni direccion, y un numero que no parece espanol). */
  origen: OrigenTercero | null;
  pais: string | null;
  por: FuenteOrigen | null;
}

export interface DatosOrigenTercero {
  eleccion?: EleccionOrigenTercero | null;
  /** Pais de la ficha del tercero ya dado de alta con ese NIF. */
  paisFicha?: string | null;
  /** NIF leido del tercero. */
  nif?: string | null;
  /** Pais leido en su direccion (ISO-2, ISO-3 o el nombre). */
  paisDireccion?: string | null;
}

export type TipoTercero = 'cliente' | 'proveedor';
export const tipoTercero = (lector: Lector): TipoTercero => (lector === 'VENTA' ? 'cliente' : 'proveedor');

/** Pais ISO-2 -> de que lado esta (Espana, otro Estado de la UE o fuera), o null si no es un pais. */
export function origenDePais(pais: string | null | undefined): OrigenTercero | null {
  const p = normalizarPais(pais);
  if (!/^[A-Z]{2}$/.test(p) || !esCodigoPais(p)) return null;
  if (p === 'ES') return 'ES';
  return esPaisUe(p) ? 'UE' : 'FUERA';
}

const QUE_ORIGEN = 'Indica de dónde es el cliente o el proveedor: de España, de otro país de la UE o de fuera de la UE.';

/**
 * La eleccion que llega de la pantalla (al subir la factura o al cambiarla
 * despues), o null si no llega ninguna. 400 si no vale. El pais es opcional
 * en UE y FUERA, y tiene que ser de ese lado.
 */
export function leerEleccionOrigen(origen: unknown, pais: unknown): EleccionOrigenTercero | null {
  if (origen === undefined || origen === null || String(origen).trim() === '') return null;
  const o = String(origen).trim().toUpperCase();
  if (!(ORIGENES_TERCERO as readonly string[]).includes(o)) throw badRequest(QUE_ORIGEN, { codigo: 'ORIGEN_TERCERO_NO_VALIDO', campo: 'origenTercero' });
  if (o === 'ES') return { origen: 'ES', pais: 'ES' };
  const crudo = pais === undefined || pais === null ? '' : String(pais).trim();
  if (!crudo) return { origen: o as OrigenTercero, pais: null };
  const p = normalizarPais(crudo);
  const lado = origenDePais(p);
  if (!lado) throw badRequest(`El país «${crudo}» no existe: usa su código de dos letras (FR, US...).`, { codigo: 'ORIGEN_TERCERO_NO_VALIDO', campo: 'paisTercero' });
  if (lado !== o) {
    const texto =
      lado === 'ES'
        ? 'España: elige «De España».'
        : lado === 'UE'
          ? `${nombrePaisEs(p)} es de la UE: elige «De otro país de la UE».`
          : `${nombrePaisEs(p)} no es de la UE: elige «De fuera de la UE».`;
    throw badRequest(texto, { codigo: 'ORIGEN_TERCERO_NO_VALIDO', campo: 'paisTercero' });
  }
  return { origen: o as OrigenTercero, pais: p };
}

/** La eleccion guardada con la lectura (resultado.origenTercero), o null. */
export function eleccionGuardada(resultado: unknown): EleccionOrigenTercero | null {
  const e = (resultado as { origenTercero?: unknown } | null)?.origenTercero as Partial<EleccionOrigenTercero> | null | undefined;
  if (!e || typeof e !== 'object' || !(ORIGENES_TERCERO as readonly string[]).includes(String(e.origen))) return null;
  return { origen: e.origen as OrigenTercero, pais: typeof e.pais === 'string' && e.pais ? e.pais : null };
}

/**
 * El prefijo de NIF-IVA del numero, si el numero tiene la forma de los de ese
 * Estado (FR + 11 caracteres...). Con ES, si detras va un NIF espanol valido
 * (ESB12345674). null si no lleva prefijo o no tiene esa forma.
 */
function prefijoConSuForma(nif: string): { prefijo: string; pais: string } | null {
  const pref = nif ? prefijoNifIvaUe(nif) : null;
  if (!pref) return null;
  const conForma = pref.prefijo === 'ES' ? validarNifEspanol(nif).valido : tieneFormaNifIvaUe(pref.prefijo, nif.slice(2));
  return conForma ? pref : null;
}

/** Lo que se deduce sin la eleccion (ver el orden arriba). */
export function origenAutomatico(d: DatosOrigenTercero): OrigenDetectado {
  const ficha = normalizarPais(d.paisFicha);
  const deFicha = origenDePais(ficha);
  if (deFicha) return { origen: deFicha, pais: ficha, por: 'ficha' };
  const nif = limpiarNif(d.nif);
  const pref = nif ? prefijoNifIvaUe(nif) : null;
  if (pref && prefijoConSuForma(nif)) return { origen: origenDePais(pref.pais) ?? 'UE', pais: pref.pais, por: 'prefijo' };
  const dir = paisIsoLeido(d.paisDireccion);
  const deDireccion = origenDePais(dir);
  if (dir && deDireccion) return { origen: deDireccion, pais: dir, por: 'direccion' };
  if (pref) return { origen: origenDePais(pref.pais) ?? 'UE', pais: pref.pais, por: 'prefijo' };
  if (nif && pareceNifEspanol(nif)) return { origen: 'ES', pais: 'ES', por: 'forma' };
  return { origen: null, pais: null, por: null };
}

/**
 * De donde es el tercero para las validaciones: lo elegido, si hay eleccion
 * (con el pais elegido o, si no se eligio, el que se deduce si es del mismo
 * lado); si no, lo que se deduce.
 *
 * Salvo un tercero ya dado de alta: su ficha dice de donde es, y su numero ya
 * se acepto al darlo de alta. Lo elegido suele ser lo de la factura anterior o
 * lo de por defecto (De España) y no la pisa: si no casan, lo avisa
 * contradiccionOrigen, con el boton para cambiarlo.
 */
export function detectarOrigenTercero(d: DatosOrigenTercero): OrigenDetectado {
  const auto = origenAutomatico(d);
  const e = d.eleccion;
  if (!e || auto.por === 'ficha') return auto;
  if (e.origen === 'ES') return { origen: 'ES', pais: 'ES', por: 'eleccion' };
  return { origen: e.origen, pais: e.pais ?? (auto.origen === e.origen ? auto.pais : null), por: 'eleccion' };
}

/** «NIF», «NIF-IVA (VAT)», «RNC»... del tercero, aunque solo se sepa el lado (UE o fuera) y no el pais. */
export function numeroFiscalDe(o: Pick<OrigenDetectado, 'origen' | 'pais'>): string {
  if (o.pais) return nombreNumeroFiscal(o.pais);
  if (o.origen === 'UE') return NUMERO_FISCAL_UE;
  if (o.origen === 'FUERA') return NUMERO_FISCAL_GENERICO;
  return NUMERO_FISCAL_ESPANA;
}

/** El mismo, dentro de una frase («Falta el número fiscal (Tax ID) del cliente»). */
export const numeroFiscalEnFraseDe = (o: Pick<OrigenDetectado, 'origen' | 'pais'>): string => {
  const n = numeroFiscalDe(o);
  return n === NUMERO_FISCAL_GENERICO ? 'número fiscal (Tax ID)' : n;
};

const LADO: Record<OrigenTercero, string> = { ES: 'de España', UE: 'de otro país de la UE', FUERA: 'de fuera de la UE' };

/** «de Francia», «de otro país de la UE», «de España». */
const deDonde = (origen: OrigenTercero, pais: string | null) => (origen === 'ES' ? 'de España' : pais ? `de ${nombrePaisEs(pais)}` : LADO[origen]);

/** Lo que la factura dice del tercero, en una frase («su NIF-IVA (FR…) es de Francia»). */
function porQue(auto: OrigenDetectado, nif: string | null, tipo: TipoTercero): string {
  const pais = auto.pais ? nombrePaisEs(auto.pais) : '';
  switch (auto.por) {
    case 'ficha':
      return `Lo tienes dado de alta como ${tipo} ${auto.origen === 'ES' ? 'de España' : `de ${pais}`}`;
    case 'prefijo':
      return `Su número (${nif}) es un NIF-IVA de ${pais}`;
    case 'direccion':
      return `Su dirección está en ${pais}`;
    default:
      return `Su número (${nif}) es un NIF español`;
  }
}

export interface Contradiccion {
  /** Lo que se propone elegir. */
  origen: OrigenTercero;
  pais: string | null;
  mensaje: string;
}

/**
 * Lo leido contradice la eleccion: se eligio «De España» y la factura trae un
 * NIF-IVA FR o una direccion en Francia, o al reves; o el mismo lado con otro
 * pais. La forma de NIF espanol solo cuenta si su control es bueno (un numero
 * extranjero se le puede parecer). Con «De fuera de la UE», un prefijo de la UE
 * sin la forma de ese Estado tampoco cuenta: un RFC mexicano puede empezar por
 * DE. null si no hay eleccion o no se contradice.
 */
export function contradiccionOrigen(d: DatosOrigenTercero, tipo: TipoTercero): Contradiccion | null {
  const e = d.eleccion;
  if (!e) return null;
  const auto = origenAutomatico(d);
  if (!auto.origen) return null;
  const nif = limpiarNif(d.nif) || null;
  if (auto.por === 'forma' && !validarNifEspanol(nif).valido) return null;
  if (auto.por === 'prefijo' && e.origen === 'FUERA' && !prefijoConSuForma(nif ?? '')) return null;
  // XI (Irlanda del Norte) con la direccion en el Reino Unido: en las entregas de bienes cuenta como de la UE.
  if (e.origen === 'UE' && auto.pais === 'GB' && prefijoNifIvaUe(nif)?.prefijo === 'XI') return null;
  const otroLado = auto.origen !== e.origen;
  const otroPais = !otroLado && !!e.pais && !!auto.pais && normalizarPais(e.pais) !== normalizarPais(auto.pais);
  if (!otroLado && !otroPais) return null;
  const mensaje = `${porQue(auto, nif, tipo)} y has dicho que el ${tipo} es ${deDonde(e.origen, e.pais)}. Si es ${deDonde(auto.origen, auto.pais)}, cámbialo en «¿De dónde es el ${tipo}?»; si no, comprueba el dato con la factura.`;
  return { origen: auto.origen, pais: auto.pais, mensaje };
}

/** El NIF leido con el prefijo de su pais, si se leyo sin el y tiene la forma de los de ese pais (12345678901 de Francia -> FR12345678901). */
export function nifIvaConPrefijo(nif: string | null | undefined, pais: string | null | undefined): string | null {
  const n = limpiarNif(nif);
  const prefijo = prefijoNifIvaDePais(pais);
  if (!n || !prefijo || prefijoNifIvaUe(n)) return null;
  return tieneFormaNifIvaUe(prefijo, n) ? `${prefijo}${n}` : null;
}

/** Lo que la pantalla necesita saber del tercero de la lectura. */
export interface InfoTercero {
  tipo: TipoTercero;
  /** Lo que eligio la persona (null: no lo dijo; se deduce). */
  eleccion: EleccionOrigenTercero | null;
  /** Con lo que se ha validado: la eleccion o, sin ella, lo que se deduce. */
  origen: OrigenTercero | null;
  pais: string | null;
  por: FuenteOrigen | null;
  /** Lo que se deduce de la factura sin la eleccion. */
  detectado: OrigenDetectado;
  /** Lo leido contradice la eleccion: lo que se propone elegir y por que. */
  contradiccion: Contradiccion | null;
  /** Como se llama su numero fiscal: «NIF», «NIF-IVA (VAT)», «RNC»... */
  numeroFiscal: string;
  /**
   * El NIF-IVA leido sin prefijo, ya con el de su pais (para la ficha del alta); null si no hace falta.
   * Si lo leido contradice la eleccion, con el pais que dice la factura (la ficha del alta se rellena con el).
   */
  nifPropuesto: string | null;
}

/** Datos del tercero de una lectura (el cliente en ventas, el proveedor en gastos). */
export function datosTerceroDeLectura(
  lector: Lector,
  l: LecturaNormalizada,
  extra: { eleccion: EleccionOrigenTercero | null; paisFicha: string | null },
): DatosOrigenTercero {
  const parte = lector === 'VENTA' ? l.receptor : l.emisor;
  return { eleccion: extra.eleccion, paisFicha: extra.paisFicha, nif: parte.nif.valor, paisDireccion: parte.direccion?.valor?.pais ?? null };
}

export function infoTercero(lector: Lector, d: DatosOrigenTercero): InfoTercero {
  const efectivo = detectarOrigenTercero(d);
  const contradiccion = contradiccionOrigen(d, tipoTercero(lector));
  // Para la ficha del alta: lo que dice la factura si contradice lo elegido (la pantalla rellena el pais con ello).
  const paraFicha = contradiccion ?? efectivo;
  return {
    tipo: tipoTercero(lector),
    eleccion: d.eleccion ?? null,
    origen: efectivo.origen,
    pais: efectivo.pais,
    por: efectivo.por,
    detectado: origenAutomatico(d),
    contradiccion,
    numeroFiscal: numeroFiscalDe(efectivo),
    nifPropuesto: paraFicha.origen === 'UE' ? nifIvaConPrefijo(d.nif, paraFicha.pais) : null,
  };
}
