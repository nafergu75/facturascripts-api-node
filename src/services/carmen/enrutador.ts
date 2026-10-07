/**
 * Enrutador de Carmen. Cada paso corta en cuanto tiene respuesta; hasta la IA
 * el coste es 0 €.
 *
 *  0. Entrada: { message?, accion?, sessionId?, currentPage? }. Una acción (un
 *     botón) se ejecuta tal cual, sin clasificar.
 *  1. Normalizar el texto (normalizar.ts).
 *  2. Huecos: periodo, tercero, modelo, número de factura, importe...
 *  3. Charla por reglas y peticiones de acción («eso se hace en...»).
 *  4. Seguimiento de la intención anterior («¿y el mes pasado?»).
 *  5. Plazos de modelos (calendario) y clasificador de datos (capa 1).
 *  6. Guarda de datos propios: una pregunta sobre sus datos nunca va a la IA.
 *  7. Fichas verificadas (capa 2).
 *  8. IA (capa 3), solo si está encendida, activada en la empresa, con tope
 *     disponible y la pregunta es genérica. Si no, sugerencias parecidas.
 *
 * Los logs llevan la intención, el origen y la duración; nunca el texto.
 */
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { HttpError } from '../../utils/http-errors';
import { contarPalabras, plano } from '../../utils/texto';
import { tiene } from './contexto';
import { normalizar, type TextoNormalizado } from './normalizar';
import { extraerPeriodo, resolverCodigoPeriodo } from './huecos/periodo';
import { extraerImporteMinimo, extraerModelo, extraerNumeroFactura, extraerSentido } from './huecos/otros';
import { buscarTercero, indiceTerceros, trozosCandidatos, UMBRAL_USAR, type ResultadoTercero, type Tercero } from './terceros';
import { clasificar, decidir, textoParaClasificar, UMBRAL_DATOS, type Puntuacion } from './clasificador';
import { INTENCIONES, intencionPorId, type Intencion } from './intenciones/catalogo';
import { peticionDeAccion, tieneMarcadoresPropios, tipoDeCharla } from './charla';
import { buscarFichas, fichaPorId, respuestaFicha, MARGEN_FAQ, UMBRAL_FAQ, UMBRAL_FAQ_DUDA, type FichaPuntuada, FICHAS } from './faq/faq';
import { AVISO_FESTIVOS, FUENTE_CALENDARIO, esPreguntaDeCalendario, frasePlazo, modeloPorNombre, proximosPlazos } from './faq/calendario';
import { hrefValido } from './menus';
import { leerAjustes, topeEmpresaDia, type AjustesCarmen } from './ajustes.service';
import { contarMensaje, leerUso, motivoConfiguracion, motivoSinIA, TEXTO_MOTIVO, type MotivoSinIA } from './presupuesto.service';
import { preguntarIA, ETIQUETA_IA, type AuditoriaIA } from './llm';
import { depurarParaIA } from './depurar';
import { crearSesion, guardarTurno, obtenerSesion, purgarSiToca, turnosParaIA, type SesionCarmen } from './sesiones';
import type {
  Accion,
  AreaIntencion,
  Boton,
  CarmenCtx,
  ContextoSesion,
  CuerpoRespuesta,
  HuecosEntrada,
  HuecosResueltos,
  RespuestaCarmen,
} from './tipos';

export interface EntradaCarmen {
  message?: string;
  accion?: Accion;
  sessionId?: string;
  currentPage?: string;
}

/** Lo que decide el enrutador: la respuesta y, si cambia, el contexto del diálogo. */
export interface Resultado {
  cuerpo: CuerpoRespuesta;
  /** undefined: no se toca; null: se borra. */
  contexto?: ContextoSesion | null;
  auditoria?: AuditoriaIA;
}

const SEGUIMIENTO_MS = 30 * 60_000;
const PALABRAS_MIN_IA = 4;

const AREA_PERMISO: Record<AreaIntencion, string> = {
  cobros: 'Ventas o de Contabilidad',
  pagos: 'Compras o de Contabilidad',
  facturacion: 'Ventas o de Compras',
  contabilidad: 'Contabilidad',
  tesoreria: 'Tesorería',
  impuestos: 'Impuestos',
  resumen: 'consulta',
};

const TEXTO_SIN_RESPUESTA = 'No tengo una respuesta para eso. Para dudas que no estén en mis fichas, consúltalo con tu asesor.';

// ---------------- Utilidades ----------------

export function intencionPermitida(ctx: Pick<CarmenCtx, 'permisos' | 'puedeNominas'>, i: Intencion): boolean {
  if (i.requiereNominas && !ctx.puedeNominas) return false;
  return !i.permisos.length || tiene(ctx, ...i.permisos);
}

function botonIntencion(i: Intencion, huecos?: HuecosEntrada): Boton {
  return { texto: i.pregunta, accion: { tipo: 'intencion', id: i.id, ...(huecos && Object.keys(huecos).length ? { huecos } : {}) } };
}

const botonFicha = (f: FichaPuntuada['ficha']): Boton => ({ texto: f.pregunta, accion: { tipo: 'faq', id: f.id } });
const BOTON_CATALOGO: Boton = { texto: 'Ver todo lo que puedo consultar', accion: { tipo: 'catalogo' } };
const BOTON_IA: Boton = { texto: 'Ninguna: preguntar a la IA', accion: { tipo: 'ia' } };

/** Intenciones permitidas que se sugieren en una página (para chips y aclaraciones sin ranking). */
export function intencionesDePagina(ctx: Pick<CarmenCtx, 'permisos' | 'puedeNominas'>, pagina?: string): Intencion[] {
  const permitidas = INTENCIONES.filter((i) => intencionPermitida(ctx, i));
  const dePagina = pagina ? permitidas.filter((i) => (i.paginas ?? []).some((p) => pagina === p || pagina.startsWith(`${p}/`))) : [];
  const resto = permitidas.filter((i) => !dePagina.includes(i));
  return [...dePagina, ...resto];
}

/** Respuesta de aclaración: hasta 3 intenciones permitidas, 2 fichas y el catálogo. */
function aclaracion(
  ctx: CarmenCtx,
  texto: string,
  opciones: { ranking?: Puntuacion[]; fichas?: FichaPuntuada[]; huecos?: HuecosEntrada; avisos?: string[]; botonIA?: boolean; pagina?: string } = {},
): CuerpoRespuesta {
  const candidatas = (opciones.ranking ?? [])
    .filter((p) => p.puntuacion > 0.15 && intencionPermitida(ctx, p.intencion))
    .map((p) => p.intencion);
  const intenciones = (candidatas.length ? candidatas : intencionesDePagina(ctx, opciones.pagina)).slice(0, 3);
  const botones: Boton[] = [
    ...intenciones.map((i) => botonIntencion(i, opciones.huecos)),
    ...(opciones.fichas ?? []).slice(0, 2).map((f) => botonFicha(f.ficha)),
    BOTON_CATALOGO,
    ...(opciones.botonIA ? [BOTON_IA] : []),
  ];
  return { origen: 'aclaracion', texto, botones, ...(opciones.avisos?.length ? { avisos: opciones.avisos } : {}) };
}

function catalogo(ctx: CarmenCtx): CuerpoRespuesta {
  const permitidas = INTENCIONES.filter((i) => intencionPermitida(ctx, i));
  return {
    origen: 'sistema',
    texto:
      'Con tus permisos puedo consultar estos datos de tu empresa. También respondo dudas de uso de la app y de contabilidad con fichas revisadas. ' +
      'No hago cambios: no creo facturas, no contabilizo ni presento nada.',
    botones: permitidas.map((i) => botonIntencion(i)),
  };
}

// ---------------- Huecos ----------------

interface HuecosTexto {
  resueltos: HuecosResueltos;
  tercero: ResultadoTercero | null;
  senales: Set<string>;
  /** Texto para clasificar: sin el nombre del tercero (el clasificador quita el periodo para el kNN). */
  textoClasificar: string;
}

async function extraerHuecos(ctx: CarmenCtx, n: TextoNormalizado): Promise<HuecosTexto> {
  const senales = new Set<string>();
  const resueltos: HuecosResueltos = {};
  let texto = n.texto;
  let base = n.base;

  const periodo = extraerPeriodo(n.texto, ctx.hoy);
  if (periodo) {
    resueltos.periodo = periodo.periodo;
    senales.add('__periodo');
    // El nombre del tercero se busca sin el periodo («septiembre» no es un cliente).
    const pb = extraerPeriodo(base, ctx.hoy);
    if (pb) base = pb.resto;
  }
  const modelo = extraerModelo(texto);
  if (modelo) {
    resueltos.modelo = modelo;
    senales.add('__modelo');
  }
  const numero = extraerNumeroFactura(texto);
  if (numero) {
    resueltos.numeroFactura = numero;
    senales.add('__numeroFactura');
  }
  const sentido = extraerSentido(texto);
  if (sentido) resueltos.sentido = sentido;
  const importe = extraerImporteMinimo(texto);
  const dias = texto.match(/\bmas de (\d{1,3}) dias\b/);
  if (dias) resueltos.diasMinimos = Number(dias[1]);
  else if (importe) resueltos.importeMinimo = importe;
  const iban = texto.match(/\b(?:acabada|acaba|termina|terminada) en (\d{4})\b/);
  if (iban) {
    resueltos.ibanFinal = iban[1];
    senales.add('__banco');
  }

  const tercero = await buscarTercero(ctx.companyId, base);
  if (tercero && tercero.tipo !== 'ninguno') {
    senales.add('__tercero');
    const roles = tercero.tipo === 'unico' ? [tercero.tercero.rol] : tercero.candidatos.map((c) => c.tercero.rol);
    if (roles.includes('cliente')) senales.add('__cliente');
    if (roles.includes('proveedor')) senales.add('__proveedor');
    if (roles.includes('banco')) senales.add('__banco');
    if (tercero.tipo === 'unico') {
      resueltos.terceroId = tercero.tercero.id;
      resueltos.rol = tercero.tercero.rol;
    }
    // En los movimientos del banco el nombre de un cliente o proveedor se busca en el concepto («cargos de Repsol»).
    if (!roles.includes('banco')) resueltos.texto = tercero.trozo;
    texto = texto.replace(new RegExp(`(^| )${tercero.trozo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`), ' ');
  } else {
    // Sin tercero conocido, lo que no es del dominio sirve para buscar en los conceptos del banco.
    const trozo = trozosCandidatos(base)[0];
    if (trozo) resueltos.texto = trozo.join(' ');
  }

  return { resueltos, tercero, senales, textoClasificar: texto.replace(/\s+/g, ' ').trim() };
}

function huecosEntradaDe(h: HuecosResueltos): HuecosEntrada {
  const e: HuecosEntrada = {};
  if (h.periodo) e.periodo = h.periodo.codigo;
  if (h.sentido) e.sentido = h.sentido;
  if (h.modelo) e.modelo = h.modelo;
  if (h.terceroId) e.terceroId = h.terceroId;
  if (h.rol) e.rol = h.rol;
  if (h.importeMinimo) e.importeMinimo = h.importeMinimo;
  if (h.diasMinimos) e.diasMinimos = h.diasMinimos;
  if (h.ibanFinal) e.ibanFinal = h.ibanFinal;
  return e;
}

/** Huecos de un botón (ya estructurados) a valores resueltos; lo que no es válido se ignora. */
function resolverEntrada(e: HuecosEntrada | undefined, hoy: string): HuecosResueltos {
  const h: HuecosResueltos = {};
  if (!e) return h;
  if (e.periodo) {
    const p = resolverCodigoPeriodo(e.periodo, hoy);
    if (p) h.periodo = p;
  }
  if (e.sentido === 'cobros' || e.sentido === 'pagos') h.sentido = e.sentido;
  if (e.modelo) h.modelo = e.modelo;
  if (e.terceroId) h.terceroId = e.terceroId;
  if (e.rol) h.rol = e.rol;
  if (e.importeMinimo && e.importeMinimo > 0) h.importeMinimo = e.importeMinimo;
  if (e.diasMinimos && e.diasMinimos > 0) h.diasMinimos = e.diasMinimos;
  if (e.ibanFinal && /^\d{4}$/.test(e.ibanFinal)) h.ibanFinal = e.ibanFinal;
  return h;
}

// ---------------- Ejecución de intenciones ----------------

async function ejecutarIntencion(
  ctx: CarmenCtx,
  intencion: Intencion,
  huecos: HuecosResueltos,
  tercero: ResultadoTercero | null = null,
): Promise<Resultado> {
  if (!intencionPermitida(ctx, intencion)) {
    return {
      cuerpo: {
        origen: 'sistema',
        intencion: intencion.id,
        texto: `Ese dato necesita el permiso de ${AREA_PERMISO[intencion.area]} en esta empresa; pídeselo al administrador.`,
      },
      contexto: null,
    };
  }

  // Hueco de tercero obligatorio sin resolver: preguntar con botones.
  const defTercero = intencion.huecos.find((d) => d.nombre === 'tercero');
  if (defTercero?.roles && huecos.terceroId && huecos.rol && !defTercero.roles.includes(huecos.rol)) {
    delete huecos.terceroId;
    delete huecos.rol;
  }
  if (defTercero?.obligatorio && !huecos.terceroId && tercero?.tipo === 'dudas') {
    // Mismo nombre como cliente y como proveedor: decide el verbo (la intención); si solo
    // queda un candidato del papel que pide y se parece lo bastante, se usa.
    const delPapel = tercero.candidatos.filter((c) => !defTercero.roles?.length || defTercero.roles.includes(c.tercero.rol));
    if (delPapel.length === 1 && delPapel[0].puntuacion >= UMBRAL_USAR) {
      huecos.terceroId = delPapel[0].tercero.id;
      huecos.rol = delPapel[0].tercero.rol;
    }
  }
  if (defTercero?.obligatorio && !huecos.terceroId) {
    const roles = defTercero.roles ?? [];
    const nombreRol = roles.includes('proveedor') ? 'proveedor' : 'cliente';
    if (tercero?.tipo === 'dudas') {
      const candidatos = tercero.candidatos.filter((c) => !roles.length || roles.includes(c.tercero.rol));
      return {
        cuerpo: {
          origen: 'aclaracion',
          intencion: intencion.id,
          texto: candidatos.length > 1 ? `¿A qué ${nombreRol} te refieres?` : `¿Te refieres a ${candidatos[0]?.tercero.nombre ?? 'este ' + nombreRol}?`,
          botones: candidatos.map((c) => ({
            texto: c.tercero.nombre,
            accion: { tipo: 'tercero', terceroId: c.tercero.id, rol: c.tercero.rol, intencion: intencion.id },
          })),
        },
        contexto: { pendiente: intencion.id, huecos: huecosEntradaDe(huecos), en: new Date().toISOString() },
      };
    }
    const parecidos = tercero?.tipo === 'ninguno' ? tercero.parecidos.filter((c) => c.puntuacion >= 0.4 && (!roles.length || roles.includes(c.tercero.rol))) : [];
    return {
      cuerpo: {
        origen: 'aclaracion',
        intencion: intencion.id,
        texto:
          tercero?.tipo === 'ninguno'
            ? `No encuentro a «${tercero.trozo}» entre tus ${nombreRol}s.${parecidos.length ? ' ¿Es alguno de estos?' : ''}`
            : `¿De qué ${nombreRol}? Escribe su nombre o su NIF.`,
        botones: [
          ...parecidos.map((c) => ({
            texto: c.tercero.nombre,
            accion: { tipo: 'tercero' as const, terceroId: c.tercero.id, rol: c.tercero.rol, intencion: intencion.id },
          })),
          ...(intencion.id === 'INT-01' ? [botonIntencion(intencionPorId('INT-02')!)] : []),
        ],
      },
      contexto: { pendiente: intencion.id, huecos: huecosEntradaDe(huecos), en: new Date().toISOString() },
    };
  }

  // Periodo por defecto.
  const defPeriodo = intencion.huecos.find((d) => d.nombre === 'periodo');
  if (!huecos.periodo && defPeriodo?.porDefecto) {
    const p = resolverCodigoPeriodo(defPeriodo.porDefecto, ctx.hoy);
    if (p) huecos.periodo = p;
  }

  const r = await intencion.ejecutar(ctx, huecos);
  const entrada = huecosEntradaDe(huecos);
  if (r.sinPermiso) {
    return {
      cuerpo: { origen: 'sistema', intencion: intencion.id, texto: `Ese dato necesita el permiso de ${AREA_PERMISO[r.area]} en esta empresa; pídeselo al administrador.` },
      contexto: null,
    };
  }
  const avisos = [...(r.avisos ?? [])];
  if (tercero?.tipo === 'ninguno' && ['INT-02', 'INT-03', 'INT-06'].includes(intencion.id)) {
    avisos.push(`No encuentro a «${tercero.trozo}» entre tus clientes ni tus proveedores; te enseño el total.`);
  }
  const comunes = {
    intencion: intencion.id,
    entendido: r.entendido,
    texto: r.texto,
    ...(r.kpis ? { kpis: r.kpis } : {}),
    ...(r.tabla ? { tabla: r.tabla } : {}),
    ...(r.enlaces?.length ? { enlaces: r.enlaces.filter((e) => hrefValido(e.href)) } : {}),
    ...(r.descargas?.length ? { descargas: r.descargas } : {}),
    ...(r.botones?.length ? { botones: r.botones } : {}),
    ...(avisos.length ? { avisos } : {}),
    huecos: entrada,
  };
  const contexto: ContextoSesion = { intencion: intencion.id, huecos: entrada, en: new Date().toISOString() };
  if (r.sinCifras) {
    // Sin cifras de la empresa: plazos generales (con su fuente) o un enlace a la pantalla.
    const cuerpo: CuerpoRespuesta =
      intencion.id === 'INT-30' ? { ...comunes, origen: 'faq', fuente: FUENTE_CALENDARIO } : { ...comunes, origen: 'sistema' };
    return { cuerpo, contexto };
  }
  return {
    cuerpo: { ...comunes, origen: 'datos', permisoRequerido: r.permisoRequerido, calculadoEn: new Date().toISOString() },
    contexto,
  };
}

// ---------------- Plazos (calendario) ----------------

async function respuestaCalendario(ctx: CarmenCtx, modelo: string): Promise<CuerpoRespuesta | null> {
  const [plazo] = proximosPlazos(ctx.hoy, 1, modelo);
  if (!plazo) return null;
  const avisos = [AVISO_FESTIVOS];
  let estado = '';
  if (tiene(ctx, 'impuestos:read') && ['303', '111', '115', '349', '390', '347', '200'].includes(plazo.modelo)) {
    // Solo lectura: el estado que guarda la pantalla de Modelos Fiscales, si existe.
    const fila = await prisma.modeloImpuesto.findUnique({
      where: { companyId_codigo_ejercicio_periodo: { companyId: ctx.companyId, codigo: plazo.modelo, ejercicio: plazo.ejercicio, periodo: plazo.periodo } },
      select: { estado: true },
    });
    estado =
      fila?.estado === 'presentado'
        ? ' En la app lo tienes marcado como presentado.'
        : fila?.estado === 'omitido'
          ? ' En la app lo tienes marcado como omitido.'
          : ' En la app todavía no consta como presentado.';
  }
  return {
    origen: 'faq',
    texto: `${frasePlazo(plazo, ctx.hoy)}${plazo.nota ? ` ${plazo.nota}` : ''}${estado}`,
    fuente: FUENTE_CALENDARIO,
    avisos,
    ...(plazo.href && tiene(ctx, 'impuestos:read') ? { enlaces: [{ texto: `Ir al modelo ${plazo.modelo}`, href: plazo.href }] } : {}),
    ...(estado ? { calculadoEn: new Date().toISOString(), permisoRequerido: 'impuestos:read' } : {}),
  };
}

// ---------------- IA ----------------

interface DisponibilidadIA {
  motivo: MotivoSinIA | null;
  topeEmpresa: number;
}

async function disponibilidadIA(ctx: CarmenCtx, ajustes: AjustesCarmen): Promise<DisponibilidadIA> {
  const topeEmpresa = topeEmpresaDia(ajustes);
  // Apagada, sin clave o desactivada en la empresa: no hace falta mirar los contadores.
  const previo = motivoConfiguracion(ajustes.iaActiva);
  if (previo) return { motivo: previo, topeEmpresa };
  const uso = await leerUso(ctx.companyId, ctx.userId, ctx.hoy, topeEmpresa);
  return { motivo: motivoSinIA({ iaActivaEmpresa: ajustes.iaActiva }, uso), topeEmpresa };
}

async function responderConIA(
  ctx: CarmenCtx,
  mensaje: string,
  sesion: SesionCarmen | null,
  topeEmpresa: number,
  fichas: FichaPuntuada[],
): Promise<Resultado> {
  const terceros: Tercero[] = await indiceTerceros(ctx.companyId);
  const pregunta = depurarParaIA(mensaje, terceros);
  const turnos = sesion
    ? (await turnosParaIA(ctx, sesion.id)).map((t) => ({ pregunta: depurarParaIA(t.pregunta, terceros), respuesta: t.respuesta }))
    : [];
  const r = await preguntarIA({ companyId: ctx.companyId, userId: ctx.userId, hoy: ctx.hoy, topeEmpresa, pregunta, fichas: fichas.map((f) => f.ficha), turnos });
  const botonesFichas = fichas.slice(0, 3).map((f) => botonFicha(f.ficha));
  switch (r.tipo) {
    case 'ok':
      return { cuerpo: { origen: 'ia', texto: r.texto, etiquetaIA: ETIQUETA_IA, validacion: 'ok', ...(botonesFichas.length ? { botones: botonesFichas } : {}) }, auditoria: r.auditoria, contexto: null };
    case 'descartada':
      return {
        cuerpo: { ...aclaracion(ctx, 'No tengo una respuesta fiable para eso. Consúltalo con tu asesor.', { fichas }), validacion: 'descartada' },
        auditoria: r.auditoria,
      };
    case 'error':
      return { cuerpo: aclaracion(ctx, 'La IA no ha respondido ahora mismo. Inténtalo de nuevo en un rato o consúltalo con tu asesor.', { fichas }), auditoria: r.auditoria };
    case 'sin_tope':
      return { cuerpo: aclaracion(ctx, TEXTO_SIN_RESPUESTA, { fichas, avisos: [TEXTO_MOTIVO[r.motivo]] }), auditoria: r.auditoria };
  }
}

// ---------------- Seguimiento ----------------

const EMPIEZA_SEGUIMIENTO = /^(y|tambien|ahora|solo|solamente|entonces|y si|vale y|ok y)\b/;

async function intentarSeguimiento(ctx: CarmenCtx, n: TextoNormalizado, h: HuecosTexto, contexto: ContextoSesion | null): Promise<Resultado | null> {
  if (!contexto?.en || Date.now() - Date.parse(contexto.en) > SEGUIMIENTO_MS) return null;

  // Intención pendiente de un hueco (por ejemplo, de qué cliente): basta con el nombre.
  if (contexto.pendiente && h.tercero && h.tercero.tipo !== 'ninguno') {
    const pendiente = intencionPorId(contexto.pendiente);
    if (pendiente) return ejecutarIntencion(ctx, pendiente, { ...resolverEntrada(contexto.huecos, ctx.hoy), ...h.resueltos }, h.tercero);
  }

  if (!contexto.intencion || n.tokens.length > 6) return null;
  let id = contexto.intencion;
  const nuevos = { ...resolverEntrada(contexto.huecos, ctx.hoy) };
  let cambia = false;
  if (h.resueltos.periodo) {
    nuevos.periodo = h.resueltos.periodo;
    cambia = true;
  }
  if (h.resueltos.sentido && h.resueltos.sentido !== nuevos.sentido) {
    nuevos.sentido = h.resueltos.sentido;
    cambia = true;
  }
  if (h.tercero && h.tercero.tipo !== 'ninguno') {
    if (h.resueltos.terceroId) {
      nuevos.terceroId = h.resueltos.terceroId;
      nuevos.rol = h.resueltos.rol;
    } else {
      delete nuevos.terceroId;
      delete nuevos.rol;
    }
    if (id === 'INT-02' || id === 'INT-03') id = 'INT-01';
    cambia = true;
  }
  if (/\bvencid/.test(n.texto) && (id === 'INT-01' || id === 'INT-02')) {
    id = 'INT-03';
    cambia = true;
  }
  if (!cambia) return null;
  // Sin «y», «también»... solo cuenta si el mensaje no trae nada más que el hueco.
  const sobra = textoParaClasificar(h.textoClasificar, ctx.hoy).split(' ').filter((p) => p && !/^(el|la|los|las|de|del|a|al|en|que|y|solo|pasado|pasada)$/.test(p));
  if (!EMPIEZA_SEGUIMIENTO.test(n.texto) && sobra.length > 1) return null;
  const intencion = intencionPorId(id);
  return intencion ? ejecutarIntencion(ctx, intencion, nuevos, h.tercero) : null;
}

// ---------------- Acciones (botones) ----------------

async function responderAccion(ctx: CarmenCtx, entrada: EntradaCarmen, sesion: SesionCarmen | null, ajustes: AjustesCarmen): Promise<Resultado> {
  const accion = entrada.accion!;
  switch (accion.tipo) {
    case 'intencion': {
      const intencion = intencionPorId(accion.id);
      if (!intencion) return { cuerpo: aclaracion(ctx, 'No sé hacer esa consulta. Esto es lo que puedo mirar:', { pagina: entrada.currentPage }) };
      return ejecutarIntencion(ctx, intencion, resolverEntrada(accion.huecos, ctx.hoy));
    }
    case 'tercero': {
      const intencion = intencionPorId(accion.intencion ?? (accion.rol === 'proveedor' ? 'INT-06' : accion.rol === 'banco' ? 'INT-24' : 'INT-01'));
      if (!intencion) return { cuerpo: aclaracion(ctx, 'No sé hacer esa consulta. Esto es lo que puedo mirar:', { pagina: entrada.currentPage }) };
      // El tercero tiene que ser de esta empresa (el índice es por empresa).
      const existe = (await indiceTerceros(ctx.companyId)).some((t) => t.id === accion.terceroId && t.rol === accion.rol);
      if (!existe) return { cuerpo: aclaracion(ctx, 'No encuentro ese cliente o proveedor en esta empresa.', { pagina: entrada.currentPage }) };
      const previos = sesion?.contexto?.pendiente === intencion.id ? resolverEntrada(sesion.contexto.huecos, ctx.hoy) : {};
      return ejecutarIntencion(ctx, intencion, { ...previos, terceroId: accion.terceroId, rol: accion.rol });
    }
    case 'faq': {
      const ficha = fichaPorId(accion.id, ctx.hoy);
      if (!ficha) return { cuerpo: aclaracion(ctx, 'Esa ficha ya no está disponible.', { pagina: entrada.currentPage }) };
      return { cuerpo: respuestaFicha(ficha), contexto: null };
    }
    case 'catalogo':
      return { cuerpo: catalogo(ctx) };
    case 'ia': {
      if (!entrada.message) throw new HttpError(400, 'Para preguntar a la IA hace falta la pregunta (message).');
      const n = normalizar(entrada.message);
      const h = await extraerHuecos(ctx, n);
      const ranking = clasificar(h.textoClasificar, h.senales, entrada.currentPage, ctx.hoy);
      const fichas = buscarFichas(entrada.message, ctx.hoy, 3);
      // La guarda de datos propios vale también para el botón: una pregunta de datos nunca va a la IA.
      if ((ranking[0]?.puntuacion ?? 0) >= UMBRAL_DATOS || tieneMarcadoresPropios(n.texto) || h.senales.has('__tercero')) {
        return { cuerpo: aclaracion(ctx, 'Eso es una pregunta sobre tus datos, y a la IA no le paso datos de tu empresa. Prueba con una de estas consultas:', { ranking, fichas, pagina: entrada.currentPage }) };
      }
      const disp = await disponibilidadIA(ctx, ajustes);
      if (disp.motivo) return { cuerpo: aclaracion(ctx, TEXTO_SIN_RESPUESTA, { fichas, avisos: [TEXTO_MOTIVO[disp.motivo]], pagina: entrada.currentPage }) };
      return responderConIA(ctx, entrada.message, sesion, disp.topeEmpresa, fichas);
    }
  }
}

// ---------------- Mensajes de texto ----------------

export async function responder(ctx: CarmenCtx, entrada: EntradaCarmen, sesion: SesionCarmen | null, ajustes: AjustesCarmen): Promise<Resultado> {
  if (entrada.accion) return responderAccion(ctx, entrada, sesion, ajustes);
  const mensaje = entrada.message ?? '';
  const n = normalizar(mensaje);
  const pagina = entrada.currentPage;

  // 3. Charla y peticiones de acción.
  const charla = tipoDeCharla(n.texto);
  if (charla === 'saludo') {
    return { cuerpo: { ...aclaracion(ctx, 'Hola. Pregúntame por tus datos (cobros, bancos, asientos...) o por cómo se hace algo en la app.', { pagina }), origen: 'sistema' } };
  }
  if (charla === 'gracias') return { cuerpo: { origen: 'sistema', texto: 'De nada. Aquí estoy si necesitas algo más.' } };
  if (charla === 'ayuda') return { cuerpo: catalogo(ctx) };
  const peticion = peticionDeAccion(n.texto);
  if (peticion) {
    const d = peticion.destino;
    return {
      cuerpo: {
        origen: 'sistema',
        texto: `Eso no lo hago yo: solo consulto datos y resuelvo dudas, no cambio nada en la app.${d ? ` Puedes hacerlo en ${d.ruta}.` : ''}`,
        ...(d ? { enlaces: [{ texto: `Ir a ${d.ruta.split(' → ').pop()}`, href: d.href }] } : {}),
      },
    };
  }

  // 1-2. Huecos.
  const h = await extraerHuecos(ctx, n);

  // 4. Seguimiento.
  const seguimiento = await intentarSeguimiento(ctx, n, h, sesion?.contexto ?? null);
  if (seguimiento) return seguimiento;

  // 5a. Plazos de un modelo: se calculan con la tabla de plazos (sin IA).
  if (esPreguntaDeCalendario(n.texto) && !h.senales.has('__tercero') && !h.senales.has('__numeroFactura')) {
    const modelo = h.resueltos.modelo ?? modeloPorNombre(n.texto);
    if (modelo) {
      const cal = await respuestaCalendario(ctx, modelo);
      if (cal) return { cuerpo: cal, contexto: null };
    }
  }

  // 5b. Clasificador de datos.
  const ranking = clasificar(h.textoClasificar, h.senales, pagina, ctx.hoy);
  const decision = decidir(ranking);
  if (decision.tipo === 'ejecutar') return ejecutarIntencion(ctx, decision.mejor.intencion, h.resueltos, h.tercero);
  const fichas = buscarFichas(mensaje, ctx.hoy, 3);
  const [f1, f2] = fichas;
  const fichaClara = !!f1 && f1.puntuacion >= UMBRAL_FAQ && f1.puntuacion - (f2?.puntuacion ?? 0) >= MARGEN_FAQ;
  if (decision.tipo === 'dudas') {
    // Una ficha clara gana a una duda de datos (no hay IA en ninguno de los dos casos);
    // las consultas de datos parecidas van como botones.
    if (fichaClara) {
      const cuerpo = respuestaFicha(f1.ficha);
      const sugeridas = ranking.filter((p) => p.puntuacion >= UMBRAL_DATOS && intencionPermitida(ctx, p.intencion)).slice(0, 2);
      return { cuerpo: { ...cuerpo, ...(sugeridas.length ? { botones: sugeridas.map((p) => botonIntencion(p.intencion, huecosEntradaDe(h.resueltos))) } : {}) }, contexto: null };
    }
    return { cuerpo: aclaracion(ctx, '¿Qué quieres ver?', { ranking, fichas, huecos: huecosEntradaDe(h.resueltos), pagina }) };
  }

  // 6. Guarda de datos propios: estas preguntas nunca llegan a la IA.
  const propia = tieneMarcadoresPropios(n.texto) || h.senales.has('__tercero');

  // 7. Fichas.
  if (fichaClara) return { cuerpo: respuestaFicha(f1.ficha), contexto: null };
  if (propia) {
    return { cuerpo: aclaracion(ctx, 'No sé si te he entendido. ¿Es alguna de estas consultas?', { ranking, fichas, huecos: huecosEntradaDe(h.resueltos), pagina }) };
  }

  // 8. IA (o sugerencias si no está disponible).
  const disp = await disponibilidadIA(ctx, ajustes);
  if (f1 && f1.puntuacion >= UMBRAL_FAQ_DUDA) {
    return { cuerpo: aclaracion(ctx, '¿Es alguna de estas?', { fichas, ranking, botonIA: !disp.motivo, pagina }) };
  }
  if (!disp.motivo && contarPalabras(mensaje) >= PALABRAS_MIN_IA) return responderConIA(ctx, mensaje, sesion, disp.topeEmpresa, fichas);
  const avisos = disp.motivo && disp.motivo.startsWith('tope') ? [TEXTO_MOTIVO[disp.motivo]] : [];
  return { cuerpo: aclaracion(ctx, TEXTO_SIN_RESPUESTA, { ranking, fichas, avisos, pagina }) };
}

// ---------------- Petición completa ----------------

/** Título de la conversación: las primeras palabras de la primera pregunta. */
function tituloDe(entrada: EntradaCarmen): string {
  if (entrada.message) return entrada.message.replace(/\s+/g, ' ').trim().slice(0, 80);
  const a = entrada.accion;
  if (a?.tipo === 'intencion') return intencionPorId(a.id)?.titulo ?? 'Consulta';
  if (a?.tipo === 'faq') return FICHAS.find((f) => f.id === a.id)?.pregunta ?? 'Consulta';
  return 'Consulta';
}

/** Texto que se guarda como pregunta del usuario cuando llega un botón. */
function textoDePregunta(entrada: EntradaCarmen): string {
  if (entrada.message) return entrada.message;
  const a = entrada.accion!;
  if (a.tipo === 'intencion') return intencionPorId(a.id)?.pregunta ?? 'Consulta';
  if (a.tipo === 'faq') return FICHAS.find((f) => f.id === a.id)?.pregunta ?? 'Pregunta frecuente';
  if (a.tipo === 'tercero') return 'Elijo una opción';
  if (a.tipo === 'catalogo') return '¿Qué puedo preguntarte?';
  return 'Pregunta a la IA';
}

/** Quita lo que solo usa el servidor (permiso, huecos, validación). */
function publico(c: CuerpoRespuesta): Omit<RespuestaCarmen, 'sessionId' | 'mensajeId'> {
  const { permisoRequerido: _p, huecos: _h, validacion: _v, ...resto } = c;
  return resto;
}

/** Atiende un mensaje: sesión propia, freno diario, enrutado, guardado y auditoría. */
export async function atender(ctx: CarmenCtx, entrada: EntradaCarmen): Promise<RespuestaCarmen> {
  const inicio = Date.now();
  // La sesión se comprueba lo primero: una ajena da 404 sin leer ni guardar nada.
  const sesionPrevia = entrada.sessionId ? await obtenerSesion(ctx, entrada.sessionId) : null;
  if (!(await contarMensaje(ctx.userId, ctx.hoy))) {
    throw new HttpError(429, 'Has llegado al máximo de mensajes a Carmen por hoy. Mañana podrás seguir preguntando.');
  }
  const ajustes = await leerAjustes(ctx.companyId);
  await purgarSiToca(ctx.companyId, ajustes.conservarDias);

  const r = await responder(ctx, entrada, sesionPrevia, ajustes);
  const sesion = sesionPrevia ?? (await crearSesion(ctx, tituloDe(entrada)));
  const mensajeId = await guardarTurno(ctx, sesion.id, textoDePregunta(entrada), r.cuerpo, r.contexto);
  if (r.auditoria) {
    const a = r.auditoria;
    await prisma.carmenLlamadaIA.create({
      data: {
        companyId: a.companyId,
        userId: a.userId,
        mensajeId,
        modelo: a.modelo,
        tokensEntrada: a.tokensEntrada,
        tokensSalida: a.tokensSalida,
        tokensCacheEscritura: a.tokensCacheEscritura,
        tokensCacheLectura: a.tokensCacheLectura,
        reservaUsd: a.reservaUsd,
        costeUsd: a.costeUsd,
        estado: a.estado,
        motivo: a.motivo?.slice(0, 120) ?? null,
        duracionMs: a.duracionMs ?? null,
      },
    });
  }
  logger.info(`carmen: origen=${r.cuerpo.origen} intencion=${r.cuerpo.intencion ?? '-'} accion=${entrada.accion?.tipo ?? '-'} ms=${Date.now() - inicio}`);
  return { sessionId: sesion.id, mensajeId, ...publico(r.cuerpo) };
}

/** Chips y catálogo para la ventana de Carmen (GET /catalogo). */
export function catalogoParaPagina(ctx: CarmenCtx, pagina?: string) {
  const permitidas = INTENCIONES.filter((i) => intencionPermitida(ctx, i));
  const areas = new Map<AreaIntencion, Array<{ id: string; titulo: string; ejemplos: string[] }>>();
  for (const i of permitidas) {
    const lista = areas.get(i.area) ?? [];
    lista.push({ id: i.id, titulo: i.titulo, ejemplos: [i.pregunta, i.ejemplos[1] ?? i.ejemplos[0]] });
    areas.set(i.area, lista);
  }
  const chips = intencionesDePagina(ctx, pagina)
    .slice(0, 4)
    .map((i) => botonIntencion(i));
  const prefijo = pagina ? plano(pagina) : '';
  const fichasPagina = FICHAS.filter((f) => f.enlaceApp && prefijo && prefijo.startsWith(f.enlaceApp.href) && f.enlaceApp.href !== '/dashboard');
  const destacadas = (fichasPagina.length ? fichasPagina : FICHAS.filter((f) => f.bloque === 'app'))
    .filter((f) => fichaPorId(f.id, ctx.hoy))
    .slice(0, 3)
    .map((f) => ({ id: f.id, pregunta: f.pregunta }));
  return { areas: [...areas.entries()].map(([area, intenciones]) => ({ area, intenciones })), chips, fichas: destacadas };
}

/** Para tests. */
export const _internos = { extraerHuecos, ejecutarIntencion, aclaracion, resolverEntrada };
