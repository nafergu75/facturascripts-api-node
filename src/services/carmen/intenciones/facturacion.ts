/**
 * Intenciones de facturación y pagos (capa 1, 0 €): lo que se debe a
 * proveedores (INT-06/07), lo facturado y gastado en un periodo frente al año
 * anterior (INT-09/10) y la búsqueda de una factura por número (INT-13).
 *
 * SOLO LECTURA. Cada ejecutor comprueba sus permisos ANTES de llamar al
 * servicio de origen y, sin permiso, devuelve { sinPermiso } sin cifras.
 */
import { prisma } from '../../../config/database';
import { pendientesSegunFacturas } from '../../informesContables.service';
import { resumenFiscalPeriodo, type ResumenFiscalPeriodo } from '../../resumenFiscal.service';
import { listarCobros, type TipoDocumento } from '../../cobrosPagos.service';
import type { ColumnaInforme } from '../../informesContables.documentos';
import { tiene } from '../contexto';
import { botonIntencion, diasEntre, eur, fechaES, plural, sumar, tabla, unAnioAntes, variacion } from '../plantillas';
import { hastaHoy, resolverCodigoPeriodo } from '../huecos/periodo';
import { indiceTerceros } from '../terceros';
import type { CarmenCtx, HuecosResueltos, Kpi, RespuestaDatos } from '../tipos';

type Ejecutor = (ctx: CarmenCtx, h: HuecosResueltos) => Promise<RespuestaDatos>;

// ---------------- INT-06/07: lo que debes a proveedores ----------------

const COLS_PAGOS: ColumnaInforme[] = [
  { titulo: 'Factura', tipo: 'codigo', ancho: 3 },
  { titulo: 'Proveedor', tipo: 'texto', ancho: 6 },
  { titulo: 'Vence', tipo: 'fecha', ancho: 3 },
  { titulo: 'Retraso', tipo: 'texto', ancho: 2 },
  { titulo: 'Pendiente', tipo: 'importe', ancho: 3 },
];

export const CRITERIO_PAGOS =
  'Cuenta el total a pagar de cada factura recibida (sin borradores) menos los pagos registrados hasta hoy.';

export const deudaConProveedores: Ejecutor = async (ctx, h) => {
  if (!tiene(ctx, 'compras:read', 'contabilidad:read')) return { sinPermiso: true, area: 'pagos' };
  const [facturas, terceros] = await Promise.all([pendientesSegunFacturas(ctx.companyId, 'proveedores', ctx.hoy), indiceTerceros(ctx.companyId)]);
  const nombres = new Map(terceros.filter((t) => t.rol === 'proveedor').map((t) => [t.id, t.nombre]));
  const permisoRequerido = 'compras:read|contabilidad:read';
  const enlaceCompras = { texto: 'Ver compras', href: '/dashboard/compras' };

  let lista = facturas.map((f) => ({ ...f, proveedor: nombres.get(f.terceroId) ?? 'Proveedor', retraso: Math.max(0, diasEntre(f.fechaVencimiento, ctx.hoy)) }));
  let proveedor: string | null = null;
  if (h.rol === 'proveedor' && h.terceroId) {
    proveedor = nombres.get(h.terceroId) ?? null;
    if (!proveedor) {
      return { entendido: 'Lo que debes a un proveedor', texto: 'No encuentro ese proveedor en esta empresa.', sinCifras: true, enlaces: [{ texto: 'Ver proveedores', href: '/dashboard/proveedores' }] };
    }
    lista = lista.filter((f) => f.terceroId === h.terceroId);
  }
  lista.sort((a, b) => a.fechaVencimiento.localeCompare(b.fechaVencimiento) || (a.numeroCompleto ?? '').localeCompare(b.numeroCompleto ?? ''));
  const vencidas = lista.filter((f) => f.fechaVencimiento < ctx.hoy);
  const totalVencido = sumar(vencidas.map((f) => f.importePendiente));
  const enlaces = proveedor
    ? [{ texto: `Ficha de ${proveedor}`, href: `/dashboard/proveedores/${h.terceroId}` }, enlaceCompras]
    : [enlaceCompras];
  const fila = (f: (typeof lista)[number]) => ({
    celdas: [f.numeroCompleto ?? 'sin número', f.proveedor, f.fechaVencimiento, f.retraso > 0 ? plural(f.retraso, 'día') : '', f.importePendiente],
  });
  const kpis = (l: typeof lista): Kpi[] => [
    { etiqueta: 'Pendiente de pago', valor: eur(sumar(l.map((f) => f.importePendiente))), detalle: plural(l.length, 'factura') },
    { etiqueta: 'Vencido', valor: eur(totalVencido), detalle: plural(vencidas.length, 'factura') },
  ];
  const a = proveedor ? ` a ${proveedor}` : ' a tus proveedores';

  // Solo lo vencido.
  if (h.soloVencidas) {
    const entendido = `Facturas de proveedores vencidas sin pagar${proveedor ? ` de ${proveedor}` : ''} a ${fechaES(ctx.hoy)}`;
    if (!vencidas.length) {
      return { entendido, texto: `No tienes facturas de proveedores vencidas sin pagar a ${fechaES(ctx.hoy)}. ${CRITERIO_PAGOS}`, permisoRequerido, enlaces };
    }
    const masAntiguas = [...vencidas].sort((x, y) => y.retraso - x.retraso);
    return {
      entendido,
      texto: `Tienes ${plural(vencidas.length, 'factura vencida', 'facturas vencidas')} sin pagar${a} por ${eur(totalVencido)}. ${CRITERIO_PAGOS}`,
      permisoRequerido,
      kpis: [{ etiqueta: 'Vencido sin pagar', valor: eur(totalVencido), detalle: plural(vencidas.length, 'factura') }],
      tabla: tabla('Facturas de proveedores vencidas, de más a menos retraso', `A ${fechaES(ctx.hoy)}`, COLS_PAGOS, masAntiguas.map(fila)),
      enlaces,
      botones: [botonIntencion('Todo lo pendiente de pago', 'INT-06', proveedor ? { terceroId: h.terceroId, rol: 'proveedor' } : undefined)],
    };
  }

  // Vencimientos de un periodo («¿qué tengo que pagar esta semana?»).
  if (h.periodo) {
    const p = h.periodo;
    const delPeriodo = lista.filter((f) => f.fechaVencimiento >= p.desde && f.fechaVencimiento <= p.hasta);
    const total = sumar(delPeriodo.map((f) => f.importePendiente));
    const entendido = `Pagos a proveedores con vencimiento en ${p.etiqueta}`;
    // Lo vencido antes del periodo no sale en él: se avisa aparte.
    const antes = vencidas.filter((f) => f.fechaVencimiento < p.desde);
    const yVencidas = antes.length
      ? ` Además tienes ${plural(antes.length, 'factura vencida', 'facturas vencidas')} de antes sin pagar por ${eur(sumar(antes.map((f) => f.importePendiente)))}.`
      : '';
    return {
      entendido,
      texto:
        (delPeriodo.length
          ? `Con vencimiento en ${p.etiqueta} tienes ${plural(delPeriodo.length, 'factura')} de proveedores por ${eur(total)}.`
          : `No tienes facturas de proveedores con vencimiento en ${p.etiqueta}.`) +
        `${yVencidas} ${CRITERIO_PAGOS}`,
      permisoRequerido,
      kpis: [
        { etiqueta: `Vence en ${p.etiqueta}`, valor: eur(total), detalle: plural(delPeriodo.length, 'factura') },
        { etiqueta: 'Vencido', valor: eur(totalVencido), detalle: plural(vencidas.length, 'factura') },
      ],
      ...(delPeriodo.length ? { tabla: tabla(`Pagos con vencimiento en ${p.etiqueta}`, `A ${fechaES(ctx.hoy)}`, COLS_PAGOS, delPeriodo.map(fila)) } : {}),
      enlaces,
      botones: [botonIntencion('Solo las vencidas', 'INT-06', { soloVencidas: true })],
    };
  }

  // Todo lo pendiente (de un proveedor o de todos).
  const entendido = proveedor ? `Lo que debes a ${proveedor} a ${fechaES(ctx.hoy)}` : `Pendiente de pago a proveedores a ${fechaES(ctx.hoy)}`;
  if (!lista.length) {
    return {
      entendido,
      texto: `${proveedor ? `No le debes nada a ${proveedor}` : 'No tienes facturas de proveedores pendientes de pago'} a ${fechaES(ctx.hoy)}. ${CRITERIO_PAGOS}`,
      permisoRequerido,
      enlaces,
    };
  }
  const total = sumar(lista.map((f) => f.importePendiente));
  const proveedores = new Set(lista.map((f) => f.terceroId)).size;
  const deCuantos = proveedor ? '' : ` de ${plural(proveedores, 'proveedor', 'proveedores')}`;
  const frase = vencidas.length
    ? vencidas.length === lista.length
      ? ' Todas están vencidas.'
      : ` ${plural(vencidas.length, 'está vencida', 'están vencidas')} (${eur(totalVencido)}).`
    : ' Ninguna ha vencido todavía.';
  return {
    entendido,
    texto: `${proveedor ? `Le debes ${eur(total)} a ${proveedor}` : `Debes ${eur(total)}${a}`} en ${plural(lista.length, 'factura')}${deCuantos}.${frase} ${CRITERIO_PAGOS}`,
    permisoRequerido,
    kpis: kpis(lista),
    tabla: tabla(proveedor ? `Facturas pendientes de ${proveedor}` : 'Próximos pagos a proveedores', `A ${fechaES(ctx.hoy)}`, COLS_PAGOS, lista.map(fila)),
    enlaces,
    botones: [
      botonIntencion('Solo las vencidas', 'INT-06', { soloVencidas: true, ...(proveedor ? { terceroId: h.terceroId, rol: 'proveedor' as const } : {}) }),
      botonIntencion('¿Qué vence esta semana?', 'INT-06', { periodo: 'esta-semana' }),
    ],
  };
};

// ---------------- INT-09/10: facturado y gastado en un periodo ----------------

const CRITERIO_FACTURADO = 'Cuenta las facturas emitidas y recibidas con fecha en el periodo, sin borradores ni proformas; importes sin IVA.';

function fraseComparada(verbo: string, actual: ResumenFiscalPeriodo['ventas'], anterior: ResumenFiscalPeriodo['ventas'], anioAnterior: number): string {
  const v = variacion(actual.base, anterior.base);
  const comparacion = anterior.facturas
    ? `en el mismo periodo de ${anioAnterior}, ${eur(anterior.base)}${v ? ` (${v})` : ''}`
    : `en el mismo periodo de ${anioAnterior} no hay facturas`;
  return `${verbo} ${eur(actual.base)} en ${plural(actual.facturas, 'factura')}; ${comparacion}.`;
}

export const facturadoEnPeriodo: Ejecutor = async (ctx, h) => {
  const puedeVentas = tiene(ctx, 'ventas:read', 'contabilidad:read');
  const puedeGastos = tiene(ctx, 'compras:read', 'contabilidad:read');
  if (h.foco === 'ventas' && !puedeVentas) return { sinPermiso: true, area: 'cobros' };
  if (h.foco === 'gastos' && !puedeGastos) return { sinPermiso: true, area: 'pagos' };
  if (!puedeVentas && !puedeGastos) return { sinPermiso: true, area: 'facturacion' };

  const periodo = h.periodo ?? resolverCodigoPeriodo('este-trimestre', ctx.hoy)!;
  const verVentas = puedeVentas && h.foco !== 'gastos';
  const verGastos = puedeGastos && h.foco !== 'ventas';
  const que = verVentas && verGastos ? 'Facturado y gastado' : verVentas ? 'Facturado' : 'Gastado';
  const entendido = `${que} en ${periodo.etiqueta}, frente al mismo periodo del año anterior`;
  if (periodo.desde > ctx.hoy) {
    return { entendido, texto: `Ese periodo (${periodo.etiqueta}) todavía no ha empezado.`, sinCifras: true };
  }
  const hasta = hastaHoy(periodo, ctx.hoy);
  const desdeAnt = unAnioAntes(periodo.desde);
  const hastaAnt = unAnioAntes(hasta);
  const anioAnt = Number(desdeAnt.slice(0, 4));
  const [actual, anterior] = await Promise.all([
    resumenFiscalPeriodo(ctx.companyId, periodo.desde, hasta),
    resumenFiscalPeriodo(ctx.companyId, desdeAnt, hastaAnt),
  ]);
  // «Este trimestre», hasta hoy; «lo que va de 2026» ya lo dice.
  const recorte = hasta < periodo.hasta && !periodo.etiqueta.startsWith('lo que va') ? ', hasta hoy,' : '';
  const frases: string[] = [];
  const kpis: Kpi[] = [];
  const filas: Array<{ celdas: Array<string | number> }> = [];
  const permisos: string[] = [];
  if (verVentas) {
    permisos.push('ventas:read|contabilidad:read');
    frases.push(fraseComparada(`En ${periodo.etiqueta}${recorte} has facturado`, actual.ventas, anterior.ventas, anioAnt));
    kpis.push({ etiqueta: 'Facturado sin IVA', valor: eur(actual.ventas.base), detalle: plural(actual.ventas.facturas, 'factura') });
    kpis.push({ etiqueta: `Mismo periodo de ${anioAnt}`, valor: eur(anterior.ventas.base), detalle: variacion(actual.ventas.base, anterior.ventas.base) ?? undefined });
    filas.push({ celdas: ['Ventas (base imponible)', actual.ventas.base, anterior.ventas.base] }, { celdas: ['IVA repercutido', actual.ventas.iva, anterior.ventas.iva] });
  }
  if (verGastos) {
    permisos.push('compras:read|contabilidad:read');
    frases.push(fraseComparada(`${verVentas ? 'Has gastado' : `En ${periodo.etiqueta}${recorte} has gastado`}`, actual.gastos, anterior.gastos, anioAnt));
    kpis.push({ etiqueta: 'Gastado sin IVA', valor: eur(actual.gastos.base), detalle: plural(actual.gastos.facturas, 'factura') });
    kpis.push({ etiqueta: `Gastos en ${anioAnt}`, valor: eur(anterior.gastos.base), detalle: variacion(actual.gastos.base, anterior.gastos.base) ?? undefined });
    filas.push({ celdas: ['Gastos (base imponible)', actual.gastos.base, anterior.gastos.base] }, { celdas: ['IVA soportado', actual.gastos.iva, anterior.gastos.iva] });
  }
  const otro =
    periodo.codigo === 'este-trimestre' ? botonIntencion('¿Y el trimestre pasado?', 'INT-09', { periodo: 'trimestre-pasado', ...(h.foco ? { foco: h.foco } : {}) })
    : periodo.codigo === 'este-mes' ? botonIntencion('¿Y el mes pasado?', 'INT-09', { periodo: 'mes-pasado', ...(h.foco ? { foco: h.foco } : {}) })
    : botonIntencion('¿Y este año?', 'INT-09', { periodo: 'este-anio', ...(h.foco ? { foco: h.foco } : {}) });
  return {
    entendido,
    texto: `${frases.join(' ')} ${CRITERIO_FACTURADO}`,
    permisoRequerido: permisos.join(';'),
    kpis,
    tabla: tabla(
      `${que} frente al año anterior`,
      `Del ${fechaES(periodo.desde)} al ${fechaES(hasta)} y del ${fechaES(desdeAnt)} al ${fechaES(hastaAnt)}`,
      [
        { titulo: 'Concepto', tipo: 'texto', ancho: 6 },
        { titulo: periodo.etiqueta, tipo: 'importe', ancho: 3 },
        { titulo: `Mismo periodo ${anioAnt}`, tipo: 'importe', ancho: 3 },
      ],
      filas,
    ),
    enlaces: [
      ...(verVentas ? [{ texto: 'Ver facturas de ingreso', href: '/dashboard/facturas' }] : []),
      ...(verGastos ? [{ texto: 'Ver compras', href: '/dashboard/compras' }] : []),
    ],
    botones: [otro],
  };
};

// ---------------- INT-13: buscar una factura ----------------

/** «2026-0045» → «202645»; «a-012» → «A12»: sin ceros a la izquierda ni separadores. */
export function claveNumeroFactura(numero: string): string {
  return numero
    .toUpperCase()
    .replace(/(^|\D)0+(?=\d)/g, '$1')
    .replace(/[^A-Z0-9Ñ]/g, '');
}

interface Encontrada {
  tipo: TipoDocumento;
  id: string;
  numero: string;
  tercero: string;
  fecha: string;
  vence: string;
  total: number;
  proforma: boolean;
}

export const buscarFactura: Ejecutor = async (ctx, h) => {
  const ventas = tiene(ctx, 'ventas:read');
  const compras = tiene(ctx, 'compras:read');
  if (!ventas && !compras) return { sinPermiso: true, area: 'facturacion' };
  const buscado = h.numeroFactura?.trim();
  if (!buscado) {
    return { entendido: 'Buscar una factura', texto: '¿Qué factura busco? Escribe su número tal cual, por ejemplo «A-12» o «2026-45».', sinCifras: true };
  }
  const final = buscado.match(/(\d+)\D*$/);
  if (!final) return { entendido: `Buscar la factura ${buscado}`, texto: `«${buscado}» no parece un número de factura.`, sinCifras: true };
  const numero = Number(final[1]);
  const soloNumero = /^\d+$/.test(buscado);
  const clave = claveNumeroFactura(buscado);
  const coincide = (nc: string | null) => !!nc && (soloNumero || claveNumeroFactura(nc) === clave);

  const [emitidas, recibidas] = await Promise.all([
    ventas
      ? prisma.incomeInvoice.findMany({
          where: { companyId: ctx.companyId, numero },
          select: { id: true, numeroCompleto: true, estadoDocumento: true, fechaEmision: true, fechaVencimiento: true, totalFactura: true, customer: { select: { nombreFiscal: true } } },
          take: 50,
        })
      : Promise.resolve([]),
    compras
      ? prisma.expenseInvoice.findMany({
          where: { companyId: ctx.companyId, numero, estado: { not: 'DRAFT' } },
          select: { id: true, numeroCompleto: true, fechaEmision: true, fechaVencimiento: true, totalFactura: true, supplier: { select: { nombreFiscal: true } } },
          take: 50,
        })
      : Promise.resolve([]),
  ]);
  const encontradas: Encontrada[] = [
    ...emitidas
      .filter((f) => coincide(f.numeroCompleto) && f.estadoDocumento !== 'BORRADOR')
      .map((f) => ({ tipo: 'INGRESO' as const, id: f.id, numero: f.numeroCompleto!, tercero: f.customer.nombreFiscal, fecha: f.fechaEmision, vence: f.fechaVencimiento, total: Number(f.totalFactura), proforma: f.estadoDocumento === 'PROFORMA' })),
    ...recibidas
      .filter((f) => coincide(f.numeroCompleto))
      .map((f) => ({ tipo: 'GASTO' as const, id: f.id, numero: f.numeroCompleto, tercero: f.supplier.nombreFiscal, fecha: f.fechaEmision, vence: f.fechaVencimiento, total: Number(f.totalFactura), proforma: false })),
  ];
  const donde = ventas && compras ? 'emitidas ni recibidas' : ventas ? 'emitidas' : 'recibidas';
  const entendido = `Buscar la factura ${buscado}`;
  const href = (f: Encontrada) => (f.tipo === 'INGRESO' ? `/dashboard/facturas/${f.id}` : `/dashboard/compras/${f.id}`);
  if (!encontradas.length) {
    return {
      entendido,
      texto: `No encuentro la factura ${buscado} entre tus facturas ${donde}.`,
      sinCifras: true,
      enlaces: [
        ...(ventas ? [{ texto: 'Ver facturas de ingreso', href: '/dashboard/facturas' }] : []),
        ...(compras ? [{ texto: 'Ver compras', href: '/dashboard/compras' }] : []),
      ],
    };
  }
  const permisoRequerido = [...new Set(encontradas.map((f) => (f.tipo === 'INGRESO' ? 'ventas:read' : 'compras:read')))].join(';');

  if (encontradas.length > 1) {
    return {
      entendido,
      texto: `Hay ${encontradas.length} facturas con el número ${buscado}. Elige la que buscas en su pantalla.`,
      permisoRequerido,
      tabla: tabla(
        `Facturas con el número ${buscado}`,
        `A ${fechaES(ctx.hoy)}`,
        [
          { titulo: 'Tipo', tipo: 'texto', ancho: 3 },
          { titulo: 'Factura', tipo: 'codigo', ancho: 3 },
          { titulo: 'Cliente o proveedor', tipo: 'texto', ancho: 6 },
          { titulo: 'Fecha', tipo: 'fecha', ancho: 3 },
          { titulo: 'Total', tipo: 'importe', ancho: 3 },
        ],
        encontradas.map((f) => ({ celdas: [f.proforma ? 'Proforma' : f.tipo === 'INGRESO' ? 'Emitida' : 'Recibida', f.numero, f.tercero, f.fecha, f.total] })),
      ),
      enlaces: encontradas.slice(0, 3).map((f) => ({ texto: `Abrir ${f.numero} (${f.tercero})`, href: href(f) })),
    };
  }

  const f = encontradas[0];
  const enlaces = [{ texto: `Abrir la factura ${f.numero}`, href: href(f) }];
  if (f.proforma) {
    return {
      entendido,
      texto: `${f.numero} es una proforma para ${f.tercero}, del ${fechaES(f.fecha)}, por ${eur(f.total)}. Una proforma no se cobra ni se contabiliza: si el cliente la acepta, pásala a factura.`,
      permisoRequerido,
      kpis: [{ etiqueta: 'Total de la proforma', valor: eur(f.total) }],
      enlaces,
    };
  }
  const r = await listarCobros(ctx.companyId, f.tipo, f.id);
  const emitida = f.tipo === 'INGRESO';
  const de = emitida ? 'cobro' : 'pago';
  const quien = emitida ? `a ${f.tercero}` : `de ${f.tercero}`;
  const retraso = diasEntre(f.vence, ctx.hoy);
  let estado: string;
  if (r.importePendiente <= 0) {
    estado = emitida ? 'Está cobrada.' : 'Está pagada.';
  } else {
    const vencida = retraso > 0 ? ` Venció el ${fechaES(f.vence)} (hace ${plural(retraso, 'día')}).` : ` Vence el ${fechaES(f.vence)}.`;
    estado = `${r.importeCobrado > 0 ? `Lleva ${eur(r.importeCobrado)} ${emitida ? 'cobrados' : 'pagados'} y quedan` : 'Quedan'} ${eur(r.importePendiente)} pendientes de ${de}.${vencida}`;
  }
  const activos = r.cobros.filter((c) => c.estado === 'ACTIVO');
  return {
    entendido,
    texto: `La factura ${f.numero} ${emitida ? 'emitida' : 'recibida'} ${quien}, del ${fechaES(f.fecha)}, es de ${eur(r.totalFactura)}. ${estado}`,
    permisoRequerido,
    kpis: [
      { etiqueta: 'Total', valor: eur(r.totalFactura) },
      { etiqueta: emitida ? 'Cobrado' : 'Pagado', valor: eur(r.importeCobrado), detalle: plural(activos.length, de) },
      { etiqueta: 'Pendiente', valor: eur(r.importePendiente) },
    ],
    ...(activos.length
      ? {
          tabla: tabla(
            emitida ? 'Cobros registrados' : 'Pagos registrados',
            `Factura ${f.numero}`,
            [
              { titulo: 'Fecha', tipo: 'fecha', ancho: 3 },
              { titulo: 'Medio', tipo: 'texto', ancho: 3 },
              { titulo: 'Importe', tipo: 'importe', ancho: 3 },
            ],
            activos.map((c) => ({ celdas: [c.fecha, c.medio === 'BANCO' ? 'Banco' : 'Caja', c.importe] })),
          ),
        }
      : {}),
    enlaces,
  };
};

export const EJECUTORES_FACTURACION = { deudaConProveedores, facturadoEnPeriodo, buscarFactura };
