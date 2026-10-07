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
 * Bloques: uso de la app (rutas sacadas de nav.ts), conceptos contables (PGC
 * de pymes) y fichas fiscales (IVA, IRPF, Sociedades, facturación y normas
 * generales), cada una comprobada el 07/10/2026 contra el texto consolidado del
 * BOE que cita su fuente. Los plazos de los modelos no van en fichas: los
 * calcula faq/calendario.ts.
 *
 * No se publican, por no poder verificarlas: las cuantías y límites de módulos
 * de 2026 (dependen de reales decretos-leyes derogados), la cuota de autónomos
 * de 2026, los créditos incobrables del art. 80 LIVA y las fechas de la campaña
 * de la renta. La búsqueda es por palabras clave y sinónimos (BM25 en
 * faq/bm25.ts); no hay embeddings.
 */
/** 'general': normas comunes a todos los impuestos (recargos, aplazamientos, prescripción). */
export type BloqueFAQ = 'app' | 'contabilidad' | 'iva' | 'irpf' | 'sociedades' | 'facturacion' | 'general';

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
/** Texto consolidado del BOE, con el ancla del artículo si la hay. */
const BOE = (id: string, ancla: string, titulo: string) => ({
  titulo: `${titulo} (BOE)`,
  url: `https://www.boe.es/buscar/act.php?id=${id}${ancla ? `#${ancla}` : ''}`,
});

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
      'Las facturas de proveedor van en Compras → Compras. La lectura automática de PDF y fotos aún no está disponible, así que los datos de la factura se meten a mano. Después, desde la ficha de la factura, la contabilizas y apruebas su asiento en Contabilidad → Motor contable. Los pagos al proveedor también se registran en esa ficha.',
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

  // ---------------- IVA ----------------
  {
    id: 'iva-tipos',
    bloque: 'iva',
    pregunta: '¿Qué tipos de IVA hay?',
    variantes: ['que tipo de iva lleva la fruta', 'iva del 21 del 10 y del 4', 'cuando se aplica el iva reducido', 'iva superreducido que productos lleva', 'que iva tiene la hosteleria', 'tipo de iva de los alimentos', 'que tipos de iba existen'],
    respuesta:
      'Hay tres tipos. El general, del 21 %, es el de la mayoría de bienes y servicios. El reducido, del 10 %, se aplica, entre otros, a los alimentos que no van al 4 %, a la hostelería y restauración, al transporte de viajeros y a la vivienda. El superreducido, del 4 %, es para el pan común, la leche, los quesos, los huevos, las frutas, verduras, hortalizas, legumbres y cereales naturales, el aceite de oliva, los libros y periódicos y los medicamentos de uso humano, entre otros. Las bebidas alcohólicas y los refrescos con azúcar añadido van al 21 %. Se aplica el tipo vigente cuando se devenga la operación.',
    fuente: BOE('BOE-A-1992-28740', 'a91', 'Ley 37/1992 del IVA, artículos 90 y 91'),
    ...VERIFICADA,
    etiquetas: ['iva', 'tipo', 'tipos', 'general', 'reducido', 'superreducido', 'alimentos', 'hosteleria', 'porcentaje'],
  },
  {
    id: 'iva-recargo-equivalencia',
    bloque: 'iva',
    pregunta: '¿Qué es el recargo de equivalencia?',
    variantes: ['a quien se aplica el recargo de equivalencia', 'tengo que cobrar recargo de equivalencia a una tienda', 'que porcentaje tiene el recargo de equivalencia', 'comerciante minorista recargo', 'vendo a un comercio minorista que iva le pongo', 'recargo de equibalencia'],
    respuesta:
      'Es un régimen especial del IVA para los comerciantes minoristas que son personas físicas o entidades en atribución de rentas (como las comunidades de bienes), no para sociedades mercantiles. El minorista no presenta el IVA de esas ventas: se lo cobra su proveedor en la factura, sumando al IVA un recargo, y es el proveedor quien lo ingresa. El recargo es del 5,2 % con IVA al 21 %, del 1,4 % con IVA al 10 %, del 0,5 % con IVA al 4 % y del 1,75 % en el tabaco. Si vendes a un minorista, él tiene que acreditarte si está o no en este régimen.',
    fuente: BOE('BOE-A-1992-28740', 'a148', 'Ley 37/1992 del IVA, artículos 148 a 163'),
    ...VERIFICADA,
    etiquetas: ['recargo', 'equivalencia', 'minorista', 'comerciante', 'tienda', 'iva'],
  },
  {
    id: 'iva-isp',
    bloque: 'iva',
    pregunta: '¿Qué es la inversión del sujeto pasivo?',
    variantes: ['cuando se aplica la inversion del sujeto pasivo', 'factura sin iva por inversion del sujeto pasivo', 'isp en el iva', 'subcontrata de obra factura sin iva', 'autorrepercutirse el iva', 'inversion sujeto pasibo'],
    respuesta:
      'Es cuando el IVA lo declara quien compra y no quien vende: el vendedor factura sin IVA, con la mención «inversión del sujeto pasivo», y el comprador, que es empresario o profesional, se lo repercute y se lo deduce en su 303. Se aplica, entre otros casos, a las compras a empresas no establecidas en España, a las obras de urbanización, construcción o rehabilitación contratadas entre promotor y contratista o entre subcontratistas, a la chatarra y otros desechos, al oro sin elaborar y a los móviles, consolas, portátiles y tabletas vendidos a revendedores o por más de 10.000 € sin IVA en una factura.',
    fuente: BOE('BOE-A-1992-28740', 'a84', 'Ley 37/1992 del IVA, artículo 84'),
    ...VERIFICADA,
    etiquetas: ['inversion', 'sujeto', 'pasivo', 'isp', 'autorrepercusion', 'subcontrata', 'obra'],
  },
  {
    id: 'iva-intracomunitarias',
    bloque: 'iva',
    pregunta: '¿Cómo facturo a un cliente de otro país de la Unión Europea?',
    variantes: ['venta intracomunitaria sin iva', 'factura a una empresa de francia lleva iva', 'le pongo iva a un cliente de francia o de otro pais de la ue', 'que es el roi', 'alta como operador intracomunitario', 'cliente europeo con vat number', 'requisitos de una entrega intracomunitaria', 'factura sin iva a alemania'],
    respuesta:
      'Una venta de bienes que sale de España hacia otro país de la UE va sin IVA (exenta) si el cliente es empresa o profesional y te ha comunicado su NIF-IVA de otro Estado miembro; compruébalo en el VIES antes de facturar. Para que la exención valga, tienes que incluir la venta en el modelo 349. Además, para hacer entregas o compras intracomunitarias tienes que estar dado de alta en el Registro de Operadores Intracomunitarios (ROI). Si el cliente es un particular o no tiene NIF-IVA, la venta lleva IVA. Los servicios siguen otras reglas: consúltalo con tu asesor.',
    fuente: BOE('BOE-A-1992-28740', 'a25', 'Ley 37/1992 del IVA, artículo 25'),
    ...VERIFICADA,
    enlaceApp: { texto: 'Ir a Clientes', href: '/dashboard/clientes' },
    etiquetas: ['intracomunitaria', 'intracomunitario', 'ue', 'europa', 'roi', 'vies', 'nif-iva', 'exenta', 'extranjero', 'pais', 'francia', 'alemania', 'italia', 'portugal'],
  },
  {
    id: 'iva-criterio-caja',
    bloque: 'iva',
    pregunta: '¿Qué es el criterio de caja del IVA?',
    variantes: ['regimen especial del criterio de caja', 'pagar el iva cuando cobre la factura', 'requisitos del criterio de caja', 'como me acojo al criterio de caja', 'no quiero adelantar el iva de facturas sin cobrar', 'criterio de caja limite de 2 millones', 'el iva se declara cuando cobro la factura'],
    respuesta:
      'Es un régimen voluntario: el IVA de tus ventas se declara cuando las cobras, no cuando las facturas, y el de tus compras se deduce cuando las pagas. Si no cobras, el IVA se devenga igualmente el 31 de diciembre del año siguiente al de la operación. Pueden usarlo quienes el año anterior no pasaron de 2.000.000 € de volumen de operaciones, y quedan fuera quienes cobran en efectivo más de 100.000 € de un mismo cliente en un año. Se elige al empezar la actividad o en diciembre para el año siguiente, y la renuncia dura como mínimo tres años. El 303 de la app se calcula con la fecha de las facturas.',
    fuente: BOE('BOE-A-1992-28740', 'a163decies', 'Ley 37/1992 del IVA, artículos 163 decies a 163 sexiesdecies'),
    ...VERIFICADA,
    etiquetas: ['criterio', 'caja', 'regimen', 'cobro', 'cobrar', 'cobrado', 'devengo', 'iva'],
  },
  {
    id: 'iva-coche',
    bloque: 'iva',
    pregunta: '¿Puedo deducirme el IVA del coche?',
    variantes: ['iva del coche deducible', 'cuanto iva me deduzco del vehiculo', 'iva de la gasolina del coche', 'iva del renting del coche', 'deducir el iva de un coche de empresa', 'el iba del coche'],
    respuesta:
      'En el IVA, un turismo, una moto o un todoterreno se presume usado en la actividad al 50 %: puedes deducir la mitad del IVA de su compra o alquiler y de sus accesorios, combustible, aparcamientos, peajes y reparaciones, salvo que pruebes otro porcentaje. Se presumen usados al 100 % los vehículos mixtos para transportar mercancías, los de transporte de viajeros, autoescuela y vigilancia, los de pruebas o promoción de los fabricantes y los de representantes o agentes comerciales. Esto es solo el IVA: en el IRPF y en Sociedades el gasto del coche tiene sus propias reglas.',
    fuente: BOE('BOE-A-1992-28740', 'a95', 'Ley 37/1992 del IVA, artículo 95'),
    ...VERIFICADA,
    etiquetas: ['coche', 'vehiculo', 'turismo', 'furgoneta', 'gasolina', 'renting', 'deducir', 'iva', '50'],
  },
  {
    id: 'iva-plazo-deducir',
    bloque: 'iva',
    pregunta: '¿Hasta cuándo puedo deducirme el IVA de una factura que se me olvidó?',
    variantes: ['factura de compra olvidada puedo deducir el iva', 'plazo para deducir el iva soportado', 'meter una factura de un trimestre anterior', 'cuantos años tengo para deducir el iva', 'se me paso una factura del trimestre pasado', 'factura de compra que no declare en su trimestre'],
    respuesta:
      'Puedes deducir el IVA de una factura recibida en el 303 del periodo en que lo soportaste o en cualquiera de los siguientes, siempre que no hayan pasado cuatro años desde que nació el derecho a deducirlo. No hace falta corregir el trimestre anterior: basta con incluirla en un 303 posterior. En la app, el 303 toma cada factura por su fecha de emisión; si ese trimestre ya está presentado, decide con tu asesor en qué periodo la declaras.',
    fuente: BOE('BOE-A-1992-28740', 'a99', 'Ley 37/1992 del IVA, artículo 99'),
    ...VERIFICADA,
    etiquetas: ['deducir', 'deduccion', 'olvidada', 'plazo', 'cuatro', 'años', 'soportado', 'trimestre', 'anterior', 'meter'],
  },

  // ---------------- Facturación ----------------
  {
    id: 'fact-simplificada',
    bloque: 'facturacion',
    pregunta: '¿Cuándo puedo hacer una factura simplificada?',
    variantes: ['que es una factura simplificada', 'ticket o factura completa', 'limite de la factura simplificada', 'factura simplificada hasta 3000 euros', 'puedo darle un ticket a una empresa', 'factura simplificda requisitos'],
    respuesta:
      'La factura simplificada (el antiguo ticket) se puede emitir si el importe no pasa de 400 € con IVA, o si es una rectificativa. Hasta 3.000 € con IVA se admite en ventas al por menor, hostelería y restauración, transporte de personas, peluquerías, aparcamientos, tintorerías y otras actividades que enumera el reglamento. No se puede usar en las entregas de bienes a otro país de la UE. Si el cliente es empresario o profesional y lo pide, tiene que llevar su NIF y su domicilio y la cuota de IVA por separado, para que pueda deducírsela.',
    fuente: BOE('BOE-A-2012-14696', 'a4', 'Reglamento de facturación (RD 1619/2012), artículos 4 y 7'),
    ...VERIFICADA,
    etiquetas: ['simplificada', 'ticket', '400', '3000', 'factura'],
  },
  {
    id: 'fact-plazo-emision',
    bloque: 'facturacion',
    pregunta: '¿Cuánto tiempo tengo para emitir una factura?',
    variantes: ['plazo para hacer la factura', 'hasta cuando puedo facturar un servicio', 'antes del dia 16 del mes siguiente factura', 'tengo que facturar en el momento de la venta', 'plazo de expedicion de facturas'],
    respuesta:
      'La regla general es emitir la factura cuando se hace la venta o el servicio. Si el cliente es empresario o profesional, tienes hasta antes del día 16 del mes siguiente a aquel en que se devengó el IVA. Por ejemplo, un servicio prestado a una empresa el 20 de octubre se puede facturar hasta el 15 de noviembre. A un particular, la factura se emite en el momento.',
    fuente: BOE('BOE-A-2012-14696', 'a11', 'Reglamento de facturación (RD 1619/2012), artículo 11'),
    ...VERIFICADA,
    etiquetas: ['plazo', 'emitir', 'expedir', 'factura', 'dia 16'],
  },
  {
    id: 'fact-rectificativa-plazo',
    bloque: 'facturacion',
    pregunta: '¿Cuándo es obligatorio hacer una factura rectificativa?',
    variantes: ['plazo para rectificar una factura', 'rectificativa por un error en el iva', 'devolucion de mercancia hace falta rectificativa', 'cuantos años tengo para rectificar una factura', 'descuento despues de facturar rectificativa', 'plazo para emitir una rectificativa'],
    respuesta:
      'Es obligatoria cuando la factura no cumple algún requisito, cuando el IVA se calculó mal o cuando cambia la base imponible (descuentos posteriores, devoluciones o impagos en los casos que prevé la ley). Se emite en cuanto conoces el motivo, siempre que no hayan pasado cuatro años desde el devengo del IVA, y debe identificar la factura que rectifica. Si el cliente devuelve mercancía y le vuelves a vender con el mismo tipo de IVA, puedes restarla en la siguiente factura. En la app se hace desde la propia factura emitida.',
    fuente: BOE('BOE-A-2012-14696', 'a15', 'Reglamento de facturación (RD 1619/2012), artículo 15'),
    ...VERIFICADA,
    enlaceApp: { texto: 'Ir a Facturas de ingreso', href: '/dashboard/facturas' },
    etiquetas: ['rectificativa', 'obligatoria', 'plazo', 'error', 'devolucion', 'descuento'],
  },
  {
    id: 'fact-conservacion',
    bloque: 'facturacion',
    pregunta: '¿Cuánto tiempo tengo que guardar las facturas?',
    variantes: ['cuantos años hay que guardar los documentos', 'que documentos debo guardar y durante cuantos años', 'puedo tirar las facturas antiguas', 'plazo de conservacion de la contabilidad', 'guardar los libros contables 6 años'],
    respuesta:
      'Las facturas emitidas y recibidas y sus justificantes se guardan, como mínimo, mientras Hacienda puede revisarlas: cuatro años desde que acaba el plazo de presentar la declaración en la que cuentan. Además, el Código de Comercio obliga a los empresarios a conservar los libros, la correspondencia y los justificantes de su negocio durante seis años desde el último asiento. En la práctica, guarda todo seis años, y más si tienes bases negativas o deducciones que se compensan en años posteriores, que se pueden comprobar durante diez.',
    fuente: BOE('BOE-A-2012-14696', 'a19', 'Reglamento de facturación (RD 1619/2012), artículo 19, y Código de Comercio, artículo 30'),
    ...VERIFICADA,
    enlaceApp: { texto: 'Ir al Archivo', href: '/dashboard/archivo' },
    etiquetas: ['guardar', 'conservar', 'conservacion', 'años', 'documentos', 'facturas', 'tirar'],
  },
  {
    id: 'fact-verifactu',
    bloque: 'facturacion',
    pregunta: '¿Qué es Verifactu y cuándo es obligatorio?',
    variantes: ['cuando entra en vigor verifactu', 'verifactu es obligatorio para autonomos', 'como funciona verifactu en las facturas', 'sistema de facturacion verificable', 'reglamento antifraude del software de facturacion', 'que es veri factu'],
    respuesta:
      'Verifactu es el nombre que se da a los requisitos que deben cumplir los programas de facturación (Real Decreto 1007/2023): cada factura genera un registro encadenado que no se puede alterar y lleva un código QR. Tras el último aplazamiento (Real Decreto-ley 15/2025), las sociedades tienen que tener el programa adaptado antes del 1 de enero de 2027, y el resto de obligados, como los autónomos, antes del 1 de julio de 2027. No se aplica a quien lleva los libros del IVA por el SII.',
    fuente: BOE('BOE-A-2023-24840', 'df-4', 'Real Decreto 1007/2023, disposición final cuarta (redacción del RDL 15/2025)'),
    ...VERIFICADA,
    etiquetas: ['verifactu', 'antifraude', 'software', 'qr', 'registro', 'facturacion', 'sif'],
  },
  {
    id: 'fact-electronica-b2b',
    bloque: 'facturacion',
    pregunta: '¿Cuándo será obligatoria la factura electrónica entre empresas?',
    variantes: ['factura electronica obligatoria b2b', 'ley crea y crece factura electronica', 'cuando tengo que emitir facturas electronicas', 'solucion publica de facturacion electronica', 'factura electronica obligatoria para autonomos'],
    respuesta:
      'El Real Decreto 238/2026 obliga a emitir y recibir factura electrónica en las operaciones entre empresarios y profesionales. Los plazos cuentan desde el 6 de octubre de 2026, cuando entró en vigor la Orden HAC/1028/2026, que regula la solución pública de la AEAT: doce meses después para quien tuvo más de 8 millones de euros de volumen de operaciones el año anterior y veinticuatro meses después para el resto. Las facturas se intercambian por plataformas privadas o por esa solución pública, de uso voluntario. Es una obligación distinta de Verifactu.',
    fuente: BOE('BOE-A-2026-7295', '', 'Real Decreto 238/2026, disposición final cuarta, y Orden HAC/1028/2026'),
    ...VERIFICADA,
    etiquetas: ['electronica', 'b2b', 'crea', 'crece', 'factura', 'obligatoria', 'plataforma'],
  },

  // ---------------- IRPF (autónomos) ----------------
  {
    id: 'irpf-suministros-casa',
    bloque: 'irpf',
    pregunta: '¿Puedo deducir la luz y el internet si trabajo en casa?',
    variantes: ['gastos de suministros trabajando desde casa', 'autonomo en casa deducir luz agua e internet', 'porcentaje deducible de los suministros de la vivienda', 'el 30 por ciento de los suministros', 'trabajo desde casa que gastos me deduzco'],
    respuesta:
      'Si eres autónomo en estimación directa y usas parte de tu vivienda habitual para la actividad, en el IRPF puedes deducir los suministros (agua, gas, electricidad, teléfono e internet) en el 30 % de la proporción de metros que dedicas al trabajo, salvo que pruebes otro porcentaje. Por ejemplo, si el despacho ocupa 15 m² de una casa de 100 m², deduces el 30 % del 15 %, es decir, el 4,5 % de cada factura. En una sociedad estas reglas no se aplican.',
    fuente: BOE('BOE-A-2006-20764', 'a30', 'Ley 35/2006 del IRPF, artículo 30.2.5.ª'),
    ...VERIFICADA,
    etiquetas: ['suministros', 'casa', 'vivienda', 'luz', 'internet', 'agua', 'autonomo', 'deducir'],
  },
  {
    id: 'irpf-manutencion',
    bloque: 'irpf',
    pregunta: '¿Cuánto puedo deducir en comidas siendo autónomo?',
    variantes: ['dietas del autonomo deducibles', 'gastos de manutencion del autonomo', 'limite de las comidas de trabajo', 'puedo deducir el menu del dia', 'comer fuera por trabajo siendo autonomo'],
    respuesta:
      'En estimación directa, tus propias comidas por la actividad se deducen en el IRPF si son en restaurantes u hostelería, las pagas con tarjeta u otro medio electrónico y no pasas de los límites diarios de las dietas de los trabajadores: 26,67 € en España y 48,08 € en el extranjero sin pernoctar, o 53,34 € y 91,35 € si duermes fuera. Guarda la factura. Las comidas con clientes son otra cosa: atenciones a clientes.',
    fuente: BOE('BOE-A-2006-20764', 'a30', 'Ley 35/2006 del IRPF, artículo 30.2.5.ª, y su Reglamento, artículo 9'),
    ...VERIFICADA,
    etiquetas: ['comidas', 'dietas', 'manutencion', 'menu', 'restaurante', 'autonomo'],
  },
  {
    id: 'irpf-dificil-justificacion',
    bloque: 'irpf',
    pregunta: '¿Qué son los gastos de difícil justificación?',
    variantes: ['dificil justificacion 5 por ciento', 'gastos de dificil justificacion en estimacion directa simplificada', 'deduccion del 5 por ciento de los autonomos', 'limite de 2000 euros dificil justificacion', 'provisiones y gastos de dificil justificacion'],
    respuesta:
      'Si eres autónomo en estimación directa simplificada, en el IRPF puedes restar un 5 % de tu rendimiento neto por provisiones y gastos de difícil justificación, sin tener que justificarlos, con un máximo de 2.000 € al año. No se aplica en la estimación directa normal. En 2026, las actividades en Ceuta con la deducción del artículo 68.4 de la ley aplican un 10 %. Es un cálculo de la declaración de la renta: la app no lo hace.',
    fuente: BOE('BOE-A-2007-6820', 'a30', 'Reglamento del IRPF (RD 439/2007), artículo 30'),
    ...VERIFICADA,
    etiquetas: ['dificil', 'justificacion', 'simplificada', 'autonomo', 'irpf', '5'],
  },
  {
    id: 'irpf-retencion-profesionales',
    bloque: 'irpf',
    pregunta: '¿Qué retención de IRPF pongo en mis facturas?',
    variantes: ['retencion del 15 o del 7', 'que irpf pongo en la factura siendo autonomo', 'retencion del 7 por ciento nuevos autonomos', 'cuando aplico el 7 de retencion', 'factura de profesional con retencion', 'poner la retencion del 7 por ciento en la factura'],
    respuesta:
      'Si tu actividad es profesional y facturas a una empresa o a otro profesional, la retención general es del 15 %. Puedes aplicar el 7 % el año en que empiezas y los dos siguientes, si el año anterior al inicio no ejerciste ninguna actividad profesional; tienes que comunicárselo a tu cliente por escrito y firmado. A un particular no se le aplica retención. Las actividades empresariales, como el comercio o los oficios, normalmente no llevan retención, salvo algunas en módulos, agrícolas, ganaderas o forestales. Quien te paga ingresa esa retención con su modelo 111.',
    fuente: BOE('BOE-A-2006-20764', 'a101', 'Ley 35/2006 del IRPF, artículo 101.5, y su Reglamento, artículo 95'),
    ...VERIFICADA,
    etiquetas: ['retencion', 'irpf', '15', '7', 'profesional', 'autonomo', 'factura', 'poner'],
  },
  {
    id: 'irpf-retencion-alquiler',
    bloque: 'irpf',
    pregunta: '¿Tengo que hacer retención en el alquiler del local?',
    variantes: ['retencion del 19 en el alquiler', 'alquiler de oficina retencion de irpf', 'pago el alquiler de un local y tengo que retener', 'retencion en el alquiler de una nave', 'retencion alquiler local negocio'],
    respuesta:
      'Si pagas el alquiler de un local, oficina o nave urbanos para tu empresa o tu actividad, normalmente tienes que retener el 19 % de la renta, sin contar el IVA, e ingresarlo con el modelo 115 cada trimestre. El arrendador sigue cobrándote el IVA. Hay excepciones: por ejemplo, si lo que pagas a un mismo arrendador no pasa de 900 € al año o si te acredita que su actividad está exonerada. Consulta a tu asesor si tienes dudas.',
    fuente: BOE('BOE-A-2007-6820', 'a100', 'Reglamento del IRPF (RD 439/2007), artículos 75 y 100'),
    ...VERIFICADA,
    enlaceApp: { texto: 'Ir al Modelo 115', href: '/dashboard/fiscal/modelo-115' },
    etiquetas: ['alquiler', 'local', 'oficina', 'nave', 'retencion', '19', 'arrendamiento', '115'],
  },

  // ---------------- Impuesto sobre Sociedades ----------------
  {
    id: 'is-tipos',
    bloque: 'sociedades',
    pregunta: '¿A qué tipo tributa una sociedad en el Impuesto sobre Sociedades?',
    variantes: ['tipo del impuesto de sociedades en 2026', 'cuanto paga una sl de impuesto de sociedades', 'tipo reducido de las microempresas', 'sociedades de nueva creacion al 15', 'porcentaje del impuesto de sociedades'],
    respuesta:
      'El tipo general es el 25 %. Si la cifra de negocios del año anterior fue de menos de 1 millón de euros, en los ejercicios que empiezan en 2026 se paga el 19 % por los primeros 50.000 € de base imponible y el 21 % por el resto (en 2027, el 17 % y el 20 %). Las demás empresas de reducida dimensión, con menos de 10 millones de cifra de negocios, pagan el 23 % en 2026 y el 22 % en 2027. Una sociedad de nueva creación paga el 15 % el primer año con base positiva y el siguiente. Las entidades patrimoniales no aplican estos tipos reducidos.',
    fuente: BOE('BOE-A-2014-12328', 'a29', 'Ley 27/2014 del Impuesto sobre Sociedades, artículo 29 y disposición transitoria cuadragésima cuarta'),
    ...VERIFICADA,
    vigenteDesde: '2026-01-01',
    intencionRelacionada: 'INT-18',
    etiquetas: ['sociedades', 'tipo', 'gravamen', 'microempresa', 'nueva', 'creacion', '25', 'is'],
  },
  {
    id: 'is-amortizacion',
    bloque: 'sociedades',
    pregunta: '¿Cómo se amortiza un ordenador?',
    variantes: ['cuantos años se amortiza un vehiculo', 'tabla de amortizacion oficial', 'coeficiente de amortizacion del mobiliario', 'amortizar programas informaticos', 'activos de menos de 300 euros amortizacion', 'amortisacion de un ordenador'],
    respuesta:
      'Un bien que dura varios años no es gasto de una vez: se reparte con la amortización. En el Impuesto sobre Sociedades, la tabla oficial fija para cada tipo de bien un coeficiente máximo y un plazo máximo: equipos para procesos de información (ordenadores), 25 % y 8 años; programas informáticos, 33 % y 6 años; mobiliario, 10 % y 20 años; elementos de transporte externo, 16 % y 14 años; edificios comerciales, 2 % y 100 años. Las empresas de reducida dimensión pueden amortizar libremente los elementos nuevos de hasta 300 € cada uno, con un máximo de 25.000 € al año. Para autónomos, consulta a tu asesor.',
    fuente: BOE('BOE-A-2014-12328', 'a12', 'Ley 27/2014 del Impuesto sobre Sociedades, artículos 12 y 103'),
    ...VERIFICADA,
    etiquetas: ['amortizacion', 'amortizar', 'ordenador', 'vehiculo', 'mobiliario', 'tabla', 'coeficiente'],
  },
  {
    id: 'is-atenciones-clientes',
    bloque: 'sociedades',
    pregunta: '¿Son deducibles los regalos y las comidas con clientes?',
    variantes: ['regalos de navidad a clientes son deducibles', 'comida con un cliente se puede deducir', 'atenciones a clientes limite', 'cesta de navidad es gasto deducible', 'invitar a comer a un cliente'],
    respuesta:
      'En el Impuesto sobre Sociedades, los gastos por atenciones a clientes o proveedores (regalos, comidas, invitaciones) son deducibles con un límite del 1 % del importe neto de la cifra de negocios del ejercicio; conviene tener la factura y poder explicar su relación con el negocio. En el IVA es distinto: el IVA de los bienes y servicios destinados a atenciones a clientes, empleados o terceros no se puede deducir, salvo el de las muestras gratuitas y los objetos publicitarios de escaso valor.',
    fuente: BOE('BOE-A-2014-12328', 'a15', 'Ley 27/2014 del Impuesto sobre Sociedades, artículo 15, y Ley del IVA, artículo 96'),
    ...VERIFICADA,
    etiquetas: ['atenciones', 'clientes', 'regalos', 'comidas', 'navidad', 'cesta', 'deducible'],
  },

  // ---------------- Normas generales ----------------
  {
    id: 'lgt-recargos',
    bloque: 'general',
    pregunta: '¿Qué pasa si presento un impuesto fuera de plazo?',
    variantes: ['recargo por presentar tarde', 'que recargo hay si presento el iva o un impuesto tarde', 'presentar el 303 tarde', 'me he pasado del plazo con hacienda', 'recargo por declaracion extemporanea', 'se me olvido presentar el iva a tiempo'],
    respuesta:
      'Si lo presentas tarde por tu cuenta, antes de que Hacienda te lo pida, no hay sanción sino un recargo: un 1 % más otro 1 % por cada mes completo de retraso. Pasados 12 meses, el recargo es del 15 % y además se pagan intereses de demora desde entonces. El recargo se reduce un 25 % si pagas a tiempo la deuda y el propio recargo. Se calcula sobre lo que sale a ingresar. Si Hacienda ya te lo ha requerido, ya no hay recargo sino una posible sanción.',
    fuente: BOE('BOE-A-2003-23186', 'a27', 'Ley 58/2003 General Tributaria, artículo 27'),
    ...VERIFICADA,
    intencionRelacionada: 'INT-30',
    etiquetas: ['recargo', 'tarde', 'fuera', 'plazo', 'extemporanea', 'retraso', 'hacienda', 'presento', 'presentar'],
  },
  {
    id: 'lgt-aplazamientos',
    bloque: 'general',
    pregunta: '¿Puedo aplazar el pago de un impuesto?',
    variantes: ['aplazar el pago del iva', 'fraccionar un pago a hacienda', 'aplazamiento sin garantia', 'no puedo pagar un impuesto que hago', 'pedir un aplazamiento a hacienda'],
    respuesta:
      'Sí: puedes pedir a la AEAT un aplazamiento o fraccionamiento, que lleva intereses de demora. Si tus deudas pendientes no pasan de 50.000 € en conjunto, no tienes que aportar garantía. No se pueden aplazar, entre otras, las retenciones (modelos 111 y 115), los pagos fraccionados del Impuesto sobre Sociedades ni el IVA repercutido, salvo que justifiques que tus clientes no te lo han pagado. Pídelo dentro del plazo de presentación del impuesto.',
    fuente: BOE('BOE-A-2003-23186', 'a65', 'Ley 58/2003 General Tributaria, artículo 65, y Orden HFP/311/2023'),
    ...VERIFICADA,
    etiquetas: ['aplazar', 'aplazamiento', 'fraccionar', 'fraccionamiento', 'garantia', 'pagar', 'deuda'],
  },
  {
    id: 'lgt-prescripcion',
    bloque: 'general',
    pregunta: '¿Cuántos años puede revisarme Hacienda?',
    variantes: ['cuando prescribe un impuesto', 'hacienda puede revisar años anteriores', 'una inspeccion cuantos años atras mira', 'prescripcion tributaria cuatro años', 'cuanto tarda en prescribir una declaracion'],
    respuesta:
      'En general, cuatro años. El plazo empieza a contar el día siguiente al último día para presentar cada declaración. Una comprobación de Hacienda, un requerimiento o una declaración posterior sobre el mismo impuesto interrumpen el plazo y lo hacen empezar de nuevo. Las bases negativas y las deducciones que compensas en años posteriores se pueden comprobar durante diez años.',
    fuente: BOE('BOE-A-2003-23186', 'a66', 'Ley 58/2003 General Tributaria, artículos 66 a 68 y 66 bis'),
    ...VERIFICADA,
    etiquetas: ['prescripcion', 'prescribe', 'revisar', 'inspeccion', 'años', 'hacienda'],
  },

  // ---------------- Modelos: qué son y qué revisar ----------------
  {
    id: 'modelo-303-que-es',
    bloque: 'iva',
    pregunta: '¿Qué es el modelo 303 y qué reviso antes de presentarlo?',
    variantes: ['para que sirve el modelo 303', 'que revisar antes de presentar el iva', 'explicacion del modelo 303', 'que se declara en el 303', 'que es el 303'],
    respuesta:
      'Es la autoliquidación del IVA: al IVA de tus facturas emitidas le restas el IVA deducible de las recibidas en el periodo. El periodo es el trimestre, salvo para las grandes empresas (más de 6 millones de volumen) y quien está en la devolución mensual, entre otros, que lo hacen cada mes. Si sale a ingresar, se paga; si sale negativo, se compensa en los siguientes y en el último periodo del año se puede pedir la devolución. Antes de presentarlo, comprueba que están todas las facturas del periodo, que no quedan borradores y que no metes como deducibles gastos que no lo son.',
    fuente: BOE('BOE-A-1992-28925', 'a71', 'Reglamento del IVA (RD 1624/1992), artículo 71, y Ley del IVA, artículo 115'),
    ...VERIFICADA,
    enlaceApp: { texto: 'Ir al Modelo 303', href: '/dashboard/fiscal/modelo-303' },
    intencionRelacionada: 'INT-28',
    etiquetas: ['303', 'modelo', 'iva', 'autoliquidacion', 'revisar', 'trimestral'],
  },
  {
    id: 'modelo-390-que-es',
    bloque: 'iva',
    pregunta: '¿Qué es el modelo 390?',
    variantes: ['para que sirve el 390', 'resumen anual del iva que es', 'que reviso en el modelo 390', 'tengo que presentar el 390', 'declaracion resumen anual del iva'],
    respuesta:
      'Es la declaración resumen anual del IVA: recoge lo declarado en los 303 del año y con ella no se paga ni se devuelve nada. Hay contribuyentes exonerados de presentarla, según la orden ministerial que lo desarrolla. Antes de presentarla, comprueba que coincide con la suma de los periodos del año y, si rectificaste algún 303, usa las cifras definitivas.',
    fuente: BOE('BOE-A-1992-28925', 'a71', 'Reglamento del IVA (RD 1624/1992), artículo 71'),
    ...VERIFICADA,
    enlaceApp: { texto: 'Ir al Modelo 390', href: '/dashboard/fiscal/modelo-390' },
    intencionRelacionada: 'INT-30',
    etiquetas: ['390', 'modelo', 'resumen', 'anual', 'iva'],
  },
  {
    id: 'modelo-347-que-es',
    bloque: 'iva',
    pregunta: '¿Qué es el modelo 347 de operaciones con terceros?',
    variantes: ['para que sirve el 347', 'quien tiene que presentar el 347', 'limite de 3005 euros', 'declaracion de operaciones con terceros', 'que reviso en el modelo 347'],
    respuesta:
      'Es la declaración anual de operaciones con terceros. En ella va cada cliente y proveedor con el que, en conjunto, superaste 3.005,06 € en el año, con las ventas y las compras por separado y desglosadas por trimestres. No entran las operaciones que ya declaras en otras declaraciones periódicas, como las intracomunitarias del 349, ni las importaciones y exportaciones. Antes de presentarla, revisa que tus clientes y proveedores tienen bien el NIF y contrasta los importes con los más importantes para evitar discrepancias.',
    fuente: BOE('BOE-A-2007-15984', 'a33', 'Reglamento de gestión e inspección tributaria (RD 1065/2007), artículos 31 a 35'),
    ...VERIFICADA,
    enlaceApp: { texto: 'Ir al Modelo 347', href: '/dashboard/fiscal/modelo-347' },
    intencionRelacionada: 'INT-30',
    etiquetas: ['347', 'modelo', 'terceros', 'operaciones', '3005', 'anual'],
  },
  {
    id: 'modelo-349-que-es',
    bloque: 'iva',
    pregunta: '¿Qué es el modelo 349?',
    variantes: ['para que sirve el 349', 'declaracion recapitulativa de operaciones intracomunitarias', 'el 349 es mensual o trimestral', 'que reviso en el modelo 349', 'quien presenta el 349'],
    respuesta:
      'Es la declaración recapitulativa de operaciones intracomunitarias: las entregas y compras de bienes y los servicios con empresas de otros países de la UE, con el NIF-IVA de cada una. Por regla general se presenta cada mes, pero es trimestral si ni en el trimestre ni en los cuatro anteriores esas operaciones pasaron de 50.000 € sin IVA. Las entregas a otro país de la UE solo están exentas si aparecen en ella. Antes de presentarla, comprueba el país y el NIF-IVA de cada cliente y proveedor.',
    fuente: BOE('BOE-A-1992-28925', 'a81', 'Reglamento del IVA (RD 1624/1992), artículos 78 a 81'),
    ...VERIFICADA,
    enlaceApp: { texto: 'Ir a Modelos Fiscales', href: '/dashboard/fiscal' },
    intencionRelacionada: 'INT-30',
    etiquetas: ['349', 'modelo', 'intracomunitarias', 'recapitulativa', 'ue'],
  },
  {
    id: 'modelo-111-que-es',
    bloque: 'irpf',
    pregunta: '¿Qué es el modelo 111?',
    variantes: ['para que sirve el 111', 'modelo de retenciones de trabajadores y profesionales', 'que reviso en el modelo 111', 'quien presenta el 111', 'explicacion del modelo 111'],
    respuesta:
      'Con el modelo 111 se ingresan las retenciones de IRPF que la empresa o el autónomo ha practicado: las de las nóminas de sus trabajadores y las de las facturas de profesionales, entre otras. Se presenta cada trimestre, en los veinte primeros días de abril, julio, octubre y enero, y cada mes en las grandes empresas. Antes de presentarlo, comprueba que las facturas de profesionales con retención están registradas y que el total cuadra con el saldo de la cuenta 4751. El resumen anual es el modelo 190.',
    fuente: BOE('BOE-A-2007-6820', 'a108', 'Reglamento del IRPF (RD 439/2007), artículo 108'),
    ...VERIFICADA,
    enlaceApp: { texto: 'Ir al Modelo 111', href: '/dashboard/fiscal/modelo-111' },
    intencionRelacionada: 'INT-30',
    etiquetas: ['111', 'modelo', 'retenciones', 'irpf', 'nominas', 'profesionales'],
  },
  {
    id: 'modelo-115-que-es',
    bloque: 'irpf',
    pregunta: '¿Qué es el modelo 115?',
    variantes: ['para que sirve el 115', 'modelo de retenciones de alquileres', 'que reviso en el modelo 115', 'quien presenta el 115', 'explicacion del modelo 115'],
    respuesta:
      'Con el modelo 115 se ingresan las retenciones del alquiler de locales, oficinas o naves urbanos que pagas como inquilino, normalmente el 19 % de la renta sin IVA. Se presenta cada trimestre, en los veinte primeros días de abril, julio, octubre y enero. Antes de presentarlo, comprueba que las facturas del alquiler llevan la retención. En la app, el autorrelleno del 115 todavía no lee tus facturas de alquiler: revisa y completa las casillas a mano. El resumen anual es el modelo 180.',
    fuente: BOE('BOE-A-2007-6820', 'a100', 'Reglamento del IRPF (RD 439/2007), artículos 100 y 108'),
    ...VERIFICADA,
    enlaceApp: { texto: 'Ir al Modelo 115', href: '/dashboard/fiscal/modelo-115' },
    intencionRelacionada: 'INT-30',
    etiquetas: ['115', 'modelo', 'retenciones', 'alquiler', 'arrendamiento'],
  },
  {
    id: 'modelo-200-que-es',
    bloque: 'sociedades',
    pregunta: '¿Qué es el modelo 200 y qué reviso antes de presentarlo?',
    variantes: ['para que sirve el modelo 200', 'declaracion del impuesto de sociedades', 'que revisar antes del impuesto de sociedades', 'como se calcula el impuesto de sociedades', 'explicacion del modelo 200'],
    respuesta:
      'Es la declaración anual del Impuesto sobre Sociedades. Parte del resultado contable del ejercicio y le aplica los ajustes fiscales (gastos no deducibles, bases negativas de años anteriores y otros) para llegar a la base imponible y la cuota. Se presenta en los 25 días naturales siguientes a los seis meses del cierre: con ejercicio natural, en julio del año siguiente. Antes de presentarlo, aprueba los asientos pendientes, cierra el ejercicio en la app y revisa con tu asesor los ajustes y el tipo que te corresponde.',
    fuente: BOE('BOE-A-2014-12328', 'a124', 'Ley 27/2014 del Impuesto sobre Sociedades, artículo 124'),
    ...VERIFICADA,
    enlaceApp: { texto: 'Ir al Modelo 200', href: '/dashboard/fiscal/modelo-200' },
    intencionRelacionada: 'INT-18',
    etiquetas: ['200', 'modelo', 'sociedades', 'impuesto', 'anual', 'is'],
  },
];
