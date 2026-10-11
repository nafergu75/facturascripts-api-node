/**
 * INT-07: saldo contable de un cliente o proveedor (capa 1, sin IA).
 *
 * Sale de los asientos aprobados de su subcuenta propia (430N; 400N y 410N),
 * con el mismo calculo que el Mayor de clientes y proveedores
 * (informeDetalleTercero). Solo con contabilidad:read: el saldo contable y los
 * movimientos son datos de contabilidad. SOLO LECTURA.
 */
import { informeDetalleTercero } from '../../informesContables.service';
import type { ColumnaInforme } from '../../informesContables.documentos';
import { tiene } from '../contexto';
import { botonIntencion, eur, fechaES, plural, tabla } from '../plantillas';
import { indiceTerceros } from '../terceros';
import type { CarmenCtx, HuecosResueltos, RespuestaDatos } from '../tipos';

type Ejecutor = (ctx: CarmenCtx, h: HuecosResueltos) => Promise<RespuestaDatos>;

const COLS_MOVIMIENTOS: ColumnaInforme[] = [
  { titulo: 'Fecha', tipo: 'fecha', ancho: 2 },
  { titulo: 'Asiento', tipo: 'codigo', ancho: 2.5 },
  { titulo: 'Concepto', tipo: 'texto', ancho: 6 },
  { titulo: 'Debe', tipo: 'importe', ancho: 2 },
  { titulo: 'Haber', tipo: 'importe', ancho: 2 },
  { titulo: 'Saldo', tipo: 'importe', ancho: 2 },
];

const CRITERIO = 'Sale de los asientos aprobados de su subcuenta; los borradores no cuentan.';

/** Frase del saldo con el signo natural: el cliente nos debe; al proveedor le debemos. */
function fraseSaldo(rol: 'cliente' | 'proveedor', nombre: string, saldo: number, fecha: string): string {
  if (saldo === 0) return `${nombre} está a cero en la contabilidad a ${fecha}.`;
  if (rol === 'cliente') {
    return saldo > 0
      ? `Según la contabilidad, ${nombre} te debe ${eur(saldo)} a ${fecha}.`
      : `Según la contabilidad, ${nombre} tiene ${eur(-saldo)} a su favor a ${fecha} (anticipos o cobros de más).`;
  }
  return saldo > 0
    ? `Según la contabilidad, le debes ${eur(saldo)} a ${nombre} a ${fecha}.`
    : `Según la contabilidad, tienes ${eur(-saldo)} a tu favor con ${nombre} a ${fecha} (anticipos o pagos de más).`;
}

export const saldoContableTercero: Ejecutor = async (ctx, h) => {
  if (!tiene(ctx, 'contabilidad:read')) return { sinPermiso: true, area: 'contabilidad' };
  const t = (await indiceTerceros(ctx.companyId)).find(
    (x) => (x.rol === 'cliente' || x.rol === 'proveedor') && x.id === h.terceroId && (!h.rol || h.rol === x.rol),
  );
  if (!t || t.rol === 'banco') {
    return {
      entendido: 'Saldo contable de un cliente o proveedor',
      texto: 'No encuentro ese cliente o proveedor en esta empresa.',
      sinCifras: true,
      enlaces: [{ texto: 'Ver el mayor de clientes y proveedores', href: '/dashboard/mayor-terceros' }],
    };
  }
  const rol = t.rol;
  const anio = Number(ctx.hoy.slice(0, 4));
  const r = await informeDetalleTercero(ctx.companyId, rol === 'cliente' ? 'clientes' : 'proveedores', { desde: `${anio}-01-01`, hasta: ctx.hoy, ejercicio: anio }, t.id);
  const ter = r.tercero as typeof r.tercero & { subcuentas?: string[] };
  const subcuentas = ter.subcuentas?.length ? ter.subcuentas : ter.cuentas;
  const hoy = fechaES(ctx.hoy);
  const entendido = `Saldo contable de ${t.nombre} a ${hoy}`;
  const enlaces = [
    ...(subcuentas.length ? [{ texto: 'Ver el mayor de su subcuenta', href: `/dashboard/informes?tipo=mayor&tercero=${t.id}&tipoTercero=${rol}` }] : []),
    { texto: rol === 'cliente' ? 'Ver en el mayor de clientes' : 'Ver en el mayor de proveedores', href: `/dashboard/mayor-terceros?tipo=${rol}&tercero=${t.id}` },
  ];
  if (!subcuentas.length) {
    return {
      entendido,
      texto: `${t.nombre} aún no tiene subcuenta contable ni movimientos en la contabilidad. ${CRITERIO}`,
      permisoRequerido: 'contabilidad:read',
      enlaces,
    };
  }
  const saldo = ter.saldoFinal;
  const consulta = `ejercicio=${anio}&hasta=${ctx.hoy}&tercero=${t.id}&tipoTercero=${rol}`;
  const textoSubcuenta = `${subcuentas.length > 1 ? 'Subcuentas' : 'Subcuenta'} ${subcuentas.join(' y ')}`;
  const movimientos = ter.movimientos.slice(-10).map((m) => ({ celdas: [m.fecha, m.asiento, m.concepto, m.debe, m.haber, m.saldo] }));
  return {
    entendido,
    texto: `${fraseSaldo(rol, t.nombre, saldo, hoy)} ${textoSubcuenta}. ${CRITERIO}`,
    permisoRequerido: 'contabilidad:read',
    kpis: [
      { etiqueta: 'Saldo contable', valor: eur(saldo), detalle: subcuentas.join(' · ') },
      {
        etiqueta: 'Pendiente según facturas',
        valor: eur(r.totalPendiente),
        detalle: plural(r.facturasPendientes.length, 'factura'),
      },
    ],
    ...(movimientos.length
      ? { tabla: tabla(`Últimos movimientos de ${t.nombre}`, `Del 01/01/${anio} al ${hoy}`, COLS_MOVIMIENTOS, movimientos) }
      : {}),
    enlaces,
    descargas: [
      { texto: 'Descargar su mayor en PDF', ruta: `/informes-contables/mayor?${consulta}&formato=pdf`, formato: 'pdf' as const },
      { texto: 'Descargar su mayor en Excel', ruta: `/informes-contables/mayor?${consulta}&formato=xlsx`, formato: 'xlsx' as const },
    ],
    botones:
      rol === 'cliente'
        ? [botonIntencion('Sus facturas pendientes de cobro', 'INT-01', { terceroId: t.id, rol })]
        : [botonIntencion('Sus facturas pendientes de pago', 'INT-06', { terceroId: t.id, rol })],
  };
};
