import { obtenerFacturasFiscales } from './impuestosCalculo.service';
import { generarLibroDiario } from './cuentasAnuales.service';
import { prisma } from '../config/database';

/**
 * Informes y exportaciones (pantalla "Informes y exportaciones" del front):
 * libros de registro de IVA, P&G, export A3 y gastos rechazados (gestorias).
 */
const SEP = ';';
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const campo = (v: unknown): string => {
  const s = String(v ?? '');
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const fila = (vs: unknown[]): string => vs.map(campo).join(SEP);

/**
 * LIBRO DE REGISTRO DE IVA (ingresos=facturas emitidas / gastos=recibidas).
 * SIEMPRE el AÑO COMPLETO: la AEAT exige el libro integro del ejercicio aunque
 * en pantalla se este viendo un trimestre o mes (regla UX documentada en el front).
 * Una fila por factura y tipo de IVA (desglose real por lineas).
 */
export async function exportarLibroIvaCSV(
  companyId: string,
  ejercicio: number,
  tipo: 'ingresos' | 'gastos',
): Promise<string> {
  const facturas = await obtenerFacturasFiscales(companyId, `${ejercicio}-01-01`, `${ejercicio}-12-31`);
  const objetivo = tipo === 'ingresos' ? 'venta' : 'compra';

  const lineas = [
    fila(['fecha', 'numero', 'nif', 'nombre', 'base_imponible', 'tipo_iva', 'cuota_iva', 'total', 'operacion']),
  ];
  for (const f of facturas.filter((x) => x.tipo === objetivo)) {
    for (const l of f.lineas) {
      lineas.push(
        fila([
          f.fecha,
          f.idFactura,
          f.cifnif,
          f.nombreTercero,
          l.base.toFixed(2),
          l.tipoIva,
          l.cuota.toFixed(2),
          round2(l.base + l.cuota).toFixed(2),
          f.operacion,
        ]),
      );
    }
  }
  return lineas.join('\r\n') + '\r\n';
}

/**
 * Informe de PERDIDAS Y GANANCIAS del periodo (este SI filtra por periodo):
 * ingresos (ventas, base), gastos deducibles y no (compras, base) y resultado,
 * desglosado POR MES + fila TOTAL.
 */
export async function exportarPerdidasGananciasCSV(
  companyId: string,
  ejercicio: number,
  rango: { desde: string; hasta: string },
): Promise<string> {
  const facturas = await obtenerFacturasFiscales(companyId, rango.desde, rango.hasta);

  const porMes = new Map<string, { ingresos: number; gastos: number }>();
  for (const f of facturas) {
    const mes = f.fecha.slice(0, 7); // yyyy-mm
    const acc = porMes.get(mes) ?? { ingresos: 0, gastos: 0 };
    const base = f.lineas.reduce((a, l) => a + l.base, 0);
    if (f.tipo === 'venta') acc.ingresos = round2(acc.ingresos + base);
    else acc.gastos = round2(acc.gastos + base);
    porMes.set(mes, acc);
  }

  const lineas = [fila(['mes', 'ingresos', 'gastos', 'resultado'])];
  let tIng = 0;
  let tGas = 0;
  for (const [mes, v] of [...porMes.entries()].sort()) {
    tIng = round2(tIng + v.ingresos);
    tGas = round2(tGas + v.gastos);
    lineas.push(fila([mes, v.ingresos.toFixed(2), v.gastos.toFixed(2), round2(v.ingresos - v.gastos).toFixed(2)]));
  }
  lineas.push(fila(['TOTAL', tIng.toFixed(2), tGas.toFixed(2), round2(tIng - tGas).toFixed(2)]));
  void ejercicio;
  return lineas.join('\r\n') + '\r\n';
}

/**
 * EXPORTACION A A3 (suenlace.dat): apuntes del libro diario en texto plano para
 * importar en A3. TODO FORMATO OFICIAL: el layout real de suenlace.dat (anchos
 * fijos y codigos de A3) requiere la especificacion de Wolters Kluwer; este
 * fichero usa un layout provisional documentado (fecha|cuenta|concepto|debe|haber)
 * que cubre el wiring completo (descarga, nombre, contenido por ejercicio).
 */
export async function exportarA3(companyId: string, ejercicio: number): Promise<string> {
  const libro = await generarLibroDiario(companyId, ejercicio);
  const lineas: string[] = [];
  for (const a of libro.asientos) {
    for (const l of a.lineas) {
      const fecha = a.fecha.replace(/-/g, ''); // yyyymmdd
      const cuenta = l.subcuenta.padEnd(12, ' ').slice(0, 12);
      const concepto = (a.concepto ?? '').padEnd(40, ' ').slice(0, 40);
      const debe = String(Math.round(l.debe * 100)).padStart(15, '0');
      const haber = String(Math.round(l.haber * 100)).padStart(15, '0');
      lineas.push(`${fecha}${cuenta}${concepto}${debe}${haber}`);
    }
  }
  return lineas.join('\r\n') + '\r\n';
}

/**
 * GASTOS RECHAZADOS (informe para gestorias): documentos subidos al lector
 * CANONICO (income-reader, persistido en Prisma) que NO se han verificado como
 * factura oficial: rechazados o pendientes de revision. El motivo sale de
 * `rejectionReason`.
 */
export async function exportarGastosRechazadosCSV(companyId: string): Promise<string> {
  const docs = await prisma.incomeReaderDocument.findMany({
    where: { companyId, status: { not: 'VERIFIED' } },
    orderBy: { uploadedAt: 'desc' },
  });
  const lineas = [fila(['archivo', 'subida', 'numero', 'fecha_factura', 'nif_emisor', 'total', 'estado', 'motivo'])];
  for (const d of docs) {
    const p = (d.parsedData ?? {}) as Record<string, unknown>;
    const total = typeof p.total === 'number' ? p.total : undefined;
    lineas.push(
      fila([
        d.originalFileName,
        d.uploadedAt.toISOString().slice(0, 10),
        (p.numero as string) ?? '',
        (p.fecha as string) ?? '',
        (p.nifEmisor as string) ?? '',
        total?.toFixed(2) ?? '',
        d.status === 'REJECTED' ? 'rechazado' : 'pendiente de revision',
        d.rejectionReason ?? '',
      ]),
    );
  }
  return lineas.join('\r\n') + '\r\n';
}
