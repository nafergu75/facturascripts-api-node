import { FacturaContable } from '../domain/factura.model';
import { ReglasContablesEmpresa } from '../domain/reglas-contables.model';
import { AsientoContableGenerado, LineaAsiento } from '../domain/asiento.model';

/** Redondeo contable a 2 decimales (evita errores de coma flotante). */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function sumBy<T>(arr: T[], f: (x: T) => number): number {
  return round2(arr.reduce((acc, x) => acc + f(x), 0));
}

/**
 * Resuelve la subcuenta de un tercero (cliente/proveedor) a partir de la cuenta
 * base (430/400...) y su codigo: grupo de 3 digitos + codigo numerico a 7 -> 10
 * digitos (ej. cliente "1" -> "4300000001"). Asi cada tercero tiene su subcuenta.
 *
 * TODO (mejora): registrar esta subcuenta como SubcuentaEmpresa (planContable)
 * la primera vez, para gestionarla desde el modulo de plan contable.
 */
export function subcuentaTercero(cuentaBase: string, codigoTercero: string): string {
  const grupo = cuentaBase.slice(0, 3);
  const digitos = (codigoTercero || '').replace(/\D/g, '') || '0';
  return grupo + digitos.padStart(7, '0').slice(-7);
}

/** Agrupa importes por subcuenta (acumulando en valor absoluto). */
function acumular(mapa: Map<string, number>, subcuenta: string, importe: number): void {
  mapa.set(subcuenta, round2((mapa.get(subcuenta) ?? 0) + Math.abs(importe)));
}

/**
 * Genera el asiento contable de una FACTURA DE VENTA (Hallazgos 3 y 4):
 *
 *   Factura normal              Abono / rectificativa (totalFactura < 0)
 *   Debe            Haber       Debe            Haber
 *   430 Cliente     700 Ventas  700 Ventas      430 Cliente
 *                   477 IVA     477 IVA
 *                   477.x RE    477.x RE
 *   473 Ret.IRPF                                473 Ret.IRPF
 *
 * Para abonos NO se usan importes negativos: se generan las MISMAS lineas con el
 * debe/haber invertido. El asiento cuadra por construccion (cliente = resto).
 */
export function generarAsientoVentaDesdeFactura(
  factura: FacturaContable,
  reglas: ReglasContablesEmpresa,
): AsientoContableGenerado {
  if (factura.tipo !== 'venta') {
    throw new Error('generarAsientoVentaDesdeFactura: la factura no es de tipo venta');
  }
  const esRectificativa = factura.totalFactura < 0; // Hallazgo 3
  const concepto = `${esRectificativa ? 'Abono' : 'Factura'} venta ${factura.idFactura} ${factura.codigoTercero}`.trim();

  // 1) Ventas por subcuenta (segun familia), en valor absoluto
  const ventasPorSubcuenta = new Map<string, number>();
  for (const l of factura.lineas) {
    const subcuenta =
      (l.familiaProducto && reglas.cuentasVentasPorFamilia?.[l.familiaProducto]) || reglas.cuentaVentasPorDefecto;
    acumular(ventasPorSubcuenta, subcuenta, l.baseImponible);
  }

  // 2) IVA repercutido por tipo -> subcuenta
  const ivaPorSubcuenta = new Map<string, number>();
  for (const l of factura.lineas) {
    if (!l.importeIva) continue;
    const subcuenta = reglas.cuentasIvaRepercutidoPorTipo[l.tipoIva];
    if (!subcuenta) throw new Error(`No hay subcuenta de IVA repercutido para el tipo ${l.tipoIva}%`);
    acumular(ivaPorSubcuenta, subcuenta, l.importeIva);
  }

  // 3) Recargo de equivalencia repercutido por tipo (Hallazgo 4)
  const recargoPorSubcuenta = new Map<string, number>();
  for (const l of factura.lineas) {
    if (!l.importeRecargo) continue;
    const subcuenta = reglas.cuentasRecargoEquivalenciaPorTipo?.[l.recargoEquivalencia ?? 0] ?? '477500';
    acumular(recargoPorSubcuenta, subcuenta, l.importeRecargo);
  }

  // 4) Retencion IRPF soportada en nuestras ventas (nos la practica el cliente)
  const totalIrpf = sumBy(factura.lineas, (l) => Math.abs(l.importeIrpf ?? 0));

  // En factura normal, ventas/IVA/recargo van al HABER y la retencion al DEBE.
  // En abono se invierte todo.
  const ladoCredito = (v: number): { debe: number; haber: number } =>
    esRectificativa ? { debe: v, haber: 0 } : { debe: 0, haber: v };
  const ladoDebito = (v: number): { debe: number; haber: number } =>
    esRectificativa ? { debe: 0, haber: v } : { debe: v, haber: 0 };

  const lineas: LineaAsiento[] = [];
  for (const [subcuenta, base] of ventasPorSubcuenta) lineas.push({ subcuenta, ...ladoCredito(base), concepto });
  for (const [subcuenta, imp] of ivaPorSubcuenta) lineas.push({ subcuenta, ...ladoCredito(imp), concepto });
  for (const [subcuenta, imp] of recargoPorSubcuenta) lineas.push({ subcuenta, ...ladoCredito(imp), concepto });
  if (totalIrpf !== 0) lineas.push({ subcuenta: reglas.cuentaRetencionesSoportadas, ...ladoDebito(totalIrpf), concepto });

  // 5) Cliente por el total a cobrar (base + IVA + recargo - IRPF), lado segun signo
  const total = Math.abs(factura.totalFactura);
  const cliente = { subcuenta: subcuentaTercero(reglas.cuentaClientesPorDefecto, factura.codigoTercero), concepto };
  lineas.unshift(esRectificativa ? { ...cliente, debe: 0, haber: total } : { ...cliente, debe: total, haber: 0 });

  const debeTotal = sumBy(lineas, (l) => l.debe);
  const haberTotal = sumBy(lineas, (l) => l.haber);
  return { fecha: factura.fecha, descripcion: concepto, lineas, debeTotal, haberTotal };
}

/**
 * Genera el asiento contable de una FACTURA DE COMPRA (Hallazgos 3 y 4):
 *
 *   Factura normal                 Abono / rectificativa (totalFactura < 0)
 *   Debe              Haber        Debe            Haber
 *   600 Compras       400 Prov.    400 Prov.       600 Compras
 *   472 IVA                                        472 IVA
 *   477.x RE soport.                               477.x RE
 *                     4751 IRPF    4751 IRPF
 */
export function generarAsientoCompraDesdeFactura(
  factura: FacturaContable,
  reglas: ReglasContablesEmpresa,
): AsientoContableGenerado {
  if (factura.tipo !== 'compra') {
    throw new Error('generarAsientoCompraDesdeFactura: la factura no es de tipo compra');
  }
  const esRectificativa = factura.totalFactura < 0; // Hallazgo 3
  const concepto = `${esRectificativa ? 'Abono' : 'Factura'} compra ${factura.idFactura} ${factura.codigoTercero}`.trim();

  // 1) Compras por subcuenta (segun familia)
  const comprasPorSubcuenta = new Map<string, number>();
  for (const l of factura.lineas) {
    const subcuenta =
      (l.familiaProducto && reglas.cuentasComprasPorFamilia?.[l.familiaProducto]) || reglas.cuentaComprasPorDefecto;
    acumular(comprasPorSubcuenta, subcuenta, l.baseImponible);
  }

  // 2) IVA soportado por tipo
  const ivaPorSubcuenta = new Map<string, number>();
  for (const l of factura.lineas) {
    if (!l.importeIva) continue;
    const subcuenta = reglas.cuentasIvaSoportadoPorTipo[l.tipoIva];
    if (!subcuenta) throw new Error(`No hay subcuenta de IVA soportado para el tipo ${l.tipoIva}%`);
    acumular(ivaPorSubcuenta, subcuenta, l.importeIva);
  }

  // 3) Recargo de equivalencia soportado (mayor coste -> al DEBE)
  const recargoPorSubcuenta = new Map<string, number>();
  for (const l of factura.lineas) {
    if (!l.importeRecargo) continue;
    const subcuenta = reglas.cuentasRecargoEquivalenciaPorTipo?.[l.recargoEquivalencia ?? 0] ?? '477500';
    acumular(recargoPorSubcuenta, subcuenta, l.importeRecargo);
  }

  // 4) Retencion IRPF practicada al proveedor (la ingresamos nosotros en AEAT)
  const totalIrpf = sumBy(factura.lineas, (l) => Math.abs(l.importeIrpf ?? 0));

  // En factura normal, compras/IVA/recargo van al DEBE y la retencion al HABER.
  const ladoDebito = (v: number): { debe: number; haber: number } =>
    esRectificativa ? { debe: 0, haber: v } : { debe: v, haber: 0 };
  const ladoCredito = (v: number): { debe: number; haber: number } =>
    esRectificativa ? { debe: v, haber: 0 } : { debe: 0, haber: v };

  const lineas: LineaAsiento[] = [];
  for (const [subcuenta, base] of comprasPorSubcuenta) lineas.push({ subcuenta, ...ladoDebito(base), concepto });
  for (const [subcuenta, imp] of ivaPorSubcuenta) lineas.push({ subcuenta, ...ladoDebito(imp), concepto });
  for (const [subcuenta, imp] of recargoPorSubcuenta) lineas.push({ subcuenta, ...ladoDebito(imp), concepto });
  if (totalIrpf !== 0) lineas.push({ subcuenta: reglas.cuentaRetencionesProfesionales, ...ladoCredito(totalIrpf), concepto });

  // 5) Proveedor por el total a pagar (base + IVA + recargo - IRPF)
  const total = Math.abs(factura.totalFactura);
  const prov = { subcuenta: subcuentaTercero(reglas.cuentaProveedoresPorDefecto, factura.codigoTercero), concepto };
  lineas.unshift(esRectificativa ? { ...prov, debe: total, haber: 0 } : { ...prov, debe: 0, haber: total });

  const debeTotal = sumBy(lineas, (l) => l.debe);
  const haberTotal = sumBy(lineas, (l) => l.haber);
  return { fecha: factura.fecha, descripcion: concepto, lineas, debeTotal, haberTotal };
}
