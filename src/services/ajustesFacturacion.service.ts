/**
 * Valores por defecto de facturación (Configuración > Facturación).
 *
 * Una fila por empresa (AjustesFacturacion). Si no existe, se devuelven los
 * valores de siempre SIN crearla: leer no escribe, así dos lecturas a la vez no
 * chocan. El PUT hace un upsert.
 *
 * Dónde se usan:
 *  - al crear una factura de venta sin forma de pago o sin vencimiento;
 *  - al emitirla: se copian en la factura el IBAN y el texto al pie, para que
 *    el PDF de una factura ya emitida no cambie si después se cambian aquí;
 *  - en el PDF de los borradores, las proformas y las facturas anteriores a la copia.
 * No cambian ningún asiento ni ningún modelo.
 */
import { z } from 'zod';
import { prisma, type ClienteBD, type TransaccionBD } from '../config/database';
import {
  AJUSTES_FACTURACION_POR_DEFECTO,
  AjustesFacturacion,
  DIAS_VENCIMIENTO_MAX,
  FORMAS_PAGO,
  FormaPago,
  IRPF_PERMITIDOS,
  TEXTO_PIE_MAX,
} from '../domain/ajustes.model';
import { badRequest } from '../utils/http-errors';
import { errorDeValidacion } from '../utils/zod-errores';
import { perfilEmpresa } from './perfilEmpresa.service';

type Db = ClienteBD | TransaccionBD;

/** Cuenta bancaria activa de la empresa, tal como se ofrece para la factura. */
export interface CuentaParaFactura {
  id: string;
  iban: string;
  bancoNombre: string | null;
  moneda: string;
}

export interface AjustesFacturacionResp extends AjustesFacturacion {
  /** false: todavía no se han guardado (son los valores por defecto). */
  guardado: boolean;
  /** Fuera de España no hay IRPF: irpfDefecto siempre 0 y la pantalla no lo muestra. */
  empresaEspanola: boolean;
  monedaCuenta: string;
  /** Cuentas activas que se pueden elegir (quien edita esto no siempre ve Tesorería). */
  cuentasBancarias: CuentaParaFactura[];
  actualizadoEn: string | null;
  actualizadoPor: string | null;
}

/** Ajustes guardados (o los de siempre), sin crear la fila. */
export async function leerAjustesFacturacion(companyId: string, db: Db = prisma): Promise<AjustesFacturacion & { guardado: boolean; actualizadoEn: string | null; actualizadoPor: string | null }> {
  // Sin la tabla (tests con prisma simulado): los valores de siempre.
  const tabla = (db as { ajustesFacturacion?: { findUnique?: unknown } }).ajustesFacturacion;
  const fila = typeof tabla?.findUnique === 'function' ? await db.ajustesFacturacion.findUnique({ where: { companyId } }) : null;
  if (!fila) return { ...AJUSTES_FACTURACION_POR_DEFECTO, guardado: false, actualizadoEn: null, actualizadoPor: null };
  return {
    formaPago: ((FORMAS_PAGO as readonly string[]).includes(fila.formaPago) ? fila.formaPago : 'TRANSFERENCIA') as FormaPago,
    diasVencimiento: fila.diasVencimiento,
    irpfDefecto: Number(fila.irpfDefecto),
    cuentaBancariaId: fila.cuentaBancariaId,
    mostrarIban: fila.mostrarIban,
    textoPie: fila.textoPie,
    guardado: true,
    actualizadoEn: fila.updatedAt.toISOString(),
    actualizadoPor: fila.updatedBy,
  };
}

async function cuentasActivas(companyId: string, db: Db = prisma): Promise<CuentaParaFactura[]> {
  if (typeof (db as { bankAccount?: { findMany?: unknown } }).bankAccount?.findMany !== 'function') return [];
  const cuentas = await db.bankAccount.findMany({
    where: { companyId, activa: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true, iban: true, bancoNombre: true, moneda: true },
  });
  return cuentas.map((c) => ({ ...c, moneda: c.moneda || 'EUR' }));
}

/** GET: los ajustes con lo que la pantalla necesita para editarlos. */
export async function obtenerAjustesFacturacion(companyId: string): Promise<AjustesFacturacionResp> {
  const [ajustes, perfil, cuentas] = await Promise.all([leerAjustesFacturacion(companyId), perfilEmpresa(companyId), cuentasActivas(companyId)]);
  return {
    ...ajustes,
    irpfDefecto: perfil.espanola ? ajustes.irpfDefecto : 0,
    empresaEspanola: perfil.espanola,
    monedaCuenta: perfil.monedaCuenta,
    // Fuera de España solo se ofrecen las cuentas en la moneda de la empresa.
    cuentasBancarias: perfil.espanola ? cuentas : cuentas.filter((c) => c.moneda === perfil.monedaCuenta),
  };
}

const esquema = z
  .object({
    formaPago: z.enum(FORMAS_PAGO),
    diasVencimiento: z.number().int().min(0).max(DIAS_VENCIMIENTO_MAX),
    irpfDefecto: z.number().refine((v) => (IRPF_PERMITIDOS as readonly number[]).includes(v)),
    cuentaBancariaId: z.string().trim().min(1).nullable(),
    mostrarIban: z.boolean(),
    textoPie: z.string().max(TEXTO_PIE_MAX).nullable(),
  })
  .partial()
  .strict();

const MENSAJES: Record<string, string> = {
  formaPago: `La forma de pago tiene que ser una de estas: ${FORMAS_PAGO.join(', ')}.`,
  diasVencimiento: `Los días de vencimiento son un número entero entre 0 y ${DIAS_VENCIMIENTO_MAX}.`,
  irpfDefecto: `El IRPF habitual tiene que ser uno de estos porcentajes: ${IRPF_PERMITIDOS.join(', ')}.`,
  cuentaBancariaId: 'Elige una cuenta bancaria de la lista o deja la automática.',
  mostrarIban: 'Indica si se muestra el IBAN en la factura (sí o no).',
  textoPie: `El texto al pie admite como máximo ${TEXTO_PIE_MAX} caracteres.`,
};

/** PUT: valida, aplica las reglas de la empresa y guarda (upsert). Solo cambia lo que llega. */
export async function guardarAjustesFacturacion(companyId: string, userId: string, entrada: unknown): Promise<AjustesFacturacionResp> {
  const r = esquema.safeParse(entrada ?? {});
  if (!r.success) throw errorDeValidacion(r.error, MENSAJES);
  const cambios = r.data;
  const [actual, perfil] = await Promise.all([leerAjustesFacturacion(companyId), perfilEmpresa(companyId)]);

  const nuevo: AjustesFacturacion = {
    formaPago: cambios.formaPago ?? actual.formaPago,
    diasVencimiento: cambios.diasVencimiento ?? actual.diasVencimiento,
    irpfDefecto: cambios.irpfDefecto ?? actual.irpfDefecto,
    cuentaBancariaId: cambios.cuentaBancariaId !== undefined ? cambios.cuentaBancariaId : actual.cuentaBancariaId,
    mostrarIban: cambios.mostrarIban ?? actual.mostrarIban,
    textoPie: cambios.textoPie !== undefined ? cambios.textoPie?.trim() || null : actual.textoPie,
  };
  // Fuera de España no hay IRPF: se guarda siempre 0.
  if (!perfil.espanola) nuevo.irpfDefecto = 0;

  if (cambios.cuentaBancariaId) {
    const cuenta = await prisma.bankAccount.findFirst({
      where: { id: cambios.cuentaBancariaId, companyId },
      select: { activa: true, moneda: true },
    });
    if (!cuenta) throw badRequest('Esa cuenta bancaria no es de esta empresa.', { campo: 'cuentaBancariaId' });
    if (!cuenta.activa) throw badRequest('Esa cuenta bancaria está desactivada: elige una activa.', { campo: 'cuentaBancariaId' });
    if (!perfil.espanola && (cuenta.moneda || 'EUR') !== perfil.monedaCuenta) {
      throw badRequest(`Elige una cuenta en ${perfil.monedaCuenta}, la moneda de la empresa.`, { campo: 'cuentaBancariaId' });
    }
  }

  const datos = { ...nuevo, updatedBy: userId };
  await prisma.ajustesFacturacion.upsert({ where: { companyId }, create: { companyId, ...datos }, update: datos });
  return obtenerAjustesFacturacion(companyId);
}

// ---------- Uso en las facturas ----------

/**
 * Cuenta que sale en la factura: ninguna si no se muestra el IBAN; la elegida
 * si sigue activa y es de la moneda de la factura (a una factura en USD no se
 * le pone una cuenta en EUR); si no, la primera activa en la moneda de la
 * factura y, si no hay, la primera activa. `cuentas` son las activas, de la
 * más antigua a la más nueva.
 */
export function cuentaParaFactura<C extends { id: string; moneda?: string | null }>(
  cuentas: C[],
  ajustes: Pick<AjustesFacturacion, 'cuentaBancariaId' | 'mostrarIban'>,
  moneda: string,
): C | null {
  if (!ajustes.mostrarIban) return null;
  const elegida = ajustes.cuentaBancariaId ? cuentas.find((c) => c.id === ajustes.cuentaBancariaId) : undefined;
  if (elegida && (elegida.moneda ?? 'EUR') === moneda) return elegida;
  return cuentas.find((c) => (c.moneda ?? 'EUR') === moneda) ?? cuentas[0] ?? null;
}

/**
 * Lo que se copia en la factura al emitirla: el IBAN que sale ('' = ninguno) y
 * el texto al pie ('' = ninguno). Nunca null, para distinguirla de una factura
 * anterior a esta copia.
 */
export async function copiaAlEmitir(companyId: string, moneda: string, db: Db = prisma): Promise<{ ibanCobro: string; textoPie: string }> {
  const [ajustes, cuentas] = await Promise.all([leerAjustesFacturacion(companyId, db), cuentasActivas(companyId, db)]);
  const cuenta = cuentaParaFactura(cuentas, ajustes, moneda);
  return { ibanCobro: cuenta?.iban ?? '', textoPie: ajustes.textoPie ?? '' };
}
