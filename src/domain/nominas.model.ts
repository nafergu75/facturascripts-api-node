/**
 * Nominas: la gestoria las calcula y la app las registra, valida su cuadre y
 * las contabiliza (un asiento por nomina, con la subcuenta 465 propia de cada
 * trabajador). Ver docs del modulo en services/nominas.service.ts.
 */

/** Resumen mensual por mes de devengo (GET /nominas/resumen). El 111 y el 190 van por fecha de pago (services/nominas/fiscal.ts). */
export interface NominaResumen {
  id: string;
  companyId: string;
  mes: number;
  ejercicio: number;
  totalBruto: number;
  totalSeguridadSocialEmpresa: number;
  totalSeguridadSocialTrabajador: number;
  totalIRPF: number;
  totalLiquido: number;
  /** 'nominas': calculado con las nominas por trabajador; 'resumen': fila antigua solo con totales. */
  origen?: 'nominas' | 'resumen';
  /** Trabajadores distintos del mes (solo con origen 'nominas'). */
  perceptores?: number;
  /** Resumenes antiguos grabados para el mes, si hay mas de uno (solo cuenta el ultimo). */
  resumenesGrabados?: number;
}

export const TIPOS_NOMINA = ['ORDINARIA', 'EXTRA', 'ATRASOS', 'FINIQUITO', 'COMPLEMENTARIA'] as const;
export type TipoNomina = (typeof TIPOS_NOMINA)[number];

export const ESTADOS_NOMINA = ['BORRADOR', 'CONTABILIZADA', 'PAGADA', 'ANULADA'] as const;
export type EstadoNomina = (typeof ESTADOS_NOMINA)[number];
/** Estados con asiento de devengo (contabilizada, y ademas pagada o no). */
export const ESTADOS_CONTABILIZADOS: readonly string[] = ['CONTABILIZADA', 'PAGADA'];

export const TIPOS_CONTRATO = ['INDEFINIDO', 'TEMPORAL', 'FIJO_DISCONTINUO', 'FORMACION', 'OTRO'] as const;
export type TipoContrato = (typeof TIPOS_CONTRATO)[number];

/** Importes de una nomina (euros, >= 0, dos decimales). */
export interface ImportesNomina {
  /** Retribuciones dinerarias sujetas a retencion. */
  brutoDinerario: number;
  dietasExentas: number;
  /** Valoracion de la retribucion en especie. */
  especieValoracion: number;
  /** Ingreso a cuenta de la especie. */
  ingresoACuenta: number;
  /** true: el ingreso a cuenta se descuenta al trabajador (reduce el liquido). */
  ingresoACuentaRepercutido: boolean;
  indemnizacionExenta: number;
  indemnizacionSujeta: number;
  ssTrabajador: number;
  irpf: number;
  anticipos: number;
  embargos: number;
  otrasDeducciones: number;
  /** Liquido a percibir (lo que se paga al trabajador). */
  liquido: number;
  ssEmpresa: number;
}

export const CAMPOS_IMPORTE: ReadonlyArray<Exclude<keyof ImportesNomina, 'ingresoACuentaRepercutido'>> = [
  'brutoDinerario',
  'dietasExentas',
  'especieValoracion',
  'ingresoACuenta',
  'indemnizacionExenta',
  'indemnizacionSujeta',
  'ssTrabajador',
  'irpf',
  'anticipos',
  'embargos',
  'otrasDeducciones',
  'liquido',
  'ssEmpresa',
];

export interface CuadreNomina {
  /** Bruto + dietas + indemnizaciones + especie. */
  devengado: number;
  /** SS trabajador + IRPF + ingreso a cuenta repercutido + especie + anticipos + embargos + otras. */
  deducido: number;
  liquidoCalculado: number;
  /** Liquido de la nomina menos el calculado. */
  diferencia: number;
  cuadra: boolean;
  /** Bruto + dietas + indemnizaciones + SS empresa + ingreso a cuenta no repercutido. */
  costeEmpresa: number;
}

export interface EmpleadoDTO {
  id: string;
  companyId: string;
  nif: string;
  nombre: string;
  apellidos: string;
  nombreCompleto: string;
  naf: string | null;
  fechaAlta: string | null;
  fechaBaja: string | null;
  tipoContrato: string;
  jornadaParcial: boolean;
  grupoCotizacion: number | null;
  porcentajeIrpfActual: number | null;
  clave190: string;
  subclave190: string | null;
  provincia: string | null;
  anioNacimiento: number | null;
  situacionFamiliar: number | null;
  nifConyuge: string | null;
  discapacidad: number | null;
  movilidadGeografica: boolean | null;
  subcuenta465: string | null;
  activo: boolean;
  observaciones: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NominaDTO extends ImportesNomina {
  id: string;
  companyId: string;
  empleadoId: string;
  empleado?: { id: string; nif: string; nombreCompleto: string; subcuenta465: string | null; activo: boolean };
  ejercicio: number;
  mes: number;
  tipo: string;
  ejercicioDevengo: number | null;
  fechaDevengo: string;
  fechaPago: string;
  porcentajeIrpf: number | null;
  estado: string;
  asientoId: string | null;
  asientoNumero?: string | null;
  asientoAnulacionId: string | null;
  anuladaEn: Date | null;
  /** Asiento del pago del liquido (compartido por las nominas pagadas juntas). */
  asientoPagoId: string | null;
  asientoPagoNumero?: string | null;
  /** Subcuenta de tesoreria del pago (572xxx o 570). */
  cuentaPago: string | null;
  loteImportacionId: string | null;
  origen: string;
  observaciones: string | null;
  cuadre: CuadreNomina;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Subcuentas de las nominas (ReglasContables.data.nominas). Las que no se
 * configuran se generan con la longitud de codigo del plan de la empresa.
 */
export interface CuentasNominas {
  /** 640 Sueldos y salarios. */
  sueldos: string;
  /** 641 Indemnizaciones. */
  indemnizaciones: string;
  /** 642 Seguridad Social a cargo de la empresa. */
  ssEmpresa: string;
  /** 649 Otros gastos sociales (reservada para la especie y gastos sociales). */
  otrosGastosSociales: string;
  /** 476 Organismos de la Seguridad Social, acreedores. */
  ssAcreedora: string;
  /** Subcuenta de la 4751 solo para las retenciones del trabajo (separada de la de profesionales). */
  irpfTrabajo: string;
  /** 465 generica (las de cada trabajador cuelgan de ella). */
  remuneracionesPendientes: string;
  /** 465 de embargos (lo retenido se debe al juzgado u organismo, no al trabajador). */
  embargos: string;
  /** 460 Anticipos de remuneraciones. */
  anticipos: string;
  /** Otras deducciones de la nomina (cuota sindical, etc.). */
  otrasDeducciones: string;
  /** Dietas exentas: la 640 (por defecto) o la 629. */
  dietas: string;
  /** 471 Organismos de la SS deudores: IT en pago delegado que compensa el RLC. */
  ssDeudoraIt: string;
  /** 570 Caja, para los pagos en efectivo. */
  caja: string;
}
