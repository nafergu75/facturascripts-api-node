/**
 * Borrador del modelo 180 (resumen anual de retenciones por alquileres) con
 * el diseno oficial: la pantalla lee el fichero generado
 * (aeat/modelo180/modelo180.dr.ts).
 *
 * De donde sale cada dato:
 *  - Facturas de gasto de ALQUILER con retencion del año, con el mismo
 *    criterio que el 115 (fecha contable, sin borradores; una anulada solo
 *    cuenta si su 115 ya se presento). Base y retencion de las lineas con
 *    retencion.
 *  - Un registro por arrendador, inmueble y ejercicio de devengo (una factura
 *    emitida un año anterior que se registra en este va aparte, con su año).
 *  - El inmueble: el de la factura o, si no tiene, el unico inmueble activo
 *    del arrendador (InmuebleArrendado). El % es el de la ultima factura.
 *  - Provincia del arrendador: codigo postal o provincia de su ficha.
 *  - Cuadre: con las casillas [02] y [03] de los 115 del año guardados en la
 *    app (los presentados o calculados) y, si no estan, con el 115 calculado.
 */
import { prisma } from '../../config/database';
import { badRequest } from '../../utils/http-errors';
import { aparicionesRetencionEntre, desgloseRetencionGasto, fechaContableGasto, whereGastosFiscales } from '../../domain/factura-gasto.model';
import { calcularModelo115, exigirModelosAeat } from '../impuestosCalculo.service';
import { codigoProvincia, periodoFiscal, retencionDeclaradaEn } from '../nominas/fiscal';
import {
  cuadre180Con115,
  ErrorEntrada180,
  erroresEntrada180,
  generarFichero180,
  leerFichero180,
  type Cuadre180,
  type Entrada180,
  type Inmueble180,
  type Pantalla180,
  type Perceptor180,
} from '../../aeat/modelo180/modelo180.dr';
import { ErrorDisenoRegistro } from '../../aeat/common/disenoRegistro';
import {
  AVISO_SIN_NUMERO,
  avisoPresentado,
  declaracionInformativa,
  declaranteEmpresa,
  erroresContacto,
  exigirNumero,
  filaModelo,
  presentacionDe,
  registrosElegidos,
} from './comun';

type InmuebleBd = NonNullable<Awaited<ReturnType<typeof prisma.inmuebleArrendado.findFirst>>>;

export interface FacturaAlquiler180 {
  id: string;
  factura: string;
  fecha: string;
  proveedor: string;
  supplierId: string;
  inmuebleArrendadoId: string | null;
  base: number;
  retencion: number;
}

export interface Borrador180 {
  ejercicio: number;
  estado: string;
  /** Tipo y anterior: los pone el historial de declaraciones (B4). */
  opciones: { tipoDeclaracion: 'C' | 'S' | null; declaracionAnterior: string | null };
  /** Numero identificativo (B5); null hasta que se descarga o se presenta. */
  numeroDeclaracion: string | null;
  entrada: Entrada180;
  /** Todos los registros del ejercicio con su clave (para elegir los de una complementaria). */
  registros: Array<{ clave: string; nombre: string; importe: number }>;
  errores: string[];
  avisos: string[];
  pantalla: Pantalla180 | null;
  cuadre: Cuadre180 & { periodos: Array<{ periodo: string; base: number; retenciones: number; fuente: 'guardado' | 'calculado'; estado: string }> };
  facturas: FacturaAlquiler180[];
  /** Facturas sin inmueble (el arrendador no tiene ninguno o tiene varios). */
  sinInmueble: FacturaAlquiler180[];
}

/** Inmueble del diseno a partir del guardado en la app. */
export function inmuebleDiseno(i: InmuebleBd): Inmueble180 {
  return {
    situacion: ([1, 2, 3, 4].includes(i.situacion) ? i.situacion : 1) as Inmueble180['situacion'],
    referenciaCatastral: i.referenciaCatastral,
    tipoVia: i.tipoVia,
    nombreVia: i.nombreVia,
    tipoNumeracion: i.tipoNumeracion,
    numeroCasa: i.numeroCasa,
    calificadorNumero: i.calificadorNumero,
    bloque: i.bloque,
    portal: i.portal,
    escalera: i.escalera,
    planta: i.planta,
    puerta: i.puerta,
    complemento: i.complemento,
    localidad: i.localidad,
    municipio: i.municipio,
    codigoMunicipio: i.codigoMunicipio,
    provinciaInmueble: i.codigoProvincia,
    codigoPostal: i.codigoPostal,
  };
}

const SIN_INMUEBLE: Inmueble180 = { situacion: 1 };
const cent = (n: number) => Math.round(n * 100);

/** 115 del año para el cuadre: los guardados en la app y, si falta alguno, el calculado. */
async function periodos115(companyId: string, ejercicio: number) {
  const filas = await prisma.modeloImpuesto.findMany({ where: { companyId, codigo: '115', ejercicio } });
  const mensual = filas.some((f) => /^\d{2}$/.test(f.periodo)) && !filas.some((f) => /^[1-4]T$/.test(f.periodo));
  const periodos = mensual ? Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0')) : ['1T', '2T', '3T', '4T'];
  const out = [];
  for (const periodo of periodos) {
    const f = filas.find((x) => x.periodo === periodo);
    const c = (f?.casillas as Record<string, unknown> | null) ?? {};
    if (f && typeof c['02_base'] === 'number' && typeof c['03_retenciones'] === 'number') {
      out.push({ periodo, base: c['02_base'] as number, retenciones: c['03_retenciones'] as number, fuente: 'guardado' as const, estado: f.estado });
    } else {
      const m = await calcularModelo115(companyId, periodoFiscal(ejercicio, periodo));
      out.push({ periodo, base: m.baseRetenciones, retenciones: m.retenciones, fuente: 'calculado' as const, estado: f?.estado ?? 'vigente' });
    }
  }
  return out;
}

/** Calcula el borrador del 180 de un ejercicio. No guarda nada. */
export async function calcularBorrador180(companyId: string, ejercicio: number): Promise<Borrador180> {
  const desde = `${ejercicio}-01-01`;
  const hasta = `${ejercicio}-12-31`;
  await exigirModelosAeat(companyId, desde, hasta);

  const facturasBd = await prisma.expenseInvoice.findMany({
    where: { AND: [whereGastosFiscales(companyId, desde, hasta), { tipoGasto: 'ALQUILER', retencionTotal: { gt: 0 } }] },
    include: { lineas: true, supplier: { select: { id: true, nifCif: true, nombreFiscal: true, cp: true, provincia: true, pais: true } } },
  });
  const inmuebles = await prisma.inmuebleArrendado.findMany({ where: { companyId } });
  const declaradaEn = await retencionDeclaradaEn(companyId, '115', facturasBd);
  const [declarante, fila, periodos, decl] = await Promise.all([
    declaranteEmpresa(companyId),
    filaModelo(companyId, '180', ejercicio, '0A'),
    periodos115(companyId, ejercicio),
    declaracionInformativa(companyId, '180', ejercicio, '0A'),
  ]);
  const avisos: string[] = [];
  const errores: string[] = erroresContacto(declarante);

  const grupos = new Map<string, Perceptor180 & { cb: number; cr: number; ultima: string }>();
  const facturas: FacturaAlquiler180[] = [];
  const sinInmueble: FacturaAlquiler180[] = [];
  for (const f of facturasBd) {
    const declarada = declaradaEn(f);
    for (const _ of aparicionesRetencionEntre(f, desde, hasta, declarada !== null)) {
      const desglose = desgloseRetencionGasto(f);
      const base = desglose.reduce((a, d) => a + cent(d.base), 0);
      const ret = desglose.reduce((a, d) => a + cent(d.cuota), 0);
      const fecha = fechaContableGasto(f);
      const activos = inmuebles.filter((i) => i.supplierId === f.supplierId && i.activo);
      // El inmueble guardado en la factura solo vale si es de su arrendador (una factura cambiada de proveedor no arrastra el del anterior).
      const inmueble = (f.inmuebleArrendadoId && inmuebles.find((i) => i.id === f.inmuebleArrendadoId && i.supplierId === f.supplierId)) || (activos.length === 1 ? activos[0] : null);
      const fila180: FacturaAlquiler180 = {
        id: f.id,
        factura: f.numeroFacturaProveedor ?? f.numeroCompleto,
        fecha,
        proveedor: f.supplier.nombreFiscal,
        supplierId: f.supplierId,
        inmuebleArrendadoId: inmueble?.id ?? null,
        base: base / 100,
        retencion: ret / 100,
      };
      facturas.push(fila180);
      if (!inmueble) sinInmueble.push(fila180);
      const devengo = Number(f.fechaEmision.slice(0, 4)) < ejercicio ? Number(f.fechaEmision.slice(0, 4)) : null;
      const k = `${f.supplierId}|${inmueble?.id ?? '-'}|${devengo ?? ''}`;
      const g = grupos.get(k) ?? {
        nif: f.supplier.nifCif,
        nombre: f.supplier.nombreFiscal,
        provincia: codigoProvincia(f.supplier.cp, f.supplier.provincia) ?? '',
        base: 0,
        porcentaje: 0,
        retenciones: 0,
        ejercicioDevengo: devengo,
        inmueble: inmueble ? inmuebleDiseno(inmueble) : SIN_INMUEBLE,
        cb: 0,
        cr: 0,
        ultima: '',
      };
      g.cb += base;
      g.cr += ret;
      // El % es el de la ultima factura del año.
      if (fecha >= g.ultima) {
        g.ultima = fecha;
        g.porcentaje = desglose.length ? desglose[desglose.length - 1].porcentaje : Number(f.tipoRetencion) || 0;
      }
      grupos.set(k, g);
    }
  }
  for (const s of sinInmueble) {
    const tiene = inmuebles.filter((i) => i.supplierId === s.supplierId && i.activo).length;
    errores.push(
      tiene
        ? `La factura ${s.factura} de ${s.proveedor} no dice de qué inmueble es, y el arrendador tiene ${tiene}: elígelo en la factura.`
        : `${s.proveedor} no tiene ningún inmueble dado de alta: añade el local alquilado (referencia catastral y dirección) en su ficha.`,
    );
  }

  // Complementaria o sustitutiva y su anterior: las pone el historial de declaraciones (B4).
  const tipoDeclaracion = decl.tipoDeclaracion;
  const opciones = { tipoDeclaracion, declaracionAnterior: decl.declaracionAnterior };
  const todos = [...grupos.values()]
    .filter((g) => g.cb !== 0 || g.cr !== 0)
    .map(({ cb, cr, ultima, ...g }) => ({ ...g, base: cb / 100, retenciones: cr / 100 }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es') || (a.ejercicioDevengo ?? 0) - (b.ejercicioDevengo ?? 0));
  const registros = todos.map((p) => ({ clave: clavePerceptor180(p), nombre: p.nombre, importe: p.base }));
  const calculada: Entrada180 = {
    ejercicio,
    declarante: {
      nif: declarante.nif,
      nombre: declarante.nombre,
      telefono: declarante.telefono,
      personaContacto: declarante.personaContacto,
      numeroDeclaracion: decl.numeroDeclaracion,
      tipoDeclaracion,
      declaracionAnterior: opciones.declaracionAnterior,
    },
    // Complementaria: solo los perceptores elegidos (por defecto, los que no estaban en la presentada).
    perceptores: registrosElegidos(todos, clavePerceptor180, decl.incluye),
  };
  // Presentada: se enseña (y se descarga) lo que se presento.
  const presentada = presentacionDe<Entrada180>(fila);
  const entrada = presentada?.entrada ?? calculada;
  if (presentada) {
    avisos.unshift(avisoPresentado(presentada));
    errores.length = 0;
  } else {
    if (!entrada.declarante.numeroDeclaracion) avisos.push(AVISO_SIN_NUMERO);
    if (decl.seleccion && !entrada.perceptores.length) errores.push('La complementaria no lleva ningún perceptor: marca los que se quedaron fuera de la declaración anterior.');
    else if (!entrada.perceptores.length) avisos.push(`No hay facturas de alquiler con retención en ${ejercicio}: no hace falta presentar el 180.`);
  }

  // El cuadre con los 115 es del año entero: en una complementaria se compara con todos los registros.
  const cuadre = { ...cuadre180Con115(decl.seleccion ? { ...entrada, perceptores: todos } : entrada, periodos), periodos };
  if (!presentada && !cuadre.coincide) {
    errores.push(
      `El 180 no cuadra con los 115 del año: bases ${cuadre.base180.toFixed(2)} € frente a ${cuadre.base115.toFixed(2)} € y retenciones ${cuadre.retenciones180.toFixed(2)} € frente a ${cuadre.retenciones115.toFixed(2)} €. Revisa los 115 guardados antes de presentar.`,
    );
  }
  const noPresentados = periodos.filter((p) => p.estado !== 'presentado').map((p) => p.periodo);
  if (entrada.perceptores.length && noPresentados.length) avisos.push(`Los 115 de ${noPresentados.join(', ')} no constan como presentados en la app.`);

  let pantalla: Pantalla180 | null = null;
  try {
    pantalla = leerFichero180(generarFichero180(entrada, { comprobar: false }));
  } catch (e) {
    if (!(e instanceof ErrorDisenoRegistro)) throw e;
  }
  return {
    ejercicio,
    estado: fila?.estado ?? 'vigente',
    opciones,
    numeroDeclaracion: entrada.declarante.numeroDeclaracion ?? null,
    entrada,
    registros,
    // Sin inmueble ya hay un error que lo explica: no se repite campo a campo.
    errores: [...errores, ...erroresEntrada180({ ...entrada, perceptores: entrada.perceptores.filter((p) => p.inmueble !== SIN_INMUEBLE) })],
    avisos,
    pantalla,
    cuadre,
    facturas,
    sinInmueble,
  };
}

/** Fichero del 180. 400 con la lista de lo que falta, o si no cuadra con los 115. */
export async function ficheroModelo180(companyId: string, ejercicio: number): Promise<{ nombre: string; contenido: string }> {
  const b = await calcularBorrador180(companyId, ejercicio);
  if (b.errores.length) throw badRequest(`No se puede generar el fichero del 180: ${b.errores.join(' ')}`, { errores: b.errores });
  exigirNumero(b.entrada.declarante.numeroDeclaracion, '180');
  try {
    return { nombre: `180_${ejercicio}.txt`, contenido: generarFichero180(b.entrada) };
  } catch (e) {
    if (e instanceof ErrorEntrada180) throw badRequest(`No se puede generar el fichero del 180: ${e.errores.join(' ')}`, { errores: e.errores });
    throw e;
  }
}

/**
 * Clave de un registro del 180: arrendador, inmueble y ejercicio de devengo.
 * El inmueble es su referencia catastral; si no la tiene (situación 4), su
 * dirección (municipio, vía, número, planta y puerta), para que dos locales del
 * mismo arrendador sin referencia no se confundan en una complementaria.
 */
export function clavePerceptor180(p: Pick<Perceptor180, 'nif' | 'inmueble' | 'ejercicioDevengo'>): string {
  const limpio = (v: unknown) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const nif = limpio(p.nif);
  const i = p.inmueble;
  const direccion = i ? [i.codigoMunicipio, i.tipoVia, i.nombreVia, i.numeroCasa, i.bloque, i.portal, i.escalera, i.planta, i.puerta].map(limpio).join('.') : '';
  const ref = limpio(i?.referenciaCatastral) || (direccion.replace(/\./g, '') ? `D:${direccion}` : '-');
  return `${nif}|${ref}|${p.ejercicioDevengo ?? ''}`;
}
