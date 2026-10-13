/**
 * Pais leido en una factura (en la direccion del cliente o del proveedor),
 * como codigo ISO de dos letras, solo si se sabe con seguridad.
 *
 * Fichero aparte, sin dependencias del resto del lector: lo usan direccion.ts
 * (la ficha del alta) y las validaciones (de donde es el tercero) sin crear un
 * ciclo entre ellos.
 */
import { normalizarPais } from '../../domain/tipo-operacion.model';
import { esCodigoPais } from '../../utils/geografia';

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
  'republica dominicana': 'DO', 'dominican republic': 'DO',
  argentina: 'AR', chile: 'CL', colombia: 'CO', peru: 'PE', ecuador: 'EC', venezuela: 'VE', uruguay: 'UY',
  brasil: 'BR', brazil: 'BR',
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
