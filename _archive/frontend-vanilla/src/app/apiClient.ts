import {
  ClienteResumen,
  CuentaBancaria,
  EmpresaSesion,
  ExtractoBancario,
  FacturaResumen,
  FiltrosFacturas,
  MovimientoBancario,
  Paginado,
  RevisionExtracto,
  Sesion,
} from './types';

/**
 * Cliente REST global del front. Encapsula TODAS las llamadas al backend
 * (el modulo Impuestos tiene ademas su propio ImpuestosApiClient, compatible).
 * Las respuestas del backend vienen envueltas en { ok, data }.
 */
export class ApiClient {
  constructor(
    public readonly baseUrl: string,
    private token = '',
    public companyId = '',
  ) {}

  setSesion(token: string, companyId: string): void {
    this.token = token;
    this.companyId = companyId;
  }

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body as { message?: string }).message ?? `HTTP ${res.status}`);
    return (body as { data: T }).data;
  }

  private co(path: string): string {
    return `/companies/${this.companyId}${path}`;
  }

  // --- Auth / sesion ---
  async login(email: string, password: string): Promise<Sesion> {
    const d = await this.req<{
      token: string;
      user: { email: string; esAdminGlobal: boolean };
      empresas: EmpresaSesion[];
    }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    const companyId = d.empresas[0]?.companyId ?? '';
    this.setSesion(d.token, companyId);
    return { token: d.token, email: d.user.email, esAdminGlobal: d.user.esAdminGlobal, companyId, empresas: d.empresas };
  }

  // --- Ventas ---
  getFacturas(filtros: FiltrosFacturas = {}): Promise<Paginado<FacturaResumen>> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filtros)) if (v !== undefined && v !== '') q.set(k, String(v));
    return this.req(this.co(`/facturas?${q.toString()}`));
  }
  getFactura(id: string): Promise<FacturaResumen> {
    return this.req(this.co(`/facturas/${id}`));
  }
  contabilizarFactura(id: string): Promise<unknown> {
    return this.req(this.co(`/facturas/${id}/contabilizar`), { method: 'POST' });
  }
  registrarCobro(id: string, importe: number, fecha: string, formaPago?: string): Promise<unknown> {
    return this.req(this.co(`/facturas/${id}/cobros`), { method: 'POST', body: JSON.stringify({ importe, fecha, formaPago }) });
  }
  buscarClientes(q: string, limit = 10): Promise<ClienteResumen[]> {
    return this.req(this.co(`/clientes/buscar?q=${encodeURIComponent(q)}&limit=${limit}`));
  }

  // --- Bancos / extractos ---
  getCuentasBancarias(): Promise<CuentaBancaria[]> {
    return this.req(this.co('/bancos/cuentas'));
  }
  getMovimientos(cuentaId?: string): Promise<MovimientoBancario[]> {
    return this.req(this.co(`/bancos/movimientos${cuentaId ? `?cuentaId=${cuentaId}` : ''}`));
  }
  getExtracto(cuentaId: string, rango: { desde?: string; hasta?: string } = {}): Promise<ExtractoBancario> {
    const q = new URLSearchParams();
    if (rango.desde) q.set('desde', rango.desde);
    if (rango.hasta) q.set('hasta', rango.hasta);
    return this.req(this.co(`/extractos/cuentas/${cuentaId}/extracto?${q.toString()}`));
  }
  getRevisionExtracto(cuentaId: string, ejercicio: number): Promise<RevisionExtracto> {
    return this.req(this.co(`/extractos/cuentas/${cuentaId}/revision?ejercicio=${ejercicio}`));
  }
  async importarCsv(cuentaId: string, csv: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${this.co(`/bancos/cuentas/${cuentaId}/importar-csv`)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'text/plain' },
      body: csv,
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
    return body.data;
  }
  conciliarMovimientoConFactura(movId: string, facturaId: string): Promise<unknown> {
    return this.req(this.co(`/bancos/movimientos/${movId}/conciliar-factura`), { method: 'POST', body: JSON.stringify({ facturaId }) });
  }
  conciliarMovimientoConCuenta(movId: string, subcuenta?: string): Promise<unknown> {
    return this.req(this.co(`/bancos/movimientos/${movId}/conciliar-cuenta`), { method: 'POST', body: JSON.stringify({ subcuenta }) });
  }

  // --- Clientes / proveedores / productos / compras ---
  getClientes(limit = 100, offset = 0): Promise<Paginado<Record<string, unknown>>> {
    return this.req(this.co(`/clientes?limit=${limit}&offset=${offset}`));
  }
  crearCliente(data: { nombre: string; cifnif: string; email?: string; telefono?: string }): Promise<Record<string, unknown>> {
    // FS guarda el telefono en `telefono1`; mapeamos desde el campo unico del form.
    const { telefono, ...resto } = data;
    return this.req(this.co('/clientes'), { method: 'POST', body: JSON.stringify({ ...resto, razonsocial: data.nombre, telefono1: telefono }) });
  }
  actualizarCliente(codcliente: string, patch: { nombre?: string; email?: string; telefono?: string }): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {};
    if (patch.nombre !== undefined) { body.nombre = patch.nombre; body.razonsocial = patch.nombre; }
    if (patch.email !== undefined) body.email = patch.email;
    if (patch.telefono !== undefined) body.telefono1 = patch.telefono;
    return this.req(this.co(`/clientes/${codcliente}`), { method: 'PUT', body: JSON.stringify(body) });
  }
  getProveedores(limit = 100, offset = 0): Promise<Paginado<Record<string, unknown>>> {
    return this.req(this.co(`/proveedores?limit=${limit}&offset=${offset}`));
  }
  buscarProveedores(q: string, limit = 10): Promise<ClienteResumen[]> {
    return this.req(this.co(`/proveedores/buscar?q=${encodeURIComponent(q)}&limit=${limit}`));
  }
  crearProveedor(data: { nombre: string; cifnif: string; email?: string; telefono?: string }): Promise<Record<string, unknown>> {
    const { telefono, ...resto } = data;
    return this.req(this.co('/proveedores'), { method: 'POST', body: JSON.stringify({ ...resto, razonsocial: data.nombre, telefono1: telefono }) });
  }
  actualizarProveedor(codproveedor: string, patch: { nombre?: string; email?: string; telefono?: string }): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {};
    if (patch.nombre !== undefined) { body.nombre = patch.nombre; body.razonsocial = patch.nombre; }
    if (patch.email !== undefined) body.email = patch.email;
    if (patch.telefono !== undefined) body.telefono1 = patch.telefono;
    return this.req(this.co(`/proveedores/${codproveedor}`), { method: 'PUT', body: JSON.stringify(body) });
  }
  getProductos(limit = 100, offset = 0): Promise<Paginado<Record<string, unknown>>> {
    return this.req(this.co(`/productos?limit=${limit}&offset=${offset}`));
  }
  getCompras(filtros: FiltrosFacturas = {}): Promise<Paginado<Record<string, unknown>>> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filtros)) if (v !== undefined && v !== '') q.set(k, String(v));
    return this.req(this.co(`/compras?${q.toString()}`));
  }
  contabilizarCompra(id: string): Promise<unknown> {
    return this.req(this.co(`/facturas/${id}/contabilizar`), { method: 'POST', body: JSON.stringify({ tipo: 'compra' }) });
  }

  // --- Bancos: alta de cuenta ---
  crearCuentaBancaria(data: { iban: string; subcuentaCodigo: string; bancoNombre?: string }): Promise<CuentaBancaria> {
    return this.req(this.co('/bancos/cuentas'), { method: 'POST', body: JSON.stringify(data) });
  }

  // --- Contabilidad ---
  getLibroDiario(ejercicio: number): Promise<unknown> {
    return this.req(this.co(`/cuentas-anuales/libro-diario?ejercicio=${ejercicio}`));
  }
  getSubcuentas(): Promise<Array<Record<string, unknown>>> {
    return this.req(this.co('/plan-contable/subcuentas'));
  }
  crearSubcuentaGasto(cuentaBaseCodigo: string, nombre: string): Promise<Record<string, unknown>> {
    return this.req(this.co('/plan-contable/subcuentas/gasto-rapido'), { method: 'POST', body: JSON.stringify({ cuentaBaseCodigo, nombre }) });
  }
  getPlanBaseCuentas(): Promise<Array<{ codigo: string; nombre: string; tipo: string }>> {
    return this.req('/plan-contable/base/cuentas');
  }

  // --- Cierres / periodos ---
  getPeriodos(ejercicio: number): Promise<Array<{ id: string; mes: number; estado: string }>> {
    return this.req(this.co(`/periodos?ejercicio=${ejercicio}`));
  }
  cambiarEstadoPeriodo(ejercicio: number, mes: number, estado: string): Promise<unknown> {
    return this.req(this.co(`/periodos/${mes}/estado?ejercicio=${ejercicio}`), { method: 'PUT', body: JSON.stringify({ estado }) });
  }
  getChequeoCierre(ejercicio: number): Promise<{ puedeCerrar: boolean; motivo: string | null; cuadre: { cuentas: unknown[]; todasCuadran: boolean; totalDiferencia: number } }> {
    return this.req(this.co(`/cuadre-bancos/chequeo-cierre?ejercicio=${ejercicio}`));
  }
  ejecutarCierre(ejercicio: number): Promise<unknown> {
    return this.req(this.co(`/periodos/cierre?ejercicio=${ejercicio}`), { method: 'POST' });
  }

  // --- Impuesto de Sociedades / Cuentas anuales ---
  getModelo200(ejercicio: number): Promise<Record<string, unknown>> {
    return this.req(this.co(`/modelo-200/preview?ejercicio=${ejercicio}`));
  }
  getCuentasAnuales(ejercicio: number): Promise<Record<string, unknown>> {
    return this.req(this.co(`/cuentas-anuales/preview?ejercicio=${ejercicio}`));
  }

  // --- Lector de facturas (LEGACY) ---
  // Estos métodos llaman al lector LEGACY del backend (/facturas/lector). El
  // lector canónico es income-reader (/income-reader), consumido por el
  // frontend Chakra. No añadir aquí métodos de lector nuevos: las rutas legacy
  // responden con cabecera Deprecation. Ver ADR "Consolidación de lector OCR".
  getFacturasLeidas(): Promise<Array<Record<string, unknown>>> {
    return this.req(this.co('/facturas/lector'));
  }
  async subirFacturaLector(file: File): Promise<Record<string, unknown>> {
    const base64 = btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())));
    return this.req(this.co('/facturas/lector/upload'), {
      method: 'POST',
      body: JSON.stringify({ nombreArchivo: file.name, mimeType: file.type || 'application/octet-stream', contenidoBase64: base64 }),
    });
  }
  crearFacturaDesdeLector(id: string, tipo: 'venta' | 'compra'): Promise<unknown> {
    return this.req(this.co(`/facturas/lector/${id}/crear-factura?tipo=${tipo}`), { method: 'POST' });
  }

  // --- Administracion (admin global) ---
  getUsers(): Promise<Paginado<Record<string, unknown>>> {
    return this.req('/users');
  }
  crearUser(email: string, password: string): Promise<Record<string, unknown>> {
    return this.req('/users', { method: 'POST', body: JSON.stringify({ email, password }) });
  }
  actualizarUser(id: string, patch: { isActive?: boolean; password?: string }): Promise<Record<string, unknown>> {
    return this.req(`/users/${id}`, { method: 'PUT', body: JSON.stringify(patch) });
  }
  getEmpresasAdmin(): Promise<Array<Record<string, unknown>>> {
    return this.req('/admin/empresas');
  }
  crearEmpresaAdmin(data: { nombre: string; codigo: string; fsBaseUrl: string; fsApiKey: string }): Promise<Record<string, unknown>> {
    return this.req('/admin/empresas', { method: 'POST', body: JSON.stringify(data) });
  }

  /** Vencimientos de toda la empresa (panel a cobrar/a pagar). */
  getVencimientos(estado?: 'pendiente' | 'liquidado'): Promise<Array<{ id: string; facturaId: string; tipo: 'cobro' | 'pago'; fecha: string; importe: number; estado: string }>> {
    return this.req(this.co(`/facturas/vencimientos${estado ? `?estado=${estado}` : ''}`));
  }

  // --- Informes y exportaciones ---
  getCuadreBancos(ejercicio: number): Promise<{ cuentas: Array<{ saldoExtracto: number; saldoContable: number }> }> {
    return this.req(this.co(`/cuadre-bancos?ejercicio=${ejercicio}`));
  }
  /** Libros de IVA: SIEMPRE año completo (requisito AEAT), por eso no llevan periodo. */
  downloadLibroIvaIngresos(year: number): Promise<void> {
    return this.descargar(`/reportes/libro-iva-ingresos.csv?ejercicio=${year}`, `libro-iva-ingresos-${year}.csv`);
  }
  downloadLibroIvaGastos(year: number): Promise<void> {
    return this.descargar(`/reportes/libro-iva-gastos.csv?ejercicio=${year}`, `libro-iva-gastos-${year}.csv`);
  }
  downloadInformePyG(year: number, periodo: string): Promise<void> {
    return this.descargar(`/reportes/perdidas-ganancias.csv?ejercicio=${year}&periodo=${periodo}`, 'perdidas-ganancias.csv');
  }
  downloadExportA3(year: number): Promise<void> {
    return this.descargar(`/reportes/export-a3.dat?ejercicio=${year}`, 'suenlace.dat');
  }
  downloadGastosRechazados(): Promise<void> {
    return this.descargar('/reportes/gastos-rechazados.csv', 'gastos-rechazados.csv');
  }

  /** Descarga autenticada (CSV/PDF/TXT/XLSX) respetando el filename del servidor. */
  async descargar(path: string, nombrePorDefecto: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}${this.co(path)}`, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new Error(`Descarga fallida (HTTP ${res.status})`);
    const blob = await res.blob();
    const nombre = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? nombrePorDefecto;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nombre;
    a.click();
    URL.revokeObjectURL(a.href);
  }
}
