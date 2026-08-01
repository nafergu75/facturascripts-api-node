import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import { PeriodoFiscal } from '../domain/impuestos.model';
import {
  calcularModelo111,
  calcularModelo115,
  calcularModelo303,
  calcularModelo347,
  calcularModelo349,
  calcularModelo390,
} from '../services/impuestosCalculo.service';
import {
  envolverFichero,
  generarFicheroModelo111,
  generarFicheroModelo115,
  generarFicheroModelo303,
  generarPaginaModelo303_03,
  generarFicheroModelo347,
  generarFicheroModelo349,
  generarFicheroModelo390,
} from '../services/impuestosExport.service';
import { Response } from 'express';

function enviarFichero(res: Response, nombre: string, contenido: string): void {
  // Los ficheros AEAT deben ir en ISO-8859-1 (Ñ=0xD1, Ç=0xC7), no UTF-8.
  res.setHeader('Content-Type', 'text/plain; charset=ISO-8859-1');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  res.status(200).send(Buffer.from(contenido, 'latin1'));
}

const TRIMESTRES: Record<string, [string, string]> = {
  '1T': ['01-01', '03-31'],
  '2T': ['04-01', '06-30'],
  '3T': ['07-01', '09-30'],
  '4T': ['10-01', '12-31'],
};

/** Construye un PeriodoFiscal a partir de ejercicio + periodo (1T..4T, 01..12, 0A). */
export function construirPeriodo(ejercicioRaw: unknown, periodoRaw: unknown): PeriodoFiscal {
  const ejercicio = Number(ejercicioRaw);
  if (!Number.isInteger(ejercicio) || ejercicio < 2000) {
    throw badRequest('Parametro "ejercicio" invalido.');
  }
  const periodo = String(periodoRaw ?? '0A').toUpperCase();

  if (periodo === '0A') {
    return { ejercicio, periodo, tipo: 'anual', fechaInicio: `${ejercicio}-01-01`, fechaFin: `${ejercicio}-12-31` };
  }
  if (TRIMESTRES[periodo]) {
    const [ini, fin] = TRIMESTRES[periodo];
    return { ejercicio, periodo, tipo: 'trimestral', fechaInicio: `${ejercicio}-${ini}`, fechaFin: `${ejercicio}-${fin}` };
  }
  const mes = periodo.padStart(2, '0');
  const mesNum = Number(mes);
  if (mesNum >= 1 && mesNum <= 12) {
    const ultimoDia = new Date(ejercicio, mesNum, 0).getDate();
    return {
      ejercicio,
      periodo: mes,
      tipo: 'mensual',
      fechaInicio: `${ejercicio}-${mes}-01`,
      fechaFin: `${ejercicio}-${mes}-${String(ultimoDia).padStart(2, '0')}`,
    };
  }
  throw badRequest('Parametro "periodo" invalido (use 1T..4T, 01..12 o 0A).');
}

export const aeatController = {
  preview303: asyncHandler(async (req, res) => {
    const periodo = construirPeriodo(req.query.ejercicio, req.query.periodo);
    // ?aCompensar= cuotas negativas de periodos anteriores [78] (patron Quipu)
    const aCompensar = Number(req.query.aCompensar ?? 0) || 0;
    sendOk(res, await calcularModelo303(req.companyId!, periodo, aCompensar));
  }),
  preview390: asyncHandler(async (req, res) => {
    const ejercicio = construirPeriodo(req.query.ejercicio, '0A').ejercicio;
    sendOk(res, await calcularModelo390(req.companyId!, ejercicio));
  }),
  preview347: asyncHandler(async (req, res) => {
    const ejercicio = construirPeriodo(req.query.ejercicio, '0A').ejercicio;
    sendOk(res, await calcularModelo347(req.companyId!, ejercicio));
  }),
  preview349: asyncHandler(async (req, res) => {
    const periodo = construirPeriodo(req.query.ejercicio, req.query.periodo);
    sendOk(res, await calcularModelo349(req.companyId!, periodo));
  }),
  preview111: asyncHandler(async (req, res) => {
    const periodo = construirPeriodo(req.query.ejercicio, req.query.periodo);
    sendOk(res, await calcularModelo111(req.companyId!, periodo));
  }),
  fichero111: asyncHandler(async (req, res) => {
    const periodo = construirPeriodo(req.query.ejercicio, req.query.periodo);
    const nif = String(req.query.nif ?? '');
    const datos = await calcularModelo111(req.companyId!, periodo);
    enviarFichero(res, `111_${periodo.ejercicio}_${periodo.periodo}.txt`, generarFicheroModelo111(nif, periodo, datos));
  }),
  preview115: asyncHandler(async (req, res) => {
    const periodo = construirPeriodo(req.query.ejercicio, req.query.periodo);
    sendOk(res, await calcularModelo115(req.companyId!, periodo));
  }),
  fichero115: asyncHandler(async (req, res) => {
    const periodo = construirPeriodo(req.query.ejercicio, req.query.periodo);
    const nif = String(req.query.nif ?? '');
    const datos = await calcularModelo115(req.companyId!, periodo);
    enviarFichero(res, `115_${periodo.ejercicio}_${periodo.periodo}.txt`, generarFicheroModelo115(nif, periodo, datos));
  }),

  // --- Ficheros BOE descargables (nif por query; TODO: tomar de la empresa) ---
  fichero303: asyncHandler(async (req, res) => {
    const periodo = construirPeriodo(req.query.ejercicio, req.query.periodo);
    const nif = String(req.query.nif ?? '');
    const aCompensar = Number(req.query.aCompensar ?? 0) || 0;
    const datos = await calcularModelo303(req.companyId!, periodo, aCompensar);
    const pagina1 = generarFicheroModelo303(nif, periodo, datos).replace(/\r\n$/, '');
    const pagina3 = generarPaginaModelo303_03(datos); // resultado final [71] + info adicional
    const fichero = envolverFichero('303', periodo.ejercicio, periodo.periodo, pagina1 + pagina3, { versionPrograma: '0101' });
    enviarFichero(res, `303_${periodo.ejercicio}_${periodo.periodo}.txt`, fichero);
  }),
  fichero390: asyncHandler(async (req, res) => {
    const ejercicio = construirPeriodo(req.query.ejercicio, '0A').ejercicio;
    const nif = String(req.query.nif ?? '');
    const datos = await calcularModelo390(req.companyId!, ejercicio);
    const paginas = generarFicheroModelo390(nif, ejercicio, datos).replace(/\r\n$/, '');
    const fichero = envolverFichero('390', ejercicio, '0A', paginas, { versionPrograma: '0102' });
    enviarFichero(res, `390_${ejercicio}.txt`, fichero);
  }),
  fichero347: asyncHandler(async (req, res) => {
    const ejercicio = construirPeriodo(req.query.ejercicio, '0A').ejercicio;
    const nif = String(req.query.nif ?? '');
    const datos = await calcularModelo347(req.companyId!, ejercicio);
    enviarFichero(res, `347_${ejercicio}.txt`, generarFicheroModelo347(nif, ejercicio, datos));
  }),
  fichero349: asyncHandler(async (req, res) => {
    const periodo = construirPeriodo(req.query.ejercicio, req.query.periodo);
    const nif = String(req.query.nif ?? '');
    const datos = await calcularModelo349(req.companyId!, periodo);
    enviarFichero(res, `349_${periodo.ejercicio}_${periodo.periodo}.txt`, generarFicheroModelo349(nif, periodo, datos));
  }),
};
