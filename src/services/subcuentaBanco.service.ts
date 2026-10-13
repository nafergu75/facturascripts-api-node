/**
 * Subcuenta 572 de una cuenta bancaria nueva.
 *
 * - Sin indicarla (el alta rapida desde la ventana de cobro o de pago): la
 *   siguiente libre con la longitud de las subcuentas de la empresa (57200001,
 *   57200002...), dada de alta en el plan con el nombre del banco.
 * - Indicada (Tesoreria > Cuentas bancarias, que propone esa misma siguiente
 *   libre y deja cambiarla): tiene que ser una 572 que no use otra cuenta
 *   bancaria; si no esta en el plan, se da de alta con la longitud de la empresa.
 *
 * Si el plan ya trae subcuentas 572 que no son de ninguna cuenta bancaria (las
 * del plan de la gestoria), el alta rapida no elige por la persona: el saldo de
 * apertura iria a una y los cobros a otra. Se le pide darla de alta en
 * Tesoreria eligiendo su subcuenta.
 *
 * Concurrencia: si dos altas a la vez sacan el mismo codigo, salta el indice
 * unico del plan (P2002) y quien llama repite la transaccion. Con una subcuenta
 * que ya esta en el plan, su fila se bloquea (SELECT ... FOR UPDATE) y la
 * segunda alta espera a la primera y ve que ya es suya.
 */
import { prisma, type ClienteBD, type TransaccionBD } from '../config/database';
import { badRequest, conflict } from '../utils/http-errors';
import { codigoSubcuenta } from './terceros/numeracion';
import { longitudSubcuentasEmpresa } from './terceros/subcuentas';

type Db = ClienteBD | TransaccionBD;

export const PREFIJO_BANCOS = '572';

/** Indice que salta si dos altas sacan la misma subcuenta (para conReintento). */
export const INDICE_SUBCUENTA_BANCO = 'ChartOfAccounts_companyId_codigo';

/** Codigo (details.codigo) del 409 cuando hay subcuentas de bancos en el plan sin cuenta bancaria. */
export const CODIGO_SUBCUENTA_POR_ELEGIR = 'SUBCUENTA_BANCO_POR_ELEGIR';

/** 572 seguida solo de ceros (572, 5720, 57200000): la cuenta de bancos, no la de un banco. */
const esGenerica = (codigo: string) => /^5720*$/.test(codigo);

/**
 * Subcuenta en la que se pueden apuntar los cobros y pagos de un banco: una 572
 * con cifras por debajo de las de agrupacion (572, 5720, 5721 no lo son). Es lo
 * que se exige al cobrar o pagar; las cuentas dadas de alta antes de comprobarlo
 * pueden tener cualquier cosa (por ejemplo «0001»).
 */
export const esSubcuentaDeBanco = (codigo: string) => /^572\d{2,}$/.test(codigo);

/** Agrupacion de los bancos (572, 5720, 5721, 57200000): no se elige para una cuenta nueva. */
const esAgrupacionBancos = (codigo: string) => !esSubcuentaDeBanco(codigo) || esGenerica(codigo);

/** Siguiente subcuenta libre de la 572 con esa longitud: la mayor ocupada + 1 (el 0 no se usa). */
export function siguienteSubcuenta572(ocupadas: Iterable<string>, longitud: number): string {
  let mayor = 0;
  for (const c of ocupadas) {
    if (c.length !== longitud || !c.startsWith(PREFIJO_BANCOS)) continue;
    const resto = c.slice(PREFIJO_BANCOS.length);
    if (/^\d+$/.test(resto)) mayor = Math.max(mayor, Number(resto));
  }
  return codigoSubcuenta(PREFIJO_BANCOS, mayor + 1, longitud);
}

/** Nombre de la subcuenta en el plan: el banco y las cuatro ultimas cifras del IBAN. */
export function nombreSubcuentaBanco(bancoNombre: string | null | undefined, iban: string): string {
  return `${(bancoNombre ?? '').trim() || 'Banco'} …${iban.slice(-4)}`.slice(0, 190);
}

export interface SubcuentasBanco {
  /** Longitud de las subcuentas de la empresa. */
  longitud: number;
  /** La siguiente 572 libre, la que se le pondria a una cuenta nueva. */
  siguiente: string;
  /** Subcuentas 572 del plan que no son de ninguna cuenta bancaria (las trae el plan de la gestoria). */
  sinCuenta: Array<{ codigo: string; nombre: string }>;
}

/** Como estan las 572 de la empresa. Solo lee. */
export async function subcuentasBanco(companyId: string, db: Db = prisma): Promise<SubcuentasBanco> {
  const [plan, cuentas, longitud] = await Promise.all([
    db.chartOfAccounts.findMany({
      where: { companyId, codigo: { startsWith: PREFIJO_BANCOS } },
      select: { codigo: true, nombre: true },
      orderBy: { codigo: 'asc' },
    }),
    db.bankAccount.findMany({ where: { companyId }, select: { subcuentaCodigo: true } }),
    longitudSubcuentasEmpresa(companyId, db),
  ]);
  const usadas = new Set(cuentas.map((c) => c.subcuentaCodigo));
  // Las de 4 cifras (5720, 5721) son agrupaciones; las de un banco van por debajo.
  const sinCuenta = plan.filter((c) => c.codigo.length > 4 && !esGenerica(c.codigo) && !usadas.has(c.codigo));
  return { longitud, siguiente: siguienteSubcuenta572([...plan.map((c) => c.codigo), ...usadas], longitud), sinCuenta };
}

/** Fila del plan de la subcuenta de un banco, colgando de la 572 (o de la 57 o la 5 si el plan no la tiene). */
async function filaDelPlan(tx: TransaccionBD, companyId: string, codigo: string, nombre: string) {
  const padre =
    (await tx.chartOfAccounts.findFirst({ where: { companyId, codigo: PREFIJO_BANCOS } })) ??
    (await tx.chartOfAccounts.findFirst({ where: { companyId, codigo: { in: ['57', '5'] } }, orderBy: { codigo: 'desc' } }));
  return {
    companyId,
    codigo,
    nombre,
    grupo: 5,
    nivel: (padre?.nivel ?? 3) + 1,
    naturaleza: padre?.naturaleza ?? 'ACTIVO',
    tipoUso: padre?.tipoUso ?? 'BALANCE',
    esBasePGC: false,
    esPersonalizadaEmpresa: true,
    parentId: padre?.id ?? null,
    parentCodigo: padre?.codigo ?? PREFIJO_BANCOS,
    notas: 'Subcuenta de una cuenta bancaria (asignada al darla de alta).',
  };
}

/** Da de alta la subcuenta en el plan (si otra alta a la vez saca el mismo codigo, salta el indice unico). */
async function darDeAltaEnPlan(tx: TransaccionBD, companyId: string, codigo: string, nombre: string): Promise<void> {
  await tx.chartOfAccounts.create({ data: await filaDelPlan(tx, companyId, codigo, nombre) });
}

/**
 * Se asegura de que la subcuenta de un banco este en el plan, dentro de la
 * transaccion `tx` (al cobrar o pagar con una cuenta dada de alta cuando aun no
 * se daba de alta en el plan). Si otro cobro a la vez la da de alta, no falla.
 */
export async function asegurarSubcuentaBancoEnPlan(tx: TransaccionBD, companyId: string, codigo: string, nombre: string): Promise<void> {
  if (await tx.chartOfAccounts.findFirst({ where: { companyId, codigo }, select: { id: true } })) return;
  await tx.chartOfAccounts.createMany({ data: [await filaDelPlan(tx, companyId, codigo, nombre)], skipDuplicates: true });
}

/**
 * Elige la subcuenta 572 de una cuenta bancaria nueva y la da de alta en el
 * plan, dentro de la transaccion `tx`. 409 si el plan tiene subcuentas de
 * bancos sin cuenta bancaria: entonces se elige a mano en Tesoreria.
 */
export async function asignarSubcuentaBanco(tx: TransaccionBD, companyId: string, nombre: string): Promise<string> {
  const { siguiente, sinCuenta } = await subcuentasBanco(companyId, tx);
  if (sinCuenta.length) {
    const lista = sinCuenta
      .slice(0, 3)
      .map((c) => `${c.codigo} ${c.nombre}`)
      .join(', ');
    throw conflict(
      `Tu plan contable ya tiene ${sinCuenta.length === 1 ? 'una subcuenta de bancos' : 'subcuentas de bancos'} sin cuenta bancaria (${lista}${sinCuenta.length > 3 ? '…' : ''}). ` +
        'Da de alta la cuenta en Tesorería > Cuentas bancarias y elige su subcuenta, para que el saldo traído y los cobros vayan a la misma.',
      { codigo: CODIGO_SUBCUENTA_POR_ELEGIR, subcuentas: sinCuenta.map((c) => c.codigo) },
    );
  }
  await darDeAltaEnPlan(tx, companyId, siguiente, nombre);
  return siguiente;
}

/**
 * Comprueba la subcuenta que ha escrito la persona y, si no esta en el plan, la
 * da de alta, dentro de la transaccion `tx`. Devuelve el codigo limpio. Errores
 * con `campo: 'subcuentaCodigo'` para enseñarlos junto al campo. `cuentaId`: la
 * cuenta bancaria a la que se le cambia (su propia subcuenta no cuenta como de otra).
 */
export async function usarSubcuentaBanco(
  tx: TransaccionBD,
  companyId: string,
  escrita: string,
  nombre: string,
  opciones: { cuentaId?: string } = {},
): Promise<string> {
  const codigo = escrita.replace(/[\s.]/g, '');
  const campo = { campo: 'subcuentaCodigo' };
  if (!/^572\d{1,9}$/.test(codigo)) {
    throw badRequest('La subcuenta de un banco empieza por 572 y lleva solo cifras, por ejemplo 57200001.', campo);
  }
  if (esAgrupacionBancos(codigo)) {
    const longitud = await longitudSubcuentasEmpresa(companyId, tx);
    throw badRequest(
      `La ${codigo} es la cuenta que agrupa los bancos, no la de un banco. Elige una subcuenta por debajo, por ejemplo ${codigoSubcuenta(PREFIJO_BANCOS, 1, longitud)}.`,
      campo,
    );
  }
  // Lecturas con bloqueo: si la subcuenta ya esta en el plan, su fila queda
  // bloqueada hasta el final y otra alta a la vez con la misma espera y despues
  // ve esta cuenta. Con una subcuenta NUEVA, las dos chocan en el indice unico
  // del plan y la que repite la ve. (Una lectura normal veria la foto de antes.)
  const enPlan = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM ChartOfAccounts WHERE companyId = ${companyId} AND codigo = ${codigo} FOR UPDATE`;
  const deCuentas = await tx.$queryRaw<Array<{ id: string; iban: string }>>`
    SELECT id, iban FROM BankAccount WHERE companyId = ${companyId} AND subcuentaCodigo = ${codigo} FOR UPDATE`;
  const otra = deCuentas.find((c) => c.id !== opciones.cuentaId);
  if (otra) {
    throw badRequest(`La subcuenta ${codigo} ya es de otra cuenta bancaria (IBAN acabado en ${otra.iban.slice(-4)}). Cada cuenta lleva la suya.`, campo);
  }
  if (enPlan.length) return codigo;
  const longitud = await longitudSubcuentasEmpresa(companyId, tx);
  if (codigo.length !== longitud) {
    throw badRequest(
      `Las subcuentas de tu plan tienen ${longitud} cifras y ${codigo} tiene ${codigo.length}. Escribe una de ${longitud}, por ejemplo ${codigoSubcuenta(PREFIJO_BANCOS, 1, longitud)}.`,
      campo,
    );
  }
  await darDeAltaEnPlan(tx, companyId, codigo, nombre);
  return codigo;
}
