/**
 * Catálogo de intenciones de datos de Carmen v1 (capa 1, 0 €).
 *
 * Cada intención declara:
 *  - permisos: basta con tener uno (la comprobación fina la hace su ejecutor);
 *  - conceptos: grupos de sinónimos que deben aparecer TODOS (cada grupo con
 *    uno de sus términos; 'xxx*' es un prefijo) y términos que la descartan.
 *    Las señales '__tercero', '__cliente', '__proveedor', '__banco',
 *    '__periodo', '__modelo' y '__numeroFactura' las pone el enrutador cuando
 *    encuentra ese hueco en la pregunta;
 *  - ejemplos: 8-12 frases para el kNN del clasificador (sin nombres propios:
 *    el nombre del tercero se quita del texto antes de clasificar);
 *  - ejecutar: herramienta de SOLO LECTURA con dos salidas, el texto con las
 *    cifras calculadas por la app y los bloques para la pantalla (KPIs, tabla,
 *    enlaces a la pantalla real, descargas y botones). Comprueba el permiso
 *    antes de llamar al servicio de origen.
 */
import type { AreaIntencion } from '../tipos';
import type { RolTercero } from '../terceros';
import { EJECUTORES, type Ejecutor } from './datos';

export type NombreHueco = 'periodo' | 'sentido' | 'tercero' | 'modelo' | 'numeroFactura' | 'importeMinimo' | 'diasMinimos' | 'texto' | 'soloVencidas' | 'foco';

export interface DefHueco {
  nombre: NombreHueco;
  obligatorio: boolean;
  /** Código de periodo por defecto ('este-mes'...). */
  porDefecto?: string;
  /** Para el hueco tercero: qué tipo de tercero. */
  roles?: RolTercero[];
}

export interface Intencion {
  id: string;
  titulo: string;
  /** Pregunta de ejemplo para los botones y el catálogo. */
  pregunta: string;
  area: AreaIntencion;
  permisos: string[];
  requiereNominas?: boolean;
  /** IVA español o modelos de la AEAT: no se ofrece a una empresa no establecida en España. */
  soloEspana?: boolean;
  conceptos: { obligatorios: string[][]; excluyentes?: string[] };
  huecos: DefHueco[];
  /** Prefijos de ruta donde se sugiere (y donde suma 0,10 al clasificar). */
  paginas?: string[];
  ejemplos: string[];
  ejecutar: Ejecutor;
}

const BANCOS = ['sabadell', 'santander', 'bbva', 'caixabank', 'caixa', 'bankinter', 'ing', 'unicaja', 'kutxabank', 'abanca', 'ibercaja', 'cajamar', 'openbank', 'laboral', 'rural', 'evo', 'triodos', 'deutsche', 'banca march', 'cajasur', 'liberbank'];

export const INTENCIONES: Intencion[] = [
  {
    id: 'INT-01',
    titulo: 'Lo que te debe un cliente',
    pregunta: '¿Cuánto me debe un cliente?',
    area: 'cobros',
    permisos: ['ventas:read', 'contabilidad:read'],
    conceptos: {
      obligatorios: [['__cliente'], ['debe', 'deben', 'me debe', 'nos debe', 'adeuda', 'pendiente*', 'pagado', 'ha pagado', 'pago*', 'cobr*', 'deuda*', 'factura*', 'saldo']],
      excluyentes: ['le debo', 'debo', 'tengo que pagar'],
    },
    huecos: [{ nombre: 'tercero', obligatorio: true, roles: ['cliente'] }],
    paginas: ['/dashboard/clientes', '/dashboard/facturas'],
    ejemplos: [
      'cuanto me debe',
      'lo que me debe',
      'me ha pagado ya',
      'que facturas tiene pendientes el cliente',
      'deuda del cliente',
      'cuanto nos debe el cliente',
      'tiene algo pendiente de pago',
      'ha pagado ya la factura',
      'saldo pendiente del cliente',
      'me debe algo',
    ],
    ejecutar: EJECUTORES.deudaDeCliente,
  },
  {
    id: 'INT-02',
    titulo: 'Pendiente de cobro',
    pregunta: '¿Quién me debe dinero?',
    area: 'cobros',
    permisos: ['ventas:read', 'contabilidad:read'],
    conceptos: {
      obligatorios: [['debe', 'deben', 'me debe', 'me deben', 'por cobrar', 'pendiente de cobro', 'pendientes de cobro', 'sin cobrar', 'cobros pendientes', 'deudores', 'cobrar', 'debiendo']],
      excluyentes: ['__tercero', 'vencid*', 'moroso*', 'retraso*', 'atrasad*', 'debo', 'le debo', 'proveedor*', 'pagar', 'como', 'que es', 'saldo contable', 'iva', 'irpf', 'retencion*', 'impuesto*', 'intracomunitari*', 'extranjero'],
    },
    huecos: [],
    paginas: ['/dashboard/facturas', '/dashboard/clientes', '/dashboard'],
    ejemplos: [
      'quien me debe dinero',
      'cuanto tengo por cobrar',
      'facturas pendientes de cobro',
      'que me deben los clientes',
      'cuanto me deben en total',
      'listado de facturas sin cobrar',
      'que facturas tengo por cobrar',
      'cobros pendientes',
      'cuanto dinero me deben',
      'quienes son mis deudores',
    ],
    ejecutar: EJECUTORES.pendienteDeCobro,
  },
  {
    id: 'INT-03',
    titulo: 'Facturas vencidas y morosos',
    pregunta: '¿Qué facturas están vencidas?',
    area: 'cobros',
    permisos: ['ventas:read', 'contabilidad:read'],
    conceptos: {
      obligatorios: [['vencid*', 'moroso*', 'retraso*', 'atrasad*', 'impagad*', 'no me han pagado', 'no han pagado', 'sin pagar']],
      excluyentes: ['__tercero', '__proveedor', 'proveedor*', 'compra*', 'gasto*', 'debo', 'le debo', 'asiento*', 'impuesto*', 'modelo*', 'hacienda', 'plazo*', 'iva'],
    },
    huecos: [{ nombre: 'diasMinimos', obligatorio: false }],
    paginas: ['/dashboard/facturas', '/dashboard/clientes'],
    ejemplos: [
      'que facturas estan vencidas',
      'morosos',
      'facturas con mas de 60 dias de retraso',
      'clientes que no me han pagado',
      'facturas vencidas sin cobrar',
      'quien va atrasado en los pagos',
      'facturas impagadas',
      'cuanto tengo vencido',
      'listado de morosos',
      'facturas de clientes sin pagar',
    ],
    ejecutar: EJECUTORES.facturasVencidas,
  },
  {
    id: 'INT-05',
    titulo: 'Cobrado o pagado en un periodo',
    pregunta: '¿Cuánto he cobrado este mes?',
    area: 'cobros',
    permisos: ['ventas:read', 'compras:read', 'contabilidad:read'],
    conceptos: {
      obligatorios: [
        ['cobrado', 'cobrados', 'cobros', 'he cobrado', 'hemos cobrado', 'cobre', 'cobramos', 'ingresado', 'me han pagado', 'pagado', 'he pagado', 'hemos pagado', 'pague', 'pagamos', 'pagos'],
        ['__periodo', 'cuanto', 'total', 'cuantos', 'cuantas'],
      ],
      excluyentes: ['pendiente*', 'por cobrar', 'por pagar', 'debe', 'deben', 'debo', 'vencid*', '__tercero', 'tengo que pagar', 'proximo*', 'banco*', 'movimiento*', 'como', 'iva', 'impuesto*'],
    },
    huecos: [
      { nombre: 'periodo', obligatorio: false, porDefecto: 'este-mes' },
      { nombre: 'sentido', obligatorio: false },
      // «¿Cuánto he cobrado de X este mes?» (el enrutador la elige con un periodo y el verbo en pasado).
      { nombre: 'tercero', obligatorio: false, roles: ['cliente', 'proveedor'] },
    ],
    paginas: ['/dashboard/facturas', '/dashboard/compras', '/dashboard/tesoreria'],
    ejemplos: [
      'cuanto he cobrado este mes',
      'cobros del trimestre',
      'cuanto he pagado en septiembre',
      'total cobrado este año',
      'cuanto hemos cobrado el mes pasado',
      'pagos de este mes',
      'cuanto he pagado a proveedores este trimestre',
      'que he cobrado esta semana',
      'cobros de octubre',
      'total pagado el año pasado',
    ],
    ejecutar: EJECUTORES.cobradoEnPeriodo,
  },
  {
    id: 'INT-06',
    titulo: 'Lo que debes a proveedores',
    pregunta: '¿Qué tengo que pagar esta semana?',
    area: 'pagos',
    permisos: ['compras:read', 'contabilidad:read'],
    conceptos: {
      obligatorios: [
        ['debo', 'le debo', 'les debo', 'deber', 'por pagar', 'sin pagar', 'pendiente*', 'vencid*', 'tengo que pagar', 'toca pagar', 'hay que pagar', 'proximos pagos', 'adeud*', 'deuda*'],
        ['proveedor*', 'acreedor*', 'pagar', 'pago*', 'le debo', 'les debo', '__proveedor', 'compra', 'compras', 'facturas de compra', 'factura de compra'],
      ],
      excluyentes: ['cobr*', 'me debe', 'me deben', 'impuesto*', 'iva', 'hacienda', 'modelo*', 'asiento*', 'seguridad social', 'nomina*', '__soloCliente'],
    },
    huecos: [
      { nombre: 'tercero', obligatorio: false, roles: ['proveedor'] },
      { nombre: 'periodo', obligatorio: false },
      { nombre: 'soloVencidas', obligatorio: false },
    ],
    paginas: ['/dashboard/compras', '/dashboard/proveedores'],
    ejemplos: [
      'que le debo',
      'que tengo que pagar esta semana',
      'facturas de proveedores vencidas',
      'cuanto debo a proveedores',
      'pagos pendientes',
      'proximos pagos a proveedores',
      'facturas de compra sin pagar',
      'que facturas tengo por pagar',
      'cuanto le debo al proveedor',
      'deudas con proveedores',
    ],
    ejecutar: EJECUTORES.deudaConProveedores,
  },
  {
    id: 'INT-09',
    titulo: 'Facturado y gastado en un periodo',
    pregunta: '¿Cuánto he facturado este trimestre?',
    area: 'facturacion',
    permisos: ['ventas:read', 'compras:read', 'contabilidad:read'],
    conceptos: {
      obligatorios: [
        ['factur*', 'ventas', 'vendido', 'he vendido', 'vendi', 'vendimos', 'ingresos', 'gastado', 'gastos', 'he gastado', 'gaste', 'gastamos', 'compras', 'comprado', 'compre', 'compramos'],
        ['__periodo', 'cuanto', 'total', 'llevo', 'resumen', 'comparado', 'volumen', 'cuantas'],
      ],
      excluyentes: ['pendiente*', 'por cobrar', 'vencid*', 'cobrado', 'pagado', 'beneficio*', 'iva', '__numeroFactura', 'como', 'donde', 'crear', 'hacer', 'emitir', 'debe', 'deben', 'impuesto*', 'deducible*', 'deduci*', 'desgrava*', 'que es'],
    },
    huecos: [
      { nombre: 'periodo', obligatorio: false, porDefecto: 'este-trimestre' },
      { nombre: 'foco', obligatorio: false },
      // «¿Cuánto le he facturado a X?»: solo las facturas de ese cliente (o de ese proveedor).
      { nombre: 'tercero', obligatorio: false, roles: ['cliente', 'proveedor'] },
    ],
    paginas: ['/dashboard/facturas', '/dashboard/compras', '/dashboard'],
    ejemplos: [
      'cuanto he facturado este trimestre',
      'ventas de septiembre',
      'cuanto he gastado este año',
      'total facturado el año pasado',
      'cuanto llevo facturado',
      'gastos del mes',
      'facturacion de este año comparada con el anterior',
      'cuanto hemos vendido este mes',
      'total de compras del trimestre',
      'volumen de facturacion',
    ],
    ejecutar: EJECUTORES.facturadoEnPeriodo,
  },
  {
    id: 'INT-13',
    titulo: 'Buscar una factura',
    pregunta: '¿Está cobrada la factura A-12?',
    area: 'facturacion',
    permisos: ['ventas:read', 'compras:read'],
    conceptos: {
      obligatorios: [['__numeroFactura'], ['factura', 'busca*', 'cobrada', 'pagada', 'estado', 'encuentra', 'donde esta', 'esta', 'numero']],
    },
    huecos: [{ nombre: 'numeroFactura', obligatorio: true }],
    paginas: ['/dashboard/facturas', '/dashboard/compras'],
    ejemplos: [
      'busca la factura',
      'esta cobrada la factura',
      'estado de la factura numero',
      'donde esta la factura',
      'encuentra la factura',
      'se ha pagado la factura',
      'esta pagada la factura',
      'buscar factura por numero',
    ],
    ejecutar: EJECUTORES.buscarFactura,
  },
  {
    id: 'INT-18',
    titulo: 'Beneficio y cuenta de resultados',
    pregunta: '¿Voy en beneficios este año?',
    area: 'contabilidad',
    permisos: ['contabilidad:read'],
    conceptos: {
      obligatorios: [['beneficio*', 'gano', 'gane', 'ganamos', 'gana', 'ganado', 'ganando', 'ganancia*', 'perdidas y ganancias', 'perdidas', 'resultado*', 'rentabl*', 'cuenta de resultados', 'margen']],
      excluyentes: ['donde', 'que es', 'descargar', 'como se', 'como saco', 'impuesto*', 'iva', '__modelo'],
    },
    huecos: [{ nombre: 'periodo', obligatorio: false, porDefecto: 'este-anio' }],
    paginas: ['/dashboard/informes'],
    ejemplos: [
      'cuanto gano este año',
      'voy en beneficios',
      'pyg de 2025',
      'cuenta de perdidas y ganancias de este año',
      'resultado del ejercicio',
      'estoy ganando o perdiendo dinero',
      'beneficio del trimestre',
      'que margen tengo',
      'cuanto he ganado el año pasado',
      'tengo perdidas',
    ],
    ejecutar: EJECUTORES.cuentaDeResultados,
  },
  {
    id: 'INT-23',
    titulo: 'Asientos sin aprobar',
    pregunta: '¿Tengo asientos sin aprobar?',
    area: 'contabilidad',
    permisos: ['contabilidad:read'],
    conceptos: {
      obligatorios: [['asiento*'], ['pendiente*', 'sin contabilizar', 'sin aprobar', 'por aprobar', 'por revisar', 'revisar', 'borrador*', 'sin revisar', 'cuantos', 'hay', 'tengo', 'quedan']],
      excluyentes: ['como apruebo', 'como se aprueba', 'que significa', 'que es', 'donde se', 'estados', 'que asiento'],
    },
    huecos: [],
    paginas: ['/dashboard/motor-contable', '/dashboard/informes'],
    ejemplos: [
      'tengo asientos sin contabilizar',
      'asientos por revisar',
      'cuantos asientos pendientes hay',
      'asientos en borrador',
      'quedan asientos por aprobar',
      'asientos pendientes de revision',
      'hay asientos sin aprobar',
      'tengo algo pendiente en el motor contable',
    ],
    ejecutar: EJECUTORES.asientosPendientes,
  },
  {
    id: 'INT-24',
    titulo: 'Saldo de los bancos',
    pregunta: '¿Cuánto dinero tengo en el banco?',
    area: 'tesoreria',
    permisos: ['tesoreria:read'],
    conceptos: {
      obligatorios: [
        ['saldo*', 'dinero', 'cuanto tengo', 'liquidez', 'tesoreria', 'cuanto hay', 'acabada en', 'termina en', 'acaba en'],
        ['banco*', 'bancari*', 'cuenta*', 'caja', '__banco', ...BANCOS],
      ],
      excluyentes: ['movimiento*', 'cargo*', 'entrado', 'extracto*', 'cliente*', 'proveedor*', '__cliente', '__proveedor', 'debe', 'deben', 'como', 'importar', 'mayor'],
    },
    huecos: [{ nombre: 'tercero', obligatorio: false, roles: ['banco'] }],
    paginas: ['/dashboard/tesoreria'],
    ejemplos: [
      'cuanto dinero tengo en el banco',
      'saldo del banco',
      'saldo de la cuenta acabada en',
      'cuanto hay en las cuentas',
      'saldo de bancos',
      'que saldo tengo',
      'dinero disponible en el banco',
      'cuanto tengo en la cuenta',
      'liquidez de la empresa',
      'saldo actual de las cuentas bancarias',
    ],
    ejecutar: EJECUTORES.saldoBancos,
  },
  {
    id: 'INT-25',
    titulo: 'Últimos movimientos del banco',
    pregunta: '¿Qué ha entrado hoy en el banco?',
    area: 'tesoreria',
    permisos: ['tesoreria:read'],
    conceptos: {
      obligatorios: [['movimiento*', 'cargos', 'cargo', 'cargado', 'cargados', 'han cargado', 'ha entrado', 'han entrado', 'entrado', 'ha salido', 'salido', 'apuntes del banco', 'transferencia*', 'recibos', 'recibo']],
      excluyentes: ['asiento*', 'como', 'importar', 'subir', 'categoria*', 'concilia*', 'que es'],
    },
    huecos: [
      { nombre: 'periodo', obligatorio: false },
      { nombre: 'sentido', obligatorio: false },
      { nombre: 'importeMinimo', obligatorio: false },
      { nombre: 'texto', obligatorio: false },
    ],
    paginas: ['/dashboard/tesoreria'],
    ejemplos: [
      'ultimos movimientos',
      'que ha entrado hoy',
      'cargos de',
      'movimientos de mas de 1000 euros',
      'que ha salido del banco esta semana',
      'ultimos cargos del banco',
      'movimientos del banco de este mes',
      'transferencias recibidas',
      'recibos cargados este mes',
      'que movimientos hay en la cuenta',
    ],
    ejecutar: EJECUTORES.ultimosMovimientos,
  },
  {
    id: 'INT-28',
    titulo: 'IVA del trimestre (modelo 303)',
    pregunta: '¿Cuánto IVA pago este trimestre?',
    area: 'impuestos',
    permisos: ['impuestos:read'],
    soloEspana: true,
    conceptos: {
      obligatorios: [
        ['iva', '303', 'a devolver', 'sale a pagar'],
        ['cuanto', 'pagar', 'pago', 'sale', 'devolver', 'resultado', 'toca', 'liquidacion', '__periodo', '__modelo', 'salir'],
      ],
      excluyentes: ['cuando', 'plazo*', 'vence', 'fecha limite', 'tipo*', 'que es', 'como', 'donde', 'repercutido', 'soportado', 'recargo*', 'intracomunitari*', 'deduci*', 'deducible*', 'desgrava*', 'aplaz*', 'fraccion*', 'tarde', 'fuera de plazo', 'pongo', 'cliente*', 'coche', 'para que sirve'],
    },
    huecos: [{ nombre: 'periodo', obligatorio: false, porDefecto: 'trimestre-pasado' }],
    paginas: ['/dashboard/fiscal'],
    ejemplos: [
      'cuanto iva pago este trimestre',
      'el 303 del tercer trimestre',
      'me sale a devolver',
      'cuanto me sale el iva',
      'resultado del 303',
      'iva a pagar del trimestre',
      'cuanto tengo que pagar de iva',
      'liquidacion del iva',
      'cuanto iva me toca pagar',
      'iva del trimestre pasado',
    ],
    ejecutar: EJECUTORES.ivaDelTrimestre,
  },
  {
    id: 'INT-30',
    titulo: 'Próximos impuestos y plazos',
    pregunta: '¿Qué impuestos tengo que presentar?',
    area: 'impuestos',
    permisos: [],
    soloEspana: true,
    conceptos: {
      obligatorios: [
        ['impuesto*', 'modelos', 'presentar', 'declaracion*', 'hacienda', 'obligaciones fiscales', 'caducado*', 'plazos', 'calendario fiscal'],
        ['tengo que', 'toca', 'tocan', 'proximo*', 'pendiente*', 'caducad*', 'vencid*', 'cuales', 'que impuestos', 'que modelos', 'que declaraciones', 'que tengo', 'hay que', 'este mes', 'este trimestre', '__periodo', 'algo'],
      ],
      excluyentes: ['iva', '303', 'cuanto', 'que es', 'como se', 'como presento', 'como', 'tipo', 'tipos', 'tributa*', 'aplaz*', 'fraccion*', 'recargo*', 'tarde', 'fuera de plazo', 'prescri*', 'para que sirve', 'deduc*', 'sociedades'],
    },
    huecos: [],
    paginas: ['/dashboard/fiscal'],
    ejemplos: [
      'que impuestos tengo que presentar',
      'tengo algo caducado',
      'proximos impuestos',
      'que declaraciones me tocan este trimestre',
      'que tengo pendiente con hacienda',
      'que modelos hay que presentar este mes',
      'calendario fiscal',
      'proximos plazos de hacienda',
    ],
    ejecutar: EJECUTORES.proximosImpuestos,
  },
  {
    id: 'INT-39',
    titulo: 'Resumen de la empresa',
    pregunta: 'Dame un resumen de cómo va la empresa',
    area: 'resumen',
    permisos: [],
    conceptos: {
      obligatorios: [['resumen', 'como va', 'como vamos', 'como van', 'que tal va', 'que tal vamos', 'como estamos', 'que tengo hoy', 'que hay hoy', 'situacion', 'como esta la empresa', 'novedades', 'que hay de nuevo']],
      excluyentes: ['ventas', 'gastos', 'iva', 'cobros', 'pagos', 'factur*', 'banco*', 'asiento*', 'impuesto*', 'modelo*', 'anual', 'fiscal'],
    },
    huecos: [],
    paginas: ['/dashboard'],
    ejemplos: [
      'dame un resumen',
      'que tengo hoy',
      'buenos dias que tengo para hoy',
      'como va la empresa',
      'como vamos',
      'resumen de la situacion',
      'novedades de hoy',
      'como esta la empresa',
      'que hay de nuevo',
    ],
    ejecutar: EJECUTORES.resumenEmpresa,
  },
];

export function intencionPorId(id: string): Intencion | undefined {
  return INTENCIONES.find((i) => i.id === id);
}
