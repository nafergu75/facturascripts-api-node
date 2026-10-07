/**
 * Nominas (nivel A: registro contable; la gestoria las calcula).
 *
 *  - Una nomina por trabajador, mes y tipo (tabla Nomina), a mano o importada
 *    del Excel que manda la gestoria cada mes (services/nominas/lector.ts). La
 *    vista previa no guarda nada en el servidor: la confirmacion vuelve a
 *    recibir el fichero (o las filas ya revisadas) y lo valida todo otra vez.
 *  - Al importar se dan de alta los trabajadores nuevos (por NIF). Reimportar
 *    un mes sustituye las nominas en BORRADOR (o ANULADAS); las CONTABILIZADAS
 *    se rechazan: hay que anularlas antes.
 *  - Contabilizar crea UN ASIENTO POR NOMINA (por trabajador y mes), con la
 *    subcuenta 465 propia del trabajador para el liquido. Todo en una
 *    transaccion, con el periodo abierto y comprobando debe = haber.
 *  - Anular: si el periodo del asiento esta abierto, el asiento pasa a
 *    REVERSED; si esta cerrado, se hace un contraasiento con la fecha de
 *    anulacion (como los cobros). La nomina vuelve a BORRADOR (o queda ANULADA).
 *  - El resumen mensual antiguo (NominaResumen, solo totales) ya no se graba:
 *    GET /nominas/resumen se calcula con las nominas por trabajador.
 */
import { randomUUID } from 'crypto';
import * as XLSX from 'xlsx';
import { Prisma } from '@prisma/client';
import { prisma, type TransaccionBD } from '../config/database';
import { badRequest, conflict, notFound } from '../utils/http-errors';
import { aCentimos } from '../utils/money';
import { hoyEspana } from '../utils/fechas';
import {
  CAMPOS_IMPORTE,
  type CuadreNomina,
  type ImportesNomina,
  type NominaDTO,
  type NominaResumen,
} from '../domain/nominas.model';
import { crearAsientoConApuntes } from './asientos.service';
import { comprobarFechaAbierta } from './cobrosPagos.service';
import { estadoPeriodoEnFecha } from './periodos.service';
import { nombreCompleto } from './empleados.service';
import {
  conceptoAsientoNomina,
  cuadreNomina,
  fmtEuros,
  generarAsientoNomina,
  mensajeDescuadre,
  siguienteSubcuenta465,
  ultimoDiaMes,
} from './nominas/calculo';
import {
  ETIQUETAS_CAMPOS,
  marcarRepetidas,
  TITULOS_PLANTILLA,
  type FilaNomina,
  type LecturaNominas,
} from './nominas/lector';
import { nominaActualizarSchema, nominaCrearSchema, parsear, type NominaActualizar } from './nominas/esquemas';
import {
  asegurarCuentasNominas,
  asegurarSubcuenta465,
  cuentasNominasEmpresa,
  prepararPlanEmpresa,
  subcuentas465Ocupadas,
  type TrabajadorPlan,
} from './nominas/plan';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const mm = (mes: number) => String(mes).padStart(2, '0');
const periodoTexto = (ejercicio: number, mes: number) => `${mm(mes)}/${ejercicio}`;

/** Tiempo maximo de las transacciones de nominas (un mes con muchos trabajadores son muchas escrituras). */
const OPCIONES_TX = { timeout: 120_000, maxWait: 15_000 };

/** Reintenta si dos procesos a la vez chocan en un indice unico (numero de asiento, subcuenta...). */
async function conReintento<T>(fn: () => Promise<T>): Promise<T> {
  for (let intento = 0; ; intento++) {
    try {
      return await fn();
    } catch (e) {
      const repetido = e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
      if (!repetido || intento >= 3) throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

type FilaNominaBD = Awaited<ReturnType<typeof prisma.nomina.findFirstOrThrow>>;
type EmpleadoBD = Awaited<ReturnType<typeof prisma.empleado.findFirstOrThrow>>;

function importesDe(n: Record<string, unknown>): ImportesNomina {
  const out = { ingresoACuentaRepercutido: n.ingresoACuentaRepercutido === true } as ImportesNomina;
  for (const k of CAMPOS_IMPORTE) (out as unknown as Record<string, number>)[k] = Number(n[k] ?? 0);
  return out;
}

export function aNominaDTO(n: FilaNominaBD, empleado?: EmpleadoBD | null, asientoNumero?: string | null): NominaDTO {
  const importes = importesDe(n as unknown as Record<string, unknown>);
  return {
    id: n.id,
    companyId: n.companyId,
    empleadoId: n.empleadoId,
    ...(empleado
      ? { empleado: { id: empleado.id, nif: empleado.nif, nombreCompleto: nombreCompleto(empleado), subcuenta465: empleado.subcuenta465, activo: empleado.activo } }
      : {}),
    ejercicio: n.ejercicio,
    mes: n.mes,
    tipo: n.tipo,
    ejercicioDevengo: n.ejercicioDevengo,
    fechaDevengo: n.fechaDevengo,
    fechaPago: n.fechaPago,
    ...importes,
    porcentajeIrpf: n.porcentajeIrpf === null ? null : Number(n.porcentajeIrpf),
    estado: n.estado,
    asientoId: n.asientoId,
    ...(asientoNumero !== undefined ? { asientoNumero } : {}),
    asientoAnulacionId: n.asientoAnulacionId,
    anuladaEn: n.anuladaEn,
    loteImportacionId: n.loteImportacionId,
    origen: n.origen,
    observaciones: n.observaciones,
    cuadre: cuadreNomina(importes),
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
  };
}

async function numerosAsiento(ids: Array<string | null>): Promise<Map<string, string>> {
  const validos = [...new Set(ids.filter((x): x is string => !!x))];
  if (!validos.length) return new Map();
  const filas = await prisma.journalEntry.findMany({ where: { id: { in: validos } }, select: { id: true, numeroAsiento: true } });
  return new Map(filas.map((a) => [a.id, a.numeroAsiento]));
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

export interface FiltroNominas {
  ejercicio?: number;
  mes?: number;
  empleadoId?: string;
  estado?: string;
}

export async function listarNominas(companyId: string, filtro: FiltroNominas = {}): Promise<NominaDTO[]> {
  const filas = await prisma.nomina.findMany({
    where: {
      companyId,
      ...(filtro.ejercicio ? { ejercicio: filtro.ejercicio } : {}),
      ...(filtro.mes ? { mes: filtro.mes } : {}),
      ...(filtro.empleadoId ? { empleadoId: filtro.empleadoId } : {}),
      ...(filtro.estado ? { estado: filtro.estado } : {}),
    },
    include: { empleado: true },
    orderBy: [{ ejercicio: 'desc' }, { mes: 'desc' }, { createdAt: 'asc' }],
    take: 5000,
  });
  const numeros = await numerosAsiento(filas.map((f) => f.asientoId));
  return filas.map((f) => aNominaDTO(f, f.empleado, f.asientoId ? (numeros.get(f.asientoId) ?? null) : null));
}

export async function obtenerNomina(companyId: string, id: string): Promise<NominaDTO> {
  const n = await prisma.nomina.findFirst({ where: { id, companyId }, include: { empleado: true } });
  if (!n) throw notFound('Nómina no encontrada.');
  const numeros = await numerosAsiento([n.asientoId]);
  return aNominaDTO(n, n.empleado, n.asientoId ? (numeros.get(n.asientoId) ?? null) : null);
}

export interface TotalesNominas {
  nominas: number;
  trabajadores: number;
  brutoDinerario: number;
  especieValoracion: number;
  ssTrabajador: number;
  irpf: number;
  embargos: number;
  anticipos: number;
  liquido: number;
  ssEmpresa: number;
  costeEmpresa: number;
}

export function totalizar(nominas: Array<ImportesNomina & { empleadoId?: string; nif?: string }>): TotalesNominas {
  const c = (f: (n: ImportesNomina) => number) => round2(nominas.reduce((a, n) => a + aCentimos(f(n)), 0) / 100);
  return {
    nominas: nominas.length,
    trabajadores: new Set(nominas.map((n) => n.empleadoId ?? n.nif)).size,
    brutoDinerario: c((n) => n.brutoDinerario),
    especieValoracion: c((n) => n.especieValoracion),
    ssTrabajador: c((n) => n.ssTrabajador),
    irpf: c((n) => n.irpf),
    embargos: c((n) => n.embargos),
    anticipos: c((n) => n.anticipos),
    liquido: c((n) => n.liquido),
    ssEmpresa: c((n) => n.ssEmpresa),
    costeEmpresa: c((n) => cuadreNomina(n).costeEmpresa),
  };
}

/** Mes de nominas: cada trabajador con su estado, cuadre y asiento, y los totales. */
export async function resumenPeriodo(companyId: string, ejercicio: number, mes: number) {
  const nominas = await listarNominas(companyId, { ejercicio, mes });
  nominas.sort((a, b) => (a.empleado?.nombreCompleto ?? '').localeCompare(b.empleado?.nombreCompleto ?? '', 'es'));
  const fechaDevengo = ultimoDiaMes(ejercicio, mes);
  const vivas = nominas.filter((n) => n.estado !== 'ANULADA');
  const estados = { BORRADOR: 0, CONTABILIZADA: 0, ANULADA: 0 } as Record<string, number>;
  for (const n of nominas) estados[n.estado] = (estados[n.estado] ?? 0) + 1;
  return {
    ejercicio,
    mes,
    fechaDevengo,
    estadoPeriodo: (await estadoPeriodoEnFecha(companyId, fechaDevengo)) ?? 'abierto',
    nominas,
    totales: totalizar(vivas),
    estados,
    cuadran: vivas.every((n) => n.cuadre.cuadra),
  };
}

// ---------------------------------------------------------------------------
// Alta, edicion y borrado manual
// ---------------------------------------------------------------------------

function importesCompletos(d: Partial<ImportesNomina>, base?: ImportesNomina): ImportesNomina {
  const out = { ...(base ?? {}) } as ImportesNomina;
  for (const k of CAMPOS_IMPORTE) {
    const v = d[k];
    (out as unknown as Record<string, number>)[k] = v === undefined || v === null ? (base?.[k] ?? 0) : v;
  }
  out.ingresoACuentaRepercutido = d.ingresoACuentaRepercutido ?? base?.ingresoACuentaRepercutido ?? false;
  return out;
}

function exigirCuadre(importes: ImportesNomina): void {
  const msg = mensajeDescuadre(importes);
  if (msg) {
    const q = cuadreNomina(importes);
    throw badRequest(msg, { diferencia: q.diferencia, liquidoCalculado: q.liquidoCalculado, devengado: q.devengado, deducido: q.deducido });
  }
}

function avisosNomina(n: { ejercicio: number; mes: number; fechaPago: string; fechaDevengo: string }, empleado: { fechaBaja: string | null; fechaAlta: string | null }): string[] {
  const avisos: string[] = [];
  const inicioMes = `${n.ejercicio}-${mm(n.mes)}-01`;
  if (n.fechaPago < n.fechaDevengo.slice(0, 8) + '01') avisos.push('La fecha de pago es anterior al mes de devengo.');
  if (empleado.fechaBaja && empleado.fechaBaja < inicioMes) avisos.push(`El trabajador está de baja desde el ${empleado.fechaBaja}: ¿es un finiquito o unos atrasos?`);
  if (empleado.fechaAlta && empleado.fechaAlta > n.fechaDevengo) avisos.push(`El trabajador se da de alta el ${empleado.fechaAlta}, después de este mes.`);
  return avisos;
}

const textoTipo = (tipo: string) => tipo.toLowerCase();

export async function crearNomina(companyId: string, body: unknown): Promise<NominaDTO & { avisos: string[] }> {
  const d = parsear(nominaCrearSchema, body);
  const empleado = await prisma.empleado.findFirst({ where: { id: d.empleadoId, companyId } });
  if (!empleado) throw badRequest('El trabajador no existe en esta empresa.');
  const importes = importesCompletos(d);
  exigirCuadre(importes);
  const fechaDevengo = ultimoDiaMes(d.ejercicio, d.mes);
  const fechaPago = d.fechaPago ?? fechaDevengo;
  const tipo = d.tipo ?? 'ORDINARIA';
  try {
    const n = await prisma.nomina.create({
      data: {
        companyId,
        empleadoId: empleado.id,
        ejercicio: d.ejercicio,
        mes: d.mes,
        tipo,
        ejercicioDevengo: d.ejercicioDevengo ?? null,
        fechaDevengo,
        fechaPago,
        ...importes,
        porcentajeIrpf: d.porcentajeIrpf ?? null,
        origen: 'manual',
        observaciones: d.observaciones ?? null,
      },
    });
    return { ...aNominaDTO(n, empleado, null), avisos: avisosNomina({ ejercicio: d.ejercicio, mes: d.mes, fechaPago, fechaDevengo }, empleado) };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw conflict(`${nombreCompleto(empleado)} ya tiene una nómina ${textoTipo(tipo)} de ${periodoTexto(d.ejercicio, d.mes)}.`);
    }
    throw e;
  }
}

function soloBorrador(n: { estado: string }, accion: string): void {
  if (n.estado === 'CONTABILIZADA') throw conflict(`La nómina está contabilizada: anúlala antes de ${accion}.`);
  if (n.estado !== 'BORRADOR') throw conflict(`La nómina está ${n.estado.toLowerCase()}: solo se puede ${accion} una nómina en borrador.`);
}

export async function actualizarNomina(companyId: string, id: string, body: unknown): Promise<NominaDTO & { avisos: string[] }> {
  const d: NominaActualizar = parsear(nominaActualizarSchema, body);
  const actual = await prisma.nomina.findFirst({ where: { id, companyId }, include: { empleado: true } });
  if (!actual) throw notFound('Nómina no encontrada.');
  soloBorrador(actual, 'modificarla');
  const importes = importesCompletos(d, importesDe(actual as unknown as Record<string, unknown>));
  exigirCuadre(importes);
  const ejercicio = d.ejercicio ?? actual.ejercicio;
  const mes = d.mes ?? actual.mes;
  const fechaDevengo = ultimoDiaMes(ejercicio, mes);
  // Si la fecha de pago era la de devengo por defecto, se mueve con el mes.
  const fechaPago = d.fechaPago ?? (actual.fechaPago === actual.fechaDevengo ? fechaDevengo : actual.fechaPago);
  try {
    const r = await prisma.nomina.updateMany({
      where: { id: actual.id, estado: 'BORRADOR' },
      data: {
        ejercicio,
        mes,
        tipo: d.tipo ?? actual.tipo,
        ...(d.ejercicioDevengo !== undefined ? { ejercicioDevengo: d.ejercicioDevengo } : {}),
        fechaDevengo,
        fechaPago,
        ...importes,
        ...(d.porcentajeIrpf !== undefined ? { porcentajeIrpf: d.porcentajeIrpf } : {}),
        ...(d.observaciones !== undefined ? { observaciones: d.observaciones } : {}),
      },
    });
    if (r.count !== 1) throw conflict('La nómina ha cambiado de estado mientras se editaba: vuelve a cargarla.');
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw conflict(`${nombreCompleto(actual.empleado)} ya tiene una nómina ${textoTipo(d.tipo ?? actual.tipo)} de ${periodoTexto(ejercicio, mes)}.`);
    }
    throw e;
  }
  const n = await obtenerNomina(companyId, id);
  return { ...n, avisos: avisosNomina(n, actual.empleado) };
}

/** Borra una nomina en borrador o anulada (las contabilizadas hay que anularlas antes). */
export async function borrarNomina(companyId: string, id: string): Promise<void> {
  const actual = await prisma.nomina.findFirst({ where: { id, companyId } });
  if (!actual) throw notFound('Nómina no encontrada.');
  if (actual.estado === 'CONTABILIZADA') throw conflict('La nómina está contabilizada: anúlala antes de borrarla.');
  const r = await prisma.nomina.deleteMany({ where: { id: actual.id, estado: { in: ['BORRADOR', 'ANULADA'] } } });
  if (r.count !== 1) throw conflict('La nómina ha cambiado de estado: vuelve a cargarla.');
}

// ---------------------------------------------------------------------------
// Importacion
// ---------------------------------------------------------------------------

export interface FilaVistaPrevia extends FilaNomina {
  empleado: { id: string | null; nombreCompleto: string; nuevo: boolean; subcuenta465: string | null };
  /** crear | sustituir (una en borrador o anulada) | error */
  accion: 'crear' | 'sustituir' | 'error';
  nominaExistenteId: string | null;
}

export interface VistaPreviaImportacion {
  lectura: Omit<LecturaNominas, 'filas'> | null;
  campos: typeof ETIQUETAS_CAMPOS;
  filas: FilaVistaPrevia[];
  resumen: {
    filas: number;
    validas: number;
    conErrores: number;
    empleadosNuevos: number;
    empleadosExistentes: number;
    sustituyen: number;
    periodos: Array<{ ejercicio: number; mes: number; nominas: number; estadoPeriodo: string }>;
    totales: TotalesNominas;
  };
  puedeConfirmar: boolean;
  avisos: string[];
}

export interface EntradaImportacion {
  lectura?: LecturaNominas;
  filas?: FilaNomina[];
}

/**
 * Vista previa de una importacion: cuadre por trabajador, trabajadores nuevos
 * o existentes y nominas que se sustituyen. No guarda nada.
 */
export async function previsualizarImportacion(companyId: string, entrada: EntradaImportacion): Promise<VistaPreviaImportacion> {
  const filas = (entrada.lectura?.filas ?? entrada.filas ?? []).map((f) => ({ ...f, errores: [...f.errores], avisos: [...f.avisos] }));
  if (!filas.length) throw badRequest('El fichero no tiene ninguna nómina.');
  marcarRepetidas(filas);
  const avisos = [...(entrada.lectura?.avisos ?? [])];

  const nifs = [...new Set(filas.map((f) => f.nif).filter(Boolean))];
  const empleados = nifs.length ? await prisma.empleado.findMany({ where: { companyId, nif: { in: nifs } } }) : [];
  const porNif = new Map(empleados.map((e) => [e.nif, e]));

  const ejercicios = [...new Set(filas.map((f) => f.ejercicio).filter(Number.isInteger))];
  const existentes = empleados.length && ejercicios.length
    ? await prisma.nomina.findMany({
        where: { companyId, empleadoId: { in: empleados.map((e) => e.id) }, ejercicio: { in: ejercicios } },
        select: { id: true, empleadoId: true, ejercicio: true, mes: true, tipo: true, estado: true, asientoId: true },
      })
    : [];
  const clave = (empleadoId: string, ejercicio: number, mes: number, tipo: string) => `${empleadoId}|${ejercicio}|${mes}|${tipo}`;
  const nominaPorClave = new Map(existentes.map((n) => [clave(n.empleadoId, n.ejercicio, n.mes, n.tipo), n]));
  const numeros = await numerosAsiento(existentes.map((n) => n.asientoId));

  const salida: FilaVistaPrevia[] = filas.map((f) => {
    const e = porNif.get(f.nif);
    if (!e && !f.nombre.trim() && !f.apellidos.trim()) f.errores.push('Falta el nombre: el trabajador es nuevo y hay que darlo de alta con su nombre.');
    if (e) {
      const enFichero = [f.nombre, f.apellidos].filter(Boolean).join(' ').trim();
      const enFicha = nombreCompleto(e);
      const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
      if (enFichero && norm(enFichero) !== norm(enFicha) && !norm(enFichero).split(' ').every((p) => norm(enFicha).includes(p))) {
        f.avisos.push(`En el fichero se llama "${enFichero}" y en su ficha "${enFicha}": se mantiene la ficha.`);
      }
      if (e.fechaBaja && Number.isInteger(f.mes) && e.fechaBaja < `${f.ejercicio}-${mm(f.mes)}-01`) {
        f.avisos.push(`El trabajador está de baja desde el ${e.fechaBaja}.`);
      }
    }
    let accion: FilaVistaPrevia['accion'] = 'crear';
    let nominaExistenteId: string | null = null;
    const previa = e && Number.isInteger(f.mes) ? nominaPorClave.get(clave(e.id, f.ejercicio, f.mes, f.tipo)) : undefined;
    if (previa) {
      nominaExistenteId = previa.id;
      if (previa.estado === 'CONTABILIZADA') {
        const num = previa.asientoId ? numeros.get(previa.asientoId) : null;
        f.errores.push(
          `La nómina de ${periodoTexto(f.ejercicio, f.mes)} de este trabajador ya está contabilizada${num ? ` (asiento ${num})` : ''}: anúlala antes de volver a importarla.`,
        );
      } else {
        accion = 'sustituir';
        f.avisos.push(`Sustituye a la nómina ${previa.estado === 'ANULADA' ? 'anulada' : 'en borrador'} ya registrada.`);
      }
    }
    if (f.errores.length) accion = 'error';
    return {
      ...f,
      empleado: e
        ? { id: e.id, nombreCompleto: nombreCompleto(e), nuevo: false, subcuenta465: e.subcuenta465 }
        : { id: null, nombreCompleto: [f.nombre, f.apellidos].filter(Boolean).join(' ').trim(), nuevo: true, subcuenta465: null },
      accion,
      nominaExistenteId,
    };
  });

  const validas = salida.filter((f) => f.accion !== 'error');
  const periodos = new Map<string, { ejercicio: number; mes: number; nominas: number; estadoPeriodo: string }>();
  for (const f of salida) {
    if (!Number.isInteger(f.mes) || !Number.isInteger(f.ejercicio)) continue;
    const k = `${f.ejercicio}-${f.mes}`;
    const p = periodos.get(k) ?? { ejercicio: f.ejercicio, mes: f.mes, nominas: 0, estadoPeriodo: 'abierto' };
    p.nominas++;
    periodos.set(k, p);
  }
  for (const p of periodos.values()) {
    p.estadoPeriodo = (await estadoPeriodoEnFecha(companyId, ultimoDiaMes(p.ejercicio, p.mes))) ?? 'abierto';
    if (p.estadoPeriodo !== 'abierto') {
      avisos.push(`El periodo ${periodoTexto(p.ejercicio, p.mes)} está ${p.estadoPeriodo}: las nóminas se podrán registrar, pero no contabilizar.`);
    }
  }
  if (periodos.size > 1) avisos.push(`El fichero trae nóminas de ${periodos.size} meses distintos.`);
  const nuevos = new Set(salida.filter((f) => f.empleado.nuevo && f.nif).map((f) => f.nif));
  const existentesNif = new Set(salida.filter((f) => !f.empleado.nuevo).map((f) => f.nif));

  const info = entrada.lectura ? (({ filas: _f, ...resto }) => resto)(entrada.lectura) : null;
  return {
    lectura: info,
    campos: ETIQUETAS_CAMPOS,
    filas: salida,
    resumen: {
      filas: salida.length,
      validas: validas.length,
      conErrores: salida.length - validas.length,
      empleadosNuevos: nuevos.size,
      empleadosExistentes: existentesNif.size,
      sustituyen: salida.filter((f) => f.accion === 'sustituir').length,
      periodos: [...periodos.values()].sort((a, b) => a.ejercicio - b.ejercicio || a.mes - b.mes),
      totales: totalizar(validas),
    },
    puedeConfirmar: salida.length > 0 && validas.length === salida.length,
    avisos,
  };
}

export interface ResultadoImportacion {
  loteImportacionId: string;
  nominasCreadas: number;
  nominasSustituidas: number;
  empleadosCreados: number;
  periodos: Array<{ ejercicio: number; mes: number }>;
  nominaIds: string[];
  avisos: string[];
  contabilizacion?: ResultadoContabilizacion[];
}

/**
 * Confirma una importacion: vuelve a validarlo todo y, si no hay errores, da de
 * alta los trabajadores nuevos y crea (o sustituye) las nominas en BORRADOR.
 * Con `contabilizar`, a continuacion contabiliza los meses importados.
 */
export async function confirmarImportacion(
  companyId: string,
  entrada: EntradaImportacion,
  opciones: { contabilizar?: boolean } = {},
): Promise<ResultadoImportacion> {
  const vista = await previsualizarImportacion(companyId, entrada);
  if (!vista.puedeConfirmar) {
    const conError = vista.filas.filter((f) => f.accion === 'error');
    throw badRequest(
      `Hay ${conError.length} fila(s) con errores: corrígelas (o quítalas) antes de importar. Primera: fila ${conError[0]?.fila}: ${conError[0]?.errores[0]}`,
      { filas: conError.map((f) => ({ fila: f.fila, nif: f.nif, errores: f.errores })) },
    );
  }
  const periodos = vista.resumen.periodos.map(({ ejercicio, mes }) => ({ ejercicio, mes }));
  if (opciones.contabilizar) {
    for (const p of periodos) await comprobarFechaAbierta(companyId, ultimoDiaMes(p.ejercicio, p.mes));
  }
  const filas = vista.filas;
  const loteImportacionId = randomUUID();

  const r = await conReintento(() =>
    prisma.$transaction(async (tx) => {
      // Trabajadores: los que ya existen (releidos dentro de la transaccion) y los nuevos.
      const nifs = [...new Set(filas.map((f) => f.nif))];
      const existentes = await tx.empleado.findMany({ where: { companyId, nif: { in: nifs } }, select: { id: true, nif: true } });
      const idPorNif = new Map(existentes.map((e) => [e.nif, e.id]));
      const nuevos: Prisma.EmpleadoCreateManyInput[] = [];
      for (const f of filas) {
        if (idPorNif.has(f.nif)) continue;
        const id = randomUUID();
        idPorNif.set(f.nif, id);
        nuevos.push({
          id,
          companyId,
          nif: f.nif,
          nombre: (f.nombre || f.apellidos).slice(0, 120),
          apellidos: f.nombre ? f.apellidos.slice(0, 120) : '',
          naf: f.naf,
          porcentajeIrpfActual: f.porcentajeIrpf,
          observaciones: 'Dado de alta al importar las nóminas de la gestoría.',
        });
      }
      if (nuevos.length) await tx.empleado.createMany({ data: nuevos });
      // NAF y % de IRPF de los que ya existian y no los tenian.
      for (const f of filas) {
        if (!f.naf || nuevos.some((n) => n.nif === f.nif)) continue;
        await tx.empleado.updateMany({ where: { companyId, nif: f.nif, naf: null }, data: { naf: f.naf } });
      }

      // Nominas que ya hay para esas claves (otra importacion pudo colarse entre la vista previa y esto).
      const empleadoIds = [...new Set(filas.map((f) => idPorNif.get(f.nif)!))];
      const previas = await tx.nomina.findMany({
        where: { companyId, empleadoId: { in: empleadoIds }, ejercicio: { in: [...new Set(filas.map((f) => f.ejercicio))] } },
        select: { id: true, empleadoId: true, ejercicio: true, mes: true, tipo: true, estado: true },
      });
      const previaPorClave = new Map(previas.map((n) => [`${n.empleadoId}|${n.ejercicio}|${n.mes}|${n.tipo}`, n]));
      const crear: Prisma.NominaCreateManyInput[] = [];
      const ids: string[] = [];
      let sustituidas = 0;
      for (const f of filas) {
        const empleadoId = idPorNif.get(f.nif)!;
        const fechaDevengo = ultimoDiaMes(f.ejercicio, f.mes);
        const datos = {
          ejercicio: f.ejercicio,
          mes: f.mes,
          tipo: f.tipo,
          fechaDevengo,
          fechaPago: fechaDevengo,
          ...importesDe(f as unknown as Record<string, unknown>),
          porcentajeIrpf: f.porcentajeIrpf,
          estado: 'BORRADOR',
          asientoId: null,
          asientoAnulacionId: null,
          anuladaEn: null,
          loteImportacionId,
          origen: 'importacion',
        };
        const previa = previaPorClave.get(`${empleadoId}|${f.ejercicio}|${f.mes}|${f.tipo}`);
        if (previa) {
          if (previa.estado === 'CONTABILIZADA') {
            throw conflict(`La nómina de ${periodoTexto(f.ejercicio, f.mes)} de ${f.nif} se ha contabilizado mientras tanto: anúlala antes de volver a importarla.`);
          }
          const u = await tx.nomina.updateMany({ where: { id: previa.id, estado: { in: ['BORRADOR', 'ANULADA'] } }, data: datos });
          if (u.count !== 1) throw conflict(`La nómina de ${periodoTexto(f.ejercicio, f.mes)} de ${f.nif} ha cambiado mientras tanto: vuelve a importar.`);
          sustituidas++;
          ids.push(previa.id);
        } else {
          const id = randomUUID();
          crear.push({ id, companyId, empleadoId, ...datos });
          ids.push(id);
        }
      }
      if (crear.length) await tx.nomina.createMany({ data: crear });
      return { creadas: crear.length, sustituidas, empleadosCreados: nuevos.length, ids };
    }, OPCIONES_TX),
  );

  const resultado: ResultadoImportacion = {
    loteImportacionId,
    nominasCreadas: r.creadas,
    nominasSustituidas: r.sustituidas,
    empleadosCreados: r.empleadosCreados,
    periodos,
    nominaIds: r.ids,
    avisos: vista.avisos,
  };
  if (opciones.contabilizar) {
    resultado.contabilizacion = [];
    for (const p of periodos) {
      const idsDelMes = r.ids.filter((_, i) => filas[i].ejercicio === p.ejercicio && filas[i].mes === p.mes);
      resultado.contabilizacion.push(await contabilizarNominas(companyId, p.ejercicio, p.mes, idsDelMes));
    }
  }
  return resultado;
}

// ---------------------------------------------------------------------------
// Contabilizacion
// ---------------------------------------------------------------------------

interface LineaPrevia {
  cuenta: string;
  nombre: string;
  debe: number;
  haber: number;
}

export interface AsientoPrevio {
  nominaId: string;
  empleadoId: string;
  trabajador: string;
  nif: string;
  estado: string;
  /** Numero del asiento si ya esta contabilizada. */
  numero: string | null;
  fecha: string;
  concepto: string;
  /** La subcuenta 465 del trabajador aun no existe: se creara al contabilizar. */
  subcuentaNueva: boolean;
  lineas: LineaPrevia[];
  debe: number;
  haber: number;
  cuadra: boolean;
  error: string | null;
}

/**
 * Asientos del mes: los de las nominas contabilizadas (tal como estan) y los
 * que se generarian para las que estan en borrador.
 */
export async function previsualizarAsientos(companyId: string, ejercicio: number, mes: number, nominaIds?: string[]): Promise<{ asientos: AsientoPrevio[]; cuadran: boolean }> {
  const nominas = await prisma.nomina.findMany({
    where: { companyId, ejercicio, mes, estado: { in: ['BORRADOR', 'CONTABILIZADA'] }, ...(nominaIds?.length ? { id: { in: nominaIds } } : {}) },
    include: { empleado: true },
    orderBy: { createdAt: 'asc' },
  });
  const { cuentas, longitud } = await cuentasNominasEmpresa(companyId);
  const ocupadas = await subcuentas465Ocupadas(prisma, companyId);
  const asignadas = new Map<string, string>();
  const reales = await prisma.journalEntry.findMany({
    where: { id: { in: nominas.map((n) => n.asientoId).filter((x): x is string => !!x) } },
    include: { lineas: true },
  });
  const realPorId = new Map(reales.map((a) => [a.id, a]));

  const asientos: AsientoPrevio[] = nominas.map((n) => {
    const nombre = nombreCompleto(n.empleado);
    const base = { nominaId: n.id, empleadoId: n.empleadoId, trabajador: nombre, nif: n.empleado.nif, estado: n.estado };
    const real = n.asientoId ? realPorId.get(n.asientoId) : undefined;
    if (n.estado === 'CONTABILIZADA' && real) {
      const lineas = real.lineas.map((l) => ({ cuenta: l.accountCode, nombre: l.accountName, debe: Number(l.debe), haber: Number(l.haber) }));
      const debe = round2(lineas.reduce((a, l) => a + l.debe, 0));
      const haber = round2(lineas.reduce((a, l) => a + l.haber, 0));
      return {
        ...base,
        numero: real.numeroAsiento,
        fecha: real.fecha.toISOString().slice(0, 10),
        concepto: real.descripcion,
        subcuentaNueva: false,
        lineas,
        debe,
        haber,
        cuadra: aCentimos(debe) === aCentimos(haber),
        error: null,
      };
    }
    let subcuenta = n.empleado.subcuenta465 ?? asignadas.get(n.empleadoId) ?? null;
    const subcuentaNueva = !n.empleado.subcuenta465;
    if (!subcuenta) {
      subcuenta = siguienteSubcuenta465(ocupadas, longitud, cuentas);
      ocupadas.add(subcuenta);
      asignadas.set(n.empleadoId, subcuenta);
    }
    try {
      const a = generarAsientoNomina(
        { ...importesDe(n as unknown as Record<string, unknown>), ejercicio: n.ejercicio, mes: n.mes, tipo: n.tipo, fechaDevengo: n.fechaDevengo },
        cuentas,
        { nombreCompleto: nombre, nif: n.empleado.nif, subcuenta465: subcuenta },
      );
      return {
        ...base,
        numero: null,
        fecha: a.fecha,
        concepto: a.descripcion,
        subcuentaNueva,
        lineas: a.lineas.map((l) => ({ cuenta: l.subcuenta, nombre: l.concepto, debe: l.debe, haber: l.haber })),
        debe: a.debeTotal,
        haber: a.haberTotal,
        cuadra: true,
        error: null,
      };
    } catch (e) {
      return {
        ...base,
        numero: null,
        fecha: n.fechaDevengo,
        concepto: conceptoAsientoNomina(n, nombre),
        subcuentaNueva,
        lineas: [],
        debe: 0,
        haber: 0,
        cuadra: false,
        error: (e as Error).message,
      };
    }
  });
  return { asientos, cuadran: asientos.every((a) => a.cuadra) };
}

export interface ResultadoContabilizacion {
  ejercicio: number;
  mes: number;
  contabilizadas: number;
  asientos: Array<{ nominaId: string; empleadoId: string; trabajador: string; asientoId: string; numero: string; subcuenta465: string; importe: number }>;
  subcuentasCreadas: string[];
}

/**
 * Contabiliza las nominas en borrador de un mes (o las indicadas): un asiento
 * por nomina, con la subcuenta 465 del trabajador. Todo o nada.
 */
export async function contabilizarNominas(companyId: string, ejercicio: number, mes: number, nominaIds?: string[]): Promise<ResultadoContabilizacion> {
  const filtroIds = nominaIds?.length ? { id: { in: nominaIds } } : {};
  const nominas = await prisma.nomina.findMany({
    where: { companyId, ejercicio, mes, ...filtroIds },
    include: { empleado: true },
    orderBy: { createdAt: 'asc' },
  });
  if (nominaIds?.length) {
    const encontradas = new Set(nominas.map((n) => n.id));
    const faltan = nominaIds.filter((id) => !encontradas.has(id));
    if (faltan.length) throw badRequest(`Hay ${faltan.length} nómina(s) que no son de ${periodoTexto(ejercicio, mes)} en esta empresa.`);
    const yaHechas = nominas.filter((n) => n.estado !== 'BORRADOR');
    if (yaHechas.length) {
      throw conflict(`${yaHechas.length} de las nóminas indicadas no están en borrador (${yaHechas.map((n) => nombreCompleto(n.empleado)).slice(0, 3).join(', ')}).`);
    }
  }
  const pendientes = nominas.filter((n) => n.estado === 'BORRADOR');
  if (!pendientes.length) {
    const contabilizadas = nominas.filter((n) => n.estado === 'CONTABILIZADA').length;
    throw conflict(
      contabilizadas
        ? `Las nóminas de ${periodoTexto(ejercicio, mes)} ya están contabilizadas.`
        : `No hay nóminas en borrador en ${periodoTexto(ejercicio, mes)}.`,
    );
  }
  const descuadradas = pendientes.filter((n) => !cuadreNomina(importesDe(n as unknown as Record<string, unknown>)).cuadra);
  if (descuadradas.length) {
    throw badRequest(
      `${descuadradas.length} nómina(s) no cuadran (${descuadradas.map((n) => nombreCompleto(n.empleado)).slice(0, 3).join(', ')}): corrígelas antes de contabilizar.`,
    );
  }
  for (const fecha of new Set(pendientes.map((n) => n.fechaDevengo))) await comprobarFechaAbierta(companyId, fecha);

  const { cuentas, longitud } = await cuentasNominasEmpresa(companyId);
  await prepararPlanEmpresa(companyId);

  return conReintento(() =>
    prisma.$transaction(async (tx) => {
      // Las nominas pasan a CONTABILIZADA primero: si otro proceso las coge a la vez, uno de los dos para aqui.
      const ids = pendientes.map((n) => n.id);
      const marcadas = await tx.nomina.updateMany({ where: { id: { in: ids }, estado: 'BORRADOR' }, data: { estado: 'CONTABILIZADA' } });
      if (marcadas.count !== ids.length) throw conflict('Alguna nómina ha cambiado de estado mientras tanto: vuelve a cargar el mes.');

      const ocupadas = await subcuentas465Ocupadas(tx, companyId);
      const fichas = await tx.empleado.findMany({ where: { companyId, id: { in: [...new Set(pendientes.map((n) => n.empleadoId))] } } });
      const trabajadores = new Map<string, TrabajadorPlan & { nif: string }>(
        fichas.map((e) => [e.id, { id: e.id, nombreCompleto: nombreCompleto(e), subcuenta465: e.subcuenta465, nif: e.nif }]),
      );
      const subcuentasCreadas: string[] = [];
      const usadas = new Set<string>();
      const generados: Array<{ n: (typeof pendientes)[number]; t: TrabajadorPlan & { nif: string }; subcuenta: string; asiento: ReturnType<typeof generarAsientoNomina> }> = [];
      for (const n of pendientes) {
        const t = trabajadores.get(n.empleadoId)!;
        const teniaSubcuenta = !!t.subcuenta465;
        const subcuenta = await asegurarSubcuenta465(tx, companyId, t, cuentas, longitud, ocupadas);
        if (!teniaSubcuenta) subcuentasCreadas.push(subcuenta);
        const asiento = generarAsientoNomina(
          { ...importesDe(n as unknown as Record<string, unknown>), ejercicio: n.ejercicio, mes: n.mes, tipo: n.tipo, fechaDevengo: n.fechaDevengo },
          cuentas,
          { nombreCompleto: t.nombreCompleto, nif: t.nif, subcuenta465: subcuenta },
        );
        for (const l of asiento.lineas) if (l.subcuenta !== subcuenta) usadas.add(l.subcuenta);
        generados.push({ n, t, subcuenta, asiento });
      }
      await asegurarCuentasNominas(tx, companyId, cuentas, usadas);

      const asientos: ResultadoContabilizacion['asientos'] = [];
      for (const { n, t, subcuenta, asiento } of generados) {
        const creado = await crearAsientoConApuntes(companyId, {
          tx,
          fecha: asiento.fecha,
          concepto: asiento.descripcion,
          apuntes: asiento.lineas,
          origen: 'NOMINA',
          invoiceId: n.id,
          invoiceType: 'NOMINA',
          referencia: `NOM ${periodoTexto(n.ejercicio, n.mes)} ${t.nif}`,
          exigirCuadre: true,
        });
        const asientoId = String(creado.asiento.idasiento);
        await tx.nomina.update({ where: { id: n.id }, data: { asientoId, asientoAnulacionId: null, anuladaEn: null } });
        asientos.push({
          nominaId: n.id,
          empleadoId: n.empleadoId,
          trabajador: t.nombreCompleto,
          asientoId,
          numero: String(creado.asiento.numero),
          subcuenta465: subcuenta,
          importe: asiento.debeTotal,
        });
      }
      return { ejercicio, mes, contabilizadas: asientos.length, asientos, subcuentasCreadas };
    }, OPCIONES_TX),
  );
}

// ---------------------------------------------------------------------------
// Anulacion
// ---------------------------------------------------------------------------

export interface OpcionesAnulacion {
  nominaIds?: string[];
  /** Fecha del contraasiento si el periodo del asiento esta cerrado (por defecto, hoy). */
  fecha?: string;
  /** true: las nominas quedan ANULADAS; si no, vuelven a BORRADOR para corregirlas. */
  dejarAnuladas?: boolean;
}

export interface ResultadoAnulacion {
  ejercicio: number;
  mes: number;
  anuladas: number;
  estadoFinal: 'BORRADOR' | 'ANULADA';
  asientosRevertidos: string[];
  contraasientos: Array<{ nominaId: string; asientoId: string; numero: string }>;
}

async function periodoAbiertoEn(companyId: string, fecha: string): Promise<boolean> {
  try {
    await comprobarFechaAbierta(companyId, fecha);
    return true;
  } catch {
    return false;
  }
}

/**
 * Anula las nominas contabilizadas de un mes (o las indicadas). Con
 * `dejarAnuladas`, las que estan en borrador indicadas tambien quedan anuladas.
 */
export async function anularNominas(companyId: string, ejercicio: number, mes: number, opciones: OpcionesAnulacion = {}): Promise<ResultadoAnulacion> {
  const estadoFinal = opciones.dejarAnuladas ? 'ANULADA' : 'BORRADOR';
  const nominas = await prisma.nomina.findMany({
    where: { companyId, ejercicio, mes, ...(opciones.nominaIds?.length ? { id: { in: opciones.nominaIds } } : {}) },
    include: { empleado: true },
  });
  if (opciones.nominaIds?.length && nominas.length !== new Set(opciones.nominaIds).size) {
    throw badRequest(`Alguna de las nóminas indicadas no es de ${periodoTexto(ejercicio, mes)} en esta empresa.`);
  }
  const contabilizadas = nominas.filter((n) => n.estado === 'CONTABILIZADA');
  const borradores = opciones.dejarAnuladas && opciones.nominaIds?.length ? nominas.filter((n) => n.estado === 'BORRADOR') : [];
  if (!contabilizadas.length && !borradores.length) throw conflict(`No hay nóminas contabilizadas en ${periodoTexto(ejercicio, mes)}.`);

  const originales = await prisma.journalEntry.findMany({
    where: { companyId, id: { in: contabilizadas.map((n) => n.asientoId).filter((x): x is string => !!x) } },
    include: { lineas: true },
  });
  const porId = new Map(originales.map((a) => [a.id, a]));
  const abiertoPorFecha = new Map<string, boolean>();
  for (const a of originales) {
    const f = a.fecha.toISOString().slice(0, 10);
    if (!abiertoPorFecha.has(f)) abiertoPorFecha.set(f, await periodoAbiertoEn(companyId, f));
  }
  const hayCerrados = [...abiertoPorFecha.values()].some((v) => !v);
  let fechaAnulacion = opciones.fecha ?? hoyEspana();
  if (hayCerrados) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaAnulacion)) throw badRequest('La fecha de anulación no es válida (AAAA-MM-DD).');
    await comprobarFechaAbierta(companyId, fechaAnulacion);
  } else fechaAnulacion = '';

  return conReintento(() =>
    prisma.$transaction(async (tx) => {
      const asientosRevertidos: string[] = [];
      const contraasientos: ResultadoAnulacion['contraasientos'] = [];
      for (const n of contabilizadas) {
        const original = n.asientoId ? porId.get(n.asientoId) : undefined;
        let asientoAnulacionId: string | null = null;
        if (original && original.estado !== 'REVERSED') {
          const abierto = abiertoPorFecha.get(original.fecha.toISOString().slice(0, 10)) ?? true;
          if (abierto) {
            await tx.journalEntry.update({ where: { id: original.id }, data: { estado: 'REVERSED' } });
            asientosRevertidos.push(original.numeroAsiento);
          } else {
            const contra = await crearAsientoConApuntes(companyId, {
              tx,
              fecha: fechaAnulacion,
              concepto: `Anulación ${original.descripcion} (${original.numeroAsiento})`.slice(0, 190),
              apuntes: original.lineas.map((l) => ({ subcuenta: l.accountCode, concepto: l.accountName, debe: Number(l.haber), haber: Number(l.debe) })),
              origen: 'NOMINA',
              invoiceId: n.id,
              invoiceType: 'NOMINA',
              referencia: `REV ${original.numeroAsiento}`,
              exigirCuadre: true,
            });
            asientoAnulacionId = String(contra.asiento.idasiento);
            contraasientos.push({ nominaId: n.id, asientoId: asientoAnulacionId, numero: String(contra.asiento.numero) });
          }
        }
        const r = await tx.nomina.updateMany({
          where: { id: n.id, estado: 'CONTABILIZADA' },
          data: {
            estado: estadoFinal,
            asientoId: estadoFinal === 'BORRADOR' ? null : n.asientoId,
            asientoAnulacionId,
            anuladaEn: new Date(),
          },
        });
        if (r.count !== 1) throw conflict('Alguna nómina ha cambiado de estado mientras tanto: vuelve a cargar el mes.');
      }
      if (borradores.length) {
        await tx.nomina.updateMany({ where: { id: { in: borradores.map((b) => b.id) }, estado: 'BORRADOR' }, data: { estado: 'ANULADA', anuladaEn: new Date() } });
      }
      return {
        ejercicio,
        mes,
        anuladas: contabilizadas.length + borradores.length,
        estadoFinal,
        asientosRevertidos,
        contraasientos,
      };
    }, OPCIONES_TX),
  );
}

// ---------------------------------------------------------------------------
// Resumen mensual (modelo 111 y compatibilidad)
// ---------------------------------------------------------------------------

/**
 * Totales por mes del ejercicio. Los meses con nominas por trabajador se
 * calculan con ellas (sin las anuladas); los demas usan el resumen antiguo
 * (NominaResumen), y si un mes tiene varios, el ultimo grabado (antes se podia
 * grabar dos veces el mismo mes y el 111 lo sumaba doble).
 * totalBruto = dinerario sujeto a retencion (bruto dinerario + indemnizacion sujeta).
 */
export async function listarResumenesNominas(companyId: string, ejercicio: number): Promise<NominaResumen[]> {
  const porMes = new Map<number, NominaResumen>();
  const db = prisma as unknown as { nomina?: { findMany?: unknown } };
  if (typeof db.nomina?.findMany === 'function') {
    const nominas = await prisma.nomina.findMany({ where: { companyId, ejercicio, estado: { not: 'ANULADA' } } });
    const grupos = new Map<number, typeof nominas>();
    for (const n of nominas) grupos.set(n.mes, [...(grupos.get(n.mes) ?? []), n]);
    for (const [mes, lista] of grupos) {
      const s = (f: (n: (typeof nominas)[number]) => unknown) => round2(lista.reduce((a, n) => a + aCentimos(Number(f(n) ?? 0)), 0) / 100);
      porMes.set(mes, {
        id: `nominas-${ejercicio}-${mes}`,
        companyId,
        mes,
        ejercicio,
        totalBruto: round2(s((n) => n.brutoDinerario) + s((n) => n.indemnizacionSujeta)),
        totalSeguridadSocialEmpresa: s((n) => n.ssEmpresa),
        totalSeguridadSocialTrabajador: s((n) => n.ssTrabajador),
        totalIRPF: s((n) => n.irpf),
        totalLiquido: s((n) => n.liquido),
        origen: 'nominas',
        perceptores: new Set(lista.map((n) => n.empleadoId)).size,
      });
    }
  }
  const antiguos = await prisma.nominaResumen.findMany({ where: { companyId, ejercicio }, orderBy: { createdAt: 'desc' } });
  for (const r of antiguos) {
    if (porMes.has(r.mes)) continue; // el mas reciente ya esta, o el mes tiene nominas por trabajador
    porMes.set(r.mes, {
      id: r.id,
      companyId: r.companyId,
      mes: r.mes,
      ejercicio: r.ejercicio,
      totalBruto: Number(r.totalBruto),
      totalSeguridadSocialEmpresa: Number(r.totalSeguridadSocialEmpresa),
      totalSeguridadSocialTrabajador: Number(r.totalSeguridadSocialTrabajador),
      totalIRPF: Number(r.totalIRPF),
      totalLiquido: Number(r.totalLiquido),
      origen: 'resumen',
    });
  }
  return [...porMes.values()].sort((a, b) => a.mes - b.mes);
}

// ---------------------------------------------------------------------------
// Plantilla
// ---------------------------------------------------------------------------

/** Excel con las columnas que reconoce el importador (y una hoja de instrucciones). */
export function generarPlantillaNominas(): Buffer {
  const wb = XLSX.utils.book_new();
  const hoja = XLSX.utils.aoa_to_sheet([TITULOS_PLANTILLA.map(([, t]) => t)]);
  hoja['!cols'] = TITULOS_PLANTILLA.map(([, t]) => ({ wch: Math.max(12, t.length + 2) }));
  XLSX.utils.book_append_sheet(wb, hoja, 'Nóminas');
  const instrucciones = [
    ['Una fila por trabajador y nómina. Importes en euros, con coma o punto decimal.'],
    ['Obligatorias: NIF, Total devengado y Líquido a percibir. Si falta una columna de importe, se toma 0.'],
    ['Mes: 01/2026, 2026-01 o "enero 2026". Si no hay columna Mes, se indica al importar.'],
    ['Tipo: ordinaria (por defecto), extra, atrasos, finiquito o complementaria.'],
    ['Cuadre de cada fila: devengado (incluida la especie) - SS trabajador - IRPF - especie - embargos - anticipos - otras deducciones = líquido (1 céntimo de margen).'],
    ['Los títulos de A3, Nominasol o Sage también se reconocen ("Aportación trabajador", "Coste SS empresa"...). Si alguno no, se indica a mano en la vista previa.'],
    [],
    ['Columna', 'Dato'],
    ...TITULOS_PLANTILLA.map(([campo, t]) => [t, ETIQUETAS_CAMPOS[campo]]),
  ];
  const hojaInstr = XLSX.utils.aoa_to_sheet(instrucciones);
  hojaInstr['!cols'] = [{ wch: 28 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, hojaInstr, 'Instrucciones');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export { fmtEuros };
export type { CuadreNomina };
