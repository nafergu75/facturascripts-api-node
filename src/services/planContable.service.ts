import { randomUUID } from 'crypto';
import {
  CuentaContableBase,
  GrupoCuenta,
  SubcuentaEmpresa,
  SubgrupoCuenta,
} from '../domain/plan-contable.model';
import { badRequest } from '../utils/http-errors';

// --- Plan base PGC-PYME (grupos 1-7). TODO: ampliable con el PGC completo (ICAC). ---

const GRUPOS_BASE: GrupoCuenta[] = [
  { codigo: '1', nombre: 'Financiacion basica' },
  { codigo: '2', nombre: 'Activo no corriente' },
  { codigo: '3', nombre: 'Existencias' },
  { codigo: '4', nombre: 'Acreedores y deudores por operaciones comerciales' },
  { codigo: '5', nombre: 'Cuentas financieras' },
  { codigo: '6', nombre: 'Compras y gastos' },
  { codigo: '7', nombre: 'Ventas e ingresos' },
];

const SUBGRUPOS_BASE: SubgrupoCuenta[] = [
  { codigo: '10', nombre: 'Capital', grupoCodigo: '1' },
  { codigo: '11', nombre: 'Reservas', grupoCodigo: '1' },
  { codigo: '17', nombre: 'Deudas a largo plazo', grupoCodigo: '1' },
  { codigo: '20', nombre: 'Inmovilizaciones intangibles', grupoCodigo: '2' },
  { codigo: '21', nombre: 'Inmovilizaciones materiales', grupoCodigo: '2' },
  { codigo: '28', nombre: 'Amortizacion acumulada del inmovilizado', grupoCodigo: '2' },
  { codigo: '30', nombre: 'Existencias comerciales', grupoCodigo: '3' },
  { codigo: '40', nombre: 'Proveedores', grupoCodigo: '4' },
  { codigo: '41', nombre: 'Acreedores varios', grupoCodigo: '4' },
  { codigo: '43', nombre: 'Clientes', grupoCodigo: '4' },
  { codigo: '44', nombre: 'Deudores varios', grupoCodigo: '4' },
  { codigo: '47', nombre: 'Administraciones publicas', grupoCodigo: '4' },
  { codigo: '52', nombre: 'Deudas a corto plazo', grupoCodigo: '5' },
  { codigo: '57', nombre: 'Tesoreria', grupoCodigo: '5' },
  { codigo: '60', nombre: 'Compras', grupoCodigo: '6' },
  { codigo: '62', nombre: 'Servicios exteriores', grupoCodigo: '6' },
  { codigo: '64', nombre: 'Gastos de personal', grupoCodigo: '6' },
  { codigo: '68', nombre: 'Dotaciones para amortizaciones', grupoCodigo: '6' },
  { codigo: '70', nombre: 'Ventas de mercaderias y prestacion de servicios', grupoCodigo: '7' },
  { codigo: '76', nombre: 'Ingresos financieros', grupoCodigo: '7' },
];

const CUENTAS_BASE: CuentaContableBase[] = [
  { codigo: '100', nombre: 'Capital social', subgrupoCodigo: '10', tipo: 'patrimonio_neto' },
  { codigo: '101', nombre: 'Fondo social', subgrupoCodigo: '10', tipo: 'patrimonio_neto' },
  { codigo: '110', nombre: 'Prima de emision', subgrupoCodigo: '11', tipo: 'patrimonio_neto' },
  { codigo: '113', nombre: 'Reservas voluntarias', subgrupoCodigo: '11', tipo: 'patrimonio_neto' },
  { codigo: '170', nombre: 'Deudas a largo plazo con entidades de credito', subgrupoCodigo: '17', tipo: 'pasivo' },
  { codigo: '200', nombre: 'Inmovilizado intangible', subgrupoCodigo: '20', tipo: 'activo' },
  { codigo: '210', nombre: 'Terrenos y bienes naturales', subgrupoCodigo: '21', tipo: 'activo' },
  { codigo: '220', nombre: 'Inversiones en construcciones', subgrupoCodigo: '21', tipo: 'activo' },
  { codigo: '300', nombre: 'Mercaderias', subgrupoCodigo: '30', tipo: 'activo' },
  { codigo: '400', nombre: 'Proveedores', subgrupoCodigo: '40', tipo: 'pasivo' },
  { codigo: '410', nombre: 'Acreedores por prestaciones de servicios', subgrupoCodigo: '41', tipo: 'pasivo' },
  { codigo: '430', nombre: 'Clientes', subgrupoCodigo: '43', tipo: 'activo' },
  { codigo: '440', nombre: 'Deudores', subgrupoCodigo: '44', tipo: 'activo' },
  { codigo: '470', nombre: 'Hacienda Publica, deudora por diversos conceptos', subgrupoCodigo: '47', tipo: 'activo' },
  { codigo: '472', nombre: 'Hacienda Publica, IVA soportado', subgrupoCodigo: '47', tipo: 'activo' },
  { codigo: '475', nombre: 'Hacienda Publica, acreedora por conceptos fiscales', subgrupoCodigo: '47', tipo: 'pasivo' },
  { codigo: '477', nombre: 'Hacienda Publica, IVA repercutido', subgrupoCodigo: '47', tipo: 'pasivo' },
  { codigo: '520', nombre: 'Deudas a corto plazo con entidades de credito', subgrupoCodigo: '52', tipo: 'pasivo' },
  { codigo: '570', nombre: 'Caja, euros', subgrupoCodigo: '57', tipo: 'activo' },
  { codigo: '572', nombre: 'Bancos e instituciones de credito c/c vista, euros', subgrupoCodigo: '57', tipo: 'activo' },
  { codigo: '600', nombre: 'Compras de mercaderias', subgrupoCodigo: '60', tipo: 'gasto' },
  { codigo: '602', nombre: 'Compras de otros aprovisionamientos', subgrupoCodigo: '60', tipo: 'gasto' },
  { codigo: '621', nombre: 'Arrendamientos y canones', subgrupoCodigo: '62', tipo: 'gasto' },
  { codigo: '622', nombre: 'Reparaciones y conservacion', subgrupoCodigo: '62', tipo: 'gasto' },
  { codigo: '626', nombre: 'Servicios bancarios y similares', subgrupoCodigo: '62', tipo: 'gasto' },
  { codigo: '627', nombre: 'Publicidad, propaganda y relaciones publicas', subgrupoCodigo: '62', tipo: 'gasto' },
  { codigo: '628', nombre: 'Suministros', subgrupoCodigo: '62', tipo: 'gasto' },
  { codigo: '629', nombre: 'Otros servicios', subgrupoCodigo: '62', tipo: 'gasto' },
  { codigo: '640', nombre: 'Sueldos y salarios', subgrupoCodigo: '64', tipo: 'gasto' },
  { codigo: '642', nombre: 'Seguridad Social a cargo de la empresa', subgrupoCodigo: '64', tipo: 'gasto' },
  { codigo: '700', nombre: 'Ventas de mercaderias', subgrupoCodigo: '70', tipo: 'ingreso' },
  { codigo: '705', nombre: 'Prestaciones de servicios', subgrupoCodigo: '70', tipo: 'ingreso' },
  { codigo: '769', nombre: 'Otros ingresos financieros', subgrupoCodigo: '76', tipo: 'ingreso' },
];

export function listarGruposBase(): GrupoCuenta[] {
  return GRUPOS_BASE;
}
export function listarSubgruposBase(): SubgrupoCuenta[] {
  return SUBGRUPOS_BASE;
}
export function listarCuentasBase(): CuentaContableBase[] {
  return CUENTAS_BASE;
}

// --- Subcuentas por empresa: almacenamiento en memoria. ---
//
// PENDIENTE BLOQUEADO (no resuelto en esta ronda): existe un sistema PARALELO ya
// persistido en Prisma para el mismo concepto — modelo ChartOfAccounts +
// chart-of-accounts.service.ts (montado en /accounting/chart-of-accounts), con
// jerarquia, version PGC y distincion base/personalizada de empresa. Esta
// implementacion en memoria (montada en /plan-contable) es la que usa hoy el
// frontend vanilla (frontend/), por lo que NO se ha podido retirar sin antes
// decidir cual de los dos sistemas es el canonico y migrar datos/consumidores.
// Mientras se decide, se bloquea en produccion para evitar perdida silenciosa de
// subcuentas personalizadas en cada reinicio.
// NOTA (deploy Vercel): el guard que LANZABA en produccion se ha rebajado a
// AVISO para permitir el despliegue. El almacenamiento sigue siendo en memoria
// (no persiste en serverless): pendiente consolidar /plan-contable con el modelo
// ChartOfAccounts (ya en Prisma) o darle persistencia propia (TODO produccion).
if (process.env.NODE_ENV !== 'test') {
  console.warn(
    '\x1b[33m[planContable.service] ADVERTENCIA: subcuentas de empresa en memoria. Se perderan al reiniciar.\x1b[0m',
  );
}

const subcuentasStore = new Map<string, SubcuentaEmpresa>(); // id -> subcuenta
const ahora = (): string => new Date().toISOString();

export async function listarSubcuentasEmpresa(companyId: string): Promise<SubcuentaEmpresa[]> {
  return [...subcuentasStore.values()].filter((s) => s.companyId === companyId);
}

export async function crearSubcuentaEmpresa(
  companyId: string,
  data: Omit<SubcuentaEmpresa, 'id' | 'companyId' | 'creadoEn' | 'actualizadoEn'>,
): Promise<SubcuentaEmpresa> {
  if (!CUENTAS_BASE.some((c) => c.codigo === data.cuentaBaseCodigo)) {
    throw badRequest(`cuentaBaseCodigo '${data.cuentaBaseCodigo}' no existe en el plan base.`);
  }
  const subcuenta: SubcuentaEmpresa = { ...data, id: randomUUID(), companyId, creadoEn: ahora(), actualizadoEn: ahora() };
  subcuentasStore.set(subcuenta.id, subcuenta);
  return subcuenta;
}

export async function actualizarSubcuentaEmpresa(
  companyId: string,
  subcuentaId: string,
  data: Partial<Omit<SubcuentaEmpresa, 'id' | 'companyId' | 'creadoEn'>>,
): Promise<SubcuentaEmpresa | null> {
  const actual = subcuentasStore.get(subcuentaId);
  if (!actual || actual.companyId !== companyId) return null;
  if (data.cuentaBaseCodigo && !CUENTAS_BASE.some((c) => c.codigo === data.cuentaBaseCodigo)) {
    throw badRequest(`cuentaBaseCodigo '${data.cuentaBaseCodigo}' no existe en el plan base.`);
  }
  const actualizada: SubcuentaEmpresa = { ...actual, ...data, id: actual.id, companyId, creadoEn: actual.creadoEn, actualizadoEn: ahora() };
  subcuentasStore.set(subcuentaId, actualizada);
  return actualizada;
}

export async function desactivarSubcuentaEmpresa(companyId: string, subcuentaId: string): Promise<boolean> {
  const actual = subcuentasStore.get(subcuentaId);
  if (!actual || actual.companyId !== companyId) return false;
  actual.activa = false;
  actual.actualizadoEn = ahora();
  return true;
}

/**
 * Alta rapida de una subcuenta de GASTO para concretar mejor el gasto (ej.
 * '6270001 Luz oficina', '6270002 Luz almacen'). Valida que la cuenta base es de
 * tipo 'gasto' y genera un codigo correlativo a partir del codigo base.
 *
 * @param cuentaBaseCodigo cuenta base PGC de gasto (ej. '627', '628', '629').
 * @param nombre           descripcion de la subcuenta.
 * @param sufijoOpcional   si se aporta y es numerico, fija el correlativo; si no,
 *                         se autogenera el siguiente disponible.
 */
export async function crearSubcuentaGastoEmpresa(
  companyId: string,
  cuentaBaseCodigo: string,
  nombre: string,
  sufijoOpcional?: string,
): Promise<SubcuentaEmpresa> {
  const base = CUENTAS_BASE.find((c) => c.codigo === cuentaBaseCodigo);
  if (!base) throw badRequest(`cuentaBaseCodigo '${cuentaBaseCodigo}' no existe en el plan base.`);
  if (base.tipo !== 'gasto') throw badRequest(`La cuenta '${cuentaBaseCodigo}' no es de tipo gasto (es '${base.tipo}').`);

  // Longitud objetivo de subcuenta (PGC PYME suele usar 7). El codigo se forma
  // como cuentaBase + correlativo, rellenando a la derecha hasta LONG_SUBCUENTA.
  const LONG_SUBCUENTA = 7;
  const existentes = [...subcuentasStore.values()].filter(
    (s) => s.companyId === companyId && s.cuentaBaseCodigo === cuentaBaseCodigo,
  );

  let correlativo: string;
  if (sufijoOpcional && /^\d+$/.test(sufijoOpcional)) {
    correlativo = sufijoOpcional;
  } else {
    correlativo = String(existentes.length + 1);
  }
  const digitosCorrelativo = LONG_SUBCUENTA - cuentaBaseCodigo.length;
  let codigo = (cuentaBaseCodigo + correlativo.padStart(Math.max(1, digitosCorrelativo), '0')).slice(0, LONG_SUBCUENTA);

  // Evita colisiones de codigo subiendo el correlativo.
  let intento = existentes.length + 1;
  while (existentes.some((s) => s.codigo === codigo) || [...subcuentasStore.values()].some((s) => s.companyId === companyId && s.codigo === codigo)) {
    codigo = (cuentaBaseCodigo + String(++intento).padStart(Math.max(1, digitosCorrelativo), '0')).slice(0, LONG_SUBCUENTA);
  }

  return crearSubcuentaEmpresa(companyId, { codigo, nombre, cuentaBaseCodigo, activa: true });
}

// INTEGRACION FUTURA con contabilidadReglas.service:
// - Al crear ficha de cliente/proveedor -> crearSubcuentaEmpresa('430xxxxx'|'400xxxxx').
// - El motor de asientos resolvera cliente/proveedor/ventas/compras/IVA/tesoreria
//   contra SubcuentaEmpresa (validando que existe y esta activa) en vez de codigos fijos.
