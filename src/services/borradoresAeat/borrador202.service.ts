/**
 * Borrador del modelo 202 (pago fraccionado del Impuesto sobre Sociedades)
 * con el diseno oficial: la pantalla lee el fichero generado
 * (aeat/modelo202/modelo202.dr.ts).
 *
 * Modalidad A (art. 40.2 LIS), la que aplica la app:
 *  - [01] = cuota del ultimo 200 con el plazo vencido el dia 1 del mes de
 *    presentacion (ejercicio natural: en el 1P, el 200 de dos años antes; en el
 *    2P y el 3P, el del año anterior), menos deducciones, bonificaciones,
 *    retenciones e ingresos a cuenta. Sale de la base indicada a mano (los 200
 *    presentados fuera de la app) o del 200 presentado en la app (su cuota
 *    liquida: la app todavia no separa las retenciones del 200).
 *  - [03] = 18 % de [01] menos [02] (complementaria); nunca negativo.
 * La modalidad B (art. 40.3, obligatoria si la cifra de negocios pasa de 6
 * millones) todavia no se calcula: la pantalla lo dice y no da fichero.
 *
 * Datos adicionales: tipo de gravamen de 2027 y siguientes (DT 44.ª LIS:
 * general 25 %; reducida dimension, INCN < 10 M: 22 % en 2027, 21 % en 2028 y
 * 20 % desde 2029; microempresa, INCN < 1 M: 17 % los primeros 50.000 € y 20 %
 * el resto desde 2027), segun la cifra de negocios del año anterior.
 */
import { prisma } from '../../config/database';
import { badRequest } from '../../utils/http-errors';
import { esEmpresaEspanolaFiscal, MENSAJE_SIN_MODELOS } from '../impuestosCalculo.service';
import { listarCuentasBancarias } from '../bancos.service';
import {
  calcularModalidadA202,
  ErrorEntrada202,
  erroresEntrada202,
  generarFichero202,
  leerFichero202,
  PERIODOS_202,
  type Entrada202,
  type Marca202,
  type Pantalla202,
  type Periodo202,
} from '../../aeat/modelo202/modelo202.dr';
import { ErrorDisenoRegistro } from '../../aeat/common/disenoRegistro';
import { avisoPresentado, declaranteEmpresa, filaModelo, opcionesDe, presentacionDe } from './comun';

export interface Opciones202 {
  modalidad: 'A' | 'B';
  /** [01] a mano: la cuota del 200 que sirve de base (si el 200 no esta en la app). */
  baseManual: number | null;
  domiciliar: boolean;
  complementaria: boolean;
  justificanteAnterior: string | null;
  /** [02] lo ingresado en la declaracion anterior (complementaria). */
  resultadoAnterior: number | null;
}

export interface Borrador202 {
  ejercicio: number;
  periodo: Periodo202;
  estado: string;
  opciones: Opciones202;
  /** De donde sale la base [01]. */
  base: { origen: 'manual' | 'modelo200' | 'ninguno'; ejercicio200: number; importe: number };
  /** Cifra de negocios del año anterior (null si no consta). */
  cifraNegociosAnterior: number | null;
  entrada: Entrada202;
  errores: string[];
  avisos: string[];
  pantalla: Pantalla202 | null;
}

/** Ejercicio del 200 que sirve de base en modalidad A (ejercicio natural). */
export const ejercicio200Base = (ejercicio: number, periodo: Periodo202) => (periodo === '1P' ? ejercicio - 2 : ejercicio - 1);

/** Tipo de gravamen y marcas de datos adicionales segun la cifra de negocios del año anterior. */
export function perfilSociedad(ejercicio: number, incn: number | null): { marcas: Partial<Record<Marca202, boolean>>; tipoGravamen: string; tramoIncn: '0' | '1' | '2' | '3' } {
  if (incn === null) return { marcas: {}, tipoGravamen: '', tramoIncn: '0' };
  const tramoIncn = incn >= 60_000_000 ? '3' : incn >= 20_000_000 ? '2' : incn >= 10_000_000 ? '1' : '0';
  const marcas: Partial<Record<Marca202, boolean>> = { marcaIncnMas6M: incn > 6_000_000 };
  if (incn < 1_000_000) {
    marcas.marcaIncnMenos1M = true;
    const micro: Record<number, string> = { 2025: '21 22', 2026: '19 21' };
    return { marcas, tipoGravamen: micro[ejercicio] ?? '17 20', tramoIncn };
  }
  if (incn < 10_000_000) {
    marcas.marcaErd = true;
    const erd: Record<number, string> = { 2025: '24', 2026: '23', 2027: '22', 2028: '21' };
    return { marcas, tipoGravamen: erd[ejercicio] ?? '20', tramoIncn };
  }
  return { marcas, tipoGravamen: '25', tramoIncn };
}

/** Cifra de negocios de un ejercicio: datos del año anterior o el 200 guardado en la app. */
async function cifraNegocios(companyId: string, ejercicio: number): Promise<number | null> {
  const previo = await prisma.priorYearData.findUnique({ where: { companyId_ejercicio: { companyId, ejercicio } }, select: { ingresos: true } });
  if (previo && Number(previo.ingresos) > 0) return Number(previo.ingresos);
  const m200 = await filaModelo(companyId, '200', ejercicio, '0A');
  const incn = (m200?.datos as { pyg?: { importeNetoCifraNegocios?: number } } | null)?.pyg?.importeNetoCifraNegocios;
  return typeof incn === 'number' ? incn : null;
}

function opciones202(o: Record<string, unknown>): Opciones202 {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    modalidad: o.modalidad === 'B' ? 'B' : 'A',
    baseManual: num(o.baseManual),
    domiciliar: o.domiciliar === true,
    complementaria: o.complementaria === true,
    justificanteAnterior: typeof o.justificanteAnterior === 'string' ? o.justificanteAnterior : null,
    resultadoAnterior: num(o.resultadoAnterior),
  };
}

/** Calcula el borrador del 202 de un periodo (1P, 2P o 3P). No guarda nada. */
export async function calcularBorrador202(companyId: string, ejercicio: number, periodoRaw: string): Promise<Borrador202> {
  const periodo = String(periodoRaw ?? '').toUpperCase() as Periodo202;
  if (!PERIODOS_202.includes(periodo)) throw badRequest('El 202 tiene tres periodos: 1P (abril), 2P (octubre) y 3P (diciembre).');
  if (!(await esEmpresaEspanolaFiscal(companyId))) throw badRequest(MENSAJE_SIN_MODELOS);

  const [declarante, fila, legal] = await Promise.all([
    declaranteEmpresa(companyId),
    filaModelo(companyId, '202', ejercicio, periodo),
    prisma.legalConfig.findUnique({ where: { companyId }, select: { cnae: true, ejercicioInicio: true, tipoSociedad: true } }),
  ]);
  const opciones = opciones202(opcionesDe(fila));
  const avisos: string[] = [];
  const errores: string[] = [];

  const inicio = legal?.ejercicioInicio ?? '01-01';
  if (inicio !== '01-01') avisos.push(`El ejercicio de la empresa empieza el ${inicio}: comprueba los plazos y qué 200 sirve de base, que la app los calcula para el año natural.`);

  // Base [01]: a mano o el 200 presentado en la app.
  const ej200 = ejercicio200Base(ejercicio, periodo);
  let base: Borrador202['base'] = { origen: 'ninguno', ejercicio200: ej200, importe: 0 };
  if (opciones.baseManual !== null) {
    base = { origen: 'manual', ejercicio200: ej200, importe: opciones.baseManual };
  } else {
    const m200 = await filaModelo(companyId, '200', ej200, '0A');
    const d = m200?.datos as { cuotaLiquida?: number } | null;
    if (m200?.estado === 'presentado' && typeof d?.cuotaLiquida === 'number') {
      base = { origen: 'modelo200', ejercicio200: ej200, importe: d.cuotaLiquida };
      avisos.push(`La base sale de la cuota líquida del 200 de ${ej200}. Réstale las retenciones e ingresos a cuenta de ese 200 si las tuvo: la app todavía no las separa.`);
    } else {
      avisos.push(
        `No hay un 200 de ${ej200} presentado en la app. Indica a mano la base: la cuota íntegra de ese 200 menos deducciones, bonificaciones, retenciones e ingresos a cuenta. Si no hubo cuota, el 202 sale a cero y no hace falta presentarlo.`,
      );
    }
  }

  const incn = await cifraNegocios(companyId, ejercicio - 1);
  const perfil = perfilSociedad(ejercicio, incn);
  if (incn === null) avisos.push(`No consta la cifra de negocios de ${ejercicio - 1}: revisa el tipo de gravamen y las marcas de datos adicionales.`);
  if (opciones.modalidad === 'B' || perfil.marcas.marcaIncnMas6M) {
    errores.push(
      perfil.marcas.marcaIncnMas6M
        ? `La cifra de negocios de ${ejercicio - 1} pasa de 6 millones: el 202 va por la modalidad B (art. 40.3 LIS), que la app todavía no calcula.`
        : 'La empresa ha optado por la modalidad B (art. 40.3 LIS), que la app todavía no calcula.',
    );
  }

  const casillas = calcularModalidadA202(base.importe, opciones.complementaria ? opciones.resultadoAnterior ?? 0 : 0);
  const iban = opciones.domiciliar ? (await listarCuentasBancarias(companyId)).find((c) => c.activa && c.iban)?.iban ?? '' : '';
  const calculada: Entrada202 = {
    ejercicio,
    periodo,
    tipoDeclaracion: casillas['03'] > 0 ? (opciones.domiciliar ? 'U' : 'I') : 'N',
    nif: declarante.nif,
    denominacion: declarante.nombre,
    fechaInicioPeriodo: `${ejercicio}-${inicio}`,
    cnae: legal?.cnae ?? null,
    marcas: perfil.marcas,
    tipoGravamen: perfil.tipoGravamen,
    tramoIncn: perfil.tramoIncn,
    modalidad: 'A',
    casillas,
    complementaria: opciones.complementaria,
    justificanteAnterior: opciones.justificanteAnterior,
    iban,
  };
  if (!String(legal?.cnae ?? '').replace(/\D/g, '')) avisos.push('Falta el CNAE de la actividad principal (CNAE-2025) en Registro Mercantil > Datos.');
  // Presentada: se enseña (y se descarga) lo que se presento.
  const presentada = presentacionDe<Entrada202>(fila);
  const entrada = presentada?.entrada ?? calculada;
  if (presentada) {
    avisos.unshift(avisoPresentado(presentada));
    errores.length = 0;
  }

  let pantalla: Pantalla202 | null = null;
  try {
    pantalla = leerFichero202(generarFichero202(entrada, { comprobar: false }));
  } catch (e) {
    if (!(e instanceof ErrorDisenoRegistro)) throw e;
  }
  return {
    ejercicio,
    periodo,
    estado: fila?.estado ?? 'vigente',
    opciones,
    base,
    cifraNegociosAnterior: incn,
    entrada,
    errores: [...errores, ...erroresEntrada202(entrada)],
    avisos,
    pantalla,
  };
}

/** Fichero del 202. 400 con la lista de lo que falta. */
export async function ficheroModelo202(companyId: string, ejercicio: number, periodo: string): Promise<{ nombre: string; contenido: string }> {
  const b = await calcularBorrador202(companyId, ejercicio, periodo);
  if (b.errores.length) throw badRequest(`No se puede generar el fichero del 202: ${b.errores.join(' ')}`, { errores: b.errores });
  try {
    return { nombre: `202_${ejercicio}_${b.periodo}.txt`, contenido: generarFichero202(b.entrada) };
  } catch (e) {
    if (e instanceof ErrorEntrada202) throw badRequest(`No se puede generar el fichero del 202: ${e.errores.join(' ')}`, { errores: e.errores });
    throw e;
  }
}

/** Valida y normaliza las opciones que llegan del formulario del 202. */
export function opcionesEntrada202(body: Record<string, unknown>): Partial<Record<keyof Opciones202, string | number | boolean | null>> {
  const out: Partial<Record<keyof Opciones202, string | number | boolean | null>> = {};
  if ('modalidad' in body) {
    if (body.modalidad !== 'A' && body.modalidad !== 'B') throw badRequest('La modalidad es A (cuota) o B (base).');
    out.modalidad = body.modalidad;
  }
  for (const k of ['baseManual', 'resultadoAnterior'] as const) {
    if (!(k in body)) continue;
    const v = body[k];
    if (v === null || v === '') out[k] = null;
    else if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = Math.round(v * 100) / 100;
    else throw badRequest(k === 'baseManual' ? 'La base tiene que ser un importe positivo.' : 'El resultado anterior tiene que ser un importe positivo.');
  }
  for (const k of ['domiciliar', 'complementaria'] as const) {
    if (!(k in body)) continue;
    if (typeof body[k] !== 'boolean') throw badRequest(`"${k}" tiene que ser sí o no.`);
    out[k] = body[k] as boolean;
  }
  if ('justificanteAnterior' in body) {
    const v = String(body.justificanteAnterior ?? '').trim().toUpperCase();
    if (v && !/^[0-9A-Z]{13}$/.test(v)) throw badRequest('El justificante de la declaración anterior tiene 13 caracteres.');
    out.justificanteAnterior = v || null;
  }
  return out;
}
