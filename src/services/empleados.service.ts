/**
 * Trabajadores de la empresa (para las nominas). Alta, edicion, baja y borrado
 * (solo si no tienen nominas). El NIF/NIE se valida con su letra de control y
 * el numero de afiliacion (NAF) con sus digitos de control.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { badRequest, conflict, notFound } from '../utils/http-errors';
import type { EmpleadoDTO } from '../domain/nominas.model';
import {
  bajaSchema,
  empleadoActualizarSchema,
  empleadoCrearSchema,
  parsear,
  type EmpleadoActualizar,
} from './nominas/esquemas';

type FilaEmpleado = Awaited<ReturnType<typeof prisma.empleado.findFirstOrThrow>>;

export const nombreCompleto = (e: { nombre: string; apellidos: string }): string => [e.nombre, e.apellidos].filter((s) => s?.trim()).join(' ').trim();

export function aEmpleadoDTO(e: FilaEmpleado): EmpleadoDTO {
  return {
    id: e.id,
    companyId: e.companyId,
    nif: e.nif,
    nombre: e.nombre,
    apellidos: e.apellidos,
    nombreCompleto: nombreCompleto(e),
    naf: e.naf,
    fechaAlta: e.fechaAlta,
    fechaBaja: e.fechaBaja,
    tipoContrato: e.tipoContrato,
    jornadaParcial: e.jornadaParcial,
    grupoCotizacion: e.grupoCotizacion,
    porcentajeIrpfActual: e.porcentajeIrpfActual === null ? null : Number(e.porcentajeIrpfActual),
    clave190: e.clave190,
    subclave190: e.subclave190,
    provincia: e.provincia,
    anioNacimiento: e.anioNacimiento,
    situacionFamiliar: e.situacionFamiliar,
    nifConyuge: e.nifConyuge,
    discapacidad: e.discapacidad,
    movilidadGeografica: e.movilidadGeografica,
    subcuenta465: e.subcuenta465,
    activo: e.activo,
    observaciones: e.observaciones,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

const esDuplicado = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

async function cargar(companyId: string, id: string): Promise<FilaEmpleado> {
  const e = await prisma.empleado.findFirst({ where: { id, companyId } });
  if (!e) throw notFound('Trabajador no encontrado.');
  return e;
}

function comprobarFechas(datos: { fechaAlta?: string | null; fechaBaja?: string | null }): void {
  if (datos.fechaAlta && datos.fechaBaja && datos.fechaBaja < datos.fechaAlta) {
    throw badRequest('La fecha de baja no puede ser anterior a la de alta.');
  }
}

export interface FiltroEmpleados {
  activos?: boolean;
  q?: string;
}

export async function listarEmpleados(companyId: string, filtro: FiltroEmpleados = {}): Promise<EmpleadoDTO[]> {
  const q = filtro.q?.trim();
  const filas = await prisma.empleado.findMany({
    where: {
      companyId,
      ...(filtro.activos === undefined ? {} : { activo: filtro.activos }),
      ...(q ? { OR: [{ nombre: { contains: q } }, { apellidos: { contains: q } }, { nif: { contains: q.toUpperCase() } }] } : {}),
    },
    orderBy: [{ activo: 'desc' }, { apellidos: 'asc' }, { nombre: 'asc' }],
    take: 2000,
  });
  return filas.map(aEmpleadoDTO);
}

export async function obtenerEmpleado(companyId: string, id: string): Promise<EmpleadoDTO & { nominas: number }> {
  const e = await cargar(companyId, id);
  const nominas = await prisma.nomina.count({ where: { companyId, empleadoId: id } });
  return { ...aEmpleadoDTO(e), nominas };
}

export async function crearEmpleado(companyId: string, body: unknown): Promise<EmpleadoDTO> {
  const d = parsear(empleadoCrearSchema, body);
  comprobarFechas(d);
  const existente = await prisma.empleado.findFirst({ where: { companyId, nif: d.nif }, select: { id: true } });
  if (existente) throw conflict(`Ya hay un trabajador con el NIF ${d.nif}.`, { empleadoId: existente.id });
  try {
    const e = await prisma.empleado.create({
      data: {
        companyId,
        nif: d.nif,
        nombre: d.nombre,
        apellidos: d.apellidos ?? '',
        naf: d.naf ?? null,
        fechaAlta: d.fechaAlta ?? null,
        fechaBaja: d.fechaBaja ?? null,
        tipoContrato: d.tipoContrato ?? 'INDEFINIDO',
        jornadaParcial: d.jornadaParcial ?? false,
        grupoCotizacion: d.grupoCotizacion ?? null,
        porcentajeIrpfActual: d.porcentajeIrpfActual ?? null,
        clave190: d.clave190 ?? 'A',
        subclave190: d.subclave190 ?? null,
        provincia: d.provincia ?? null,
        anioNacimiento: d.anioNacimiento ?? null,
        situacionFamiliar: d.situacionFamiliar ?? null,
        nifConyuge: d.nifConyuge ?? null,
        discapacidad: d.discapacidad ?? null,
        movilidadGeografica: d.movilidadGeografica ?? null,
        activo: d.activo ?? !d.fechaBaja,
        observaciones: d.observaciones ?? null,
      },
    });
    return aEmpleadoDTO(e);
  } catch (e) {
    if (esDuplicado(e)) throw conflict(`Ya hay un trabajador con el NIF ${d.nif}.`);
    throw e;
  }
}

export async function actualizarEmpleado(companyId: string, id: string, body: unknown): Promise<EmpleadoDTO> {
  const d: EmpleadoActualizar = parsear(empleadoActualizarSchema, body);
  const actual = await cargar(companyId, id);
  comprobarFechas({ fechaAlta: d.fechaAlta === undefined ? actual.fechaAlta : d.fechaAlta, fechaBaja: d.fechaBaja === undefined ? actual.fechaBaja : d.fechaBaja });
  if (d.nif && d.nif !== actual.nif) {
    // Las nominas ya registradas se declaran con este NIF (111, 190).
    const nominas = await prisma.nomina.count({ where: { companyId, empleadoId: id } });
    if (nominas > 0) throw conflict(`No se puede cambiar el NIF: el trabajador ya tiene ${nominas} nómina(s). Si el NIF estaba mal, anula y borra sus nóminas o crea otro trabajador.`);
  }
  const data: Prisma.EmpleadoUpdateInput = {};
  for (const [k, v] of Object.entries(d)) {
    if (v !== undefined) (data as Record<string, unknown>)[k] = k === 'apellidos' ? (v ?? '') : v;
  }
  try {
    // La subcuenta 465 no lleva el nombre (ver etiquetaTrabajador): no hay que renombrarla.
    const e = await prisma.empleado.update({ where: { id: actual.id }, data });
    return aEmpleadoDTO(e);
  } catch (e) {
    if (esDuplicado(e)) throw conflict(`Ya hay un trabajador con el NIF ${d.nif}.`);
    throw e;
  }
}

/** Baja del trabajador (deja de salir como activo; sus nominas siguen ahi). */
export async function darDeBajaEmpleado(companyId: string, id: string, body: unknown): Promise<EmpleadoDTO> {
  const d = parsear(bajaSchema, body);
  const actual = await cargar(companyId, id);
  comprobarFechas({ fechaAlta: actual.fechaAlta, fechaBaja: d.fechaBaja });
  const e = await prisma.empleado.update({
    where: { id: actual.id },
    data: { fechaBaja: d.fechaBaja, activo: false, ...(d.observaciones !== undefined ? { observaciones: d.observaciones } : {}) },
  });
  return aEmpleadoDTO(e);
}

/** Borra un trabajador sin nominas (si tiene, hay que darlo de baja). */
export async function borrarEmpleado(companyId: string, id: string): Promise<void> {
  const actual = await cargar(companyId, id);
  const nominas = await prisma.nomina.count({ where: { companyId, empleadoId: id } });
  if (nominas > 0) throw conflict(`El trabajador tiene ${nominas} nómina(s): no se puede borrar. Dale de baja.`);
  await prisma.empleado.delete({ where: { id: actual.id } });
}
