import { prisma } from '../config/database';
import { badRequest, notFound } from '../utils/http-errors';
import { conReintento } from '../utils/reintento';
import { isValidIban } from '../utils/validateIban';
import { importarMovimientosDesdeCSV } from './bancos.service';
import { conciliarMovimientoConFactura } from './conciliacionConfirmar.service';
import { perfilEmpresa } from './perfilEmpresa.service';
import { asignarSubcuentaBanco, INDICE_SUBCUENTA_BANCO, nombreSubcuentaBanco, subcuentasBanco, usarSubcuentaBanco } from './subcuentaBanco.service';

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
  moneda?: string | null;
}) => ({
  id: c.id,
  iban: c.iban,
  /** Moneda de la cuenta: la de la contabilidad de la empresa al darla de alta. */
  moneda: c.moneda ?? 'EUR',
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

/**
 * Alta de una cuenta bancaria.
 *
 * - Sin `subcuentaCodigo` (el alta rapida de la ventana de cobro o de pago, que
 *   solo pide IBAN y banco): se le asigna la siguiente 572 libre y se da de alta
 *   en el plan.
 * - Con `subcuentaCodigo` (Tesoreria > Cuentas bancarias): tiene que ser una 572
 *   que no use otra cuenta; si no esta en el plan, se da de alta en el.
 *
 * El IBAN se comprueba (digitos de control) siempre que lo parezca, y en una
 * empresa espanola siempre. En una de EE. UU. o Hong Kong, que no usan IBAN,
 * vale el numero de cuenta. Los errores llevan `campo` para la pantalla.
 */
export async function crearCuentaBancaria(
  companyId: string,
  datos: { iban?: string; bic?: string; bancoNombre?: string; subcuentaCodigo?: string; saldoInicial?: number },
) {
  const iban = String(datos.iban ?? '').replace(/[\s-]+/g, '').toUpperCase();
  if (!iban) throw badRequest('Escribe el IBAN de la cuenta.', { campo: 'iban' });
  const perfil = await perfilEmpresa(companyId);
  const pareceIban = /^[A-Z]{2}\d{2}/.test(iban);
  if ((pareceIban || perfil.espanola) && !isValidIban(iban)) {
    throw badRequest(
      pareceIban
        ? 'El IBAN no es válido: revisa que esté completo y sin cifras cambiadas.'
        : 'Escribe el IBAN completo, empezando por las letras del país (por ejemplo ES91 2100…).',
      { campo: 'iban' },
    );
  }

  const saldoInicial = Number(datos.saldoInicial ?? 0);
  if (!Number.isFinite(saldoInicial)) throw badRequest('El saldo inicial no es un importe válido.', { campo: 'saldoInicial' });

  const existe = await prisma.bankAccount.findFirst({ where: { companyId, iban } });
  if (existe) throw badRequest(`Ya tienes dada de alta una cuenta con el IBAN ${iban}.`, { campo: 'iban' });

  const bancoNombre = datos.bancoNombre?.trim() || null;
  const datosCuenta = {
    companyId,
    iban,
    bic: datos.bic?.trim() || null,
    bancoNombre,
    saldoInicial: Math.round(saldoInicial * 100) / 100,
    // Las cuentas van en la moneda de la contabilidad (cuentas en otra moneda: fuera de alcance).
    moneda: perfil.monedaCuenta,
  };
  const escrita = String(datos.subcuentaCodigo ?? '').trim();
  const nombre = nombreSubcuentaBanco(bancoNombre, iban);
  const cuenta = await conReintento(
    () =>
      prisma.$transaction(async (tx) => {
        const subcuentaCodigo = escrita ? await usarSubcuentaBanco(tx, companyId, escrita, nombre) : await asignarSubcuentaBanco(tx, companyId, nombre);
        return tx.bankAccount.create({ data: { ...datosCuenta, subcuentaCodigo } });
      }),
    { indices: [INDICE_SUBCUENTA_BANCO], intentos: 5 },
  );
  return aCuenta(cuenta);
}

/**
 * Subcuenta que se propone al dar de alta una cuenta en Tesoreria (la misma
 * que pondria el alta rapida) y las 572 del plan que aun no son de ninguna
 * cuenta, por si la nueva es una de ellas. Solo lee.
 */
export async function subcuentaPropuesta(companyId: string) {
  const s = await subcuentasBanco(companyId);
  return { subcuentaCodigo: s.siguiente, longitud: s.longitud, sinCuenta: s.sinCuenta };
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
  subcuentaPropuesta,
  listarCuentasBancarias,
  listarMovimientos,
  subirExtracto,
  conciliarMovimiento,
  obtenerResumen,
};
