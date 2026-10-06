import { prisma } from '../config/database';
import { badRequest, notFound } from '../utils/http-errors';
import { importarMovimientosDesdeCSV } from './bancos.service';
import { conciliarMovimientoConFactura } from './conciliacionConfirmar.service';

/**
 * Tesoreria: la API que usa la pantalla de tesoreria del frontend.
 *
 * Es una capa fina sobre el modulo de bancos (importacion de extractos y
 * conciliacion con facturas), que ya tiene tests. Solo traduce formatos:
 * el frontend habla de `estado` ('pendiente' | 'conciliado') y el esquema
 * guarda un booleano `conciliado`.
 */

type EstadoMovimiento = 'pendiente' | 'conciliado';

const estadoDe = (conciliado: boolean): EstadoMovimiento => (conciliado ? 'conciliado' : 'pendiente');

const aMovimiento = (m: {
  id: string;
  cuentaBancariaId: string;
  fecha: string;
  importe: number;
  concepto: string;
  referencia: string | null;
  origen: string;
  conciliado: boolean;
}) => ({
  id: m.id,
  cuentaBancariaId: m.cuentaBancariaId,
  fecha: m.fecha,
  importe: m.importe,
  concepto: m.concepto,
  referencia: m.referencia ?? undefined,
  origen: m.origen,
  estado: estadoDe(m.conciliado),
  tipo: m.importe >= 0 ? ('entrada' as const) : ('salida' as const),
});

const aCuenta = (c: {
  id: string;
  iban: string;
  bic: string | null;
  bancoNombre: string | null;
  subcuentaCodigo: string;
  saldoInicial: number;
  activa: boolean;
  createdAt: Date;
}) => ({
  id: c.id,
  iban: c.iban,
  bic: c.bic ?? undefined,
  bancoNombre: c.bancoNombre ?? undefined,
  subcuentaCodigo: c.subcuentaCodigo,
  saldoInicial: c.saldoInicial,
  estado: c.activa ? 'activa' : 'inactiva',
  createdAt: c.createdAt,
});

async function cuentaDeEmpresa(companyId: string, accountId: string) {
  const cuenta = await prisma.bankAccount.findFirst({ where: { id: accountId, companyId } });
  if (!cuenta) throw notFound('Cuenta bancaria no encontrada.');
  return cuenta;
}

export async function crearCuentaBancaria(
  companyId: string,
  datos: { iban?: string; bic?: string; bancoNombre?: string; subcuentaCodigo?: string; saldoInicial?: number },
) {
  const iban = String(datos.iban ?? '').replace(/\s+/g, '').toUpperCase();
  if (!iban) throw badRequest('El IBAN es obligatorio.');
  if (!datos.subcuentaCodigo) throw badRequest('La subcuenta contable (572xxx) es obligatoria.');

  const saldoInicial = Number(datos.saldoInicial ?? 0);
  if (!Number.isFinite(saldoInicial)) throw badRequest('El saldo inicial no es un numero valido.');

  const existe = await prisma.bankAccount.findFirst({ where: { companyId, iban } });
  if (existe) throw badRequest(`Ya existe una cuenta con IBAN ${iban} en esta empresa.`);

  const cuenta = await prisma.bankAccount.create({
    data: {
      companyId,
      iban,
      bic: datos.bic || null,
      bancoNombre: datos.bancoNombre || null,
      subcuentaCodigo: datos.subcuentaCodigo,
      saldoInicial,
    },
  });
  return aCuenta(cuenta);
}

/** Cuentas de la empresa, cada una con sus ultimos 5 movimientos pendientes. */
export async function listarCuentasBancarias(companyId: string) {
  const cuentas = await prisma.bankAccount.findMany({
    where: { companyId },
    include: { movimientos: { where: { conciliado: false }, orderBy: { fecha: 'desc' }, take: 5 } },
    orderBy: { createdAt: 'desc' },
  });
  return cuentas.map((c) => ({ ...aCuenta(c), movimientos: c.movimientos.map(aMovimiento) }));
}

export async function listarMovimientos(companyId: string, accountId: string, estado?: string) {
  await cuentaDeEmpresa(companyId, accountId);
  if (estado && estado !== 'pendiente' && estado !== 'conciliado') {
    throw badRequest("El filtro estado debe ser 'pendiente' o 'conciliado'.");
  }
  const movimientos = await prisma.bankMovement.findMany({
    where: {
      companyId,
      cuentaBancariaId: accountId,
      ...(estado && { conciliado: estado === 'conciliado' }),
    },
    orderBy: { fecha: 'desc' },
  });
  return movimientos.map(aMovimiento);
}

/** Sube un extracto CSV. El parseo (separador, decimales, fechas) es el de bancos. */
export async function subirExtracto(companyId: string, accountId: string, contenidoCSV: unknown) {
  if (typeof contenidoCSV !== 'string' || !contenidoCSV.trim()) {
    throw badRequest('Envia el extracto en { contenidoCSV }.');
  }
  await cuentaDeEmpresa(companyId, accountId);
  const importados = await importarMovimientosDesdeCSV(companyId, accountId, contenidoCSV);
  return {
    movimientosCreados: importados.length,
    detalles: importados.map((m) => ({ ...m, estado: estadoDe(m.conciliado) })),
  };
}

/**
 * Concilia un movimiento. Hoy solo esta soportado el caso que el modulo de
 * bancos sabe contabilizar: un cobro contra una factura de venta. Los demas
 * tipos devuelven un error claro en vez de marcar el movimiento sin asiento.
 */
export async function conciliarMovimiento(
  companyId: string,
  movementId: string,
  tipoOrigen: unknown,
  origenId: unknown,
) {
  if (typeof origenId !== 'string' || !origenId.trim()) throw badRequest('Indica el id de la factura (origenId).');
  if (tipoOrigen !== 'factura_ingreso') {
    throw badRequest(
      'Por ahora solo se puede conciliar un cobro con una factura de venta. ' +
        'La conciliacion con facturas de gasto o con asientos aun no esta disponible.',
    );
  }
  return conciliarMovimientoConFactura(companyId, movementId, origenId.trim());
}

export async function obtenerResumen(companyId: string) {
  const [cuentas, conciliados, pendientes] = await Promise.all([
    prisma.bankAccount.findMany({ where: { companyId, activa: true }, orderBy: { createdAt: 'desc' } }),
    prisma.bankMovement.count({ where: { companyId, conciliado: true } }),
    prisma.bankMovement.count({ where: { companyId, conciliado: false } }),
  ]);

  // Saldo actual por cuenta = saldo inicial declarado + suma de sus movimientos.
  const sumas = await prisma.bankMovement.groupBy({
    by: ['cuentaBancariaId'],
    where: { companyId },
    _sum: { importe: true },
  });
  const sumaPorCuenta = new Map(sumas.map((s) => [s.cuentaBancariaId, s._sum.importe ?? 0]));

  const detalle = cuentas.map((c) => {
    const saldoActual = Math.round((c.saldoInicial + (sumaPorCuenta.get(c.id) ?? 0)) * 100) / 100;
    return { id: c.id, nombre: c.bancoNombre ?? undefined, iban: c.iban, saldoInicial: c.saldoInicial, saldoActual };
  });

  return {
    cuentasActivas: cuentas.length,
    saldoTotal: Math.round(detalle.reduce((acc, c) => acc + c.saldoActual, 0) * 100) / 100,
    conciliados,
    pendientes,
    cuentas: detalle,
  };
}

export const treasuryService = {
  crearCuentaBancaria,
  listarCuentasBancarias,
  listarMovimientos,
  subirExtracto,
  conciliarMovimiento,
  obtenerResumen,
};
