/**
 * Importacion de una carga con UNA confirmacion (A1).
 *
 * Confirmar (`confirmarCarga`) vuelve a analizar la carga: si la huella no es
 * la del resumen que vio la persona, 409 y se revisa de nuevo. Si coincide, la
 * carga pasa a APLICANDO (solo una persona lo consigue si dos confirman a la
 * vez) y la pantalla llama en bucle a `aplicarFase`, que hace la siguiente
 * fase (o un trozo de ella) y la apunta en la carga en la misma transaccion.
 * Asi ninguna peticion es larga y un corte no pierde nada: la siguiente
 * llamada sigue donde se quedo, sin repetir lo hecho.
 *
 * Orden: ejercicios -> plan y subcuentas con clientes y proveedores -> diario
 * de 2026 (historico de solo lectura) -> apertura del 1-1-2027 -> cartera
 * pendiente -> inmovilizado -> bancos y datos fiscales -> comparativo de 2026
 * -> comprobacion final.
 */
import { Prisma } from '@prisma/client';
import { prisma, type TransaccionBD } from '../../config/database';
import { FILTRO_ASIENTOS_APERTURA } from '../../domain/asientosCierre';
import { badRequest, conflict } from '../../utils/http-errors';
import { importeTexto } from '../../utils/money';
import { registrarAuditoria } from '../auditoria.service';
import { asegurarPlanContableEmpresa } from '../chart-of-accounts.service';
import { grabarAsientos, OPCIONES_TX, rangoEjercicio, type AsientoNuevo } from '../puestaEnMarcha/asientosEnBloque';
import { confirmarPlanEnTx, type CreadoPorPlan, type PermisosAlta } from '../puestaEnMarcha/planAnterior';
import { asegurarEjercicio, guardarSaldosComparativo } from '../puestaEnMarcha/puestaEnMarcha.service';
import { conReintentoSubcuenta } from '../terceros/subcuentas';
import { CONCEPTO_APERTURA_ARRANQUE, type AnalisisCarga } from './analisis.service';
import { analizarCargaGuardada, cargaDeEmpresa, validarEjercicio, type CargaFila } from './cargas.service';
import { aplicarBancos, saldos572 } from './bancos.service';
import { claveActivo, clavePartida } from './definitiva';
import { comprobacionesArranque, type ComprobacionesArranque } from './seguimiento.service';
import { origenHistorico, saldosDesdeDiario } from './historico';

export const FASES = ['EJERCICIOS', 'PLAN_Y_TERCEROS', 'HISTORICO', 'APERTURA', 'CARTERA', 'INMOVILIZADO', 'BANCOS', 'COMPARATIVO', 'FINAL'] as const;
export type Fase = (typeof FASES)[number];

export const NOMBRE_FASE: Record<Fase, string> = {
  EJERCICIOS: 'Ejercicios 2026 y 2027',
  PLAN_Y_TERCEROS: 'Plan de cuentas, clientes y proveedores',
  HISTORICO: 'Contabilidad de 2026',
  APERTURA: 'Apertura del 1-1-2027',
  CARTERA: 'Facturas pendientes de cobro y pago',
  INMOVILIZADO: 'Inmovilizado',
  BANCOS: 'Bancos y datos fiscales',
  COMPARATIVO: 'Comparativo de 2026',
  FINAL: 'Comprobación final',
};

export interface EstadoFase {
  fase: Fase;
  estado: 'PENDIENTE' | 'HECHA' | 'OMITIDA';
  inicio?: string;
  fin?: string;
  /** Asientos del diario ya grabados (la fase del historico va por trozos). */
  cursor?: number;
  total?: number;
  resultado?: string;
}

/** Asientos del diario que se graban en cada llamada. */
export const TROZO_HISTORICO = 1000;
/** Clientes y proveedores que se enlazan o crean en cada llamada. */
export const TROZO_TERCEROS = 100;
/** Principio de la nota de las cuentas que se desactivan al deshacer una carga. */
export const NOTA_CUENTA_DESHECHA = 'Desactivada al deshacer la carga';

/** Quien confirma es administrador de la empresa: puede dar de alta clientes y proveedores. */
const TODOS: PermisosAlta = { cliente: true, proveedor: true };

const fasesDe = (c: CargaFila): EstadoFase[] => (Array.isArray(c.fases) ? (c.fases as unknown as EstadoFase[]) : []);
const objeto = (v: Prisma.JsonValue | null): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const json = (v: unknown) => v as Prisma.InputJsonValue;
/** Numero de un asiento «HIST-00042» (42), o null. */
export const numeroDe = (numero: string): number | null => {
  const n = Number(numero.slice(numero.lastIndexOf('-') + 1));
  return Number.isInteger(n) ? n : null;
};
const varios = (n: number, uno: string, muchos: string) => `${n.toLocaleString('es-ES')} ${n === 1 ? uno : muchos}`;

/** Sin la marca de una partida ni de una carga, y con el ejercicio abierto: 409. */
export interface Confirmacion {
  cargaId: string;
  version: number;
  fases: EstadoFase[];
}

/**
 * Confirma el borrador: comprueba que el analisis sigue dando la misma huella
 * y que no tiene errores, y lo pasa a APLICANDO.
 */
export async function confirmarCarga(companyId: string, ejercicioRaw: unknown, cargaId: string, huella: unknown, userId: string): Promise<Confirmacion> {
  const ejercicio = validarEjercicio(ejercicioRaw);
  const c = await cargaDeEmpresa(companyId, ejercicio, cargaId);
  if (c.estado !== 'BORRADOR') throw conflict(c.estado === 'APLICANDO' ? 'Esta carga ya se está importando.' : 'Esta carga ya no es un borrador.', { estado: c.estado });
  if (typeof huella !== 'string' || !huella) throw badRequest('Falta la huella del resumen que has revisado.');
  const a = await analizarCargaGuardada(c, TODOS);
  if (a.huella !== huella) {
    throw conflict('Algo ha cambiado desde el resumen (ficheros, clientes, proveedores o el plan): revísalo de nuevo antes de confirmar.', { codigo: 'HUELLA_CAMBIADA', huella: a.huella });
  }
  if (a.comprobaciones.nivel === 'ERRORES') {
    throw conflict(a.comprobaciones.mensaje, { codigo: 'CARGA_CON_ERRORES', puntos: a.comprobaciones.puntos.filter((p) => p.nivel === 'ERROR') });
  }
  const fases: EstadoFase[] = FASES.map((fase) => ({ fase, estado: 'PENDIENTE' }));
  const otra = await prisma.cargaArranque.findFirst({ where: { companyId, ejercicio, estado: 'APLICANDO' }, select: { id: true } });
  if (otra) throw conflict('Ya hay otra carga importándose en esta empresa.');
  const r = await prisma.cargaArranque.updateMany({
    where: { id: c.id, estado: 'BORRADOR', huella },
    data: {
      estado: 'APLICANDO',
      fases: json(fases),
      confirmadaPor: userId,
      resumen: json({ ...objeto(c.resumen), confirmacion: { huella, nivel: a.comprobaciones.nivel, comprobaciones: a.comprobaciones, en: new Date().toISOString() } }),
      creado: json({}),
      anterior: json({}),
    },
  });
  if (r.count !== 1) throw conflict('Otra persona ha confirmado o cambiado esta carga a la vez: vuelve a cargar la página.');
  // Dos cargas distintas confirmadas a la vez: solo sigue la primera.
  const aplicando = await prisma.cargaArranque.findMany({ where: { companyId, ejercicio, estado: 'APLICANDO' }, orderBy: { updatedAt: 'asc' }, select: { id: true } });
  if (aplicando.length > 1 && aplicando[0].id !== c.id) {
    await prisma.cargaArranque.update({ where: { id: c.id }, data: { estado: 'BORRADOR', fases: Prisma.DbNull, confirmadaPor: null } });
    throw conflict('Ya hay otra carga importándose en esta empresa.');
  }
  await registrarAuditoria({ userId, companyId, action: 'ARRANQUE_CONFIRMAR', resourceType: 'CargaArranque', resourceId: c.id, meta: { version: c.version, tipo: a.tipoCarga, huella, nivel: a.comprobaciones.nivel, modoApertura: a.repeticion.modo, ...(a.repeticion.modo === 'COMPLEMENTARIO' ? { motivoAjuste: a.ajustes.motivoAjuste ?? null, ajuste: a.repeticion.ajuste } : {}) } });
  return { cargaId: c.id, version: c.version, fases };
}

export interface ResultadoFase {
  fase: Fase;
  nombre: string;
  hecho: string;
  /** La siguiente fase pendiente; null si la carga ha terminado. */
  siguiente: Fase | null;
  terminada: boolean;
  progreso: { cursor: number; total: number } | null;
  fases: EstadoFase[];
  /** Al terminar: el mensaje de A4 con todo importado. */
  comprobaciones: ComprobacionesArranque | null;
}

interface ContextoFase {
  tx: TransaccionBD;
  c: CargaFila;
  a: AnalisisCarga;
  creado: Record<string, unknown>;
  anterior: Record<string, unknown>;
  estado: EstadoFase;
  userId: string;
}

/** Hace la siguiente fase pendiente (o un trozo del historico) de una carga confirmada. */
export async function aplicarFase(companyId: string, ejercicioRaw: unknown, cargaId: string, userId: string): Promise<ResultadoFase> {
  const ejercicio = validarEjercicio(ejercicioRaw);
  const c0 = await cargaDeEmpresa(companyId, ejercicio, cargaId);
  if (c0.estado !== 'APLICANDO') throw conflict(c0.estado === 'CONFIRMADA' ? 'Esta carga ya está importada.' : 'Confirma antes la carga.', { estado: c0.estado });
  const pendiente = fasesDe(c0).find((f) => f.estado === 'PENDIENTE');
  if (!pendiente) throw conflict('Esta carga no tiene nada pendiente.');
  const a = await analizarCargaGuardada(c0, TODOS);
  if (pendiente.fase === 'PLAN_Y_TERCEROS') await asegurarPlanContableEmpresa(companyId);

  const ejecutar = async (tx: TransaccionBD): Promise<{ hecho: string; fases: EstadoFase[] }> => {
    // Se vuelve a leer dentro de la transaccion: dos llamadas a la vez no hacen la misma fase.
    const c = await tx.cargaArranque.findUniqueOrThrow({ where: { id: c0.id } });
    const fases = fasesDe(c);
    const estado = fases.find((f) => f.estado === 'PENDIENTE');
    if (c.estado !== 'APLICANDO' || !estado || estado.fase !== pendiente.fase || (estado.cursor ?? 0) !== (pendiente.cursor ?? 0)) {
      throw conflict('Esta fase ya la está haciendo otra petición: vuelve a intentarlo en unos segundos.');
    }
    const ctx: ContextoFase = { tx, c, a, creado: objeto(c.creado), anterior: objeto(c.anterior), estado, userId };
    estado.inicio ??= new Date().toISOString();
    const hecho = await FUNCIONES[estado.fase](ctx);
    if (estado.estado === 'PENDIENTE' && (estado.total === undefined || (estado.cursor ?? 0) >= estado.total)) estado.estado = 'HECHA';
    if (estado.estado !== 'PENDIENTE') estado.fin = new Date().toISOString();
    estado.resultado = hecho;
    const final = estado.fase === 'FINAL' && estado.estado !== 'PENDIENTE';
    await tx.cargaArranque.update({
      where: { id: c.id },
      data: {
        fases: json(fases),
        creado: json(ctx.creado),
        anterior: json(ctx.anterior),
        ...(final ? { estado: 'CONFIRMADA', confirmadaEn: new Date() } : {}),
      },
    });
    return { hecho, fases };
  };
  const r = await conReintentoSubcuenta(() => prisma.$transaction(ejecutar, OPCIONES_TX));
  const { fases } = r;
  let { hecho } = r;
  const actual = fases.find((f) => f.fase === pendiente.fase)!;
  let comprobaciones: ComprobacionesArranque | null = null;
  if (actual.fase === 'FINAL' && actual.estado !== 'PENDIENTE') {
    // El mensaje final de A4 se calcula ya con todo importado (bancos, fichas, series, datos de la empresa).
    comprobaciones = await comprobacionesArranque(companyId, ejercicio);
    if (comprobaciones) {
      const c = await prisma.cargaArranque.findUniqueOrThrow({ where: { id: c0.id }, select: { resumen: true } });
      await prisma.cargaArranque.update({ where: { id: c0.id }, data: { resumen: json({ ...objeto(c.resumen), final: { nivel: comprobaciones.nivel, en: new Date().toISOString() } }) } });
      hecho =
        comprobaciones.nivel === 'CORRECTO'
          ? `La contabilidad de ${ejercicio - 1} está completa y cuadra. Ya puedes seguir con ${ejercicio}.`
          : `Contabilidad de ${ejercicio - 1} importada. Quedan datos por completar: los verás en el aviso del panel y en las comprobaciones.`;
      actual.resultado = hecho;
    }
  }
  await registrarAuditoria({
    userId,
    companyId,
    action: actual.fase === 'FINAL' ? 'ARRANQUE_CONFIRMADA' : 'ARRANQUE_FASE',
    resourceType: 'CargaArranque',
    resourceId: c0.id,
    meta: { version: c0.version, fase: actual.fase, estado: actual.estado, hecho, ...(actual.total !== undefined ? { cursor: actual.cursor, total: actual.total } : {}) },
  });
  const siguiente = fases.find((f) => f.estado === 'PENDIENTE')?.fase ?? null;
  return {
    fase: actual.fase,
    nombre: NOMBRE_FASE[actual.fase],
    hecho,
    siguiente,
    terminada: siguiente === null,
    progreso: actual.total !== undefined ? { cursor: actual.cursor ?? 0, total: actual.total } : null,
    fases,
    comprobaciones,
  };
}

// ---------------------------------------------------------------------------
// Fases
// ---------------------------------------------------------------------------

/** Lo creado por el plan en varias llamadas, junto. */
function juntarCreado(previo: CreadoPorPlan | undefined, nuevo: CreadoPorPlan): CreadoPorPlan {
  if (!previo) return nuevo;
  return {
    cuentas: [...previo.cuentas, ...nuevo.cuentas],
    clientes: [...previo.clientes, ...nuevo.clientes],
    proveedores: [...previo.proveedores, ...nuevo.proveedores],
    enlaces: [...previo.enlaces, ...nuevo.enlaces],
    nombresAnteriores: [...previo.nombresAnteriores, ...nuevo.nombresAnteriores],
    longitudAnterior: previo.longitudAnterior,
  };
}

const FUNCIONES: Record<Fase, (ctx: ContextoFase) => Promise<string>> = {
  EJERCICIOS: faseEjercicios,
  PLAN_Y_TERCEROS: fasePlan,
  HISTORICO: faseHistorico,
  APERTURA: faseApertura,
  CARTERA: faseCartera,
  INMOVILIZADO: faseInmovilizado,
  BANCOS: faseBancos,
  COMPARATIVO: faseComparativo,
  FINAL: faseFinal,
};

/** 0. Ejercicios: 2026 y 2027; con sumas y saldos o diario, 2026 pasa a llevado fuera (D1) y se retira lo apuntado en 2026 en la app. */
async function faseEjercicios({ tx, c, a, anterior, creado }: ContextoFase): Promise<string> {
  const anio = c.ejercicio - 1;
  const fyAnterior = await asegurarEjercicio(tx, c.companyId, anio);
  await asegurarEjercicio(tx, c.companyId, c.ejercicio);
  if (!a.marcaLlevanzaExterna) return `${anio} sigue en la app: la carga no trae su sumas y saldos ni su diario.`;
  anterior.llevanza = fyAnterior.llevanza;
  if (fyAnterior.llevanza !== 'EXTERNA') await tx.fiscalYear.update({ where: { id: fyAnterior.id }, data: { llevanza: 'EXTERNA' } });
  const retirar = await tx.journalEntry.findMany({
    where: { companyId: c.companyId, estado: 'POSTED', fecha: rangoEjercicio(anio), NOT: { origen: { startsWith: 'HISTORICO' } } },
    select: { id: true },
  });
  if (retirar.length) {
    await tx.journalEntry.updateMany({ where: { companyId: c.companyId, id: { in: retirar.map((r) => r.id) } }, data: { estado: 'SUSTITUIDO' } });
  }
  anterior.sustituidos = [...((anterior.sustituidos as string[] | undefined) ?? []), ...retirar.map((r) => r.id)];
  creado.llevanzaExterna = true;
  return `${anio} queda como llevado por la gestoría (solo lectura)${retirar.length ? `; se retiran ${varios(retirar.length, 'asiento', 'asientos')} de ${anio} hechos en la app` : ''}.`;
}

/** 1 y 2. Plan y subcuentas (A3) con clientes y proveedores enlazados, en la misma transaccion. */
async function fasePlan({ tx, c, a, creado, anterior, estado }: ContextoFase): Promise<string> {
  if (!a.cuentas.length) {
    return 'La carga no trae cuentas.';
  }
  // Para deshacer: las subcuentas que tenian las fichas antes de la carga (solo la primera vez).
  if (!anterior.fichas) {
    const [cs, ps] = await Promise.all([
      tx.customer.findMany({ where: { companyId: c.companyId, subcuenta430: { not: null } }, select: { id: true, subcuenta430: true } }),
      tx.supplier.findMany({ where: { companyId: c.companyId, OR: [{ subcuenta400: { not: null } }, { subcuenta410: { not: null } }] }, select: { id: true, subcuenta400: true, subcuenta410: true } }),
    ]);
    anterior.fichas = { clientes: cs.map((x) => [x.id, x.subcuenta430]), proveedores: ps.map((x) => [x.id, x.subcuenta400, x.subcuenta410]) };
    // Cuentas que la carga trae y se desactivaron al deshacer una carga anterior: vuelven a estar
    // activas. Las que la empresa desactivo a mano se quedan como estan.
    const codigos = a.cuentas.map((x) => x.codigo);
    const inactivas: string[] = [];
    for (let i = 0; i < codigos.length; i += 1000) {
      const filas = await tx.chartOfAccounts.findMany({
        where: { companyId: c.companyId, activo: false, notas: { startsWith: NOTA_CUENTA_DESHECHA }, codigo: { in: codigos.slice(i, i + 1000) } },
        select: { codigo: true },
      });
      inactivas.push(...filas.map((f) => f.codigo));
    }
    if (inactivas.length) {
      await tx.chartOfAccounts.updateMany({ where: { companyId: c.companyId, codigo: { in: inactivas } }, data: { activo: true, notas: `Arranque ${c.ejercicio}, carga ${c.id}` } });
    }
    anterior.reactivadas = inactivas;
  }
  // Por trozos: cada llamada enlaza o crea como mucho TROZO_TERCEROS fichas; las ya hechas salen como «ya enlazadas».
  const r = await confirmarPlanEnTx(
    tx,
    c.companyId,
    { cuentas: a.cuentas, terceros: a.listado, permisos: TODOS },
    { nombresGestoria: true, nota: `Arranque ${c.ejercicio}, carga ${c.id}`, limiteTerceros: TROZO_TERCEROS },
  );
  creado.plan = juntarCreado(creado.plan as CreadoPorPlan | undefined, r.creado);
  const hechas = (estado.cursor ?? 0) + r.creado.enlaces.length;
  estado.cursor = hechas;
  estado.total = hechas + r.quedan;
  if (r.quedan) return `${varios(hechas, 'cliente o proveedor', 'clientes y proveedores')} de ${(hechas + r.quedan).toLocaleString('es-ES')}.`;
  // Marca de plan anterior traido: el aviso del primer cliente o proveedor ya no salta.
  const reglas = await tx.reglasContables.findUnique({ where: { companyId: c.companyId }, select: { data: true } });
  const data = objeto((reglas?.data as Prisma.JsonValue) ?? null);
  anterior.planAnterior = data.planAnterior ?? null;
  const nueva = { ...data, planAnterior: { cargaId: c.id, fecha: new Date().toISOString() } };
  await tx.reglasContables.upsert({ where: { companyId: c.companyId }, update: { data: json(nueva) }, create: { companyId: c.companyId, data: json(nueva) } });
  const todo = creado.plan as CreadoPorPlan;
  const creadas = todo.clientes.length + todo.proveedores.length;
  const enlazadas = new Set(todo.enlaces.map((e) => e.fichaId)).size - creadas;
  const partes = [
    varios(todo.cuentas.length, 'cuenta nueva', 'cuentas nuevas'),
    todo.nombresAnteriores.length ? varios(todo.nombresAnteriores.length, 'nombre cambiado', 'nombres cambiados') : '',
    varios(creadas, 'ficha creada', 'fichas creadas'),
    varios(Math.max(0, enlazadas), 'ficha enlazada', 'fichas enlazadas'),
    r.pendientes ? varios(r.pendientes, 'subcuenta pendiente de enlazar', 'subcuentas pendientes de enlazar') : '',
  ].filter(Boolean);
  return `${partes.join(', ')}.`;
}

/** 3. Diario de 2026 como historico (A2), por trozos. */
async function faseHistorico({ tx, c, a, estado, anterior, creado }: ContextoFase): Promise<string> {
  if (!a.diario || a.excluidos.includes('DIARIO') || a.diario.descuadrados.length) {
    estado.estado = 'OMITIDA';
    return a.diario ? 'El diario no se importa: no cuadra (queda en «Faltan datos»).' : 'La carga no trae el diario.';
  }
  const asientos = a.diario.asientos;
  const desde = estado.cursor ?? 0;
  if (desde === 0) {
    // Repetir la carga: el historico de la version anterior se sustituye por el nuevo.
    const previos = await tx.journalEntry.findMany({
      where: { companyId: c.companyId, estado: 'POSTED', origen: { startsWith: 'HISTORICO' }, fecha: rangoEjercicio(c.ejercicio - 1) },
      select: { id: true, numeroAsiento: true },
    });
    if (previos.length) await tx.journalEntry.updateMany({ where: { id: { in: previos.map((p) => p.id) } }, data: { estado: 'REVERSED' } });
    // Para deshacer: el tramo de numeros del historico anterior (HIST-...), que vuelve si se deshace esta carga.
    const numeros = previos.map((p) => numeroDe(p.numeroAsiento)).filter((n): n is number => n !== null);
    anterior.historicoAnulado = numeros.length ? { n: previos.length, desde: Math.min(...numeros), hasta: Math.max(...numeros) } : null;
  }
  const nombres = new Map(a.cuentas.map((x) => [x.codigo, x.nombre]));
  const trozo: AsientoNuevo[] = asientos.slice(desde, desde + TROZO_HISTORICO).map((x) => ({
    fecha: x.fecha,
    concepto: x.concepto,
    origen: origenHistorico(x),
    lineas: x.lineas.map((l) => ({
      cuenta: l.cuenta,
      nombre: nombres.get(l.cuenta) || l.nombre,
      debe: l.debe,
      haber: l.haber,
      referencia: [x.numeroOriginal ? `As. ${x.numeroOriginal}` : '', l.concepto].filter(Boolean).join(' · ') || undefined,
    })),
  }));
  const grabados = await grabarAsientos(tx, c.companyId, trozo);
  estado.total = asientos.length;
  estado.cursor = desde + grabados.length;
  creado.historico = { asientos: estado.cursor, primero: (creado.historico as { primero?: string } | undefined)?.primero ?? grabados[0]?.numero ?? null, ultimo: grabados[grabados.length - 1]?.numero ?? null };
  return `${varios(estado.cursor, 'asiento', 'asientos')} de ${asientos.length.toLocaleString('es-ES')} grabados.`;
}

/** 4. Apertura del 1-1-2027: una linea por subcuenta. La que ya hubiera se anula. */
async function faseApertura({ tx, c, a, estado, anterior, creado }: ContextoFase): Promise<string> {
  if (!a.apertura) {
    estado.estado = 'OMITIDA';
    return 'La carga no trae saldos a 31-12: la apertura queda pendiente.';
  }
  if (a.repeticion.modo === 'COMPLEMENTARIO') {
    // Enero bloqueado: la apertura no se toca; solo las diferencias, en un asiento de ajuste.
    anterior.aperturas = [];
    if (!a.repeticion.ajuste.length) return 'La apertura no cambia: no hace falta ajuste.';
    const [ajuste] = await grabarAsientos(tx, c.companyId, [
      {
        fecha: a.apertura.fecha,
        concepto: `Ajuste de la apertura ${c.ejercicio} con el cierre definitivo de la gestoría`,
        origen: 'APERTURA_AJUSTE',
        lineas: a.repeticion.ajuste.map((l) => ({ ...l, referencia: (a.ajustes.motivoAjuste ?? '').slice(0, 180) || undefined })),
      },
    ]);
    creado.ajuste = ajuste;
    return `Asiento de ajuste ${ajuste.numero} con ${varios(a.repeticion.ajuste.length, 'línea', 'líneas')} (enero está bloqueado: la apertura no se toca).`;
  }
  const previas = await tx.journalEntry.findMany({
    where: { companyId: c.companyId, estado: 'POSTED', ...FILTRO_ASIENTOS_APERTURA, fecha: rangoEjercicio(c.ejercicio) },
    select: { id: true, numeroAsiento: true },
  });
  if (previas.length) await tx.journalEntry.updateMany({ where: { id: { in: previas.map((p) => p.id) } }, data: { estado: 'REVERSED' } });
  anterior.aperturas = previas.map((p) => p.id);
  const [asiento] = await grabarAsientos(tx, c.companyId, [
    {
      fecha: a.apertura.fecha,
      concepto: CONCEPTO_APERTURA_ARRANQUE,
      origen: 'APERTURA',
      lineas: a.apertura.lineas.map((l) => ({ cuenta: l.cuenta, nombre: l.nombre, debe: l.debe, haber: l.haber, referencia: `Saldos de la gestoría a 31-12-${c.ejercicio - 1}` })),
    },
  ]);
  creado.apertura = asiento;
  return `Asiento ${asiento.numero} con ${varios(a.apertura.lineas.length, 'línea', 'líneas')}${previas.length ? ` (sustituye a ${previas.map((p) => p.numeroAsiento).join(', ')})` : ''}.`;
}

/** 5. Cartera pendiente: partidas por subcuenta, sin asientos ni IVA (D3: «Saldo sin detalle» por la diferencia). */
async function faseCartera({ tx, c, a, estado, anterior, creado }: ContextoFase): Promise<string> {
  if (!a.cartera || !(a.cartera.partidas.length + a.cartera.sinDetalle.length)) {
    estado.estado = 'OMITIDA';
    return 'No hay facturas pendientes de cobro ni de pago.';
  }
  // Repetir la carga: las partidas de la version anterior se anulan, salvo las que ya tienen
  // cobros o pagos y la cartera nueva trae igual: esas siguen (pasan a esta carga).
  const vigente = await tx.cargaArranque.findFirst({ where: { companyId: c.companyId, ejercicio: c.ejercicio, estado: 'CONFIRMADA' }, select: { id: true } });
  const siguen = new Set(a.repeticion.partidasMantenidas.map((p) => p.clave));
  if (vigente) {
    const mantenidas = a.repeticion.partidasMantenidas.map((p) => p.id);
    const anular = await tx.partidaPendiente.findMany({ where: { companyId: c.companyId, cargaId: vigente.id, estado: { not: 'ANULADA' }, id: { notIn: mantenidas } }, select: { id: true } });
    if (anular.length) await tx.partidaPendiente.updateMany({ where: { id: { in: anular.map((p) => p.id) } }, data: { estado: 'ANULADA' } });
    if (mantenidas.length) await tx.partidaPendiente.updateMany({ where: { id: { in: mantenidas } }, data: { cargaId: c.id } });
    anterior.partidasAnuladas = anular.map((p) => p.id);
    anterior.partidasMovidas = { cargaId: vigente.id, ids: mantenidas };
  }
  const subcuentas = [...new Set([...a.cartera.partidas, ...a.cartera.sinDetalle].map((p) => p.subcuenta))];
  const [clientes, proveedores] = await Promise.all([
    tx.customer.findMany({ where: { companyId: c.companyId, subcuenta430: { in: subcuentas } }, select: { id: true, subcuenta430: true } }),
    tx.supplier.findMany({ where: { companyId: c.companyId, OR: [{ subcuenta400: { in: subcuentas } }, { subcuenta410: { in: subcuentas } }] }, select: { id: true, subcuenta400: true, subcuenta410: true } }),
  ]);
  const ficha = new Map<string, { customerId?: string; supplierId?: string }>();
  for (const x of clientes) if (x.subcuenta430) ficha.set(x.subcuenta430, { customerId: x.id });
  for (const x of proveedores) {
    if (x.subcuenta400) ficha.set(x.subcuenta400, { supplierId: x.id });
    if (x.subcuenta410) ficha.set(x.subcuenta410, { supplierId: x.id });
  }
  const filas = [...a.cartera.partidas, ...a.cartera.sinDetalle].filter((p) => !siguen.has(clavePartida(p))).map((p) => ({
    companyId: c.companyId,
    cargaId: c.id,
    tipo: p.tipo,
    subcuenta: p.subcuenta,
    ...ficha.get(p.subcuenta),
    ...(a.cartera!.facturas.get(`${p.tipo}|${p.documento}`) ?? {}),
    numeroDocumento: p.documento,
    fechaDocumento: p.fecha ?? null,
    fechaVencimiento: p.vencimiento ?? null,
    importeOriginal: p.importeOriginal ?? null,
    importePendiente: p.pendiente,
    moneda: p.moneda,
    sinDetalle: p.sinDetalle,
  }));
  for (let i = 0; i < filas.length; i += 1000) await tx.partidaPendiente.createMany({ data: filas.slice(i, i + 1000) });
  creado.partidas = filas.length;
  const cobros = filas.filter((f) => f.tipo === 'COBRO').length;
  const textoSiguen = siguen.size ? `; ${varios(siguen.size, 'factura con cobros o pagos sigue', 'facturas con cobros o pagos siguen')} como estaban` : '';
  return `${varios(cobros, 'factura pendiente de cobro', 'facturas pendientes de cobro')} y ${varios(filas.length - cobros, 'de pago', 'de pago')}${a.cartera.sinDetalle.length ? ` (${varios(a.cartera.sinDetalle.length, 'saldo sin detalle', 'saldos sin detalle')})` : ''}${textoSiguen}.`;
}

/** 6. Inmovilizado: fichas con la amortizacion acumulada a 31-12; la de 2027 empieza el 1-1-2027 (D2 si no cuadra). */
async function faseInmovilizado({ tx, c, a, estado, anterior, creado }: ContextoFase): Promise<string> {
  if (!a.inmovilizado || a.excluidos.includes('INMOVILIZADO') || !a.inmovilizado.activos.length) {
    estado.estado = 'OMITIDA';
    return a.inmovilizado ? 'Las fichas de inmovilizado no se importan: no cuadran con sus cuentas (queda en «Faltan datos»).' : 'La carga no trae inmovilizado.';
  }
  // Repetir la carga: las fichas de la version anterior se dan de baja, salvo las que ya tienen
  // amortizacion apuntada y el fichero nuevo trae igual: esas siguen (pasan a esta carga).
  const vigente = await tx.cargaArranque.findFirst({ where: { companyId: c.companyId, ejercicio: c.ejercicio, estado: 'CONFIRMADA' }, select: { id: true } });
  const siguen = new Set(a.repeticion.activosMantenidos.map((x) => x.clave));
  if (vigente) {
    const mantenidos = a.repeticion.activosMantenidos.map((x) => x.id);
    const previos = await tx.activoFijo.findMany({ where: { companyId: c.companyId, cargaId: vigente.id, activo: true, id: { notIn: mantenidos } }, select: { id: true } });
    if (previos.length) await tx.activoFijo.updateMany({ where: { id: { in: previos.map((p) => p.id) } }, data: { activo: false } });
    if (mantenidos.length) await tx.activoFijo.updateMany({ where: { id: { in: mantenidos } }, data: { cargaId: c.id } });
    anterior.activosRetirados = previos.map((p) => p.id);
    anterior.activosMovidos = { cargaId: vigente.id, ids: mantenidos };
  }
  const inicio = `${c.ejercicio}-01-01`;
  const fin = `${c.ejercicio - 1}-12-31`;
  const nuevos = a.inmovilizado.activos.filter((x) => !siguen.has(claveActivo({ descripcion: x.descripcion, cuentaBien: x.cuentaBien })));
  await tx.activoFijo.createMany({
    data: nuevos.map((x) => ({
      companyId: c.companyId,
      cargaId: c.id,
      descripcion: x.descripcion,
      subcuentaBien: x.cuentaBien,
      subcuentaAmortAcum: x.cuentaAmortAcum,
      subcuentaDotacion: x.cuentaDotacion,
      fechaAlta: x.fechaAlta ?? fin,
      fechaInicioAmortizacion: inicio,
      coste: x.coste,
      valorResidual: x.valorResidual,
      amortAcumuladaInicial: x.amortAcumulada,
      fechaAmortAcumulada: fin,
      coeficiente: x.coeficiente ?? 0,
    })),
  });
  creado.activos = nuevos.length;
  return `${varios(nuevos.length, 'bien', 'bienes')} de inmovilizado${siguen.size ? `; ${varios(siguen.size, 'bien con amortización apuntada sigue', 'bienes con amortización apuntada siguen')} como estaban` : ''}.`;
}

/** 7. Bancos y datos fiscales: saldo de los extractos a 31-12 (escrito en el resumen) y lo que se arrastra de 2026. */
async function faseBancos({ tx, c, a, estado, anterior, creado }: ContextoFase): Promise<string> {
  const bancos = a.ajustes.bancos ?? {};
  const fiscales = a.ajustes.datosFiscales ?? {};
  await tx.cargaArranque.update({ where: { id: c.id }, data: { resumen: json({ ...objeto(c.resumen), bancos, datosFiscales: fiscales }) } });
  const fiscalesTexto = fiscales.cuotasIvaACompensar ? `; ${importeTexto(fiscales.cuotasIvaACompensar)} de IVA a compensar en el 303 del 1T` : '';
  if (!a.apertura) {
    estado.estado = 'OMITIDA';
    return `Sin apertura no hay bancos que enlazar${fiscalesTexto}.`;
  }
  const r = await aplicarBancos(tx, c.companyId, c.ejercicio - 1, saldos572(a.apertura.lineas), bancos, anterior, creado);
  if (!r.tocadas) return `Ningún banco con el saldo del extracto todavía: escríbelo después en el resumen de la carga${fiscalesTexto}.`;
  return `${varios(r.tocadas, 'banco enlazado', 'bancos enlazados')} con el saldo del extracto a 31-12-${c.ejercicio - 1}${r.altas ? ` (${varios(r.altas, 'cuenta nueva', 'cuentas nuevas')} en Tesorería)` : ''}${fiscalesTexto}.`;
}

/** Tamano maximo del comparativo (PriorYearData.datosJSON es TEXT, 64 KB). */
const MAX_COMPARATIVO = 60_000;

/** Saldos sumados por cuenta de `digitos` digitos. */
function agruparCuentas(cuentas: Array<{ codigo: string; nombre: string; saldo: number }>, digitos: number) {
  const m = new Map<string, number>();
  for (const x of cuentas) {
    const k = x.codigo.slice(0, digitos);
    m.set(k, Math.round(((m.get(k) ?? 0) + x.saldo) * 100) / 100);
  }
  return [...m.entries()].filter(([, v]) => Math.round(v * 100) !== 0).map(([codigo, saldo]) => ({ codigo, nombre: '', saldo })).sort((a, b) => a.codigo.localeCompare(b.codigo));
}

/** 8. Comparativo de 2026 (columna N-1 de los informes de 2027) desde el sumas y saldos. */
async function faseComparativo({ tx, c, a, estado, anterior, creado }: ContextoFase): Promise<string> {
  const sys = a.datos.sumasSaldos;
  if (!sys || !a.saldos || a.saldos.analisis.tipo === 'CON_CIERRE') {
    estado.estado = 'OMITIDA';
    return 'Sin sumas y saldos no hay comparativo de 2026.';
  }
  let cuentas = sys.cuentas.filter((x) => Math.round(x.saldo * 100) !== 0);
  // Regularizado: los gastos e ingresos salen del diario antes de regularizar, si se ha importado;
  // si no, de las partidas de la PyG oficial (una cuenta de 3 digitos por partida).
  if (a.saldos.analisis.tipo === 'REGULARIZADO' && a.diario && !a.excluidos.includes('DIARIO')) {
    const pyg = saldosDesdeDiario(a.diario.asientos).filter((x) => /^[67]/.test(x.codigo) && Math.round(x.saldo * 100) !== 0);
    cuentas = [...cuentas.filter((x) => !/^[67]/.test(x.codigo)), ...pyg];
  } else if (a.saldos.analisis.tipo === 'REGULARIZADO' && a.pygComparativo) {
    cuentas = [...cuentas.filter((x) => !/^[67]/.test(x.codigo)), ...a.pygComparativo];
  }
  // El comparativo se guarda en un campo de texto de 64 KB: con miles de subcuentas se agrupa
  // por cuentas de 4 (o 3) digitos, que es lo que usan el balance y la PyG del año anterior.
  let nivel = 0;
  for (const digitos of [4, 3]) {
    if (JSON.stringify({ formato: 'saldos-v1', cuentas }).length <= MAX_COMPARATIVO) break;
    cuentas = agruparCuentas(cuentas, digitos);
    nivel = digitos;
  }
  const anio = c.ejercicio - 1;
  const previo = await tx.priorYearData.findFirst({ where: { companyId: c.companyId, ejercicio: anio } });
  // Para deshacer: la fila entera (sin id ni fechas).
  anterior.comparativo = previo
    ? {
        estado: previo.estado,
        baseImponible: Number(previo.baseImponible),
        ivaDevengado: Number(previo.ivaDevengado),
        ivaRepercutido: Number(previo.ivaRepercutido),
        irpfRetenido: Number(previo.irpfRetenido),
        gasto: Number(previo.gasto),
        ingresos: Number(previo.ingresos),
        beneficio: Number(previo.beneficio),
        datosJSON: previo.datosJSON,
        observaciones: previo.observaciones,
      }
    : null;
  // Se sustituye entero (no se mezcla con lo que hubiera).
  if (previo) await tx.priorYearData.delete({ where: { id: previo.id } });
  await guardarSaldosComparativo(c.companyId, anio, cuentas, 'todo', `Traído de la gestoría (carga ${c.version})`, tx);
  creado.comparativo = nivel ? { agrupadoA: nivel } : true;
  return `${varios(cuentas.length, 'cuenta', 'cuentas')} de ${anio} como comparativo de ${c.ejercicio}${nivel ? ` (agrupadas en cuentas de ${nivel} dígitos)` : ''}.`;
}

/** 9. Comprobacion final: la carga queda CONFIRMADA y la anterior SUSTITUIDA. */
async function faseFinal({ tx, c, creado }: ContextoFase): Promise<string> {
  const previa = await tx.cargaArranque.findFirst({ where: { companyId: c.companyId, ejercicio: c.ejercicio, estado: 'CONFIRMADA', NOT: { id: c.id } }, select: { id: true, version: true } });
  if (previa) await tx.cargaArranque.update({ where: { id: previa.id }, data: { estado: 'SUSTITUIDA' } });
  const resumen = objeto(c.resumen);
  const confirmacion = objeto((resumen.confirmacion as Prisma.JsonValue) ?? null);
  const nivel = String(confirmacion.nivel ?? 'FALTAN_DATOS');
  creado.sustituyeA = previa?.id ?? null;
  await tx.cargaArranque.update({ where: { id: c.id }, data: { resumen: json({ ...resumen, final: { nivel, en: new Date().toISOString() } }) } });
  return nivel === 'CORRECTO'
    ? `La contabilidad de ${c.ejercicio - 1} está completa y cuadra. Ya puedes seguir con ${c.ejercicio}.`
    : `Contabilidad de ${c.ejercicio - 1} importada. Quedan datos por completar: los verás en el aviso del panel.`;
}
