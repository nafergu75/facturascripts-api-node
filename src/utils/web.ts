/**
 * Web de un cliente o de un proveedor.
 *
 * Se guarda sin espacios (tampoco los invisibles que se cuelan al pegar) y con
 * http:// o https:// delante (si no lo lleva, se le pone https://). Solo se
 * aceptan dominios razonables: www.empresa.com, empresa.es/tienda,
 * https://tienda.empresa.com... Un texto que no lo sea
 * (una palabra suelta, un correo, una IP, otro protocolo) da un motivo claro.
 * Vacio = sin web.
 */

/** Largo maximo de la columna `web` (VARCHAR(255)). */
export const LARGO_MAXIMO_WEB = 255;

/** Ejemplo que se cita en los mensajes. */
const EJEMPLO = 'www.empresa.com';

export type ResultadoWeb = { ok: true; web: string | null } | { ok: false; motivo: string };

const ESQUEMA_HTTP = /^(https?):\/\//i;
/** El http(s):// mal escrito: «https//», «https:/», «http:www...». */
const ESQUEMA_MAL_ESCRITO = /^https?(?::\/?|\/\/?)(?!\/)/i;
/**
 * Espacios y caracteres invisibles que se pegan desde paginas o documentos
 * (espacio de ancho cero, guion invisible, marcas de direccion, BOM...): \s no
 * los cubre todos y se guardarian dentro de la web.
 */
const ESPACIOS_E_INVISIBLES = /[\s\u00ad\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]+/g;
/** Una IP (el navegador ya pasa a esta forma 3232235786 o 0xC0.168.1.10) o una IPv6 entre corchetes. */
const IP = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i;
/** Otro protocolo delante (ftp://, mailto:, javascript:...). «empresa.com:8080» no cuenta: tras los dos puntos va el puerto. */
const OTRO_ESQUEMA = /^[a-z][a-z0-9+.-]*:(?!\d)/i;
/** Caracteres que una direccion web no puede llevar tal cual. */
const CARACTER_PROHIBIDO = /["<>\\^`{|}\u0000-\u001f\u007f]/;
/** Cada parte del dominio (ya en ASCII): letras, cifras y guiones, sin guion al principio ni al final. */
const ETIQUETA = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Terminacion del dominio: letras (.com, .es, .info) o la forma ASCII de una con acentos (xn--...). */
const TERMINACION = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

const mal = (motivo: string): ResultadoWeb => ({ ok: false, motivo });
const COMO = `Escríbela como ${EJEMPLO} o https://${EJEMPLO.slice(4)}.`;
const NO_VALIDA = `La web no es válida. ${COMO}`;

/**
 * Normaliza la web que llega en el cuerpo. `undefined`, `null` o un texto en
 * blanco: sin web (null). Si no es valida, `ok: false` con el motivo, escrito
 * para la persona.
 */
export function normalizarWeb(valor: unknown): ResultadoWeb {
  if (valor === undefined || valor === null) return { ok: true, web: null };
  if (typeof valor !== 'string') return mal(NO_VALIDA);
  // Sin espacios: ni delante, ni detras, ni en medio («www.empresa .com»), ni invisibles.
  const limpio = valor.replace(ESPACIOS_E_INVISIBLES, '');
  if (!limpio) return { ok: true, web: null };
  if (CARACTER_PROHIBIDO.test(limpio)) return mal(`La web lleva caracteres que no puede tener (comillas, < >, llaves...). ${COMO}`);

  let esquema = 'https';
  let resto = limpio;
  const http = ESQUEMA_HTTP.exec(limpio);
  if (http) {
    esquema = http[1].toLowerCase();
    resto = limpio.slice(http[0].length);
  } else if (limpio.startsWith('//')) {
    resto = limpio.slice(2);
  } else if (ESQUEMA_MAL_ESCRITO.test(limpio)) {
    return mal(`El principio de la web está mal escrito: tiene que ser https:// (con los dos puntos y las dos barras), o escríbela sin nada delante: ${EJEMPLO}.`);
  } else if (/^mailto:/i.test(limpio)) {
    return mal(`Eso es un correo electrónico: va en el campo del email. En la web va la dirección de la página, por ejemplo ${EJEMPLO}.`);
  } else if (OTRO_ESQUEMA.test(limpio)) {
    return mal(`La web tiene que empezar por http:// o https://, o escríbela sin nada delante: ${EJEMPLO}.`);
  }
  if (!resto) return mal(NO_VALIDA);

  const web = `${esquema}://${resto}`;
  if (web.length > LARGO_MAXIMO_WEB) {
    // Cuenta el https:// que se le pone delante si no lo lleva.
    return mal(`La web es demasiado larga: con el ${esquema}:// delante, ${LARGO_MAXIMO_WEB} caracteres como mucho.`);
  }

  let url: URL;
  try {
    url = new URL(web);
  } catch {
    return mal(NO_VALIDA);
  }
  if (url.username || url.password) {
    // «info@empresa.com»: sin protocolo, el navegador lo tomaria por un usuario y una web.
    return !http && !resto.includes('/')
      ? mal(`Eso parece un correo electrónico: va en el campo del email. En la web va la dirección de la página, por ejemplo ${EJEMPLO}.`)
      : mal(`La web no puede llevar usuario ni contraseña. ${COMO}`);
  }

  // El navegador ya la pasa a minusculas y a ASCII (ñ y acentos, en xn--).
  const host = url.hostname.replace(/\.$/, '');
  if (IP.test(host)) return mal(`Una dirección IP no vale como web: escribe el nombre de la página, por ejemplo ${EJEMPLO}.`);
  const partes = host.split('.');
  if (host.length > 253 || !partes.every((p) => ETIQUETA.test(p))) return mal(NO_VALIDA);
  if (partes.length < 2) return mal(`Falta la terminación de la web (.com, .es...). Escríbela completa, por ejemplo ${EJEMPLO}.`);
  if (!TERMINACION.test(partes[partes.length - 1])) return mal(NO_VALIDA);

  return { ok: true, web };
}
