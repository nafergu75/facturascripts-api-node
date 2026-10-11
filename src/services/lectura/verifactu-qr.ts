/**
 * QR de VERI*FACTU (AEAT, "Detalle de las especificaciones tecnicas del codigo
 * QR", v0.5.0 de 10-12-2025).
 *
 *   https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR?nif=…&numserie=…&fecha=DD-MM-AAAA&importe=241.4
 *
 * Se lee lo que trae el codigo (Azure lo da en pages[].barcodes con el
 * complemento gratuito de codigos de barras) y se compara con lo leido de la
 * factura. La URL NUNCA se abre: el cotejo en linea con la AEAT queda fuera
 * de esta fase.
 *
 * Sobre el importe: segun fabricantes de software (no lo he encontrado en una
 * pagina oficial de la AEAT) es el total sin restar la retencion de IRPF. Por
 * eso se compara con el total bruto (base + IVA + recargo).
 */
import { esFechaReal } from '../../schemas/factura-gasto.schemas';
import { aCentimos } from '../../utils/money';
import { normalizarNif } from '../../utils/nif';
import type { Campo, DiferenciaQr, LecturaNormalizada, QrInterpretado, ResultadoQr } from './tipos';

const HOST_PRODUCCION = 'www2.agenciatributaria.gob.es';
const HOST_PRUEBAS = 'prewww2.aeat.es';
const RUTA_VERIFACTU = '/wlpl/TIKE-CONT/ValidarQR';
const RUTA_NO_VERIFACTU = '/wlpl/TIKE-CONT/ValidarQRNoVerifactu';
const CLAVES_ADMITIDAS = new Set(['nif', 'numserie', 'fecha', 'importe', 'idioma', 'formato']);

export const MOTIVO_QR_PRUEBAS = 'El QR es del entorno de pruebas de la AEAT; una factura real no debería llevarlo.';
export const MOTIVO_QR_ILEGIBLE = 'El QR VERI*FACTU está mal formado; no se ha podido comprobar.';
export const MOTIVO_TOTAL_DEL_QR = 'Se ha tomado el total del QR, que no trae el desglose: compruébalo.';
export const MOTIVO_DATO_DEL_QR = 'No se ha podido leer en la factura: se ha sacado del QR. Compruébalo con el documento.';

export interface CodigoBarras {
  kind?: string;
  value?: string;
}

/** Interpreta un valor de QR. null si no es una URL. */
export function interpretarValorQr(valor: string): QrInterpretado | null {
  let url: URL;
  try {
    url = new URL(valor.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host === HOST_PRUEBAS) return { estado: 'PRUEBAS', verifactu: null, datos: null };
  if (host !== HOST_PRODUCCION || (url.pathname !== RUTA_VERIFACTU && url.pathname !== RUTA_NO_VERIFACTU)) {
    return { estado: 'AJENO', verifactu: null, datos: null };
  }
  const verifactu = url.pathname === RUTA_VERIFACTU;
  const ilegible: QrInterpretado = { estado: 'ILEGIBLE', verifactu, datos: null };

  const p = url.searchParams;
  // Una clave que no es del QR suele ser un '&' sin codificar dentro de numserie.
  for (const clave of p.keys()) if (!CLAVES_ADMITIDAS.has(clave)) return ilegible;
  const nif = p.get('nif');
  const numserie = p.get('numserie');
  const fecha = p.get('fecha');
  const importe = p.get('importe');
  if (!nif || !numserie || !fecha || !importe) return ilegible;

  const f = /^(\d{2})-(\d{2})-(\d{4})$/.exec(fecha);
  const iso = f ? `${f[3]}-${f[2]}-${f[1]}` : '';
  if (!f || !esFechaReal(iso)) return ilegible;
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(importe)) return ilegible;
  if (numserie.length > 60) return ilegible;

  return { estado: 'VALIDO', verifactu, datos: { nif: normalizarNif(nif), numserie, fecha: iso, importe: Number(importe) } };
}

const PRIORIDAD: Record<QrInterpretado['estado'], number> = { VALIDO: 0, ILEGIBLE: 1, PRUEBAS: 1, AJENO: 2 };

/**
 * El QR de la AEAT entre los codigos de la factura: primero uno valido, luego
 * uno mal formado o de pruebas, y solo si no hay ninguno de la AEAT, uno ajeno
 * (la web del proveedor, un enlace de pago...). null si no hay ninguna URL.
 */
export function leerQrDeCodigos(codigos: CodigoBarras[]): QrInterpretado | null {
  let mejor: QrInterpretado | null = null;
  for (const c of codigos) {
    if (c.kind !== 'QRCode' || typeof c.value !== 'string') continue;
    const q = interpretarValorQr(c.value);
    if (q && (!mejor || PRIORIDAD[q.estado] < PRIORIDAD[mejor.estado])) mejor = q;
  }
  return mejor;
}

const normalNumero = (s: string) => s.toUpperCase().replace(/\s+/g, '');
const sinSignos = (s: string) => normalNumero(s).replace(/[-/._]/g, '');

/** El campo confirmado por el QR: fuente 'qr' y confianza 1 (aunque Azure lo leyera con poca seguridad). */
function confirmado<T>(c: Campo<T>): Campo<T> {
  const { motivo: _motivo, ...resto } = c;
  return { ...resto, fuente: 'qr', confianza: 1 };
}

/**
 * Dato que no se leyo en la factura y se ha sacado del QR: no se ha cotejado
 * con nada, asi que va sin confianza y con motivo (queda para revisar).
 */
const sacadoDelQr = (c: Campo<unknown>): boolean => c.fuente === 'qr' && c.confianza !== 1;

/**
 * El dato sacado del QR. Si ya lo estaba (segunda comparacion, tras el
 * complemento), conserva su motivo: el de la IA, si leia otra cosa.
 */
function completado<T>(c: Campo<T>, valor: T, motivo = MOTIVO_DATO_DEL_QR): Campo<T> {
  return { ...c, valor, fuente: 'qr', confianza: null, motivo: sacadoDelQr(c) && c.motivo ? c.motivo : motivo };
}

const euros = (n: number) => n.toFixed(2);

/**
 * Compara el QR con lo leido y devuelve la lectura con `qr` y con los campos
 * que el QR confirma o completa. No modifica la lectura recibida.
 */
export function compararQr(qr: QrInterpretado | null, original: LecturaNormalizada): LecturaNormalizada {
  const l: LecturaNormalizada = structuredClone(original);
  const resultado = (r: Omit<ResultadoQr, 'diferencias'> & { diferencias?: DiferenciaQr[] }): LecturaNormalizada => {
    l.qr = { diferencias: [], ...r };
    return l;
  };

  if (!qr) return resultado({ estado: 'SIN_QR', verifactu: null, datos: null });
  if (qr.estado === 'AJENO') return resultado({ estado: 'AJENO', verifactu: null, datos: null });
  if (qr.estado === 'PRUEBAS') return resultado({ estado: 'NO_COINCIDE', verifactu: null, datos: null, pruebas: true, motivo: MOTIVO_QR_PRUEBAS });
  if (qr.estado === 'ILEGIBLE' || !qr.datos) return resultado({ estado: 'ILEGIBLE', verifactu: qr.verifactu, datos: null, motivo: MOTIVO_QR_ILEGIBLE });

  const d = qr.datos;
  const diferencias: DiferenciaQr[] = [];
  const completados: Array<DiferenciaQr['campo']> = [];

  // Lo que ya se saco del QR en una comparacion anterior se trata como no leido:
  // si no, en la segunda coincidiria consigo mismo y dejaria de contar como sacado del QR.
  // NIF del emisor (el obligado a expedir).
  const nifLeido = sacadoDelQr(l.emisor.nif) ? null : l.emisor.nif.valor;
  if (!nifLeido) {
    l.emisor.nif = completado(l.emisor.nif, d.nif);
    completados.push('nif');
  }
  else if (normalizarNif(nifLeido) === d.nif) l.emisor.nif = confirmado(l.emisor.nif);
  else diferencias.push({ campo: 'nif', enQr: d.nif, leido: nifLeido, nivel: 'error' });

  // Serie y numero.
  const numLeido = sacadoDelQr(l.numero) ? null : l.numero.valor;
  if (!numLeido) {
    l.numero = completado(l.numero, d.numserie);
    completados.push('numero');
  }
  else if (normalNumero(numLeido) === normalNumero(d.numserie) || sinSignos(numLeido) === sinSignos(d.numserie)) l.numero = confirmado(l.numero);
  else if (normalNumero(d.numserie).endsWith(normalNumero(numLeido))) diferencias.push({ campo: 'numero', enQr: d.numserie, leido: numLeido, nivel: 'revisar' });
  else diferencias.push({ campo: 'numero', enQr: d.numserie, leido: numLeido, nivel: 'error' });

  // Fecha de expedicion.
  const fechaLeida = sacadoDelQr(l.fechaEmision) ? null : l.fechaEmision.valor;
  if (!fechaLeida) {
    l.fechaEmision = completado(l.fechaEmision, d.fecha);
    completados.push('fecha');
  }
  else if (fechaLeida === d.fecha) l.fechaEmision = confirmado(l.fechaEmision);
  else diferencias.push({ campo: 'fecha', enQr: d.fecha, leido: fechaLeida, nivel: 'error' });

  // Importe: el total bruto (sin restar la retencion; no verificado en la AEAT).
  const bruto = sacadoDelQr(l.totales.totalFactura) ? null : l.totales.totalFactura.valor;
  const aPagar = sacadoDelQr(l.totales.totalAPagar) ? null : l.totales.totalAPagar.valor;
  if (bruto === null) {
    l.totales.totalFactura = completado(l.totales.totalFactura, d.importe, MOTIVO_TOTAL_DEL_QR);
    if (aPagar === null) l.totales.totalAPagar = completado(l.totales.totalAPagar, d.importe, MOTIVO_TOTAL_DEL_QR);
    completados.push('importe');
  } else if (aCentimos(bruto) === aCentimos(d.importe)) {
    l.totales.totalFactura = confirmado(l.totales.totalFactura);
  } else if (aPagar !== null && aCentimos(aPagar) === aCentimos(d.importe)) {
    diferencias.push({ campo: 'importe', enQr: euros(d.importe), leido: euros(bruto), nivel: 'revisar' });
  } else {
    diferencias.push({ campo: 'importe', enQr: euros(d.importe), leido: euros(bruto), nivel: 'error' });
  }

  return resultado({ estado: diferencias.length ? 'NO_COINCIDE' : 'COINCIDE', verifactu: qr.verifactu, datos: d, diferencias, completados });
}

const NOMBRE_DATO: Record<DiferenciaQr['campo'], string> = { nif: 'NIF', numero: 'número', fecha: 'fecha', importe: 'importe' };
const CON_ARTICULO: Record<DiferenciaQr['campo'], string> = { nif: 'el NIF', numero: 'el número', fecha: 'la fecha', importe: 'el importe' };
const ORDEN_DATOS: Array<DiferenciaQr['campo']> = ['nif', 'numero', 'fecha', 'importe'];

/** "el NIF, el número y la fecha" */
function enumerar(campos: Array<DiferenciaQr['campo']>): string {
  const t = campos.map((c) => CON_ARTICULO[c]);
  return t.length > 1 ? `${t.slice(0, -1).join(', ')} y ${t[t.length - 1]}` : t[0];
}

/** Texto de la insignia del QR en la pantalla. */
export function textoQr(qr: ResultadoQr | null): string {
  if (!qr) return 'El QR no se ha comprobado: la factura se ha leído con IA.';
  switch (qr.estado) {
    case 'COINCIDE': {
      // Solo se dice "coinciden" de lo que se ha cotejado; lo tomado del QR se dice aparte.
      const tomados = ORDEN_DATOS.filter((c) => qr.completados?.includes(c));
      const cotejados = ORDEN_DATOS.filter((c) => !tomados.includes(c));
      if (!tomados.length) return 'Los datos del QR VERI*FACTU coinciden con los leídos: NIF, número, fecha e importe.';
      const tomado = `${enumerar(tomados)} ${tomados.length > 1 ? 'se han tomado' : 'se ha tomado'} del QR`;
      if (!cotejados.length) return `No se ha podido cotejar el QR VERI*FACTU: ${tomado}.`;
      return `QR VERI*FACTU: ${enumerar(cotejados)} ${cotejados.length > 1 ? 'coinciden' : 'coincide'} con lo leído; ${tomado}.`;
    }
    case 'NO_COINCIDE':
      if (qr.motivo) return qr.motivo;
      return `El QR VERI*FACTU no coincide con la factura en: ${qr.diferencias.map((d) => NOMBRE_DATO[d.campo]).join(', ')}. Revísalo antes de registrar.`;
    case 'ILEGIBLE':
      return 'La factura tiene un QR VERI*FACTU, pero no se ha podido leer bien.';
    case 'AJENO':
      return 'La factura tiene un código QR que no es de la Agencia Tributaria; no se ha tenido en cuenta.';
    default:
      return 'Sin QR VERI*FACTU.';
  }
}
