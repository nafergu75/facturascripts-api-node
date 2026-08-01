import { Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest, notImplemented } from '../utils/http-errors';
import { calcularMargenPorCliente } from '../services/analitica.service';
import {
  exportarLibroDiarioCSV,
  exportarMayorPorCuentaCSV,
  exportarReporteMargenCSV,
} from '../services/export.service';
import {
  exportarLibroIvaCSV,
  exportarPerdidasGananciasCSV,
  exportarA3,
  exportarGastosRechazadosCSV,
} from '../services/informesExport.service';

/** Rango de fechas de un periodo (0A | 1T..4T | 01..12) dentro del ejercicio. */
function rangoPeriodo(ejercicio: number, periodoRaw: unknown): { desde: string; hasta: string } {
  const p = String(periodoRaw ?? '0A').toUpperCase().replace('Q', '').replace(/^([1-4])$/, '$1T');
  const T: Record<string, [string, string]> = { '1T': ['01-01', '03-31'], '2T': ['04-01', '06-30'], '3T': ['07-01', '09-30'], '4T': ['10-01', '12-31'] };
  if (T[p]) return { desde: `${ejercicio}-${T[p][0]}`, hasta: `${ejercicio}-${T[p][1]}` };
  if (/^(0[1-9]|1[0-2])$/.test(p)) {
    const ultimo = new Date(ejercicio, Number(p), 0).getDate();
    return { desde: `${ejercicio}-${p}-01`, hasta: `${ejercicio}-${p}-${String(ultimo).padStart(2, '0')}` };
  }
  return { desde: `${ejercicio}-01-01`, hasta: `${ejercicio}-12-31` };
}

function parseEjercicio(raw: unknown): number {
  const e = Number(raw);
  if (!Number.isInteger(e)) throw badRequest('Parametro "ejercicio" invalido.');
  return e;
}

function enviarCsv(res: Response, nombre: string, contenido: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  res.status(200).send(contenido);
}

export const reportesController = {
  margenCliente: asyncHandler(async (req, res) => {
    sendOk(res, await calcularMargenPorCliente(req.companyId!, parseEjercicio(req.query.ejercicio)));
  }),
  margenProducto: asyncHandler(async () => {
    // Requiere desglose de lineafacturaclientes por referencia + coste de producto/escandallo.
    // Bloqueado para no devolver un reporte vacio sin avisar (ver analitica.service.ts).
    throw notImplemented('Margen por producto pendiente de implementación (requiere coste por producto).');
  }),
  // --- CSV ---
  libroDiarioCsv: asyncHandler(async (req, res) => {
    const ejercicio = parseEjercicio(req.query.ejercicio);
    enviarCsv(res, `libro-diario-${ejercicio}.csv`, await exportarLibroDiarioCSV(req.companyId!, ejercicio));
  }),
  mayorCsv: asyncHandler(async (req, res) => {
    const ejercicio = parseEjercicio(req.query.ejercicio);
    enviarCsv(res, `mayor-${req.params.cuentaCodigo}-${ejercicio}.csv`, await exportarMayorPorCuentaCSV(req.companyId!, ejercicio, req.params.cuentaCodigo));
  }),
  margenClienteCsv: asyncHandler(async (req, res) => {
    const ejercicio = parseEjercicio(req.query.ejercicio);
    const reporte = await calcularMargenPorCliente(req.companyId!, ejercicio);
    enviarCsv(res, `margen-cliente-${ejercicio}.csv`, exportarReporteMargenCSV(reporte));
  }),

  // --- Informes y exportaciones (pantalla del front) ---
  // Libros de IVA: SIEMPRE año completo (requisito AEAT), ignoran ?periodo=.
  libroIvaIngresosCsv: asyncHandler(async (req, res) => {
    const ejercicio = parseEjercicio(req.query.ejercicio);
    enviarCsv(res, `libro-iva-ingresos-${ejercicio}.csv`, await exportarLibroIvaCSV(req.companyId!, ejercicio, 'ingresos'));
  }),
  libroIvaGastosCsv: asyncHandler(async (req, res) => {
    const ejercicio = parseEjercicio(req.query.ejercicio);
    enviarCsv(res, `libro-iva-gastos-${ejercicio}.csv`, await exportarLibroIvaCSV(req.companyId!, ejercicio, 'gastos'));
  }),
  perdidasGananciasCsv: asyncHandler(async (req, res) => {
    const ejercicio = parseEjercicio(req.query.ejercicio);
    const rango = rangoPeriodo(ejercicio, req.query.periodo);
    enviarCsv(res, `perdidas-ganancias-${ejercicio}${req.query.periodo ? '-' + req.query.periodo : ''}.csv`, await exportarPerdidasGananciasCSV(req.companyId!, ejercicio, rango));
  }),
  exportA3: asyncHandler(async (req, res) => {
    const ejercicio = parseEjercicio(req.query.ejercicio);
    const contenido = await exportarA3(req.companyId!, ejercicio);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="suenlace.dat"');
    res.status(200).send(contenido);
  }),
  gastosRechazadosCsv: asyncHandler(async (req, res) => {
    enviarCsv(res, 'gastos-rechazados.csv', await exportarGastosRechazadosCSV(req.companyId!));
  }),
};
