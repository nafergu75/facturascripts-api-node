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
 *  - en el PDF de los borradores, las proformas y las facturas anteriores a la copia;
 *  - el IEEPNR (plantilla A): si la empresa lo repercute y a qué tipo por kg. El
 *    tipo queda guardado en cada factura (IncomeInvoice.ieepnrPorKg): cambiarlo
 *    aquí no cambia las emitidas. Si la empresa lo repercute, la serie A usa sola
 *    la plantilla A (series.service, contextoPlantillas).
 * Lo único que cambia un asiento es ieepnrCuenta: con ella, el IEEPNR de las
 * ventas que se emitan después va a esa cuenta en vez de a la de ingresos de su
 * línea. Cada factura la guarda al emitirse (IncomeInvoice.ieepnrCuenta; su
 * rectificativa, la de la original): cambiarla aquí no cambia el asiento de las
 * ya emitidas. Ningún modelo cambia; el panel no cuenta como ingreso el IEEPNR
 * que va a una cuenta 47.
 *
 * vendeCeramica (plantilla B): si la empresa vende ceramica, la serie B usa sola
 * la plantilla B (series.service, contextoPlantillas); si no, la estandar. Al
 * guardar con la casilla marcada (empresa española) se crea la serie B si no
 * existe (seriesSemilla.service); si ya existe y no puede usar la B
 * (desactivada, de otro tipo o con otra plantilla elegida) no se toca y
 * serieCeramica.aviso dice qué hacer. Desmarcarla no borra ni desactiva nada.
 * cuentaPalets (plantilla B): la cuenta de ingresos (70x) que se pone en la
 * línea del cargo de palets de madera que no lleve otra, al guardar la factura;
 * queda en la línea, así que cambiarla aquí no cambia las ya guardadas. Si deja
 * de valer (se desactiva en el plan), el GET lo dice (cuentaPaletsProblema) y
 * al guardar una factura sale el aviso CUENTA_PALETS_NO_VALIDA.
 * El logo de la marca y el sello de la plantilla B van aparte
 * (imagenesFactura.service): aquí solo se dice si los hay.
 */
import { z } from 'zod';
import { prisma, type ClienteBD, type TransaccionBD } from '../config/database';
import {
  AJUSTES_FACTURACION_POR_DEFECTO,
  AjustesFacturacion,
  DIAS_VENCIMIENTO_MAX,
  FORMAS_PAGO,
  FormaPago,
  IEEPNR_POR_KG_MAX,
  IRPF_PERMITIDOS,
  TEXTO_PIE_MAX,
} from '../domain/ajustes.model';
import { PGC_BASE } from '../domain/pgc-model';
import { badRequest } from '../utils/http-errors';
import { errorDeValidacion } from '../utils/zod-errores';
import { perfilEmpresa } from './perfilEmpresa.service';
import { problemaCuentasLinea } from './cuentasLinea.service';
import { estadoSerieCeramica, prepararSerieCeramica, type SerieCeramica } from './seriesSemilla.service';
import { logger } from '../config/logger';

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
  /** Plantilla B: si ya hay logo de la marca y sello de la empresa (GET /ajustes-facturacion/imagenes/marca|sello). */
  imagenesPlantillaB: { marca: boolean; sello: boolean };
  /** Plantilla B: por qué la cuenta del cargo de palets ya no vale (desactivada o fuera del plan); null si vale o no hay. */
  cuentaPaletsProblema: string | null;
  /**
   * Plantilla B: cómo está la serie B si la empresa vende cerámica (null si no
   * la vende). En la respuesta del PUT, 'creada' si se acaba de crear; con
   * `aviso` si hay que hacer algo en Configuración > Series.
   */
  serieCeramica: SerieCeramica | null;
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
    ieepnrRepercute: fila.ieepnrRepercute ?? false,
    ieepnrPorKg: fila.ieepnrPorKg === null || fila.ieepnrPorKg === undefined ? AJUSTES_FACTURACION_POR_DEFECTO.ieepnrPorKg : Number(fila.ieepnrPorKg),
    ieepnrCuenta: fila.ieepnrCuenta ?? null,
    cuentaPalets: fila.cuentaPalets ?? null,
    vendeCeramica: fila.vendeCeramica ?? false,
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

/** Imagenes de la plantilla B que tiene la empresa (sin leer sus bytes). */
async function imagenesPlantillaB(companyId: string): Promise<{ marca: boolean; sello: boolean }> {
  if (typeof (prisma as unknown as { imagenFactura?: { findMany?: unknown } }).imagenFactura?.findMany !== 'function') return { marca: false, sello: false };
  const tipos = new Set((await prisma.imagenFactura.findMany({ where: { companyId }, select: { tipo: true } })).map((i) => i.tipo));
  return { marca: tipos.has('MARCA'), sello: tipos.has('SELLO') };
}

/** GET: los ajustes con lo que la pantalla necesita para editarlos. */
export async function obtenerAjustesFacturacion(companyId: string): Promise<AjustesFacturacionResp> {
  const [ajustes, perfil, cuentas, imagenes] = await Promise.all([
    leerAjustesFacturacion(companyId),
    perfilEmpresa(companyId),
    cuentasActivas(companyId),
    imagenesPlantillaB(companyId),
  ]);
  // La del cargo de palets se valida al guardarla, pero despues se puede desactivar en el plan.
  const problemaPalets = ajustes.cuentaPalets ? await problemaCuentasLinea(companyId, 'venta', [ajustes.cuentaPalets]) : null;
  // La serie B, solo si vende ceramica (y en Espana). Leer no crea nada: sin ella, 'pendiente'.
  const serieCeramica = perfil.espanola && ajustes.vendeCeramica ? await estadoSerieCeramica(companyId) : null;
  return {
    imagenesPlantillaB: imagenes,
    cuentaPaletsProblema: problemaPalets?.mensaje ?? null,
    serieCeramica,
    ...ajustes,
    irpfDefecto: perfil.espanola ? ajustes.irpfDefecto : 0,
    // El IEEPNR es un impuesto español: fuera de España, nunca.
    ieepnrRepercute: perfil.espanola ? ajustes.ieepnrRepercute : false,
    // La plantilla B es solo para empresas españolas.
    vendeCeramica: perfil.espanola ? ajustes.vendeCeramica : false,
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
    ieepnrRepercute: z.boolean(),
    ieepnrPorKg: z
      .number()
      .gt(0)
      .max(IEEPNR_POR_KG_MAX)
      .refine((v) => Math.abs(Math.round(v * 10000) - v * 10000) < 1e-6),
    ieepnrCuenta: z.string().trim().regex(/^\d{2,15}$/).nullable(),
    cuentaPalets: z.string().trim().regex(/^\d{3,15}$/).nullable(),
    vendeCeramica: z.boolean(),
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
  ieepnrRepercute: 'Indica si repercutes el IEEPNR en tus facturas (sí o no).',
  ieepnrPorKg: `El IEEPNR por kg es un importe en euros mayor que 0 y de ${IEEPNR_POR_KG_MAX} como mucho, con 4 decimales como máximo (por ejemplo, 0,45).`,
  ieepnrCuenta: 'La cuenta del IEEPNR se escribe solo con números (por ejemplo, 4758) o se deja vacía.',
  cuentaPalets: 'La cuenta del cargo de palets se escribe solo con números (por ejemplo, 704) o se deja vacía.',
  vendeCeramica: 'Indica si vendes cerámica y materiales de construcción (sí o no).',
};

/** Cuentas del plan base (PGC) que se copian al plan de la empresa al contabilizar. */
const CUENTAS_BASE = new Set(PGC_BASE.map((n) => n.code));

/**
 * Cuenta del IEEPNR (solo si la empresa fuera contribuyente): del grupo 47
 * (Hacienda) o del 7 (ingresos), y que exista y esté activa en el plan de la
 * empresa (o en el plan base, que se copia al contabilizar). Solo lee: va fuera
 * de cualquier transacción. Devuelve el texto del error o null.
 */
async function problemaCuentaIeepnr(companyId: string, cuenta: string): Promise<string | null> {
  if (!/^(47|7)/.test(cuenta)) return `La cuenta ${cuenta} no sirve para el IEEPNR: tiene que empezar por 47 (Hacienda) o por 7 (ingresos).`;
  const fila = await prisma.chartOfAccounts.findFirst({ where: { companyId, codigo: cuenta }, select: { activo: true } });
  if (fila && !fila.activo) return `La cuenta ${cuenta} está desactivada en tu plan contable.`;
  if (!fila && !CUENTAS_BASE.has(cuenta)) return `La cuenta ${cuenta} no existe en tu plan contable. Créala antes en Contabilidad > Plan contable.`;
  return null;
}

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
    ieepnrRepercute: cambios.ieepnrRepercute ?? actual.ieepnrRepercute,
    ieepnrPorKg: cambios.ieepnrPorKg ?? actual.ieepnrPorKg,
    ieepnrCuenta: cambios.ieepnrCuenta !== undefined ? cambios.ieepnrCuenta || null : actual.ieepnrCuenta,
    cuentaPalets: cambios.cuentaPalets !== undefined ? cambios.cuentaPalets || null : actual.cuentaPalets,
    vendeCeramica: cambios.vendeCeramica ?? actual.vendeCeramica,
  };
  // Fuera de España no hay IRPF, IEEPNR ni plantilla B: se guardan siempre 0 y no.
  if (!perfil.espanola) {
    nuevo.irpfDefecto = 0;
    nuevo.ieepnrRepercute = false;
    nuevo.vendeCeramica = false;
  }

  if (cambios.ieepnrCuenta) {
    const problema = await problemaCuentaIeepnr(companyId, cambios.ieepnrCuenta);
    if (problema) throw badRequest(problema, { campo: 'ieepnrCuenta' });
  }
  // La del cargo de palets, como la de cualquier linea de venta: 70x, en el plan y activa.
  if (cambios.cuentaPalets) {
    const problema = await problemaCuentasLinea(companyId, 'venta', [cambios.cuentaPalets]);
    if (problema) throw badRequest(problema.mensaje, { campo: 'cuentaPalets' });
  }

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
  // Vende ceramica: la serie B, si no existe, se crea ahora (despues de las de siempre).
  const serieCeramica = nuevo.vendeCeramica ? await serieCeramicaAlGuardar(companyId) : null;
  const resp = await obtenerAjustesFacturacion(companyId);
  return serieCeramica ? { ...resp, serieCeramica } : resp;
}

/**
 * Crea la serie B al guardar con «Vendo cerámica» marcada. Los ajustes ya
 * están guardados: si la serie no se puede crear ahora, no se pierden; se avisa
 * y la B se crea sola la próxima vez que se abran las series.
 */
async function serieCeramicaAlGuardar(companyId: string): Promise<SerieCeramica> {
  try {
    return await prepararSerieCeramica(companyId);
  } catch (err) {
    logger.warn('[ajustes-facturacion] No se pudo crear la serie B', { companyId, error: err instanceof Error ? err.message : String(err) });
    return {
      codigo: 'B',
      estado: 'pendiente',
      aviso: 'Los ajustes se han guardado, pero la serie B no se ha podido crear ahora. Se creará sola la próxima vez que abras Configuración > Series.',
    };
  }
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

const sinEspacios = (iban: string | null | undefined) => (iban ?? '').replace(/\s+/g, '').toUpperCase();

/**
 * Cuenta bancaria en la que el cliente debería pagar una factura emitida, para
 * proponerla al registrar el cobro: la del IBAN que se imprimió al emitirla
 * (`ibanCobro`) si sigue activa; si no (factura anterior a esa copia, emitida
 * sin IBAN o con la cuenta ya desactivada), la que saldría hoy en una factura
 * de su moneda (la elegida en los ajustes o la primera activa en esa moneda).
 * null si la empresa no tiene cuentas bancarias activas. Solo lee.
 */
export async function cuentaBancariaDeCobro(
  companyId: string,
  factura: { ibanCobro: string | null; moneda: string },
  db: Db = prisma,
): Promise<string | null> {
  const [ajustes, cuentas] = await Promise.all([leerAjustesFacturacion(companyId, db), cuentasActivas(companyId, db)]);
  const iban = sinEspacios(factura.ibanCobro);
  const impresa = iban ? cuentas.find((c) => sinEspacios(c.iban) === iban) : undefined;
  if (impresa) return impresa.id;
  return cuentaParaFactura(cuentas, { cuentaBancariaId: ajustes.cuentaBancariaId, mostrarIban: true }, factura.moneda)?.id ?? null;
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
