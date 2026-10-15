import type { Prisma } from '@prisma/client';
import { prisma, type ClienteBD, type TransaccionBD } from '../../config/database';
import { perfilDesdeConfig } from '../perfilEmpresa.service';
import { badRequest, conflict, HttpError } from '../../utils/http-errors';
import { formatearHusoMadrid, hoyEspana } from '../../utils/fechas';
import { textoAvisoCaducidad } from './certificado.service';

/**
 * Red de seguridad de VERI*FACTU (spec verifactu, apartado 9).
 *
 * Desde el 1-1-2027 (hora de Madrid) la app no deja EMITIR facturas de una
 * empresa española que no tenga VERI*FACTU activo. Borradores, proformas,
 * duplicar, «pasar a factura» (crea un borrador) y las facturas que llegan de
 * los lectores (las expidio otro programa) nunca se bloquean.
 *
 * Se mira el instante en que se emite, no la fecha de la factura: una factura
 * con fecha de 2026 emitida el 2-1-2027 tambien se bloquea.
 *
 * Solo el administrador global puede desactivarla (AjustePlataforma), y solo
 * con la referencia del BOE que publique el aplazamiento. Desactivarla no
 * desactiva VERI*FACTU en las empresas que ya lo tengan (Orden HAC/1177/2024, art. 17).
 */

/** details.codigo del 409 que devuelve la emision bloqueada. */
export const CODIGO_VERIFACTU_INACTIVO = 'VERIFACTU_INACTIVO';
/** Clave de la red en AjustePlataforma. */
export const CLAVE_RED_SEGURIDAD = 'verifactu.redSeguridad';
/** Sociedades (contribuyentes del Impuesto sobre Sociedades): RD 1007/2023, disp. final 4.ª. */
export const INICIO_SOCIEDADES = '2027-01-01';
/** Resto de obligados (autónomos). */
export const INICIO_RESTO = '2027-07-01';
/** Desde este dia se avisa en Ventas de lo que va a pasar. */
export const INICIO_AVISOS = '2026-12-01';
/** Exclusiones que admite la configuracion: SII (RD 1007/2023, art. 3.3) y regimen foral (art. 1.3). */
export const EXCLUSIONES = ['SII', 'FORAL'] as const;
export type Exclusion = (typeof EXCLUSIONES)[number];

/** Lo que lee la red de la configuracion de VERI*FACTU de la empresa. */
export interface ConfigVerifactuRed {
  estado: string;
  entorno: string;
  activaDesde: Date | null;
  motivoExclusion: string | null;
}

export interface DatosRedSeguridad {
  espanola: boolean;
  /** LegalConfig.tipoSociedad (SA, SL, SLU, AUTONOMO...). null: sin configuracion legal (sociedad). */
  tipoSociedad: string | null;
  /** AjustesFiscales.sii */
  sii: boolean;
  /** null: la empresa no tiene configuracion de VERI*FACTU (= no activo). */
  config: ConfigVerifactuRed | null;
  /** false solo si el administrador global la ha desactivado. */
  redActiva: boolean;
  certificadoVigente: boolean;
  /** Empresa de pruebas de VERI*FACTU (Company.pruebasVerifactuDe). Sin el dato, no lo es. */
  empresaPruebas?: boolean;
}

export type ResultadoRed = { ok: true } | { ok: false; motivo: string };

/** Fecha (AAAA-MM-DD, hora de Madrid) desde la que se bloquea: sociedades el 1-1-2027, autónomos el 1-7-2027. */
export function inicioRedSeguridad(tipoSociedad: string | null | undefined): string {
  return String(tipoSociedad ?? '').trim().toUpperCase() === 'AUTONOMO' ? INICIO_RESTO : INICIO_SOCIEDADES;
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** «2027-01-01» -> «1 de enero de 2027», como se escribe en los avisos (no se parte en dos lineas). */
export function fechaLarga(iso: string): string {
  const [a, m, d] = iso.split('-');
  return `${Number(d)} de ${MESES[Number(m) - 1]} de ${a}`;
}

/** Regla unica de «activo en este instante» (spec 2.1). */
export function verifactuActivo(config: { estado: string; activaDesde: Date | null } | null, ahora: Date): boolean {
  return !!config && config.estado === 'ACTIVO' && config.activaDesde != null && ahora.getTime() >= config.activaDesde.getTime();
}

/**
 * SII o FORAL, si la empresa esta fuera de VERI*FACTU. Solo cuenta la exclusion
 * que aprobo un administrador de la empresa (VerifactuConfig.motivoExclusion,
 * con su rastro en AuditLog). Marcar el SII en los ajustes fiscales, que puede
 * hacer quien lleva los impuestos, no abre la red por si solo. Y una exclusion
 * SII deja de valer si el SII se desmarca en los ajustes fiscales (spec 9.2:
 * «copia AjustesFiscales.sii»).
 */
export function exclusionDe(d: Pick<DatosRedSeguridad, 'sii' | 'config'>): Exclusion | null {
  const anotada = String(d.config?.motivoExclusion ?? '').trim().toUpperCase();
  if (anotada === 'FORAL') return 'FORAL';
  if (anotada === 'SII' && d.sii) return 'SII';
  return null;
}

/** Texto comun del bloqueo. Quien lo usa añade la salida que tiene sentido donde esta el usuario. */
export function motivoBloqueo(inicio: string): string {
  return `Esta empresa todavía no tiene VERI*FACTU activo y desde el ${fechaLarga(inicio)} no se pueden emitir facturas sin él.`;
}

/** La regla, sin base de datos. `ahora` es el instante en que se emite. */
export function evaluarRedSeguridad(d: DatosRedSeguridad, ahora: Date): ResultadoRed {
  if (!d.espanola) return { ok: true }; // EE. UU. y Hong Kong: fuera del RD 1007/2023
  if (exclusionDe(d)) return { ok: true }; // SII o foral
  const inicio = inicioRedSeguridad(d.tipoSociedad);
  if (hoyEspana(ahora) < inicio) return { ok: true }; // fecha por hora de Madrid
  if (!d.redActiva) return { ok: true };
  // Empresa de pruebas en PRUEBAS: sus facturas nunca son reales (solo van al entorno de pruebas de la AEAT).
  if (d.empresaPruebas && d.config?.estado === 'PRUEBAS') return { ok: true };
  if (d.config && verifactuActivo(d.config, ahora) && d.config.entorno === 'PRODUCCION' && d.certificadoVigente) return { ok: true };
  return { ok: false, motivo: motivoBloqueo(inicio) };
}

/**
 * Instante con el que se evalua la red: la hora real. Solo con NODE_ENV=test se
 * puede fijar con VERIFACTU_RED_RELOJ_PRUEBAS (lo hace jest.setup.ts), para que
 * los tests de facturas no empiecen a fallar el 1-1-2027 y los de la red puedan
 * situarse a un lado y otro de la fecha.
 */
export function ahoraRedSeguridad(real: Date = new Date()): Date {
  if (process.env.NODE_ENV === 'test' && process.env.VERIFACTU_RED_RELOJ_PRUEBAS) {
    const fijo = new Date(process.env.VERIFACTU_RED_RELOJ_PRUEBAS);
    if (!Number.isNaN(fijo.getTime())) return fijo;
  }
  return real;
}

// --- Interruptor del administrador global (AjustePlataforma) ---

export interface EstadoInterruptor {
  activa: boolean;
  motivo: string | null;
  referenciaBoe: string | null;
  cambiadoPor: string | null;
  cambiadoEn: Date | null;
}

type Db = ClienteBD | TransaccionBD;

/** Estado de la red. Sin fila (o con un valor que no se entiende), activa: ante la duda, se protege. */
export async function leerInterruptorRed(db: Db = prisma): Promise<EstadoInterruptor> {
  const fila = await db.ajustePlataforma.findUnique({ where: { clave: CLAVE_RED_SEGURIDAD } });
  const valor = (fila?.valor ?? null) as Record<string, unknown> | null;
  const texto = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    activa: !(valor && typeof valor === 'object' && valor.activa === false),
    motivo: texto(valor?.motivo),
    referenciaBoe: texto(valor?.referenciaBoe),
    cambiadoPor: fila?.cambiadoPor ?? null,
    cambiadoEn: fila?.cambiadoEn ?? null,
  };
}

const REFERENCIA_BOE_RE = /^BOE-A-\d{4}-\d{1,6}$/;
const MOTIVO_MAX = 500;

/** Referencia del BOE con la forma BOE-A-AAAA-NNNNN, normalizada (mayusculas, sin espacios alrededor). */
export function validarReferenciaBoe(valor: unknown): string {
  const ref = typeof valor === 'string' ? valor.trim().toUpperCase() : '';
  if (!REFERENCIA_BOE_RE.test(ref)) {
    throw badRequest(
      'Escribe la referencia del BOE que publica el aplazamiento, con la forma BOE-A-AAAA-NNNNN (por ejemplo, BOE-A-2026-24840).',
      { campo: 'referenciaBoe' },
    );
  }
  return ref;
}

/**
 * Activa o desactiva la red. Desactivarla exige la referencia del BOE y un
 * motivo. El cambio y la auditoria (AuditLog, RED_SEGURIDAD_CAMBIADA) se
 * guardan en la misma transaccion: no queda un cambio sin su rastro.
 */
export async function cambiarInterruptorRed(
  userId: string,
  datos: { activa?: unknown; referenciaBoe?: unknown; motivo?: unknown },
  ahora: Date = new Date(),
): Promise<EstadoInterruptor> {
  if (typeof datos.activa !== 'boolean') {
    throw badRequest('Indica si la red de seguridad queda activa (true) o desactivada (false).', { campo: 'activa' });
  }
  const motivo = typeof datos.motivo === 'string' ? datos.motivo.trim() : '';
  if (motivo.length > MOTIVO_MAX) throw badRequest(`El motivo admite como máximo ${MOTIVO_MAX} caracteres.`, { campo: 'motivo' });
  let referenciaBoe: string | null = null;
  if (!datos.activa) {
    referenciaBoe = validarReferenciaBoe(datos.referenciaBoe);
    if (!motivo) throw badRequest('Explica por qué se desactiva la red de seguridad.', { campo: 'motivo' });
  }
  const valor = { activa: datos.activa, ...(motivo ? { motivo } : {}), ...(referenciaBoe ? { referenciaBoe } : {}) };

  return prisma.$transaction(async (tx) => {
    const antes = await leerInterruptorRed(tx);
    await tx.ajustePlataforma.upsert({
      where: { clave: CLAVE_RED_SEGURIDAD },
      create: { clave: CLAVE_RED_SEGURIDAD, valor, cambiadoPor: userId },
      update: { valor, cambiadoPor: userId },
    });
    await tx.auditLog.create({
      data: {
        userId,
        companyId: null,
        action: 'RED_SEGURIDAD_CAMBIADA',
        resourceType: 'AJUSTE_PLATAFORMA',
        resourceId: CLAVE_RED_SEGURIDAD,
        meta: {
          antes: { activa: antes.activa, referenciaBoe: antes.referenciaBoe, motivo: antes.motivo },
          despues: valor,
          instante: formatearHusoMadrid(ahora),
        } as Prisma.InputJsonValue,
      },
    });
    return leerInterruptorRed(tx);
  });
}

// --- La regla con los datos de la empresa ---

/** El certificado sirve en `ahora`: existe y esta entre su fecha de inicio y la de caducidad. */
export function certificadoVigenteEn(cert: { validoDesde: Date; caducaEn: Date } | null, ahora: Date): boolean {
  return !!cert && cert.validoDesde.getTime() <= ahora.getTime() && ahora.getTime() < cert.caducaEn.getTime();
}

type DatosConCertificado = DatosRedSeguridad & { certificado: { validoDesde: Date; caducaEn: Date } | null };

/** Datos de la red, una consulta detras de otra (con `db` puede ser una transaccion). */
async function datosRedConCertificado(companyId: string, ahora: Date, db: Db = prisma): Promise<DatosConCertificado> {
  const legal = await db.legalConfig.findUnique({ where: { companyId }, select: { pais: true, monedaCuenta: true, tipoSociedad: true } });
  const ajustes = await db.ajustesFiscales.findUnique({ where: { companyId }, select: { sii: true } });
  const config = await db.verifactuConfig.findUnique({
    where: { companyId },
    select: { estado: true, entorno: true, activaDesde: true, motivoExclusion: true },
  });
  const red = await leerInterruptorRed(db);
  const empresa = await db.company.findUnique({ where: { id: companyId }, select: { pruebasVerifactuDe: true } });
  // Solo las fechas: el certificado no se abre aqui. La red sigue pidiendo
  // ACTIVO + PRODUCCION, y en la fase F2 no hay ruta que active.
  const certificado = await db.verifactuCertificado.findUnique({ where: { companyId }, select: { validoDesde: true, caducaEn: true } });
  return {
    espanola: perfilDesdeConfig(legal).espanola,
    tipoSociedad: legal?.tipoSociedad ?? null,
    sii: ajustes?.sii === true,
    config,
    redActiva: red.activa,
    certificadoVigente: certificadoVigenteEn(certificado, ahora),
    empresaPruebas: !!empresa?.pruebasVerifactuDe,
    certificado,
  };
}

/** ¿Se puede emitir ahora una factura FINAL de esta empresa? (spec 9.1) */
export async function puedeEmitirFinal(companyId: string, ahora: Date = ahoraRedSeguridad()): Promise<ResultadoRed> {
  return evaluarRedSeguridad(await datosRedConCertificado(companyId, ahora), ahora);
}

/** Error de la emision bloqueada: 409 con details.codigo VERIFACTU_INACTIVO. */
export function errorVerifactuInactivo(motivo: string): HttpError {
  return conflict(motivo, { codigo: CODIGO_VERIFACTU_INACTIVO, code: CODIGO_VERIFACTU_INACTIVO });
}

/**
 * Para los caminos que emiten (finalizar, emision directa de crear y la
 * rectificativa emitida al momento). Se llama FUERA de la transaccion y antes
 * de tocar nada: una emision bloqueada no crea clientes ni gasta numeros.
 * `salida`: lo que puede hacer el usuario desde ahi (se añade al motivo).
 */
export async function exigirPuedeEmitirFinal(companyId: string, ahora: Date = ahoraRedSeguridad(), salida?: string): Promise<void> {
  const r = await puedeEmitirFinal(companyId, ahora);
  if (!r.ok) throw errorVerifactuInactivo(salida ? `${r.motivo} ${salida}` : r.motivo);
}

export interface EstadoRedEmpresa {
  /** false: empresa extranjera, en el SII o foral (la red no le afecta). */
  aplica: boolean;
  exclusion: Exclusion | null;
  /** El SII esta marcado en los ajustes fiscales, pero ningun administrador ha aprobado la exclusion. */
  siiSinAprobar: boolean;
  /** Desde cuando bloquea (AAAA-MM-DD, hora de Madrid). */
  inicio: string;
  redActiva: boolean;
  verifactuActivo: boolean;
  /** true: ahora mismo no se puede emitir (el boton «Emitir» se deshabilita). */
  bloquea: boolean;
  motivo: string | null;
  /** Aviso previo para Ventas (desde el 1-12-2026), o null. */
  aviso: string | null;
  /** Empresa de pruebas de VERI*FACTU (sus facturas no son reales). */
  empresaPruebas: boolean;
  /** Aviso de caducidad del certificado (30 y 7 dias antes, y caducado), o null. */
  avisoCertificado: { nivel: 'aviso' | 'urgente' | 'caducado'; texto: string } | null;
}

/** Lo que necesita la pantalla de Ventas y el formulario de factura (GET /verifactu/red-seguridad). */
export async function estadoRedEmpresa(companyId: string, ahora: Date = ahoraRedSeguridad()): Promise<EstadoRedEmpresa> {
  const d = await datosRedConCertificado(companyId, ahora);
  const r = evaluarRedSeguridad(d, ahora);
  const exclusion = exclusionDe(d);
  const inicio = inicioRedSeguridad(d.tipoSociedad);
  const activo = verifactuActivo(d.config, ahora) && d.config?.entorno === 'PRODUCCION' && d.certificadoVigente;
  const aplica = d.espanola && !exclusion;
  const hoy = hoyEspana(ahora);
  // La empresa de pruebas en PRUEBAS sigue emitiendo despues del 1-1-2027 (evaluarRedSeguridad): no se le avisa de lo contrario.
  const pruebasQueEmite = d.empresaPruebas === true && d.config?.estado === 'PRUEBAS';
  const avisar = aplica && d.redActiva && !activo && !pruebasQueEmite && r.ok && hoy >= INICIO_AVISOS && hoy < inicio;
  return {
    aplica,
    exclusion,
    siiSinAprobar: d.espanola && d.sii && exclusion !== 'SII',
    inicio,
    redActiva: d.redActiva,
    verifactuActivo: activo,
    bloquea: !r.ok,
    motivo: r.ok ? null : r.motivo,
    aviso: avisar
      ? `Desde el ${fechaLarga(inicio)} no podrás emitir facturas desde aquí sin VERI*FACTU. Los borradores y las proformas se podrán seguir guardando.`
      : null,
    empresaPruebas: d.empresaPruebas === true,
    avisoCertificado: d.certificado && d.espanola ? textoAvisoCaducidad(d.certificado.caducaEn, ahora) : null,
  };
}

// --- Exclusion de la empresa (spec 9.2) ---

export interface EstadoExclusion {
  motivoExclusion: Exclusion | null;
  /** AjustesFiscales.sii, para que la pantalla explique por que una exclusion SII no vale. */
  sii: boolean;
}

/**
 * Fija o quita la exclusion de la empresa (SII o FORAL). Solo un administrador
 * de la empresa (la ruta pide admin:empresa; el administrador global tambien
 * pasa). El cambio y su rastro en AuditLog (VERIFACTU_EXCLUSION_CAMBIADA, con
 * el valor anterior, el nuevo y el motivo) van en la misma transaccion.
 *
 * - SII: solo si los ajustes fiscales dicen que la empresa lleva el SII
 *   (RD 1007/2023, art. 3.3). Si despues se desmarca alli, la exclusion deja de valer.
 * - FORAL: domicilio fiscal en el Pais Vasco o Navarra (art. 1.3).
 * - Con VERI*FACTU ya activo no se excluye: hay que seguir hasta fin de año
 *   (Orden HAC/1177/2024, art. 17).
 */
export async function fijarExclusion(
  companyId: string,
  userId: string,
  datos: { motivoExclusion?: unknown; motivo?: unknown },
  ahora: Date = new Date(),
): Promise<EstadoExclusion> {
  const pedido = datos.motivoExclusion === null || datos.motivoExclusion === '' ? null : String(datos.motivoExclusion ?? '').trim().toUpperCase();
  if (pedido !== null && !(EXCLUSIONES as readonly string[]).includes(pedido)) {
    throw badRequest('Elige SII (la empresa lleva los libros por el SII) o FORAL (domicilio fiscal en el País Vasco o Navarra), o quita la exclusión.', {
      campo: 'motivoExclusion',
    });
  }
  const motivo = typeof datos.motivo === 'string' ? datos.motivo.trim() : '';
  if (motivo.length > MOTIVO_MAX) throw badRequest(`El motivo admite como máximo ${MOTIVO_MAX} caracteres.`, { campo: 'motivo' });
  if (pedido && !motivo) {
    throw badRequest('Explica en una frase por qué la empresa queda fuera de VERI*FACTU (por ejemplo, quién lo ha confirmado).', { campo: 'motivo' });
  }

  return prisma.$transaction(async (tx) => {
    // Una consulta detras de otra: con una sola conexion, nada de Promise.all dentro de una transaccion (14-10-2026).
    const legal = await tx.legalConfig.findUnique({ where: { companyId }, select: { pais: true, monedaCuenta: true } });
    const ajustes = await tx.ajustesFiscales.findUnique({ where: { companyId }, select: { sii: true } });
    const config = await tx.verifactuConfig.findUnique({ where: { companyId }, select: { estado: true, motivoExclusion: true } });
    if (!perfilDesdeConfig(legal).espanola) {
      throw badRequest('VERI*FACTU solo se aplica a empresas españolas: esta empresa no necesita exclusión.');
    }
    const sii = ajustes?.sii === true;
    if (pedido === 'SII' && !sii) {
      throw badRequest('Para excluirla por el SII, antes marca en Impuestos > Ajustes fiscales que la empresa lleva los libros por el SII.', {
        campo: 'motivoExclusion',
      });
    }
    if (pedido && config?.estado === 'ACTIVO') {
      throw conflict('Esta empresa ya tiene VERI*FACTU activo y tiene que seguir con él hasta el 31 de diciembre: no se puede excluir ahora.', {
        campo: 'motivoExclusion',
      });
    }
    const antes = config?.motivoExclusion ?? null;
    await tx.verifactuConfig.upsert({
      where: { companyId },
      create: { companyId, motivoExclusion: pedido, updatedBy: userId },
      update: { motivoExclusion: pedido, updatedBy: userId },
    });
    await tx.auditLog.create({
      data: {
        userId,
        companyId,
        action: 'VERIFACTU_EXCLUSION_CAMBIADA',
        resourceType: 'VERIFACTU_CONFIG',
        resourceId: companyId,
        meta: { antes, despues: pedido, motivo: motivo || null, sii, instante: formatearHusoMadrid(ahora) } as Prisma.InputJsonValue,
      },
    });
    return { motivoExclusion: pedido as Exclusion | null, sii };
  });
}

/** Exclusion guardada y el SII de los ajustes fiscales. */
export async function leerExclusion(companyId: string): Promise<EstadoExclusion> {
  const [ajustes, config] = await Promise.all([
    prisma.ajustesFiscales.findUnique({ where: { companyId }, select: { sii: true } }),
    prisma.verifactuConfig.findUnique({ where: { companyId }, select: { motivoExclusion: true } }),
  ]);
  const anotada = String(config?.motivoExclusion ?? '').toUpperCase();
  return { motivoExclusion: (EXCLUSIONES as readonly string[]).includes(anotada) ? (anotada as Exclusion) : null, sii: ajustes?.sii === true };
}
