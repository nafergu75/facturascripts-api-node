/**
 * SDK oficial TypeScript para la API de contabilidad (BFF sobre FacturaScripts).
 * Envuelve las rutas principales con metodos tipados. Usa fetch (Node >=18 / browser).
 *
 * Ejemplo:
 *   const api = new ContaApiClient({ baseUrl: 'http://localhost:3000', apiToken: jwt });
 *   const empresas = await api.getEmpresas();
 *   const m303 = await api.getModelo303Preview('1', 2026, '2T');
 */
export interface ContaApiClientOptions {
  baseUrl: string;
  apiToken: string;
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  message?: string;
}

export class ContaApiClient {
  private readonly baseUrl: string;
  private readonly apiToken: string;

  constructor(options: ContaApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiToken = options.apiToken;
  }

  private async request<T>(method: string, path: string, params?: Record<string, unknown>, body?: unknown): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as Envelope<T> & { statusCode?: number };
    if (!res.ok) {
      throw new Error(`API ${res.status}: ${json.message ?? res.statusText}`);
    }
    return (json.data ?? (json as unknown as T)) as T;
  }

  private get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    return this.request<T>('GET', path, params);
  }
  private post<T>(path: string, body?: unknown, params?: Record<string, unknown>): Promise<T> {
    return this.request<T>('POST', path, params, body);
  }

  // --- Auth ---
  async login(email: string, password: string): Promise<{ token: string; user: unknown }> {
    return this.post('/auth/login', { email, password });
  }

  // --- Empresas ---
  getEmpresas(): Promise<unknown[]> {
    return this.get('/companies');
  }

  // --- Facturas / contabilidad ---
  getFacturas(companyId: string, filtros?: Record<string, unknown>): Promise<unknown> {
    return this.get(`/companies/${companyId}/facturas`, filtros);
  }
  contabilizarFactura(companyId: string, facturaId: string): Promise<unknown> {
    return this.post(`/companies/${companyId}/facturas/${facturaId}/contabilizar`);
  }
  getHuellasFactura(companyId: string, facturaId: string): Promise<unknown> {
    return this.get(`/companies/${companyId}/facturas/${facturaId}/huellas`);
  }

  // --- AEAT / impuestos ---
  getModelo303Preview(companyId: string, ejercicio: number, periodo: string): Promise<unknown> {
    return this.get(`/companies/${companyId}/aeat/modelo-303/preview`, { ejercicio, periodo });
  }
  getModelo200Preview(companyId: string, ejercicio: number): Promise<unknown> {
    return this.get(`/companies/${companyId}/modelo-200/preview`, { ejercicio });
  }
  getCuentasAnuales(companyId: string, ejercicio: number): Promise<unknown> {
    return this.get(`/companies/${companyId}/cuentas-anuales/preview`, { ejercicio });
  }

  // --- Plan contable ---
  getPlanContableBase(): Promise<unknown> {
    return this.get('/plan-contable/base/cuentas');
  }
  getSubcuentasEmpresa(companyId: string): Promise<unknown[]> {
    return this.get(`/companies/${companyId}/plan-contable/subcuentas`);
  }

  // --- Compliance / reportes ---
  getAlertasCompliance(companyId: string, ejercicio: number): Promise<unknown[]> {
    return this.get(`/companies/${companyId}/compliance/alertas`, { ejercicio });
  }
  getMargenPorCliente(companyId: string, ejercicio: number): Promise<unknown> {
    return this.get(`/companies/${companyId}/reportes/margen/cliente`, { ejercicio });
  }
}
