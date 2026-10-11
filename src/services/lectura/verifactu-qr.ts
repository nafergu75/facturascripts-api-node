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

/** El primer QR (kind QRCode) que sea una URL. null si no hay ninguno. */
export function leerQrDeCodigos(codigos: CodigoBarras[]): QrInterpretado | null {
  for (const c of codigos) {
    if (c.kind !== 'QRCode' || typeof c.value !== 'string') continue;
    const q = interpretarValorQr(c.value);
    if (q) return q;
  }
  return null;
}

const normalNumero = (s: string) => s.toUpperCase().replace(/\s+/g, '');
const sinSignos = (s: string) => normalNumero(s).replace(/[-/._]/g, '');

/** El campo confirmado por el QR: fuente 'qr' y confianza 1 (aunque Azure lo leyera con poca seguridad). */
function confirmado<T>(c: Campo<T>, valor?: T): Campo<T> {
  const { motivo: _motivo, ...resto } = c;
  return { ...resto, valor: valor !== undefined ? valor : c.valor, fuente: 'qr', confianza: 1 };
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
  if (qr.estado === 'PRUEBAS') return resultado({ estado: 'NO_COINCIDE', verifactu: null, datos: null, motivo: MOTIVO_QR_PRUEBAS });
  if (qr.estado === 'ILEGIBLE' || !qr.datos) return resultado({ estado: 'ILEGIBLE', verifactu: qr.verifactu, datos: null, motivo: MOTIVO_QR_ILEGIBLE });

  const d = qr.datos;
  const diferencias: DiferenciaQr[] = [];

  // NIF del emisor (el obligado a expedir).
  const nifLeido = l.emisor.nif.valor;
  if (!nifLeido) l.emisor.nif = confirmado(l.emisor.nif, d.nif);
  else if (normalizarNif(nifLeido) === d.nif) l.emisor.nif = confirmado(l.emisor.nif);
  else diferencias.push({ campo: 'nif', enQr: d.nif, leido: nifLeido, nivel: 'error' });

  // Serie y numero.
  const numLeido = l.numero.valor;
  if (!numLeido) l.numero = confirmado(l.numero, d.numserie);
  else if (normalNumero(numLeido) === normalNumero(d.numserie) || sinSignos(numLeido) === sinSignos(d.numserie)) l.numero = confirmado(l.numero);
  else if (normalNumero(d.numserie).endsWith(normalNumero(numLeido))) diferencias.push({ campo: 'numero', enQr: d.numserie, leido: numLeido, nivel: 'revisar' });
  else diferencias.push({ campo: 'numero', enQr: d.numserie, leido: numLeido, nivel: 'error' });

  // Fecha de expedicion.
  const fechaLeida = l.fechaEmision.valor;
  if (!fechaLeida) l.fechaEmision = confirmado(l.fechaEmision, d.fecha);
  else if (fechaLeida === d.fecha) l.fechaEmision = confirmado(l.fechaEmision);
  else diferencias.push({ campo: 'fecha', enQr: d.fecha, leido: fechaLeida, nivel: 'error' });

  // Importe: el total bruto (sin restar la retencion; no verificado en la AEAT).
  const bruto = l.totales.totalFactura.valor;
  const aPagar = l.totales.totalAPagar.valor;
  if (bruto === null) {
    l.totales.totalFactura = { valor: d.importe, confianza: null, fuente: 'qr', motivo: MOTIVO_TOTAL_DEL_QR };
    if (aPagar === null) l.totales.totalAPagar = { valor: d.importe, confianza: null, fuente: 'qr', motivo: MOTIVO_TOTAL_DEL_QR };
  } else if (aCentimos(bruto) === aCentimos(d.importe)) {
    l.totales.totalFactura = confirmado(l.totales.totalFactura);
  } else if (aPagar !== null && aCentimos(aPagar) === aCentimos(d.importe)) {
    diferencias.push({ campo: 'importe', enQr: euros(d.importe), leido: euros(bruto), nivel: 'revisar' });
  } else {
    diferencias.push({ campo: 'importe', enQr: euros(d.importe), leido: euros(bruto), nivel: 'error' });
  }

  return resultado({ estado: diferencias.length ? 'NO_COINCIDE' : 'COINCIDE', verifactu: qr.verifactu, datos: d, diferencias });
}

const NOMBRE_DATO: Record<DiferenciaQr['campo'], string> = { nif: 'NIF', numero: 'número', fecha: 'fecha', importe: 'importe' };

/** Texto de la insignia del QR en la pantalla. */
export function textoQr(qr: ResultadoQr | null): string {
  if (!qr) return 'El QR no se ha comprobado: la factura se ha leído con IA.';
  switch (qr.estado) {
    case 'COINCIDE':
      return 'QR VERI*FACTU comprobado: el NIF, el número, la fecha y el importe coinciden con la factura.';
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
