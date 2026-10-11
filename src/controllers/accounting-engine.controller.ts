/**
 * CONTROLADOR DEL MOTOR CONTABLE - Orquestador
 *
 * Responsabilidades:
 * - Orquestar llamadas al motor contable (AccountingEngineService)
 * - Gestionar transacciones atómicas con Prisma
 * - Validar datos (empresa, plan contable, reglas)
 * - Retornar errores claros para usuarios no-contables
 * - Registrar auditoría de todas las operaciones
 */

import { badRequest, conflict, notFound, notImplemented } from '../utils/http-errors';
import { registrarAuditoria } from '../services/auditoria.service';
import { accountingEngineService, desgloseIvaPorTipo } from '../services/accounting-engine.service';
import { prisma, type TransaccionBD } from '../config/database';
import { basePorCuenta, nombresDeCuentas } from '../services/cuentasLinea.service';
import { cuadraEnCentimos } from '../utils/money';
import { asegurarPlanContableEmpresa } from '../services/chart-of-accounts.service';
import { comprobarFechaAbierta, periodoNoAbierto } from '../services/periodos.service';
import { perfilEmpresa } from '../services/perfilEmpresa.service';
import { motivoSinTipoFijado, notaDivisa } from '../domain/divisas';
import { esTipoOperacion, fechaDevengoVenta } from '../domain/tipo-operacion.model';
import { fechaContableGasto } from '../domain/factura-gasto.model';
import { cuentaAcreedorDePagos, datosContablesGastoConSubcuenta, motivoPeriodoBloqueado, retencionDe } from '../services/expense-invoices.service';
import { conReintentoSubcuenta, fichaDeSubcuenta, subcuentaClienteParaApunte, type FichaDeSubcuenta } from '../services/terceros/subcuentas';
import { esSubcuentaGenerica } from '../services/terceros/numeracion';

/** Mismo cliente o proveedor. */
const mismaFicha = (a: { tipo: string; id: string } | null | undefined, b: { tipo: string; id: string } | null | undefined) =>
  !!a && !!b && a.tipo === b.tipo && a.id === b.id;

/**
 * Al cambiar la cuenta de una linea de cliente (43x) o de proveedor (40x/41x)
 * de un borrador, la nueva tiene que ser del mismo grupo y del MISMO tercero:
 * la deuda no se pasa a otro cliente o proveedor desde aqui. En proveedores,
 * su subcuenta (400N o 410N) o la generica; en clientes, una 43x que no sea de
 * otro cliente. Y cualquier otra linea (700, 477, 572...) solo puede pasar a la
 * subcuenta de un cliente o proveedor si es el del asiento (el de su factura o
 * el de otra de sus lineas); en un asiento sin tercero, a la de cualquiera.
 * Devuelve el texto del error o null.
 */
async function problemaCuentaTercero(
  companyId: string,
  asiento: { invoiceId: string | null; invoiceType: string | null; origen: string; lineas: Array<{ id: string; accountCode: string }> },
  lineaId: string,
  original: string,
  nueva: string,
): Promise<string | null> {
  const esCliente = original.startsWith('43');
  const esProveedor = /^4[01]/.test(original);
  if (esCliente && !nueva.startsWith('43')) return `Esta línea es la del cliente (${original}): solo puede ir a una cuenta de clientes (43).`;
  if (esProveedor && !/^4[01]/.test(nueva)) return `Esta línea es la del proveedor (${original}): solo puede ir a una cuenta de proveedores o acreedores (400 o 410).`;
  const fichas = await fichaDeSubcuenta(companyId);
  const deLaNueva: FichaDeSubcuenta | undefined = fichas.get(nueva);
  if (!esCliente && !esProveedor && !deLaNueva) return null;
  let deLaLinea: { tipo: string; id: string } | null = fichas.get(original) ?? null;
  if (!deLaLinea && asiento.invoiceId) {
    if (asiento.invoiceType === 'GASTO' || asiento.origen === 'FACTURA_GASTO') {
      const f = await prisma.expenseInvoice.findFirst({ where: { id: asiento.invoiceId, companyId }, select: { supplierId: true } });
      if (f) deLaLinea = { tipo: 'proveedor', id: f.supplierId };
    } else {
      const f = await prisma.incomeInvoice.findFirst({ where: { id: asiento.invoiceId, companyId }, select: { customerId: true } });
      if (f) deLaLinea = { tipo: 'cliente', id: f.customerId };
    }
  }
  if (!esCliente && !esProveedor) {
    // Linea que no es de tercero: el tercero del asiento sale de la factura o de otra linea.
    const delAsiento = deLaLinea ?? asiento.lineas.filter((l) => l.id !== lineaId).map((l) => fichas.get(l.accountCode)).find((f) => !!f) ?? null;
    return delAsiento && !mismaFicha(deLaNueva, delAsiento)
      ? `La subcuenta ${nueva} es de ${deLaNueva!.nombre}, no del cliente o proveedor de este asiento.`
      : null;
  }
  if (esCliente) {
    if (deLaNueva && deLaLinea && !mismaFicha(deLaNueva, deLaLinea)) return `La subcuenta ${nueva} es de ${deLaNueva.nombre}, no del cliente de este asiento.`;
    return null;
  }
  if (esSubcuentaGenerica(nueva) || mismaFicha(deLaNueva, deLaLinea)) return null;
  return deLaNueva
    ? `La subcuenta ${nueva} es de ${deLaNueva.nombre}, no del proveedor de este asiento.`
    : `La cuenta ${nueva} no es una subcuenta del proveedor de este asiento: usa la suya (400 o 410) o la genérica.`;
}

/**
 * Base de la venta por cuenta de ingresos (la de cada linea; sin ella, la 700),
 * con el nombre del plan. undefined si ninguna linea lleva cuenta: el asiento
 * de siempre, todo a la 700 «Ventas».
 */
async function ingresosPorCuenta(
  tx: TransaccionBD,
  companyId: string,
  lineas: Array<{ accountCode: string | null; baseLine: number }>,
): Promise<Array<{ cuenta: string; nombre: string; base: number }> | undefined> {
  if (!lineas.some((l) => l.accountCode)) return undefined;
  const reparto = basePorCuenta(lineas.map((l) => ({ cuenta: l.accountCode, base: Number(l.baseLine) })), '700');
  const nombres = await nombresDeCuentas(tx, companyId, reparto.map((r) => r.cuenta));
  return reparto.map((r) => ({ ...r, nombre: nombres.get(r.cuenta) ?? 'Ventas' }));
}

export class AccountingEngineController {
  /**
   * Contabilizar factura de ingreso (VENTA)
   *
   * Genera automáticamente un asiento contable con:
   * - Cliente (DEBE)
   * - Ventas (HABER)
   * - IVA repercutido (HABER)
   * - IRPF retenido (DEBE) [si aplica]
   *
   * Estado inicial: DRAFT o PENDING_REVIEW según mode
   */
  async contabilizarFacturaIngreso(
    companyId: string,
    invoiceId: string,
    mode: 'AUTO' | 'MANUAL' = 'AUTO',
  ): Promise<{
    journalEntryId: string;
    estado: 'POSTED' | 'DRAFT' | 'PENDING_REVIEW';
    advertencias?: string[];
  }> {
    try {
      // Validar empresa existe
      const empresa = await prisma.company.findUnique({
        where: { id: companyId },
      });
      if (!empresa) {
        throw badRequest('Empresa no encontrada.');
      }

      // El plan de cuentas se crea (o se completa) solo: antes se exigia que un
      // admin lo inicializara a mano y, si no, no se podia contabilizar nada.
      await asegurarPlanContableEmpresa(companyId);

      // Obtener factura de ingreso
      const factura = await prisma.incomeInvoice.findUnique({
        where: { id: invoiceId },
        include: { customer: true, lineas: true, readerDocument: { select: { id: true } } },
      });
      if (!factura || factura.companyId !== companyId) {
        throw notFound(`Factura de ingreso ${invoiceId} no encontrada.`);
      }
      // Las facturas emitidas en la app se contabilizan en firme; las que vienen
      // del lector OCR quedan en borrador hasta revisarlas en Motor contable.
      const desdeOcr = !!factura.readerDocument;
      if (factura.estadoDocumento !== 'FINAL') {
        throw badRequest('La factura está en borrador: emítela antes de contabilizarla.');
      }
      // En otra moneda solo con el tipo de cambio fijado: si no, sus importes en
      // la moneda de cuenta no son de fiar y no se llevan a la contabilidad.
      const { monedaCuenta } = await perfilEmpresa(companyId);
      const sinTipo = motivoSinTipoFijado(factura, monedaCuenta);
      if (sinTipo) throw badRequest(sinTipo);

      // Validar que no esté ya contabilizada
      // Los asientos de cobro (TESORERIA) tambien llevan invoiceId: no cuentan.
      const entryExistente = await prisma.journalEntry.findFirst({
        where: {
          companyId,
          invoiceId,
          origen: { not: 'TESORERIA' },
          estado: { in: ['POSTED', 'PENDING_REVIEW', 'DRAFT'] },
        },
      });
      if (entryExistente) {
        throw badRequest(`Esta factura ya ha sido contabilizada (asiento: ${entryExistente.id}).`);
      }
      // Ni en un mes bloqueado ni en un ejercicio cerrado (tambien desde el hook AUTO).
      await comprobarFechaAbierta(companyId, factura.fechaEmision, 'contabilizar la factura');

      // Transacción atómica: subcuenta del cliente (430N, asignada y en el plan
      // si falta) + asiento + líneas + VATBook. Las rectificativas van a la del
      // cliente de la original (es el mismo customerId).
      const result = await conReintentoSubcuenta(() => prisma.$transaction(async (tx) => {
        const cliente = await subcuentaClienteParaApunte(tx, companyId, factura.customerId);
        const ingresoPorCuenta = await ingresosPorCuenta(tx, companyId, factura.lineas);
        const asiento = await accountingEngineService.contabilizarFacturaIngreso(
          companyId,
          invoiceId,
          {
            baseTotal: factura.baseTotal,
            ivaTotal: factura.ivaTotal,
            ivaRate: factura.lineas[0]?.tipoIva ?? 21,
            retencionTotal: factura.retencionTotal,
            retencionRate: factura.lineas[0]?.tipoRetencion ?? 0,
            desgloseIva: desgloseIvaPorTipo(factura.lineas),
            totalFactura: factura.totalFactura,
            fechaEmision: factura.fechaEmision,
            fechaDevengo: fechaDevengoVenta(factura),
            numeroFactura: factura.numeroCompleto ?? '',
            clienteId: factura.customerId,
            clienteNif: factura.customer.nifCif,
            clienteNombre: factura.customer.nombreFiscal,
            cuentaCliente: cliente.codigo,
            nombreCuentaCliente: cliente.nombre,
            ...(ingresoPorCuenta ? { ingresoPorCuenta } : {}),
            clientePais: factura.customer.pais,
            // El tipo guardado; las facturas anteriores (sin tipo) se contabilizan como siempre.
            tipoOperacion: esTipoOperacion(factura.tipoOperacion) ? factura.tipoOperacion : undefined,
            causaExencion: factura.causaExencion,
            notaDescripcion: notaDivisa(factura, monedaCuenta),
            estadoAsiento: desdeOcr ? 'DRAFT' : 'POSTED',
          },
          tx,
        );

        // El `estado` de una factura de venta es su estado de COBRO (PENDING,
        // PAID, OVERDUE): contabilizarla no lo cambia. Antes se ponia ACCOUNTED y
        // la factura dejaba de verse como pendiente de cobro.

        return asiento;
      }));

      // Auditoría
      await registrarAuditoria({
        userId: 'SYSTEM',
        companyId,
        action: 'CONTABILIZAR_FACTURA_INGRESO_AUTO',
        resourceType: 'IncomeInvoice',
        resourceId: invoiceId,
        meta: { journalEntryId: result.asientoId, modo: mode },
      });

      return {
        journalEntryId: result.asientoId,
        estado: desdeOcr ? 'DRAFT' : 'POSTED',
        advertencias: [],
      };
    } catch (err) {
      if (err instanceof Error && 'statusCode' in err) {
        throw err;
      }
      throw badRequest(
        `Error contabilizando factura: ${err instanceof Error ? err.message : 'desconocido'}`
      );
    }
  }

  /**
   * Contabilizar factura de gasto (COMPRA/SERVICIO)
   *
   * Genera asiento PGC de gastos:
   * - 600/622/621/623 DEBE  (gasto según tipoGasto)
   * - 472             DEBE  (IVA soportado deducible)
   * - 4751            HABER (IRPF retenido al proveedor, deuda con AEAT — si aplica)
   * - 400             HABER (proveedor acreedor = base + IVA - retención)
   */
  async contabilizarFacturaGasto(
    companyId: string,
    invoiceId: string,
    mode: 'AUTO' | 'MANUAL' = 'AUTO',
  ): Promise<{
    journalEntryId: string;
    estado: 'POSTED' | 'DRAFT' | 'PENDING_REVIEW';
    advertencias?: string[];
  }> {
    try {
      // Validar empresa
      const empresa = await prisma.company.findUnique({ where: { id: companyId } });
      if (!empresa) throw badRequest('Empresa no encontrada.');

      // El plan de cuentas se crea (o se completa) solo: antes se exigia que un
      // admin lo inicializara a mano y, si no, no se podia contabilizar nada.
      await asegurarPlanContableEmpresa(companyId);

      // Obtener factura de gasto con proveedor
      const factura = await prisma.expenseInvoice.findUnique({
        where: { id: invoiceId },
        include: { supplier: true, lineas: true },
      });
      if (!factura || factura.companyId !== companyId) {
        throw notFound(`Factura de gasto ${invoiceId} no encontrada.`);
      }

      // Validar estado contabilizable. Las facturas de gasto se crean PENDING u
      // OVERDUE (segun su vencimiento): tambien se contabilizan. Solo se rechaza
      // la que ya esta contabilizada.
      if (factura.estado === 'ACCOUNTED') {
        throw badRequest(
          `La factura de gasto está en estado "${factura.estado}" (ya contabilizada) y no puede contabilizarse otra vez.`,
        );
      }
      if (factura.estado === 'ANULADA' || factura.estado === 'DRAFT') {
        throw badRequest(
          factura.estado === 'ANULADA'
            ? 'La factura está anulada: no se contabiliza.'
            : 'La factura está pendiente de revisar: su asiento en borrador está en el Motor contable.',
        );
      }

      // Evitar doble contabilización
      const entryExistente = await prisma.journalEntry.findFirst({
        where: {
          companyId,
          invoiceId,
          invoiceType: 'GASTO',
          origen: { not: 'TESORERIA' },
          estado: { in: ['POSTED', 'PENDING_REVIEW', 'DRAFT'] },
        },
      });
      if (entryExistente) {
        throw badRequest(`Esta factura de gasto ya ha sido contabilizada (asiento: ${entryExistente.id}).`);
      }
      // Ni en un mes bloqueado ni en un ejercicio cerrado. Cuenta la fecha del
      // asiento (la de registro si se recibio mas tarde), no la de expedicion.
      await comprobarFechaAbierta(companyId, fechaContableGasto(factura), 'contabilizar la factura de gasto');

      // Transacción atómica: crear asiento + líneas + VATBook + RetentionBook + marcar factura
      // Los mismos datos que el alta: la fecha de registro (si se recibio mas
      // tarde), la cuenta de cada linea, la base de las lineas con retencion y,
      // si ya tiene pagos, la cuenta del proveedor que usaron (400 o 410).
      // Sin pagos, la subcuenta del proveedor (400N o 410N segun el tipo de gasto).
      const cuentaAcreedor = await cuentaAcreedorDePagos(companyId, invoiceId);
      const result = await conReintentoSubcuenta(() => prisma.$transaction(async (tx) => {
        const asiento = await accountingEngineService.contabilizarFacturaGasto(
          companyId,
          invoiceId,
          await datosContablesGastoConSubcuenta(tx, companyId, factura, factura.supplier, { estadoAsiento: 'POSTED', cuentaAcreedor }),
          tx,
        );

        await tx.expenseInvoice.update({
          where: { id: invoiceId },
          data: { estado: 'ACCOUNTED' },
        });

        return asiento;
      }));

      // Auditoría
      await registrarAuditoria({
        userId: 'SYSTEM',
        companyId,
        action: 'CONTABILIZAR_FACTURA_GASTO_AUTO',
        resourceType: 'ExpenseInvoice',
        resourceId: invoiceId,
        meta: { journalEntryId: result.asientoId, modo: mode },
      });

      return {
        journalEntryId: result.asientoId,
        estado: 'POSTED',
        advertencias: [],
      };
    } catch (err) {
      if (err instanceof Error && 'statusCode' in err) throw err;
      throw badRequest(`Error contabilizando gasto: ${err instanceof Error ? err.message : 'desconocido'}`);
    }
  }

  /**
   * Aprobar un asiento (PENDING_REVIEW → POSTED)
   *
   * Transiciona un asiento a estado definitivo.
   * Validaciones finales:
   * - Asiento en PENDING_REVIEW
   * - Debe = Haber
   * - Todas las cuentas existen y activas
   */
  async aprobarAsiento(
    companyId: string,
    journalEntryId: string,
    userId: string,
    observaciones?: string,
  ): Promise<{
    journalEntryId: string;
    estado: 'POSTED';
    contabilizadoEn: Date;
  }> {
    try {
      // Obtener asiento
      const asiento = await prisma.journalEntry.findFirst({
        where: { id: journalEntryId, companyId },
        include: { lineas: true },
      });

      if (!asiento) {
        throw notFound(`Asiento ${journalEntryId} no encontrado.`);
      }

      // Validar estado: los asientos AUTO se crean en DRAFT y los MANUAL en
      // PENDING_REVIEW; ambos son aprobables (mismo criterio que ajustarLineaAsiento).
      if (!['DRAFT', 'PENDING_REVIEW'].includes(asiento.estado)) {
        throw badRequest(
          `No se puede aprobar un asiento en estado ${asiento.estado}. Solo se pueden aprobar asientos en DRAFT o PENDING_REVIEW.`
        );
      }

      // Un borrador (p. ej. del lector) no pasa a definitivo en un mes bloqueado
      // ni en un ejercicio cerrado. El de una factura de gasto tampoco en un
      // periodo con el 303 (o el 111/115) ya presentado; para ese, un 409 que
      // lleva a la factura: su fecha de registro (si se recibio mas tarde) se
      // cambia, la fecha que puso el proveedor no.
      const fechaAsiento = asiento.fecha.toISOString().slice(0, 10);
      const gasto =
        asiento.origen === 'FACTURA_GASTO' && asiento.invoiceId
          ? await prisma.expenseInvoice.findFirst({
              where: { id: asiento.invoiceId, companyId },
              select: { tipoGasto: true, retencionTotal: true },
            })
          : null;
      if (gasto && asiento.invoiceId) {
        const motivo = await motivoPeriodoBloqueado(companyId, fechaAsiento, retencionDe(gasto));
        if (motivo) {
          // campo y facturaId: la pantalla abre la factura con «¿La recibiste más tarde?» desplegado.
          const periodo = await periodoNoAbierto(companyId, fechaAsiento);
          const siTeLlego = !periodo
            ? ''
            : periodo.motivo === 'periodo_bloqueado'
              ? ' Si te llegó en ese mes, desbloquéalo antes en Configuración > Ejercicios y periodos.'
              : ' Si te llegó en ese periodo, consúltalo con tu asesor: está cerrado.';
          throw conflict(
            `${motivo}: modifica la factura y, si la recibiste más tarde, pon en «¿La recibiste más tarde?» la fecha en que te llegó, de un periodo abierto y sin presentar. Después aprueba el asiento.${siTeLlego}`,
            { campo: 'fechaRegistro', facturaId: asiento.invoiceId },
          );
        }
      } else {
        await comprobarFechaAbierta(companyId, fechaAsiento, 'aprobar el asiento');
      }

      // Validar debe = haber
      const totalDebe = asiento.lineas.reduce((s, l) => s + (l.debe || 0), 0);
      const totalHaber = asiento.lineas.reduce((s, l) => s + (l.haber || 0), 0);
      if (!cuadraEnCentimos(totalDebe, totalHaber)) {
        throw badRequest(
          `Asiento desequilibrado: debe ${totalDebe} ≠ haber ${totalHaber}. Contacta al equipo de soporte.`
        );
      }

      // Validar todas las cuentas existen y están activas
      for (const linea of asiento.lineas) {
        const cuenta = await prisma.chartOfAccounts.findFirst({
          where: {
            companyId,
            codigo: linea.accountCode,
          },
        });
        if (!cuenta) {
          throw badRequest(
            `Cuenta PGC ${linea.accountCode} no encontrada. No se puede contabilizar.`
          );
        }
        if (!cuenta.activo) {
          throw badRequest(
            `Cuenta PGC ${linea.accountCode} está inactiva. Solicita a tu asesor que la active.`
          );
        }
      }

      // Actualizar estado. Si es el borrador de una factura de gasto del lector,
      // la factura pasa a contabilizada en la misma transaccion.
      const ahora = new Date();
      await prisma.$transaction(async (tx) => {
        await tx.journalEntry.update({
          where: { id: journalEntryId },
          data: {
            estado: 'POSTED',
            updatedAt: ahora,
          },
        });
        if (asiento.origen === 'FACTURA_GASTO') {
          await tx.expenseInvoice.updateMany({
            where: { id: asiento.invoiceId ?? '', companyId, estado: 'DRAFT' },
            data: { estado: 'ACCOUNTED' },
          });
        }
      });

      // Auditoría
      await registrarAuditoria({
        userId,
        companyId,
        action: 'APROBAR_ASIENTO',
        resourceType: 'JournalEntry',
        resourceId: journalEntryId,
        meta: { observaciones },
      });

      return {
        journalEntryId,
        estado: 'POSTED',
        contabilizadoEn: ahora,
      };
    } catch (err) {
      if (err instanceof Error && 'statusCode' in err) {
        throw err;
      }
      throw badRequest(`Error aprobando asiento: ${err instanceof Error ? err.message : ''}`);
    }
  }

  /**
   * Recalcular un asiento (si factura fue modificada)
   *
   * Flujo:
   * 1. Busca asiento anterior (POSTED o PENDING_REVIEW)
   * 2. Crea reversión (líneas opuestas, estado POSTED inmediato)
   * 3. Marca anterior como REVERSED
   * 4. Genera nuevo asiento (PENDING_REVIEW) con datos corregidos
   *
   * TODO: Completar la generación del nuevo asiento llamando a contabilizar nuevamente
   */
  async recalcularAsiento(
    companyId: string,
    journalEntryId: string,
    userId: string,
  ): Promise<{
    asientoReversado: string;
    asientoNuevo: string;
    estado: 'PENDING_REVIEW';
  }> {
    // Funcionalidad pendiente de implementar: la generación del nuevo asiento con
    // las líneas corregidas requiere recuperar los datos actualizados de la factura
    // y volver a pasar por el motor contable. Hasta que no esté completa, bloqueamos
    // la ruta para evitar crear asientos vacíos que corrompen la contabilidad.
    throw notImplemented(
      'Recalcular asiento no está disponible en esta versión. ' +
      'Para corregir un asiento, use "Ajustar línea" en el detalle del asiento.'
    );
  }

  /**
   * Obtener asiento con contexto completo
   *
   * Retorna:
   * - Asiento + líneas
   * - Factura asociada
   * - Validaciones (debe=haber, cuentas, etc.)
   * - Permisos (permitidoAprobar, permitidoAjustar)
   */
  async obtenerAsientoDetallado(
    companyId: string,
    journalEntryId: string,
  ): Promise<{
    asiento: any;
    lineas: any[];
    factura?: any;
    validaciones: {
      cuadrado: boolean;
      errores: string[];
      advertencias: string[];
    };
    permitidoAprobar: boolean;
    permitidoAjustar: boolean;
  }> {
    try {
      const asiento = await prisma.journalEntry.findFirst({
        where: { id: journalEntryId, companyId },
        include: { lineas: true },
      });

      if (!asiento) {
        throw notFound(`Asiento ${journalEntryId} no encontrado.`);
      }

      // Obtener factura asociada buscando en la tabla correcta según invoiceType
      let factura: any = null;
      if (asiento.invoiceId) {
        if (asiento.invoiceType === 'GASTO' || asiento.origen === 'FACTURA_GASTO') {
          factura = await prisma.expenseInvoice.findUnique({
            where: { id: asiento.invoiceId },
            include: { supplier: true },
          });
        } else {
          factura = await prisma.incomeInvoice.findUnique({
            where: { id: asiento.invoiceId },
            include: { customer: true },
          });
        }
      }

      // Validar debe = haber
      const totalDebe = asiento.lineas.reduce((s: number, l: any) => s + (l.debe || 0), 0);
      const totalHaber = asiento.lineas.reduce((s: number, l: any) => s + (l.haber || 0), 0);
      const cuadrado = cuadraEnCentimos(totalDebe, totalHaber);

      const errores: string[] = [];
      if (!cuadrado) {
        errores.push(
          `Asiento desequilibrado: debe ${totalDebe} ≠ haber ${totalHaber}`
        );
      }

      return {
        asiento,
        lineas: asiento.lineas,
        factura,
        validaciones: {
          cuadrado,
          errores,
          advertencias: [],
        },
        // Lo mismo que acepta aprobarAsiento.
        permitidoAprobar: ['DRAFT', 'PENDING_REVIEW'].includes(asiento.estado),
        permitidoAjustar: ['DRAFT', 'PENDING_REVIEW'].includes(asiento.estado),
      };
    } catch (err) {
      if (err instanceof Error && 'statusCode' in err) {
        throw err;
      }
      throw badRequest(`Error obteniendo asiento: ${err instanceof Error ? err.message : ''}`);
    }
  }

  /**
   * Listar asientos con filtros
   *
   * Filtros:
   * - estado: DRAFT, PENDING_REVIEW, POSTED, REVERSED
   * - desde/hasta: rango de fechas
   * - origen: INCOME_INVOICE, EXPENSE_INVOICE, etc.
   */
  async listarAsientos(
    companyId: string,
    filtros: {
      estado?: string;
      desde?: string;
      hasta?: string;
      origen?: string;
    },
  ): Promise<any[]> {
    try {
      const where: any = { companyId };

      if (filtros.estado) {
        where.estado = filtros.estado;
      }
      if (filtros.origen) {
        where.origen = filtros.origen;
      }
      if (filtros.desde || filtros.hasta) {
        where.fecha = {};
        if (filtros.desde) {
          where.fecha.gte = new Date(filtros.desde);
        }
        if (filtros.hasta) {
          where.fecha.lte = new Date(filtros.hasta);
        }
      }

      return prisma.journalEntry.findMany({
        where,
        include: { lineas: true },
        orderBy: { fecha: 'desc' },
      });
    } catch (err) {
      throw badRequest(`Error listando asientos: ${err instanceof Error ? err.message : ''}`);
    }
  }

  /**
   * Ajustar línea de asiento (cambiar cuenta, debe/haber)
   *
   * Restricciones:
   * - Solo si asiento en DRAFT o PENDING_REVIEW
   * - Después de ajuste, debe = haber (validación)
   * - Auditoría del cambio
   */
  async ajustarLineaAsiento(
    companyId: string,
    journalEntryId: string,
    lineId: string,
    cambios: { accountCode?: string; debe?: number; haber?: number },
    userId: string,
  ): Promise<{
    lineaActualizada: any;
    asientoValidado: boolean;
  }> {
    try {
      // Obtener asiento
      const asiento = await prisma.journalEntry.findFirst({
        where: { id: journalEntryId, companyId },
        include: { lineas: true },
      });

      if (!asiento) {
        throw notFound(`Asiento ${journalEntryId} no encontrado.`);
      }

      // Validar que la línea pertenece a este asiento
      const lineaExiste = asiento.lineas.some((l) => l.id === lineId);
      if (!lineaExiste) {
        throw notFound(`Línea ${lineId} no pertenece a este asiento.`);
      }

      // Validar estado
      if (!['DRAFT', 'PENDING_REVIEW'].includes(asiento.estado)) {
        throw badRequest(
          `No se puede ajustar un asiento en estado ${asiento.estado}. Solo se pueden ajustar asientos en DRAFT o PENDING_REVIEW.`
        );
      }

      // Solo cuenta, debe y haber. La cuenta tiene que existir y estar activa en
      // el plan (su nombre pasa a la linea); la de un cliente o proveedor, del
      // mismo tercero (problemaCuentaTercero).
      const linea = asiento.lineas.find((l) => l.id === lineId)!;
      const data: { accountCode?: string; accountName?: string; debe?: number; haber?: number } = {};
      if (cambios.accountCode !== undefined && String(cambios.accountCode).trim() !== linea.accountCode) {
        const codigo = String(cambios.accountCode).trim();
        if (/^\d{1,2}$/.test(codigo)) {
          throw badRequest(`La ${codigo} es un grupo o subgrupo del plan y no lleva apuntes: elige una cuenta de 3 o más dígitos.`);
        }
        const cuenta = codigo ? await prisma.chartOfAccounts.findFirst({ where: { companyId, codigo }, select: { nombre: true, activo: true } }) : null;
        if (!cuenta) throw badRequest(`La cuenta ${codigo || '(vacía)'} no está en el plan contable de la empresa.`);
        if (!cuenta.activo) throw badRequest(`La cuenta ${codigo} está desactivada en el plan contable.`);
        const problema = await problemaCuentaTercero(companyId, asiento, lineId, linea.accountCode, codigo);
        if (problema) throw badRequest(problema);
        data.accountCode = codigo;
        data.accountName = cuenta.nombre.slice(0, 190);
      }
      for (const campo of ['debe', 'haber'] as const) {
        if (cambios[campo] === undefined) continue;
        const n = Number(cambios[campo]);
        if (!Number.isFinite(n)) throw badRequest(`El ${campo} no es un número.`);
        data[campo] = Math.round(n * 100) / 100;
      }

      // Debe = haber con el cambio aplicado, ANTES de guardarlo (antes se
      // guardaba y luego se avisaba, y el asiento quedaba descuadrado).
      const conCambio = asiento.lineas.map((l) => (l.id === lineId ? { ...l, ...data } : l));
      const totalDebe = conCambio.reduce((s, l) => s + (l.debe || 0), 0);
      const totalHaber = conCambio.reduce((s, l) => s + (l.haber || 0), 0);
      const cuadrado = cuadraEnCentimos(totalDebe, totalHaber);
      if (!cuadrado) {
        throw badRequest(
          `Ajuste desequilibra el asiento: debe ${totalDebe} ≠ haber ${totalHaber}`
        );
      }

      // Actualizar línea
      const lineaActualizada = await prisma.journalEntryLine.update({
        where: { id: lineId },
        data,
      });

      // Auditoría
      await registrarAuditoria({
        userId,
        companyId,
        action: 'AJUSTAR_LINEA_ASIENTO',
        resourceType: 'JournalEntryLine',
        resourceId: lineId,
        meta: { cambios },
      });

      return {
        lineaActualizada,
        asientoValidado: cuadrado,
      };
    } catch (err) {
      if (err instanceof Error && 'statusCode' in err) {
        throw err;
      }
      throw badRequest(`Error ajustando línea: ${err instanceof Error ? err.message : ''}`);
    }
  }
}

export const accountingEngineController = new AccountingEngineController();
