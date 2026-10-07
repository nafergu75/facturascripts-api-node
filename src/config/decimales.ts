import { Prisma } from '@prisma/client';

/**
 * Importes en Decimal (exactos en MySQL), numeros en el codigo.
 *
 * Los importes (bases, cuotas, totales, debe/haber, saldos...) se guardan como
 * DECIMAL(14,2) (precios unitarios DECIMAL(14,4)): con Float, MySQL los
 * guardaba en binario y las sumas arrastraban error. Prisma devuelve esos
 * campos como Prisma.Decimal; para no reescribir todo el codigo ni romper el
 * JSON (Decimal se serializa como texto), se convierten a number al leer.
 *
 * Al escribir basta con pasar number: MySQL redondea al numero de decimales de
 * la columna. Para comparar o cuadrar, usar siempre utils/money (en centimos).
 *
 * Generado a partir de la lista de campos migrados; si se migra un campo nuevo,
 * anadirlo en CAMPOS_DECIMALES y en la extension de resultado.
 */

/** Decimal (o lo que llegue) -> number. null/undefined se respetan. */
export function aNumero<T>(valor: T): T extends Prisma.Decimal ? number : T {
  if (valor instanceof Prisma.Decimal) return valor.toNumber() as never;
  return valor as never;
}

/** Nombres de los campos migrados a Decimal (en cualquier modelo). */
export const CAMPOS_DECIMALES: ReadonlySet<string> = new Set(["baseImponible", "baseLine", "baseTotal", "beneficio", "cuotaIva", "cuotaRetencion", "debe", "descuentoImporte", "gasto", "haber", "importe", "ingresos", "irpfRetenido", "ivaDevengado", "ivaPorcentaje", "ivaImporte", "ivaRepercutido", "ivaTotal", "precio", "precioCompra", "precioUnitario", "retencionImporte", "retencionTotal", "saldoInicial", "totalBruto", "totalFactura", "totalIRPF", "totalLiquido", "totalSeguridadSocialEmpresa", "totalSeguridadSocialTrabajador"]);

/**
 * Recorre un resultado de Prisma y convierte a number los Decimal de los campos
 * migrados. Cubre lo que la extension de resultado no alcanza: agregados
 * (_sum, _avg... de aggregate y groupBy). Otros Decimal (Movement.amount,
 * DocumentoArchivo) se dejan como Decimal: su codigo ya opera con ellos.
 */
export function decimalesANumero(valor: unknown, campo?: string): unknown {
  if (valor instanceof Prisma.Decimal) return campo && CAMPOS_DECIMALES.has(campo) ? valor.toNumber() : valor;
  if (Array.isArray(valor)) return valor.map((v) => decimalesANumero(v, campo));
  if (valor && typeof valor === 'object' && !(valor instanceof Date) && !Buffer.isBuffer(valor)) {
    const obj = valor as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      // En agregados el campo va anidado: { _sum: { importe } }
      obj[k] = decimalesANumero(obj[k], k.startsWith('_') ? undefined : k);
    }
    return obj;
  }
  return valor;
}

/** Extension de resultado: los campos migrados se leen como number (y asi se tipan). */
export const importesComoNumero = Prisma.defineExtension({
  name: 'importes-como-numero',
  result: {
    vencimiento: {
      importe: { needs: { importe: true }, compute: (r) => aNumero(r.importe) },
    },
    cobro: {
      importe: { needs: { importe: true }, compute: (r) => aNumero(r.importe) },
    },
    invoicePayment: {
      importe: { needs: { importe: true }, compute: (r) => aNumero(r.importe) },
    },
    incomeInvoice: {
      baseTotal: { needs: { baseTotal: true }, compute: (r) => aNumero(r.baseTotal) },
      ivaTotal: { needs: { ivaTotal: true }, compute: (r) => aNumero(r.ivaTotal) },
      retencionTotal: { needs: { retencionTotal: true }, compute: (r) => aNumero(r.retencionTotal) },
      totalFactura: { needs: { totalFactura: true }, compute: (r) => aNumero(r.totalFactura) },
    },
    incomeInvoiceLine: {
      precioUnitario: { needs: { precioUnitario: true }, compute: (r) => aNumero(r.precioUnitario) },
      baseLine: { needs: { baseLine: true }, compute: (r) => aNumero(r.baseLine) },
      descuentoImporte: { needs: { descuentoImporte: true }, compute: (r) => aNumero(r.descuentoImporte) },
      ivaImporte: { needs: { ivaImporte: true }, compute: (r) => aNumero(r.ivaImporte) },
      retencionImporte: { needs: { retencionImporte: true }, compute: (r) => aNumero(r.retencionImporte) },
    },
    priorYearData: {
      baseImponible: { needs: { baseImponible: true }, compute: (r) => aNumero(r.baseImponible) },
      ivaDevengado: { needs: { ivaDevengado: true }, compute: (r) => aNumero(r.ivaDevengado) },
      ivaRepercutido: { needs: { ivaRepercutido: true }, compute: (r) => aNumero(r.ivaRepercutido) },
      irpfRetenido: { needs: { irpfRetenido: true }, compute: (r) => aNumero(r.irpfRetenido) },
      gasto: { needs: { gasto: true }, compute: (r) => aNumero(r.gasto) },
      ingresos: { needs: { ingresos: true }, compute: (r) => aNumero(r.ingresos) },
      beneficio: { needs: { beneficio: true }, compute: (r) => aNumero(r.beneficio) },
    },
    journalEntryLine: {
      debe: { needs: { debe: true }, compute: (r) => aNumero(r.debe) },
      haber: { needs: { haber: true }, compute: (r) => aNumero(r.haber) },
    },
    vATBook: {
      baseImponible: { needs: { baseImponible: true }, compute: (r) => aNumero(r.baseImponible) },
      cuotaIva: { needs: { cuotaIva: true }, compute: (r) => aNumero(r.cuotaIva) },
    },
    retentionBook: {
      baseImponible: { needs: { baseImponible: true }, compute: (r) => aNumero(r.baseImponible) },
      cuotaRetencion: { needs: { cuotaRetencion: true }, compute: (r) => aNumero(r.cuotaRetencion) },
    },
    expenseInvoice: {
      baseTotal: { needs: { baseTotal: true }, compute: (r) => aNumero(r.baseTotal) },
      ivaTotal: { needs: { ivaTotal: true }, compute: (r) => aNumero(r.ivaTotal) },
      retencionTotal: { needs: { retencionTotal: true }, compute: (r) => aNumero(r.retencionTotal) },
      totalFactura: { needs: { totalFactura: true }, compute: (r) => aNumero(r.totalFactura) },
    },
    expenseInvoiceLine: {
      precioUnitario: { needs: { precioUnitario: true }, compute: (r) => aNumero(r.precioUnitario) },
      baseLine: { needs: { baseLine: true }, compute: (r) => aNumero(r.baseLine) },
      descuentoImporte: { needs: { descuentoImporte: true }, compute: (r) => aNumero(r.descuentoImporte) },
      ivaImporte: { needs: { ivaImporte: true }, compute: (r) => aNumero(r.ivaImporte) },
      retencionImporte: { needs: { retencionImporte: true }, compute: (r) => aNumero(r.retencionImporte) },
    },
    product: {
      precio: { needs: { precio: true }, compute: (r) => aNumero(r.precio) },
      precioCompra: { needs: { precioCompra: true }, compute: (r) => aNumero(r.precioCompra) },
      ivaPorcentaje: { needs: { ivaPorcentaje: true }, compute: (r) => aNumero(r.ivaPorcentaje) },
    },
    productFamily: {
      ivaPorcentaje: { needs: { ivaPorcentaje: true }, compute: (r) => aNumero(r.ivaPorcentaje) },
    },
    bankAccount: {
      saldoInicial: { needs: { saldoInicial: true }, compute: (r) => aNumero(r.saldoInicial) },
    },
    bankMovement: {
      importe: { needs: { importe: true }, compute: (r) => aNumero(r.importe) },
      ivaPorcentaje: { needs: { ivaPorcentaje: true }, compute: (r) => aNumero(r.ivaPorcentaje) },
    },
    bankMovementSplit: {
      importe: { needs: { importe: true }, compute: (r) => aNumero(r.importe) },
      ivaPorcentaje: { needs: { ivaPorcentaje: true }, compute: (r) => aNumero(r.ivaPorcentaje) },
    },
    treasuryCategory: {
      ivaPorcentaje: { needs: { ivaPorcentaje: true }, compute: (r) => aNumero(r.ivaPorcentaje) },
    },
    nominaResumen: {
      totalBruto: { needs: { totalBruto: true }, compute: (r) => aNumero(r.totalBruto) },
      totalSeguridadSocialEmpresa: { needs: { totalSeguridadSocialEmpresa: true }, compute: (r) => aNumero(r.totalSeguridadSocialEmpresa) },
      totalSeguridadSocialTrabajador: { needs: { totalSeguridadSocialTrabajador: true }, compute: (r) => aNumero(r.totalSeguridadSocialTrabajador) },
      totalIRPF: { needs: { totalIRPF: true }, compute: (r) => aNumero(r.totalIRPF) },
      totalLiquido: { needs: { totalLiquido: true }, compute: (r) => aNumero(r.totalLiquido) },
    },
    nomina: {
      brutoDinerario: { needs: { brutoDinerario: true }, compute: (r) => aNumero(r.brutoDinerario) },
      dietasExentas: { needs: { dietasExentas: true }, compute: (r) => aNumero(r.dietasExentas) },
      especieValoracion: { needs: { especieValoracion: true }, compute: (r) => aNumero(r.especieValoracion) },
      ingresoACuenta: { needs: { ingresoACuenta: true }, compute: (r) => aNumero(r.ingresoACuenta) },
      indemnizacionExenta: { needs: { indemnizacionExenta: true }, compute: (r) => aNumero(r.indemnizacionExenta) },
      indemnizacionSujeta: { needs: { indemnizacionSujeta: true }, compute: (r) => aNumero(r.indemnizacionSujeta) },
      ssTrabajador: { needs: { ssTrabajador: true }, compute: (r) => aNumero(r.ssTrabajador) },
      irpf: { needs: { irpf: true }, compute: (r) => aNumero(r.irpf) },
      porcentajeIrpf: { needs: { porcentajeIrpf: true }, compute: (r) => aNumero(r.porcentajeIrpf) },
      anticipos: { needs: { anticipos: true }, compute: (r) => aNumero(r.anticipos) },
      embargos: { needs: { embargos: true }, compute: (r) => aNumero(r.embargos) },
      otrasDeducciones: { needs: { otrasDeducciones: true }, compute: (r) => aNumero(r.otrasDeducciones) },
      liquido: { needs: { liquido: true }, compute: (r) => aNumero(r.liquido) },
      ssEmpresa: { needs: { ssEmpresa: true }, compute: (r) => aNumero(r.ssEmpresa) },
    },
    empleado: {
      porcentajeIrpfActual: { needs: { porcentajeIrpfActual: true }, compute: (r) => aNumero(r.porcentajeIrpfActual) },
    },
    liquidacionSS: {
      cuotaObrera: { needs: { cuotaObrera: true }, compute: (r) => aNumero(r.cuotaObrera) },
      cuotaPatronal: { needs: { cuotaPatronal: true }, compute: (r) => aNumero(r.cuotaPatronal) },
      totalPrevisto: { needs: { totalPrevisto: true }, compute: (r) => aNumero(r.totalPrevisto) },
      totalRlc: { needs: { totalRlc: true }, compute: (r) => aNumero(r.totalRlc) },
      compensacionIt: { needs: { compensacionIt: true }, compute: (r) => aNumero(r.compensacionIt) },
    },
  },
  query: {
    $allModels: {
      async $allOperations({ args, query }) {
        return decimalesANumero(await query(args));
      },
    },
  },
});

/**
 * Importes de las nominas (Nomina, Empleado y LiquidacionSS): tambien se leen como number en
 * agregados y relaciones anidadas. Se anaden aqui, aparte de la lista general.
 */
export const CAMPOS_DECIMALES_NOMINAS = [
  'brutoDinerario', 'dietasExentas', 'especieValoracion', 'ingresoACuenta', 'indemnizacionExenta', 'indemnizacionSujeta',
  'ssTrabajador', 'irpf', 'porcentajeIrpf', 'anticipos', 'embargos', 'otrasDeducciones', 'liquido', 'ssEmpresa', 'porcentajeIrpfActual',
  // Seguros sociales del mes (LiquidacionSS).
  'cuotaObrera', 'cuotaPatronal', 'totalPrevisto', 'totalRlc', 'compensacionIt',
] as const;
for (const campo of CAMPOS_DECIMALES_NOMINAS) (CAMPOS_DECIMALES as Set<string>).add(campo);
