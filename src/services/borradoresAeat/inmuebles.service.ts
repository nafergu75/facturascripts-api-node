/**
 * Inmuebles que nos alquilan los proveedores (para el modelo 180) y los datos
 * por factura que piden el 180 y el 349: el inmueble de una factura de
 * alquiler y la clave A/I de una compra a otro pais de la UE.
 */
import { prisma } from '../../config/database';
import { badRequest, notFound } from '../../utils/http-errors';
import { textoAeat } from '../../aeat/common/disenoRegistro';

const PROVINCIA = /^(0[1-9]|[1-4]\d|5[0-3])$/;

export interface InmuebleEntrada {
  supplierId?: unknown;
  situacion?: unknown;
  referenciaCatastral?: unknown;
  tipoVia?: unknown;
  nombreVia?: unknown;
  tipoNumeracion?: unknown;
  numeroCasa?: unknown;
  calificadorNumero?: unknown;
  bloque?: unknown;
  portal?: unknown;
  escalera?: unknown;
  planta?: unknown;
  puerta?: unknown;
  complemento?: unknown;
  localidad?: unknown;
  municipio?: unknown;
  codigoMunicipio?: unknown;
  codigoProvincia?: unknown;
  codigoPostal?: unknown;
  activo?: unknown;
}

/** Situacion que corresponde a la provincia: Pais Vasco 2, Navarra 3, resto 1 (4 sin referencia catastral). */
export function situacionDeProvincia(provincia: string, conReferencia: boolean): 1 | 2 | 3 | 4 {
  if (!conReferencia) return 4;
  if (['01', '20', '48'].includes(provincia)) return 2;
  if (provincia === '31') return 3;
  return 1;
}

type DatosInmueble = {
  situacion: number;
  referenciaCatastral: string | null;
  tipoVia: string;
  nombreVia: string;
  tipoNumeracion: string;
  numeroCasa: string | null;
  calificadorNumero: string | null;
  bloque: string | null;
  portal: string | null;
  escalera: string | null;
  planta: string | null;
  puerta: string | null;
  complemento: string | null;
  localidad: string | null;
  municipio: string;
  codigoMunicipio: string;
  codigoProvincia: string;
  codigoPostal: string;
};

/** Valida y normaliza un inmueble (completo: alta, o el guardado con los cambios encima). */
export function validarInmueble(e: InmuebleEntrada): DatosInmueble {
  const errores: string[] = [];
  const txt = (v: unknown, max: number, campo: string, obligatorio = false, literal = false): string | null => {
    const t = textoAeat(v as string, literal);
    if (!t) {
      if (obligatorio) errores.push(`Falta ${campo}.`);
      return null;
    }
    if (t.length > max) errores.push(`${campo[0].toUpperCase()}${campo.slice(1)} tiene como mucho ${max} caracteres.`);
    return t.slice(0, max);
  };
  const cp = String(e.codigoPostal ?? '').trim();
  if (!/^\d{5}$/.test(cp)) errores.push('El código postal del inmueble tiene 5 cifras.');
  const provincia = String(e.codigoProvincia ?? '').trim() || (cp.slice(0, 2) || '');
  if (!PROVINCIA.test(provincia)) errores.push('Falta la provincia del inmueble (dos cifras, 01-53).');
  const ine = String(e.codigoMunicipio ?? '').trim();
  if (!/^\d{5}$/.test(ine)) errores.push('El código INE del municipio tiene 5 cifras.');
  else if (PROVINCIA.test(provincia) && provincia !== '53' && ine.slice(0, 2) !== provincia) errores.push(`El código INE ${ine} no es de la provincia ${provincia}.`);
  const ref = textoAeat(e.referenciaCatastral as string).replace(/ /g, '');
  if (ref && !/^[0-9A-Z]{20}$/.test(ref)) errores.push('La referencia catastral tiene 20 letras y cifras.');
  const situacion = e.situacion === undefined || e.situacion === null || e.situacion === '' ? situacionDeProvincia(provincia, !!ref) : Number(e.situacion);
  if (![1, 2, 3, 4].includes(situacion)) errores.push('La situación del inmueble es 1, 2, 3 o 4.');
  if (situacion !== 4 && !ref) errores.push('Falta la referencia catastral (o marca la situación 4: sin referencia catastral).');
  const numeracion = txt(e.tipoNumeracion ?? 'NUM', 3, 'el tipo de numeración', false, true) ?? 'NUM';
  if (!['NUM', 'KM.', 'S/N'].includes(numeracion)) errores.push('El tipo de numeración es NUM, KM. o S/N.');
  const datos: DatosInmueble = {
    situacion,
    referenciaCatastral: situacion === 4 ? null : ref || null,
    tipoVia: txt(e.tipoVia, 5, 'el tipo de vía (CL, AV, PZ...)', true) ?? '',
    nombreVia: txt(e.nombreVia, 50, 'el nombre de la vía', true) ?? '',
    tipoNumeracion: numeracion,
    numeroCasa: txt(e.numeroCasa, 5, 'el número'),
    calificadorNumero: txt(e.calificadorNumero, 3, 'el calificador del número'),
    bloque: txt(e.bloque, 3, 'el bloque'),
    portal: txt(e.portal, 3, 'el portal'),
    escalera: txt(e.escalera, 3, 'la escalera'),
    planta: txt(e.planta, 3, 'la planta'),
    puerta: txt(e.puerta, 3, 'la puerta'),
    complemento: txt(e.complemento, 40, 'el complemento'),
    localidad: txt(e.localidad, 30, 'la localidad'),
    municipio: txt(e.municipio, 30, 'el municipio', true) ?? '',
    codigoMunicipio: ine,
    codigoProvincia: provincia,
    codigoPostal: cp,
  };
  if (errores.length) throw badRequest(errores.join(' '), { errores });
  return datos;
}

export async function listarInmuebles(companyId: string, supplierId?: string) {
  return prisma.inmuebleArrendado.findMany({
    where: { companyId, ...(supplierId ? { supplierId } : {}) },
    include: { supplier: { select: { nombreFiscal: true, nifCif: true } } },
    orderBy: [{ supplierId: 'asc' }, { createdAt: 'asc' }],
  });
}

export async function crearInmueble(companyId: string, e: InmuebleEntrada) {
  const supplierId = String(e.supplierId ?? '');
  const proveedor = supplierId ? await prisma.supplier.findFirst({ where: { id: supplierId, companyId }, select: { id: true } }) : null;
  if (!proveedor) throw badRequest('Elige el proveedor que te alquila el inmueble.');
  const datos = validarInmueble(e);
  return prisma.inmuebleArrendado.create({ data: { companyId, supplierId, ...datos } });
}

export async function actualizarInmueble(companyId: string, id: string, e: InmuebleEntrada) {
  const actual = await prisma.inmuebleArrendado.findFirst({ where: { id, companyId } });
  if (!actual) throw notFound('No existe ese inmueble.');
  const { id: _id, companyId: _c, supplierId: _s, createdAt: _cr, updatedAt: _u, activo, ...guardado } = actual;
  const datos = validarInmueble({ ...guardado, ...e, supplierId: actual.supplierId });
  const nuevoActivo = e.activo === undefined ? activo : e.activo === true;
  return prisma.inmuebleArrendado.update({ where: { id }, data: { ...datos, activo: nuevoActivo } });
}

/** Inmueble de una factura de gasto (null = el unico inmueble activo del arrendador). */
export async function asignarInmuebleAFactura(companyId: string, invoiceId: string, inmuebleId: unknown) {
  const f = await prisma.expenseInvoice.findFirst({ where: { id: invoiceId, companyId }, select: { id: true, supplierId: true } });
  if (!f) throw notFound('No existe esa factura de gasto.');
  let id: string | null = null;
  if (inmuebleId !== null && inmuebleId !== undefined && inmuebleId !== '') {
    const i = await prisma.inmuebleArrendado.findFirst({ where: { id: String(inmuebleId), companyId }, select: { id: true, supplierId: true } });
    if (!i) throw badRequest('No existe ese inmueble.');
    if (i.supplierId !== f.supplierId) throw badRequest('Ese inmueble es de otro arrendador.');
    id = i.id;
  }
  await prisma.expenseInvoice.update({ where: { id: f.id }, data: { inmuebleArrendadoId: id } });
  return { id: f.id, inmuebleArrendadoId: id };
}

/** Clave del 349 de una compra a otro pais de la UE: A (bienes), I (servicios) o null (segun el tipo de gasto). */
export async function asignarClave349Compra(companyId: string, invoiceId: string, clave: unknown) {
  if (clave !== null && clave !== 'A' && clave !== 'I') throw badRequest('La clave del 349 de una compra es A (bienes), I (servicios) o vacía (según el tipo de gasto).');
  const f = await prisma.expenseInvoice.findFirst({ where: { id: invoiceId, companyId }, select: { id: true } });
  if (!f) throw notFound('No existe esa factura de gasto.');
  await prisma.expenseInvoice.update({ where: { id: f.id }, data: { clave349: clave } });
  return { id: f.id, clave349: clave };
}
