import { Prisma } from '@prisma/client';
import { prisma, type TransaccionBD } from '../config/database';
import { badRequest, conflict, notFound } from '../utils/http-errors';
import { importeConMoneda } from '../domain/divisas';
import { aCentimos } from '../utils/money';
import { esClaveRepetida } from '../utils/reintento';
import { isValidIban } from '../utils/validateIban';
import { registrarAuditoria } from './auditoria.service';
import { importarMovimientosDesdeCSV } from './bancos.service';
import { conciliarMovimientoConFactura } from './conciliacionConfirmar.service';
import { perfilEmpresa } from './perfilEmpresa.service';
import {
  asignarSubcuentaBanco,
  esSubcuentaDeBanco,
  INDICE_SUBCUENTA_BANCO,
  nombreSubcuentaBanco,
  subcuentasBanco,
  usarSubcuentaBanco,
} from './subcuentaBanco.service';

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
  /** Solo si la subcuenta no es de bancos: hasta cambiarla no se puede cobrar ni pagar con esta cuenta. */
  avisoSubcuenta: esSubcuentaDeBanco(c.subcuentaCodigo) ? undefined : avisoSubcuentaMala(c.subcuentaCodigo),
  saldoInicial: c.saldoInicial,
  estado: c.activa ? 'activa' : 'inactiva',
  createdAt: c.createdAt,
});

/** Aviso de una cuenta cuya subcuenta no es de bancos (dada de alta cuando aun no se comprobaba). */
const avisoSubcuentaMala = (codigo: string) =>
  `Su subcuenta «${codigo}» no es de bancos (una 572, por ejemplo 57200001): hasta que la cambies no se pueden apuntar cobros ni pagos en esta cuenta.`;

/** IBAN sin espacios ni guiones y en mayusculas (como se guarda). */
const normalizarIban = (iban: string) => iban.replace(/[\s-]+/g, '').toUpperCase();

/**
 * Dos altas a la vez: la misma subcuenta (indice unico del plan) o un
 * interbloqueo de MySQL al bloquear las cuentas de la empresa. Se repite la
 * transaccion y la segunda ve lo que hizo la primera.
 */
const esChoqueDeAltas = (e: unknown) =>
  esClaveRepetida(e, [INDICE_SUBCUENTA_BANCO]) ||
  (e instanceof Prisma.PrismaClientKnownRequestError &&
    (e.code === 'P2034' || (e.code === 'P2010' && /1213|deadlock/i.test(JSON.stringify(e.meta ?? {})))));

async function conReintentoDeAltas<T>(fn: () => Promise<T>): Promise<T> {
  for (let intento = 0; ; intento++) {
    try {
      return await fn();
    } catch (e) {
      if (intento >= 5 || !esChoqueDeAltas(e)) throw e;
    }
  }
}

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
 *
 * Si ese IBAN es de una cuenta desactivada, se vuelve a activar tal como estaba
 * (con su subcuenta y su saldo inicial) en vez de dar un error sin salida: la
 * app no tiene otra forma de reactivarla. La respuesta lleva `reactivada`.
 */
export async function crearCuentaBancaria(
  companyId: string,
  datos: { iban?: string; bic?: string; bancoNombre?: string; subcuentaCodigo?: string; saldoInicial?: number },
) {
  const iban = normalizarIban(String(datos.iban ?? ''));
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
  return conReintentoDeAltas(() =>
    prisma.$transaction(async (tx) => {
      // El IBAN repetido se mira dentro de la transaccion y con bloqueo: dos altas
      // a la vez del mismo IBAN se ponen en cola y la segunda ve la primera.
      const existe = (await cuentasBloqueadas(tx, companyId)).find((c) => normalizarIban(c.iban) === iban);
      if (existe?.activa) throw badRequest(`Ya tienes dada de alta una cuenta con el IBAN ${iban}.`, { campo: 'iban' });
      if (existe) {
        const reactivada = await tx.bankAccount.update({ where: { id: existe.id }, data: { activa: true } });
        return { ...aCuenta(reactivada), reactivada: true };
      }
      const subcuentaCodigo = escrita ? await usarSubcuentaBanco(tx, companyId, escrita, nombre) : await asignarSubcuentaBanco(tx, companyId, nombre);
      return aCuenta(await tx.bankAccount.create({ data: { ...datosCuenta, subcuentaCodigo } }));
    }),
  );
}

/** Cuentas bancarias de la empresa leidas con bloqueo (hasta el final de la transaccion). */
async function cuentasBloqueadas(tx: TransaccionBD, companyId: string): Promise<Array<{ id: string; iban: string; activa: boolean }>> {
  const filas = await tx.$queryRaw<Array<{ id: string; iban: string; activa: unknown }>>`
    SELECT id, iban, activa FROM BankAccount WHERE companyId = ${companyId} FOR UPDATE`;
  return filas.map((f) => ({ id: f.id, iban: f.iban, activa: Boolean(Number(f.activa)) }));
}

/**
 * Cambia la subcuenta 572 de una cuenta bancaria: la de una cuenta dada de alta
 * con una que no es de bancos (por ejemplo «0001», cuando aun no se comprobaba)
 * o con otra equivocada. Lo ya apuntado se queda en la subcuenta de antes, asi
 * que solo se deja si esta no tiene saldo: si lo tuviera, el banco quedaria
 * partido en dos subcuentas. Antes hay que anular esos cobros y pagos, o pasar
 * el saldo a la nueva con un asiento. La nueva se comprueba como en el alta.
 */
export async function cambiarSubcuentaCuentaBancaria(companyId: string, accountId: string, datos: { subcuentaCodigo?: unknown }, userId = 'unknown') {
  const cuenta = await cuentaDeEmpresa(companyId, accountId);
  const escrita = String(datos.subcuentaCodigo ?? '').trim();
  if (!escrita) throw badRequest('Escribe la subcuenta 572 de la cuenta.', { campo: 'subcuentaCodigo' });
  const antes = cuenta.subcuentaCodigo;
  if (escrita.replace(/[\s.]/g, '') === antes) return aCuenta(cuenta);

  const actualizada = await conReintentoDeAltas(() =>
    prisma.$transaction(async (tx) => {
      await cuentasBloqueadas(tx, companyId);
      const sumas = await tx.journalEntryLine.aggregate({
        where: { companyId, accountCode: antes, entry: { estado: { not: 'REVERSED' } } },
        _sum: { debe: true, haber: true },
      });
      const saldo = Number(sumas._sum.debe ?? 0) - Number(sumas._sum.haber ?? 0);
      if (aCentimos(saldo) !== 0) {
        throw conflict(
          `La subcuenta ${antes} ya tiene apuntes de este banco con saldo (${importeConMoneda(saldo, cuenta.moneda ?? 'EUR')}). Si la cambias, el saldo del banco quedaría partido en dos subcuentas. ` +
            'Anula antes esos cobros o pagos (o pasa el saldo a la nueva subcuenta con un asiento) y vuelve a cambiarla.',
          { codigo: 'SUBCUENTA_BANCO_CON_SALDO', subcuenta: antes, saldo: Math.round(saldo * 100) / 100 },
        );
      }
      const subcuentaCodigo = await usarSubcuentaBanco(tx, companyId, escrita, nombreSubcuentaBanco(cuenta.bancoNombre, cuenta.iban), { cuentaId: cuenta.id });
      return tx.bankAccount.update({ where: { id: cuenta.id }, data: { subcuentaCodigo } });
    }),
  );
  await registrarAuditoria({
    userId,
    companyId,
    action: 'CUENTA_BANCARIA_SUBCUENTA',
    resourceType: 'BankAccount',
    resourceId: cuenta.id,
    meta: { antes, despues: actualizada.subcuentaCodigo },
  });
  return aCuenta(actualizada);
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
  cambiarSubcuentaCuentaBancaria,
  subcuentaPropuesta,
  listarCuentasBancarias,
  listarMovimientos,
  subirExtracto,
  conciliarMovimiento,
  obtenerResumen,
};
