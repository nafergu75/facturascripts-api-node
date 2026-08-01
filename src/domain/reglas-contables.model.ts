/**
 * Reglas contables configurables por empresa.
 *
 * Permiten que la generacion de asientos (ventas/compras, IVA, tercero,
 * tesoreria) se adapte a cada empresa sin tocar codigo. Se almacenaran en la BD
 * propia (Prisma) por companyId en una iteracion posterior.
 *
 * Las subcuentas siguen el PGC español (ej. 700000 ventas, 477000 IVA
 * repercutido, 430000 clientes, 572000 bancos), pero son libres por empresa.
 */
export interface ReglasContablesEmpresa {
  /** familia de producto -> subcuenta de ventas (ej. "SERVICIOS" -> "700000"). */
  cuentasVentasPorFamilia?: Record<string, string>;

  /** familia de producto -> subcuenta de compras. */
  cuentasComprasPorFamilia?: Record<string, string>;

  /** tipo de IVA (%) -> subcuenta de IVA repercutido (ej. 21 -> "477000"). */
  cuentasIvaRepercutidoPorTipo: Record<number, string>;

  /** tipo de IVA (%) -> subcuenta de IVA soportado (ej. 21 -> "472000"). */
  cuentasIvaSoportadoPorTipo: Record<number, string>;

  /** forma de pago -> subcuenta de tesoreria (ej. "CONTADO" -> "570000"). */
  cuentasTesoreriaPorFormaPago: Record<string, string>;

  /** tipo de recargo de equivalencia (%) -> subcuenta (ej. 5.2 -> "477500"). */
  cuentasRecargoEquivalenciaPorTipo?: Record<number, string>;

  /** Subcuentas por defecto cuando no hay mapeo especifico. */
  cuentaVentasPorDefecto: string;
  cuentaComprasPorDefecto: string;
  cuentaClientesPorDefecto: string;
  cuentaProveedoresPorDefecto: string;
  /** Subcuenta de tesoreria por defecto (cobros/pagos sin forma de pago mapeada). */
  cuentaTesoreriaPorDefecto: string;
  /** HP acreedora por retenciones IRPF practicadas a profesionales (compras). */
  cuentaRetencionesProfesionales: string;
  /** HP deudora por retenciones IRPF soportadas en nuestras ventas (si aplica). */
  cuentaRetencionesSoportadas: string;
}

/**
 * Reglas por defecto (PGC España simplificado). Util como semilla y en tests.
 */
export function reglasPorDefecto(): ReglasContablesEmpresa {
  return {
    cuentasVentasPorFamilia: {},
    cuentasComprasPorFamilia: {},
    cuentasIvaRepercutidoPorTipo: { 21: '477000', 10: '477001', 4: '477002', 0: '477000' },
    cuentasIvaSoportadoPorTipo: { 21: '472000', 10: '472001', 4: '472002', 0: '472000' },
    cuentasTesoreriaPorFormaPago: { CONTADO: '570000', CONT: '570000', TRANSFERENCIA: '572000', TRANS: '572000' },
    cuentasRecargoEquivalenciaPorTipo: { 5.2: '477500', 1.4: '477501', 0.5: '477502' },
    cuentaVentasPorDefecto: '700000',
    cuentaComprasPorDefecto: '600000',
    cuentaClientesPorDefecto: '430000',
    cuentaProveedoresPorDefecto: '400000',
    cuentaTesoreriaPorDefecto: '572000',
    cuentaRetencionesProfesionales: '475100', // HP acreedora retenciones (mod. 111)
    cuentaRetencionesSoportadas: '473000', // HP retenciones y pagos a cuenta
  };
}
