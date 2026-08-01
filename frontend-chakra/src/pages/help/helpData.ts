/**
 * Base de conocimiento de ayuda: fuente única de verdad para la página /ayuda
 * (buscador) y para los textos de HelpTooltip (vía getHelpSnippet). Cambiar
 * un texto aquí lo actualiza en ambos sitios sin duplicar contenido.
 */

export type HelpArticle = {
  id: string;
  title: string;
  module: 'lector' | 'contabilidad' | 'informes' | 'seguridad' | 'general';
  content: string;
  keywords: string[];
};

export const helpArticles: HelpArticle[] = [
  // --- Lector de facturas ---
  {
    id: 'lector-flujo-basico',
    module: 'lector',
    title: 'Cómo funciona el lector de facturas',
    content:
      'El lector oficial del sistema (income-reader) permite subir facturas en PDF o imagen. Extrae automáticamente número, fecha, NIF, emisor y totales (base, IVA, retención) usando Claude (visión). Una vez leída, revisas los datos antes de crear la factura de ingreso en contabilidad.',
    keywords: ['lector', 'facturas', 'ocr', 'income-reader', 'pdf', 'subir', 'upload', 'claude'],
  },
  {
    id: 'lector-ocr-no-detecta',
    module: 'lector',
    title: 'Qué pasa si el lector no detecta ningún dato',
    content:
      'La extracción usa Claude (visión) cuando hay una clave ANTHROPIC_API_KEY configurada en el backend. Si no la hay, o el archivo no es un PDF/imagen legible, el documento llega con los campos vacíos y confianza 0%. En ese caso puedes rellenarlos manualmente: el sistema no bloquea esa edición antes de crear la factura.',
    keywords: ['ocr', 'claude', 'confianza', 'vacío', 'no detecta', 'manual', 'anthropic'],
  },
  {
    id: 'lector-modo-demo',
    module: 'lector',
    title: 'Modo demo del lector',
    content:
      'En /lector?demo=1 puedes probar el flujo completo (subir, leer, editar, simular creación de factura de ingreso o de gasto) sin backend y sin que nada se guarde en la empresa real. Es útil para enseñar el producto sin configurar nada.',
    keywords: ['demo', 'simular', 'ejemplo', 'prueba'],
  },
  {
    id: 'lector-demo-vs-real',
    module: 'lector',
    title: 'Diferencia entre el lector demo y el lector real',
    content:
      'El lector demo simula la lectura con 3 patrones fijos y nunca llama a la API: nada se guarda, ideal para mostrar el flujo sin backend. El lector real (income-reader) sube el archivo de verdad, lo guarda y crea un documento que pasa a "lista para revisar" en el backend; los datos los extrae Claude (visión) si hay ANTHROPIC_API_KEY configurada, o quedan vacíos para completar a mano si no la hay. Se entra en demo automáticamente si la API no responde, o se fuerza con ?demo=1 en la URL.',
    keywords: ['demo', 'real', 'diferencia', 'simular', 'api', 'backend', 'income-reader', 'claude'],
  },

  // --- Contabilidad ---
  {
    id: 'contabilidad-estados-factura',
    module: 'contabilidad',
    title: 'Estados de la factura: DRAFT, CONFIRMED, ACCOUNTED',
    content:
      'Una factura de gasto pasa por tres estados: DRAFT (borrador), CONFIRMED (confirmada, lista para contabilizar) y ACCOUNTED (ya tiene un asiento contable generado). Las facturas de ingreso usan un campo de estado orientado al cobro (PENDING, PAID, OVERDUE) que se sustituye por ACCOUNTED en el momento de contabilizar. En ambos casos, confirmar la factura dispara la contabilización automática.',
    keywords: ['draft', 'confirmed', 'accounted', 'pending', 'estado', 'factura'],
  },
  {
    id: 'contabilidad-generar-asiento',
    module: 'contabilidad',
    title: 'Cómo se genera el asiento contable',
    content:
      'Al confirmar una factura, el motor contable genera automáticamente el asiento según el Plan General Contable: cuentas de cliente o proveedor (430/400), ventas o compras (700/600), IVA repercutido o soportado (477/472) y retención IRPF (473/4751) cuando corresponde.',
    keywords: ['asiento', 'pgc', 'contabilizar', 'iva', 'retención', 'motor contable'],
  },
  {
    id: 'contabilidad-draft-posted',
    module: 'contabilidad',
    title: 'Diferencia entre asiento DRAFT y POSTED',
    content:
      'Aprueba el asiento y lo marca como contabilizado definitivamente. Pasa de DRAFT o PENDING_REVIEW (ambos editables, pendientes de aprobar) a POSTED: ya no se puede editar, y a partir de ese momento cuenta para los informes oficiales (Balance, PyG, IVA, retenciones).',
    keywords: ['draft', 'posted', 'pending_review', 'aprobar', 'asiento', 'definitivo'],
  },
  {
    id: 'contabilidad-recalcular-bloqueado',
    module: 'contabilidad',
    title: 'Recalcular asiento (no disponible actualmente)',
    content:
      'Recalcular un asiento desde una factura modificada no está disponible en esta versión: la API devuelve un error explícito (501) para no generar asientos vacíos o incorrectos. Si necesitas corregir un asiento ya creado, usa "Ajustar línea" en su detalle para modificar una cuenta o un importe puntual.',
    keywords: ['recalcular', 'bloqueado', '501', 'ajustar línea', 'corregir', 'pendiente'],
  },

  // --- Informes y exportaciones ---
  {
    id: 'informes-resumen',
    module: 'informes',
    title: 'Qué informes hay disponibles',
    content:
      'El sistema calcula Balance de situación, Pérdidas y Ganancias, Mayor de cuentas, ingresos, gastos, IVA, retenciones IRPF y tesorería. Todos se calculan a partir de asientos en estado POSTED: los borradores nunca aparecen en un informe.',
    keywords: ['informes', 'balance', 'pyg', 'mayor', 'ingresos', 'gastos', 'tesorería'],
  },
  {
    id: 'informes-iva-retenciones-oficiales',
    module: 'informes',
    title: 'Qué informes son oficiales para IVA y retenciones',
    content:
      'El libro de IVA y el libro de retenciones reflejan solo asientos POSTED, que es el criterio correcto para presentar el modelo 303 (IVA) y el modelo 111 (retenciones). El modelo 200 (Impuesto de Sociedades) es un cálculo simplificado orientativo: revísalo siempre con un asesor fiscal antes de presentarlo.',
    keywords: ['303', '111', '200', 'modelo', 'oficial', 'iva', 'retenciones', 'presentar'],
  },
  {
    id: 'informes-exportar',
    module: 'informes',
    title: 'Cómo exportar un informe (CSV, Excel, PDF)',
    content:
      'Descarga el informe actual en CSV, Excel o PDF desde el botón "Exportar". CSV es texto separado por comas y se abre en Excel; Excel genera un .xlsx nativo; PDF abre el diálogo de impresión del navegador para guardarlo. Ningún formato requiere generación en el servidor.',
    keywords: ['exportar', 'csv', 'excel', 'pdf', 'descargar', 'imprimir'],
  },

  // --- Seguridad y acceso ---
  {
    id: 'seguridad-sesion',
    module: 'seguridad',
    title: 'Cómo funciona la sesión y el acceso por empresa',
    content:
      'El acceso se controla con un token de sesión (JWT) válido 24 horas. Cada usuario puede tener acceso a una o varias empresas, cada una con un rol distinto (lectura, contable, ventas, administración). Cerrar sesión revoca el token de forma inmediata.',
    keywords: ['sesión', 'login', 'jwt', 'token', 'empresa', 'rol', 'permisos'],
  },
  {
    id: 'seguridad-cierre-sesion',
    module: 'seguridad',
    title: 'Qué pasa si mi sesión expira',
    content:
      'La sesión dura 24 horas y hoy no se renueva sola: al expirar, el sistema te lleva de vuelta a la pantalla de inicio de sesión y tienes que volver a entrar con tu email y contraseña.',
    keywords: ['expirar', 'sesión', 'logout', 'renovar', 'refresh'],
  },
];

/**
 * Devuelve una frase breve de un articulo de ayuda, pensada para usarse como
 * label de un HelpTooltip sin duplicar el texto en dos sitios. Si el articulo
 * no existe, devuelve cadena vacia (HelpTooltip simplemente no mostraria nada
 * util, pero no rompe).
 */
export function getHelpSnippet(id: string): string {
  const articulo = helpArticles.find((a) => a.id === id);
  if (!articulo) return '';
  const primeraOracion = articulo.content.split(/(?<=[.!?])\s/)[0];
  return primeraOracion;
}
