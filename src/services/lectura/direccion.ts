/**
 * Direccion leida de una factura (del cliente o del proveedor), lista para la
 * ficha que se da de alta desde el lector: calle, codigo postal, municipio,
 * provincia y pais, cada uno en su casilla.
 *
 * El pais se da como codigo ISO de dos letras (ES, FR, PT...) solo si se sabe
 * con seguridad (Azure lo da en ISO-3, «ESP»; Claude, como venga escrito). Si
 * no, null: mejor una casilla vacia que un pais equivocado. Ni el correo ni el
 * telefono los da el lector: no se inventan.
 */
import { normalizarPais } from '../../domain/tipo-operacion.model';
import { esCodigoPais } from '../../utils/geografia';
import type { Campo, DireccionLeida } from './tipos';
import { estadoPorConfianza } from './validaciones';

/** La forma que leen las pantallas (direccionCliente en ventas, direccionProveedor en gastos). */
export interface DireccionFicha {
  calle: string | null;
  cp: string | null;
  municipio: string | null;
  provincia: string | null;
  /** ISO-2 en mayusculas, o null si no se sabe con seguridad. */
  pais: string | null;
  /** true si la direccion se ha leido con poca seguridad: hay que revisarla. */
  revisar: boolean;
}

const sinAcentos = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Nombres de pais frecuentes (en castellano, ingles y su idioma), ya sin acentos y en minusculas. */
const NOMBRES_PAIS: Readonly<Record<string, string>> = {
  espana: 'ES', spain: 'ES', espanya: 'ES', espainia: 'ES', 'reino de espana': 'ES',
  francia: 'FR', france: 'FR',
  portugal: 'PT',
  alemania: 'DE', germany: 'DE', deutschland: 'DE',
  italia: 'IT', italy: 'IT',
  'reino unido': 'GB', 'united kingdom': 'GB', 'great britain': 'GB', 'gran bretana': 'GB',
  irlanda: 'IE', ireland: 'IE',
  'paises bajos': 'NL', holanda: 'NL', netherlands: 'NL', 'the netherlands': 'NL', nederland: 'NL',
  belgica: 'BE', belgium: 'BE', belgique: 'BE', belgie: 'BE',
  luxemburgo: 'LU', luxembourg: 'LU',
  austria: 'AT', osterreich: 'AT',
  suiza: 'CH', switzerland: 'CH', suisse: 'CH', schweiz: 'CH',
  polonia: 'PL', poland: 'PL', polska: 'PL',
  suecia: 'SE', sweden: 'SE', sverige: 'SE',
  dinamarca: 'DK', denmark: 'DK', danmark: 'DK',
  finlandia: 'FI', finland: 'FI',
  noruega: 'NO', norway: 'NO', norge: 'NO',
  grecia: 'GR', greece: 'GR',
  andorra: 'AD',
  marruecos: 'MA', morocco: 'MA', maroc: 'MA',
  'estados unidos': 'US', 'united states': 'US', 'united states of america': 'US', usa: 'US', 'ee. uu.': 'US', 'ee.uu.': 'US', eeuu: 'US',
  mexico: 'MX',
  china: 'CN',
  'hong kong': 'HK',
};

/**
 * Pais leido -> ISO-2 si es seguro: un codigo ISO-2 que existe («es», «FR»),
 * un ISO-3 conocido («ESP», «FRA») o un nombre de la lista («España»,
 * «Spain», «Francia»). Cualquier otra cosa, null.
 */
export function paisIsoLeido(valor: string | null | undefined): string | null {
  const texto = String(valor ?? '').trim();
  if (!texto) return null;
  const nombre = NOMBRES_PAIS[sinAcentos(texto).toLowerCase().replace(/\s+/g, ' ')];
  if (nombre) return nombre;
  if (!/^[a-z]{2,3}$/i.test(texto)) return null;
  // EL (Grecia en el NIF-IVA) no es un codigo de pais de una direccion.
  if (texto.toUpperCase() === 'EL') return null;
  const iso = normalizarPais(texto);
  return iso.length === 2 && esCodigoPais(iso) ? iso : null;
}

const limpio = (v: string | null | undefined): string | null => {
  const t = (v ?? '').replace(/\s+/g, ' ').trim();
  return t || null;
};

/** Direccion leida (Azure o Claude) -> la de la ficha. null si no se ha leido nada que sirva. */
export function direccionParaFicha(campo: Campo<DireccionLeida> | null | undefined): DireccionFicha | null {
  const d = campo?.valor;
  if (!campo || !d) return null;
  const ficha: DireccionFicha = {
    calle: limpio(d.calle),
    cp: limpio(d.cp),
    municipio: limpio(d.municipio),
    provincia: limpio(d.provincia),
    pais: paisIsoLeido(d.pais),
    revisar: false,
  };
  if (!ficha.calle && !ficha.cp && !ficha.municipio && !ficha.provincia && !ficha.pais) return null;
  // Mismo criterio que el resto de datos leidos (poca confianza de Azure, motivo...).
  ficha.revisar = estadoPorConfianza(campo).nivel !== 'ok';
  return ficha;
}

/** De la ficha a la direccion leida (para rehacer una lectura guardada). */
export function direccionLeidaDeFicha(f: DireccionFicha | null | undefined): DireccionLeida | null {
  if (!f) return null;
  const d: DireccionLeida = {};
  if (f.calle) d.calle = f.calle;
  if (f.cp) d.cp = f.cp;
  if (f.municipio) d.municipio = f.municipio;
  if (f.provincia) d.provincia = f.provincia;
  if (f.pais) d.pais = f.pais;
  return Object.keys(d).length ? d : null;
}
