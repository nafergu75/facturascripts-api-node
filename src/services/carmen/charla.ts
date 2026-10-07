/**
 * Paso 3 del enrutador (reglas, sin IA): saludos, gracias, «¿qué sabes
 * hacer?» y peticiones de acción («créame una factura»), que Carmen no hace:
 * dice dónde se hacen. Y la guarda de datos propios del paso 6.
 */
import { contieneFrase } from './normalizar';

export type TipoCharla = 'saludo' | 'gracias' | 'ayuda';

export function tipoDeCharla(texto: string): TipoCharla | null {
  const t = texto.replace(/\bcarmen\b/g, '').replace(/\s+/g, ' ').trim();
  if (/^(hola|buenas|buenos dias|buenas tardes|buenas noches|hey|ey|que tal|hola que tal|saludos)$/.test(t)) return 'saludo';
  if (/^(gracias|muchas gracias|mil gracias|vale gracias|ok gracias|perfecto|perfecto gracias|genial|genial gracias|vale|ok|okey|de acuerdo|entendido)$/.test(t)) return 'gracias';
  if (/^(que sabes hacer|que puedes hacer|que te puedo preguntar|que puedo preguntarte|ayuda|ayudame|como funcionas|para que sirves|que haces|que eres|quien eres)$/.test(t)) return 'ayuda';
  return null;
}

const VERBO_ACCION =
  /^(?:(?:me |nos )?(?:puedes|podrias|quiero que|necesito que|haz el favor de)\s+)?(crea|creame|crear|crees|borra|borrame|borrar|borres|elimina|eliminar|elimines|presenta|presentame|presentar|presentes|contabiliza|contabilizar|contabilices|envia|enviame|enviar|envies|manda|mandame|mandar|mandes|emite|emiteme|emitir|emitas|aprueba|aprobar|apruebes|anula|anular|anules|registra|registrar|registres|paga|pagar|pagues|sube|subir|subas|importa|importar|importes|modifica|modificar|modifiques|da de alta|dar de alta|des de alta|hazme)\b/;

interface DestinoAccion {
  re: RegExp;
  ruta: string;
  href: string;
}

const DESTINOS: DestinoAccion[] = [
  { re: /\bproforma/, ruta: 'Ventas → Proformas', href: '/dashboard/proformas' },
  { re: /\b(gasto|gastos|compra|compras|ticket|tickets|factura de proveedor|facturas de proveedor|factura recibida)\b/, ruta: 'Compras → Compras', href: '/dashboard/compras' },
  { re: /\b(factura|facturas|rectificativa|abono|correo|email)\b/, ruta: 'Ventas → Facturas de ingreso', href: '/dashboard/facturas' },
  { re: /\basiento/, ruta: 'Contabilidad → Motor contable', href: '/dashboard/motor-contable' },
  { re: /\b(modelo|modelos|303|111|115|130|190|200|347|349|390|declaracion|impuesto|impuestos|iva)\b/, ruta: 'Fiscalidad → Modelos Fiscales', href: '/dashboard/fiscal' },
  { re: /\bcliente/, ruta: 'Ventas → Clientes', href: '/dashboard/clientes' },
  { re: /\bproveedor/, ruta: 'Compras → Proveedores', href: '/dashboard/proveedores' },
  { re: /\b(cuenta bancaria|cuentas bancarias)\b/, ruta: 'Tesorería → Cuentas bancarias', href: '/dashboard/tesoreria/cuentas' },
  { re: /\b(extracto|extractos|movimiento|movimientos|banco)\b/, ruta: 'Tesorería → Extractos', href: '/dashboard/tesoreria/extractos' },
  { re: /\bcierre/, ruta: 'Contabilidad → Cierre y traspaso de saldos', href: '/dashboard/contabilidad/cierre-ejercicio' },
];

/** Si el mensaje pide a Carmen que HAGA algo, la pantalla donde se hace (o null si no es una petición de acción). */
export function peticionDeAccion(texto: string): { destino: DestinoAccion | null } | null {
  if (!VERBO_ACCION.test(texto)) return null;
  return { destino: DESTINOS.find((d) => d.re.test(texto)) ?? null };
}

// ---------- Guarda de datos propios (paso 6) ----------

const MARCADORES_PROPIOS = [
  'mi', 'mis', 'tengo', 'tenemos', 'me debe', 'me deben', 'nos debe', 'nos deben', 'le debo', 'les debo', 'debo', 'debemos',
  'he facturado', 'hemos facturado', 'he pagado', 'hemos pagado', 'he cobrado', 'hemos cobrado', 'he gastado', 'hemos gastado',
  'he vendido', 'hemos vendido', 'cuanto llevo', 'llevamos', 'mis clientes', 'mi banco', 'mi empresa', 'nuestra', 'nuestro',
  'cobre', 'cobramos', 'pague', 'pagamos', 'facture', 'facturamos', 'gaste', 'gastamos', 'vendi', 'vendimos', 'compre', 'compramos',
  'nuestros', 'nuestras', 'me sale', 'me toca', 'me han pagado', 'nos han pagado',
];

const SUSTANTIVOS_DOMINIO = [
  'factura*', 'cliente*', 'proveedor*', 'banco*', 'cuenta*', 'saldo*', 'iva', 'asiento*', 'gasto*', 'venta*', 'cobr*', 'pag*',
  'impuesto*', 'modelo*', 'beneficio*', 'ingreso*', 'deuda*', 'dinero', 'hacienda', 'nomina*', 'trabajador*', 'empleado*', 'empresa',
  'caja', 'tesoreria', 'resultado*', 'perdida*', 'balance', 'contabilidad', 'irpf', 'retencion*', 'sueldo*', 'salario*', 'alquiler*',
  'facturado', 'gastado', 'vendido', 'cobrado', 'pagado',
];

/** «mi/mis/tengo/me debe/...» junto a un sustantivo del dominio: la pregunta es sobre sus datos. */
export function tieneMarcadoresPropios(texto: string): boolean {
  return MARCADORES_PROPIOS.some((m) => contieneFrase(texto, m)) && SUSTANTIVOS_DOMINIO.some((s) => contieneFrase(texto, s));
}
