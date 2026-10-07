/**
 * Fichas de preguntas frecuentes de Carmen (capa 2, sin IA y sin coste).
 *
 * Reglas:
 *  - Solo se sirven las fichas con verificada:true, vigentes hoy y con
 *    revisarAntes posterior a hoy (un test falla si alguna caduca).
 *  - Cada ficha nueva o cambiada entra por commit y la aprueban Ignacio o su
 *    asesor. Se revisan cada año (revisarAntes).
 *  - Respuestas de 120 palabras como máximo, en llano y sin emojis.
 *
 * Bloques de esta primera tanda: uso de la app (rutas sacadas de nav.ts) y
 * conceptos contables (PGC de pymes). Las fichas fiscales verificadas
 * (IVA, IRPF, Sociedades, facturación) se añaden en la siguiente entrega. Los
 * plazos de los modelos no van en fichas: los calcula faq/calendario.ts.
 */
export type BloqueFAQ = 'app' | 'contabilidad' | 'iva' | 'irpf' | 'sociedades' | 'facturacion';

export interface FichaFAQ {
  id: string;
  bloque: BloqueFAQ;
  pregunta: string;
  /** 5-8 paráfrasis, con faltas típicas. */
  variantes: string[];
  respuesta: string;
  fuente: { titulo: string; url: string };
  verificada: boolean;
  verificadaEl: string;
  vigenteDesde?: string;
  vigenteHasta?: string;
  revisarAntes: string;
  enlaceApp?: { texto: string; href: string };
  intencionRelacionada?: string;
  etiquetas: string[];
}

const APP = (href: string, pantalla: string) => ({ titulo: `Conta API, pantalla ${pantalla}`, url: href });
const PGC = { titulo: 'Plan General de Contabilidad de Pymes (RD 1515/2007, BOE)', url: 'https://www.boe.es/buscar/act.php?id=BOE-A-2007-19966' };
const VERIFICADA = { verificada: true, verificadaEl: '2026-10-07', revisarAntes: '2027-10-07' } as const;

export const FICHAS: FichaFAQ[] = [
  // ---------------- Uso de la app ----------------
  {
    id: 'app-factura-nueva',
    bloque: 'app',
    pregunta: '¿Cómo hago una factura?',
    variantes: ['como creo una factura', 'hacer una factura nueva', 'emitir factura a un cliente', 'donde se hacen las facturas', 'quiero facturar', 'como factura un servicio', 'crear fra'],
    respuesta:
      'Entra en Ventas → Facturas de ingreso y pulsa «Nueva factura». Elige el cliente (si no existe, dalo de alta antes en Ventas → Clientes), añade las líneas con su precio y su IVA y emítela. Al emitirla, la app crea su asiento contable; lo revisas y lo apruebas en Contabilidad → Motor contable. Si el cliente aún no ha aceptado el presupuesto, usa Ventas → Proformas: no se contabilizan.',
    fuente: APP('/dashboard/facturas', 'Facturas de ingreso'),
    ...VERIFICADA,
    enlaceApp: { texto: 'Ir a Facturas de ingreso', href: '/dashboard/facturas' },
    etiquetas: ['factura', 'emitir', 'venta', 'crear'],
  },
  {
    id: 'app-rectificativa',
    bloque: 'app',
    pregunta: '¿Cómo corrijo una factura que ya he emitido?',
    variantes: ['me he equivocado en una factura', 'como anulo una factura', 'borrar una factura emitida', 'modificar factura ya enviada', 'hacer una rectificativa', 'factura rectificativa como se hace', 'abono de una factura'],
    respuesta:
      'Una factura emitida no se borra ni se edita: se corrige con una rectificativa. Abre la factura en Ventas → Facturas de ingreso y crea la rectificativa desde ella. Puede restar el importe entero (anula la original) o solo la diferencia. La app genera también el asiento que corrige el de la factura original.',
    fuente: APP('/dashboard/facturas', 'Facturas de ingreso'),
    ...VERIFICADA,
    enlaceApp: { texto: 'Ir a Facturas de ingreso', href: '/dashboard/facturas' },
    etiquetas: ['rectificativa', 'anular', 'corregir', 'abono', 'factura'],
  },
  {
    id: 'app-proformas',
    bloque: 'app',
    pregunta: '¿Para qué sirven las proformas?',
    variantes: ['que es una proforma', 'como hago un presupuesto', 'presupuesto para un cliente', 'proforma se contabiliza', 'pasar proforma a factura', 'diferencia entre proforma y factura'],
    respuesta:
      'Una proforma es una oferta con forma de factura, en la serie P. Se guarda sin contabilizarse y no cuenta para el IVA. Las tienes en Ventas → Proformas. Si el cliente la acepta, desde la propia proforma la pasas a factura y entonces sí se emite y se contabiliza. Si la rechaza, la marcas como rechazada.',
    fuente: APP('/dashboard/proformas', 'Proformas'),
    ...VERIFICADA,
    enlaceApp: { texto: 'Ir a Proformas', href: '/dashboard/proformas' },
    etiquetas: ['proforma', 'presupuesto', 'oferta'],
  },
  {
    id: 'app-registrar-gasto',
    bloque: 'app',
    pregunta: '¿Dónde registro una factura de un proveedor?',
    variantes: ['como meto un gasto', 'registrar factura de compra', 'donde subo las facturas de proveedores', 'apuntar un gasto', 'meter una factura recibida', 'escanear factura de gasto', 'subir ticket de gasto'],
    respuesta:
      'Las facturas de proveedor van en Compras → Compras. Si la tienes en PDF o en foto, súbela a Compras → Bandeja OCR: el lector saca proveedor, fecha, base, IVA y total, y tú los revisas antes de guardar. Después, desde la ficha de la factura, la contabilizas y apruebas su asiento en Contabilidad → Motor contable. Los pagos al proveedor también se registran en esa ficha.',
    fuente: APP('/dashboard/compras', 'Compras'),
    ...VERIFICADA,
    enlaceApp: { texto: 'Ir a Compras', href: '/dashboard/compras' },
    etiquetas: ['gasto', 'compra', 'proveedor', 'factura recibida', 'ocr', 'lector'],
  },
  {
    id: 'app-importar-extracto',
    bloque: 'app',
    pregunta: '¿Cómo importo el extracto del banco?',
    variantes: ['subir extracto bancario', 'cargar movimientos del banco', 'importar norma 43', 'meter el csv del banco', 'como paso los movimientos del banco a la app', 'extracto del banco donde se sube'],
    respuesta:
      'En Tesorería → Extractos eliges la cuenta y subes el fichero que te da el banco (CSV o Norma 43). Los movimientos aparecen en Tesorería → Cobros y pagos, donde les pones categoría. Después, en Tesorería → Conciliación, cruzas cada cobro con su factura. Si la cuenta no existe todavía, créala antes en Tesorería → Cuentas bancarias.',
    fuente: APP('/dashboard/tesoreria/extractos', 'Extractos'),
    ...VERIFICADA,
    enlaceApp: { texto: 'Ir a Extractos', href: '/dashboard/tesoreria/extractos' },
    etiquetas: ['extracto', 'banco', 'importar', 'csv', 'norma 43', 'movimientos'],
  },
  {
    id: 'app-conciliar',
    bloque: 'app',
    pregunta: '¿Cómo concilio un cobro del banco con su factura?',
    variantes: ['conciliar movimientos', 'que es conciliar', 'cruzar los movimientos del banco con las facturas', 'marcar factura cobrada desde el banco', 'conciliacion bancaria como funciona', 'el banco no cuadra con las facturas'],
    respuesta:
      'En Tesorería → Conciliación eliges la cuenta, buscas el movimiento y pulsas en conciliar para elegir la factura de venta que paga. Al conciliarlo, la factura queda cobrada por ese importe. Por ahora se concilian cobros con facturas de venta; los pagos a proveedores se registran desde la propia factura de compra.',
    fuente: APP('/dashboard/tesoreria/conciliacion', 'Conciliación'),
    ...VERIFICADA,
    enlaceApp: { texto: 'Ir a Conciliación', href: '/dashboard/tesoreria/conciliacion' },
    etiquetas: ['conciliar', 'conciliacion', 'cruzar', 'cruzo', 'casar', 'banco', 'cobro', 'factura'],
  },
  {
    id: 'app-categorizar',
    bloque: 'app',
    pregunta: '¿Cómo clasifico los movimientos del banco por categorías?',
    variantes: ['poner categoria a un movimiento', 'categorias de tesoreria', 'clasificar gastos del banco', 'crear una categoria nueva', 'movimientos sin categoria', 'desglosar un movimiento'],
    respuesta:
      'En Tesorería → Cobros y pagos ves los movimientos importados y a cada uno le pones su categoría; si un cargo mezcla conceptos, lo desglosas en varias. Las categorías se crean y se ordenan en Tesorería → Categorías. Son categorías de análisis: no cambian la contabilidad.',
    fuente: APP('/dashboard/tesoreria/movimientos', 'Cobros y pagos'),
    ...VERIFICADA,
    enlaceApp: { texto: 'Ir a Cobros y pagos', href: '/dashboard/tesoreria/movimientos' },
    etiquetas: ['categoria', 'categorias', 'clasificar', 'movimientos', 'tesoreria'],
  },
  {
    id: 'app-informes',
    bloque: 'app',
    pregunta: '¿Dónde veo el balance y la cuenta de pérdidas y ganancias?',
    variantes: ['donde esta el balance', 'ver la cuenta de resultados', 'sacar el pyg', 'libro mayor donde lo veo', 'descargar el diario en excel', 'sumas y saldos', 'informes contables en pdf'],
    respuesta:
      'En Contabilidad → Informes contables tienes el balance, la cuenta de pérdidas y ganancias, el balance de sumas y saldos, el mayor y el diario de cualquier ejercicio. Cada informe se descarga en PDF o en Excel. Solo incluyen asientos aprobados: si falta algo, mira si tiene el asiento pendiente en Contabilidad → Motor contable.',
    fuente: APP('/dashboard/informes', 'Informes contables'),
    ...VERIFICADA,
    enlaceApp: { texto: 'Ir a Informes contables', href: '/dashboard/informes' },
    intencionRelacionada: 'INT-18',
    etiquetas: ['balance', 'perdidas y ganancias', 'pyg', 'mayor', 'diario', 'informes', 'sumas y saldos'],
  },
  {
    id: 'app-aprobar-asientos',
    bloque: 'app',
    pregunta: '¿Cómo apruebo los asientos?',
    variantes: ['aprobar un asiento', 'donde se aprueban los asientos', 'contabilizar asientos pendientes', 'revisar asientos del motor contable', 'pasar asiento a definitivo', 'asiento en borrador como lo apruebo'],
    respuesta:
      'En Contabilidad → Motor contable están los asientos que la app genera desde las facturas. Abre el que quieras revisar, comprueba las cuentas y los importes y pulsa «Aprobar». Desde ese momento cuenta en el balance, en la cuenta de resultados y en los libros.',
    fuente: APP('/dashboard/motor-contable', 'Motor contable'),
    ...VERIFICADA,
    enlaceApp: { texto: 'Ir a Motor contable', href: '/dashboard/motor-contable' },
    intencionRelacionada: 'INT-23',
    etiquetas: ['asiento', 'asientos', 'aprobar', 'motor contable', 'revisar'],
  },
  {
    id: 'app-cierre',
    bloque: 'app',
    pregunta: '¿Cómo cierro el ejercicio?',
    variantes: ['como cierro el año', 'cerrar el año contable', 'cierre del año contable', 'hacer el cierre contable', 'abrir el ejercicio nuevo', 'traspasar saldos al año siguiente', 'regularizacion de fin de año', 'asiento de cierre'],
    respuesta:
      'El cierre se hace en Contabilidad → Cierre y traspaso de saldos: la app genera la regularización, el asiento de cierre y la apertura del año siguiente. Antes conviene tener aprobados todos los asientos del año y revisado el balance. Los documentos de cada cierre quedan en Contabilidad → Archivo de cierres.',
    fuente: APP('/dashboard/contabilidad/cierre-ejercicio', 'Cierre y traspaso de saldos'),
    ...VERIFICADA,
    enlaceApp: { texto: 'Ir a Cierre y traspaso de saldos', href: '/dashboard/contabilidad/cierre-ejercicio' },
    etiquetas: ['cierre', 'ejercicio', 'regularizacion', 'apertura', 'traspaso'],
  },
  {
    id: 'app-puesta-en-marcha',
    bloque: 'app',
    pregunta: '¿Cómo paso la contabilidad que llevaba en otro programa?',
    variantes: ['importar contabilidad de otro programa', 'cargar el balance de apertura', 'empezar a usar la app a mitad de año', 'importar el diario', 'traer los saldos del año pasado', 'migrar desde otro programa contable'],
    respuesta:
      'Desde Contabilidad → Puesta en marcha importas el balance de apertura, el diario del año en curso y los saldos de ejercicios anteriores (para tener comparativos). Hace falta el permiso de escritura en contabilidad.',
    fuente: APP('/dashboard/contabilidad/puesta-en-marcha', 'Puesta en marcha'),
    ...VERIFICADA,
    enlaceApp: { texto: 'Ir a Puesta en marcha', href: '/dashboard/contabilidad/puesta-en-marcha' },
    etiquetas: ['importar', 'apertura', 'migrar', 'puesta en marcha', 'diario'],
  },
  {
    id: 'app-modelo-303',
    bloque: 'app',
    pregunta: '¿Cómo preparo el modelo 303 en la app?',
    variantes: ['hacer el 303', 'donde esta el modelo 303', 'preparar la declaracion del iva', 'sacar el fichero del 303', 'presentar el iva trimestral desde la app', 'calcular el iva del trimestre'],
    respuesta:
      'En Fiscalidad → Modelos Fiscales → Modelo 303 eliges el trimestre y la app rellena las casillas con las facturas de ese periodo. Revisa el borrador y descarga el fichero para presentarlo en la sede de la AEAT; la app no presenta nada por ti. Si cambias facturas de ese trimestre, vuelve a revisar el borrador antes de descargarlo.',
    fuente: APP('/dashboard/fiscal/modelo-303', 'Modelo 303'),
    ...VERIFICADA,
    enlaceApp: { texto: 'Ir al Modelo 303', href: '/dashboard/fiscal/modelo-303' },
    intencionRelacionada: 'INT-28',
    etiquetas: ['303', 'iva', 'modelo', 'declaracion', 'trimestre'],
  },
  {
    id: 'app-permisos',
    bloque: 'app',
    pregunta: '¿Por qué no puedo ver o hacer algo en la app?',
    variantes: ['no tengo permiso', 'me sale que falta permiso', 'no veo tesoreria', 'quien me da acceso', 'roles de usuario', 'como doy permisos a un empleado'],
    respuesta:
      'Cada usuario tiene un rol en cada empresa: administrador, contable, tesorería, ventas o solo lectura. El rol decide qué pantallas ves y qué puedes cambiar, y Carmen sigue las mismas reglas. Si te falta acceso a algo, pídeselo al administrador de tu empresa.',
    fuente: APP('/dashboard', 'Resumen'),
    ...VERIFICADA,
    etiquetas: ['permiso', 'permisos', 'rol', 'roles', 'acceso', 'usuario'],
  },
  {
    id: 'app-datos-empresa',
    bloque: 'app',
    pregunta: '¿Dónde cambio los datos de mi empresa que salen en las facturas?',
    variantes: ['cambiar el logo de las facturas', 'poner mi nif en las facturas', 'datos fiscales de la empresa', 'cambiar direccion de la empresa', 'registro mercantil en la factura'],
    respuesta:
      'En Más → Datos de la empresa: datos fiscales, contacto, inscripción en el Registro Mercantil y logo. Es lo que sale en la cabecera de las facturas que emites desde ese momento.',
    fuente: APP('/dashboard/empresa', 'Datos de la empresa'),
    ...VERIFICADA,
    enlaceApp: { texto: 'Ir a Datos de la empresa', href: '/dashboard/empresa' },
    etiquetas: ['empresa', 'logo', 'datos fiscales', 'nif', 'direccion'],
  },

  // ---------------- Conceptos contables ----------------
  {
    id: 'cont-estados-asiento',
    bloque: 'contabilidad',
    pregunta: '¿Qué significan los estados de un asiento?',
    variantes: ['que es un asiento en borrador', 'asiento pendiente de revision que significa', 'estado posted', 'asiento anulado reversed', 'draft pending review posted', 'que quiere decir asiento aprobado'],
    respuesta:
      'Un asiento pasa por estos estados. Borrador: recién creado. Pendiente de revisión: esperando a que alguien lo compruebe. Aprobado: ya es definitivo y cuenta en el balance, la cuenta de resultados y los libros. Anulado: se deshizo, por ejemplo al rectificar la factura. Los borradores y los pendientes no salen en ningún informe.',
    fuente: PGC,
    ...VERIFICADA,
    enlaceApp: { texto: 'Ir a Motor contable', href: '/dashboard/motor-contable' },
    intencionRelacionada: 'INT-23',
    etiquetas: ['asiento', 'estado', 'borrador', 'pendiente', 'aprobado', 'anulado'],
  },
  {
    id: 'cont-no-sale-en-informes',
    bloque: 'contabilidad',
    pregunta: '¿Por qué una factura no sale en el balance ni en la cuenta de resultados?',
    variantes: ['la factura no aparece en el pyg', 'no me sale la venta en el balance', 'informes no cuadran con las facturas', 'falta una factura en el mayor', 'el resultado no coincide con lo facturado'],
    respuesta:
      'Los informes contables solo cuentan asientos aprobados. Si la factura tiene su asiento en borrador o pendiente de revisión, no sale hasta que lo apruebes en Contabilidad → Motor contable. Si no tiene asiento, contabilízala desde la propia factura. Revisa también la fecha: cuenta en el ejercicio de su fecha de emisión.',
    fuente: PGC,
    ...VERIFICADA,
    enlaceApp: { texto: 'Ir a Motor contable', href: '/dashboard/motor-contable' },
    intencionRelacionada: 'INT-23',
    etiquetas: ['informes', 'balance', 'pyg', 'no sale', 'asiento', 'aprobar'],
  },
  {
    id: 'cont-asiento-venta',
    bloque: 'contabilidad',
    pregunta: '¿Qué asiento genera una factura de venta?',
    variantes: ['que asiento hace una venta', 'asiento de una factura emitida', 'como se contabiliza una venta', 'cuentas de una factura de venta', '430 700 477', 'partida doble de una venta'],
    respuesta:
      'Con una venta de 1.000 € más 210 € de IVA, el asiento es: al debe, 430 Clientes por 1.210 €; al haber, 700 Ventas por 1.000 € y 477 IVA repercutido por 210 €. Debe y haber siempre suman lo mismo. Cuando cobras, otro asiento lleva 572 Bancos al debe y 430 Clientes al haber.',
    fuente: PGC,
    ...VERIFICADA,
    etiquetas: ['asiento', 'venta', '430', '700', '477', 'partida doble', 'contabilizar'],
  },
  {
    id: 'cont-asiento-compra',
    bloque: 'contabilidad',
    pregunta: '¿Qué asiento genera una factura de compra o de gasto?',
    variantes: ['como se contabiliza un gasto', 'asiento de factura de proveedor', 'cuentas de una compra', '600 472 400', 'contabilizar factura recibida'],
    respuesta:
      'Con una compra de 500 € más 105 € de IVA: al debe, la cuenta del gasto (600 Compras, 621 Arrendamientos, 628 Suministros...) por 500 € y 472 IVA soportado por 105 €; al haber, 400 Proveedores (o 410 Acreedores si es un servicio) por 605 €. Al pagarla, 400 o 410 al debe y 572 Bancos al haber.',
    fuente: PGC,
    ...VERIFICADA,
    etiquetas: ['asiento', 'compra', 'gasto', '400', '410', '472', '600', 'proveedor', 'contabilizar', 'contabiliza', 'factura de proveedor'],
  },
  {
    id: 'cont-iva-repercutido-soportado',
    bloque: 'contabilidad',
    pregunta: '¿Qué diferencia hay entre IVA repercutido e IVA soportado?',
    variantes: ['que es el iva repercutido', 'que es el iva soportado', 'iva de ventas e iva de compras', 'cuenta 477 y 472', 'iva que cobro y iva que pago'],
    respuesta:
      'El IVA repercutido es el que cobras a tus clientes en tus facturas (cuenta 477). El soportado es el que te cobran tus proveedores (cuenta 472). En cada declaración de IVA restas al repercutido el soportado que puedes deducir: si sale positivo, pagas; si sale negativo, compensas o pides la devolución.',
    fuente: PGC,
    ...VERIFICADA,
    etiquetas: ['iva', 'repercutido', 'soportado', '477', '472'],
  },
  {
    id: 'cont-pendiente-vs-saldo',
    bloque: 'contabilidad',
    pregunta: '¿Por qué lo pendiente de cobro de un cliente no coincide con su saldo contable?',
    variantes: ['el saldo del cliente no cuadra con las facturas', 'diferencia entre pendiente y saldo del mayor', 'mayor de clientes no coincide', 'pendiente de cobro distinto del saldo de la 430', 'por que no coincide el saldo contable con lo pendiente'],
    respuesta:
      'Son dos cálculos distintos. Lo pendiente según facturas es el total de cada factura menos los cobros registrados, a fecha de hoy. El saldo contable sale de los asientos aprobados de la cuenta del cliente (430). No coinciden si hay asientos sin aprobar, cobros registrados sin asiento o saldos de apertura importados. El saldo contable lo ves en Contabilidad → Mayor de clientes y proveedores.',
    fuente: PGC,
    ...VERIFICADA,
    enlaceApp: { texto: 'Ir al Mayor de clientes y proveedores', href: '/dashboard/mayor-terceros' },
    intencionRelacionada: 'INT-02',
    etiquetas: ['pendiente', 'saldo', 'cliente', 'mayor', '430', 'no cuadra'],
  },
];
