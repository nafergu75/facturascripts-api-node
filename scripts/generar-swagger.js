/* Genera src/docs/swagger.json con TODOS los endpoints de la API (Alta 6).
   Ejecutar tras anadir rutas: node scripts/generar-swagger.js */
const fs = require('fs');
const path = require('path');

const B = '/companies/{companyId}';
const sec = [{ bearerAuth: [] }];
const P = {};

function ep(ruta, method, tag, summary, opts = {}) {
  P[ruta] = P[ruta] || {};
  const o = { tags: [tag], summary, security: sec, responses: { 200: { description: 'OK' } } };
  const params = [];
  for (const m of ruta.match(/\{(\w+)\}/g) || []) {
    params.push({ name: m.slice(1, -1), in: 'path', required: true, schema: { type: 'string' } });
  }
  for (const q of opts.query || []) params.push({ name: q, in: 'query', required: false, schema: { type: 'string' } });
  if (params.length) o.parameters = params;
  if (opts.body) o.requestBody = { content: { 'application/json': { schema: { type: 'object', example: opts.body } } } };
  if (opts.noAuth) delete o.security;
  P[ruta][method] = o;
}

// --- Auth / publico ---
ep('/health', 'get', 'Sistema', 'Healthcheck', { noAuth: true });
ep('/auth/login', 'post', 'Auth', 'Login: token+refreshToken, esAdminGlobal y empresas. empresaCodigo opcional', { noAuth: true, body: { email: 'demo@empresa.com', password: 'demo1234', empresaCodigo: 'DEMO' } });
ep('/auth/refresh', 'post', 'Auth', 'Renueva el access token con un refresh token', { noAuth: true, body: { refreshToken: '...' } });
ep('/plan-contable/base/grupos', 'get', 'Plan contable', 'Grupos PGC-PYME (publico)', { noAuth: true });
ep('/plan-contable/base/subgrupos', 'get', 'Plan contable', 'Subgrupos PGC-PYME (publico)', { noAuth: true });
ep('/plan-contable/base/cuentas', 'get', 'Plan contable', 'Cuentas base PGC-PYME (publico)', { noAuth: true });

// --- Plataforma / admin ---
ep('/companies', 'get', 'Plataforma', 'Empresas del usuario autenticado');
ep('/companies/{id}', 'get', 'Plataforma', 'Detalle de empresa');
ep('/users', 'get', 'Plataforma', 'Listar usuarios (admin global)');
ep('/users/{id}', 'get', 'Plataforma', 'Detalle usuario (admin global)');
ep('/users', 'post', 'Plataforma', 'Crear usuario (admin global)', { body: { email: 'x@y.com', password: '***' } });
ep('/users/{id}', 'put', 'Plataforma', 'Actualizar usuario: isActive/password (admin global)');
ep('/users/{id}', 'delete', 'Plataforma', 'Baja logica de usuario (admin global)');
ep('/admin/empresas', 'get', 'Admin', 'Listar todas las empresas (admin global)');
ep('/admin/empresas', 'post', 'Admin', 'Crear empresa/instancia FS (admin global)', { body: { nombre: 'Mi SL', codigo: 'MISL', fsBaseUrl: 'http://host/api/3', fsApiKey: '***' } });
ep('/admin/usuarios', 'post', 'Admin', 'Crear usuario, opcional esAdminGlobal (admin global)', { body: { email: 'x@y.com', password: '***', esAdminGlobal: false } });
ep('/admin/usuarios/{userId}/empresas/{companyId}', 'post', 'Admin', 'Asignar usuario a empresa con rol', { body: { role: 'contable' } });

// --- Clientes / productos ---
ep(B + '/clientes', 'get', 'Clientes', 'Listado de clientes (paginado/filtrado)');
ep(B + '/clientes/buscar', 'get', 'Clientes', 'Buscador por nombre/NIF/email para facturar', { query: ['q', 'limit'] });
ep(B + '/clientes/{id}', 'get', 'Clientes', 'Detalle de cliente');
ep(B + '/clientes', 'post', 'Clientes', 'Crear cliente en FacturaScripts');
ep(B + '/clientes/{id}', 'put', 'Clientes', 'Actualizar cliente');
ep(B + '/clientes/{id}', 'delete', 'Clientes', 'Eliminar cliente');
ep(B + '/productos', 'get', 'Productos', 'Catalogo de productos (FS productos)', { query: ['limit', 'offset', 'referencia'] });
ep(B + '/inventario', 'get', 'Productos', 'Inventario (501 pendiente)');
ep(B + '/proveedores', 'get', 'Proveedores', 'Listado de proveedores');
ep(B + '/proveedores/buscar', 'get', 'Proveedores', 'Buscador por nombre/NIF/email', { query: ['q', 'limit'] });
ep(B + '/proveedores', 'post', 'Proveedores', 'Crear proveedor');
ep(B + '/compras', 'get', 'Compras', 'Facturas de gasto (facturaproveedores)', { query: ['page', 'pageSize', 'desde', 'hasta'] });
ep(B + '/compras/{id}', 'get', 'Compras', 'Detalle de factura de gasto');

// --- Facturas / documentos / series ---
ep(B + '/facturas', 'get', 'Facturas', 'Listado con estadoCobro/importeCobrado/importePendiente', { query: ['page', 'pageSize', 'desde', 'hasta', 'clienteCodigo'] });
ep(B + '/facturas/{id}', 'get', 'Facturas', 'Detalle con estado de cobro');
ep(B + '/facturas', 'post', 'Facturas', 'Crear factura (serieId/serieCodigo opcional -> codserie FS)', { body: { codcliente: '1', fecha: '2026-06-01', serieCodigo: 'A', lineas: [{ descripcion: 'Servicio', cantidad: 1, pvpunitario: 100, iva: 21 }] } });
ep(B + '/facturas/{facturaId}/contabilizar', 'post', 'Facturas', 'Genera asiento + vencimientos (IVA, IRPF, recargo, dto global, divisa, abonos)');
ep(B + '/facturas/ingreso', 'post', 'Facturas', 'Crear factura de INGRESO (cliente existente/nuevo + serie + lineas con IVA/retencion). Crea factura+lineas+totales en FS', { body: { customer: { nuevo: { nombreFiscal: 'Cliente SA', nifCif: 'B12345678', email: 'c@x.com' } }, serie: 'A', fechaEmision: '2026-05-10', lineas: [{ descripcion: 'Consultoria', cantidad: 1, precioUnitario: 1000, tipoIva: 21, tipoRetencion: 15 }] } });
ep(B + '/facturas/{id}/estado', 'patch', 'Facturas', 'Cambiar estado: PAID liquida el pendiente (asiento de cobro)', { body: { estado: 'PAID', fechaCobro: '2026-05-20', metodoCobro: 'TRANSFERENCIA' } });
ep(B + '/facturas/{id}/rectificativa', 'post', 'Facturas', 'Factura rectificativa (abono) enlazada a la original');
ep(B + '/facturas/{id}/send-email', 'post', 'Facturas', 'Enviar factura por email (TODO SMTP + PDF)');
ep(B + '/facturas/{id}/recurrente', 'post', 'Facturas', 'Convertir en factura periodica (TODO recurrencia + job)');
ep(B + '/facturas/{id}/cobros', 'post', 'Tesoreria', 'Cobro directo VIA UNICA: vencimiento + asiento 572<->430', { body: { importe: 121, fecha: '2026-06-10', formaPago: 'TRANSFERENCIA' } });
ep(B + '/facturas/{id}/vencimientos', 'get', 'Tesoreria', 'Vencimientos de la factura');
ep(B + '/facturas/vencimientos/{vencimientoId}/liquidar', 'post', 'Tesoreria', 'Liquidar vencimiento (genera asiento de tesoreria)', { body: { fecha: '2026-06-10', formaPago: 'TRANSFERENCIA' } });
ep(B + '/facturas/{id}/huellas', 'get', 'VeriFactu', 'Cadena de huellas SHA-256 de la factura');
ep(B + '/facturas/{id}/huellas', 'post', 'VeriFactu', 'Registrar huella de inalterabilidad');
ep(B + '/pedidos', 'get', 'Documentos', 'Listado de pedidos');
ep(B + '/albaranes', 'get', 'Documentos', 'Listado de albaranes');
ep(B + '/presupuestos', 'get', 'Documentos', 'Listado de presupuestos');
ep(B + '/series', 'get', 'Series', 'Series de numeracion', { query: ['tipoDocumento'] });
ep(B + '/series', 'post', 'Series', 'Crear serie (porDefecto desmarca las demas del tipo)', { body: { codigo: 'B2026', descripcion: '', tipoDocumento: 'FACTURA', porDefecto: true } });
ep(B + '/series/{id}', 'put', 'Series', 'Actualizar serie');

// --- Lector de facturas ---
ep(B + '/facturas/lector/upload', 'post', 'Lector de facturas', 'Subir PDF/imagen/XML (multipart campo archivo | binario | base64). XML Facturae se parsea automaticamente');
ep(B + '/facturas/lector', 'get', 'Lector de facturas', 'Listado de facturas leidas');
ep(B + '/facturas/lector/{id}', 'get', 'Lector de facturas', 'Detalle del borrador');
ep(B + '/facturas/lector/{id}', 'put', 'Lector de facturas', 'Corregir borrador tras la extraccion');
ep(B + '/facturas/lector/{id}/crear-factura', 'post', 'Lector de facturas', 'Crear factura oficial + contabilidad (alta automatica de tercero por NIF)', { query: ['tipo'] });

// --- Contabilidad / plan contable ---
ep(B + '/contabilidad/asientos', 'get', 'Contabilidad', 'Asientos (lectura)');
ep(B + '/reglas-contables', 'get', 'Contabilidad', 'Reglas contables de la empresa');
ep(B + '/reglas-contables', 'put', 'Contabilidad', 'Guardar reglas (merge sobre defaults)');
ep(B + '/plan-contable/subcuentas', 'get', 'Plan contable', 'Subcuentas de la empresa');
ep(B + '/plan-contable/subcuentas', 'post', 'Plan contable', 'Crear subcuenta');
ep(B + '/plan-contable/subcuentas/gasto-rapido', 'post', 'Plan contable', 'Alta rapida de subcuenta de GASTO (codigo correlativo 627xxxx)', { body: { cuentaBaseCodigo: '627', nombre: 'Luz oficina' } });
ep(B + '/plan-contable/subcuentas/{id}', 'put', 'Plan contable', 'Actualizar subcuenta');
ep(B + '/plan-contable/subcuentas/{id}', 'delete', 'Plan contable', 'Desactivar subcuenta');
ep(B + '/plantillas', 'get', 'Plantillas', 'Plantillas de documento');
ep(B + '/conciliacion/proponer', 'post', 'Conciliacion', 'Propuestas de conciliacion (scoring importe/fecha/texto)');
ep(B + '/reportes/libro-iva-ingresos.csv', 'get', 'Reportes', 'Libro de registro de IVA de INGRESOS (siempre año completo, requisito AEAT)', { query: ['ejercicio'] });
ep(B + '/reportes/libro-iva-gastos.csv', 'get', 'Reportes', 'Libro de registro de IVA de GASTOS (siempre año completo)', { query: ['ejercicio'] });
ep(B + '/reportes/perdidas-ganancias.csv', 'get', 'Reportes', 'Informe P&G por mes (filtra por periodo 0A|1T..4T|01..12)', { query: ['ejercicio', 'periodo'] });
ep(B + '/reportes/export-a3.dat', 'get', 'Reportes', 'Exportacion a A3 (suenlace.dat, layout provisional TODO formato oficial)', { query: ['ejercicio'] });
ep(B + '/reportes/gastos-rechazados.csv', 'get', 'Reportes', 'Gastos rechazados/pendientes del lector (informe para gestorias)');
ep(B + '/reportes/libro-diario.csv', 'get', 'Reportes', 'Libro diario CSV', { query: ['ejercicio'] });
ep(B + '/reportes/mayor.csv', 'get', 'Reportes', 'Mayor CSV', { query: ['ejercicio'] });
ep(B + '/reportes/margen.csv', 'get', 'Reportes', 'Margen por cliente CSV', { query: ['ejercicio'] });
ep(B + '/sugerencias/subcuenta-tercero', 'get', 'Contabilidad', 'Siguiente subcuenta correlativa de tercero');

// --- Modulo Impuestos (estilo Quipu) ---
ep(B + '/impuestos/modelos', 'get', 'Impuestos', 'Calendario fiscal: vigentes (verde) / expirados (naranja) con dias hasta/desde vencimiento', { query: ['ejercicio', 'tab'] });
ep(B + '/impuestos/modelos/{modeloId}', 'get', 'Impuestos', 'Detalle: ficha explicativa + casillas + origen');
ep(B + '/impuestos/modelos/{modeloId}/recalcular', 'post', 'Impuestos', 'Recalcular importes: autorrelleno desde contabilidad + config (NIF/IBAN). Guarda automaticamente y PISA lo manual');
ep(B + '/impuestos/modelos/{modeloId}', 'put', 'Impuestos', 'Guardar cambios manuales (no recalcula totales dependientes)', { body: { casillas: { '01_base_devengada': 999 } } });
ep(B + '/impuestos/modelos/{modeloId}/omitir', 'post', 'Impuestos', 'Omitir modelo (pasa a pestana omitidos)');
ep(B + '/impuestos/modelos/{modeloId}/recuperar', 'post', 'Impuestos', 'Recuperar modelo omitido');
ep(B + '/impuestos/modelos/{modeloId}/listo-para-presentar', 'post', 'Impuestos', 'Marcar listo para presentar (pestana presentados)');
ep(B + '/impuestos/modelos/{modeloId}/no-presentado', 'post', 'Impuestos', 'Volver a la lista principal');
ep(B + '/impuestos/modelos/{modeloId}/txt', 'get', 'Impuestos', 'TXT AEAT del modelo (diseno BOE, ISO-8859-1)');
ep(B + '/impuestos/modelos/{modeloId}/pdf', 'get', 'Impuestos', 'Copia en PDF del modelo');
ep(B + '/impuestos/ingresos-gastos/excel', 'get', 'Impuestos', 'Excel de ingresos y gastos del periodo para validar antes de presentar', { query: ['ejercicio', 'periodo'] });
ep(B + '/impuestos/calculate', 'get', 'Impuestos', 'Casillas oficiales calculadas desde facturas (303: filas [01]-[09] por tipo de IVA; 111: trabajo+profesionales)', { query: ['model_type', 'year', 'period'] });
ep(B + '/impuestos/generate-pdf', 'post', 'Impuestos', 'PDF a partir de un JSON de casillas (p.ej. editadas en el front)', { body: { modelo: '303', ejercicio: 2026, periodo: '1T', casillas: { '01_base_devengada_21': 1000 } } });

// --- AEAT ---
for (const m of ['303', '390', '347', '349', '111', '115']) {
  const q = m === '303' ? ['ejercicio', 'periodo', 'aCompensar'] : ['ejercicio', 'periodo'];
  ep(B + '/aeat/modelo-' + m + '/preview', 'get', 'AEAT', 'Modelo ' + m + ': calculo (JSON)', { query: q });
  ep(B + '/aeat/modelo-' + m + '/fichero', 'get', 'AEAT', 'Modelo ' + m + ': fichero BOE (ISO-8859-1)', { query: [...q, 'nif'] });
}
ep(B + '/modelo-200/preview', 'get', 'AEAT', 'Modelo 200 (IS): calculo', { query: ['ejercicio'] });
ep(B + '/modelo-200/fichero', 'get', 'AEAT', 'Modelo 200: fichero BOE (identificacion)', { query: ['ejercicio', 'nif'] });
ep(B + '/cuentas-anuales/preview', 'get', 'Cuentas anuales', 'Balance+PyG+ECPN+EFE', { query: ['ejercicio'] });
ep(B + '/cuentas-anuales/libro-diario', 'get', 'Cuentas anuales', 'Libro diario', { query: ['ejercicio'] });
ep(B + '/cuentas-anuales/libro-inventarios', 'get', 'Cuentas anuales', 'Libro de inventarios', { query: ['ejercicio'] });
ep(B + '/cuentas-anuales/efe', 'get', 'Cuentas anuales', 'Estado de flujos de efectivo', { query: ['ejercicio'] });

// --- Bancos / tesoreria / cierre ---
ep(B + '/bancos/cuentas', 'get', 'Bancos', 'Cuentas bancarias');
ep(B + '/bancos/cuentas', 'post', 'Bancos', 'Crear cuenta bancaria (subcuenta 572xxx)');
ep(B + '/bancos/movimientos', 'get', 'Bancos', 'Movimientos importados', { query: ['cuentaId'] });
ep(B + '/bancos/cuentas/{cuentaId}/importar-csv', 'post', 'Bancos', 'Importar extracto CSV (fecha;importe;concepto;referencia)');
ep(B + '/bancos/movimientos/{movId}/conciliar-factura', 'post', 'Bancos', 'Conciliar movimiento con factura: cobro contabilizado (patron Quipu)', { body: { facturaId: '5' } });
ep(B + '/bancos/movimientos/{movId}/conciliar-cuenta', 'post', 'Bancos', 'Conciliar movimiento con cuenta contable (555 pendientes de aplicacion, 526...)', { body: { subcuenta: '5550000000' } });
ep(B + '/extractos/cuentas/{cuentaId}/extracto', 'get', 'Bancos', 'Extracto con saldo acumulado', { query: ['desde', 'hasta', 'saldoInicial'] });
ep(B + '/extractos/cuentas/{cuentaId}/extracto.csv', 'get', 'Bancos', 'Extracto CSV descargable');
ep(B + '/extractos/cuentas/{cuentaId}/revision', 'get', 'Bancos', 'Revision extracto vs contabilidad 57x', { query: ['ejercicio'] });
ep(B + '/cuadre-bancos', 'get', 'Cierre', 'Cuadre saldo contable 57x vs extracto por cuenta', { query: ['ejercicio'] });
ep(B + '/cuadre-bancos/chequeo-cierre', 'get', 'Cierre', 'Chequeo previo al cierre (config + cuadre)', { query: ['ejercicio'] });
ep(B + '/cuadre-bancos/config', 'get', 'Cierre', 'Config de cierre (exigirCuadreBancos, tolerancia)');
ep(B + '/cuadre-bancos/config', 'put', 'Cierre', 'Actualizar config de cierre');
ep(B + '/periodos', 'get', 'Cierre', 'Periodos del ejercicio (persistidos en BD)', { query: ['ejercicio'] });
ep(B + '/periodos/{mes}/estado', 'put', 'Cierre', 'Cambiar estado del periodo', { body: { estado: 'cerrado' } });
ep(B + '/periodos/cierre', 'post', 'Cierre', 'CIERRE REAL: regularizacion+cierre+apertura. 409 si bancos descuadran', { query: ['ejercicio'] });
ep(B + '/nominas', 'get', 'Nominas', 'Resumenes de nominas');
ep(B + '/compliance/alertas', 'get', 'Compliance', 'Alertas IVA/347', { query: ['ejercicio'] });

// --- Asistente "Carmen" (chat contable con RAG) ---
ep(B + '/chat-assistant', 'post', 'Carmen (Asistente)', 'Pregunta a Carmen. Recupera contexto (RAG) sobre la base de conocimiento contable y responde con Claude. Devuelve { response, sources, suggestions, sessionId }. Si sessionId va vacio se crea uno nuevo.', { body: { message: '¿Por qué tengo un asiento pendiente de revisión?', sessionId: '', currentPage: '/contabilidad/asientos' } });
ep(B + '/chat-assistant/{sessionId}/messages', 'get', 'Carmen (Asistente)', 'Historial de mensajes de una sesion de chat (orden cronologico)');

const doc = {
  openapi: '3.0.3',
  info: {
    title: 'FacturaScripts BFF API',
    version: '1.0.0',
    description:
      'API Node multiempresa sobre FacturaScripts: facturacion, contabilidad inteligente (asientos, IVA, IRPF, recargo, divisa, abonos), tesoreria (vencimientos, cobros con asiento, conciliacion bancaria estilo Quipu, cuenta 555), modelos AEAT BOE (303/390/347/349/111/115/200, ISO-8859-1), cuentas anuales, lector de facturas (Facturae XML; OCR PDF/imagen TODO), cierre de ejercicio con bloqueo por descuadre de bancos, RBAC y admin global.',
  },
  servers: [{ url: 'http://localhost:3000' }],
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
  paths: P,
};

const destino = path.join(__dirname, '..', 'src', 'docs', 'openapi.json');
fs.writeFileSync(destino, JSON.stringify(doc, null, 2));
const ops = Object.values(P).reduce((a, p) => a + Object.keys(p).length, 0);
console.log('swagger.json generado: ' + Object.keys(P).length + ' rutas, ' + ops + ' operaciones');
