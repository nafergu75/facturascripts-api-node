/**
 * Titulos de columna que usan los programas de las gestorias, normalizados
 * (minusculas, sin tildes ni signos: «Nº Asiento» -> «n asiento»), y el dato
 * que lleva cada columna. Sirve para clasificar las hojas y para leer las que
 * no lee el lector de la puesta en marcha (cartera, terceros, inmovilizado).
 *
 * El orden importa: los titulos mas concretos van antes («importe pendiente»
 * antes que «importe», «fecha vencimiento» antes que «fecha»).
 */
import { normalizarTitulo } from '../puestaEnMarcha/lectorContable';

export type Campo =
  | 'cuenta'
  | 'nombre'
  | 'nif'
  | 'debe'
  | 'haber'
  | 'saldoDeudor'
  | 'saldoAcreedor'
  | 'saldo'
  | 'saldoAnterior'
  | 'pesetas'
  | 'fecha'
  | 'asiento'
  | 'concepto'
  | 'importe'
  | 'signo'
  | 'contrapartida'
  | 'documento'
  | 'vencimiento'
  | 'pendiente'
  | 'importeOriginal'
  | 'moneda'
  | 'tipoTercero'
  | 'direccion'
  | 'cp'
  | 'municipio'
  | 'provincia'
  | 'pais'
  | 'email'
  | 'telefono'
  | 'web'
  | 'coste'
  | 'amortAcumulada'
  | 'coeficiente'
  | 'vidaUtil'
  | 'fechaAlta'
  | 'fechaInicioAmort'
  | 'valorResidual'
  | 'cuentaAmortAcum'
  | 'cuentaDotacion';

export const PATRONES_CAMPOS: Array<[Campo, RegExp]> = [
  // Importes antiguos en pesetas de ContaPlus: se reconocen para no tomarlos por euros.
  ['pesetas', /^(pta|ptas|pts|pesetas)(debe|haber|saldo)$|^(debe|haber|saldo) (pesetas|ptas|pts)$|^ptadebe$|^ptahaber$/],
  ['saldoAnterior', /^saldo (anterior|inicial|apertura|de apertura|a 1 1)$|^saldoant$/],
  ['saldoDeudor', /^(saldos? )?deudor(es)?( euros)?$|^saldo deudor/],
  ['saldoAcreedor', /^(saldos? )?acreedor(es)?( euros)?$|^saldo acreedor/],
  ['pendiente', /^(importe |imp |saldo )?pendiente( de (cobro|pago))?$|^pdte$|^importe pdte$|^por (cobrar|pagar)$|^resto$/],
  ['importeOriginal', /^(importe|total) (original|factura|documento|efecto|inicial)$|^total$|^importe total$/],
  ['vencimiento', /^(fecha (de )?)?(vencimiento|vto)$|^f vto$|^f vencimiento$|^vto$|^vencim$/],
  ['fechaInicioAmort', /^(fecha )?inicio (de la )?amortizacion$|^f inicio amort/],
  ['fechaAlta', /^fecha (de )?(alta|adquisicion|compra|puesta en (marcha|funcionamiento))$|^f alta$|^f adquisicion$/],
  ['amortAcumulada', /^(amortizacion|amort|a) (acumulada|acum)( a 31 12( 2026)?)?$|^amort acum$|^amortizado$|^acumulada$/],
  ['valorResidual', /^valor residual$|^residual$/],
  ['coste', /^(coste|costo|valor|precio|importe) (de )?(adquisicion|compra|inicial)$|^coste$|^valor bruto$|^valor de adquisicion$/],
  // «% Amort.» queda en «amort» al normalizar; «Porc. amort.», en «porc amort».
  ['coeficiente', /^(coeficiente|coef|porcentaje|porc|pct)( de)?( amortizacion| amort| amortiz)?$|^tipo (de )?amortizacion$|^amortizacion$|^amort$|^amortiz$|^tasa$/],
  ['vidaUtil', /^vida util( anos)?$|^anos( de vida)?$|^vida$/],
  ['cuentaAmortAcum', /^(cuenta|cta|subcuenta) (de )?(amortizacion acumulada|amort acum|amortizacion)$/],
  ['cuentaDotacion', /^(cuenta|cta|subcuenta) (de )?(dotacion|gasto)$/],
  ['debe', /^(sumas? |total |acumulado |movimientos? |importe )?(debe|cargos?|debit)( acumulado| periodo| ejercicio| euros)?$|^eurodebe$|^euro debe$/],
  ['haber', /^(sumas? |total |acumulado |movimientos? |importe )?(haber|abonos?|credit)( acumulado| periodo| ejercicio| euros)?$|^eurohaber$|^euro haber$/],
  ['saldo', /^(saldo|saldo final|saldo actual|saldo cierre|saldo al cierre|saldo a fecha.*|saldo a 31 12.*|saldo periodo|saldo ejercicio|importe saldo|balance|saldo total|eurosaldo)$/],
  ['contrapartida', /^(contrapartida|contra|contrap|cta contrapartida)$/],
  ['nif', /^(nif|cif|nif cif|cif nif|dni|nie|nif iva|vat|tax id|n i f|c i f|identificacion fiscal|nif dni)$/],
  ['cuenta', /^(cuenta|subcuenta|subcta|cod|codigo|cta|n cuenta|num cuenta|numero cuenta|codigo cuenta|cod cuenta|codigo subcuenta|cod subcuenta|codsubcuenta|codigo contable|cuenta contable|account|code|cuenta del bien|cuenta activo)$/],
  ['documento', /^(documento|n documento|num documento|n factura|num factura|numero factura|factura|n fra|fra|efecto|n efecto|referencia|n doc|doc)$/],
  ['fecha', /^(fecha|f asiento|fecha asiento|fecha apunte|fecha contable|fecha factura|fecha documento|f factura|f emision|fecha emision|date)$/],
  ['asiento', /^(asiento|n asiento|num asiento|numero asiento|n asto|asto|n de asiento|asien|entry|id asiento|asiento n)$/],
  ['concepto', /^(concepto|detalle|texto|glosa|comentario|concepto apunte)$/],
  ['nombre', /^(descripcion|nombre|titulo|denominacion|nombre cuenta|descripcion cuenta|nombre subcuenta|descripcion subcuenta|titulo cuenta|titulo de la cuenta|description|name|razon social|nombre fiscal|cliente|proveedor|acreedor|tercero|elemento|bien|descripcion del bien)$/],
  ['importe', /^(importe|importe apunte|amount|valor)$/],
  ['signo', /^(d h|dh|signo|debe haber|lado)$/],
  ['moneda', /^(moneda|divisa|currency)$/],
  ['tipoTercero', /^(tipo|tipo tercero|clase)$/],
  ['direccion', /^(domicilio|direccion|direccion fiscal|calle|domicilio fiscal)$/],
  ['cp', /^(cp|c p|codigo postal|cod postal|codpostal|cod post)$/],
  ['municipio', /^(poblacion|municipio|localidad|ciudad)$/],
  ['provincia', /^provincia$/],
  ['pais', /^(pais|cod pais|codigo pais)$/],
  ['email', /^(email|e mail|correo|correo electronico|mail)$/],
  ['telefono', /^(telefono|tel|tlf|tfno|movil|telefono 1)$/],
  ['web', /^(web|www|url|pagina web|sitio web|website|web site|direccion web|pagina de internet)$/],
];

/** Dato que lleva una columna por su titulo, o null. */
export function campoDeTitulo(titulo: unknown): Campo | null {
  const t = normalizarTitulo(titulo);
  if (!t) return null;
  for (const [campo, re] of PATRONES_CAMPOS) if (re.test(t)) return campo;
  return null;
}

export interface CabeceraDetectada {
  /** Indice (0-based) de la fila de titulos. */
  fila: number;
  titulos: string[];
  /** Columna de cada dato (la primera que lo tiene). */
  campos: Partial<Record<Campo, number>>;
}

/**
 * Titulos que encajan con un dato pero de forma dudosa: si en la misma fila hay
 * otra columna con un titulo claro para ese dato, manda la clara. En un
 * listado de inmovilizado o de cartera, «Código» suele ser el numero del bien
 * o del cliente, y la cuenta va en «Cuenta».
 */
const TITULOS_DUDOSOS: Partial<Record<Campo, RegExp>> = {
  cuenta: /^(cod|codigo|code)$/,
};

/**
 * Fila de titulos: la de las 40 primeras con mas datos reconocidos (al menos
 * dos distintos). null si no hay ninguna (fichero sin titulos).
 */
export function detectarCabecera(filas: unknown[][]): CabeceraDetectada | null {
  let mejor: (CabeceraDetectada & { n: number }) | null = null;
  for (let i = 0; i < Math.min(filas.length, 40); i++) {
    const fila = filas[i] ?? [];
    const campos: Partial<Record<Campo, number>> = {};
    const dudosos = new Set<Campo>();
    fila.forEach((celda, j) => {
      const c = campoDeTitulo(celda);
      if (!c) return;
      const dudoso = !!TITULOS_DUDOSOS[c]?.test(normalizarTitulo(celda));
      if (campos[c] === undefined || (dudosos.has(c) && !dudoso)) {
        campos[c] = j;
        if (dudoso) dudosos.add(c);
        else dudosos.delete(c);
      }
    });
    const n = Object.keys(campos).length;
    if (n >= 2 && (!mejor || n > mejor.n)) mejor = { fila: i, titulos: fila.map(normalizarTitulo), campos, n };
  }
  if (!mejor) return null;
  const { n: _n, ...cab } = mejor;
  return cab;
}

/** Mapeo a mano que llega del cliente: indices enteros por dato conocido. */
export function limpiarMapeoCampos(mapeo: unknown): Partial<Record<Campo, number>> | null {
  if (!mapeo || typeof mapeo !== 'object') return null;
  const conocidos = new Set(PATRONES_CAMPOS.map(([c]) => c));
  const out: Partial<Record<Campo, number>> = {};
  for (const [k, v] of Object.entries(mapeo as Record<string, unknown>)) {
    if (!conocidos.has(k as Campo) || v === null || v === undefined || v === '') continue;
    const n = Number(v);
    if (Number.isInteger(n) && n >= 0 && n < 200) out[k as Campo] = n;
  }
  return Object.keys(out).length ? out : null;
}
