/**
 * Intenciones de datos (capa 1): calculan con los servicios de la app y
 * redactan con plantillas. SOLO LECTURA: aquí no se crea, actualiza ni borra
 * nada. Cada una comprueba sus permisos ANTES de llamar al servicio y, sin
 * permiso, devuelve { sinPermiso } sin ninguna cifra.
 */
import { prisma } from '../../../config/database';
import { facturasPorCobrar, type FacturaPorCobrar } from '../../cobrosClientes.service';
import { totalCobradoEntre } from '../../cobrosPagos.service';
import { obtenerResumen } from '../../treasury.service';
import { aCentimos } from '../../../utils/money';
import { plano } from '../../../utils/texto';
import type { ColumnaInforme } from '../../informesContables.documentos';
import { tiene } from '../contexto';
import { botonIntencion, eur, fechaES, plural, tabla } from '../plantillas';
import { hastaHoy, resolverCodigoPeriodo } from '../huecos/periodo';
import { indiceTerceros } from '../terceros';
import { AVISO_FESTIVOS, NOMBRES_MODELO, diasHasta, etiquetaPeriodo, proximosPlazos } from '../faq/calendario';
import type { AreaIntencion, CarmenCtx, HuecosResueltos, Kpi, RespuestaDatos } from '../tipos';

type Ejecutor = (ctx: CarmenCtx, h: HuecosResueltos) => Promise<RespuestaDatos>;

const sumar = (importes: number[]) => importes.reduce((s, x) => s + aCentimos(x), 0) / 100;

const COLS_FACTURAS: ColumnaInforme[] = [
  { titulo: 'Factura', tipo: 'codigo', ancho: 3 },
  { titulo: 'Cliente', tipo: 'texto', ancho: 6 },
  { titulo: 'Vence', tipo: 'fecha', ancho: 3 },
  { titulo: 'Retraso', tipo: 'texto', ancho: 2 },
  { titulo: 'Pendiente', tipo: 'importe', ancho: 3 },
];

const filaFactura = (f: FacturaPorCobrar) => ({
  celdas: [f.numeroCompleto ?? 'sin número', f.cliente, f.fechaVencimiento, f.diasRetraso > 0 ? plural(f.diasRetraso, 'día') : '', f.pendiente],
});

const CRITERIO_PENDIENTE = 'Cuenta el total de cada factura emitida menos los cobros registrados hasta hoy y sus rectificativas.';

// ---------------- INT-01: lo que me debe un cliente ----------------

export const deudaDeCliente: Ejecutor = async (ctx, h) => {
  if (!tiene(ctx, 'ventas:read', 'contabilidad:read')) return { sinPermiso: true, area: 'cobros' };
  const cliente = (await indiceTerceros(ctx.companyId)).find((t) => t.rol === 'cliente' && t.id === h.terceroId);
  if (!cliente) {
    return {
      entendido: 'Lo que te debe un cliente',
      texto: 'No encuentro ese cliente en esta empresa.',
      sinCifras: true,
      enlaces: [{ texto: 'Ver clientes', href: '/dashboard/clientes' }],
    };
  }
  const r = await facturasPorCobrar(ctx.companyId, ctx.hoy);
  const suyas = r.facturas.filter((f) => f.customerId === cliente.id);
  const entendido = `Pendiente de cobro de ${cliente.nombre} a ${fechaES(ctx.hoy)}`;
  const enlaces = [
    { texto: `Ficha de ${cliente.nombre}`, href: `/dashboard/clientes/${cliente.id}` },
    { texto: 'Ver facturas de ingreso', href: '/dashboard/facturas' },
  ];
  if (!suyas.length) {
    return {
      entendido,
      texto: `${cliente.nombre} no tiene facturas pendientes de cobro a ${fechaES(ctx.hoy)}. ${CRITERIO_PENDIENTE}`,
      permisoRequerido: 'ventas:read|contabilidad:read',
      enlaces,
    };
  }
  const total = sumar(suyas.map((f) => f.pendiente));
  const vencidas = suyas.filter((f) => f.vencida);
  const totalVencido = sumar(vencidas.map((f) => f.pendiente));
  const frase = vencidas.length
    ? `${vencidas.length === suyas.length ? 'Todas están vencidas' : `${plural(vencidas.length, 'está vencida', 'están vencidas')} (${eur(totalVencido)})`}.`
    : 'Ninguna ha vencido todavía.';
  return {
    entendido,
    texto: `${cliente.nombre} te debe ${eur(total)} en ${plural(suyas.length, 'factura')}. ${frase} ${CRITERIO_PENDIENTE}`,
    permisoRequerido: 'ventas:read|contabilidad:read',
    kpis: [
      { etiqueta: 'Pendiente de cobro', valor: eur(total), detalle: plural(suyas.length, 'factura') },
      { etiqueta: 'Vencido', valor: eur(totalVencido), detalle: plural(vencidas.length, 'factura') },
    ],
    tabla: tabla(`Facturas pendientes de ${cliente.nombre}`, `A ${fechaES(ctx.hoy)}`, COLS_FACTURAS, suyas.map(filaFactura)),
    enlaces,
    botones: [botonIntencion('Todo lo pendiente de cobro', 'INT-02'), botonIntencion('Solo las vencidas', 'INT-03')],
  };
};

// ---------------- INT-02: pendiente de cobro ----------------

export const pendienteDeCobro: Ejecutor = async (ctx) => {
  if (!tiene(ctx, 'ventas:read', 'contabilidad:read')) return { sinPermiso: true, area: 'cobros' };
  const r = await facturasPorCobrar(ctx.companyId, ctx.hoy);
  const entendido = `Pendiente de cobro de tus clientes a ${fechaES(ctx.hoy)}`;
  if (!r.facturas.length) {
    return {
      entendido,
      texto: `No tienes facturas pendientes de cobro a ${fechaES(ctx.hoy)}. ${CRITERIO_PENDIENTE}`,
      permisoRequerido: 'ventas:read|contabilidad:read',
      enlaces: [{ texto: 'Ver facturas de ingreso', href: '/dashboard/facturas' }],
    };
  }
  const clientes = new Set(r.facturas.map((f) => f.customerId ?? f.cliente)).size;
  return {
    entendido,
    texto:
      `Tienes ${eur(r.pendientes.importe)} pendientes de cobro en ${plural(r.pendientes.numero, 'factura')} de ${plural(clientes, 'cliente')}` +
      `${r.vencidas.numero ? `; ${eur(r.vencidas.importe)} ya han vencido` : ' y ninguna ha vencido'}. ${CRITERIO_PENDIENTE}`,
    permisoRequerido: 'ventas:read|contabilidad:read',
    kpis: [
      { etiqueta: 'Pendiente de cobro', valor: eur(r.pendientes.importe), detalle: plural(r.pendientes.numero, 'factura') },
      { etiqueta: 'Vencido', valor: eur(r.vencidas.importe), detalle: plural(r.vencidas.numero, 'factura') },
    ],
    tabla: tabla('Próximas facturas a cobrar', `A ${fechaES(ctx.hoy)}`, COLS_FACTURAS, r.facturas.slice(0, 10).map(filaFactura)),
    enlaces: [{ texto: 'Ver facturas de ingreso', href: '/dashboard/facturas' }],
    botones: [botonIntencion('Solo las vencidas', 'INT-03')],
  };
};

// ---------------- INT-03: vencidas y morosos ----------------

const TRAMOS: Array<[string, number, number]> = [
  ['De 1 a 30 días', 1, 30],
  ['De 31 a 60 días', 31, 60],
  ['De 61 a 90 días', 61, 90],
  ['Más de 90 días', 91, Number.POSITIVE_INFINITY],
];

export const facturasVencidas: Ejecutor = async (ctx, h) => {
  if (!tiene(ctx, 'ventas:read', 'contabilidad:read')) return { sinPermiso: true, area: 'cobros' };
  const r = await facturasPorCobrar(ctx.companyId, ctx.hoy);
  const minimo = Math.max(1, h.diasMinimos ? h.diasMinimos + 1 : 1);
  const vencidas = r.facturas.filter((f) => f.vencida && f.diasRetraso >= minimo).sort((a, b) => b.diasRetraso - a.diasRetraso);
  const filtro = h.diasMinimos ? ` con más de ${plural(h.diasMinimos, 'día')} de retraso` : '';
  const entendido = `Facturas vencidas sin cobrar${filtro} a ${fechaES(ctx.hoy)}`;
  if (!vencidas.length) {
    return {
      entendido,
      texto: `No tienes facturas vencidas sin cobrar${filtro} a ${fechaES(ctx.hoy)}. ${CRITERIO_PENDIENTE}`,
      permisoRequerido: 'ventas:read|contabilidad:read',
      enlaces: [{ texto: 'Ver facturas de ingreso', href: '/dashboard/facturas' }],
      botones: [botonIntencion('Todo lo pendiente de cobro', 'INT-02')],
    };
  }
  const total = sumar(vencidas.map((f) => f.pendiente));
  const kpis: Kpi[] = TRAMOS.map(([etiqueta, desde, hasta]) => {
    const enTramo = vencidas.filter((f) => f.diasRetraso >= desde && f.diasRetraso <= hasta);
    return { etiqueta, valor: eur(sumar(enTramo.map((f) => f.pendiente))), detalle: plural(enTramo.length, 'factura') };
  });
  return {
    entendido,
    texto: `Tienes ${plural(vencidas.length, 'factura vencida', 'facturas vencidas')} sin cobrar${filtro} por ${eur(total)}. Cuenta lo pendiente de cada factura cuyo vencimiento ya ha pasado, a ${fechaES(ctx.hoy)}.`,
    permisoRequerido: 'ventas:read|contabilidad:read',
    kpis: [{ etiqueta: 'Total vencido', valor: eur(total), detalle: plural(vencidas.length, 'factura') }, ...kpis],
    tabla: tabla('Facturas vencidas, de más a menos retraso', `A ${fechaES(ctx.hoy)}`, COLS_FACTURAS, vencidas.map(filaFactura)),
    enlaces: [{ texto: 'Ver facturas de ingreso', href: '/dashboard/facturas' }],
    botones: [botonIntencion('Todo lo pendiente de cobro', 'INT-02')],
  };
};

// ---------------- INT-05: cobrado o pagado en un periodo ----------------

export const cobradoEnPeriodo: Ejecutor = async (ctx, h) => {
  const sentido = h.sentido ?? 'cobros';
  const permitido = sentido === 'cobros' ? tiene(ctx, 'ventas:read', 'contabilidad:read') : tiene(ctx, 'compras:read', 'contabilidad:read');
  if (!permitido) return { sinPermiso: true, area: sentido === 'cobros' ? 'cobros' : 'pagos' };
  const periodo = h.periodo ?? resolverCodigoPeriodo('este-mes', ctx.hoy)!;
  const verbo = sentido === 'cobros' ? 'cobrado' : 'pagado';
  const nombre = sentido === 'cobros' ? 'cobro' : 'pago';
  const entendido = `Total ${verbo} en ${periodo.etiqueta}`;
  const otro = botonIntencion(sentido === 'cobros' ? 'Ver los pagos' : 'Ver los cobros', 'INT-05', { periodo: periodo.codigo, sentido: sentido === 'cobros' ? 'pagos' : 'cobros' });
  if (periodo.desde > ctx.hoy) {
    return { entendido, texto: `Ese periodo (${periodo.etiqueta}) todavía no ha empezado.`, sinCifras: true, botones: [otro] };
  }
  const hasta = hastaHoy(periodo, ctx.hoy);
  const tipo = sentido === 'cobros' ? 'INGRESO' : 'GASTO';
  const [total, numero] = await Promise.all([
    totalCobradoEntre(ctx.companyId, tipo, periodo.desde, hasta),
    prisma.invoicePayment.count({ where: { companyId: ctx.companyId, invoiceType: tipo, estado: 'ACTIVO', fecha: { gte: periodo.desde, lte: hasta } } }),
  ]);
  const recorte = hasta < periodo.hasta ? ' (hasta hoy)' : '';
  const anterior =
    periodo.codigo === 'este-mes' ? botonIntencion('¿Y el mes pasado?', 'INT-05', { periodo: 'mes-pasado', sentido })
    : periodo.codigo === 'este-trimestre' ? botonIntencion('¿Y el trimestre pasado?', 'INT-05', { periodo: 'trimestre-pasado', sentido })
    : periodo.codigo === 'este-anio' ? botonIntencion('¿Y el año pasado?', 'INT-05', { periodo: 'anio-pasado', sentido })
    : botonIntencion('¿Y este mes?', 'INT-05', { periodo: 'este-mes', sentido });
  return {
    entendido,
    texto:
      `En ${periodo.etiqueta}${recorte} has ${verbo} ${eur(total)} en ${plural(numero, `${nombre} registrado`, `${nombre}s registrados`)}. ` +
      `Suma los ${nombre}s con fecha en ese periodo; las facturas marcadas como ${verbo}s a mano, sin ${nombre} registrado, no cuentan porque no tienen fecha.`,
    permisoRequerido: sentido === 'cobros' ? 'ventas:read|contabilidad:read' : 'compras:read|contabilidad:read',
    kpis: [{ etiqueta: `Total ${verbo}`, valor: eur(total), detalle: plural(numero, nombre) }],
    enlaces: [sentido === 'cobros' ? { texto: 'Ver facturas de ingreso', href: '/dashboard/facturas' } : { texto: 'Ver compras', href: '/dashboard/compras' }],
    botones: [anterior, otro],
  };
};

// ---------------- INT-23: asientos pendientes ----------------

const ESTADOS_ASIENTO: Record<string, string> = { DRAFT: 'Borrador', PENDING_REVIEW: 'Pendiente de revisión' };

export const asientosPendientes: Ejecutor = async (ctx) => {
  if (!tiene(ctx, 'contabilidad:read')) return { sinPermiso: true, area: 'contabilidad' };
  const where = { companyId: ctx.companyId };
  const [borradores, pendientes, antiguos] = await Promise.all([
    prisma.journalEntry.count({ where: { ...where, estado: 'DRAFT' } }),
    prisma.journalEntry.count({ where: { ...where, estado: 'PENDING_REVIEW' } }),
    prisma.journalEntry.findMany({
      where: { ...where, estado: { in: ['DRAFT', 'PENDING_REVIEW'] } },
      orderBy: [{ fecha: 'asc' }, { createdAt: 'asc' }],
      take: 10,
      select: { fecha: true, numeroAsiento: true, descripcion: true, estado: true },
    }),
  ]);
  const total = borradores + pendientes;
  const entendido = `Asientos sin aprobar a ${fechaES(ctx.hoy)}`;
  const enlaces = [{ texto: 'Ir a Motor contable', href: '/dashboard/motor-contable' }];
  if (!total) {
    return { entendido, texto: 'No tienes asientos sin aprobar: todo lo contabilizado ya cuenta en los informes.', permisoRequerido: 'contabilidad:read', enlaces };
  }
  return {
    entendido,
    texto:
      `Tienes ${plural(total, 'asiento sin aprobar', 'asientos sin aprobar')}: ${plural(borradores, 'borrador', 'borradores')} y ${plural(pendientes, 'pendiente', 'pendientes')} de revisión. ` +
      'No salen en el balance ni en la cuenta de resultados hasta que los apruebes.',
    permisoRequerido: 'contabilidad:read',
    kpis: [
      { etiqueta: 'Borradores', valor: borradores.toLocaleString('es-ES') },
      { etiqueta: 'Pendientes de revisión', valor: pendientes.toLocaleString('es-ES') },
    ],
    tabla: tabla(
      'Los más antiguos',
      `A ${fechaES(ctx.hoy)}`,
      [
        { titulo: 'Fecha', tipo: 'fecha', ancho: 3 },
        { titulo: 'Asiento', tipo: 'codigo', ancho: 3 },
        { titulo: 'Descripción', tipo: 'texto', ancho: 8 },
        { titulo: 'Estado', tipo: 'texto', ancho: 4 },
      ],
      antiguos.map((a) => ({ celdas: [a.fecha.toISOString().slice(0, 10), a.numeroAsiento, a.descripcion, ESTADOS_ASIENTO[a.estado] ?? a.estado] })),
    ),
    enlaces,
  };
};

// ---------------- INT-24: saldo de bancos ----------------

export const saldoBancos: Ejecutor = async (ctx, h) => {
  if (!tiene(ctx, 'tesoreria:read')) return { sinPermiso: true, area: 'tesoreria' };
  const [resumen, ultimo] = await Promise.all([
    obtenerResumen(ctx.companyId),
    prisma.bankMovement.aggregate({ where: { companyId: ctx.companyId }, _max: { fecha: true } }),
  ]);
  let cuentas = resumen.cuentas;
  let filtro = '';
  if (h.rol === 'banco' && h.terceroId) {
    cuentas = cuentas.filter((c) => c.id === h.terceroId);
    filtro = cuentas[0] ? ` de ${cuentas[0].nombre ?? 'la cuenta'}` : '';
  } else if (h.ibanFinal) {
    cuentas = cuentas.filter((c) => c.iban.replace(/\s/g, '').endsWith(h.ibanFinal!));
    filtro = ` de la cuenta acabada en ${h.ibanFinal}`;
  }
  const entendido = `Saldo de tus cuentas bancarias${filtro}`;
  const enlaces = [{ texto: 'Ver cuentas bancarias', href: '/dashboard/tesoreria/cuentas' }];
  if (!cuentas.length) {
    return {
      entendido,
      texto: resumen.cuentas.length ? 'No encuentro esa cuenta entre las cuentas bancarias activas de la empresa.' : 'No tienes cuentas bancarias dadas de alta.',
      permisoRequerido: 'tesoreria:read',
      sinCifras: true,
      enlaces,
    };
  }
  const total = sumar(cuentas.map((c) => c.saldoActual));
  const fechaUltimo = ultimo._max.fecha;
  const criterio = fechaUltimo
    ? `según los extractos importados hasta el ${fechaES(fechaUltimo)}`
    : 'según el saldo inicial de cada cuenta (todavía no hay extractos importados)';
  const nombreCuenta = (c: (typeof cuentas)[number]) => `${c.nombre ?? 'Cuenta'} …${c.iban.replace(/\s/g, '').slice(-4)}`;
  return {
    entendido,
    texto:
      cuentas.length === 1
        ? `El saldo de ${nombreCuenta(cuentas[0])} es ${eur(total)}, ${criterio}.`
        : `El saldo de tus ${cuentas.length} cuentas es ${eur(total)}, ${criterio}.`,
    permisoRequerido: 'tesoreria:read',
    kpis: [{ etiqueta: 'Saldo total', valor: eur(total), detalle: plural(cuentas.length, 'cuenta') }],
    tabla: tabla(
      'Saldo por cuenta',
      fechaUltimo ? `Extractos hasta el ${fechaES(fechaUltimo)}` : 'Sin extractos',
      [
        { titulo: 'Cuenta', tipo: 'texto', ancho: 8 },
        { titulo: 'Saldo', tipo: 'importe', ancho: 4 },
      ],
      cuentas.map((c) => ({ celdas: [nombreCuenta(c), c.saldoActual] })),
    ),
    enlaces,
    botones: [botonIntencion('Últimos movimientos', 'INT-25')],
  };
};

// ---------------- INT-25: últimos movimientos del banco ----------------

export const ultimosMovimientos: Ejecutor = async (ctx, h) => {
  if (!tiene(ctx, 'tesoreria:read')) return { sinPermiso: true, area: 'tesoreria' };
  const where: Record<string, unknown> = { companyId: ctx.companyId, ignorado: false };
  if (h.periodo) where.fecha = { gte: h.periodo.desde, lte: h.periodo.hasta };
  if (h.sentido === 'cobros') where.importe = { gte: 0 };
  if (h.sentido === 'pagos') where.importe = { lt: 0 };
  if (h.rol === 'banco' && h.terceroId) where.cuentaBancariaId = h.terceroId;
  const filas = await prisma.bankMovement.findMany({
    where,
    orderBy: [{ fecha: 'desc' }, { createdAt: 'desc' }],
    take: 500,
    select: { fecha: true, importe: true, concepto: true, cuentaBancaria: { select: { bancoNombre: true, iban: true } } },
  });
  const buscar = h.texto ? plano(h.texto) : '';
  const lista = filas
    .map((m) => ({ ...m, importe: Number(m.importe) }))
    .filter((m) => (!buscar || plano(m.concepto).includes(buscar)) && (!h.importeMinimo || Math.abs(m.importe) >= h.importeMinimo));
  const partes = [
    h.sentido === 'cobros' ? 'entradas' : h.sentido === 'pagos' ? 'salidas' : 'movimientos',
    h.texto ? `con «${h.texto}» en el concepto` : '',
    h.importeMinimo ? `de más de ${eur(h.importeMinimo)}` : '',
    h.periodo ? `en ${h.periodo.etiqueta}` : '',
  ].filter(Boolean);
  const entendido = `Últimos ${partes.join(' ')} del banco`;
  const enlaces = [{ texto: 'Ver cobros y pagos del banco', href: '/dashboard/tesoreria/movimientos' }];
  if (!lista.length) {
    return { entendido, texto: `No encuentro ${partes.join(' ')} en los extractos importados.`, permisoRequerido: 'tesoreria:read', enlaces };
  }
  const entradas = sumar(lista.filter((m) => m.importe > 0).map((m) => m.importe));
  const salidas = sumar(lista.filter((m) => m.importe < 0).map((m) => -m.importe));
  const limitado = filas.length === 500 ? ' (entre los 500 más recientes)' : '';
  return {
    entendido,
    texto: `Encuentro ${plural(lista.length, 'movimiento')}${limitado}: ${eur(entradas)} de entradas y ${eur(salidas)} de salidas. Salen de los extractos importados, sin los movimientos marcados como ignorados.`,
    permisoRequerido: 'tesoreria:read',
    kpis: [
      { etiqueta: 'Entradas', valor: eur(entradas) },
      { etiqueta: 'Salidas', valor: eur(salidas) },
    ],
    tabla: tabla(
      'Movimientos, del más reciente al más antiguo',
      h.periodo ? h.periodo.etiqueta : 'Extractos importados',
      [
        { titulo: 'Fecha', tipo: 'fecha', ancho: 3 },
        { titulo: 'Concepto', tipo: 'texto', ancho: 9 },
        { titulo: 'Cuenta', tipo: 'texto', ancho: 4 },
        { titulo: 'Importe', tipo: 'importe', ancho: 3 },
      ],
      lista.map((m) => ({
        celdas: [m.fecha, m.concepto, `${m.cuentaBancaria.bancoNombre ?? 'Cuenta'} …${m.cuentaBancaria.iban.replace(/\s/g, '').slice(-4)}`, m.importe],
      })),
    ),
    enlaces,
  };
};

// ---------------- INT-30: próximos impuestos ----------------

export const proximosImpuestos: Ejecutor = async (ctx) => {
  const plazos = proximosPlazos(ctx.hoy, 6);
  const primero = plazos[0];
  const dias = primero ? diasHasta(ctx.hoy, primero.fecha) : 0;
  return {
    entendido: `Próximos plazos de presentación desde el ${fechaES(ctx.hoy)}`,
    texto:
      (primero
        ? `El próximo plazo es el ${fechaES(primero.fecha)}${dias === 0 ? ' (hoy)' : ` (dentro de ${plural(dias, 'día')})`}: modelo ${primero.modelo}, ${NOMBRES_MODELO[primero.modelo]}. `
        : '') +
      'Son los plazos generales de una empresa con ejercicio natural; no miran qué modelos te tocan ni si ya los has presentado.',
    sinCifras: true,
    tabla: tabla(
      'Próximos plazos generales',
      `Desde el ${fechaES(ctx.hoy)}`,
      [
        { titulo: 'Modelo', tipo: 'codigo', ancho: 2 },
        { titulo: 'Qué es', tipo: 'texto', ancho: 8 },
        { titulo: 'Periodo', tipo: 'texto', ancho: 4 },
        { titulo: 'Hasta el', tipo: 'fecha', ancho: 3 },
      ],
      plazos.map((p) => ({ celdas: [p.modelo, p.nombre, etiquetaPeriodo(p).replace(/^el /, ''), p.fecha] })),
    ),
    avisos: [AVISO_FESTIVOS],
    enlaces: tiene(ctx, 'impuestos:read') ? [{ texto: 'Ver el estado de tus modelos', href: '/dashboard/fiscal/estado' }] : [],
  };
};

// ---------------- INT-39: resumen de la empresa ----------------

export const resumenEmpresa: Ejecutor = async (ctx) => {
  const kpis: Kpi[] = [];
  const frases: string[] = [];
  const tareas: Array<Promise<void>> = [];
  // Permisos de los bloques que salen: si el usuario pierde alguno, el historial oculta la respuesta.
  const permisos: string[] = [];
  if (tiene(ctx, 'ventas:read', 'contabilidad:read')) {
    permisos.push('ventas:read|contabilidad:read');
    tareas.push(
      facturasPorCobrar(ctx.companyId, ctx.hoy).then((r) => {
        kpis.push({ etiqueta: 'Pendiente de cobro', valor: eur(r.pendientes.importe), detalle: plural(r.pendientes.numero, 'factura') });
        kpis.push({ etiqueta: 'Vencido sin cobrar', valor: eur(r.vencidas.importe), detalle: plural(r.vencidas.numero, 'factura') });
        frases.push(`Tienes ${eur(r.pendientes.importe)} pendientes de cobro, ${eur(r.vencidas.importe)} ya vencidos.`);
      }),
    );
  }
  if (tiene(ctx, 'tesoreria:read')) {
    permisos.push('tesoreria:read');
    tareas.push(
      obtenerResumen(ctx.companyId).then((r) => {
        kpis.push({ etiqueta: 'Saldo en bancos', valor: eur(r.saldoTotal), detalle: plural(r.cuentasActivas, 'cuenta') });
        frases.push(`En bancos hay ${eur(r.saldoTotal)} según los extractos importados.`);
      }),
    );
  }
  if (tiene(ctx, 'contabilidad:read')) {
    permisos.push('contabilidad:read');
    tareas.push(
      prisma.journalEntry.count({ where: { companyId: ctx.companyId, estado: { in: ['DRAFT', 'PENDING_REVIEW'] } } }).then((n) => {
        kpis.push({ etiqueta: 'Asientos sin aprobar', valor: n.toLocaleString('es-ES') });
        if (n) frases.push(`Hay ${plural(n, 'asiento sin aprobar', 'asientos sin aprobar')}.`);
      }),
    );
  }
  await Promise.all(tareas);
  const plazo = proximosPlazos(ctx.hoy, 1)[0];
  if (plazo) frases.push(`El próximo plazo fiscal general es el ${fechaES(plazo.fecha)} (modelo ${plazo.modelo}).`);
  if (!kpis.length) {
    return {
      entendido: `Resumen de la empresa a ${fechaES(ctx.hoy)}`,
      texto: `${frases.join(' ')} Con tus permisos no puedo enseñarte cifras de cobros, bancos ni contabilidad.`,
      sinCifras: true,
    };
  }
  return {
    entendido: `Resumen de la empresa a ${fechaES(ctx.hoy)}`,
    texto: frases.join(' '),
    permisoRequerido: permisos.join(';'),
    kpis,
    botones: [
      ...(tiene(ctx, 'ventas:read', 'contabilidad:read') ? [botonIntencion('Ver facturas vencidas', 'INT-03')] : []),
      ...(tiene(ctx, 'tesoreria:read') ? [botonIntencion('Saldo por cuenta', 'INT-24')] : []),
    ],
  };
};

// ---------------- Intenciones que por ahora solo llevan a su pantalla ----------------

export function soloPantalla(permisos: string[], area: AreaIntencion, titulo: string, ruta: string, href: string): Ejecutor {
  return async (ctx) => {
    if (!tiene(ctx, ...permisos)) return { sinPermiso: true, area };
    return {
      entendido: titulo,
      texto: `Esa cifra todavía no la calculo desde el chat. La tienes en ${ruta}.`,
      sinCifras: true,
      enlaces: [{ texto: `Ir a ${ruta.split(' → ').pop()}`, href }],
    };
  };
}

export const EJECUTORES = {
  deudaDeCliente,
  pendienteDeCobro,
  facturasVencidas,
  cobradoEnPeriodo,
  asientosPendientes,
  saldoBancos,
  ultimosMovimientos,
  proximosImpuestos,
  resumenEmpresa,
};

export type { Ejecutor };
