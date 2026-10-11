/**
 * Lo que cada modelo aporta al historial de declaraciones (B4): la
 * instantánea de lo que se presenta (la misma declaración que la pantalla y el
 * fichero), las claves de sus registros (informativas) y lo ya ingresado con
 * las presentadas (autoliquidaciones).
 *
 * Las funciones de aquí solo calculan; quien escribe es declaraciones.service,
 * llamado desde rutas con permiso de escritura.
 */
import { badRequest } from '../../utils/http-errors';
import {
  calcularBorrador303,
  configuracionEmpresa,
  datosGuardados303,
  casillasGuardadas303,
  declaracionRetenciones,
  opcionesBorrador303DeQuery,
  periodoFiscalDe,
} from '../impuestosModulo.service';
import { ficheroBorrador303 } from '../modelo303.service';
import { casillasAGuardadas, ficheroDeclaracion, MODELOS_RETENCIONES, OPCION_COMPLEMENTARIA, OPCION_JUSTIFICANTE } from '../aeatRetenciones/declaracion';
import { calcularBorrador349, claveOperador, claveRectificacion349 } from '../borradoresAeat/borrador349.service';
import { calcularBorrador180, clavePerceptor180 } from '../borradoresAeat/borrador180.service';
import { calcularBorrador202 } from '../borradoresAeat/borrador202.service';
import { conservarOpciones } from '../borradoresAeat/comun';
import { borrador200, borrador347, borrador390 } from '../borradoresAeat.service';
import { generarFichero349 } from '../../aeat/modelo349/modelo349.dr';
import { generarFichero180 } from '../../aeat/modelo180/modelo180.dr';
import { generarFichero202 } from '../../aeat/modelo202/modelo202.dr';
import { claveDeclarado347 } from '../../aeat/oficial/modelo347';
import { declaracion190 } from '../nominas/fichero190';
import { generarFicheroModelo190, idRegistro190, totales190 } from '../nominas/modelo190';
import { datosDe, sumaResultados, type CodigoAeat, type FilaDeclaracion, type InstantaneaDeclaracion } from './declaraciones.service';

/** Instantánea calculada y lo que impide presentarla. */
export interface Presentable {
  instantanea: InstantaneaDeclaracion;
  errores: string[];
}

const sinFichero = <T extends { fichero?: unknown }>(b: T): Omit<T, 'fichero'> => {
  const { fichero: _f, ...resto } = b;
  return resto;
};

/** Configuración de la empresa (NIF, razón social, IBAN) que guardan las filas del 111, 115 y 303. */
async function config(companyId: string) {
  return (await configuracionEmpresa(companyId)) as Record<string, unknown>;
}

/**
 * Lo que se presentaría ahora del modelo y periodo. `opciones`: las de la
 * pantalla que no se guardan (303: tipo de declaración, cuotas a compensar y
 * cuenta bancaria).
 */
export async function presentable(companyId: string, codigo: CodigoAeat, ejercicio: number, periodo: string, opciones: Record<string, unknown> = {}): Promise<Presentable> {
  switch (codigo) {
    case '303': {
      const p = periodoFiscalDe({ ejercicio, periodo });
      const { borrador: b } = await calcularBorrador303(companyId, p, opcionesBorrador303DeQuery(opciones));
      const cfg = await config(companyId);
      return {
        errores: b.errores,
        instantanea: {
          casillas: b.casillas,
          fila: {
            casillas: { ...casillasGuardadas303(b.datos), ...Object.fromEntries(Object.entries(cfg).filter(([k]) => k.startsWith('config_'))) },
            datos: datosGuardados303(b.datos, { tipoDeclaracion: b.tipoDeclaracion, ibanPresentado: b.iban, rectificativa: b.rectificativa }),
          },
          fichero: b.errores.length ? null : ficheroBorrador303(b),
          resultado: Math.max(0, b.casillas['71'] ?? 0),
          importes: { '69': b.casillas['69'] ?? 0, '71': b.casillas['71'] ?? 0 },
          tipoDeclaracion: b.tipoDeclaracion,
          iban: b.iban,
        },
      };
    }
    case '111':
    case '115': {
      const r = await declaracionRetenciones(companyId, codigo, ejercicio, periodo);
      const d = r.declaracion;
      const m = MODELOS_RETENCIONES[codigo];
      const actuales = (r.fila.casillas ?? {}) as Record<string, unknown>;
      const cfg = await config(companyId);
      return {
        errores: d.errores,
        instantanea: {
          casillas: d.casillas,
          fila: {
            casillas: {
              ...casillasAGuardadas(codigo, d.casillas),
              ...Object.fromEntries(Object.entries({ ...cfg, ...actuales }).filter(([k]) => k.startsWith('config_'))),
              ...conservarOpciones(actuales),
              // Lo que pone el historial se guarda con lo presentado: el fichero se rehace igual.
              ...(d.complementaria ? { [OPCION_COMPLEMENTARIA]: true, [OPCION_JUSTIFICANTE]: d.justificanteAnterior } : {}),
              ...(d.iban ? { config_iban: d.iban } : {}),
            },
            datos: r.datos as unknown as Record<string, unknown>,
          },
          fichero: d.errores.length ? null : ficheroDeclaracion(d),
          resultado: d.casillas[m.resultado] ?? 0,
          tipoDeclaracion: d.tipoDeclaracion,
          iban: d.iban || null,
        },
      };
    }
    case '202': {
      const b = await calcularBorrador202(companyId, ejercicio, periodo);
      return {
        errores: b.errores,
        instantanea: {
          casillas: b.entrada.casillas as Record<string, unknown>,
          fila: { casillas: { '01': b.entrada.casillas['01'] ?? 0, '02': b.entrada.casillas['02'] ?? 0, '03': b.entrada.casillas['03'] ?? 0 }, datos: { entrada: b.entrada } },
          fichero: b.errores.length ? null : generarFichero202(b.entrada),
          resultado: b.entrada.casillas['03'] ?? 0,
          tipoDeclaracion: b.entrada.tipoDeclaracion,
          iban: b.entrada.iban ?? null,
        },
      };
    }
    case '349': {
      const b = await calcularBorrador349(companyId, ejercicio, periodo);
      const e = b.entrada;
      return {
        errores: b.errores,
        instantanea: {
          casillas: { num_operadores: e.operadores.length, num_rectificaciones: e.rectificaciones?.length ?? 0 },
          fila: { casillas: { num_operadores: e.operadores.length, num_rectificaciones: e.rectificaciones?.length ?? 0 }, datos: { entrada: e } },
          fichero: b.errores.length || !e.declarante.numeroDeclaracion ? null : generarFichero349(e),
          registros: [
            ...e.operadores.map((o) => ({ clave: claveOperador(o), nombre: o.nombre, importe: o.base })),
            ...(e.rectificaciones ?? []).map((r) => ({ clave: claveRectificacion349(r), nombre: r.nombre, importe: r.baseRectificada })),
          ],
        },
      };
    }
    case '180': {
      const b = await calcularBorrador180(companyId, ejercicio);
      const e = b.entrada;
      return {
        errores: b.errores,
        instantanea: {
          casillas: { num_perceptores: e.perceptores.length, base_retenciones: b.cuadre.base180, retenciones: b.cuadre.retenciones180 },
          fila: { casillas: { num_perceptores: e.perceptores.length, base_retenciones: b.cuadre.base180, retenciones: b.cuadre.retenciones180 }, datos: { entrada: e } },
          fichero: b.errores.length || !e.declarante.numeroDeclaracion ? null : generarFichero180(e),
          registros: e.perceptores.map((p) => ({ clave: clavePerceptor180(p), nombre: p.nombre, importe: p.base })),
        },
      };
    }
    case '347': {
      const b = await borrador347(companyId, ejercicio);
      return {
        errores: b.errores,
        instantanea: {
          casillas: { num_declarados: b.resumen.numeroDeclarados, importe_total: b.resumen.importeTotal },
          fila: { casillas: { num_declarados: b.resumen.numeroDeclarados, importe_total: b.resumen.importeTotal }, datos: { resumen: b.resumen, declarante: b.declarante } },
          fichero: b.errores.length ? null : b.fichero,
          pantalla: sinFichero(b),
          registros: b.declarados.map((x) => ({ clave: claveDeclarado347(x), nombre: x.nombre, importe: x.importeAnual })),
        },
      };
    }
    case '390': {
      const b = await borrador390(companyId, ejercicio);
      return {
        errores: b.errores,
        instantanea: {
          casillas: b.casillas,
          fila: { casillas: b.casillas, datos: { liquidaciones: b.liquidaciones } },
          fichero: b.errores.length ? null : b.fichero,
          pantalla: sinFichero(b),
        },
      };
    }
    case '200': {
      const b = await borrador200(companyId, ejercicio);
      return {
        errores: b.errores,
        instantanea: {
          casillas: b.casillas,
          // El 202 toma la base de la cuota líquida del 200 presentado.
          fila: { casillas: b.casillas, datos: { ...b.liquidacion, cuotaLiquida: b.liquidacion.cuotaLiquida } },
          fichero: b.errores.length ? null : b.fichero,
          pantalla: sinFichero(b),
          resultado: Math.max(0, b.liquidacion.resultado ?? 0),
          tipoDeclaracion: b.liquidacion.tipoDeclaracion,
        },
      };
    }
    case '190': {
      const d = await declaracion190(companyId, ejercicio);
      const t = totales190(d.perceptores);
      const casillas = { num_percepciones: t.registros, num_perceptores: new Set(d.perceptores.map((p) => p.nif)).size, importe_percepciones: t.percepciones, retenciones_ingresos_cuenta: t.retenciones };
      return {
        errores: d.errores,
        instantanea: {
          casillas,
          fila: { casillas, datos: { totales: t } },
          fichero: d.errores.length || !d.declarante.numeroDeclaracion ? null : generarFicheroModelo190(ejercicio, d.declarante, d.perceptores),
          registros: d.perceptores.map((p) => ({ clave: idRegistro190(p), nombre: p.nombre, importe: p.percepcionIntegra })),
        },
      };
    }
  }
}

/** Claves de todos los registros que hay hoy (para proponer los de una complementaria). */
export async function registrosActuales(companyId: string, codigo: CodigoAeat, ejercicio: number, periodo: string): Promise<Array<{ clave: string; nombre: string; importe: number }>> {
  switch (codigo) {
    case '349':
      return (await calcularBorrador349(companyId, ejercicio, periodo)).registros;
    case '180':
      return (await calcularBorrador180(companyId, ejercicio)).registros;
    case '347':
      return (await borrador347(companyId, ejercicio, { calcular: true })).registrosDeclaracion ?? [];
    case '190': {
      const d = await declaracion190(companyId, ejercicio);
      return d.todos.map((p) => ({ clave: idRegistro190(p), nombre: p.nombre, importe: p.percepcionIntegra }));
    }
    default:
      throw badRequest(`El ${codigo} no tiene registros que elegir.`);
  }
}

/**
 * Lo ya ingresado con las presentadas del periodo, que va en la complementaria:
 * [29] del 111, [04] del 115 y [02] del 202 (suma de lo ingresado); en el 303
 * rectificativo, [70] = el [69] de la autoliquidación que se rectifica.
 */
export function resultadoAnterior(codigo: CodigoAeat, presentadas: FilaDeclaracion[]): number {
  if (codigo === '303') {
    const ultima = presentadas[presentadas.length - 1];
    if (!ultima) return 0;
    const d = datosDe(ultima);
    const c69 = d.importes?.['69'] ?? Number((d.fila?.datos as { casillasOficiales?: Record<string, number> } | undefined)?.casillasOficiales?.['69'] ?? 0);
    return Math.max(0, Math.round((Number(c69) || 0) * 100) / 100);
  }
  // Las presentadas antes del historial no guardaron `resultado`: se toma de su fila.
  const CLAVE_RESULTADO: Partial<Record<CodigoAeat, string>> = { '111': '30_resultado', '115': '05_resultado', '202': '03' };
  const clave = CLAVE_RESULTADO[codigo];
  const conResultado = presentadas.map((p) => {
    const d = datosDe(p);
    if (d.resultado !== undefined || !clave) return p;
    const v = Number((d.fila?.casillas ?? {})[clave] ?? 0) || 0;
    return { ...p, datos: { ...d, resultado: v } } as FilaDeclaracion;
  });
  return sumaResultados(conResultado);
}
