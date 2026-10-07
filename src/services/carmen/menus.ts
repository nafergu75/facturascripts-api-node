/**
 * Mapa de menús de la app, sacado de frontend/web/components/dashboard/nav.ts
 * (solo las entradas con página propia en frontend/web/app/dashboard; «Lector de
 * facturas» aún es una página genérica y se deja fuera). Lo usan las
 * respuestas («eso se hace en Ventas → Facturas de ingreso»), las fichas de uso
 * de la app y el system prompt de la IA. Si cambia el menú del frontend, hay que
 * cambiarlo aquí.
 */
export interface PantallaApp {
  /** Ruta de menú tal como la ve el usuario. */
  ruta: string;
  href: string;
  descripcion: string;
}

export const PANTALLAS: PantallaApp[] = [
  { ruta: 'Panel → Resumen', href: '/dashboard', descripcion: 'Indicadores, evolución mensual y últimos movimientos.' },
  { ruta: 'Ventas → Clientes', href: '/dashboard/clientes', descripcion: 'Alta, edición y búsqueda de clientes.' },
  { ruta: 'Ventas → Productos', href: '/dashboard/productos', descripcion: 'Catálogo de productos y servicios.' },
  { ruta: 'Ventas → Facturas de ingreso', href: '/dashboard/facturas', descripcion: 'Emitir facturas, rectificativas, envío por email, cobros y recurrencias.' },
  { ruta: 'Ventas → Proformas', href: '/dashboard/proformas', descripcion: 'Proformas (serie P): no se contabilizan y se pasan a factura si el cliente acepta.' },
  { ruta: 'Compras → Proveedores', href: '/dashboard/proveedores', descripcion: 'Proveedores y sus datos fiscales.' },
  { ruta: 'Compras → Compras', href: '/dashboard/compras', descripcion: 'Facturas recibidas y gastos de proveedor, con sus pagos.' },
  { ruta: 'Contabilidad → Movimientos', href: '/dashboard/movimientos', descripcion: 'Ingresos y gastos con estados y estadísticas.' },
  { ruta: 'Contabilidad → Plan contable', href: '/dashboard/plan-contable', descripcion: 'Cuentas y subcuentas del PGC de la empresa.' },
  { ruta: 'Contabilidad → Motor contable', href: '/dashboard/motor-contable', descripcion: 'Asientos generados desde las facturas; aquí se revisan y se aprueban.' },
  { ruta: 'Contabilidad → Informes contables', href: '/dashboard/informes', descripcion: 'Balance, pérdidas y ganancias, sumas y saldos, mayor y diario, en PDF o Excel.' },
  { ruta: 'Contabilidad → Mayor de clientes y proveedores', href: '/dashboard/mayor-terceros', descripcion: 'Saldo contable de cada cliente y proveedor con su detalle.' },
  { ruta: 'Contabilidad → Puesta en marcha', href: '/dashboard/contabilidad/puesta-en-marcha', descripcion: 'Importar el balance de apertura, el diario del año y saldos anteriores.' },
  { ruta: 'Contabilidad → Cierre y traspaso de saldos', href: '/dashboard/contabilidad/cierre-ejercicio', descripcion: 'Regularización, cierre del ejercicio y apertura del siguiente.' },
  { ruta: 'Contabilidad → Archivo de cierres', href: '/dashboard/cierre-contable', descripcion: 'Estado y documentos de los cierres de cada ejercicio.' },
  { ruta: 'Tesorería → Resumen', href: '/dashboard/tesoreria', descripcion: 'Posición de tesorería.' },
  { ruta: 'Tesorería → Cuentas bancarias', href: '/dashboard/tesoreria/cuentas', descripcion: 'Cuentas bancarias de la empresa y su saldo.' },
  { ruta: 'Tesorería → Cobros y pagos', href: '/dashboard/tesoreria/movimientos', descripcion: 'Movimientos del banco con su categoría.' },
  { ruta: 'Tesorería → Categorías', href: '/dashboard/tesoreria/categorias', descripcion: 'Categorías de cobros y pagos.' },
  { ruta: 'Tesorería → Extractos', href: '/dashboard/tesoreria/extractos', descripcion: 'Importar extractos bancarios (CSV, Norma 43).' },
  { ruta: 'Tesorería → Conciliación', href: '/dashboard/tesoreria/conciliacion', descripcion: 'Cruzar movimientos del banco con facturas.' },
  { ruta: 'Fiscalidad → Modelos Fiscales', href: '/dashboard/fiscal', descripcion: 'Declaraciones de IVA, retenciones e Impuesto sobre Sociedades.' },
  { ruta: 'Fiscalidad → Modelos Fiscales → Estado Fiscal', href: '/dashboard/fiscal/estado', descripcion: 'Modelos y próximos vencimientos.' },
  { ruta: 'Fiscalidad → Modelos Fiscales → Modelo 303', href: '/dashboard/fiscal/modelo-303', descripcion: 'IVA trimestral.' },
  { ruta: 'Fiscalidad → Modelos Fiscales → Modelo 111', href: '/dashboard/fiscal/modelo-111', descripcion: 'Retenciones de trabajo y profesionales.' },
  { ruta: 'Fiscalidad → Modelos Fiscales → Modelo 115', href: '/dashboard/fiscal/modelo-115', descripcion: 'Retenciones de alquileres.' },
  { ruta: 'Fiscalidad → Modelos Fiscales → Modelo 200', href: '/dashboard/fiscal/modelo-200', descripcion: 'Impuesto sobre Sociedades.' },
  { ruta: 'Fiscalidad → Modelos Fiscales → Modelo 347', href: '/dashboard/fiscal/modelo-347', descripcion: 'Operaciones con terceros.' },
  { ruta: 'Fiscalidad → Modelos Fiscales → Modelo 390', href: '/dashboard/fiscal/modelo-390', descripcion: 'Resumen anual de IVA.' },
  { ruta: 'Fiscalidad → Modelos Fiscales → Modelo 190', href: '/dashboard/fiscal/modelo-190', descripcion: 'Resumen anual de retenciones.' },
  { ruta: 'Fiscalidad → Registro Mercantil', href: '/dashboard/registro-mercantil', descripcion: 'Libros oficiales y cuentas anuales para depositar.' },
  { ruta: 'Más → Datos de la empresa', href: '/dashboard/empresa', descripcion: 'Datos fiscales, contacto y logo de las facturas.' },
  { ruta: 'Más → Archivo', href: '/dashboard/archivo', descripcion: 'Documentos y archivos de la empresa.' },
];

/** Prefijos de rutas con identificador que también existen (/dashboard/facturas/{id}...). */
const PREFIJOS_CON_ID = ['/dashboard/facturas/', '/dashboard/compras/', '/dashboard/clientes/', '/dashboard/proveedores/', '/dashboard/motor-contable/', '/dashboard/proformas/'];

/** Un enlace de una respuesta apunta a una pantalla que existe. */
export function hrefValido(href: string): boolean {
  const ruta = href.split(/[?#]/)[0];
  if (PANTALLAS.some((p) => p.href === ruta)) return true;
  if (ruta === '/dashboard/informes/pyg' || ruta === '/dashboard/informes/balance') return true;
  return PREFIJOS_CON_ID.some((p) => ruta.startsWith(p) && /^[A-Za-z0-9_-]+$/.test(ruta.slice(p.length)));
}

export function pantalla(href: string): PantallaApp {
  const p = PANTALLAS.find((x) => x.href === href);
  if (!p) throw new Error(`Pantalla desconocida: ${href}`);
  return p;
}

/** Texto del mapa de menús para el system prompt. */
export function mapaDeMenus(): string {
  return PANTALLAS.map((p) => `- ${p.ruta}: ${p.descripcion}`).join('\n');
}
