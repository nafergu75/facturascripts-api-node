/**
 * Calculos puros de las nominas: cuadre, cuentas y asiento. Sin base de datos.
 *
 * Cuadre de una nomina (en centimos):
 *   devengado = bruto dinerario + dietas exentas + indemnizaciones + especie
 *   deducido  = SS trabajador + IRPF + ingreso a cuenta repercutido + especie
 *               + anticipos + embargos + otras deducciones
 *   liquido   = devengado - deducido
 * La especie suma en los devengos y resta en las deducciones (el trabajador la
 * recibe en bienes o servicios, no en dinero), asi que no cambia el liquido.
 * Se admite 1 centimo de diferencia por redondeos de la gestoria; en el asiento
 * ese centimo va a la 640 para que cuadre sin tocar el liquido, el IRPF ni la SS.
 *
 * Asiento de cada nomina (fecha: ultimo dia del mes de devengo):
 *   Debe  640 bruto dinerario (+ dietas si no van a la 629, + ingreso a cuenta no repercutido)
 *   Debe  629 dietas exentas (si asi se configura)
 *   Debe  641 indemnizaciones
 *   Debe  642 Seguridad Social a cargo de la empresa
 *   Haber 476 SS trabajador + SS empresa
 *   Haber 4751 (subcuenta de trabajo) IRPF + ingreso a cuenta
 *   Haber 460 anticipos
 *   Haber 465 de embargos
 *   Haber subcuenta de otras deducciones
 *   Haber 465 del trabajador: liquido
 * La especie no es gasto en este asiento: su coste entra con la factura del
 * proveedor (649 contra 400/572). Aqui solo aparece su ingreso a cuenta.
 */
import type { AsientoContableGenerado, LineaAsiento } from '../../domain/asiento.model';
import type { CuadreNomina, CuentasNominas, ImportesNomina } from '../../domain/nominas.model';
import { aCentimos } from '../../utils/money';
import { badRequest } from '../../utils/http-errors';

export const TOLERANCIA_CENTIMOS = 1;

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const euros = (centimos: number): number => round2(centimos / 100);

/** Importe en euros con dos decimales y coma, para mensajes. */
export const fmtEuros = (n: number): string =>
  `${n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

export function cuadreNomina(n: ImportesNomina): CuadreNomina {
  const c = (v: number) => aCentimos(v || 0);
  const devengado = c(n.brutoDinerario) + c(n.dietasExentas) + c(n.indemnizacionExenta) + c(n.indemnizacionSujeta) + c(n.especieValoracion);
  const deducido =
    c(n.ssTrabajador) +
    c(n.irpf) +
    (n.ingresoACuentaRepercutido ? c(n.ingresoACuenta) : 0) +
    c(n.especieValoracion) +
    c(n.anticipos) +
    c(n.embargos) +
    c(n.otrasDeducciones);
  const liquidoCalculado = devengado - deducido;
  const diferencia = c(n.liquido) - liquidoCalculado;
  const costeEmpresa =
    c(n.brutoDinerario) +
    c(n.dietasExentas) +
    c(n.indemnizacionExenta) +
    c(n.indemnizacionSujeta) +
    c(n.ssEmpresa) +
    (n.ingresoACuentaRepercutido ? 0 : c(n.ingresoACuenta));
  return {
    devengado: euros(devengado),
    deducido: euros(deducido),
    liquidoCalculado: euros(liquidoCalculado),
    diferencia: euros(diferencia),
    cuadra: Math.abs(diferencia) <= TOLERANCIA_CENTIMOS,
    costeEmpresa: euros(costeEmpresa),
  };
}

/** Mensaje de descuadre, o null si la nomina cuadra. */
export function mensajeDescuadre(n: ImportesNomina): string | null {
  const q = cuadreNomina(n);
  if (q.cuadra) return null;
  return (
    `La nómina no cuadra: el líquido es ${fmtEuros(n.liquido)} y devengado menos deducciones da ${fmtEuros(q.liquidoCalculado)} ` +
    `(diferencia de ${fmtEuros(q.diferencia)}).`
  );
}

/** Ultimo dia del mes (YYYY-MM-DD). */
export function ultimoDiaMes(ejercicio: number, mes: number): string {
  return new Date(Date.UTC(ejercicio, mes, 0)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Cuentas
// ---------------------------------------------------------------------------

/** Longitud de codigo con la que se generan las subcuentas (entre 6 y 10). */
export function longitudValida(longitud: number | null | undefined): number {
  const n = Math.round(Number(longitud));
  if (!Number.isFinite(n)) return 6;
  return Math.min(10, Math.max(6, n));
}

/**
 * Longitud mas habitual entre los codigos del plan/diario de la empresa (solo
 * los de 4 o mas digitos: los de 3 son cuentas genericas). Sin datos, 6, que es
 * la de las reglas contables por defecto (700000, 430000, 475100...).
 */
export function longitudMasHabitual(codigos: Iterable<string>): number {
  const cuenta = new Map<number, number>();
  for (const c of codigos) {
    if (!/^\d{4,10}$/.test(c)) continue;
    cuenta.set(c.length, (cuenta.get(c.length) ?? 0) + 1);
  }
  let mejor = 6;
  let veces = 0;
  for (const [largo, n] of cuenta) {
    if (n > veces || (n === veces && largo > mejor)) {
      mejor = largo;
      veces = n;
    }
  }
  return longitudValida(mejor);
}

const relleno = (base: string, longitud: number) => base.padEnd(longitud, '0');

/** Subcuentas por defecto para una longitud de codigo. */
export function cuentasNominasPorDefecto(longitudEntrada: number): CuentasNominas {
  const l = longitudValida(longitudEntrada);
  const sueldos = relleno('640', l);
  return {
    sueldos,
    indemnizaciones: relleno('641', l),
    ssEmpresa: relleno('642', l),
    otrosGastosSociales: relleno('649', l),
    ssAcreedora: relleno('476', l),
    // 4751 + ...1: la de profesionales es la 4751 + ...0 (475100 en las reglas por defecto).
    irpfTrabajo: `4751${'1'.padStart(l - 4, '0')}`,
    remuneracionesPendientes: relleno('465', l),
    embargos: `465${'9'.repeat(l - 3)}`,
    anticipos: relleno('460', l),
    otrasDeducciones: `465${'9'.repeat(l - 4)}8`,
    dietas: sueldos,
    ssDeudoraIt: relleno('471', l),
    caja: relleno('570', l),
  };
}

/** Cuentas configuradas en las reglas (validas) sobre las de por defecto. */
export function resolverCuentasNominas(configuradas: Partial<CuentasNominas> | undefined | null, longitud: number): CuentasNominas {
  const def = cuentasNominasPorDefecto(longitud);
  const out = { ...def };
  for (const k of Object.keys(def) as Array<keyof CuentasNominas>) {
    const v = configuradas?.[k];
    if (typeof v === 'string' && /^\d{3,10}$/.test(v.trim())) out[k] = v.trim();
  }
  return out;
}

/** Codigos reservados de la 465 (no se dan a ningun trabajador). */
export function reservadas465(cuentas: CuentasNominas): Set<string> {
  return new Set([cuentas.remuneracionesPendientes, cuentas.embargos, cuentas.otrasDeducciones]);
}

/**
 * Siguiente subcuenta 465 libre para un trabajador: 465 + correlativo con la
 * longitud del plan (4650001...). `ocupadas`: codigos ya usados.
 */
export function siguienteSubcuenta465(ocupadas: Iterable<string>, longitudEntrada: number, cuentas: CuentasNominas): string {
  const l = longitudValida(longitudEntrada);
  const usadas = new Set(ocupadas);
  for (const r of reservadas465(cuentas)) usadas.add(r);
  let max = 0;
  for (const c of usadas) {
    if (c.length !== l || !c.startsWith('465')) continue;
    const n = Number(c.slice(3));
    // Los correlativos altos (9998, 9999...) son de embargos y otras deducciones.
    if (Number.isInteger(n) && n > max && n < 10 ** (l - 3) - 10) max = n;
  }
  for (let n = max + 1; n < 10 ** (l - 3); n++) {
    const codigo = `465${String(n).padStart(l - 3, '0')}`;
    if (!usadas.has(codigo)) return codigo;
  }
  throw badRequest('No quedan subcuentas 465 libres para dar de alta más trabajadores.');
}

/** Nombres de las subcuentas (para el plan y para los apuntes). */
export const NOMBRES_CUENTAS: Record<keyof CuentasNominas, string> = {
  sueldos: 'Sueldos y salarios',
  indemnizaciones: 'Indemnizaciones',
  ssEmpresa: 'Seguridad Social a cargo de la empresa',
  otrosGastosSociales: 'Otros gastos sociales',
  ssAcreedora: 'Organismos de la Seguridad Social, acreedores',
  irpfTrabajo: 'HP acreedora por retenciones del trabajo',
  remuneracionesPendientes: 'Remuneraciones pendientes de pago',
  embargos: 'Embargos de nóminas pendientes de pago',
  anticipos: 'Anticipos de remuneraciones',
  otrasDeducciones: 'Otras deducciones de nóminas',
  dietas: 'Dietas',
  ssDeudoraIt: 'Organismos de la Seguridad Social, deudores',
  caja: 'Caja, euros',
};

// ---------------------------------------------------------------------------
// Asiento
// ---------------------------------------------------------------------------

export interface DatosAsientoNomina extends ImportesNomina {
  ejercicio: number;
  mes: number;
  tipo: string;
  fechaDevengo: string;
}

export interface TrabajadorAsiento {
  nombreCompleto: string;
  nif: string;
  subcuenta465: string;
}

const TIPO_TEXTO: Record<string, string> = {
  ORDINARIA: 'Nómina',
  EXTRA: 'Paga extra',
  ATRASOS: 'Atrasos',
  FINIQUITO: 'Finiquito',
  COMPLEMENTARIA: 'Nómina complementaria',
};

export function conceptoAsientoNomina(n: { mes: number; ejercicio: number; tipo: string }, nombre: string): string {
  return `${TIPO_TEXTO[n.tipo] ?? 'Nómina'} ${String(n.mes).padStart(2, '0')}/${n.ejercicio} - ${nombre}`;
}

/**
 * Asiento de devengo de una nomina (puro). Comprueba que debe = haber al
 * centimo y que la nomina cuadra (con 1 centimo de tolerancia).
 */
export function generarAsientoNomina(n: DatosAsientoNomina, cuentas: CuentasNominas, trabajador: TrabajadorAsiento): AsientoContableGenerado {
  const q = cuadreNomina(n);
  if (!q.cuadra) throw badRequest(`${trabajador.nombreCompleto}: ${mensajeDescuadre(n)}`);
  const c = (v: number) => aCentimos(v || 0);

  // Debe y haber en centimos por cuenta (una cuenta puede recibir varios importes).
  const debe = new Map<string, number>();
  const haber = new Map<string, number>();
  const nombres = new Map<string, string>();
  const sumar = (m: Map<string, number>, cuenta: string, nombre: string, centimos: number) => {
    if (!centimos) return;
    m.set(cuenta, (m.get(cuenta) ?? 0) + centimos);
    if (!nombres.has(cuenta)) nombres.set(cuenta, nombre);
  };

  const iacNoRepercutido = n.ingresoACuentaRepercutido ? 0 : c(n.ingresoACuenta);
  // El centimo de redondeo (si lo hay) va a la 640: el liquido es lo que se paga.
  sumar(debe, cuentas.sueldos, NOMBRES_CUENTAS.sueldos, c(n.brutoDinerario) + iacNoRepercutido + aCentimos(q.diferencia));
  sumar(debe, cuentas.dietas, cuentas.dietas === cuentas.sueldos ? NOMBRES_CUENTAS.sueldos : NOMBRES_CUENTAS.dietas, c(n.dietasExentas));
  sumar(debe, cuentas.indemnizaciones, NOMBRES_CUENTAS.indemnizaciones, c(n.indemnizacionExenta) + c(n.indemnizacionSujeta));
  sumar(debe, cuentas.ssEmpresa, NOMBRES_CUENTAS.ssEmpresa, c(n.ssEmpresa));

  sumar(haber, cuentas.ssAcreedora, NOMBRES_CUENTAS.ssAcreedora, c(n.ssTrabajador) + c(n.ssEmpresa));
  sumar(haber, cuentas.irpfTrabajo, NOMBRES_CUENTAS.irpfTrabajo, c(n.irpf) + c(n.ingresoACuenta));
  sumar(haber, cuentas.anticipos, NOMBRES_CUENTAS.anticipos, c(n.anticipos));
  sumar(haber, cuentas.embargos, NOMBRES_CUENTAS.embargos, c(n.embargos));
  sumar(haber, cuentas.otrasDeducciones, NOMBRES_CUENTAS.otrasDeducciones, c(n.otrasDeducciones));
  sumar(haber, trabajador.subcuenta465, trabajador.nombreCompleto, c(n.liquido));

  const lineas: LineaAsiento[] = [];
  for (const [cuenta, cent] of debe) {
    if (cent < 0) throw badRequest(`${trabajador.nombreCompleto}: el importe de la cuenta ${cuenta} sale negativo.`);
    lineas.push({ subcuenta: cuenta, debe: euros(cent), haber: 0, concepto: nombres.get(cuenta)! });
  }
  for (const [cuenta, cent] of haber) {
    lineas.push({ subcuenta: cuenta, debe: 0, haber: euros(cent), concepto: nombres.get(cuenta)! });
  }
  const totalDebe = [...debe.values()].reduce((a, b) => a + b, 0);
  const totalHaber = [...haber.values()].reduce((a, b) => a + b, 0);
  if (totalDebe !== totalHaber) {
    throw badRequest(`${trabajador.nombreCompleto}: el asiento no cuadra (Debe ${fmtEuros(euros(totalDebe))}, Haber ${fmtEuros(euros(totalHaber))}).`);
  }
  if (totalDebe === 0) throw badRequest(`${trabajador.nombreCompleto}: la nómina no tiene importes.`);

  return {
    fecha: n.fechaDevengo,
    descripcion: conceptoAsientoNomina(n, trabajador.nombreCompleto),
    lineas,
    debeTotal: euros(totalDebe),
    haberTotal: euros(totalHaber),
  };
}
