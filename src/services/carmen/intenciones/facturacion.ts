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
import { facturasPorCobrar } from '../../cobrosClientes.service';
import type { ColumnaInforme } from '../../informesContables.documentos';
import { tiene } from '../contexto';
import { botonIntencion, diasEntre, eur, fechaES, plural, sumar, tabla, unAnioAntes, variacion } from '../plantillas';
import { hastaHoy, resolverCodigoPeriodo } from '../huecos/periodo';
import { indiceTerceros } from '../terceros';
import type { CarmenCtx, HuecosResueltos, Kpi, RespuestaDatos } from '../tipos';
import { GASTO_VIGENTE } from '../../../domain/factura-gasto.model';
import { expenseInvoicesService } from '../../expense-invoices.service';

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

  // Los abonos con algo a tu favor (pendiente en negativo) van aparte: no son
  // facturas que pagar ni salen como vencidas.
  const todas = facturas.map((f) => ({ ...f, proveedor: nombres.get(f.terceroId) ?? 'Proveedor', retraso: Math.max(0, diasEntre(f.fechaVencimiento, ctx.hoy)) }));
  let lista = todas.filter((f) => f.importePendiente > 0);
  let abonos = todas.filter((f) => f.importePendiente < 0);
  let proveedor: string | null = null;
  if (h.rol === 'proveedor' && h.terceroId) {
    proveedor = nombres.get(h.terceroId) ?? null;
    if (!proveedor) {
      return { entendido: 'Lo que debes a un proveedor', texto: 'No encuentro ese proveedor en esta empresa.', sinCifras: true, enlaces: [{ texto: 'Ver proveedores', href: '/dashboard/proveedores' }] };
    }
    lista = lista.filter((f) => f.terceroId === h.terceroId);
    abonos = abonos.filter((f) => f.terceroId === h.terceroId);
  }
  const aFavor = sumar(abonos.map((f) => -f.importePendiente));
  const kpiAFavor: Kpi[] = aFavor > 0 ? [{ etiqueta: 'A tu favor', valor: eur(aFavor), detalle: plural(abonos.length, 'abono') }] : [];
  const unAbono = abonos.length === 1;
  const pideDevolucion = `${plural(abonos.length, 'abono')}: pide la devolución o ${unAbono ? 'aplícalo' : 'aplícalos'} a otra factura.`;
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
      texto:
        `${proveedor ? `No le debes nada a ${proveedor}` : 'No tienes facturas de proveedores pendientes de pago'} a ${fechaES(ctx.hoy)}.` +
        `${aFavor > 0 ? ` Tienes ${eur(aFavor)} a tu favor en ${pideDevolucion}` : ''} ${CRITERIO_PAGOS}`,
      permisoRequerido,
      ...(kpiAFavor.length ? { kpis: kpiAFavor } : {}),
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
  // A tu favor: con un proveedor cuyos abonos superan lo pendiente, el saldo neto.
  const fraseAFavor =
    aFavor <= 0
      ? ''
      : proveedor && aFavor > total
        ? ` Con sus abonos (${eur(aFavor)}), el saldo es de ${eur(Math.round((aFavor - total) * 100) / 100)} a tu favor: pide la devolución o aplícalo a otra factura.`
        : ` Además tienes ${eur(aFavor)} a tu favor en ${pideDevolucion}`;
  return {
    entendido,
    texto: `${proveedor ? `Le debes ${eur(total)} a ${proveedor}` : `Debes ${eur(total)}${a}`} en ${plural(lista.length, 'factura')}${deCuantos}.${frase}${fraseAFavor} ${CRITERIO_PAGOS}`,
    permisoRequerido,
    kpis: [...kpis(lista), ...kpiAFavor],
    tabla: tabla(proveedor ? `Facturas pendientes de ${proveedor}` : 'Próximos pagos a proveedores', `A ${fechaES(ctx.hoy)}`, COLS_PAGOS, lista.map(fila)),
    enlaces,
    botones: [
      botonIntencion('Solo las vencidas', 'INT-06', { soloVencidas: true, ...(proveedor ? { terceroId: h.terceroId, rol: 'proveedor' as const } : {}) }),
      botonIntencion('¿Qué vence esta semana?', 'INT-06', { periodo: 'esta-semana' }),
    ],
  };
};

// ---------------- INT-09/10: facturado y gastado en un periodo ----------------

const CRITERIO_FACTURADO = 'Las ventas cuentan por la fecha de la operación (si la factura no la lleva, por la de la factura) y una rectificativa por sustitución, solo por lo que cambia respecto a la original. Los gastos, por la fecha de la factura. Sin borradores ni proformas; importes sin IVA.';

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
  // Un cliente o un proveedor en la pregunta: solo sus facturas (lo facturado al cliente, lo gastado con el proveedor).
  let tercero: { id: string; nombre: string; rol: 'cliente' | 'proveedor' } | null = null;
  if (h.terceroId && (h.rol === 'cliente' || h.rol === 'proveedor')) {
    const t = (await indiceTerceros(ctx.companyId)).find((x) => x.id === h.terceroId && x.rol === h.rol);
    if (!t) {
      return { entendido: 'Facturado a un cliente o gastado con un proveedor', texto: 'No encuentro ese cliente o proveedor en esta empresa.', sinCifras: true };
    }
    tercero = { id: t.id, nombre: t.nombre, rol: h.rol };
  }
  const foco = tercero ? (tercero.rol === 'cliente' ? 'ventas' : 'gastos') : h.foco;
  if (foco === 'ventas' && !puedeVentas) return { sinPermiso: true, area: 'cobros' };
  if (foco === 'gastos' && !puedeGastos) return { sinPermiso: true, area: 'pagos' };
  if (!puedeVentas && !puedeGastos) return { sinPermiso: true, area: 'facturacion' };

  const periodo = h.periodo ?? resolverCodigoPeriodo('este-trimestre', ctx.hoy)!;
  const verVentas = puedeVentas && foco !== 'gastos';
  const verGastos = puedeGastos && foco !== 'ventas';
  const que = verVentas && verGastos ? 'Facturado y gastado' : verVentas ? 'Facturado' : 'Gastado';
  const conQuien = tercero ? (tercero.rol === 'cliente' ? ` a ${tercero.nombre}` : ` con ${tercero.nombre}`) : '';
  const entendido = `${que}${conQuien} en ${periodo.etiqueta}, frente al mismo periodo del año anterior`;
  const avisos: string[] = [];
  if (tercero && h.foco && h.foco !== foco) {
    avisos.push(
      tercero.rol === 'cliente'
        ? `${tercero.nombre} es cliente: te enseño lo que le has facturado.`
        : `${tercero.nombre} es proveedor: te enseño lo que te ha facturado (tus gastos con él).`,
    );
  }
  if (periodo.desde > ctx.hoy) {
    return { entendido, texto: `Ese periodo (${periodo.etiqueta}) todavía no ha empezado.`, sinCifras: true };
  }
  const hasta = hastaHoy(periodo, ctx.hoy);
  const desdeAnt = unAnioAntes(periodo.desde);
  const hastaAnt = unAnioAntes(hasta);
  const anioAnt = Number(desdeAnt.slice(0, 4));
  const filtro = tercero ? (tercero.rol === 'cliente' ? { customerId: tercero.id } : { supplierId: tercero.id }) : undefined;
  const [actual, anterior] = await Promise.all([
    resumenFiscalPeriodo(ctx.companyId, periodo.desde, hasta, filtro),
    resumenFiscalPeriodo(ctx.companyId, desdeAnt, hastaAnt, filtro),
  ]);
  // «Este trimestre», hasta hoy; «lo que va de 2026» ya lo dice.
  const recorte = hasta < periodo.hasta && !periodo.etiqueta.startsWith('lo que va') ? ', hasta hoy,' : '';
  const frases: string[] = [];
  const kpis: Kpi[] = [];
  const filas: Array<{ celdas: Array<string | number> }> = [];
  const permisos: string[] = [];
  // Una empresa no establecida en España no lleva IVA español: ni la fila del IVA ni «sin IVA».
  const sinImpuesto = ctx.espanola ? 'sin IVA' : 'sin impuestos';
  if (verVentas) {
    permisos.push('ventas:read|contabilidad:read');
    const verbo = tercero ? `En ${periodo.etiqueta}${recorte} le has facturado a ${tercero.nombre}` : `En ${periodo.etiqueta}${recorte} has facturado`;
    frases.push(fraseComparada(verbo, actual.ventas, anterior.ventas, anioAnt));
    kpis.push({ etiqueta: `Facturado ${sinImpuesto}`, valor: eur(actual.ventas.base), detalle: plural(actual.ventas.facturas, 'factura') });
    kpis.push({ etiqueta: `Mismo periodo de ${anioAnt}`, valor: eur(anterior.ventas.base), detalle: variacion(actual.ventas.base, anterior.ventas.base) ?? undefined });
    filas.push({ celdas: ['Ventas (base imponible)', actual.ventas.base, anterior.ventas.base] });
    if (ctx.espanola) filas.push({ celdas: ['IVA repercutido', actual.ventas.iva, anterior.ventas.iva] });
  }
  if (verGastos) {
    permisos.push('compras:read|contabilidad:read');
    const verbo = tercero
      ? `En ${periodo.etiqueta}${recorte} has gastado con ${tercero.nombre}`
      : `${verVentas ? 'Has gastado' : `En ${periodo.etiqueta}${recorte} has gastado`}`;
    frases.push(fraseComparada(verbo, actual.gastos, anterior.gastos, anioAnt));
    kpis.push({ etiqueta: `Gastado ${sinImpuesto}`, valor: eur(actual.gastos.base), detalle: plural(actual.gastos.facturas, 'factura') });
    kpis.push({ etiqueta: `Gastos en ${anioAnt}`, valor: eur(anterior.gastos.base), detalle: variacion(actual.gastos.base, anterior.gastos.base) ?? undefined });
    filas.push({ celdas: ['Gastos (base imponible)', actual.gastos.base, anterior.gastos.base] });
    if (ctx.espanola) filas.push({ celdas: ['IVA soportado', actual.gastos.iva, anterior.gastos.iva] });
  }
  // Los botones repiten la consulta con el mismo cliente o proveedor (por su id, nunca por el nombre).
  const mismos = { ...(h.foco && !tercero ? { foco: h.foco } : {}), ...(tercero ? { terceroId: tercero.id, rol: tercero.rol } : {}) };
  const otro =
    periodo.codigo === 'este-trimestre' ? botonIntencion('¿Y el trimestre pasado?', 'INT-09', { periodo: 'trimestre-pasado', ...mismos })
    : periodo.codigo === 'este-mes' ? botonIntencion('¿Y el mes pasado?', 'INT-09', { periodo: 'mes-pasado', ...mismos })
    : periodo.codigo === 'este-anio' ? botonIntencion('¿Y el año pasado?', 'INT-09', { periodo: 'anio-pasado', ...mismos })
    : botonIntencion('¿Y este año?', 'INT-09', { periodo: 'este-anio', ...mismos });
  return {
    entendido,
    texto: `${frases.join(' ')} ${ctx.espanola ? CRITERIO_FACTURADO : CRITERIO_FACTURADO.replace('sin IVA', 'sin impuestos')}`,
    permisoRequerido: permisos.join(';'),
    kpis,
    ...(avisos.length ? { avisos } : {}),
    tabla: tabla(
      `${que}${conQuien} frente al año anterior`,
      `Del ${fechaES(periodo.desde)} al ${fechaES(hasta)} y del ${fechaES(desdeAnt)} al ${fechaES(hastaAnt)}`,
      [
        { titulo: 'Concepto', tipo: 'texto', ancho: 6 },
        { titulo: periodo.etiqueta, tipo: 'importe', ancho: 3 },
        { titulo: `Mismo periodo ${anioAnt}`, tipo: 'importe', ancho: 3 },
      ],
      filas,
    ),
    enlaces: [
      ...(tercero ? [{ texto: `Ficha de ${tercero.nombre}`, href: `/dashboard/${tercero.rol === 'cliente' ? 'clientes' : 'proveedores'}/${tercero.id}` }] : []),
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
  /** Solo emitidas: la factura que rectifica y cómo (S por sustitución, I por diferencias). */
  facturaOriginalId?: string | null;
  tipoRectificativa?: string | null;
  /** Solo emitidas: es una rectificativa (con varias facturas, un periodo o una de fuera, facturaOriginalId va vacío). */
  esRectificativa?: boolean;
  /** Solo emitidas: la factura de fuera de la app que rectifica (con los campos de antes). */
  rectificaFueraNumero?: string | null;
  /** Solo recibidas: el numero que puso el proveedor. */
  numeroProveedor?: string | null;
}

/** Ventas válidas: emitidas, sin borradores (los antiguos quedaron con estado DRAFT y documento FINAL). */
const VENTA_EMITIDA = { estadoDocumento: 'FINAL', estado: { not: 'DRAFT' } } as const;

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
          // Sin borradores: ni los de ahora (BORRADOR) ni los antiguos (estado DRAFT con documento FINAL).
          where: { companyId: ctx.companyId, numero, estado: { not: 'DRAFT' } },
          select: {
            id: true,
            numeroCompleto: true,
            estadoDocumento: true,
            fechaEmision: true,
            fechaVencimiento: true,
            totalFactura: true,
            facturaOriginalId: true,
            tipoRectificativa: true,
            esRectificativa: true,
            rectificaFueraNumero: true,
            customer: { select: { nombreFiscal: true } },
          },
          take: 50,
        })
      : Promise.resolve([]),
    compras
      ? prisma.expenseInvoice.findMany({
          where: { companyId: ctx.companyId, numero, ...GASTO_VIGENTE },
          select: { id: true, numeroCompleto: true, numeroFacturaProveedor: true, fechaEmision: true, fechaVencimiento: true, totalFactura: true, supplier: { select: { nombreFiscal: true } } },
          take: 50,
        })
      : Promise.resolve([]),
  ]);
  const encontradas: Encontrada[] = [
    ...emitidas
      .filter((f) => coincide(f.numeroCompleto) && f.estadoDocumento !== 'BORRADOR')
      .map((f) => ({
        tipo: 'INGRESO' as const,
        id: f.id,
        numero: f.numeroCompleto!,
        tercero: f.customer.nombreFiscal,
        fecha: f.fechaEmision,
        vence: f.fechaVencimiento,
        total: Number(f.totalFactura),
        proforma: f.estadoDocumento === 'PROFORMA',
        facturaOriginalId: f.facturaOriginalId,
        tipoRectificativa: f.tipoRectificativa,
        esRectificativa: f.esRectificativa,
        rectificaFueraNumero: f.rectificaFueraNumero,
      })),
    ...recibidas
      .filter((f) => coincide(f.numeroCompleto))
      .map((f) => ({
        tipo: 'GASTO' as const,
        id: f.id,
        numero: f.numeroCompleto,
        tercero: f.supplier.nombreFiscal,
        fecha: f.fechaEmision,
        vence: f.fechaVencimiento,
        total: Number(f.totalFactura),
        proforma: false,
        numeroProveedor: f.numeroFacturaProveedor,
      })),
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
  const emitida = f.tipo === 'INGRESO';
  const de = emitida ? 'cobro' : 'pago';
  const quien = emitida ? `a ${f.tercero}` : `de ${f.tercero}`;

  // Emitidas: sus rectificativas cuentan como en el panel de cobros (cobrosClientes).
  const numeroDe = async (id: string) =>
    (await prisma.incomeInvoice.findFirst({ where: { id, companyId: ctx.companyId }, select: { numeroCompleto: true } }))?.numeroCompleto ?? 'sin número';
  if (emitida && f.total < 0 && (f.esRectificativa || f.facturaOriginalId)) {
    // Rectificativa en negativo: no se cobra, abona lo que rectifica. Por sus
    // enlaces (varias facturas, un periodo o una de fuera) o, en las de antes,
    // por facturaOriginalId o la factura de fuera escrita.
    const filas =
      (await prisma.incomeInvoiceRectificada.findMany({
        where: { companyId: ctx.companyId, rectificativaId: f.id },
        include: { original: { select: { numeroCompleto: true } } },
        orderBy: { createdAt: 'asc' },
      })) ?? [];
    const periodo = filas.find((x) => x.periodoDesde && x.periodoHasta);
    const refs: Array<{ numero: string; id: string | null }> = filas.length
      ? filas.filter((x) => !x.periodoDesde).map((x) => ({ numero: x.original?.numeroCompleto ?? x.numeroOriginal ?? 'sin número', id: x.originalId }))
      : f.facturaOriginalId
        ? [{ numero: await numeroDe(f.facturaOriginalId), id: f.facturaOriginalId }]
        : f.rectificaFueraNumero
          ? [{ numero: f.rectificaFueraNumero, id: null }]
          : [];
    if (refs.length || periodo) {
      const lista = (xs: string[]) => (xs.length === 1 ? xs[0] : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`);
      const que = periodo
        ? `las ventas del ${fechaES(periodo.periodoDesde!)} al ${fechaES(periodo.periodoHasta!)} (un rappel)`
        : `${refs.length === 1 ? 'la factura' : 'las facturas'} ${lista(refs.map((r) => r.numero))}`;
      const deLaApp = refs.filter((r) => r.id);
      const efecto = deLaApp.length
        ? `No se cobra: resta de lo pendiente de ${deLaApp.length === 1 ? 'la' : 'las'} ${lista(deLaApp.map((r) => r.numero))} y, si ya estaba cobrada, es un importe que le debes devolver a ${f.tercero}.`
        : `No se cobra ni resta de ninguna factura de la app: si lo que rectifica estaba pendiente de cobro, lo rebaja; si no, es un importe a favor de ${f.tercero}, que le puedes devolver.`;
      return {
        entendido,
        texto: `La factura ${f.numero} es una rectificativa en negativo (un abono) de ${que}, del ${fechaES(f.fecha)}, por ${eur(f.total)}. ${efecto}`,
        permisoRequerido,
        kpis: [{ etiqueta: 'Importe del abono', valor: eur(f.total) }],
        enlaces: [...enlaces, ...deLaApp.slice(0, 3).map((r) => ({ texto: `Abrir la factura ${r.numero}`, href: `/dashboard/facturas/${r.id}` }))],
      };
    }
  }
  // Recibidas: un abono del proveedor (total en negativo) dice qué rectifica, lo que ha restado y lo que queda a tu favor.
  if (!emitida && f.total < 0) return explicarAbono(ctx, f, entendido);

  // Las que la rectifican: por facturaOriginalId (una sola original) y por los
  // enlaces (también un abono de varias facturas, con la parte de esta).
  const directas = emitida
    ? await prisma.incomeInvoice.findMany({
        where: { companyId: ctx.companyId, facturaOriginalId: f.id, ...VENTA_EMITIDA },
        select: { id: true, numeroCompleto: true, tipoRectificativa: true, totalFactura: true, fechaEmision: true },
        orderBy: { fechaEmision: 'desc' },
      })
    : [];
  const porEnlaces = emitida
    ? ((await prisma.incomeInvoiceRectificada.findMany({
        where: { companyId: ctx.companyId, originalId: f.id, rectificativa: VENTA_EMITIDA },
        select: {
          baseRectificada: true,
          cuotaRectificada: true,
          retencionRectificada: true,
          rectificativa: { select: { id: true, numeroCompleto: true, tipoRectificativa: true, totalFactura: true, fechaEmision: true } },
        },
      })) ?? [])
    : [];
  const rectificativas = [
    ...directas.filter((d) => !porEnlaces.some((e) => e.rectificativa.id === d.id)),
    ...porEnlaces.map((e) => ({
      ...e.rectificativa,
      // Por diferencias, la parte de esta factura; por sustitución, la factura corregida.
      totalFactura:
        e.rectificativa.tipoRectificativa !== 'S' && e.baseRectificada !== null
          ? sumar([Number(e.baseRectificada), Number(e.cuotaRectificada ?? 0), -Number(e.retencionRectificada ?? 0)])
          : e.rectificativa.totalFactura,
    })),
  ].sort((a, b) => b.fechaEmision.localeCompare(a.fechaEmision));
  const sustituta = rectificativas.find((x) => x.tipoRectificativa === 'S' && x.id !== f.id);
  if (sustituta) {
    return {
      entendido,
      texto: `La factura ${f.numero} emitida ${quien}, del ${fechaES(f.fecha)}, por ${eur(f.total)}, está sustituida por la rectificativa ${sustituta.numeroCompleto ?? 'sin número'} (por sustitución): ya no cuenta. Lo que se le cobró se descuenta de la nueva; pregunta por la ${sustituta.numeroCompleto ?? 'nueva'} para ver lo pendiente.`,
      permisoRequerido,
      kpis: [{ etiqueta: 'Total (sustituida)', valor: eur(f.total) }],
      enlaces: [...enlaces, { texto: `Abrir la factura ${sustituta.numeroCompleto ?? 'que la sustituye'}`, href: `/dashboard/facturas/${sustituta.id}` }],
    };
  }

  // Todo en moneda de cuenta, como el resto de Carmen y como facturasPorCobrar:
  // listarCobros da totalFactura/importeCobrado/importePendiente en la moneda
  // de la factura y las mismas cifras en la de cuenta en los campos *Cuenta.
  const r = await listarCobros(ctx.companyId, f.tipo, f.id);
  const total = r.totalFacturaCuenta;
  // En una recibida, lo compensado con abonos no es un pago: va aparte, como «abonado».
  const compensado = emitida ? 0 : (r.importeCompensado ?? 0);
  const cobrado = Math.round((r.importeCobradoCuenta - compensado) * 100) / 100;
  let pendiente = r.importePendienteCuenta;
  let abonado = compensado;
  let abonos = rectificativas.filter((x) => Number(x.totalFactura) < 0).map((x) => x.numeroCompleto ?? 'sin número');
  if (emitida) {
    // Lo pendiente, con las mismas reglas que el panel: rectificativas, cobros con fecha futura y cobradas a mano.
    const fila = (await facturasPorCobrar(ctx.companyId, ctx.hoy)).facturas.find((x) => x.id === f.id);
    pendiente = fila?.pendiente ?? 0;
    abonado = fila?.abonado ?? sumar(rectificativas.filter((x) => Number(x.totalFactura) < 0).map((x) => -Number(x.totalFactura)));
  } else if (compensado > 0) {
    // Los abonos aplicados a esta factura (automáticos o a mano), con el número del proveedor.
    const aplicados = await prisma.compensacionGasto.findMany({
      where: { companyId: ctx.companyId, facturaId: f.id, estado: 'ACTIVO' },
      select: { abonoId: true },
    });
    const facturasAbono = await prisma.expenseInvoice.findMany({
      where: { companyId: ctx.companyId, id: { in: [...new Set(aplicados.map((x) => x.abonoId))] } },
      select: { numeroCompleto: true, numeroFacturaProveedor: true },
      orderBy: { numero: 'asc' },
    });
    abonos = facturasAbono.map((x) => x.numeroFacturaProveedor ?? x.numeroCompleto);
  }
  const retraso = diasEntre(f.vence, ctx.hoy);
  let estado: string;
  if (pendiente <= 0) {
    estado = !emitida
      ? abonado > 0 && abonos.length
        ? 'No queda nada pendiente de pago: ' + (abonos.length === 1 ? 'el abono ' + abonos[0] + ' la abona' : 'los abonos ' + abonos.join(', ') + ' la abonan') + (cobrado > 0 ? ' y el resto está pagado.' : '.')
        : 'Está pagada.'
      : abonos.length && cobrado < total ? `No queda nada pendiente de cobro: la rectificativa ${abonos.join(', ')} la abona.` : 'Está cobrada.';
  } else {
    const vencida = retraso > 0 ? ` Venció el ${fechaES(f.vence)} (hace ${plural(retraso, 'día')}).` : ` Vence el ${fechaES(f.vence)}.`;
    const restan = emitida ? 'La rectificativa ' + abonos.join(', ') + ' le resta' : abonos.length === 1 ? 'El abono ' + abonos[0] + ' le resta' : 'Los abonos ' + abonos.join(', ') + ' le restan';
    const conAbono = abonado > 0 && abonos.length ? ' ' + restan + ' ' + eur(abonado) + '.' : '';
    estado = `${cobrado > 0 ? `Lleva ${eur(cobrado)} ${emitida ? 'cobrados' : 'pagados'} y quedan` : 'Quedan'} ${eur(pendiente)} pendientes de ${de}.${conAbono}${vencida}`;
  }
  const sustituye = emitida && f.tipoRectificativa === 'S' && f.facturaOriginalId ? ` Sustituye a la factura ${await numeroDe(f.facturaOriginalId)}.` : '';
  const activos = r.cobros.filter((c) => c.estado === 'ACTIVO');
  // Factura en otra moneda: las cifras del documento van aparte, con su código
  // ISO (no con «€», para que enMonedaDeCuenta no las toque).
  const enDivisa = r.moneda !== r.monedaCuenta;
  const enDoc = (n: number) => eur(n).replace(/ €$/, ` ${r.moneda}`);
  const avisos = enDivisa
    ? [
        `La factura está en ${r.moneda}: ${enDoc(r.totalFactura)}, con ${enDoc(r.importeCobrado)} ${emitida ? 'cobrados' : 'pagados'}` +
          `${abonado > 0 ? '' : ` y ${enDoc(r.importePendiente)} pendientes`}. Las cifras de arriba van en la moneda de la contabilidad, al tipo de cambio de la factura.`,
      ]
    : [];
  return {
    entendido,
    texto: `La factura ${f.numero} ${emitida ? 'emitida' : 'recibida'} ${quien}, del ${fechaES(f.fecha)}, es de ${eur(total)}.${sustituye} ${estado}`,
    permisoRequerido,
    kpis: [
      { etiqueta: 'Total', valor: eur(total), ...(enDivisa ? { detalle: enDoc(r.totalFactura) } : {}) },
      { etiqueta: emitida ? 'Cobrado' : 'Pagado', valor: eur(cobrado), detalle: plural(activos.length, de) },
      ...(abonado > 0 ? [{ etiqueta: emitida ? 'Abonado por rectificativa' : 'Abonado', valor: eur(abonado) }] : []),
      { etiqueta: 'Pendiente', valor: eur(pendiente) },
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
    ...(avisos.length ? { avisos } : {}),
    enlaces,
  };
};

/**
 * Un abono o rectificativa de proveedor con total en negativo: qué rectifica,
 * lo que ha restado de lo pendiente (compensaciones), lo que ha devuelto el
 * proveedor y lo que queda a tu favor. Las cifras son las de su ficha.
 */
async function explicarAbono(ctx: CarmenCtx, f: Encontrada, entendido: string): Promise<RespuestaDatos> {
  const d = await expenseInvoicesService.obtenerPorId(ctx.companyId, f.id);
  const numero = d.numeroFacturaProveedor ?? d.numeroCompleto;
  const total = Number(d.totalFactura);
  const originales = d.rectificativa?.originales ?? [];
  const periodo = d.rectificativa?.periodo;
  const nombre = (o: { numero: string | null; numeroCompleto: string | null }) => o.numero ?? o.numeroCompleto ?? 'sin número';
  const rectifica = originales.length
    ? ` que rectifica ${originales.length === 1 ? 'la' : 'las'} ${originales.map(nombre).join(', ')}`
    : periodo
      ? ` que rectifica las compras del ${fechaES(periodo.desde)} al ${fechaES(periodo.hasta)}`
      : '';
  const activas = d.compensaciones.filter((c) => c.estado === 'ACTIVO');
  const compensado = sumar(activas.map((c) => c.importe));
  const aFavor = d.aFavor ?? 0;
  const devuelto = Math.max(0, Math.round((-total - compensado - aFavor) * 100) / 100);
  const destinos = [...new Set(activas.map((c) => c.otra.numero ?? c.otra.numeroCompleto ?? 'sin número'))];
  const frases = [
    `La ${numero} (registro ${d.numeroCompleto}) es un abono de ${f.tercero}${rectifica}, por ${eur(total)}.`,
    ...(compensado > 0 ? [`Ha restado ${eur(compensado)} de lo pendiente de ${destinos.length === 1 ? 'la' : 'las'} ${destinos.join(', ')}.`] : []),
    ...(devuelto > 0 ? [`El proveedor te ha devuelto ${eur(devuelto)}.`] : []),
    ...(aFavor > 0 ? [`Te quedan ${eur(aFavor)} a tu favor: pide la devolución o aplícalo a otra factura.`] : []),
  ];
  return {
    entendido,
    texto: frases.join(' '),
    permisoRequerido: 'compras:read',
    kpis: [
      { etiqueta: 'Importe del abono', valor: eur(total) },
      ...(compensado > 0 ? [{ etiqueta: 'Restado de facturas', valor: eur(compensado) }] : []),
      ...(devuelto > 0 ? [{ etiqueta: 'Devuelto', valor: eur(devuelto) }] : []),
      { etiqueta: 'A tu favor', valor: eur(aFavor) },
    ],
    enlaces: [
      { texto: `Abrir el abono ${d.numeroCompleto}`, href: `/dashboard/compras/${f.id}` },
      ...originales.filter((o) => o.id).map((o) => ({ texto: `Abrir la factura ${nombre(o)}`, href: `/dashboard/compras/${o.id}` })),
    ],
  };
}

export const EJECUTORES_FACTURACION ={ deudaConProveedores, facturadoEnPeriodo, buscarFactura };
